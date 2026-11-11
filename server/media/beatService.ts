/**
 * Beat analysis of a film's soundtrack: decode with FFmpeg, detect beats,
 * cache. Results are cached in memory and in <film>/.shotloom/beats/ (keyed by
 * file name, size and modification time), so each song is analyzed once.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BEAT_ANALYSIS_VERSION, type BeatAnalysis } from "../../shared/beats";
import { AppError, errorMessage, newId } from "../errors";
import { beatsDir, filmDir } from "../films/layout";
import { assertFileName } from "../films/paths";
import type { FilmStore } from "../films/store";
import { ANALYSIS_SAMPLE_RATE, detectBeats } from "./beatDetect";
import type { MediaTools } from "./ffmpeg";

/** Long files are analyzed up to this length (a film rarely needs more). */
export const MAX_ANALYZE_SEC = 20 * 60;

export class BeatService {
  private readonly memory = new Map<string, BeatAnalysis>();
  private readonly inflight = new Map<string, Promise<BeatAnalysis>>();

  constructor(
    private readonly store: FilmStore,
    private readonly tools: MediaTools,
    private readonly decode: (tools: MediaTools, file: string) => Promise<Float32Array> = decodeMono,
  ) {}

  /** Analysis for an audio file in the film folder (cached). */
  async get(film: string, filename: string): Promise<BeatAnalysis> {
    assertFileName(filename);
    const file = await this.store.guard(path.join(filmDir(this.store.root, film), filename));
    let info;
    try {
      info = await stat(file);
    } catch {
      throw new AppError(404, "NOT_FOUND", `"${filename}" is no longer in the film folder.`);
    }
    const id = { filename, sizeBytes: info.size, modifiedMs: Math.round(info.mtimeMs) };
    const key = `${film}\u0000${filename}\u0000${id.sizeBytes}\u0000${id.modifiedMs}`;
    const hit = this.memory.get(key);
    if (hit) return hit;
    const running = this.inflight.get(key);
    if (running) return running;
    const job = (async () => {
      const cacheFile = await this.store.guard(path.join(beatsDir(this.store.root, film), `${hashName(filename)}.json`));
      const cached = await readCache(cacheFile, id);
      if (cached) return cached;
      let samples: Float32Array;
      try {
        samples = await this.decode(this.tools, file);
      } catch (err) {
        throw new AppError(422, "AUDIO_UNREADABLE", `Could not read "${filename}" to find its beats: ${errorMessage(err)}`);
      }
      const d = detectBeats(samples, ANALYSIS_SAMPLE_RATE);
      const analysis: BeatAnalysis = { version: BEAT_ANALYSIS_VERSION, ...id, ...d, analyzedSec: d.durationSec };
      await writeCache(cacheFile, analysis).catch(() => undefined); // the cache is an optimization only
      return analysis;
    })();
    this.inflight.set(key, job);
    try {
      const result = await job;
      this.memory.set(key, result);
      return result;
    } finally {
      this.inflight.delete(key);
    }
  }
}

/** Mono 32-bit float PCM at the analysis rate, up to MAX_ANALYZE_SEC. */
export async function decodeMono(tools: MediaTools, file: string): Promise<Float32Array> {
  const proc = Bun.spawn(
    [tools.ffmpegPath, "-hide_banner", "-nostdin", "-v", "error", "-t", String(MAX_ANALYZE_SEC), "-i", file, "-vn", "-ac", "1", "-ar", String(ANALYSIS_SAMPLE_RATE), "-f", "f32le", "-"],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
  );
  const timer = setTimeout(() => proc.kill(), 5 * 60_000);
  try {
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).arrayBuffer(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    if (code !== 0) throw new Error(err.trim().split(/\r?\n/).at(-1) || `ffmpeg exited with code ${code}`);
    if (out.byteLength < 4) throw new Error("it has no audio");
    return new Float32Array(out, 0, Math.floor(out.byteLength / 4));
  } finally {
    clearTimeout(timer);
  }
}

function hashName(filename: string): string {
  return new Bun.CryptoHasher("sha1").update(filename).digest("hex").slice(0, 16);
}

async function readCache(file: string, id: { filename: string; sizeBytes: number; modifiedMs: number }): Promise<BeatAnalysis | null> {
  try {
    const a = JSON.parse(await readFile(file, "utf8")) as BeatAnalysis;
    const valid =
      a.version === BEAT_ANALYSIS_VERSION &&
      a.filename === id.filename &&
      a.sizeBytes === id.sizeBytes &&
      a.modifiedMs === id.modifiedMs &&
      Array.isArray(a.beats) &&
      a.beats.every((b) => typeof b === "number" && Number.isFinite(b));
    return valid ? a : null;
  } catch {
    return null;
  }
}

async function writeCache(file: string, a: BeatAnalysis): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${newId()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(a));
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
