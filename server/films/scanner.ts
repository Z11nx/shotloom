import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileNameProblem, filmNameProblem } from "./paths";

// Same discovery sets as the reference app. Discovery ≠ provider support:
// generation support is decided per model (see shared/models.ts).
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
export const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);

export async function listFilmNames(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && filmNameProblem(e.name) === null)
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export interface FilmMedia {
  images: string[];
  audio: string[];
}

/**
 * Non-hidden regular files directly inside the film folder. Symlinks are not
 * followed (Dirent.isFile() is false for them), and names that could not be
 * safely served are skipped.
 */
export async function scanFilmMedia(dir: string): Promise<FilmMedia> {
  const entries = await readdir(dir, { withFileTypes: true });
  const images: string[] = [];
  const audio: string[] = [];
  for (const e of entries) {
    if (!e.isFile() || fileNameProblem(e.name) !== null) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) images.push(e.name);
    else if (AUDIO_EXTENSIONS.has(ext)) audio.push(e.name);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  return { images: images.sort(byName), audio: audio.sort(byName) };
}
