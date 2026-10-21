/**
 * fal adapter tests with a fake client and fake fetch: no network, no charges.
 */
import { describe, expect, test } from "bun:test";
import { ApiError } from "@fal-ai/client";
import { buildRequest, createFalProvider, type FalClientLike } from "../server/generation/providers/fal";
import { ProviderError } from "../server/generation/providers/types";
import { MINIMAX_H3_MAX_I2V } from "../shared/models";

const KEY = "test-key-should-never-leak-0123456789";
const model = MINIMAX_H3_MAX_I2V;
const settings = { durationSec: 6, resolution: "768P", seed: 42 };

function fakeClient(over: Partial<FalClientLike["queue"]> = {}): FalClientLike {
  return {
    storage: { upload: async () => "https://fal.media/files/source.png" },
    queue: {
      status: async () => ({ status: "IN_PROGRESS" }),
      result: async () => ({ data: { video: { url: "https://fal.media/out.mp4" }, expanded_prompt: "A richer prompt" } }),
      ...over,
    },
  };
}

function recordingFetch(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { fn, calls };
}

describe("request mapping", () => {
  test("sends exactly the documented fields", () => {
    expect(buildRequest("p", "https://img", settings)).toEqual({
      prompt: "p",
      image_url: "https://img",
      duration: 6,
      resolution: "768P",
      seed: 42,
      prompt_expansion_mode: "balanced",
    });
  });
  test("omits seed when random; never adds invented controls", () => {
    const body = buildRequest("p", "u", { ...settings, seed: null });
    expect("seed" in body).toBe(false);
    for (const k of ["motion_strength", "camera", "guidance_scale", "negative_prompt"]) expect(k in body).toBe(false);
  });
});

