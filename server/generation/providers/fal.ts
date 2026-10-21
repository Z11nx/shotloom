/**
 * fal.ai adapter for minimax/h3-max/image-to-video.
 *
 * Request fields used (verified against fal's model API page, Oct 2026):
 *   prompt, image_url, duration, resolution, seed (optional), prompt_expansion_mode
 * Response fields used: video.url, expanded_prompt (nullable).
 * The response does not echo the seed, so the submitted seed is the only record.
 *
 * Submission deliberately bypasses the fal JS client: the client retries
 * submits on 502/503/504, which could create a second billable request if the
 * first was accepted. Here a submit is attempted exactly once and any ambiguous
 * outcome is reported as such.
 *
 * FAL_KEY is held in this module's closure only. It is never returned, logged,
 * or written into request snapshots.
 */
import { ApiError, createFalClient } from "@fal-ai/client";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { GenerationSettings } from "../../../shared/domain";
import type { ModelDescriptor } from "../../../shared/models";
import {
  ProviderError,
  type GenerationProvider,
  type JobRef,
  type RemoteResult,
  type RemoteState,
  type SourceFile,
  type SubmitInput,
  type SubmitResult,
} from "./types";

/** The subset of the fal client this adapter uses (injectable for tests). */
export interface FalClientLike {
  storage: { upload(file: Blob): Promise<string> };
  queue: {
    status(endpointId: string, opts: { requestId: string; logs?: boolean }): Promise<{ status: string }>;
    result(endpointId: string, opts: { requestId: string }): Promise<{ data: unknown }>;
  };
}

