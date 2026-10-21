/**
 * Film discovery and persistence.
 *
 * - One versioned JSON state file per film.
 * - Mutations for a film run one at a time (per-film promise chain), against a
 *   copy of the state; the copy only becomes current after it is safely on disk.
 * - Writes go to a temp file, are flushed, then renamed over state.json
 *   (with a retry for transient Windows sharing violations). The previous good
 *   file is kept as state.prev.json.
 * - An unreadable or invalid state file is never overwritten or reset. The film
 *   is reported as broken until the user fixes or moves the file aside.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FilmStateSchema, STATE_VERSION, type FilmState, type GenerationSettings } from "../../shared/domain";
import { DEFAULT_STYLE_BLOCK_TEXT } from "../../shared/prompt";
import { AppError, conflict, errorMessage, newId, notFound } from "../errors";
import { filmDir, metaDir, prevStateFile, stateFile } from "./layout";
import { assertFilmName, assertUnderRoot } from "./paths";
import { listFilmNames, scanFilmMedia, type FilmMedia } from "./scanner";

export interface FilmStoreOptions {
  root: string;
  defaultSettings: () => GenerationSettings;
  /** Minimum ms between disk rescans of one film (polling clients call often). */
  scanIntervalMs?: number;
  now?: () => Date;
}

export class FilmStore {
  readonly root: string;
  private readonly cache = new Map<string, FilmState>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly lastScan = new Map<string, { at: number; media: FilmMedia }>();
  private readonly opts: Required<Omit<FilmStoreOptions, "root">>;

  constructor(opts: FilmStoreOptions) {
    this.root = opts.root;
    this.opts = {
      defaultSettings: opts.defaultSettings,
      scanIntervalMs: opts.scanIntervalMs ?? 1000,
      now: opts.now ?? (() => new Date()),
    };
  }

  private nowIso(): string {
    return this.opts.now().toISOString();
  }

  /**
   * Every filesystem path this store (and the services using it) touches goes
   * through here: it must resolve inside the configured films root.
   */
  guard(abs: string): Promise<string> {
    return assertUnderRoot(this.root, abs);
  }

