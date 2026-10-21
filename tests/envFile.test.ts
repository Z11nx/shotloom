import { describe, expect, test } from "bun:test";
import { lstat, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../server/config";
import { ensureEnvSettings, exampleSettings, mentionedKeys } from "../scripts/envFile";
import { fileSymlinkSupport, tempRoot } from "./helpers";

const REAL_EXAMPLE = path.resolve(import.meta.dir, "..", ".env.example");
const LINKS = fileSymlinkSupport();

/** Minimal KEY=VALUE reader for assertions (comments and blanks ignored). */
function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

async function withFiles(env: string | null, run: (envPath: string, examplePath: string, dir: string) => Promise<void>) {
  const { root, cleanup } = await tempRoot("shotloom-env-");
  try {
    const envPath = path.join(root, ".env");
    const examplePath = path.join(root, ".env.example");
    await writeFile(examplePath, await readFile(REAL_EXAMPLE, "utf8"));
    if (env !== null) await writeFile(envPath, env);
    await run(envPath, examplePath, root);
  } finally {
    await cleanup();
  }
}

describe(".env upkeep (launcher)", () => {
  test("every value in .env.example equals the built-in default, so adding one never changes behavior", async () => {
    const example = parse(await readFile(REAL_EXAMPLE, "utf8"));
    expect(Object.keys(example)).toContain("FAL_BILLING_KEY");
    expect(loadConfig(example)).toEqual(loadConfig({}));
  });

  test("finds each example setting with its comment block", async () => {
    const s = exampleSettings(await readFile(REAL_EXAMPLE, "utf8"));
    const billing = s.find((x) => x.key === "FAL_BILLING_KEY")!;
    expect(billing.lines.at(-1)).toBe("FAL_BILLING_KEY=");
    expect(billing.lines[0]).toMatch(/^# Optional: a read-only fal key/);
    expect(s.map((x) => x.key)).not.toContain("FFMPEG_PATH"); // commented-out examples are not added
  });

  test("an existing .env (like yours) gains only FAL_BILLING_KEY; every existing byte is kept", async () => {
    const mine = "FAL_KEY=fal-secret-123\r\nGENERATION_PROVIDER=fal\r\nFILMS_ROOT=./films\r\nPORT=8787\r\n# FFMPEG_PATH=C:\\ffmpeg\\bin\\ffmpeg.exe\r\n";
    await withFiles(mine, async (envPath, examplePath) => {
      expect(await ensureEnvSettings(envPath, examplePath)).toEqual({ action: "added", keys: ["FAL_BILLING_KEY"] });
      const after = await readFile(envPath, "utf8");
      expect(after.startsWith(mine)).toBe(true);
      expect(after.replace(/\r\n/g, "")).not.toContain("\n"); // CRLF kept throughout
      expect(after).toMatch(/\r\nFAL_BILLING_KEY=\r\n$/);
      expect(after).toContain("# Added by Shotloom on ");
      const before = loadConfig(parse(mine));
      const now = loadConfig(parse(after));
      expect(now).toEqual(before);
      expect(now.falKey).toBe("fal-secret-123");
      expect(now.falBillingKey).toBeNull();
      // Running again changes nothing.
      expect(await ensureEnvSettings(envPath, examplePath)).toEqual({ action: "none" });
      expect(await readFile(envPath, "utf8")).toBe(after);
    });
  });

  test("a setting the user commented out is left alone; a missing final newline is handled", async () => {
    await withFiles("FAL_KEY=k\n# FAL_BILLING_KEY=\nGENERATION_PROVIDER=fal\nFILMS_ROOT=./films\nPORT=9000", async (envPath, examplePath) => {
      expect(await ensureEnvSettings(envPath, examplePath)).toEqual({ action: "none" });
    });
    await withFiles("FAL_KEY=k", async (envPath, examplePath) => {
      const r = await ensureEnvSettings(envPath, examplePath);
      expect(r).toEqual({ action: "added", keys: ["FAL_BILLING_KEY", "GENERATION_PROVIDER", "FILMS_ROOT", "PORT"] });
      const after = await readFile(envPath, "utf8");
      expect(after.startsWith("FAL_KEY=k\n\n# Added by Shotloom")).toBe(true);
      expect(mentionedKeys(after)).toEqual(new Set(["FAL_KEY", "FAL_BILLING_KEY", "GENERATION_PROVIDER", "FILMS_ROOT", "PORT"]));
      expect(parse(after).GENERATION_PROVIDER).toBe("mock");
    });
  });

  test("no .env: it is created as a copy of .env.example (mock mode)", async () => {
    await withFiles(null, async (envPath, examplePath) => {
      expect(await ensureEnvSettings(envPath, examplePath)).toEqual({ action: "created" });
      expect(await readFile(envPath, "utf8")).toBe(await readFile(examplePath, "utf8"));
      expect(loadConfig(parse(await readFile(envPath, "utf8"))).providerMode).toBe("mock");
    });
  });

  test("no temp files are left behind", async () => {
    await withFiles("FAL_KEY=k\n", async (envPath, examplePath, dir) => {
      await ensureEnvSettings(envPath, examplePath);
      const { readdir } = await import("node:fs/promises");
      expect((await readdir(dir)).sort()).toEqual([".env", ".env.example"]);
    });
  });

  test.skipIf(!LINKS.ok)("a linked .env stays a link; the file it points to is updated", async () => {
    await withFiles(null, async (envPath, examplePath, dir) => {
      const real = path.join(dir, "real.env");
      await writeFile(real, "FAL_KEY=k\n");
      await symlink(real, envPath, "file");
      await ensureEnvSettings(envPath, examplePath);
      expect((await lstat(envPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(real, "utf8")).toContain("FAL_BILLING_KEY=");
    });
  });
});
