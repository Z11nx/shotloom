/**
 * Test helpers. All media is generated on the fly with FFmpeg's built-in test
 * sources, so the suite ships no third-party media.
 */
import { lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp, type AppOverrides } from "../server/app";
import { loadConfig } from "../server/config";
import { FilmStore } from "../server/films/store";
import { runFfmpeg, type MediaTools } from "../server/media/ffmpeg";
import { defaultSettings, MOCK_I2V } from "../shared/models";

export const tools: MediaTools = { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" };

export async function tempRoot(prefix = "shotloom-test-"): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export function newStore(root: string, scanIntervalMs = 0): FilmStore {
  return new FilmStore({ root, defaultSettings: () => defaultSettings(MOCK_I2V), scanIntervalMs });
}

export async function makeImage(file: string, color = "0x336699", size = "640x360"): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await runFfmpeg(tools, ["-f", "lavfi", "-i", `color=c=${color}:s=${size}`, "-frames:v", "1", file]);
}

export async function makeVideo(
  file: string,
  opts: { color: string; seconds: number; audio: boolean; size?: string },
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const args = ["-f", "lavfi", "-i", `color=c=${opts.color}:s=${opts.size ?? "1280x704"}:r=24:d=${opts.seconds}`];
  if (opts.audio) args.push("-f", "lavfi", "-i", `sine=f=440:d=${opts.seconds}`);
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (opts.audio) args.push("-c:a", "aac", "-shortest");
  args.push(file);
  await runFfmpeg(tools, args);
}

export async function makeAudio(file: string, seconds: number): Promise<void> {
  await runFfmpeg(tools, ["-f", "lavfi", "-i", `sine=f=220:d=${seconds}`, file]);
}

/** Average RGB of the frame at time t (seconds). */
export async function frameColor(file: string, t: number): Promise<[number, number, number]> {
  const proc = Bun.spawn(
    ["ffmpeg", "-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  return [buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0];
}

/** Peak volume in dB of the audio over the whole file (−91 ≈ digital silence). */
export async function maxVolume(file: string, startSec = 0, durSec?: number): Promise<number> {
  const args = ["ffmpeg", "-v", "info", "-ss", String(startSec)];
  if (durSec !== undefined) args.push("-t", String(durSec));
  args.push("-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-");
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(err);
  if (!m || m[1] === "-inf") return -Infinity;
  return Number(m[1]);
}

export function testApp(root: string, overrides: AppOverrides = {}, env: Record<string, string> = {}) {
  const config = loadConfig({ FILMS_ROOT: root, GENERATION_PROVIDER: "mock", PORT: "8787", ...env });
  return createApp(config, { openFolder: async () => undefined, log: () => undefined, ...overrides });
}

/** Builds a Request as the browser would send it to the local server. */
export function req(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:8787${pathname}`, {
    method,
    headers: { Host: "127.0.0.1:8787", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function until(cond: () => Promise<boolean> | boolean, timeoutMs = 20_000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("Condition not met in time");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * Whether this process may create FILE symlinks. On Windows that needs
 * Developer Mode or administrator rights; directory junctions do not.
 * Only EPERM/EACCES count as "not permitted"; any other error is a real failure.
 */
export function fileSymlinkSupport(): { ok: boolean; reason: string } {
  const dir = path.join(os.tmpdir(), `shotloom-symlink-probe-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "target.txt"), "x");
    symlinkSync(path.join(dir, "target.txt"), path.join(dir, "link.txt"), "file");
    return { ok: lstatSync(path.join(dir, "link.txt")).isSymbolicLink(), reason: "" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "EPERM" || code === "EACCES") {
      return {
        ok: false,
        reason: `creating file symlinks is not permitted here (${code}); enable Windows Developer Mode or run as administrator to include this test`,
      };
    }
    throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const DIR_LINK: "junction" | "dir" = process.platform === "win32" ? "junction" : "dir";
