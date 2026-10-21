/**
 * Generation orchestration and recovery.
 *
 * Flow per job:  queued → (upload) → submitting → submitted → processing → downloading → completed
 *                                         ↘ uncertain (interrupted / ambiguous submit)   ↘ failed
 *
 * Guarantees:
 * - A job is only ever handled by one worker at a time (in-process lock set;
 *   a films-root lock file keeps a second server process from starting).
 * - A job that may have reached the provider is never resubmitted automatically.
 * - Status/result/download failures that look transient are retried with
 *   bounded exponential backoff; "Resume" re-polls an existing request id,
 *   which is never a new (billable) generation.
 * - A job is marked completed only after its video is downloaded, renamed into
 *   place and probed.
 * - Polling runs on the server, independent of any browser.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ACTIVE_STATUSES,
  type FilmState,
  type Generation,
  type GenerationError,
  type GenerationSettings,
} from "../../shared/domain";
import { getModel, isSupportedSourceImage, validateSettings, type ModelDescriptor } from "../../shared/models";
import { composePrompt } from "../../shared/prompt";
import { AppError, badRequest, conflict, errorMessage, newId, notFound } from "../errors";
import { generationsDir } from "../films/layout";
import { assertFileName } from "../films/paths";
import type { FilmStore } from "../films/store";
import type { MediaTools } from "../media/ffmpeg";
import { probeMedia } from "../media/probe";
import { ProviderError, type GenerationProvider, type JobRef } from "./providers/types";

export interface GenerationServiceOptions {
  store: FilmStore;
  providers: GenerationProvider[];
  /** Model used for NEW generations. Existing jobs keep the model they were created with. */
  activeModel: ModelDescriptor;
  tools: MediaTools;
  log?: (msg: string) => void;
  now?: () => number;
  pollIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxTransientFailures?: number;
  submitConcurrency?: number;
  maxQueued?: number;
}

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export class GenerationService {
  private readonly store: FilmStore;
  private readonly providers = new Map<string, GenerationProvider>();
  readonly activeModel: ModelDescriptor;
  private readonly tools: MediaTools;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly cfg: Required<
    Pick<
      GenerationServiceOptions,
      "pollIntervalMs" | "backoffBaseMs" | "backoffMaxMs" | "maxTransientFailures" | "submitConcurrency" | "maxQueued"
    >
  >;

  /** `${film}\u0000${generationId}` for jobs a worker currently owns. */
  private readonly inFlight = new Set<string>();
  /** Films that may contain active jobs; avoids rescanning idle films every tick. */
  private readonly activeFilms = new Set<string>();
  private submitting = 0;
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: GenerationServiceOptions) {
    this.store = opts.store;
    for (const p of opts.providers) this.providers.set(p.id, p);
    this.activeModel = opts.activeModel;
    this.tools = opts.tools;
    this.log = opts.log ?? ((m) => console.log(m));
    this.now = opts.now ?? Date.now;
    this.cfg = {
      pollIntervalMs: opts.pollIntervalMs ?? 3000,
      backoffBaseMs: opts.backoffBaseMs ?? 2000,
      backoffMaxMs: opts.backoffMaxMs ?? 60_000,
      maxTransientFailures: opts.maxTransientFailures ?? 8,
      submitConcurrency: opts.submitConcurrency ?? 2,
      maxQueued: opts.maxQueued ?? 24,
    };
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  activeProvider(): GenerationProvider {
    const p = this.providers.get(this.activeModel.providerId);
    if (!p) throw new Error(`No provider registered for ${this.activeModel.providerId}`);
    return p;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Recovers jobs left over from a previous run. Call once before start(). */
  async recover(): Promise<void> {
    for (const film of await this.store.listFilms()) {
      try {
        await this.store.mutate(film, (s) => {
          for (const g of allGenerations(s)) {
            if (g.status === "submitting") {
              g.status = "uncertain";
              g.error = {
                stage: "recovery",
                message:
                  "Shotloom stopped while this request was being submitted, so it is unknown whether the provider accepted it " +
                  "(and charged for it). It will not be resubmitted automatically. Check your provider dashboard, then " +
                  "mark it as failed or generate again.",
                at: this.iso(),
              };
              g.updatedAt = this.iso();
            } else if (g.status === "downloading") {
              // Download is a read-only step: fetch the result again.
              g.status = "processing";
              g.nextAttemptAt = null;
              g.updatedAt = this.iso();
            }
            if (ACTIVE_STATUSES.has(g.status)) this.activeFilms.add(film);
          }
        });
        await this.cleanPartials(film);
      } catch (err) {
        this.log(`[recovery] skipped film "${film}": ${errorMessage(err)}`);
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.cfg.pollIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async cleanPartials(film: string): Promise<void> {
    const dir = await this.store.guard(generationsDir(this.store.root, film));
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.endsWith(".part")).map((n) => rm(path.join(dir, n), { force: true })));
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Saves the shot text exactly as sent, snapshots prompt + settings, and records
   * `count` independent jobs. With count 4 each job gets its own random seed.
   */
  async enqueue(
    film: string,
    shotFilename: string,
    input: { text: string; settings: GenerationSettings; count: 1 | 4; expectedPrompt?: string },
  ): Promise<string[]> {
    const model = this.activeModel;
    const provider = this.activeProvider();
    const reason = provider.unavailableReason();
    if (reason) throw new AppError(503, "PROVIDER_UNAVAILABLE", reason);
    if (!provider.supports(model)) throw new AppError(500, "MODEL_UNSUPPORTED", `${provider.label} cannot run ${model.label}.`);

    const settingErrors = validateSettings(model, input.settings);
    if (settingErrors.length) throw badRequest(settingErrors.join(" "));

    assertFileName(shotFilename);
    if (!isSupportedSourceImage(model, shotFilename)) {
      throw badRequest(
        `${path.extname(shotFilename) || "This file type"} images are not a documented input for ${model.label}. ` +
          `Convert it to ${model.sourceImageExtensions.join(", ")} first.`,
      );
    }
    const queuedNow = await this.countQueued();
    if (queuedNow + input.count > this.cfg.maxQueued) {
      throw new AppError(429, "QUEUE_FULL", `There are already ${queuedNow} generations waiting to submit. Wait for some to start.`);
    }

    const sourcePath = await this.store.filmPath(film, shotFilename);
    const st = await stat(sourcePath).catch(() => null);
    if (!st?.isFile()) throw notFound(`Source image "${shotFilename}" is not in the film folder.`);

    const seeds =
      input.count === 1 ? [input.settings.seed] : distinctSeeds(4, model.seed.min, model.seed.max);
    const batchId = input.count === 4 ? newId() : null;

    const { result: ids } = await this.store.mutate(film, (s) => {
      const shot = s.shots[shotFilename];
      if (!shot) throw notFound(`Shot "${shotFilename}" was not found.`);
      if (shot.missingSince) throw conflict("SOURCE_MISSING", `"${shotFilename}" is no longer in the film folder.`);
      shot.text = input.text;
      s.generationSettings = { ...input.settings };
      const prompt = composePrompt(s.promptBlocks, shot.text);
      if (input.expectedPrompt !== undefined && input.expectedPrompt !== prompt) {
        // Throwing inside the mutation discards it: no text saved, no jobs created.
        throw conflict(
          "PROMPT_CHANGED",
          "The saved prompt differs from the one on screen (a prompt block may not have saved yet or changed elsewhere). " +
            "Nothing was submitted. Check the prompt and generate again.",
        );
      }
      const problems = provider.validate(model, { prompt, settings: input.settings });
      if (problems.length) throw badRequest(problems.join(" "));
      const created: string[] = [];
      for (const seed of seeds) {
        const id = newId();
        const now = this.iso();
        shot.generations.push({
          id,
          shotFilename,
          source: { filename: shotFilename, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() },
          providerId: model.providerId,
          modelKey: model.key,
          modelId: model.modelId,
          batchId,
          settings: { ...input.settings, seed: seed ?? null },
          submittedPrompt: prompt,
          expandedPrompt: null,
          providerRequest: null,
          requestId: null,
          status: "queued",
          error: null,
          transientFailures: 0,
          nextAttemptAt: null,
          output: null,
          trim: null,
          createdAt: now,
          submittedAt: null,
          completedAt: null,
          updatedAt: now,
        });
        created.push(id);
      }
      return created;
    });
    this.activeFilms.add(film);
    void this.tick();
    return ids;
  }

  /** Re-polls a failed job that already has a request id. Never resubmits. */
  async resume(film: string, generationId: string): Promise<void> {
    await this.store.mutate(film, (s) => {
      const g = requireGeneration(s, generationId);
      if (g.status !== "failed" || !g.requestId) {
        throw conflict("NOT_RESUMABLE", "Only failed jobs that the provider accepted can be resumed.");
      }
      if (g.error && !["status", "result", "download", "probe"].includes(g.error.stage)) {
        throw conflict("NOT_RESUMABLE", "This job failed before or during submission; generate again instead.");
      }
      g.status = "processing";
      g.error = null;
      g.transientFailures = 0;
      g.nextAttemptAt = null;
      g.updatedAt = this.iso();
    });
    this.activeFilms.add(film);
    void this.tick();
  }

  /** User confirms an uncertain job should be treated as failed (does not cancel anything remotely). */
  async acknowledgeUncertain(film: string, generationId: string): Promise<void> {
    await this.store.mutate(film, (s) => {
      const g = requireGeneration(s, generationId);
      if (g.status !== "uncertain") throw conflict("NOT_UNCERTAIN", "This job is not in the uncertain state.");
      g.status = "failed";
      g.error = {
        stage: "recovery",
        message: "Marked as failed by you after an interrupted submission. Any remote request was not cancelled.",
        at: this.iso(),
      };
      g.updatedAt = this.iso();
    });
  }

  /** Deletes a finished (completed or failed) job, its files and its timeline uses. Never the source image. */
  async deleteGeneration(film: string, generationId: string): Promise<void> {
    // Check every file this deletion will remove before changing anything.
    const dir = await this.store.guard(generationsDir(this.store.root, film));
    const sidecar = await this.store.guard(path.join(dir, `${generationId}.json`));
    const { state: before } = await this.store.read(film);
    const known = Object.values(before.shots).flatMap((x) => x.generations).find((x) => x.id === generationId);
    const clipPath = known?.output ? await this.store.guard(path.join(dir, assertFileName(known.output.filename))) : null;
    const { result: outputFile } = await this.store.mutate(film, (s) => {
      const g = requireGeneration(s, generationId);
      if (g.status !== "completed" && g.status !== "failed") {
        throw conflict(
          "JOB_ACTIVE",
          g.status === "uncertain"
            ? "Mark this job as failed before deleting it."
            : "This job is still running remotely. Deleting the local record would not stop it or its cost, so delete it after it finishes.",
        );
      }
      for (const shot of Object.values(s.shots)) shot.generations = shot.generations.filter((x) => x.id !== generationId);
      s.timeline = s.timeline.filter((c) => c.generationId !== generationId);
      return g.output?.filename ?? null;
    });
    if (outputFile) {
      const target = clipPath && path.basename(clipPath) === outputFile ? clipPath : await this.store.guard(path.join(dir, assertFileName(outputFile)));
      await unlink(target).catch(() => undefined);
    }
    await unlink(sidecar).catch(() => undefined);
  }

  private async countQueued(): Promise<number> {
    let n = 0;
    for (const film of this.activeFilms) {
      try {
        const { state } = await this.store.read(film);
        n += allGenerations(state).filter((g) => g.status === "queued").length;
      } catch {
        /* broken film: ignore */
      }
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // Worker loop
  // -------------------------------------------------------------------------

  /** One pass over active jobs. Safe to call often; overlapping calls are skipped. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const film of [...this.activeFilms]) {
        let state: FilmState;
        try {
          ({ state } = await this.store.read(film));
        } catch (err) {
          this.log(`[worker] cannot read film "${film}": ${errorMessage(err)}`);
          continue;
        }
        const jobs = allGenerations(state).filter((g) => ACTIVE_STATUSES.has(g.status));
        if (jobs.length === 0) {
          this.activeFilms.delete(film);
          continue;
        }
        const queued = jobs.filter((g) => g.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const job of queued) {
          if (this.submitting >= this.cfg.submitConcurrency) break;
          this.claim(film, job.id, () => this.submitJob(film, job.id));
        }
        for (const job of jobs) {
          if (job.status !== "submitted" && job.status !== "processing") continue;
          if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > this.now()) continue;
          this.claim(film, job.id, () => this.pollJob(film, job.id));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Runs work for one job unless another worker already owns it. */
  private claim(film: string, id: string, work: () => Promise<void>): void {
    const key = `${film}\u0000${id}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    work()
      .catch((err) => this.log(`[worker] ${film}/${id}: ${errorMessage(err)}`))
      .finally(() => this.inFlight.delete(key));
  }

  /** Waits until no worker owns any job (tests and shutdown). */
  async idle(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (this.inFlight.size > 0) {
      if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for workers.");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private async update(film: string, id: string, fn: (g: Generation) => void): Promise<Generation> {
    const { result } = await this.store.mutate(film, (s) => {
      const g = requireGeneration(s, id);
      fn(g);
      g.updatedAt = this.iso();
      return structuredClone(g);
    });
    return result;
  }

  private fail(film: string, id: string, stage: GenerationError["stage"], message: string): Promise<Generation> {
    return this.update(film, id, (g) => {
      g.status = "failed";
      g.error = { stage, message, at: this.iso() };
      g.nextAttemptAt = null;
    });
  }

  private async submitJob(film: string, id: string): Promise<void> {
    this.submitting++;
    try {
      const { state } = await this.store.read(film);
      const job = requireGeneration(state, id);
      if (job.status !== "queued") return;
      const model = getModel(job.modelKey);
      const provider = this.providers.get(job.providerId);
      if (!model || !provider) {
        await this.fail(film, id, "validate", `Provider "${job.providerId}" / model "${job.modelKey}" is not available in this build.`);
        return;
      }
      const reason = provider.unavailableReason();
      if (reason) {
        await this.fail(film, id, "validate", `Not submitted: ${reason}`);
        return;
      }

      // Upload happens while still "queued": nothing billable has happened yet,
      // so a crash here simply retries the upload on the next run.
      let sourceUrl: string;
      try {
        const sourcePath = await this.store.filmPath(film, job.source.filename);
        if (!existsSync(sourcePath)) throw new Error(`"${job.source.filename}" is no longer in the film folder.`);
        sourceUrl = await provider.uploadSource(model, {
          path: sourcePath,
          filename: job.source.filename,
          mimeType: MIME[path.extname(job.source.filename).toLowerCase()] ?? "application/octet-stream",
        });
      } catch (err) {
        await this.fail(film, id, "upload", `Not submitted: ${errorMessage(err)}`);
        return;
      }

      // From here on a crash leaves the job "submitting", which recovery reports as uncertain.
      await this.update(film, id, (g) => {
        g.status = "submitting";
      });
      let submitted: Awaited<ReturnType<GenerationProvider["submit"]>>;
      try {
        submitted = await provider.submit(model, { prompt: job.submittedPrompt, sourceUrl, settings: job.settings });
      } catch (err) {
        if (err instanceof ProviderError && err.kind === "permanent") {
          await this.fail(film, id, "submit", err.message);
        } else {
          await this.update(film, id, (g) => {
            g.status = "uncertain";
            g.error = {
              stage: "submit",
              message: `${errorMessage(err)} Shotloom will not resubmit automatically; check your provider dashboard.`,
              at: this.iso(),
            };
          });
        }
        return;
      }
      try {
        await this.update(film, id, (g) => {
          g.status = "submitted";
          g.requestId = submitted.requestId;
          g.providerRequest = submitted.request;
          g.submittedAt = this.iso();
        });
      } catch (err) {
        // The request exists remotely but could not be recorded. Leave a trail.
        this.log(
          `[worker] IMPORTANT: ${film}/${id} was accepted as request ${submitted.requestId} but saving that failed: ${errorMessage(err)}`,
        );
        throw err;
      }
    } finally {
      this.submitting--;
    }
  }

  private async pollJob(film: string, id: string): Promise<void> {
    const { state } = await this.store.read(film);
    const job = requireGeneration(state, id);
    if ((job.status !== "submitted" && job.status !== "processing") || !job.requestId) return;
    const model = getModel(job.modelKey);
    const provider = this.providers.get(job.providerId);
    if (!model || !provider || provider.unavailableReason()) return; // wait; shown in UI as provider unavailable
    const ref: JobRef = { requestId: job.requestId, providerRequest: job.providerRequest };

    let stage: GenerationError["stage"] = "status";
    try {
      const remote = await provider.status(model, ref);
      if (remote !== "completed") {
        const next = remote === "queued" ? "submitted" : "processing";
        if (job.status !== next || job.transientFailures > 0) {
          await this.update(film, id, (g) => {
            g.status = next;
            g.transientFailures = 0;
            g.nextAttemptAt = null;
          });
        }
        return;
      }
      await this.update(film, id, (g) => {
        g.status = "downloading";
      });
      stage = "result";
      const result = await provider.result(model, ref);
      stage = "download";
      const dir = await this.store.guard(generationsDir(this.store.root, film));
      const filename = `${id}.mp4`;
      const finalPath = await this.store.guard(path.join(dir, filename));
      const partPath = await this.store.guard(`${finalPath}.part`);
      await mkdir(dir, { recursive: true });
      await rm(partPath, { force: true });
      try {
        await provider.download(model, ref, result, partPath);
        stage = "probe";
        const probe = await probeMedia(this.tools, partPath).catch((err) => {
          throw new ProviderError("permanent", `The downloaded file is not a readable video: ${errorMessage(err)}`);
        });
        if (!probe.hasVideo || !probe.width || !probe.height) {
          throw new ProviderError("permanent", "The downloaded file has no video stream.");
        }
        await rename(partPath, finalPath);
        const size = (await stat(finalPath)).size;
        const output = {
          filename,
          sizeBytes: size,
          durationSec: probe.durationSec,
          width: probe.width,
          height: probe.height,
          hasAudio: probe.hasAudio,
        };
        const done = await this.update(film, id, (g) => {
          g.status = "completed";
          g.output = output;
          g.expandedPrompt = result.expandedPrompt;
          g.completedAt = this.iso();
          g.error = null;
          g.transientFailures = 0;
          g.nextAttemptAt = null;
        });
        await this.writeSidecar(film, done).catch((err) => this.log(`[worker] sidecar for ${id}: ${errorMessage(err)}`));
      } finally {
        await rm(partPath, { force: true }).catch(() => undefined);
      }
    } catch (err) {
      await this.handlePollError(film, id, stage, err);
    }
  }

  private async handlePollError(film: string, id: string, stage: GenerationError["stage"], err: unknown): Promise<void> {
    // AppErrors are definite local problems (e.g. a folder linked outside the films root): no retrying.
    const permanent = (err instanceof ProviderError && err.kind === "permanent") || err instanceof AppError;
    if (permanent) {
      await this.fail(film, id, stage, errorMessage(err));
      return;
    }
    await this.update(film, id, (g) => {
      g.transientFailures += 1;
      if (g.status === "downloading") g.status = "processing";
      if (g.transientFailures > this.cfg.maxTransientFailures) {
        g.status = "failed";
        g.error = {
          stage,
          message:
            `Gave up after ${g.transientFailures} attempts: ${errorMessage(err)} The request may still finish remotely; ` +
            "use Resume to check again (this does not start a new generation).",
          at: this.iso(),
        };
        g.nextAttemptAt = null;
      } else {
        const delay = Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 2 ** (g.transientFailures - 1));
        g.nextAttemptAt = this.iso(this.now() + delay);
        g.error = { stage, message: `Retrying: ${errorMessage(err)}`, at: this.iso() };
      }
    });
  }

  /** Human-readable metadata next to each clip. Contains no credentials. */
  private async writeSidecar(film: string, g: Generation): Promise<void> {
    const dir = await this.store.guard(generationsDir(this.store.root, film));
    const meta = {
      app: "Shotloom",
      film,
      generationId: g.id,
      shot: g.shotFilename,
      source: g.source,
      provider: g.providerId,
      model: g.modelId,
      requestId: g.requestId,
      settings: g.settings,
      submittedPrompt: g.submittedPrompt,
      expandedPrompt: g.expandedPrompt,
      providerRequest: g.providerRequest,
      output: g.output,
      createdAt: g.createdAt,
      submittedAt: g.submittedAt,
      completedAt: g.completedAt,
    };
    await writeFile(await this.store.guard(path.join(dir, `${g.id}.json`)), JSON.stringify(meta, null, 2) + "\n");
  }
}

export function allGenerations(state: FilmState): Generation[] {
  return Object.values(state.shots).flatMap((s) => s.generations);
}

function requireGeneration(state: FilmState, id: string): Generation {
  for (const shot of Object.values(state.shots)) {
    const g = shot.generations.find((x) => x.id === id);
    if (g) return g;
  }
  throw notFound(`Generation "${id}" was not found.`);
}

/** n distinct uniformly random integers in [min, max]. */
export function distinctSeeds(n: number, min: number, max: number): number[] {
  const seeds = new Set<number>();
  const span = max - min + 1;
  const buf = new Uint32Array(1);
  while (seeds.size < n) {
    crypto.getRandomValues(buf);
    seeds.add(min + ((buf[0] ?? 0) % span));
  }
  return [...seeds];
}
