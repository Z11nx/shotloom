import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { generationsDir } from "../server/films/layout";
import { createMockProvider } from "../server/generation/providers/mock";
import { ProviderError, type GenerationProvider, type RemoteState } from "../server/generation/providers/types";
import { GenerationService } from "../server/generation/service";
import { createFalProvider } from "../server/generation/providers/fal";
import type { FilmStore } from "../server/films/store";
import { MINIMAX_H3_MAX_I2V, MOCK_I2V } from "../shared/models";
import { makeImage, makeVideo, newStore, tempRoot, tools, until } from "./helpers";

const SETTINGS = { durationSec: 6, resolution: "768P", seed: 123 };

let fixtureDir: string;
let fixtureCleanup: () => Promise<void>;
let fixtureVideo: string;
beforeAll(async () => {
  ({ root: fixtureDir, cleanup: fixtureCleanup } = await tempRoot("shotloom-fixture-"));
  fixtureVideo = path.join(fixtureDir, "clip.mp4");
  await makeVideo(fixtureVideo, { color: "red", seconds: 2, audio: true });
});
afterAll(() => fixtureCleanup());

/** Scriptable provider that records every call. Registered under the "mock" id. */
function spyProvider(opts: { status?: () => RemoteState | Error; submit?: () => Error | null } = {}) {
  const calls = { upload: 0, submit: 0, status: 0, result: 0, download: 0 };
  const provider: GenerationProvider = {
    id: "mock",
    label: "Spy",
    isMock: true,
    unavailableReason: () => null,
    supports: () => true,
    validate: (_m, i) => (i.prompt.trim() ? [] : ["empty"]),
    uploadSource: async () => {
      calls.upload++;
      return "spy://source";
    },
    submit: async (_m, input) => {
      calls.submit++;
      const err = opts.submit?.();
      if (err) throw err;
      return { requestId: `spy-${calls.submit}`, request: { prompt: input.prompt, seed: input.settings.seed } };
    },
    status: async () => {
      calls.status++;
      const r = opts.status?.() ?? "completed";
      if (r instanceof Error) throw r;
      return r;
    },
    result: async () => {
      calls.result++;
      await new Promise((r) => setTimeout(r, 30)); // widen the window for overlapping workers
      return { outputUrl: "spy://out", expandedPrompt: "expanded by provider" };
    },
    download: async (_m, _j, _r, dest) => {
      calls.download++;
      await copyFile(fixtureVideo, dest);
    },
  };
  return { provider, calls };
}

let root: string;
let cleanup: () => Promise<void>;
let store: FilmStore;

beforeEach(async () => {
  ({ root, cleanup } = await tempRoot());
  store = newStore(root);
  await store.createFilm("F");
  await makeImage(path.join(root, "F", "shot.png"));
  await store.read("F");
});
afterEach(() => cleanup());

function service(provider: GenerationProvider, extra: Partial<ConstructorParameters<typeof GenerationService>[0]> = {}) {
  return new GenerationService({
    store,
    providers: [provider],
    activeModel: MOCK_I2V,
    tools,
    log: () => undefined,
    pollIntervalMs: 20,
    backoffBaseMs: 10,
    backoffMaxMs: 40,
    ...extra,
  });
}

const gens = async () => (await store.read("F")).state.shots["shot.png"]!.generations;
async function settle(svc: GenerationService) {
  await until(async () => {
    await svc.tick();
    await svc.idle();
    return (await gens()).every((g) => ["completed", "failed", "uncertain"].includes(g.status));
  });
}