  /** A validated path inside a film, checked against the films root. */
  filmPath(film: string, ...segments: string[]): Promise<string> {
    assertFilmName(film);
    return this.guard(path.join(filmDir(this.root, film), ...segments));
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  listFilms(): Promise<string[]> {
    return listFilmNames(this.root);
  }

  async createFilm(name: string): Promise<string> {
    assertFilmName(name);
    await this.ensureRoot();
    const existing = await this.listFilms();
    if (existing.some((f) => f.toLowerCase() === name.toLowerCase())) {
      throw conflict("FILM_EXISTS", `A film named "${name}" already exists.`);
    }
    const dir = await this.filmPath(name);
    if (existsSync(dir)) throw conflict("FILM_EXISTS", `A folder named "${name}" already exists.`);
    await mkdir(dir, { recursive: false });
    await writeFile(
      await this.guard(path.join(dir, "PUT IMAGES AND AUDIO HERE.txt")),
      "Add source images (jpg, png, webp) and soundtrack audio files to this folder.\r\n" +
        "Shotloom picks them up automatically. Generated clips are kept in the .shotloom folder;\r\n" +
        "finished videos go to the exports folder.\r\n",
    );
    await this.mutate(name, () => undefined); // writes the initial state file
    return name;
  }

  async assertFilmExists(film: string): Promise<void> {
    assertFilmName(film);
    const dir = await this.filmPath(film); // refuses a film folder that leads outside the root
    const s = await stat(dir).catch(() => null);
    if (!s?.isDirectory()) throw notFound(`Film "${film}" was not found.`);
  }

  private initialState(): FilmState {
    const now = this.nowIso();
    return {
      version: STATE_VERSION,
      promptBlocks: [{ id: newId(), text: DEFAULT_STYLE_BLOCK_TEXT, enabled: true, createdAt: now, updatedAt: now }],
      shots: {},
      timeline: [],
      soundtrack: null,
      aspectRatio: "16:9",
      generationSettings: this.opts.defaultSettings(),
    };
  }

  /** Loads from disk (or cache). Throws STATE_UNREADABLE without touching the file. */
  private async load(film: string): Promise<FilmState> {
    // Checked even when cached, so a folder swapped for a link is refused immediately.
    const file = await this.guard(stateFile(this.root, film));
    const cached = this.cache.get(film);
    if (cached) return cached;
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AppError(500, "STATE_UNREADABLE", `Could not read ${file}: ${errorMessage(err)}`);
      }
      if (existsSync(await this.guard(prevStateFile(this.root, film)))) {
        throw new AppError(
          409,
          "STATE_MISSING",
          `state.json is missing but a backup (state.prev.json) exists in ${metaDir(this.root, film)}. ` +
            "Rename the backup to state.json to restore it, or use “Start fresh” to keep it aside and begin a new state.",
        );
      }
      const fresh = this.initialState();
      this.cache.set(film, fresh);
      return fresh;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw this.corrupt(film, `it is not valid JSON (${errorMessage(err)})`);
    }
    const version = (parsed as { version?: unknown } | null)?.version;
    if (typeof version === "number" && version > STATE_VERSION) {
      throw this.corrupt(film, `it was written by a newer version of Shotloom (state version ${version})`);
    }
    const result = FilmStateSchema.safeParse(parsed);
    if (!result.success) {
      const first = result.error.issues[0];
      const where = first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "unknown issue";
      throw this.corrupt(film, `it does not match the expected format (${where})`);
    }
    this.cache.set(film, result.data);
    return result.data;
  }

  private corrupt(film: string, why: string): AppError {
    const file = stateFile(this.root, film);
    return new AppError(
      409,
      "STATE_UNREADABLE",
      `Film state could not be loaded because ${why}. The file was left untouched: ${file}. ` +
        "Fix it by hand, restore state.prev.json from the same folder, or choose “Start fresh” to move it aside.",
      { stateFile: file },
    );
  }

  /** Runs fn after all earlier queued work for this film has finished. */
  private serialize<T>(film: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(film) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(film, next);
    // Drop the reference when idle so the map does not grow forever.
    next.finally(() => {
      if (this.chains.get(film) === next) this.chains.delete(film);
    }).catch(() => undefined);
    return next;
  }

  /**
   * Applies a mutation atomically. `fn` receives a private copy; if it throws,
   * nothing changes. Returns the committed state and fn's result.
   */
  mutate<T>(film: string, fn: (draft: FilmState) => T | Promise<T>): Promise<{ state: FilmState; result: T }> {
    return this.serialize(film, async () => {
      await this.assertFilmExists(film);
      const current = await this.load(film);
      const draft = structuredClone(current);
      // Merge what is on disk first so the mutation sees newly added shots.
      this.mergeMedia(draft, await this.scan(film, true));
      const result = await fn(draft);
      const validated = FilmStateSchema.parse(draft); // guards against programming errors
      await this.writeAtomic(film, validated);
      this.cache.set(film, validated);
      return { state: structuredClone(validated), result };
    });
  }

  /** Current state merged with what is on disk now. Persists if discovery changed anything. */
  async read(film: string, opts: { rescan?: boolean } = {}): Promise<{ state: FilmState; media: FilmMedia }> {
    await this.assertFilmExists(film);
    const media = await this.scan(film, opts.rescan ?? false);
    const current = await this.serialize(film, () => this.load(film));
    const probe = structuredClone(current);
    if (this.mergeMedia(probe, media)) {
      const { state } = await this.mutate(film, () => undefined);
      return { state, media: this.lastScan.get(film)?.media ?? media };
    }
    return { state: probe, media };
  }

  private async scan(film: string, force: boolean): Promise<FilmMedia> {
    const prev = this.lastScan.get(film);
    const now = Date.now();
    if (!force && prev && now - prev.at < this.opts.scanIntervalMs) return prev.media;
    const media = await scanFilmMedia(await this.filmPath(film));
    this.lastScan.set(film, { at: now, media });
    return media;
  }

  /** Adds new shots, flags vanished ones, reconnects returning ones. Returns true if changed. */
  private mergeMedia(state: FilmState, media: FilmMedia): boolean {
    let changed = false;
    const onDisk = new Set(media.images);
    for (const filename of media.images) {
      const shot = state.shots[filename];
      if (!shot) {
        state.shots[filename] = { filename, text: "", missingSince: null, generations: [] };
        changed = true;
      } else if (shot.missingSince !== null) {
        shot.missingSince = null;
        changed = true;
      }
    }
    for (const shot of Object.values(state.shots)) {
      if (!onDisk.has(shot.filename) && shot.missingSince === null) {
        shot.missingSince = this.nowIso();
        changed = true;
      }
    }
    return changed;
  }

  private async writeAtomic(film: string, state: FilmState): Promise<void> {
    const dir = await this.guard(metaDir(this.root, film));
    const target = await this.guard(stateFile(this.root, film));
    const prev = await this.guard(prevStateFile(this.root, film));
    await mkdir(dir, { recursive: true });
    const tmp = await this.guard(path.join(dir, `state.json.${process.pid}.${newId()}.tmp`));
    const json = JSON.stringify(state, null, 2) + "\n";
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(json, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (existsSync(target)) await copyFile(target, prev).catch(() => undefined);
      await renameWithRetry(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new AppError(500, "STATE_WRITE_FAILED", `Could not save film state: ${errorMessage(err)}`);
    }
  }

  /** Explicit user action: keep the unreadable file under a new name and start a fresh state. */
  async startFresh(film: string): Promise<string | null> {
    return this.serialize(film, async () => {
      await this.assertFilmExists(film);
      const target = await this.guard(stateFile(this.root, film));
      let keptAs: string | null = null;
      if (existsSync(target)) {
        const stamp = this.nowIso().replace(/[:.]/g, "-");
        keptAs = await this.guard(path.join(path.dirname(target), `state.unreadable-${stamp}.json`));
        await renameWithRetry(target, keptAs);
      }
      const prev = await this.guard(prevStateFile(this.root, film));
      if (existsSync(prev)) {
        const stamp = this.nowIso().replace(/[:.]/g, "-");
        await renameWithRetry(prev, await this.guard(path.join(path.dirname(prev), `state.prev-kept-${stamp}.json`)));
      }
      this.cache.delete(film);
      return keptAs;
    });
  }

  /** For tests and the orchestrator: drop cached copies so the next read hits disk. */
  forget(film?: string): void {
    if (film) this.cache.delete(film);
    else this.cache.clear();
  }
}

/** Windows can briefly refuse a rename while antivirus/indexers hold the file. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const delays = [20, 50, 100, 200, 400];
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      const delay = delays[attempt];
      if (!transient || delay === undefined) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
