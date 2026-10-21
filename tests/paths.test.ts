import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeSegment, fileNameProblem, filmNameProblem, resolveInside } from "../server/films/paths";
import { DIR_LINK, fileSymlinkSupport, tempRoot } from "./helpers";

const FILE_SYMLINKS = fileSymlinkSupport();
if (!FILE_SYMLINKS.ok) console.warn(`[paths] SKIPPING file-symlink test: ${FILE_SYMLINKS.reason}`);

describe("film names", () => {
  test("accepts ordinary names", () => {
    for (const n of ["Harbor", "My film 2", "a_b-c"]) expect(filmNameProblem(n)).toBeNull();
  });
  test("rejects traversal, separators, hidden and odd names", () => {
    for (const n of ["..", "../x", "a/b", "a\\b", ".hidden", "", " lead", "trail ", "x".repeat(65), "a:b"]) {
      expect(filmNameProblem(n)).not.toBeNull();
    }
  });
  test("rejects Windows reserved device names, any case", () => {
    for (const n of ["CON", "con", "Nul", "COM1", "lpt9", "AUX"]) expect(filmNameProblem(n)).not.toBeNull();
  });
});

describe("file names", () => {
  test("accepts normal media names", () => {
    expect(fileNameProblem("01 harbor.png")).toBeNull();
    expect(fileNameProblem("Score (final).mp3")).toBeNull();
  });
  test("rejects traversal, separators, streams, reserved and hidden names", () => {
    for (const n of ["..", ".", "a/b.png", "a\\b.png", "x.png:stream", ".state.json", "con.png", "NUL.txt", "a.png.", "a.png ", "a\u0000.png"]) {
      expect(fileNameProblem(n)).not.toBeNull();
    }
  });
});

describe("decodeSegment", () => {
  test("decodes once", () => expect(decodeSegment("My%20Film")).toBe("My Film"));
  test("rejects encoded separators", () => {
    expect(() => decodeSegment("..%2Fsecret")).toThrow();
    expect(() => decodeSegment("..%5Csecret")).toThrow();
    expect(() => decodeSegment("a%00b")).toThrow();
  });
  test("does not double-decode", () => expect(decodeSegment("%252F")).toBe("%2F"));
  test("rejects malformed encoding", () => expect(() => decodeSegment("%E0%A4%A")).toThrow());
});

describe("resolveInside", () => {
  let root: string;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ root, cleanup } = await tempRoot());
    await mkdir(path.join(root, "films", "A"), { recursive: true });
    await writeFile(path.join(root, "outside.txt"), "secret");
    await writeFile(path.join(root, "films", "A", "ok.png"), "x");
  });
  afterAll(() => cleanup());

  test("allows files inside", async () => {
    const p = await resolveInside(path.join(root, "films"), "A", "ok.png");
    expect(p).toBe(path.join(root, "films", "A", "ok.png"));
  });
  test("blocks lexical escape", async () => {
    await expect(resolveInside(path.join(root, "films"), "..", "outside.txt")).rejects.toThrow();
  });
  test.skipIf(!FILE_SYMLINKS.ok)("blocks file symlink escape", async () => {
    const link = path.join(root, "films", "A", "link.png");
    await symlink(path.join(root, "outside.txt"), link, "file");
    await expect(resolveInside(path.join(root, "films"), "A", "link.png")).rejects.toThrow(/link or junction/);
  });
  test("blocks writing through a dangling link (target missing)", async () => {
    const missing = path.join(root, "not-created-yet");
    await symlink(missing, path.join(root, "films", "A", "dangling"), DIR_LINK);
    await expect(resolveInside(path.join(root, "films"), "A", "dangling", "state.json")).rejects.toThrow(/target is missing/);
  });

  test("allows paths that do not exist yet under real folders", async () => {
    const p = await resolveInside(path.join(root, "films"), "A", ".shotloom", "generations", "x.mp4");
    expect(p).toBe(path.join(root, "films", "A", ".shotloom", "generations", "x.mp4"));
  });

  test("compares by path component, not string prefix", async () => {
    await mkdir(path.join(root, "films-evil"), { recursive: true });
    await expect(resolveInside(path.join(root, "films"), "..", "films-evil", "x")).rejects.toThrow();
  });

  test("blocks directory symlink/junction escape", async () => {
    await symlink(root, path.join(root, "films", "jump"), DIR_LINK);
    await expect(resolveInside(path.join(root, "films"), "jump", "outside.txt")).rejects.toThrow();
  });
});
