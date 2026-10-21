import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { App } from "../server/app";
import { stateFile } from "../server/films/layout";
import { makeAudio, makeImage, req, tempRoot, testApp } from "./helpers";

let root: string;
let cleanup: () => Promise<void>;
let app: App;

beforeAll(async () => {
  ({ root, cleanup } = await tempRoot());
  app = testApp(root);
  await app.store.ensureRoot();
  const res = await app.fetch(req("POST", "/api/films", { name: "Web Film" }));
  expect(res.status).toBe(201);
  await makeImage(path.join(root, "Web Film", "one.png"));
  await makeAudio(path.join(root, "Web Film", "song.mp3"), 2);
  await writeFile(path.join(root, "secret.txt"), "do not serve");
});
afterAll(() => cleanup());

const body = async (r: Response) => (await r.json()) as { error?: { code: string; message: string } } & Record<string, unknown>;

describe("errors and validation", () => {
  test("consistent error envelope for unknown routes and bad bodies", async () => {
    const r1 = await app.fetch(req("GET", "/api/nope"));
    expect(r1.status).toBe(404);
    expect((await body(r1)).error?.code).toBe("NOT_FOUND");

    const r2 = await app.fetch(req("PUT", "/api/films/Web%20Film/aspect-ratio", { aspectRatio: "4:3" }));
    expect(r2.status).toBe(400);
    expect((await body(r2)).error?.message).toMatch(/aspectRatio/);

    const r3 = await app.fetch(
      new Request("http://127.0.0.1:8787/api/films", {
        method: "POST",
        headers: { Host: "127.0.0.1:8787", "Content-Type": "application/json" },
        body: "{bad json",
      }),
    );
    expect(r3.status).toBe(400);
    expect((await body(r3)).error?.message).toMatch(/not valid JSON/);

    const r4 = await app.fetch(req("DELETE", "/api/status"));
    expect(r4.status).toBe(405);
  });

  test("status reports dependencies without exposing secrets", async () => {
    const withKey = testApp(root, {}, { FAL_KEY: "super-secret-value", GENERATION_PROVIDER: "fal" });
    const r = await withKey.fetch(req("GET", "/api/status"));
    const text = await r.text();
    expect(text).not.toContain("super-secret-value");
    const s = JSON.parse(text);
    expect(s.falKeyConfigured).toBe(true);
    expect(s.ffmpeg.ok).toBe(true);
    expect(s.provider.isMock).toBe(false);
  });

  test("missing FAL_KEY disables generation with a clear reason but editing still works", async () => {
    const noKey = testApp(root, {}, { GENERATION_PROVIDER: "fal" });
    const s = await body(await noKey.fetch(req("GET", "/api/status")));
    expect((s.provider as { ready: boolean; reason: string }).ready).toBe(false);
    const gen = await noKey.fetch(
      req("POST", "/api/films/Web%20Film/shots/one.png/generate", {
        text: "x",
        settings: { durationSec: 6, resolution: "768P", seed: null },
        count: 1,
      }),
    );
    expect(gen.status).toBe(503);
    expect((await body(gen)).error?.message).toMatch(/FAL_KEY/);
    const edit = await noKey.fetch(req("PATCH", "/api/films/Web%20Film/shots/one.png", { text: "still editable" }));
    expect(edit.status).toBe(200);
  });
});