export interface FalProviderOptions {
  apiKey: string | null;
  client?: FalClientLike;
  fetchFn?: typeof fetch;
  queueBaseUrl?: string;
  submitTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

const SUPPORTED_MODEL_IDS = new Set(["minimax/h3-max/image-to-video"]);

export function createFalProvider(opts: FalProviderOptions): GenerationProvider {
  const apiKey = opts.apiKey;
  const fetchFn = opts.fetchFn ?? fetch;
  const queueBase = opts.queueBaseUrl ?? "https://queue.fal.run";
  const client: FalClientLike | null =
    opts.client ?? (apiKey ? (createFalClient({ credentials: apiKey }) as unknown as FalClientLike) : null);

  function requireClient(): FalClientLike {
    if (!client || !apiKey) throw new ProviderError("permanent", "FAL_KEY is not configured on the server.");
    return client;
  }

  return {
    id: "fal",
    label: "fal.ai",
    isMock: false,

    unavailableReason() {
      return apiKey ? null : "FAL_KEY is not set. Add it to .env and restart to enable generation.";
    },

    supports(model) {
      return model.providerId === "fal" && SUPPORTED_MODEL_IDS.has(model.modelId);
    },

    validate(_model, input) {
      const errors: string[] = [];
      if (!input.prompt.trim()) errors.push("The prompt is empty. Describe the shot or enable a prompt block.");
      return errors;
    },

    async uploadSource(_model, file: SourceFile) {
      const c = requireClient();
      try {
        const bytes = await Bun.file(file.path).arrayBuffer();
        return await c.storage.upload(new Blob([bytes], { type: file.mimeType }));
      } catch (err) {
        throw new ProviderError("permanent", `Uploading the source image to fal failed: ${describeError(err)}`);
      }
    },

    async submit(model, input: SubmitInput): Promise<SubmitResult> {
      requireClient();
      const request = buildRequest(input.prompt, input.sourceUrl, input.settings);
      let res: Response;
      try {
        res = await fetchFn(`${queueBase}/${model.modelId}`, {
          method: "POST",
          headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(opts.submitTimeoutMs ?? 60_000),
        });
      } catch (err) {
        throw new ProviderError(
          "ambiguous",
          `The connection to fal failed while submitting (${describeError(err)}). The request may or may not have been accepted.`,
        );
      }
      const body = await res.json().catch(() => null);
      if (res.ok) {
        const requestId = (body as { request_id?: unknown } | null)?.request_id;
        if (typeof requestId === "string" && requestId) return { requestId, request };
        throw new ProviderError("ambiguous", "fal accepted the submission but returned no request id.");
      }
      const detail = detailFromBody(body) ?? res.statusText;
      if (res.status >= 500) {
        throw new ProviderError(
          "ambiguous",
          `fal returned HTTP ${res.status} while submitting (${detail}). The request may or may not have been accepted.`,
        );
      }
      if (res.status === 429) {
        throw new ProviderError("permanent", "fal rate-limited the submission (HTTP 429); it was not accepted. Try again shortly.");
      }
      throw new ProviderError("permanent", `fal rejected the request (HTTP ${res.status}): ${detail}`);
    },

    async status(model, job: JobRef): Promise<RemoteState> {
      const c = requireClient();
      try {
        const s = await c.queue.status(model.modelId, { requestId: job.requestId, logs: false });
        if (s.status === "IN_QUEUE") return "queued";
        if (s.status === "IN_PROGRESS") return "processing";
        if (s.status === "COMPLETED") return "completed";
        throw new ProviderError("transient", `Unexpected fal status "${s.status}".`);
      } catch (err) {
        throw classifyReadError(err, "checking status");
      }
    },

    async result(model, job: JobRef): Promise<RemoteResult> {
      const c = requireClient();
      let data: unknown;
      try {
        ({ data } = await c.queue.result(model.modelId, { requestId: job.requestId }));
      } catch (err) {
        throw classifyReadError(err, "fetching the result");
      }
      const d = data as { video?: { url?: unknown }; expanded_prompt?: unknown } | null;
      const url = d?.video?.url;
      if (typeof url !== "string" || !url) {
        throw new ProviderError("permanent", "fal finished but returned no video URL.");
      }
      const expanded = typeof d?.expanded_prompt === "string" && d.expanded_prompt.trim() ? d.expanded_prompt : null;
      return { outputUrl: url, expandedPrompt: expanded };
    },

    async download(_model, _job, result, destPath) {
      let res: Response;
      try {
        res = await fetchFn(result.outputUrl, { signal: AbortSignal.timeout(opts.downloadTimeoutMs ?? 5 * 60_000) });
      } catch (err) {
        throw new ProviderError("transient", `Downloading the video failed: ${describeError(err)}`);
      }
      if (!res.ok || !res.body) {
        const kind = res.status >= 500 || res.status === 429 || res.status === 408 ? "transient" : "permanent";
        throw new ProviderError(kind, `Downloading the video failed (HTTP ${res.status}).`);
      }
      try {
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(destPath));
      } catch (err) {
        throw new ProviderError("transient", `Saving the downloaded video failed: ${describeError(err)}`);
      }
    },
  };
}

/** Maps neutral settings to this endpoint's documented fields. Nothing else is sent. */
export function buildRequest(prompt: string, imageUrl: string, s: GenerationSettings): Record<string, unknown> {
  const request: Record<string, unknown> = {
    prompt,
    image_url: imageUrl,
    duration: s.durationSec,
    resolution: s.resolution,
    prompt_expansion_mode: "balanced",
  };
  if (s.seed !== null) request.seed = s.seed;
  return request;
}

function classifyReadError(err: unknown, action: string): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof ApiError) {
    const status = err.status;
    const detail = detailFromBody(err.body) ?? err.message;
    if (status >= 500 || status === 429 || status === 408) {
      return new ProviderError("transient", `fal HTTP ${status} while ${action}: ${detail}`);
    }
    return new ProviderError("permanent", `fal reported a failure while ${action} (HTTP ${status}): ${detail}`);
  }
  return new ProviderError("transient", `Network problem while ${action}: ${describeError(err)}`);
}

function detailFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const item = d as { msg?: unknown; loc?: unknown };
        const loc = Array.isArray(item.loc) ? item.loc.join(".") : "";
        return [loc, typeof item.msg === "string" ? item.msg : JSON.stringify(d)].filter(Boolean).join(": ");
      })
      .join("; ");
  }
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export type { GenerationProvider };
