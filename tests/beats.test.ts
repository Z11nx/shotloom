import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { activeBeatSync, beatGrid, beatTime, defaultBeatSync, fitsSlot, LOW_CONFIDENCE, planBeatCuts, type BeatAnalysis } from "../shared/beats";
import type { FilmState, Generation } from "../shared/domain";
import { FilmStateSchema } from "../shared/domain";
import { ANALYSIS_SAMPLE_RATE, detectBeats, onsetStrength } from "../server/media/beatDetect";
import { BeatService, decodeMono } from "../server/media/beatService";
import { beatsDir, generationsDir } from "../server/films/layout";
import { buildRenderPlan, FPS, renderPlan } from "../server/media/render";
import { probeMedia } from "../server/media/probe";
import { beatErrors, makeSong, wavBytes } from "./music";
import { makeImage, makeVideo, newStore, req, tempRoot, testApp, tools } from "./helpers";

/** Average RGB of frame number `n` (selected by index, not by time). */
async function frameByIndex(file: string, n: number): Promise<number[]> {
  const proc = Bun.spawn(["ffmpeg", "-v", "error", "-i", file, "-vf", `select='eq(n\\,${n})',scale=1:1`, "-vsync", "0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdout: "pipe", stderr: "pipe" });
  const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  return [buf[0]!, buf[1]!, buf[2]!];
}

/** Seeded random numbers (mulberry32), so "noise" tests are repeatable. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("beat detection", () => {
  const cases = [
    { bpm: 75, durationSec: 30 },
    { bpm: 92, durationSec: 30, swing: 0.33 },
    { bpm: 120, durationSec: 30 },
    { bpm: 128, durationSec: 30, leadInSec: 0.37 },
    { bpm: 140, durationSec: 30 },
    { bpm: 100, durationSec: 30, noDrums: true },
    { bpm: 110, durationSec: 40, endBpm: 116 },
  ];
  for (const spec of cases) {
    test(`finds the beats of a ${JSON.stringify(spec)} song`, () => {
      const song = makeSong(spec);
      const d = detectBeats(song.samples, song.sampleRate);
      const meanBpm = spec.endBpm ? (spec.bpm + spec.endBpm) / 2 : spec.bpm;
      expect(Math.abs(d.bpm - meanBpm) / meanBpm).toBeLessThan(0.03);
      const inner = song.beats.slice(1, -1); // edges may be trimmed as weak
      const errs = beatErrors(inner, d.beats);
      expect(errs.filter((e) => e < 0.035).length / errs.length).toBeGreaterThanOrEqual(0.95);
      // No systematic early/late bias (the attack-latency correction works).
      const signed = inner.map((b) => d.beats.reduce((a, x) => (Math.abs(x - b) < Math.abs(a - b) ? x : a), Infinity) - b);
      expect(Math.abs(signed.reduce((a, b) => a + b, 0) / signed.length)).toBeLessThan(0.008);
      expect(d.confidence).toBeGreaterThanOrEqual(0.6);
      expect(d.energy.length).toBe(d.beats.length);
    });
  }

  test("very fast music may come out at half tempo, still on the beat", () => {
    const song = makeSong({ bpm: 174, durationSec: 30 });
    const d = detectBeats(song.samples, song.sampleRate);
    const ratio = d.bpm / 174;
    expect(Math.abs(ratio - 1) < 0.03 || Math.abs(ratio - 0.5) < 0.03).toBe(true);
    // Every detected beat sits on a real beat.
    expect(Math.max(...beatErrors(d.beats.slice(1, -1), song.beats))).toBeLessThan(0.035);
  });

  test("music without a pulse reports low confidence", () => {
    const sr = 22050;
    const n = sr * 30;
    const r = rng(42);
    const noise = new Float32Array(n).map(() => (r() * 2 - 1) * 0.3);
    const pad = new Float32Array(n).map((_, k) => 0.2 * Math.sin((2 * Math.PI * 220 * k) / sr) * (1 + 0.3 * Math.sin((2 * Math.PI * 0.13 * k) / sr)));
    const hits = new Float32Array(n);
    for (let i = 0; i < 60; i++) {
      const s = Math.floor(r() * (n - 4000));
      for (let k = 0; k < 3000; k++) hits[s + k]! += (r() * 2 - 1) * Math.exp(-k / 400) * 0.6;
    }
    for (const x of [noise, pad, hits]) expect(detectBeats(x, sr).confidence).toBeLessThan(LOW_CONFIDENCE);
    expect(detectBeats(new Float32Array(n), sr)).toMatchObject({ bpm: 0, beats: [], confidence: 0 });
  });
});

const analysis = (beats: number[], extra: Partial<BeatAnalysis> = {}): BeatAnalysis => ({
  version: 1,
  filename: "song.wav",
  sizeBytes: 1,
  modifiedMs: 1,
  durationSec: 60,
  analyzedSec: 60,
  bpm: 120,
  beats,
  confidence: 1,
  energy: beats.map(() => 0.5),
  ...extra,
});

describe("beat grid and cuts", () => {
  const sync = { bpm: null, scale: 1 as const, nudgeSec: 0 };
  const half = Array.from({ length: 8 }, (_, i) => 0.25 + i * 0.5); // 120 BPM from 0.25 s

  test("detected beats, doubled, halved, typed tempo and nudge", () => {
    expect(beatGrid(analysis(half), sync).times).toEqual(half);
    expect(beatGrid(analysis(half), { ...sync, scale: 2 }).times.slice(0, 4)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(beatGrid(analysis(half), { ...sync, scale: 0.5 }).times).toEqual([0.25, 1.25, 2.25, 3.25]);
    const typed = beatGrid(analysis(half, { durationSec: 3 }), { ...sync, bpm: 100 });
    expect(typed.times.slice(0, 3)).toEqual([0.25, 0.85, 1.45]); // phase-locked to the first detected beat
    expect(typed.bpm).toBe(100);
    const nudged = beatGrid(analysis(half), { ...sync, nudgeSec: -0.3 });
    expect(nudged.times[0]).toBe(0.45); // 0.25 - 0.3 < 0 is dropped
  });

  test("the grid continues past the song at the typical beat length", () => {
    const g = beatGrid(analysis(half), sync);
    expect(beatTime(g, 7)).toBe(3.75);
    expect(beatTime(g, 9)).toBeCloseTo(4.75, 6);
  });

  test("cuts land on beats, frame-exact, with per-clip beat counts", () => {
    const g = beatGrid(analysis(half), sync);
    const plan = planBeatCuts(g, { startBeat: 1, beatsPerClip: 2 }, [
      { id: "a", beats: null },
      { id: "b", beats: 3 },
      { id: "c", beats: 1 },
    ], 30);
    expect(plan.offsetSec).toBe(0.75);
    expect(plan.cuts.map((c) => [c.startBeat, c.beats, c.startFrame, c.frames])).toEqual([
      [1, 2, 0, 30],
      [3, 3, 30, 45],
      [6, 1, 75, 15],
    ]);
    expect(plan.totalSec).toBe(3);
  });

  test("no drift over a long song with an awkward tempo", () => {
    const period = 60 / 123.4;
    const beats = Array.from({ length: 400 }, (_, i) => 0.113 + i * period);
    const g = beatGrid(analysis(beats, { durationSec: 200 }), sync);
    const clips = Array.from({ length: 150 }, (_, i) => ({ id: String(i), beats: null }));
    const plan = planBeatCuts(g, { startBeat: 0, beatsPerClip: 2 }, clips, 30);
    let frame = 0;
    plan.cuts.forEach((c, i) => {
      expect(c.startFrame).toBe(frame); // segments are contiguous
      frame += c.frames;
      const beatFilmTime = beats[i * 2]! - beats[0]!;
      expect(Math.abs(c.startSec - beatFilmTime)).toBeLessThanOrEqual(1 / 60 + 1e-9); // within half a frame
    });
  });

  test("a clip fits its slot only if there is enough video from its in-point", () => {
    const g = { output: { durationSec: 5.2 }, settings: { durationSec: 5 }, trim: { inSec: 1, outSec: 2 } } as unknown as Generation;
    expect(fitsSlot(g, 4, 30)).toBe(true); // 5 - 1 = 4 s available (out-point ignored)
    expect(fitsSlot(g, 4.1, 30)).toBe(false);
  });

  test("beat sync applies only when on and a soundtrack is chosen", () => {
    const base = { beatSync: defaultBeatSync(), soundtrack: { filename: "s.wav", offsetSec: 0 } } as FilmState;
    expect(activeBeatSync(base)).not.toBeNull();
    expect(activeBeatSync({ ...base, soundtrack: null })).toBeNull();
    expect(activeBeatSync({ ...base, beatSync: { ...defaultBeatSync(), enabled: false } })).toBeNull();
  });

  test("films saved before beat sync load with it off", () => {
    const old = { version: 1, promptBlocks: [], shots: {}, timeline: [{ id: "c", generationId: "g", muted: false }], soundtrack: null, aspectRatio: "16:9", generationSettings: { durationSec: 5, resolution: "768P", seed: null } };
    const parsed = FilmStateSchema.parse(old);
    expect(parsed.beatSync).toBeNull();
    expect(parsed.timeline[0]!.beats).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Real files: analysis cache and a frame-checked export
// ---------------------------------------------------------------------------

let root: string;
let cleanup: () => Promise<void>;
let store: ReturnType<typeof newStore>;
const song = makeSong({ bpm: 120, durationSec: 12, leadInSec: 0.37 });

function gen(id: string, shot: string, durationSec: number): Generation {
  const now = new Date().toISOString();
  return {
    id, shotFilename: shot, source: { filename: shot, sizeBytes: 1, modifiedAt: now }, providerId: "mock", modelKey: "mock", modelId: "mock",
    batchId: null, settings: { durationSec: 4, resolution: "768P", seed: 1 }, submittedPrompt: "p", expandedPrompt: null, providerRequest: null,
    requestId: "r", status: "completed", error: null, transientFailures: 0, nextAttemptAt: null,
    output: { filename: `${id}.mp4`, sizeBytes: 1, durationSec, width: 1280, height: 704, hasAudio: false },
    trim: null, createdAt: now, submittedAt: now, completedAt: now, updatedAt: now,
  };
}

beforeAll(async () => {
  ({ root, cleanup } = await tempRoot());
  store = newStore(root);
  await store.createFilm("B");
  for (const s of ["a.png", "b.png", "c.png"]) await makeImage(path.join(root, "B", s));
  await writeFile(path.join(root, "B", "song.wav"), wavBytes(song));
  const gdir = generationsDir(root, "B");
  const colors = { red: "red", lime: "lime", blue: "blue" };
  for (const [id, color] of Object.entries(colors)) await makeVideo(path.join(gdir, `${id}.mp4`), { color, seconds: 4, audio: false });
  const dur = (await probeMedia(tools, path.join(gdir, "red.mp4"))).durationSec;
  await store.mutate("B", (s) => {
    s.shots["a.png"]!.generations.push(gen("red", "a.png", dur));
    s.shots["b.png"]!.generations.push(gen("lime", "b.png", dur));
    s.shots["c.png"]!.generations.push(gen("blue", "c.png", dur));
    s.timeline = [
      { id: "c1", generationId: "red", muted: false, beats: null },
      { id: "c2", generationId: "lime", muted: false, beats: 3 },
      { id: "c3", generationId: "blue", muted: false, beats: 1 },
    ];
    s.soundtrack = { filename: "song.wav", offsetSec: 0 };
    s.beatSync = { ...defaultBeatSync(), beatsPerClip: 2, startBeat: 2 };
  });
});
afterAll(() => cleanup());

describe("beat analysis service", () => {
  test("analyzes once, then answers from memory and from the disk cache", async () => {
    let decodes = 0;
    const counting = async (t: typeof tools, f: string) => {
      decodes++;
      return decodeMono(t, f);
    };
    const a = await new BeatService(store, tools, counting).get("B", "song.wav");
    expect(Math.abs(a.bpm - 120)).toBeLessThan(2);
    expect(decodes).toBe(1);
    const svc = new BeatService(store, tools, counting);
    const [b, c] = await Promise.all([svc.get("B", "song.wav"), svc.get("B", "song.wav")]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(decodes).toBe(1); // read from .shotloom/beats
    expect((await readdir(beatsDir(root, "B"))).filter((n) => n.endsWith(".json")).length).toBe(1);
    // A changed file is analyzed again.
    const later = new Date(Date.now() + 5000);
    await utimes(path.join(root, "B", "song.wav"), later, later);
    await new BeatService(store, tools, counting).get("B", "song.wav");
    expect(decodes).toBe(2);
  });

  test("unreadable audio is a clear error, not a crash", async () => {
    await writeFile(path.join(root, "B", "broken.mp3"), "not audio");
    await expect(new BeatService(store, tools).get("B", "broken.mp3")).rejects.toThrow(/Could not read "broken.mp3"/);
  });
});

describe("cut-to-beat export", () => {
  test("every cut lands on a beat of the song, frame-exact", async () => {
    const { state, media } = await store.read("B");
    const a = await new BeatService(store, tools).get("B", "song.wav");
    const plan = await buildRenderPlan(root, "B", state, media.audio, tools, a);
    expect(plan.clips.map((c) => c.frames)).toEqual([30, 45, 15]); // 2, 3 and 1 beats at 120 BPM
    expect(plan.soundtrack!.offsetSec).toBeCloseTo(song.beats[2]!, 1);
    const out = path.join(root, "beat.mp4");
    const probe = await renderPlan(tools, plan, out, path.join(root, "work-beat"));
    expect(Math.abs(probe.durationSec - 3)).toBeLessThan(0.05);

    // Colors switch exactly at frames 30 and 75 (checked by frame number, one frame either side).
    const at = (frame: number) => frameByIndex(out, frame);
    const isRed = ([r, g, b]: number[]) => r! > 180 && g! < 80 && b! < 80;
    const isLime = ([r, g, b]: number[]) => g! > 180 && r! < 80 && b! < 80;
    const isBlue = ([r, g, b]: number[]) => b! > 180 && r! < 80 && g! < 80;
    expect(isRed(await at(29))).toBe(true);
    expect(isLime(await at(30))).toBe(true);
    expect(isLime(await at(74))).toBe(true);
    expect(isBlue(await at(75))).toBe(true);

    // The cuts (film 1.0 s and 2.5 s) are true beats of the song...
    for (const cut of [1.0, 2.5]) {
      const songTime = plan.soundtrack!.offsetSec + cut;
      expect(Math.min(...song.beats.map((b) => Math.abs(b - songTime)))).toBeLessThan(0.035);
    }
    // ...and in the exported file a drum hit is heard right at each cut.
    const env = onsetStrength(await decodeMono(tools, out));
    const fr = ANALYSIS_SAMPLE_RATE / 256;
    for (const cut of [1.0, 2.5]) {
      let best = 0;
      for (let i = Math.round((cut - 0.1) * fr); i <= Math.round((cut + 0.1) * fr); i++) if (env[i]! > env[best]!) best = i;
      expect(Math.abs(best / fr - cut)).toBeLessThan(0.035);
    }
  });

  test("a clip too short for its slot is refused with a clear reason", async () => {
    const { state, media } = await store.read("B");
    const s = structuredClone(state);
    s.timeline[0]!.beats = 16; // 8 s at 120 BPM; the clip has 4 s
    const a = await new BeatService(store, tools).get("B", "song.wav");
    await expect(buildRenderPlan(root, "B", s, media.audio, tools, a)).rejects.toThrow(/16-beat slot needs 8\.0s\. Give it fewer beats/);
  });
});

describe("beat routes", () => {
  test("analysis, settings, per-clip beats, and a new song resets the grid", async () => {
    const app = testApp(root);
    const beats = await (await app.fetch(req("GET", "/api/films/B/soundtrack/beats"))).json();
    expect(Math.abs(beats.bpm - 120)).toBeLessThan(2);
    expect(JSON.stringify(beats)).not.toContain(root); // no local paths sent to the browser

    let r = await app.fetch(req("PUT", "/api/films/B/beat-sync", { beatSync: { ...defaultBeatSync(), beatsPerClip: 8, startBeat: 5, nudgeSec: 0.01234 } }));
    let v = await r.json();
    expect(v.state.beatSync).toMatchObject({ beatsPerClip: 8, startBeat: 5, nudgeSec: 0.012 });
    r = await app.fetch(req("PUT", "/api/films/B/beat-sync", { beatSync: { ...defaultBeatSync(), beatsPerClip: 0 } }));
    expect(r.status).toBe(400);

    v = await (await app.fetch(req("PATCH", "/api/films/B/timeline/c1", { beats: 2 }))).json();
    expect(v.state.timeline[0]).toMatchObject({ beats: 2, muted: false });
    v = await (await app.fetch(req("PATCH", "/api/films/B/timeline/c1", { muted: true }))).json();
    expect(v.state.timeline[0]).toMatchObject({ beats: 2, muted: true });
    expect((await app.fetch(req("PATCH", "/api/films/B/timeline/c1", {}))).status).toBe(400);

    await writeFile(path.join(root, "B", "other.wav"), wavBytes(makeSong({ bpm: 90, durationSec: 5 })));
    v = await (await app.fetch(req("PUT", "/api/films/B/soundtrack", { filename: "other.wav", offsetSec: 0 }))).json();
    expect(v.state.beatSync).toMatchObject({ beatsPerClip: 8, startBeat: 0, bpm: null, scale: 1, nudgeSec: 0 });

    await app.fetch(req("PUT", "/api/films/B/soundtrack", { filename: null }));
    expect((await app.fetch(req("GET", "/api/films/B/soundtrack/beats"))).status).toBe(400);
  });
});
