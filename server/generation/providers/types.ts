/**
 * The small contract every generation provider implements.
 *
 * The orchestrator speaks only in provider-neutral terms (GenerationSettings,
 * a prompt, a local source file). Each adapter owns the mapping to its own
 * request schema and the interpretation of its own responses.
 */
import type { GenerationSettings } from "../../../shared/domain";
import type { ModelDescriptor } from "../../../shared/models";

/**
 * transient – safe to try the same read-only step again later (status, result, download).
 * permanent – will not succeed by retrying; record as failed.
 * ambiguous – a submission may or may not have been accepted (possible charge); never auto-resubmit.
 */
export type ProviderErrorKind = "transient" | "permanent" | "ambiguous";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface SourceFile {
  path: string;
  filename: string;
  mimeType: string;
}

export interface SubmitInput {
  prompt: string;
  sourceUrl: string;
  settings: GenerationSettings;
}

export interface SubmitResult {
  requestId: string;
  /** The exact body that was sent (no credentials), persisted on the job. */
  request: Record<string, unknown>;
}

/** Everything the adapter may need to follow up on a job after a restart. */
export interface JobRef {
  requestId: string;
  providerRequest: Record<string, unknown> | null;
}

export type RemoteState = "queued" | "processing" | "completed";

export interface RemoteResult {
  outputUrl: string;
  /** Provider-rewritten prompt when reported; null otherwise. */
  expandedPrompt: string | null;
}

export interface GenerationProvider {
  readonly id: string;
  readonly label: string;
  readonly isMock: boolean;
  /** null when the provider can be used right now; otherwise a user-facing reason. */
  unavailableReason(): string | null;
  supports(model: ModelDescriptor): boolean;
  /** Provider-specific checks on top of the descriptor's generic validation. */
  validate(model: ModelDescriptor, input: { prompt: string; settings: GenerationSettings }): string[];
  uploadSource(model: ModelDescriptor, file: SourceFile): Promise<string>;
  /** Must not retry on its own. Ambiguous outcomes must throw ProviderError("ambiguous"). */
  submit(model: ModelDescriptor, input: SubmitInput): Promise<SubmitResult>;
  status(model: ModelDescriptor, job: JobRef): Promise<RemoteState>;
  result(model: ModelDescriptor, job: JobRef): Promise<RemoteResult>;
  /** Writes the output video to destPath (the caller renames it into place). */
  download(model: ModelDescriptor, job: JobRef, result: RemoteResult, destPath: string): Promise<void>;
}
