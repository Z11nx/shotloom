import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DependencyCheck, StatusResponse } from "../../shared/api";
import { APP_NAME, APP_VERSION, type AppConfig } from "../config";
import type { GenerationService } from "../generation/service";
import { toolVersion } from "../media/ffmpeg";

async function checkTool(bin: string): Promise<DependencyCheck> {
  try {
    return { ok: true, detail: await toolVersion(bin) };
  } catch (err) {
    return {
      ok: false,
      detail: `${bin} was not found or could not run (${(err as Error).message}). Install FFmpeg and add it to PATH, or set FFMPEG_PATH / FFPROBE_PATH in .env.`,
    };
  }
}

async function checkWritable(dir: string): Promise<DependencyCheck> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
    return { ok: true, detail: "Writable" };
  } catch (err) {
    return { ok: false, detail: `Cannot write to the films folder: ${(err as Error).message}` };
  }
}

export class StatusChecker {
  private cached: { at: number; value: Omit<StatusResponse, "provider"> } | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly generation: GenerationService,
  ) {}

  async get(): Promise<StatusResponse> {
    if (!this.cached || Date.now() - this.cached.at > 30_000) {
      const [ffmpeg, ffprobe, root] = await Promise.all([
        checkTool(this.config.ffmpegPath),
        checkTool(this.config.ffprobePath),
        checkWritable(this.config.filmsRoot),
      ]);
      this.cached = {
        at: Date.now(),
        value: {
          appName: APP_NAME,
          version: APP_VERSION,
          platform: process.platform,
          activeModel: this.generation.activeModel,
          falKeyConfigured: Boolean(this.config.falKey), // boolean only; the key never leaves the server
          ffmpeg,
          ffprobe,
          filmsRoot: { ...root, path: this.config.filmsRoot },
        },
      };
    }
    const provider = this.generation.activeProvider();
    const reason = provider.unavailableReason();
    return {
      ...this.cached.value,
      provider: { id: provider.id, label: provider.label, isMock: provider.isMock, ready: reason === null, reason },
    };
  }
}
