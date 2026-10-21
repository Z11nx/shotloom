/**
 * Export pipeline tests with generated (original) fixtures. Checks order,
 * trims, canvas size, audio streams, mute/silent handling and short soundtracks
 * with ffprobe and frame sampling.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { FilmState, Generation } from "../shared/domain";
import { generationsDir, exportsDir } from "../server/films/layout";
import type { FilmStore } from "../server/films/store";
import { buildRenderPlan, renderPlan } from "../server/media/render";
import { RenderService } from "../server/media/renderService";
import { probeMedia } from "../server/media/probe";
import { frameColor, makeAudio, makeImage, makeVideo, maxVolume, newStore, tempRoot, tools } from "./helpers";

let root: string;
let cleanup: () => Promise<void>;
let store: FilmStore;

function gen(id: string, shot: string, duration: number, hasAudio: boolean, trim: { inSec: number; outSec: number } | null): Generation {
  const now = "2026-10-01T00:00:00.000Z";
  return {
    id,
    shotFilename: shot,
    source: { filename: shot, sizeBytes: 1, modifiedAt: now },
    providerId: "mock",
    modelKey: "mock-i2v",
    modelId: "mock/image-to-video",
    batchId: null,
    settings: { durationSec: 5, resolution: "768P", seed: 1 },
    submittedPrompt: "p",
    expandedPrompt: null,
    providerRequest: null,
    requestId: `r-${id}`,
    status: "completed",
    error: null,
    transientFailures: 0,
    nextAttemptAt: null,
    output: { filename: `${id}.mp4`, sizeBytes: 1, durationSec: duration, width: 1280, height: 704, hasAudio },
    trim,
    createdAt: now,
    submittedAt: now,
    completedAt: now,
    updatedAt: now,
  };
}

beforeAll(async () => {
  ({ root, cleanup } = await tempRoot());
  store = newStore(root);
  await store.createFilm("R");
  await makeImage(path.join(root, "R", "a.png"));
  await makeImage(path.join(root, "R", "b.png"));
  const gdir = generationsDir(root, "R");
  // Red clip with a tone, blue clip without any audio stream.
  await makeVideo(path.join(gdir, "red.mp4"), { color: "red", seconds: 4, audio: true });
  await makeVideo(path.join(gdir, "blue.mp4"), { color: "blue", seconds: 3, audio: false, size: "1280x736" });
  await makeAudio(path.join(root, "R", "short.mp3"), 1.5);
  const redDur = (await probeMedia(tools, path.join(gdir, "red.mp4"))).durationSec;
  const blueDur = (await probeMedia(tools, path.join(gdir, "blue.mp4"))).durationSec;
  await store.mutate("R", (s) => {
    s.shots["a.png"]!.generations.push(gen("red", "a.png", redDur, true, { inSec: 0.5, outSec: 2.5 }));
    s.shots["b.png"]!.generations.push(gen("blue", "b.png", blueDur, false, { inSec: 1, outSec: 2.5 }));
    // Order: blue first, then red.
    s.timeline = [
      { id: "c-blue", generationId: "blue", muted: false },
      { id: "c-red", generationId: "red", muted: false },
    ];
  });
});
afterAll(() => cleanup());

async function render(mutate: (s: FilmState) => void, name: string) {
  const { state: s0 } = await store.read("R");
  const state = structuredClone(s0);
  mutate(state);
  const { media } = await store.read("R");
  const plan = await buildRenderPlan(root, "R", state, media.audio, tools);
  const out = path.join(root, `${name}.mp4`);
  const probe = await renderPlan(tools, plan, out, path.join(root, "work", name));
  return { out, probe, plan };
}

describe("render pipeline", () => {
  test("two trimmed clips export in timeline order at 16:9 with an audio stream", async () => {
    const { out, probe } = await render(() => undefined, "wide");
    expect(probe.width).toBe(1440);
    expect(probe.height).toBe(810);
    expect(probe.hasAudio).toBe(true);
    expect(probe.durationSec).toBeGreaterThan(3.4);
    expect(probe.durationSec).toBeLessThan(3.6); // 1.5 + 2.0
    const [r1, , b1] = await frameColor(out, 0.5); // inside the blue clip
    const [r2, , b2] = await frameColor(out, 2.5); // inside the red clip
    expect(b1).toBeGreaterThan(150);
    expect(r1).toBeLessThan(60);
    expect(r2).toBeGreaterThan(150);
    expect(b2).toBeLessThan(60);
    // Silent blue clip got synthesized silence; red clip's tone is audible.
    expect(await maxVolume(out, 0.1, 1.2)).toBeLessThan(-60);
    expect(await maxVolume(out, 1.8, 1.0)).toBeGreaterThan(-30);
  });

  test("square and vertical canvases", async () => {
    const sq = await render((s) => { s.aspectRatio = "1:1"; }, "square");
    expect([sq.probe.width, sq.probe.height]).toEqual([1080, 1080]);
    const v = await render((s) => { s.aspectRatio = "9:16"; }, "vertical");
    expect([v.probe.width, v.probe.height]).toEqual([810, 1440]);
  });

  test("muted clip audio is silenced", async () => {
    const { out } = await render((s) => { s.timeline[1]!.muted = true; }, "muted");
    expect(await maxVolume(out)).toBeLessThan(-60);
  });

  test("a soundtrack shorter than the timeline does not shorten the video", async () => {
    const { out, probe } = await render((s) => {
      s.timeline.forEach((c) => (c.muted = true));
      s.soundtrack = { filename: "short.mp3", offsetSec: 0.25 };
    }, "soundtrack");
    expect(probe.durationSec).toBeGreaterThan(3.4);
    expect(probe.hasAudio).toBe(true);
    expect(await maxVolume(out, 0, 1.0)).toBeGreaterThan(-30); // soundtrack audible at the start
    const [r] = await frameColor(out, 3.3); // video still present near the end
    expect(r).toBeGreaterThan(150);
  });

  test("final audio fades out at the end", async () => {
    const { out } = await render(() => undefined, "fade");
    expect(await maxVolume(out, 3.42, 0.08)).toBeLessThan(await maxVolume(out, 1.8, 0.2));
  });
});

describe("requested length", () => {
  test("a clip the provider returned longer than requested exports at the requested length", async () => {
    const gdir = generationsDir(root, "R");
    await makeVideo(path.join(gdir, "long.mp4"), { color: "green", seconds: 5.3, audio: true });
    const longDur = (await probeMedia(tools, path.join(gdir, "long.mp4"))).durationSec;
    expect(longDur).toBeGreaterThan(5.2);
    const { out, probe } = await render((s) => {
      s.shots["a.png"]!.generations.push(gen("long", "a.png", longDur, true, null)); // settings ask for 5 s
      s.timeline = [{ id: "c-long", generationId: "long", muted: false }];
    }, "requested-length");
    expect(out).toBeTruthy();
    expect(Math.abs(probe.durationSec - 5)).toBeLessThan(0.05);
  });
});

describe("timeline validation", () => {
  test("rejects an empty timeline, invalid trims, missing files and bad soundtrack offsets", async () => {
    const { state, media } = await store.read("R");
    const empty = { ...structuredClone(state), timeline: [] };
    await expect(buildRenderPlan(root, "R", empty, media.audio, tools)).rejects.toThrow(/empty/);

    const badTrim = structuredClone(state);
    badTrim.shots["a.png"]!.generations[0]!.trim = { inSec: 1, outSec: 99 };
    await expect(buildRenderPlan(root, "R", badTrim, media.audio, tools)).rejects.toThrow(/past the end/);

    const ghost = structuredClone(state);
    ghost.timeline.push({ id: "x", generationId: "nope", muted: false });
    await expect(buildRenderPlan(root, "R", ghost, media.audio, tools)).rejects.toThrow(/no longer exists/);

    const offset = structuredClone(state);
    offset.soundtrack = { filename: "short.mp3", offsetSec: 30 };
    await expect(buildRenderPlan(root, "R", offset, media.audio, tools)).rejects.toThrow(/past the end of "short.mp3"/);

    const gone = structuredClone(state);
    gone.soundtrack = { filename: "deleted.mp3", offsetSec: 0 };
    await expect(buildRenderPlan(root, "R", gone, media.audio, tools)).rejects.toThrow(/no longer in the film folder/);
  });
});

describe("render service", () => {
  test("exports get unique names, conflicting renders are refused, scratch is cleaned", async () => {
    const svc = new RenderService(store, tools, () => undefined);
    const first = await svc.start("R", "export");
    await expect(svc.start("R", "preview")).rejects.toThrow(/already running/);
    await svc.idle();
    await svc.start("R", "export");
    await svc.idle();
    const status = svc.status("R")!;
    expect(status.state).toBe("done");
    expect(status.output!.filename).not.toBe(first.output?.filename);
    const names = await Array.fromAsync(new Bun.Glob("*.mp4").scan(exportsDir(root, "R")));
    expect(names.length).toBe(2);
    expect(new Set(names).size).toBe(2);
    const tmp = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: path.join(root, "R", ".shotloom", "tmp"), onlyFiles: false })).catch(() => []);
    expect(tmp).toEqual([]);
  }, 60_000);

  test("a preview replaces the previous one and has a fresh name", async () => {
    const svc = new RenderService(store, tools, () => undefined);
    await svc.start("R", "preview");
    await svc.idle();
    const a = svc.status("R")!.output!.filename;
    await new Promise((r) => setTimeout(r, 5));
    await svc.start("R", "preview");
    await svc.idle();
    const b = svc.status("R")!.output!.filename;
    expect(a).not.toBe(b);
    const previews = await Array.fromAsync(new Bun.Glob("*").scan(path.join(root, "R", ".shotloom", "preview")));
    expect(previews).toEqual([b]);
  }, 60_000);
});