describe("enqueue", () => {
  test("Gen 1 creates one job; the visible text is saved and snapshotted atomically", async () => {
    const { provider } = spyProvider();
    const svc = service(provider);
    const ids = await svc.enqueue("F", "shot.png", { text: "latest typed text", settings: SETTINGS, count: 1 });
    expect(ids).toHaveLength(1);
    const { state } = await store.read("F");
    const g = state.shots["shot.png"]!.generations[0]!;
    expect(state.shots["shot.png"]!.text).toBe("latest typed text");
    expect(g.submittedPrompt.endsWith("latest typed text")).toBe(true);
    expect(g.settings).toEqual(SETTINGS);
    expect(g.batchId).toBeNull();
    expect(g.modelKey).toBe(MOCK_I2V.key);
    expect(state.generationSettings).toEqual(SETTINGS);
  });

  test("Gen 4 creates four independent records with distinct random seeds", async () => {
    const { provider } = spyProvider();
    const ids = await service(provider).enqueue("F", "shot.png", { text: "x", settings: SETTINGS, count: 4 });
    expect(new Set(ids).size).toBe(4);
    const list = await gens();
    expect(list).toHaveLength(4);
    const seeds = list.map((g) => g.settings.seed);
    expect(new Set(seeds).size).toBe(4);
    expect(seeds).not.toContain(SETTINGS.seed); // the shared seed is overridden for the batch (overwhelmingly likely)
    expect(new Set(list.map((g) => g.batchId)).size).toBe(1);
    expect(list[0]!.batchId).not.toBeNull();
  });

  test("invalid settings, empty prompts and unsupported sources are refused", async () => {
    const { provider } = spyProvider();
    const svc = service(provider);
    await expect(svc.enqueue("F", "shot.png", { text: "x", settings: { ...SETTINGS, durationSec: 99 }, count: 1 })).rejects.toThrow(/Duration/);
    await expect(svc.enqueue("F", "shot.png", { text: "x", settings: { ...SETTINGS, resolution: "4K" }, count: 1 })).rejects.toThrow(/Resolution/);
    await store.mutate("F", (s) => {
      s.promptBlocks = [];
    });
    await expect(svc.enqueue("F", "shot.png", { text: "   ", settings: SETTINGS, count: 1 })).rejects.toThrow(/empty/);
    await makeImage(path.join(root, "F", "anim.gif"));
    await store.read("F");
    await expect(svc.enqueue("F", "anim.gif", { text: "x", settings: SETTINGS, count: 1 })).rejects.toThrow(/not a documented input/);
  });

  test("the bounded queue refuses more work than it holds", async () => {
    const { provider } = spyProvider();
    const svc = service(provider, { maxQueued: 5 });
    await svc.enqueue("F", "shot.png", { text: "x", settings: SETTINGS, count: 4 });
    await expect(svc.enqueue("F", "shot.png", { text: "x", settings: SETTINGS, count: 4 })).rejects.toThrow(/waiting/);
  });

  test("a provider without credentials refuses; there is no silent fallback to mock", async () => {
    const fal = createFalProvider({ apiKey: null });
    const { provider: mock, calls } = spyProvider();
    const svc = new GenerationService({ store, providers: [fal, mock], activeModel: MINIMAX_H3_MAX_I2V, tools, log: () => undefined });
    await expect(svc.enqueue("F", "shot.png", { text: "x", settings: SETTINGS, count: 1 })).rejects.toThrow(/FAL_KEY/);
    expect(calls.submit).toBe(0);
    expect(await gens()).toHaveLength(0);
  });
});

