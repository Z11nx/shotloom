/**
 * Launcher tests.
 *
 * start-windows.cmd cannot run outside Windows, so it only gets static checks
 * here (line endings, redirection targets, quoting, no hard-coded port). Those
 * checks do NOT prove the batch file works on Windows.
 *
 * The real work (reading .env, checking the configured ffmpeg/ffprobe, building,
 * starting the server and opening the configured port) lives in
 * scripts/launch.ts, which is exercised for real below.
 */
import { describe, expect, test } from "bun:test";
import { copyFile, link, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../server/config";
import { tempRoot } from "./helpers";

const APP = path.resolve(import.meta.dir, "..");
const CMD = path.join(APP, "start-windows.cmd");

describe("start-windows.cmd (static checks only; not a Windows run)", () => {
  test("uses CRLF line endings throughout", async () => {
    const raw = await readFile(CMD, "latin1");
    expect(raw.replace(/\r\n/g, "")).not.toContain("\n");
    expect(raw.endsWith("\r\n")).toBe(true);
  });

  test("never redirects to /dev/null; every redirection targets nul or &1", async () => {
    const raw = await readFile(CMD, "latin1");
    expect(raw).not.toContain("/dev/null");
    const lines = raw.split("\r\n").filter((l) => !/^\s*rem\b/i.test(l) && !/^\s*::/.test(l));
    const targets = lines.flatMap((l) => [...l.matchAll(/\d?>>?\s*([^\s&|)]+)/g)].map((m) => m[1]));
    for (const t of targets) expect(["nul", "&1"]).toContain(t!.toLowerCase());
  });

  test("changes to its own folder with quoting that survives spaces", async () => {
    const raw = await readFile(CMD, "latin1");
    expect(raw).toContain('cd /d "%~dp0"');
  });

  test("does not hard-code the port or ffmpeg path; delegates to the launcher script", async () => {
    const raw = await readFile(CMD, "latin1");
    expect(raw).not.toContain("8787");
    expect(raw).not.toMatch(/where\s+ffmpeg/i);
    expect(raw).toContain("scripts/launch.ts");
  });
});

describe("scripts/launch.ts", () => {
  test("opens the configured port, not a fixed one", async () => {
    const { appUrl } = await import("../scripts/launch");
    expect(appUrl(loadConfig({ PORT: "9123" }))).toBe("http://localhost:9123/");
    expect(appUrl(loadConfig({}))).toBe("http://localhost:8787/");
  });

  test("checks the explicitly configured ffmpeg/ffprobe paths, including paths with spaces", async () => {
    const { preflight } = await import("../scripts/launch");
    const { root, cleanup } = await tempRoot("shotloom-launch-");
    try {
      const spaced = path.join(root, "Program Files", "FF mpeg");
      await mkdir(spaced, { recursive: true });
      const exe = process.platform === "win32" ? ".exe" : "";
      const ffmpeg = path.join(spaced, `my ffmpeg${exe}`);
      const ffprobe = path.join(spaced, `my ffprobe${exe}`);
      // Hard link (no special privilege on Windows), falling back to a copy.
      for (const [src, dest] of [[Bun.which("ffmpeg")!, ffmpeg], [Bun.which("ffprobe")!, ffprobe]] as const) {
        await link(src, dest).catch(() => copyFile(src, dest));
      }
      const ok = await preflight(loadConfig({ FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe }));
      expect(ok.ffmpeg.ok).toBe(true);
      expect(ok.ffprobe.ok).toBe(true);
      expect(ok.ffmpeg.path).toBe(ffmpeg);

      const missing = path.join(root, "No Such Dir", "ffmpeg.exe");
      const bad = await preflight(loadConfig({ FFMPEG_PATH: missing, FFPROBE_PATH: ffprobe }));
      expect(bad.ffmpeg.ok).toBe(false);
      expect(bad.ffmpeg.message).toContain(missing);
      expect(bad.ffmpeg.message).toMatch(/FFMPEG_PATH/);
      expect(bad.ffprobe.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("starts the server on the configured port and reports its URL", async () => {
    const { root, cleanup } = await tempRoot("shotloom-launch-run-");
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const proc = Bun.spawn([process.execPath, "run", "scripts/launch.ts", "--no-open", "--skip-build", "--no-env-update"], {
      cwd: APP,
      env: { ...process.env, PORT: String(port), FILMS_ROOT: path.join(root, "films"), GENERATION_PROVIDER: "mock", FAL_KEY: "", FFMPEG_PATH: path.join(root, "missing ffmpeg") },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let out = "";
      let err = "";
      void (async () => {
        const dec2 = new TextDecoder();
        const r = proc.stderr.getReader();
        for (;;) {
          const { value, done } = await r.read();
          if (done) break;
          err += dec2.decode(value);
        }
      })();
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
      const deadline = Date.now() + 30_000;
      while (!out.includes(`http://localhost:${port}/`) && Date.now() < deadline) {
        const { value, done } = await Promise.race([reader.read(), Bun.sleep(30_000).then(() => ({ value: undefined, done: true }))]);
        if (done) break;
        out += dec.decode(value);
      }
      expect(out).toContain(`http://localhost:${port}/`);
      expect(err).toMatch(/ffmpeg.*missing ffmpeg/i); // warned about the configured path, kept going
      const status = await fetch(`http://127.0.0.1:${port}/api/status`);
      expect(status.status).toBe(200);
    } finally {
      proc.kill();
      await proc.exited;
      await cleanup();
    }
  }, 45_000);
});
