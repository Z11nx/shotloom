/**
 * Browser test harness: an isolated Shotloom server in mock mode on a free
 * port with a temporary films root, plus a headless browser.
 *
 * Never contacts fal: GENERATION_PROVIDER=mock and FAL_KEY is blanked.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page, type Request } from "playwright-core";
import { runFfmpeg } from "../../server/media/ffmpeg";

export const APP_DIR = path.resolve(import.meta.dir, "..", "..");

export interface Server {
  base: string;
  root: string;
  port: number;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

export async function startServer(): Promise<Server> {
  if (!existsSync(path.join(APP_DIR, "dist", "index.html"))) {
    throw new Error("The interface is not built. Run `bun run build` first (or use `bun run test:browser`).");
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), "shotloom-e2e-"));
  const root = path.join(tmp, "films");
  await mkdir(root, { recursive: true });
  const port = await freePort();
  const proc = Bun.spawn([process.execPath, "run", "server/main.ts"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      FILMS_ROOT: root,
      PORT: String(port),
      CLIENT_PORT: String(port),
      GENERATION_PROVIDER: "mock",
      FAL_KEY: "",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${base}/api/status`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (proc.exitCode !== null) throw new Error(`Server exited: ${await new Response(proc.stderr).text()}`);
    if (Date.now() - start > 20_000) throw new Error("Server did not start in time.");
    await Bun.sleep(100);
  }
  return {
    base,
    root,
    port,
    stop: async () => {
      proc.kill();
      await proc.exited;
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * Bundled Chromium if present (PLAYWRIGHT_BROWSERS_PATH), else installed Edge,
 * else Chrome, else SHOTLOOM_BROWSER (path to a Chromium-based browser).
 */
export async function launchBrowser(): Promise<{ browser: Browser; label: string }> {
  const attempts: [string, () => Promise<Browser>][] = [];
  if (process.env.SHOTLOOM_BROWSER) {
    attempts.push([process.env.SHOTLOOM_BROWSER, () => chromium.launch({ executablePath: process.env.SHOTLOOM_BROWSER })]);
  }
  attempts.push(["bundled Chromium", () => chromium.launch()]);
  attempts.push(["Microsoft Edge", () => chromium.launch({ channel: "msedge" })]);
  attempts.push(["Google Chrome", () => chromium.launch({ channel: "chrome" })]);
  const errors: string[] = [];
  for (const [label, launch] of attempts) {
    try {
      return { browser: await launch(), label };
    } catch (err) {
      errors.push(`${label}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`No usable browser found.\n${errors.join("\n")}`);
}

// --- media helpers -------------------------------------------------------------

const vp9Cache = new Map<string, Promise<Buffer>>();

/**
 * Test-browser-only stand-in for H.264: bundled Chromium has no H.264 decoder,
 * so generated clips are served to it as VP9 WebM copies (made with FFmpeg into
 * `dir`, without audio). Byte ranges are honored so seeking and looping work.
 * With `onlyIfNoH264`, browsers that play H.264 (Edge, Chrome) get the originals.
 * The app and server are unchanged.
 */
export async function serveVp9Copies(page: Page, dir: string, opts: { onlyIfNoH264?: boolean } = {}): Promise<void> {
  if (opts.onlyIfNoH264) {
    const h264 = await page.evaluate(() => document.createElement("video").canPlayType('video/mp4; codecs="avc1.640028"') !== "");
    if (h264) return;
  }
  const tools = { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" };
  await page.route(
    (u) => /^\/media\/[^/]+\/gen\/[^/]+$/.test(u.pathname),
    async (route) => {
      const key = `${dir}|${new URL(route.request().url()).pathname}`;
      if (!vp9Cache.has(key)) {
        vp9Cache.set(
          key,
          (async () => {
            const res = await route.fetch({ headers: { ...route.request().headers(), range: "" } });
            await mkdir(dir, { recursive: true });
            const base = path.join(dir, key.replace(/[^a-z0-9]/gi, "_").slice(-120));
            await Bun.write(`${base}.mp4`, await res.body());
            await runFfmpeg(tools, ["-y", "-i", `${base}.mp4`, "-c:v", "libvpx-vp9", "-b:v", "1M", "-deadline", "realtime", "-cpu-used", "8", "-an", `${base}.webm`]);
            return Buffer.from(await Bun.file(`${base}.webm`).arrayBuffer());
          })(),
        );
      }
      const body = await vp9Cache.get(key)!;
      const m = /^bytes=(\d*)-(\d*)$/.exec(route.request().headers()["range"] ?? "");
      if (!m || (m[1] === "" && m[2] === "")) {
        await route.fulfill({ status: 200, headers: { "content-type": "video/webm", "accept-ranges": "bytes" }, body });
        return;
      }
      const start = m[1] === "" ? Math.max(0, body.length - Number(m[2])) : Number(m[1]);
      const end = m[1] !== "" && m[2] !== "" ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
      await route.fulfill({
        status: 206,
        headers: { "content-type": "video/webm", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${body.length}` },
        body: body.subarray(start, end + 1),
      });
    },
  );
}