describe("processing", () => {
  test("job completes only after download and probe; expanded prompt kept separately", async () => {
    const { provider, calls } = spyProvider();
    const svc = service(provider);
    await svc.enqueue("F", "shot.png", { text: "go", settings: SETTINGS, count: 1 });
    await settle(svc);
    const g = (await gens())[0]!;
    expect(g.status).toBe("completed");
    expect(g.requestId).toBe("spy-1");
    expect(g.output?.durationSec).toBeCloseTo(2, 1);
    expect(g.output?.hasAudio).toBe(true);
    expect(g.expandedPrompt).toBe("expanded by provider");
    expect(g.submittedPrompt).not.toBe(g.expandedPrompt);
    expect(calls).toEqual({ upload: 1, submit: 1, status: 1, result: 1, download: 1 });
    const files = await readdir(generationsDir(root, "F"));
    expect(files.sort()).toEqual([`${g.id}.json`, `${g.id}.mp4`]);
    const sidecar = await readFile(path.join(generationsDir(root, "F"), `${g.id}.json`), "utf8");
    expect(sidecar).not.toMatch(/FAL_KEY|Authorization|Key /);
  });

  test("overlapping ticks never process the same job twice", async () => {
    const { provider, calls } = spyProvider();
    const svc = service(provider);
    await svc.enqueue("F", "shot.png", { text: "go", settings: SETTINGS, count: 4 });
    for (let i = 0; i < 30; i++) {
      await Promise.all([svc.tick(), svc.tick(), svc.tick()]);
      await new Promise((r) => setTimeout(r, 5));
    }
    await settle(svc);
    expect(calls.submit).toBe(4);
    expect(calls.result).toBe(4);
    expect(calls.download).toBe(4);
  });

  test("historical prompt and settings stay unchanged after later edits", async () => {
    const { provider } = spyProvider();
    const svc = service(provider);
    await svc.enqueue("F", "shot.png", { text: "first", settings: SETTINGS, count: 1 });
    await settle(svc);
    const before = structuredClone((await gens())[0]!);
    await store.mutate("F", (s) => {
      s.promptBlocks[0]!.text = "changed style";
      s.promptBlocks.push({ id: "n", text: "new block", enabled: true, createdAt: "x", updatedAt: "x" });
      s.shots["shot.png"]!.text = "second";
      s.generationSettings = { durationSec: 10, resolution: "480P", seed: null };
    });
    const after = (await gens())[0]!;
    expect(after.submittedPrompt).toBe(before.submittedPrompt);
    expect(after.settings).toEqual(before.settings);
    expect(after.providerRequest).toEqual(before.providerRequest);
  });

  test("transient status errors back off and recover", async () => {
    let n = 0;
    const { provider, calls } = spyProvider({ status: () => (++n <= 3 ? new ProviderError("transient", "blip") : "completed") });
    const svc = service(provider);
    await svc.enqueue("F", "shot.png", { text: "go", settings: SETTINGS, count: 1 });
    await settle(svc);
    expect((await gens())[0]!.status).toBe("completed");
    expect(calls.status).toBe(4);
    expect(calls.submit).toBe(1);
  });

  test("too many transient errors fail the job; Resume re-polls without resubmitting", async () => {
    let healthy = false;
    const { provider, calls } = spyProvider({ status: () => (healthy ? "completed" : new ProviderError("transient", "down")) });
    const svc = service(provider, { maxTransientFailures: 2 });
    await svc.enqueue("F", "shot.png", { text: "go", settings: SETTINGS, count: 1 });
    await settle(svc);
    const failed = (await gens())[0]!;
    expect(failed.status).toBe("failed");
    expect(failed.error?.message).toMatch(/Resume/);
    healthy = true;
    await svc.resume("F", failed.id);
    await settle(svc);
    expect((await gens())[0]!.status).toBe("completed");
    expect(calls.submit).toBe(1);
  });

  test("an ambiguous submit becomes uncertain and is never resubmitted", async () => {
    const { provider, calls } = spyProvider({ submit: () => new ProviderError("ambiguous", "connection reset") });
    const svc = service(provider);
    await svc.enqueue("F", "shot.png", { text: "go", settings: SETTINGS, count: 1 });
    await settle(svc);
    for (let i = 0; i < 5; i++) await svc.tick();
    await svc.idle();
    const g = (await gens())[0]!;
    expect(g.status).toBe("uncertain");
    expect(calls.submit).toBe(1);
    await expect(svc.deleteGeneration("F", g.id)).rejects.toThrow(/Mark this job as failed/);
    await svc.acknowledgeUncertain("F", g.id);
    expect((await gens())[0]!.status).toBe("failed");
    await svc.deleteGeneration("F", g.id);
    expect(await gens()).toHaveLength(0);
  });

  test("a permanent submit rejection fails visibly", async () => {
    const { provider } = spyProvider({ submit: () => new ProviderError("permanent", "bad input") });
    const svc = service(provider);
    await svc.enqueue("F", "shot.png", { text: "go", settings: SETTINGS, count: 1 });
    await settle(svc);
    const g = (await gens())[0]!;
    expect(g.status).toBe("failed");
    expect(g.error).toMatchObject({ stage: "submit", message: "bad input" });
  });
});

