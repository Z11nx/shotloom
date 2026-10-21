/**
 * Films-root containment, exercised through the real HTTP API.
 *
 * Each test builds a disposable layout:
 *   <base>/films      the configured FILMS_ROOT
 *   <base>/outside    a sibling directory that must never be read, written or deleted
 * and links part of a film to <base>/outside. On Windows directory links are
 * junctions (no privilege needed); elsewhere they are directory symlinks.
 *
 * File symlinks need Developer Mode or admin rights on Windows. That test is
 * skipped, with a printed reason, only when the probe below proves the
 * privilege is missing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { App } from "../server/app";
import { createMockProvider } from "../server/generation/providers/mock";
import type { Generation } from "../shared/domain";
import { DIR_LINK, fileSymlinkSupport, makeImage, makeVideo, req, tempRoot, testApp, tools, until } from "./helpers";

const FILE_SYMLINKS = fileSymlinkSupport();
if (!FILE_SYMLINKS.ok) console.warn(`[containment] SKIPPING file-symlink test: ${FILE_SYMLINKS.reason}`);

let base: string;
let cleanup: () => Promise<void>;
let root: string;
let outside: string;
let app: App;
let opened: string[];

/** Recursive listing of a directory (links are listed, never followed). */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    for (const name of (await readdir(d)).sort()) {
      const p = path.join(d, name);
      const s = await lstat(p);
      out.push(`${path.relative(dir, p)}|${s.isDirectory() ? "dir" : s.size}|${s.mtimeMs}`);
      if (s.isDirectory()) await walk(p);
    }
  }
  await walk(dir);
  return out;
}

function fastApp(rootDir: string): App {
  opened = [];
  return testApp(rootDir, {
    providers: [createMockProvider({ tools, queueMs: 0, processMs: 0 })],
    openFolder: async (p) => {
      opened.push(p);
    },
  });
}

beforeEach(async () => {
  ({ root: base, cleanup } = await tempRoot("shotloom-contain-"));
  root = path.join(base, "films");
  outside = path.join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await makeImage(path.join(outside, "secret.png"), "0xff0000");
  await writeFile(path.join(outside, "keep.txt"), "must survive");
  app = fastApp(root);
  await app.store.ensureRoot();
});
afterEach(async () => {
  app.generation.stop();
  await cleanup();
});

const enc = encodeURIComponent;
async function call(method: string, p: string, body?: unknown) {
  const res = await app.fetch(req(method, p, body));
  return { status: res.status, text: await res.text() };
}

function completedGeneration(id: string, shot: string): Generation {
  const now = new Date().toISOString();
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
    output: { filename: `${id}.mp4`, sizeBytes: 1, durationSec: 2, width: 640, height: 360, hasAudio: true },
    trim: null,
    createdAt: now,
    submittedAt: now,
    completedAt: now,
    updatedAt: now,
  };
}

/** A real film with one shot and one completed clip on the timeline. */
async function filmWithClip(name: string): Promise<{ clip: string }> {
  expect((await call("POST", "/api/films", { name })).status).toBe(201);
  await makeImage(path.join(root, name, "shot.png"));
  const gdir = path.join(root, name, ".shotloom", "generations");
  await makeVideo(path.join(gdir, "g1.mp4"), { color: "blue", seconds: 2, audio: true, size: "640x360" });
  await app.store.mutate(name, (s) => {
    s.shots["shot.png"]!.generations.push(completedGeneration("g1", "shot.png"));
    s.timeline = [{ id: "c1", generationId: "g1", muted: false }];
  });
  return { clip: path.join(gdir, "g1.mp4") };
}

