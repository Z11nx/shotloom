/**
 * JSON API and media routes. Route table: docs/API.md.
 * Handlers stay thin: validate input, call a service, return a FilmView.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  AddClipBody,
  AspectRatioBody,
  CreateFilmBody,
  CreatePromptBlockBody,
  GenerateBody,
  ImportPromptBlocksBody,
  OpenFolderBody,
  RenderBody,
  ReorderBody,
  SettingsBody,
  SoundtrackBody,
  UpdateClipBody,
  UpdateGenerationBody,
  UpdatePromptBlockBody,
  UpdateShotBody,
  type FilmView,
  type GenerateResponse,
} from "../../shared/api";
import { findGeneration, validateTrim, type FilmState } from "../../shared/domain";
import { isSupportedSourceImage, validateSettings } from "../../shared/models";
import { AppError, badRequest, conflict, newId, notFound } from "../errors";
import { exportsDir, filmDir, generationsDir, previewDir } from "../films/layout";
import { assertFileName, assertFilmName } from "../films/paths";
import type { FilmStore } from "../films/store";
import type { GenerationService } from "../generation/service";
import type { RenderService } from "../media/renderService";
import type { StatusChecker } from "../system/status";
import type { FalBalance } from "../system/falBalance";
import type { FolderOpener } from "../system/opener";
import { json, readBody, serveFile } from "./respond";
import { Router, type Params } from "./router";

export interface RouteDeps {
  store: FilmStore;
  generation: GenerationService;
  renders: RenderService;
  status: StatusChecker;
  falBalance: FalBalance;
  openFolder: FolderOpener;
}

export function buildRouter(d: RouteDeps): Router {
  const r = new Router();
  const film = (p: Params) => assertFilmName(p.film ?? "");

  async function view(name: string, state?: FilmState): Promise<FilmView> {
    const { state: current, media } = await d.store.read(name);
    const s = state ?? current;
    const model = d.generation.activeModel;
    return {
      name,
      state: s,
      sources: media.images.map((filename) => {
        const ok = isSupportedSourceImage(model, filename);
        return {
          filename,
          generatable: ok,
          reason: ok
            ? null
            : `${path.extname(filename).toUpperCase().slice(1)} is not a documented input for ${model.label}; convert to ${model.sourceImageExtensions.join("/")} to generate.`,
        };
      }),
      audioFiles: media.audio,
      render: d.renders.status(name),
    };
  }

  /** Mutates film state and returns the fresh view. */
  async function mutateView(name: string, fn: (s: FilmState) => void): Promise<Response> {
    const { state } = await d.store.mutate(name, fn);
    return json(await view(name, state));
  }

  // --- status & films ------------------------------------------------------

  r.get("/api/status", async () => json(await d.status.get()));
  // fal credit balance (cached server-side; ?refresh=1 asks for a fresh read, rate-limited).
  r.get("/api/fal/balance", async (_req, _p, url) => json(await d.falBalance.get(url.searchParams.get("refresh") === "1")));

  r.get("/api/films", async () => json({ films: (await d.store.listFilms()).map((name) => ({ name })) }));

  r.post("/api/films", async (req) => {
    const body = await readBody(req, CreateFilmBody);
    const name = await d.store.createFilm(body.name.trim());
    await d.openFolder(filmDir(d.store.root, name)).catch(() => undefined);
    return json({ film: name }, 201);
  });

  r.get("/api/films/:film", async (_req, p) => json(await view(film(p))));

  r.post("/api/films/:film/open-folder", async (req, p) => {
    const name = film(p);
    await d.store.assertFilmExists(name);
    const body = await readBody(req, OpenFolderBody);
    const target = await d.store.guard(body.target === "film" ? filmDir(d.store.root, name) : exportsDir(d.store.root, name));
    await mkdir(target, { recursive: true });
    await d.openFolder(target);
    return json({ ok: true });
  });

  r.post("/api/films/:film/state/start-fresh", async (_req, p) => {
    const name = film(p);
    const keptAs = await d.store.startFresh(name);
    return json({ keptAs: keptAs ? path.basename(keptAs) : null, view: await view(name) });
  });

  r.put("/api/films/:film/settings", async (req, p) => {
    const body = await readBody(req, SettingsBody);
    const errors = validateSettings(d.generation.activeModel, body);
    if (errors.length) throw badRequest(errors.join(" "));
    return mutateView(film(p), (s) => {
      s.generationSettings = body;
    });
  });

  // --- prompt blocks -----------------------------------------------------------

  r.post("/api/films/:film/prompt-blocks", async (req, p) => {
    const body = await readBody(req, CreatePromptBlockBody);
    const now = new Date().toISOString();
    return mutateView(film(p), (s) => {
      s.promptBlocks.push({ id: newId(), text: body.text, enabled: body.enabled, createdAt: now, updatedAt: now });
    });
  });

  r.put("/api/films/:film/prompt-blocks/order", async (req, p) => {
    const { ids } = await readBody(req, ReorderBody);
    return mutateView(film(p), (s) => {
      s.promptBlocks = reorderExact(s.promptBlocks, ids, "prompt blocks");
    });
  });

  r.post("/api/films/:film/prompt-blocks/import", async (req, p) => {
    const target = film(p);
    const { sourceFilm } = await readBody(req, ImportPromptBlocksBody);
    assertFilmName(sourceFilm);
    if (sourceFilm === target) throw badRequest("Choose a different film to import from.");
    const { state: source } = await d.store.read(sourceFilm);
    const now = new Date().toISOString();
    return mutateView(target, (s) => {
      // Independent copies: new ids, later edits in either film do not affect the other.
      for (const b of source.promptBlocks) {
        s.promptBlocks.push({ id: newId(), text: b.text, enabled: b.enabled, createdAt: now, updatedAt: now });
      }
    });
  });

  r.patch("/api/films/:film/prompt-blocks/:id", async (req, p) => {
    const body = await readBody(req, UpdatePromptBlockBody);
    return mutateView(film(p), (s) => {
      const block = s.promptBlocks.find((b) => b.id === p.id);
      if (!block) throw notFound("That prompt block no longer exists.");
      if (body.text !== undefined) block.text = body.text;
      if (body.enabled !== undefined) block.enabled = body.enabled;
      block.updatedAt = new Date().toISOString();
    });
  });

  r.delete("/api/films/:film/prompt-blocks/:id", async (_req, p) =>
    mutateView(film(p), (s) => {
      const before = s.promptBlocks.length;
      s.promptBlocks = s.promptBlocks.filter((b) => b.id !== p.id);
      if (s.promptBlocks.length === before) throw notFound("That prompt block no longer exists.");
    }),
  );

  // --- shots & generation ------------------------------------------------------

  r.patch("/api/films/:film/shots/:shot", async (req, p) => {
    const shotName = assertFileName(p.shot ?? "");
    const body = await readBody(req, UpdateShotBody);
    return mutateView(film(p), (s) => {
      const shot = s.shots[shotName];
      if (!shot) throw notFound(`Shot "${shotName}" was not found.`);
      shot.text = body.text;
    });
  });

  r.post("/api/films/:film/shots/:shot/generate", async (req, p) => {
    const name = film(p);
    const shotName = assertFileName(p.shot ?? "");
    const body = await readBody(req, GenerateBody);
    const ids = await d.generation.enqueue(name, shotName, body);
    const response: GenerateResponse = { generationIds: ids, view: await view(name) };
    return json(response, 202);
  });

  r.patch("/api/films/:film/generations/:id", async (req, p) => {
    const body = await readBody(req, UpdateGenerationBody);
    return mutateView(film(p), (s) => {
      const found = findGeneration(s, p.id ?? "");
      if (!found) throw notFound("That generation no longer exists.");
      const g = found.generation;
      if (g.status !== "completed" || !g.output) throw conflict("NOT_COMPLETED", "Only completed clips can be trimmed.");
      if (body.trim) {
        const problem = validateTrim(body.trim, g.output.durationSec);
        if (problem) throw badRequest(problem);
        g.trim = { inSec: round3(body.trim.inSec), outSec: round3(Math.min(body.trim.outSec, g.output.durationSec)) };
      } else {
        g.trim = null; // reset to full clip
      }
      g.updatedAt = new Date().toISOString();
    });
  });

  r.delete("/api/films/:film/generations/:id", async (_req, p) => {
    const name = film(p);
    await d.generation.deleteGeneration(name, p.id ?? "");
    return json(await view(name));
  });

  r.post("/api/films/:film/generations/:id/resume", async (_req, p) => {
    const name = film(p);
    await d.generation.resume(name, p.id ?? "");
    return json(await view(name));
  });

  r.post("/api/films/:film/generations/:id/mark-failed", async (_req, p) => {
    const name = film(p);
    await d.generation.acknowledgeUncertain(name, p.id ?? "");
    return json(await view(name));
  });

  // --- timeline, soundtrack, aspect -------------------------------------------

  r.post("/api/films/:film/timeline", async (req, p) => {
    const { generationId } = await readBody(req, AddClipBody);
    return mutateView(film(p), (s) => {
      const found = findGeneration(s, generationId);
      if (!found) throw notFound("That generation no longer exists.");
      if (found.generation.status !== "completed") throw conflict("NOT_COMPLETED", "Only completed clips can go on the timeline.");
      if (s.timeline.some((c) => c.generationId === generationId)) {
        throw conflict("ALREADY_ON_TIMELINE", "This clip is already on the timeline.");
      }
      s.timeline.push({ id: newId(), generationId, muted: false });
    });
  });

  r.put("/api/films/:film/timeline/order", async (req, p) => {
    const { ids } = await readBody(req, ReorderBody);
    return mutateView(film(p), (s) => {
      s.timeline = reorderExact(s.timeline, ids, "timeline clips");
    });
  });

  r.patch("/api/films/:film/timeline/:clipId", async (req, p) => {
    const { muted } = await readBody(req, UpdateClipBody);
    return mutateView(film(p), (s) => {
      const clip = s.timeline.find((c) => c.id === p.clipId);
      if (!clip) throw notFound("That clip is no longer on the timeline.");
      clip.muted = muted;
    });
  });

  r.delete("/api/films/:film/timeline/:clipId", async (_req, p) =>
    mutateView(film(p), (s) => {
      s.timeline = s.timeline.filter((c) => c.id !== p.clipId);
    }),
  );

  r.put("/api/films/:film/soundtrack", async (req, p) => {
    const name = film(p);
    const body = await readBody(req, SoundtrackBody);
    if (body.filename !== null) {
      assertFileName(body.filename);
      const { media } = await d.store.read(name, { rescan: true });
      if (!media.audio.includes(body.filename)) throw badRequest(`"${body.filename}" is not an audio file in this film's folder.`);
    }
    return mutateView(name, (s) => {
      s.soundtrack = body.filename === null ? null : { filename: body.filename, offsetSec: round3(body.offsetSec) };
    });
  });

  r.put("/api/films/:film/aspect-ratio", async (req, p) => {
    const { aspectRatio } = await readBody(req, AspectRatioBody);
    return mutateView(film(p), (s) => {
      s.aspectRatio = aspectRatio;
    });
  });

  r.post("/api/films/:film/render", async (req, p) => {
    const name = film(p);
    const { kind } = await readBody(req, RenderBody);
    const status = await d.renders.start(name, kind);
    return json(status, 202);
  });

  // --- media ---------------------------------------------------------------------
  // Only files the app knows about are served: discovered sources, recorded
  // outputs, the current preview, and exports. Never state or config files.

  r.get("/media/:film/source/:file", async (req, p) => {
    const name = film(p);
    const file = assertFileName(p.file ?? "");
    let { media } = await d.store.read(name);
    if (!media.images.includes(file) && !media.audio.includes(file)) {
      ({ media } = await d.store.read(name, { rescan: true })); // may have been added in the last second
    }
    if (!media.images.includes(file) && !media.audio.includes(file)) throw notFound("Not a media file in this film.");
    const abs = await d.store.filmPath(name, file);
    return serveFile(req, abs, "no-cache");
  });

  r.get("/media/:film/gen/:id", async (req, p) => {
    const name = film(p);
    const { state } = await d.store.read(name);
    const found = findGeneration(state, p.id ?? "");
    const output = found?.generation.status === "completed" ? found.generation.output : null;
    if (!output) throw notFound("That clip is not available.");
    const abs = await d.store.guard(path.join(generationsDir(d.store.root, name), assertFileName(output.filename)));
    return serveFile(req, abs, "private, max-age=31536000, immutable");
  });

  r.get("/media/:film/preview/:file", async (req, p) => {
    const name = film(p);
    const file = p.file ?? "";
    if (!/^preview-\d+\.mp4$/.test(file)) throw notFound("Not a preview file.");
    const abs = await d.store.guard(path.join(previewDir(d.store.root, name), file));
    return serveFile(req, abs, "no-store");
  });

  r.get("/media/:film/exports/:file", async (req, p) => {
    const name = film(p);
    const file = assertFileName(p.file ?? "");
    if (!file.toLowerCase().endsWith(".mp4")) throw notFound("Not an export.");
    const abs = await d.store.guard(path.join(exportsDir(d.store.root, name), file));
    return serveFile(req, abs, "no-cache");
  });

  return r;
}

function reorderExact<T extends { id: string }>(items: T[], ids: string[], what: string): T[] {
  if (ids.length !== items.length || new Set(ids).size !== ids.length) {
    throw conflict("STALE_ORDER", `The list of ${what} changed; refresh and try again.`);
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  return ids.map((id) => {
    const item = byId.get(id);
    if (!item) throw conflict("STALE_ORDER", `The list of ${what} changed; refresh and try again.`);
    return item;
  });
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export { AppError };