describe("submit", () => {
  test("posts once to the queue endpoint with the key only in the Authorization header", async () => {
    const { fn, calls } = recordingFetch(() => Response.json({ request_id: "req-1" }));
    const fal = createFalProvider({ apiKey: KEY, client: fakeClient(), fetchFn: fn });
    const res = await fal.submit(model, { prompt: "hello", sourceUrl: "https://img", settings });
    expect(res.requestId).toBe("req-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://queue.fal.run/minimax/h3-max/image-to-video");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Key ${KEY}`);
    expect(JSON.stringify(res.request)).not.toContain(KEY);
    expect(String(calls[0]!.init.body)).not.toContain(KEY);
  });

  test("network failure and 5xx are ambiguous (possible charge), never retried", async () => {
    const boom = recordingFetch(() => {
      throw new TypeError("socket hang up");
    });
    const fal1 = createFalProvider({ apiKey: KEY, client: fakeClient(), fetchFn: boom.fn });
    const e1 = await fal1.submit(model, { prompt: "x", sourceUrl: "u", settings }).catch((e) => e);
    expect(e1).toBeInstanceOf(ProviderError);
    expect((e1 as ProviderError).kind).toBe("ambiguous");
    expect(boom.calls).toHaveLength(1);

    const five = recordingFetch(() => new Response("{}", { status: 503 }));
    const fal2 = createFalProvider({ apiKey: KEY, client: fakeClient(), fetchFn: five.fn });
    const e2 = (await fal2.submit(model, { prompt: "x", sourceUrl: "u", settings }).catch((e) => e)) as ProviderError;
    expect(e2.kind).toBe("ambiguous");
    expect(five.calls).toHaveLength(1);
  });

  test("4xx (including 429) is a definite, permanent rejection with the provider's message", async () => {
    const bad = recordingFetch(() =>
      Response.json({ detail: [{ loc: ["body", "duration"], msg: "too long" }] }, { status: 422 }),
    );
    const fal = createFalProvider({ apiKey: KEY, client: fakeClient(), fetchFn: bad.fn });
    const e = (await fal.submit(model, { prompt: "x", sourceUrl: "u", settings }).catch((x) => x)) as ProviderError;
    expect(e.kind).toBe("permanent");
    expect(e.message).toContain("body.duration: too long");
    expect(e.message).not.toContain(KEY);

    const limited = recordingFetch(() => new Response("{}", { status: 429 }));
    const fal2 = createFalProvider({ apiKey: KEY, client: fakeClient(), fetchFn: limited.fn });
    const e2 = (await fal2.submit(model, { prompt: "x", sourceUrl: "u", settings }).catch((x) => x)) as ProviderError;
    expect(e2.kind).toBe("permanent");
    expect(e2.message).toMatch(/not accepted/);
  });

  test("without a key nothing is sent and the reason is explained", async () => {
    const { fn, calls } = recordingFetch(() => Response.json({}));
    const fal = createFalProvider({ apiKey: null, fetchFn: fn });
    expect(fal.unavailableReason()).toMatch(/FAL_KEY/);
    await expect(fal.submit(model, { prompt: "x", sourceUrl: "u", settings })).rejects.toThrow(/FAL_KEY/);
    expect(calls).toHaveLength(0);
  });
});

describe("status, result, download", () => {
  const job = { requestId: "req-1", providerRequest: null };

  test("maps queue statuses", async () => {
    for (const [raw, mapped] of [
      ["IN_QUEUE", "queued"],
      ["IN_PROGRESS", "processing"],
      ["COMPLETED", "completed"],
    ] as const) {
      const fal = createFalProvider({ apiKey: KEY, client: fakeClient({ status: async () => ({ status: raw }) }) });
      expect(await fal.status(model, job)).toBe(mapped);
    }
  });

  test("result keeps the expanded prompt separately and handles null", async () => {
    const fal = createFalProvider({ apiKey: KEY, client: fakeClient() });
    expect(await fal.result(model, job)).toEqual({ outputUrl: "https://fal.media/out.mp4", expandedPrompt: "A richer prompt" });
    const fal2 = createFalProvider({
      apiKey: KEY,
      client: fakeClient({ result: async () => ({ data: { video: { url: "u" }, expanded_prompt: null } }) }),
    });
    expect((await fal2.result(model, job)).expandedPrompt).toBeNull();
  });

  test("classifies read errors: 5xx/network transient, 4xx permanent", async () => {
    const server = createFalProvider({
      apiKey: KEY,
      client: fakeClient({ status: async () => { throw new ApiError({ message: "x", status: 502 }); } }),
    });
    expect(((await server.status(model, job).catch((e) => e)) as ProviderError).kind).toBe("transient");
    const net = createFalProvider({ apiKey: KEY, client: fakeClient({ status: async () => { throw new TypeError("fetch failed"); } }) });
    expect(((await net.status(model, job).catch((e) => e)) as ProviderError).kind).toBe("transient");
    const failed = createFalProvider({
      apiKey: KEY,
      client: fakeClient({ result: async () => { throw new ApiError({ message: "x", status: 422, body: { detail: "NSFW content" } }); } }),
    });
    const e = (await failed.result(model, job).catch((x) => x)) as ProviderError;
    expect(e.kind).toBe("permanent");
    expect(e.message).toContain("NSFW content");
  });

  test("missing video URL is a permanent failure", async () => {
    const fal = createFalProvider({ apiKey: KEY, client: fakeClient({ result: async () => ({ data: {} }) }) });
    expect(((await fal.result(model, job).catch((e) => e)) as ProviderError).kind).toBe("permanent");
  });

  test("download failures are classified", async () => {
    const r404 = recordingFetch(() => new Response("gone", { status: 404 }));
    const fal = createFalProvider({ apiKey: KEY, client: fakeClient(), fetchFn: r404.fn });
    const e = (await fal.download(model, job, { outputUrl: "https://x", expandedPrompt: null }, "/nonexistent/out").catch((x) => x)) as ProviderError;
    expect(e.kind).toBe("permanent");
    const r503 = recordingFetch(() => new Response("busy", { status: 503 }));
    const fal2 = createFalProvider({ apiKey: KEY, client: fakeClient(), fetchFn: r503.fn });
    const e2 = (await fal2.download(model, job, { outputUrl: "https://x", expandedPrompt: null }, "/nonexistent/out").catch((x) => x)) as ProviderError;
    expect(e2.kind).toBe("transient");
  });
});
