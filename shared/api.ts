/**
 * HTTP API contract: request body schemas (validated at runtime on the server)
 * and response types (used by the typed client in src/lib/api.ts).
 * See docs/API.md for the route table.
 */
import { z } from "zod";
import { AspectRatioSchema, GenerationSettingsSchema, TrimSchema, type FilmState } from "./domain";
import type { ModelDescriptor } from "./models";

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const CreateFilmBody = z.object({ name: z.string() });
export const OpenFolderBody = z.object({ target: z.enum(["film", "exports"]) });
export const SettingsBody = GenerationSettingsSchema;

export const CreatePromptBlockBody = z.object({ text: z.string().max(20_000), enabled: z.boolean().default(true) });
export const UpdatePromptBlockBody = z
  .object({ text: z.string().max(20_000).optional(), enabled: z.boolean().optional() })
  .refine((b) => b.text !== undefined || b.enabled !== undefined, "Provide text or enabled.");
export const ReorderBody = z.object({ ids: z.array(z.string().min(1)).max(10_000) });
export const ImportPromptBlocksBody = z.object({ sourceFilm: z.string().min(1) });

export const UpdateShotBody = z.object({ text: z.string().max(20_000) });

export const GenerateBody = z.object({
  /** The shot text exactly as currently visible; saved and used atomically. */
  text: z.string().max(20_000),
  settings: GenerationSettingsSchema,
  count: z.union([z.literal(1), z.literal(4)]),
  /**
   * The full prompt the client shows for this shot. When present the server
   * refuses (409 PROMPT_CHANGED, nothing created) if its own composition differs.
   */
  expectedPrompt: z.string().max(200_000).optional(),
});

export const UpdateGenerationBody = z.object({ trim: TrimSchema.nullable() });

export const AddClipBody = z.object({ generationId: z.string().min(1) });
export const UpdateClipBody = z.object({ muted: z.boolean() });
export const SoundtrackBody = z.object({
  filename: z.string().min(1).nullable(),
  offsetSec: z.number().nonnegative().max(24 * 3600).default(0),
});
export const AspectRatioBody = z.object({ aspectRatio: AspectRatioSchema });
export const RenderBody = z.object({ kind: z.enum(["preview", "export"]) });

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface DependencyCheck {
  ok: boolean;
  detail: string;
}

export interface StatusResponse {
  appName: string;
  version: string;
  platform: string;
  provider: {
    id: string;
    label: string;
    isMock: boolean;
    /** False when generation cannot run (e.g. FAL_KEY missing). Editing still works. */
    ready: boolean;
    reason: string | null;
  };
  activeModel: ModelDescriptor;
  falKeyConfigured: boolean;
  ffmpeg: DependencyCheck;
  ffprobe: DependencyCheck;
  filmsRoot: DependencyCheck & { path: string };
}

/**
 * fal credit balance for the top bar. Only numbers and a reason cross to the
 * browser; the key never does.
 */
export type FalBalanceResponse =
  | { state: "ok"; balance: number; currency: string; checkedAt: string }
  /** Not looked up: mock mode, or no key configured. */
  | { state: "off" }
  /** Looked up and failed. `needsBillingKey` means the key lacks billing-read permission. */
  | { state: "unavailable"; needsBillingKey: boolean; message: string; checkedAt: string };

export interface FilmSummary {
  name: string;
}

export interface SourceImageInfo {
  filename: string;
  /** False when the active model does not accept this format; reason explains why. */
  generatable: boolean;
  reason: string | null;
}

export interface RenderOutput {
  kind: "preview" | "export";
  filename: string;
  /** URL the browser can load (cache-busted for previews). */
  url: string;
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface RenderStatus {
  id: string;
  kind: "preview" | "export";
  state: "running" | "done" | "failed";
  step: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  output: RenderOutput | null;
}

export interface FilmView {
  name: string;
  state: FilmState;
  sources: SourceImageInfo[];
  audioFiles: string[];
  render: RenderStatus | null;
}

export interface GenerateResponse {
  generationIds: string[];
  view: FilmView;
}