describe("restart recovery", () => {
  test("submitted jobs resume polling with their request id and are not resubmitted", async () => {
    const first = spyProvider({ status: () => "processing" });
    const svc1 = service(first.provider);
    await svc1.enqueue("F", "shot.png", { text: "go", settings: SETTINGS, count: 1 });
    await until(async () => {
      await svc1.tick();
      await svc1.idle();
      return (await gens())[0]!.status === "processing";
    });
    svc1.stop();

    // "Restart": fresh store instance reading from disk, fresh provider and service.
    store = newStore(root);
    const second = spyProvider();
    const svc2 = service(second.provider);
    await svc2.recover();
    await settle(svc2);
    const g = (await gens())[0]!;
    expect(g.status).toBe("completed");
    expect(g.requestId).toBe("spy-1");
    expect(second.calls.submit).toBe(0);
    expect(second.calls.upload).toBe(0);
  });

  test("a job interrupted mid-submission becomes uncertain instead of being resubmitted", async () => {
    const { provider } = spyProvider();
    await service(provider).enqueue("F", "shot.png", { text: "go", settings: SETTINGS, count: 1 });
    await store.mutate("F", (s) => {
      s.shots["shot.png"]!.generations[0]!.status = "submitting";
    });
    store = newStore(root);
    const after = spyProvider();
    const svc = service(after.provider);
    await svc.recover();
    for (let i = 0; i < 5; i++) await svc.tick();
    await svc.idle();
    const g = (await gens())[0]!;
    expect(g.status).toBe("uncertain");
    expect(g.error?.stage).toBe("recovery");
    expect(after.calls.submit).toBe(0);
  });

  test("a job interrupted while downloading downloads again (no new submission)", async () => {
    const { provider } = spyProvider({ status: () => "processing" });
    const svc1 = service(provider);
    await svc1.enqueue("F", "shot.png", { text: "go", settings: SETTINGS, count: 1 });
    await until(async () => {
      await svc1.tick();
      await svc1.idle();
      return (await gens())[0]!.status === "processing";
    });
    await store.mutate("F", (s) => {
      s.shots["shot.png"]!.generations[0]!.status = "downloading";
    });
    store = newStore(root);
    const after = spyProvider();
    const svc2 = service(after.provider);
    await svc2.recover();
    await settle(svc2);
    expect((await gens())[0]!.status).toBe("completed");
    expect(after.calls.submit).toBe(0);
  });
});

describe("history and deletion", () => {
  test("missing source image keeps its generations; deleting a clip removes its timeline use but not the source", async () => {
    const { provider } = spyProvider();
    const svc = service(provider);
    await svc.enqueue("F", "shot.png", { text: "go", settings: SETTINGS, count: 1 });
    await settle(svc);
    const g = (await gens())[0]!;
    await store.mutate("F", (s) => {
      s.timeline.push({ id: "c1", generationId: g.id, muted: false });
    });
    await rename(path.join(root, "F", "shot.png"), path.join(root, "away.png"));
    let { state } = await store.read("F");
    expect(state.shots["shot.png"]!.missingSince).not.toBeNull();
    expect(state.shots["shot.png"]!.generations).toHaveLength(1);
    await rename(path.join(root, "away.png"), path.join(root, "F", "shot.png"));

    await svc.deleteGeneration("F", g.id);
    ({ state } = await store.read("F"));
    expect(state.timeline).toHaveLength(0);
    expect(state.shots["shot.png"]!.generations).toHaveLength(0);
    expect(await Bun.file(path.join(root, "F", "shot.png")).exists()).toBe(true);
    expect(await readdir(generationsDir(root, "F"))).toEqual([]);
  });

  test("active jobs cannot be deleted", async () => {
    const { provider } = spyProvider({ status: () => "processing" });
    const svc = service(provider);
    const [id] = await svc.enqueue("F", "shot.png", { text: "go", settings: SETTINGS, count: 1 });
    await expect(svc.deleteGeneration("F", id!)).rejects.toThrow(/still running/);
  });
});

describe("mock provider (real FFmpeg, no network)", () => {
  test("progresses, renders a playable clip, and fails visibly on request", async () => {
    let clock = 1_000_000;
    const mock = createMockProvider({ tools, queueMs: 100, processMs: 100, now: () => clock });
    const svc = new GenerationService({ store, providers: [mock], activeModel: MOCK_I2V, tools, log: () => undefined, now: () => clock });
    await svc.enqueue("F", "shot.png", { text: "fine", settings: { ...SETTINGS, durationSec: 5, resolution: "480P" }, count: 1 });
    await svc.enqueue("F", "shot.png", { text: "mock:fail", settings: SETTINGS, count: 1 });
    await svc.enqueue("F", "shot.png", { text: "mock:silent", settings: { ...SETTINGS, durationSec: 5, resolution: "480P" }, count: 1 });
    await until(async () => {
      clock += 60;
      await svc.tick();
      await svc.idle();
      return (await gens()).every((g) => ["completed", "failed"].includes(g.status));
    }, 60_000);
    const [ok, bad, silent] = await gens();
    expect(ok!.status).toBe("completed");
    expect(ok!.providerId).toBe("mock");
    expect(ok!.output!.height).toBe(480);
    expect(ok!.output!.durationSec).toBeCloseTo(5.3, 1);
    expect(ok!.output!.hasAudio).toBe(true);
    expect(bad!.status).toBe("failed");
    expect(bad!.error?.message).toMatch(/simulated generation failure/);
    expect(silent!.output!.hasAudio).toBe(false);
    expect(mock.submitCount()).toBe(3);
  }, 90_000);
});