/** Replaces <root>/<film>/<rel> with a directory link to <outside>/<target>. */
async function linkOut(film: string, rel: string, target: string, seed?: (dir: string) => Promise<void>) {
  const dest = path.join(outside, target);
  await rm(path.join(root, film, rel), { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  if (seed) await seed(dest);
  await symlink(dest, path.join(root, film, rel), DIR_LINK);
  app.store.forget(film);
}

function expectRefused(r: { status: number; text: string }) {
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.status).toBeLessThan(500);
}

describe("films-root containment through the API", () => {
  test("a film folder that is a link to outside the root is refused, and nothing outside is touched", async () => {
    await symlink(outside, path.join(root, "LinkedFilm"), DIR_LINK);
    const before = await snapshot(outside);

    const list = JSON.parse((await call("GET", "/api/films")).text) as { films: { name: string }[] };
    expect(list.films.map((f) => f.name)).not.toContain("LinkedFilm");

    expectRefused(await call("GET", "/api/films/LinkedFilm"));
    const media = await call("GET", "/media/LinkedFilm/source/secret.png");
    expect(media.status).not.toBe(200);
    expectRefused(await call("PATCH", "/api/films/LinkedFilm/shots/secret.png", { text: "x" }));
    expectRefused(await call("POST", "/api/films/LinkedFilm/prompt-blocks", { text: "x" }));
    expectRefused(await call("PUT", "/api/films/LinkedFilm/aspect-ratio", { aspectRatio: "1:1" }));
    expectRefused(await call("POST", "/api/films/LinkedFilm/render", { kind: "export" }));
    expectRefused(await call("POST", "/api/films/LinkedFilm/state/start-fresh", {}));
    expectRefused(await call("POST", "/api/films/LinkedFilm/open-folder", { target: "exports" }));
    expectRefused(
      await call("POST", "/api/films/LinkedFilm/shots/secret.png/generate", {
        text: "x",
        settings: { durationSec: 5, resolution: "480P", seed: null },
        count: 1,
      }),
    );
    expectRefused(await call("POST", "/api/films/Other/prompt-blocks/import", { sourceFilm: "LinkedFilm" }));

    expect(opened).toEqual([]);
    expect(await snapshot(outside)).toEqual(before);
  });

  test("a linked .shotloom folder is refused for state reads and writes", async () => {
    await call("POST", "/api/films", { name: "Real" });
    await makeImage(path.join(root, "Real", "shot.png"));
    const decoyState = await readFile(path.join(root, "Real", ".shotloom", "state.json"), "utf8");
    await linkOut("Real", ".shotloom", "meta", async (d) => {
      await writeFile(path.join(d, "state.json"), decoyState);
    });
    const before = await snapshot(outside);

    expectRefused(await call("GET", "/api/films/Real"));
    expectRefused(await call("PATCH", `/api/films/Real/shots/shot.png`, { text: "leak" }));
    expectRefused(await call("PUT", "/api/films/Real/aspect-ratio", { aspectRatio: "9:16" }));
    expectRefused(await call("POST", "/api/films/Real/state/start-fresh", {}));

    expect(await snapshot(outside)).toEqual(before);
    expect(await readFile(path.join(outside, "meta", "state.json"), "utf8")).toBe(decoyState);
  });

  test("a linked exports folder: export and open-folder are refused, nothing is created outside", async () => {
    await filmWithClip("Exp");
    opened = []; // creating the film opened its own (real) folder
    await linkOut("Exp", "exports", "exports");
    const before = await snapshot(outside);
    expectRefused(await call("POST", "/api/films/Exp/render", { kind: "export" }));
    await app.renders.idle();
    expectRefused(await call("POST", "/api/films/Exp/open-folder", { target: "exports" }));
    expectRefused(await call("GET", "/media/Exp/exports/x.mp4"));
    expect(opened).toEqual([]);
    expect(await snapshot(outside)).toEqual(before);
  });

  test("linked preview and render-scratch folders: renders are refused and outside files are not deleted", async () => {
    await filmWithClip("Prev");
    await linkOut("Prev", path.join(".shotloom", "tmp"), "scratch", async (d) => {
      await writeFile(path.join(d, "important.txt"), "do not delete");
    });
    await linkOut("Prev", path.join(".shotloom", "preview"), "preview", async (d) => {
      await writeFile(path.join(d, "old.mp4"), "not a preview");
    });
    const before = await snapshot(outside);
    expectRefused(await call("POST", "/api/films/Prev/render", { kind: "preview" }));
    expectRefused(await call("POST", "/api/films/Prev/render", { kind: "export" }));
    await app.renders.idle();
    expect(await snapshot(outside)).toEqual(before);
  });

  test("a linked generations folder: clips are not served, not deleted, and new jobs write nothing outside", async () => {
    await filmWithClip("Gen");
    await linkOut("Gen", path.join(".shotloom", "generations"), "gens", async (d) => {
      await makeVideo(path.join(d, "g1.mp4"), { color: "red", seconds: 1, audio: false, size: "320x180" });
      await writeFile(path.join(d, "g1.json"), "{}");
    });
    const before = await snapshot(outside);

    expect((await call("GET", "/media/Gen/gen/g1")).status).not.toBe(200);
    expectRefused(await call("DELETE", "/api/films/Gen/generations/g1"));

    // A new job: the worker must refuse to write its clip into the linked folder.
    const r = await call("POST", "/api/films/Gen/shots/shot.png/generate", {
      text: "go",
      settings: { durationSec: 5, resolution: "480P", seed: null },
      count: 1,
    });
    if (r.status === 202) {
      const id = (JSON.parse(r.text) as { generationIds: string[] }).generationIds[0]!;
      await until(async () => {
        await app.generation.tick();
        await app.generation.idle();
        const g = app.store && (await app.store.read("Gen").catch(() => null));
        const job = g?.state.shots["shot.png"]!.generations.find((x) => x.id === id);
        return !job || job.status === "failed" || job.status === "completed";
      }, 60_000);
      const { state } = await app.store.read("Gen");
      const job = state.shots["shot.png"]!.generations.find((x) => x.id === id)!;
      expect(job.status).toBe("failed");
    } else {
      expectRefused(r);
    }
    expect(await snapshot(outside)).toEqual(before);
  }, 90_000);

  test.skipIf(!FILE_SYMLINKS.ok)("a source file symlinked to outside the root is not served", async () => {
    await call("POST", "/api/films", { name: "Sym" });
    await symlink(path.join(outside, "secret.png"), path.join(root, "Sym", "linked.png"), "file");
    const r = await call("GET", "/media/Sym/source/linked.png");
    expect(r.status).not.toBe(200);
    const view = JSON.parse((await call("GET", "/api/films/Sym")).text) as { state: { shots: Record<string, unknown> } };
    expect(Object.keys(view.state.shots)).not.toContain("linked.png");
  });

  test("a films root that is itself a link is supported and contained in its target", async () => {
    const realRoot = path.join(base, "real-root");
    const linkRoot = path.join(base, "root-link");
    await mkdir(realRoot);
    await symlink(realRoot, linkRoot, DIR_LINK);
    app = fastApp(linkRoot);
    await app.store.ensureRoot();
    expect((await call("POST", "/api/films", { name: "Through Link" })).status).toBe(201);
    await makeImage(path.join(linkRoot, "Through Link", "a.png"));
    expect((await call("GET", `/api/films/${enc("Through Link")}`)).status).toBe(200);
    expect((await call("GET", `/media/${enc("Through Link")}/source/a.png`)).status).toBe(200);
    expect((await call("PATCH", `/api/films/${enc("Through Link")}/shots/a.png`, { text: "ok" })).status).toBe(200);
    const state = JSON.parse(await readFile(path.join(realRoot, "Through Link", ".shotloom", "state.json"), "utf8"));
    expect(state.shots["a.png"].text).toBe("ok");
    expect(await readdir(outside)).toEqual(["keep.txt", "secret.png"]);
  });

  test("an ordinary film still works end to end (control)", async () => {
    const { clip } = await filmWithClip("Plain");
    expect((await call("GET", "/media/Plain/gen/g1")).status).toBe(200);
    expect((await call("POST", "/api/films/Plain/render", { kind: "export" })).status).toBe(202);
    await app.renders.idle();
    expect(app.renders.status("Plain")?.state).toBe("done");
    opened = [];
    expect((await call("POST", "/api/films/Plain/open-folder", { target: "exports" })).status).toBe(200);
    expect(opened).toEqual([path.join(root, "Plain", "exports")]);
    await copyFile(clip, path.join(base, "clip-copy.mp4"));
    expect((await call("DELETE", "/api/films/Plain/generations/g1")).status).toBe(200);
  }, 60_000);
});
