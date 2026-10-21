/**
 * Shared domain model for Shotloom.
 *
 * The Zod schemas are the source of truth: they validate state files read from
 * disk and request bodies arriving over HTTP. TypeScript types are inferred from
 * them so the server, client and tests agree on one shape.
 *
 * Nothing in this file knows about any particular provider's request schema.
 */
import { z } from "zod";

export const STATE_VERSION = 1 as const;

const isoDate = z.string().min(1);

// ---------------------------------------------------------------------------
// Prompt blocks
// ---------------------------------------------------------------------------

export const PromptBlockSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  enabled: z.boolean(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type PromptBlock = z.infer<typeof PromptBlockSchema>;

// ---------------------------------------------------------------------------
// Generation settings and records
// ---------------------------------------------------------------------------

/** What the user asked for. Provider-neutral; adapters map it to their own schema. */
export const GenerationSettingsSchema = z.object({
  durationSec: z.number().int().positive(),
  resolution: z.string().min(1),
  /** null = let the provider choose (random). */
  seed: z.number().int().nonnegative().nullable(),
});
export type GenerationSettings = z.infer<typeof GenerationSettingsSchema>;

/**
 * Lifecycle of one generation.
 *
 * queued      – recorded locally, not yet sent anywhere
 * submitting  – upload/submit in flight; if the server dies here acceptance is unknown
 * submitted   – provider accepted it and gave a request id; waiting in provider queue
 * processing  – provider reports it is running
 * downloading – provider finished; saving the result locally
 * completed   – output saved and probed; usable
 * failed      – definitively failed (see error)
 * uncertain   – submission was interrupted; it may or may not have been accepted (and billed)
 */
export const GenerationStatusSchema = z.enum([
  "queued",
  "submitting",
  "submitted",
  "processing",
  "downloading",
  "completed",
  "failed",
  "uncertain",
]);
export type GenerationStatus = z.infer<typeof GenerationStatusSchema>;

export const ACTIVE_STATUSES: ReadonlySet<GenerationStatus> = new Set([
  "queued",
  "submitting",
  "submitted",
  "processing",
  "downloading",
]);

export const TrimSchema = z.object({
  inSec: z.number().nonnegative(),
  outSec: z.number().positive(),
});
export type Trim = z.infer<typeof TrimSchema>;

export const OutputInfoSchema = z.object({
  /** File name inside the film's generations directory. */
  filename: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /** Measured with ffprobe; may differ from the requested duration. */
  durationSec: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  hasAudio: z.boolean(),
});
export type OutputInfo = z.infer<typeof OutputInfoSchema>;

export const GenerationErrorSchema = z.object({
  message: z.string(),
  /** Which step failed: helps decide whether "resume" (re-poll, not billable) makes sense. */
  stage: z.enum(["validate", "upload", "submit", "status", "result", "download", "probe", "recovery"]),
  at: isoDate,
});
export type GenerationError = z.infer<typeof GenerationErrorSchema>;

export const GenerationSchema = z.object({
  id: z.string().min(1),
  shotFilename: z.string().min(1),
  /** Snapshot of the source file at submission, so later replacement is detectable. */
  source: z.object({
    filename: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    modifiedAt: isoDate,
  }),
  /** Provider and model are persisted so polling never follows a later config change. */
  providerId: z.string().min(1),
  modelKey: z.string().min(1),
  modelId: z.string().min(1),
  /** Batch id groups the four records of a "Gen 4" action. */
  batchId: z.string().nullable(),
  settings: GenerationSettingsSchema,
  /** The text this app sent. Not necessarily the text the model used (see expandedPrompt). */
  submittedPrompt: z.string(),
  /** Provider-reported rewritten prompt, if any. */
  expandedPrompt: z.string().nullable(),
  /** Exact request body sent to the provider (no credentials). */
  providerRequest: z.record(z.string(), z.unknown()).nullable(),
  requestId: z.string().nullable(),
  status: GenerationStatusSchema,
  error: GenerationErrorSchema.nullable(),
  /** Consecutive transient failures while polling/downloading; drives backoff. */
  transientFailures: z.number().int().nonnegative(),
  nextAttemptAt: isoDate.nullable(),
  output: OutputInfoSchema.nullable(),
  trim: TrimSchema.nullable(),
  createdAt: isoDate,
  submittedAt: isoDate.nullable(),
  completedAt: isoDate.nullable(),
  updatedAt: isoDate,
});
export type Generation = z.infer<typeof GenerationSchema>;

// ---------------------------------------------------------------------------
// Shots, timeline, film state
// ---------------------------------------------------------------------------

export const ShotSchema = z.object({
  filename: z.string().min(1),
  text: z.string(),
  /** Set when the source image disappears; cleared if it comes back. History is kept. */
  missingSince: isoDate.nullable(),
  generations: z.array(GenerationSchema),
});
export type Shot = z.infer<typeof ShotSchema>;

export const TimelineClipSchema = z.object({
  id: z.string().min(1),
  generationId: z.string().min(1),
  muted: z.boolean(),
});
export type TimelineClip = z.infer<typeof TimelineClipSchema>;

export const SoundtrackSchema = z.object({
  filename: z.string().min(1),
  offsetSec: z.number().nonnegative(),
});
export type Soundtrack = z.infer<typeof SoundtrackSchema>;

export const AspectRatioSchema = z.enum(["16:9", "1:1", "9:16"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const FilmStateSchema = z.object({
  version: z.literal(STATE_VERSION),
  promptBlocks: z.array(PromptBlockSchema),
  shots: z.record(z.string(), ShotSchema),
  timeline: z.array(TimelineClipSchema),
  soundtrack: SoundtrackSchema.nullable(),
  aspectRatio: AspectRatioSchema,
  /** Last-used generation settings for this film (shown in the left panel). */
  generationSettings: GenerationSettingsSchema,
});
export type FilmState = z.infer<typeof FilmStateSchema>;

// ---------------------------------------------------------------------------
// Helpers shared by client and server
// ---------------------------------------------------------------------------

export function findGeneration(state: FilmState, generationId: string): { shot: Shot; generation: Generation } | null {
  for (const shot of Object.values(state.shots)) {
    const generation = shot.generations.find((g) => g.id === generationId);
    if (generation) return { shot, generation };
  }
  return null;
}

/** Overrun beyond the requested duration that is still treated as "on length" (float noise, one frame). */
export const OVERRUN_TOLERANCE_SEC = 0.05;

/**
 * The part of a completed clip Shotloom uses: the requested duration. Providers
 * can return a little more than asked (fal's MiniMax returns about 5.2 s for a
 * 5 s request); the extra tail is ignored everywhere (preview, timeline,
 * export) while the downloaded file is kept exactly as received. A clip that
 * is shorter than requested is used in full.
 */
export function usableDurationSec(generation: Generation): number {
  if (!generation.output) return 0;
  const actual = generation.output.durationSec;
  const requested = generation.settings.durationSec;
  return actual > requested + OVERRUN_TOLERANCE_SEC ? requested : actual;
}

/**
 * Effective [in, out] of a completed generation: the saved trim, or the usable
 * duration. A valid saved trim that runs into the ignored tail is cut at the
 * usable end, unless that would leave less than 0.1 s. Anything else (including
 * an invalid trim past the file's end) is returned as saved, so validation
 * still reports it.
 */
export function effectiveTrim(generation: Generation): Trim | null {
  if (!generation.output) return null;
  const usable = usableDurationSec(generation);
  const t = generation.trim;
  if (!t) return { inSec: 0, outSec: usable };
  const inTail = t.outSec > usable && t.outSec <= generation.output.durationSec + 0.001;
  if (inTail && usable - t.inSec >= 0.1) return { inSec: t.inSec, outSec: usable };
  return t;
}

export function clipDuration(generation: Generation): number {
  const trim = effectiveTrim(generation);
  return trim ? trim.outSec - trim.inSec : 0;
}

/** Validates 0 ≤ in < out ≤ actual duration. Returns an error message or null. */
export function validateTrim(trim: Trim, actualDurationSec: number): string | null {
  if (!Number.isFinite(trim.inSec) || !Number.isFinite(trim.outSec)) return "Trim points must be numbers.";
  if (trim.inSec < 0) return "In point cannot be negative.";
  if (trim.outSec <= trim.inSec) return "Out point must be after the in point.";
  // Small tolerance for float rounding coming from the browser's media clock.
  if (trim.outSec > actualDurationSec + 0.001) {
    return `Out point (${trim.outSec.toFixed(2)}s) is past the end of the clip (${actualDurationSec.toFixed(2)}s).`;
  }
  return null;
}

export const ASPECT_CANVAS: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1440, height: 810 },
  "1:1": { width: 1080, height: 1080 },
  "9:16": { width: 810, height: 1440 },
};
