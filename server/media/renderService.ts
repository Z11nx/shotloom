/**
 * Runs preview/export renders one at a time in the background and remembers
 * the latest status per film (shown in the timeline panel).
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RenderStatus } from "../../shared/api";
import { AppError, errorMessage, newId } from "../errors";
import { exportsDir, previewDir, renderTmpDir } from "../films/layout";
import type { FilmStore } from "../films/store";
import type { MediaTools } from "./ffmpeg";
import { buildRenderPlan, cleanRenderScratch, renderPlan } from "./render";

export class RenderService {
  private readonly statuses = new Map<string, RenderStatus>();
  private running: { film: string; id: string } | null = null;

  constructor(
    private readonly store: FilmStore,
    private readonly tools: MediaTools,
    private readonly log: (m: string) => void = console.log,
  ) {}

  status(film: string): RenderStatus | null {
    return this.statuses.get(film) ?? null;
  }

  /** Validates synchronously (errors return to the caller), then renders in the background. */
  async start(film: string, kind: "preview" | "export"): Promise<RenderStatus> {
    if (this.running) {
      throw new AppError(
        409,
        "RENDER_BUSY",
        this.running.film === film
          ? "A render is already running for this film."
          : `A render is already running for “${this.running.film}”. Wait for it to finish.`,
      );
    }
    const id = newId();
    this.running = { film, id }; // claim before any await so two clicks cannot both start
    try {
      const { state, media } = await this.store.read(film);
      const plan = await buildRenderPlan(this.store.root, film, state, media.audio, this.tools);
      // Every folder this render writes to or clears must be inside the films root.
      const dirs = {
        tmp: await this.store.guard(renderTmpDir(this.store.root, film)),
        out: await this.store.guard(kind === "preview" ? previewDir(this.store.root, film) : exportsDir(this.store.root, film)),
      };
      const status: RenderStatus = {
        id,
        kind,
        state: "running",
        step: "Starting",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        output: null,
      };
      this.statuses.set(film, status);
      void this.run(film, kind, status, plan, dirs);
      return status;
    } catch (err) {
      this.running = null;
      throw err;
    }
  }

  private async run(
    film: string,
    kind: "preview" | "export",
    status: RenderStatus,
    plan: Awaited<ReturnType<typeof buildRenderPlan>>,
    dirs: { tmp: string; out: string },
  ): Promise<void> {
    const tmpRoot = dirs.tmp;
    try {
      await cleanRenderScratch(tmpRoot);
      let outDir: string;
      let filename: string;
      if (kind === "preview") {
        outDir = dirs.out;
        await mkdir(outDir, { recursive: true });
        // Only the latest preview is kept; unique names defeat stale browser caches.
        for (const old of await readdir(outDir).catch(() => [] as string[])) {
          await rm(path.join(outDir, old), { force: true }).catch(() => undefined);
        }
        filename = `preview-${Date.now()}.mp4`;
      } else {
        outDir = dirs.out;
        await mkdir(outDir, { recursive: true });
        filename = uniqueExportName(outDir, film);
      }
      const outPath = await this.store.guard(path.join(outDir, filename));
      const workDir = await this.store.guard(path.join(tmpRoot, status.id));
      const probe = await renderPlan(this.tools, plan, outPath, workDir, (step) => {
        status.step = step;
      });
      status.state = "done";
      status.step = "Done";
      status.output = {
        kind,
        filename,
        url: `/media/${encodeURIComponent(film)}/${kind === "preview" ? "preview" : "exports"}/${encodeURIComponent(filename)}`,
        durationSec: probe.durationSec,
        width: probe.width ?? 0,
        height: probe.height ?? 0,
        hasAudio: probe.hasAudio,
      };
    } catch (err) {
      status.state = "failed";
      status.error = errorMessage(err);
      this.log(`[render] ${film} ${kind} failed: ${status.error}`);
    } finally {
      status.finishedAt = new Date().toISOString();
      this.running = null;
    }
  }

  /** Resolves when no render is running (tests). */
  async idle(timeoutMs = 120_000): Promise<void> {
    const start = Date.now();
    while (this.running) {
      if (Date.now() - start > timeoutMs) throw new Error("Render did not finish in time.");
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

function uniqueExportName(dir: string, film: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const base = `${film.replace(/\s+/g, "-")}-${stamp}`;
  let name = `${base}.mp4`;
  for (let i = 2; existsSync(path.join(dir, name)); i++) name = `${base}-${i}.mp4`;
  return name;
}
