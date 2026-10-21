/**
 * `bun run launch` (used by start-windows.cmd): checks dependencies using the
 * real configuration, builds the interface, starts the server, waits until it
 * answers, then opens the configured URL in the default browser.
 *
 * Reads .env the same way the server does (Bun loads it from this folder), so
 * PORT, FFMPEG_PATH and FFPROBE_PATH are honored.
 *
 * Before that it adds any new settings from .env.example to .env (creating
 * .env if it is missing); see scripts/envFile.ts. Existing lines are untouched.
 *
 * Flags: --no-open (do not open a browser), --skip-build (serve existing dist/),
 * --no-env-update (leave .env alone; used by tests).
 */
import path from "node:path";
import { APP_NAME, loadConfig, type AppConfig } from "../server/config";
import { toolVersion } from "../server/media/ffmpeg";
import { ensureEnvSettings } from "./envFile";

export interface ToolCheck {
  ok: boolean;
  path: string;
  message: string;
}

export function appUrl(config: AppConfig): string {
  return `http://localhost:${config.port}/`;
}

async function checkTool(name: "ffmpeg" | "ffprobe", bin: string): Promise<ToolCheck> {
  const envName = name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  const configured = bin !== name;
  try {
    const version = await toolVersion(bin);
    return { ok: true, path: bin, message: version };
  } catch {
    const where = configured ? `the configured ${envName} ("${bin}")` : `"${name}" on PATH`;
    const fix = configured
      ? `Check ${envName} in .env points at ${name}.exe.`
      : `Install FFmpeg (winget install Gyan.FFmpeg) and open a new window, or set ${envName} in .env.`;
    return { ok: false, path: bin, message: `${name} could not be run from ${where}. ${fix}` };
  }
}

export async function preflight(config: AppConfig): Promise<{ ffmpeg: ToolCheck; ffprobe: ToolCheck }> {
  const [ffmpeg, ffprobe] = await Promise.all([checkTool("ffmpeg", config.ffmpegPath), checkTool("ffprobe", config.ffprobePath)]);
  return { ffmpeg, ffprobe };
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "win32" ? ["explorer.exe", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    console.log(`  Open ${url} in your browser.`);
  }
}

async function waitUntilReady(port: number, child: { exitCode: number | null }, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(250);
  }
  return false;
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  const appDir = path.resolve(import.meta.dir, "..");
  if (!args.has("--no-env-update")) {
    try {
      const r = await ensureEnvSettings(path.join(appDir, ".env"), path.join(appDir, ".env.example"));
      if (r.action === "created") console.log("Created .env from .env.example (mock mode). Edit it to add your fal keys.");
      if (r.action === "added") console.log(`Added new setting${r.keys.length > 1 ? "s" : ""} to .env: ${r.keys.join(", ")} (left at the default; edit .env to use).`);
    } catch (err) {
      console.warn(`Could not update .env (${(err as Error).message}). Continuing with the current settings.`);
    }
  }
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`${APP_NAME} configuration problem: ${(err as Error).message}\nFix it in .env and try again.`);
    return 1;
  }

  const checks = await preflight(config);
  for (const c of [checks.ffmpeg, checks.ffprobe]) {
    if (!c.ok) console.warn(`Warning: ${c.message}\n         Editing works; checking clips, previews and exports need it.`);
  }

  if (!args.has("--skip-build")) {
    console.log("Building the interface…");
    const build = Bun.spawn([process.execPath, "x", "vite", "build", "--logLevel", "warn"], {
      cwd: appDir,
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await build.exited) !== 0) {
      console.error("Building the interface failed (see above).");
      return 1;
    }
  }

  const server = Bun.spawn([process.execPath, "run", "server/main.ts"], {
    cwd: appDir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const stop = () => {
    server.kill();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const url = appUrl(config);
  if (await waitUntilReady(config.port, server)) {
    console.log(`  Ready: ${url}`);
    if (!args.has("--no-open")) openInBrowser(url);
  } else if (server.exitCode === null) {
    console.warn(`The server has not answered on ${url} yet; open it manually once it reports it is running.`);
  }
  return await server.exited;
}

if (import.meta.main) {
  process.exit(await main());
}