describe("local safety", () => {
  test("rejects foreign Host headers (DNS rebinding) and cross-site origins", async () => {
    const r1 = await app.fetch(req("GET", "/api/films", undefined, { Host: "attacker.example:8787" }));
    expect(r1.status).toBe(403);
    const r2 = await app.fetch(req("POST", "/api/films", { name: "X" }, { Origin: "https://attacker.example" }));
    expect(r2.status).toBe(403);
    const r3 = await app.fetch(req("GET", "/api/films", undefined, { Host: "localhost:5173" }));
    expect(r3.status).toBe(200); // the Vite dev server
  });

  test("requires JSON for writes (blocks simple cross-site form posts)", async () => {
    const r = await app.fetch(
      new Request("http://127.0.0.1:8787/api/films", {
        method: "POST",
        headers: { Host: "127.0.0.1:8787", "Content-Type": "application/x-www-form-urlencoded" },
        body: "name=x",
      }),
    );
    expect(r.status).toBe(415);
  });

  test("traversal, encoded separators and hidden files are not served", async () => {
    for (const p of [
      "/media/Web%20Film/source/..%2F..%2Fsecret.txt",
      "/media/Web%20Film/source/..%5Csecret.txt",
      "/media/..%2F/source/secret.txt",
      "/media/Web%20Film/source/.shotloom",
      "/media/Web%20Film/source/state.json",
      "/media/Web%20Film/preview/..%2Fstate.json",
      "/media/Web%20Film/exports/x.json",
      "/api/films/CON",
    ]) {
      const r = await app.fetch(req("GET", p));
      expect([400, 404]).toContain(r.status);
      expect(await r.text()).not.toContain("do not serve");
    }
  });

  test("serves discovered media with byte ranges for seeking", async () => {
    const full = await app.fetch(req("GET", "/media/Web%20Film/source/song.mp3"));
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    const size = Number(full.headers.get("content-length"));
    const part = await app.fetch(req("GET", "/media/Web%20Film/source/song.mp3", undefined, { Range: "bytes=10-19" }));
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 10-19/${size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(10);
    const suffix = await app.fetch(req("GET", "/media/Web%20Film/source/song.mp3", undefined, { Range: "bytes=-5" }));
    expect((await suffix.arrayBuffer()).byteLength).toBe(5);
    const bad = await app.fetch(req("GET", "/media/Web%20Film/source/song.mp3", undefined, { Range: `bytes=${size + 5}-` }));
    expect(bad.status).toBe(416);
  });
});

describe("film workflow over HTTP", () => {
  test("prompt blocks: add, edit, toggle, reorder, import as independent copies", async () => {
    const f = "/api/films/Web%20Film";
    let v = await body(await app.fetch(req("POST", `${f}/prompt-blocks`, { text: "Second" })));
    const blocks = () => (v.state as { promptBlocks: { id: string; text: string; enabled: boolean }[] }).promptBlocks;
    const [first, second] = blocks();
    v = await body(await app.fetch(req("PATCH", `${f}/prompt-blocks/${first!.id}`, { enabled: false })));
    v = await body(await app.fetch(req("PUT", `${f}/prompt-blocks/order`, { ids: [second!.id, first!.id] })));
    expect(blocks().map((b) => b.text)).toEqual(["Second", first!.text]);
    const stale = await app.fetch(req("PUT", `${f}/prompt-blocks/order`, { ids: [second!.id] }));
    expect(stale.status).toBe(409);

    await app.fetch(req("POST", "/api/films", { name: "Other" }));
    let other = await body(await app.fetch(req("POST", "/api/films/Other/prompt-blocks/import", { sourceFilm: "Web Film" })));
    const otherBlocks = (other.state as { promptBlocks: { id: string; text: string; enabled: boolean }[] }).promptBlocks;
    const imported = otherBlocks.slice(-2);
    expect(imported.map((b) => [b.text, b.enabled])).toEqual([
      ["Second", true],
      [first!.text, false],
    ]);
    expect(imported.map((b) => b.id)).not.toContain(second!.id);
    // Editing the copy leaves the original alone.
    await app.fetch(req("PATCH", `/api/films/Other/prompt-blocks/${imported[0]!.id}`, { text: "Edited copy" }));
    v = await body(await app.fetch(req("GET", f)));
    expect(blocks().map((b) => b.text)).toContain("Second");
    other = await body(await app.fetch(req("GET", "/api/films/Other")));
    expect(JSON.stringify(other.state)).toContain("Edited copy");
  });

  test("generate captures the text sent with the request", async () => {
    const res = await app.fetch(
      req("POST", "/api/films/Web%20Film/shots/one.png/generate", {
        text: "typed just now",
        settings: { durationSec: 6, resolution: "768P", seed: 7 },
        count: 1,
      }),
    );
    expect(res.status).toBe(202);
    const data = (await res.json()) as { generationIds: string[]; view: { state: { shots: Record<string, { text: string; generations: { submittedPrompt: string }[] }> } } };
    const shot = data.view.state.shots["one.png"]!;
    expect(shot.text).toBe("typed just now");
    expect(shot.generations[0]!.submittedPrompt.endsWith("typed just now")).toBe(true);
  });

  test("a generate whose expected prompt differs from the server's is refused and creates nothing", async () => {
    const f = "/api/films/Web%20Film";
    const before = (await body(await app.fetch(req("GET", f)))) as unknown as { state: { shots: Record<string, { text: string; generations: unknown[] }> } };
    const r = await app.fetch(
      req("POST", `${f}/shots/one.png/generate`, {
        text: "new text",
        settings: { durationSec: 6, resolution: "768P", seed: null },
        count: 4,
        expectedPrompt: "a block the server never saved\n\nnew text",
      }),
    );
    expect(r.status).toBe(409);
    expect((await body(r)).error?.code).toBe("PROMPT_CHANGED");
    const after = (await body(await app.fetch(req("GET", f)))) as unknown as typeof before;
    expect(after.state.shots["one.png"]!.generations.length).toBe(before.state.shots["one.png"]!.generations.length);
    expect(after.state.shots["one.png"]!.text).toBe(before.state.shots["one.png"]!.text);
  });

  test("soundtrack must be an audio file in the film folder", async () => {
    const ok = await app.fetch(req("PUT", "/api/films/Web%20Film/soundtrack", { filename: "song.mp3", offsetSec: 0.5 }));
    expect(ok.status).toBe(200);
    const bad = await app.fetch(req("PUT", "/api/films/Web%20Film/soundtrack", { filename: "one.png", offsetSec: 0 }));
    expect(bad.status).toBe(400);
    const neg = await app.fetch(req("PUT", "/api/films/Web%20Film/soundtrack", { filename: "song.mp3", offsetSec: -1 }));
    expect(neg.status).toBe(400);
  });

  test("malformed state is reported with an actionable 409, and start-fresh recovers", async () => {
    await app.fetch(req("POST", "/api/films", { name: "Broken" }));
    await writeFile(stateFile(root, "Broken"), "{oops");
    app.store.forget("Broken");
    const r = await app.fetch(req("GET", "/api/films/Broken"));
    expect(r.status).toBe(409);
    const e = await body(r);
    expect(e.error?.code).toBe("STATE_UNREADABLE");
    expect(e.error?.message).toMatch(/left untouched/);
    const fresh = await app.fetch(req("POST", "/api/films/Broken/state/start-fresh", {}));
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as { keptAs: string }).keptAs).toMatch(/^state\.unreadable-/);
  });
});
