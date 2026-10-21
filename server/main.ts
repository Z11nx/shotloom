/**
 * Entry point: `bun run serve` (or `bun run start`, which builds the UI first).
 * Listens on 127.0.0.1 only.
 */
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app";
import { APP_NAME, loadConfig } from "./config";
import { serverLockFile } from "./films/layout";

function acquireLock(root: string, port: number): () => void {
  const file = serverLockFile(root);
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    try {
      const prev = JSON.parse(readFileSync(file, "utf8")) as { pid?: number; port?: number };
      if (prev.pid && prev.pid !== process.pid && isAlive(prev.pid)) {
        console.error(
          `\n${APP_NAME} is already running for this films folder (process ${prev.pid}, port ${prev.port}).\n` +
            `Two copies would process the same generation jobs, so this one will exit.\n` +
            `If that process is not really ${APP_NAME}, delete ${file} and try again.\n`,
        );
        process.exit(1);
      }
    } catch {
      /* unreadable lock: treat as stale */
    }
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
  return () => {
    try {
      const cur = JSON.parse(readFileSync(file, "utf8")) as { pid?: number };
      if (cur.pid === process.pid) rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config);
  await app.store.ensureRoot();
  await app.store.guard(serverLockFile(config.filmsRoot)); // the lock folder must not lead outside the root
  const release = acquireLock(config.filmsRoot, config.port);

  await app.generation.recover();
  app.generation.start();

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 120,
    fetch: app.fetch,
  });

  const mode = config.providerMode === "mock" ? "MOCK MODE (no network, no charges)" : "fal.ai (real, paid)";
  console.log(`\n  ${APP_NAME} is running at http://localhost:${server.port}`);
  console.log(`  Films folder: ${config.filmsRoot}`);
  console.log(`  Generation:   ${mode}${config.providerMode === "fal" && !config.falKey ? " — FAL_KEY missing, generation disabled" : ""}`);
  console.log(`  Press Ctrl+C to stop.\n`);

  const shutdown = () => {
    app.generation.stop();
    server.stop();
    release();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`${APP_NAME} failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
