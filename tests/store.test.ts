import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { stateFile } from "../server/films/layout";
import type { FilmStore } from "../server/films/store";
import { makeImage, newStore, tempRoot } from "./helpers";

let root: string;
let cleanup: () => Promise<void>;
let store: FilmStore;

beforeEach(async () => {
  ({ root, cleanup } = await tempRoot());
  store = newStore(root);
  await store.createFilm("Alpha");
});
afterEach(() => cleanup());

describe("films and discovery", () => {
  test("new film gets a versioned state with an editable default block", async () => {
    const raw = JSON.parse(await readFile(stateFile(root, "Alpha"), "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.promptBlocks).toHaveLength(1);
    expect(raw.aspectRatio).toBe("16:9");
  });

  test("duplicate names are refused case-insensitively", async () => {
    await expect(store.createFilm("alpha")).rejects.toThrow(/already exists/);
  });

  test("images added later are discovered without restarting", async () => {
    expect(Object.keys((await store.read("Alpha")).state.shots)).toHaveLength(0);
    await makeImage(path.join(root, "Alpha", "b.png"));
    await makeImage(path.join(root, "Alpha", "a.jpg"));
    await writeFile(path.join(root, "Alpha", "notes.txt"), "ignored");
    await writeFile(path.join(root, "Alpha", ".hidden.png"), "ignored");
    const { state, media } = await store.read("Alpha");
    expect(Object.keys(state.shots).sort()).toEqual(["a.jpg", "b.png"]);
    expect(media.images).toEqual(["a.jpg", "b.png"]);
  });

  test("a vanished image keeps its history and reconnects when it returns", async () => {
    const img = path.join(root, "Alpha", "a.png");
    await makeImage(img);
    await store.mutate("Alpha", (s) => {
      s.shots["a.png"]!.text = "keep me";
    });
    await rename(img, path.join(root, "a.png.moved"));
    let { state } = await store.read("Alpha");
    expect(state.shots["a.png"]!.missingSince).not.toBeNull();
    expect(state.shots["a.png"]!.text).toBe("keep me");
    await rename(path.join(root, "a.png.moved"), img);
    ({ state } = await store.read("Alpha"));
    expect(state.shots["a.png"]!.missingSince).toBeNull();
    expect(state.shots["a.png"]!.text).toBe("keep me");
  });
});

describe("persistence", () => {
  test("concurrent mutations are serialized without lost updates", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.mutate("Alpha", (s) => {
          s.promptBlocks.push({ id: `b${i}`, text: String(i), enabled: true, createdAt: "x", updatedAt: "x" });
        }),
      ),
    );
    store.forget();
    const { state } = await store.read("Alpha");
    expect(state.promptBlocks).toHaveLength(26);
  });

  test("a mutation that throws changes nothing", async () => {
    await expect(
      store.mutate("Alpha", (s) => {
        s.aspectRatio = "1:1";
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect((await store.read("Alpha")).state.aspectRatio).toBe("16:9");
  });

  test("writes are atomic: no temp files are left and a backup is kept", async () => {
    await store.mutate("Alpha", (s) => {
      s.aspectRatio = "9:16";
    });
    const files = await readdir(path.join(root, "Alpha", ".shotloom"));
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(files).toContain("state.prev.json");
  });

  test("corrupt state is preserved and reported, never reset", async () => {
    const file = stateFile(root, "Alpha");
    await writeFile(file, "{ not json");
    store.forget();
    await expect(store.read("Alpha")).rejects.toThrow(/not valid JSON.*left untouched/s);
    await expect(store.mutate("Alpha", () => undefined)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("{ not json");
  });

  test("schema-invalid and future-version state are refused", async () => {
    const file = stateFile(root, "Alpha");
    await writeFile(file, JSON.stringify({ version: 1, promptBlocks: "oops" }));
    store.forget();
    await expect(store.read("Alpha")).rejects.toThrow(/expected format/);
    await writeFile(file, JSON.stringify({ version: 99 }));
    store.forget();
    await expect(store.read("Alpha")).rejects.toThrow(/newer version/);
  });

  test("start fresh keeps the unreadable file under a new name", async () => {
    await writeFile(stateFile(root, "Alpha"), "garbage");
    store.forget();
    const kept = await store.startFresh("Alpha");
    expect(kept).toMatch(/state\.unreadable-.*\.json$/);
    expect(await readFile(kept!, "utf8")).toBe("garbage");
    expect((await store.read("Alpha")).state.version).toBe(1);
  });

  test("unknown films are reported as not found", async () => {
    await expect(store.read("Nope")).rejects.toThrow(/not found/);
  });
});
