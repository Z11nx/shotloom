/**
 * Wires services together and produces the request handler. Kept separate from
 * main.ts so tests can build a full app against a temporary films root.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { getModel, MINIMAX_H3_MAX_I2V, MOCK_I2V, defaultSettings } from "../shared/models";
import type { AppConfig } from "./config";
import { AppError } from "./errors";
import { FilmStore } from "./films/store";
import { createFalProvider } from "./generation/providers/fal";
import { createMockProvider } from "./generation/providers/mock";
import type { GenerationProvider } from "./generation/providers/types";
import { GenerationService } from "./generation/service";
import type { MediaTools } from "./media/ffmpeg";
import { RenderService } from "./media/renderService";
import { errorResponse, json, serveFile } from "./http/respond";
import { buildRouter } from "./http/routes";
import { openFolderInFileManager, type FolderOpener } from "./system/opener";
import { StatusChecker } from "./system/status";
import { FalBalance } from "./system/falBalance";
import { resolveInside } from "./films/paths";

export interface AppOverrides {
  providers?: GenerationProvider[];
  openFolder?: FolderOpener;
  log?: (m: string) => void;
  pollIntervalMs?: number;
  backoffBaseMs?: number;
  falBalance?: FalBalance;
}

export interface App {
  config: AppConfig;
  store: FilmStore;
  generation: GenerationService;
  renders: RenderService;
  fetch: (req: Request) => Promise<Response>;
}

export function createApp(config: AppConfig, overrides: AppOverrides = {}): App {
  const log = overrides.log ?? ((m: string) => console.log(m));
  const tools: MediaTools = { ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath };
  const activeModel = config.providerMode === "mock" ? MOCK_I2V : MINIMAX_H3_MAX_I2V;
  // Both adapters are always registered so existing jobs keep polling with the
  // provider they were created with, whatever mode new jobs use.
  const providers = overrides.providers ?? [
    createFalProvider({ apiKey: config.falKey }),
    createMockProvider({ tools }),
  ];
  const store = new FilmStore({ root: config.filmsRoot, defaultSettings: () => defaultSettings(activeModel) });
  const generation = new GenerationService({
    store,
    providers,
    activeModel: getModel(activeModel.key)!,
    tools,
    log,
    pollIntervalMs: overrides.pollIntervalMs,
    backoffBaseMs: overrides.backoffBaseMs,
  });
  const renders = new RenderService(store, tools, log);
  const status = new StatusChecker(config, generation);
  const router = buildRouter({
    store,
    generation,
    renders,
    status,
    falBalance: overrides.falBalance ?? new FalBalance(config),
    openFolder: overrides.openFolder ?? openFolderInFileManager,
  });

  const allowedHosts = new Set(
    [config.port, config.devClientPort].flatMap((port) => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]),
  );
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // DNS-rebinding guard: only answer requests addressed to this machine.
    const host = (req.headers.get("host") ?? "").toLowerCase();
    if (!allowedHosts.has(host)) {
      throw new AppError(403, "HOST_NOT_ALLOWED", "Shotloom only answers requests addressed to localhost.");
    }
    const safeMethod = req.method === "GET" || req.method === "HEAD";
    const origin = req.headers.get("origin");
    if (!safeMethod && origin !== null && !allowedOrigins.has(origin.toLowerCase())) {
      throw new AppError(403, "ORIGIN_NOT_ALLOWED", "Cross-site requests are not allowed.");
    }

    const rawPath = url.pathname;
    if (rawPath.startsWith("/api/") || rawPath.startsWith("/media/")) {
      const match = router.match(req.method, rawPath);
      if (match === "method") throw new AppError(405, "METHOD_NOT_ALLOWED", `${req.method} is not supported here.`);
      if (!match) throw new AppError(404, "NOT_FOUND", "No such endpoint.");
      return match.handler(req, match.params, url);
    }
    if (!safeMethod) throw new AppError(405, "METHOD_NOT_ALLOWED", "Not allowed.");
    return serveFrontend(req, rawPath);
  }

  async function serveFrontend(req: Request, rawPath: string): Promise<Response> {
    const dist = config.distDir;
    if (!existsSync(path.join(dist, "index.html"))) {
      return new Response(
        "The interface has not been built yet. Run `bun run start` (builds and serves), or `bun run dev` for development.",
        { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    let rel: string;
    try {
      rel = decodeURIComponent(rawPath).replace(/^\/+/, "");
    } catch {
      throw new AppError(400, "BAD_REQUEST", "Malformed URL.");
    }
    if (rel && !rel.includes("\0") && rel.startsWith("assets/")) {
      const abs = await resolveInside(dist, ...rel.split("/"));
      if (existsSync(abs)) return serveFile(req, abs, "public, max-age=31536000, immutable");
    }
    if (rel === "favicon.svg") {
      const abs = path.join(dist, "favicon.svg");
      if (existsSync(abs)) return serveFile(req, abs, "public, max-age=86400");
    }
    // Single-page app: everything else gets index.html.
    return serveFile(req, path.join(dist, "index.html"), "no-cache");
  }

  return {
    config,
    store,
    generation,
    renders,
    fetch: async (req) => {
      try {
        return await handle(req);
      } catch (err) {
        return errorResponse(err, log);
      }
    },
  };
}

export { json };