// --- API helpers ---------------------------------------------------------------

export async function api<T = unknown>(srv: Server, method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${srv.base}${p}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as T;
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

export interface ViewLite {
  name: string;
  state: {
    promptBlocks: { id: string; text: string; enabled: boolean }[];
    shots: Record<string, { text: string; generations: { submittedPrompt: string; settings: { durationSec: number; resolution: string; seed: number | null } }[] }>;
  };
}

export const filmUrl = (name: string) => `/api/films/${encodeURIComponent(name)}`;

/** Creates a film with one shot image and the given first-block text. */
export async function makeFilm(srv: Server, name: string, shot: string, blockText?: string): Promise<ViewLite> {
  await api(srv, "POST", "/api/films", { name });
  await runFfmpeg({ ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" }, [
    "-f", "lavfi", "-i", "testsrc2=s=640x360", "-frames:v", "1", path.join(srv.root, name, shot),
  ]);
  let view = await api<ViewLite>(srv, "GET", filmUrl(name));
  if (blockText !== undefined) {
    const id = view.state.promptBlocks[0]!.id;
    view = await api<ViewLite>(srv, "PATCH", `${filmUrl(name)}/prompt-blocks/${id}`, { text: blockText });
  }
  return view;
}

export async function getView(srv: Server, name: string): Promise<ViewLite> {
  return api<ViewLite>(srv, "GET", filmUrl(name));
}

// --- page helpers --------------------------------------------------------------

export interface GenRequest {
  film: string;
  shot: string;
  body: { text: string; settings: { durationSec: number; resolution: string; seed: number | null }; count: number; [k: string]: unknown };
}

/** Records every generate POST the page sends. */
export function recordGenerates(page: Page): GenRequest[] {
  const list: GenRequest[] = [];
  page.on("request", (r: Request) => {
    const u = new URL(r.url());
    const m = /^\/api\/films\/([^/]+)\/shots\/([^/]+)\/generate$/.exec(u.pathname);
    if (r.method() === "POST" && m) {
      list.push({ film: decodeURIComponent(m[1]!), shot: decodeURIComponent(m[2]!), body: r.postDataJSON() });
    }
  });
  return list;
}

/**
 * Starts watching the page for any of `needles` in visible text or in the
 * value of any input/textarea. Returns a function that reports what was seen.
 */
export async function watchFor(page: Page, needles: string[], opts: { scope?: "page" | "editor" } = {}): Promise<() => Promise<string[]>> {
  const key = `__watch_${Math.random().toString(36).slice(2)}`;
  await page.evaluate(
    ({ key, needles, scope }) => {
      const seen = new Set<string>();
      (window as unknown as Record<string, unknown>)[key] = seen;
      const check = () => {
        // "editor" = everything except the notification area (toasts).
        const roots: Element[] =
          scope === "editor" ? [...document.querySelectorAll(".app > :not(.toasts)")] : [document.body];
        const parts: string[] = [];
        for (const r of roots) {
          parts.push((r as HTMLElement).innerText ?? "");
          r.querySelectorAll("textarea, input, select").forEach((el) => parts.push((el as HTMLInputElement).value));
        }
        const all = parts.join("\n");
        for (const n of needles) if (all.includes(n)) seen.add(`${n}`);
      };
      check();
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      setInterval(check, 20);
    },
    { key, needles, scope: opts.scope ?? "page" },
  );
  return () => page.evaluate((key) => [...((window as unknown as Record<string, Set<string>>)[key] ?? [])], key);
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// --- tiny assertion helpers ------------------------------------------------------

export class AssertionError extends Error {}

export function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AssertionError(message);
}

export function eq<T>(actual: T, expected: T, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${what}: expected ${e}, got ${a}`);
}
