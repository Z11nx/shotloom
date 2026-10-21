/**
 * On-disk layout of a film folder (documented in docs/STORAGE.md):
 *
 *   <films root>/<Film>/                 your images and audio (you manage these)
 *   <films root>/<Film>/exports/         finished videos
 *   <films root>/<Film>/.shotloom/state.json        film state (versioned JSON)
 *   <films root>/<Film>/.shotloom/state.prev.json   previous good state (auto backup)
 *   <films root>/<Film>/.shotloom/generations/      generated clips + metadata sidecars
 *   <films root>/<Film>/.shotloom/preview/          latest preview render (disposable)
 *   <films root>/<Film>/.shotloom/tmp/              render scratch (cleaned up)
 */
import path from "node:path";

export const META_DIR = ".shotloom";

export function filmDir(root: string, film: string): string {
  return path.join(root, film);
}
export function metaDir(root: string, film: string): string {
  return path.join(root, film, META_DIR);
}
export function stateFile(root: string, film: string): string {
  return path.join(metaDir(root, film), "state.json");
}
export function prevStateFile(root: string, film: string): string {
  return path.join(metaDir(root, film), "state.prev.json");
}
export function generationsDir(root: string, film: string): string {
  return path.join(metaDir(root, film), "generations");
}
export function previewDir(root: string, film: string): string {
  return path.join(metaDir(root, film), "preview");
}
export function renderTmpDir(root: string, film: string): string {
  return path.join(metaDir(root, film), "tmp");
}
export function exportsDir(root: string, film: string): string {
  return path.join(root, film, "exports");
}
export function serverLockFile(root: string): string {
  return path.join(root, META_DIR, "server.lock");
}
