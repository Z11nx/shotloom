/**
 * Mock provider: fakes the queue lifecycle and renders a real (but obviously
 * fake) MP4 locally with FFmpeg — a slow pan over the source image, a magenta
 * "mock" bar across the top, and a test tone. It never contacts the network.
 *
 * Its state is derived from the request id (which encodes the submission time),
 * so jobs keep progressing correctly across a server restart.
 *
 * Prompt tokens for testing failure paths:
 *   mock:fail          the job fails when its result is fetched
 *   mock:reject        the submission is rejected outright
 *   mock:flaky         the first two status checks fail transiently
 *   mock:silent        the clip has no audio stream
 */
import type { ModelDescriptor } from "../../../shared/models";
import { runFfmpeg, type MediaTools } from "../../media/ffmpeg";
import {
  ProviderError,
  type GenerationProvider,
  type JobRef,
  type RemoteResult,
  type RemoteState,
} from "./types";

export interface MockProviderOptions {
  tools: MediaTools;
  /** ms in the fake queue, then ms "processing". */
  queueMs?: number;
  processMs?: number;
  /** Extra seconds added to the clip, mimicking real providers' small overrun. */
  overrunSec?: number;
  now?: () => number;
}

const RESOLUTION_HEIGHT: Record<string, number> = { "480P": 480, "768P": 768, "1080P": 1080 };

export function createMockProvider(opts: MockProviderOptions): GenerationProvider & {
  submitCount: () => number;
} {
  const now = opts.now ?? Date.now;
  const queueMs = opts.queueMs ?? 1500;
  const processMs = opts.processMs ?? 2500;
  const flakyCalls = new Map<string, number>();
  let submits = 0;

  function submittedAt(requestId: string): number {
    const m = /^mock_(\d+)_/.exec(requestId);
    if (!m) throw new ProviderError("permanent", `Not a mock request id: ${requestId}`);
    return Number(m[1]);
  }

  function promptOf(job: JobRef): string {
    const p = job.providerRequest?.prompt;
    return typeof p === "string" ? p : "";
  }

  return {
    id: "mock",
    label: "Mock (local, no network)",
    isMock: true,
    submitCount: () => submits,

    unavailableReason: () => null,

    supports: (model: ModelDescriptor) => model.providerId === "mock",

    validate(_model, input) {
      return input.prompt.trim() ? [] : ["The prompt is empty. Describe the shot or enable a prompt block."];
    },

    async uploadSource(_model, file) {
      return `mock-source:${file.path}`;
    },

    async submit(_model, input) {
      if (input.prompt.includes("mock:reject")) {
        throw new ProviderError("permanent", "Mock provider rejected the request (mock:reject).");
      }
      submits++;
      const requestId = `mock_${now()}_${crypto.randomUUID().slice(0, 8)}`;
      const request: Record<string, unknown> = {
        prompt: input.prompt,
        image_url: input.sourceUrl,
        duration: input.settings.durationSec,
        resolution: input.settings.resolution,
      };
      if (input.settings.seed !== null) request.seed = input.settings.seed;
      return { requestId, request };
    },

    async status(_model, job): Promise<RemoteState> {
      if (promptOf(job).includes("mock:flaky")) {
        const n = (flakyCalls.get(job.requestId) ?? 0) + 1;
        flakyCalls.set(job.requestId, n);
        if (n <= 2) throw new ProviderError("transient", "Mock provider: simulated network hiccup (mock:flaky).");
      }
      const elapsed = now() - submittedAt(job.requestId);
      if (elapsed < queueMs) return "queued";
      if (elapsed < queueMs + processMs) return "processing";
      return "completed";
    },

    async result(_model, job): Promise<RemoteResult> {
      if (promptOf(job).includes("mock:fail")) {
        throw new ProviderError("permanent", "Mock provider: simulated generation failure (mock:fail).");
      }
      return { outputUrl: `mock-output:${job.requestId}`, expandedPrompt: null };
    },

    async download(_model, job, _result, destPath) {
      const req = job.providerRequest ?? {};
      const source = String(req.image_url ?? "").replace(/^mock-source:/, "");
      const duration = Number(req.duration ?? 5) + (opts.overrunSec ?? 0.3);
      const height = RESOLUTION_HEIGHT[String(req.resolution)] ?? 768;
      const seed = typeof req.seed === "number" ? req.seed : 0;
      const silent = promptOf(job).includes("mock:silent");
      const tone = 220 + (seed % 9) * 55;
      const video =
        `scale=-2:${Math.round(height * 1.12)}:flags=bicubic,` +
        `crop=w=trunc(iw/1.12/2)*2:h=${height}:x=(iw-ow)*t/${duration.toFixed(2)}:y=(ih-oh)/2,` +
        `drawbox=x=0:y=0:w=iw:h=ih/18:color=magenta@0.85:t=fill,fps=30,format=yuv420p`;
      const args = ["-loop", "1", "-framerate", "30", "-i", source];
      if (!silent) args.push("-f", "lavfi", "-i", `sine=frequency=${tone}:sample_rate=48000`);
      args.push("-t", duration.toFixed(3), "-vf", video, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28");
      if (!silent) args.push("-c:a", "aac", "-b:a", "96k");
      args.push("-f", "mp4", destPath);
      try {
        await runFfmpeg(opts.tools, args, 120_000);
      } catch (err) {
        throw new ProviderError("permanent", `Mock render failed: ${(err as Error).message}`);
      }
    },
  };
}
