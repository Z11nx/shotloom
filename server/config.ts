import path from "node:path";

export type ProviderMode = "fal" | "mock";

export interface AppConfig {
  appDir: string;
  filmsRoot: string;
  port: number;
  host: string;
  providerMode: ProviderMode;
  /** Present only on the server. Never serialized into responses, logs, or metadata. */
  falKey: string | null;
  /**
   * Optional read-only fal key (BILLING preset) used only to show the credit
   * balance. Falls back to `falKey`. Server-only, like `falKey`.
   */
  falBillingKey: string | null;
  ffmpegPath: string;
  ffprobePath: string;
  /** Built frontend served by the backend in production mode. */
  distDir: string;
  /** Extra Host header values allowed (e.g. the Vite dev server port). */
  devClientPort: number;
}

export const APP_NAME = "Shotloom";
export const APP_VERSION = "0.1.0";

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const appDir = path.resolve(import.meta.dir, "..");
  const rawRoot = env.FILMS_ROOT?.trim() || "./films";
  const filmsRoot = path.resolve(appDir, rawRoot);
  const port = parsePort(env.PORT, 8787);
  const modeRaw = (env.GENERATION_PROVIDER ?? "mock").trim().toLowerCase();
  if (modeRaw !== "fal" && modeRaw !== "mock") {
    throw new Error(`GENERATION_PROVIDER must be "fal" or "mock" (got "${modeRaw}").`);
  }
  const falKey = env.FAL_KEY?.trim() || null;
  return {
    appDir,
    filmsRoot,
    port,
    host: "127.0.0.1",
    providerMode: modeRaw,
    falKey,
    falBillingKey: env.FAL_BILLING_KEY?.trim() || null,
    ffmpegPath: env.FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobePath: env.FFPROBE_PATH?.trim() || "ffprobe",
    distDir: path.join(appDir, "dist"),
    devClientPort: parsePort(env.CLIENT_PORT, 5173),
  };
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid port: ${raw}`);
  return n;
}
