/**
 * Typed client for the local Shotloom server. Every call returns parsed JSON or
 * throws ApiError with the server's message. No credentials ever live here.
 */
import type { ApiErrorBody, FalBalanceResponse, FilmSummary, FilmView, GenerateResponse, RenderStatus, StatusResponse } from "../../shared/api";
import type { AspectRatio, GenerationSettings, Trim } from "../../shared/domain";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** True when the server could not be reached at all. */
export class OfflineError extends Error {}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new OfflineError("Can't reach the Shotloom server.");
  }
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    if (res.status === 502 || res.status === 504) throw new OfflineError("Can't reach the Shotloom server.");
    throw new ApiError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

const enc = encodeURIComponent;
const f = (film: string) => `/api/films/${enc(film)}`;

export const api = {
  status: () => request<StatusResponse>("GET", "/api/status"),
  falBalance: (refresh = false) => request<FalBalanceResponse>("GET", `/api/fal/balance${refresh ? "?refresh=1" : ""}`),
  films: () => request<{ films: FilmSummary[] }>("GET", "/api/films"),
  createFilm: (name: string) => request<{ film: string }>("POST", "/api/films", { name }),
  film: (film: string) => request<FilmView>("GET", f(film)),
  openFolder: (film: string, target: "film" | "exports") =>
    request<{ ok: true }>("POST", `${f(film)}/open-folder`, { target }),
  startFresh: (film: string) => request<{ keptAs: string | null; view: FilmView }>("POST", `${f(film)}/state/start-fresh`, {}),
  saveSettings: (film: string, s: GenerationSettings) => request<FilmView>("PUT", `${f(film)}/settings`, s),

  addBlock: (film: string, text: string) => request<FilmView>("POST", `${f(film)}/prompt-blocks`, { text, enabled: true }),
  updateBlock: (film: string, id: string, patch: { text?: string; enabled?: boolean }) =>
    request<FilmView>("PATCH", `${f(film)}/prompt-blocks/${enc(id)}`, patch),
  deleteBlock: (film: string, id: string) => request<FilmView>("DELETE", `${f(film)}/prompt-blocks/${enc(id)}`),
  reorderBlocks: (film: string, ids: string[]) => request<FilmView>("PUT", `${f(film)}/prompt-blocks/order`, { ids }),
  importBlocks: (film: string, sourceFilm: string) =>
    request<FilmView>("POST", `${f(film)}/prompt-blocks/import`, { sourceFilm }),

  saveShotText: (film: string, shot: string, text: string) =>
    request<FilmView>("PATCH", `${f(film)}/shots/${enc(shot)}`, { text }),
  generate: (film: string, shot: string, body: { text: string; settings: GenerationSettings; count: 1 | 4; expectedPrompt?: string }) =>
    request<GenerateResponse>("POST", `${f(film)}/shots/${enc(shot)}/generate`, body),

  setTrim: (film: string, id: string, trim: Trim | null) =>
    request<FilmView>("PATCH", `${f(film)}/generations/${enc(id)}`, { trim }),
  deleteGeneration: (film: string, id: string) => request<FilmView>("DELETE", `${f(film)}/generations/${enc(id)}`),
  resume: (film: string, id: string) => request<FilmView>("POST", `${f(film)}/generations/${enc(id)}/resume`, {}),
  markFailed: (film: string, id: string) => request<FilmView>("POST", `${f(film)}/generations/${enc(id)}/mark-failed`, {}),

  addClip: (film: string, generationId: string) => request<FilmView>("POST", `${f(film)}/timeline`, { generationId }),
  removeClip: (film: string, clipId: string) => request<FilmView>("DELETE", `${f(film)}/timeline/${enc(clipId)}`),
  reorderClips: (film: string, ids: string[]) => request<FilmView>("PUT", `${f(film)}/timeline/order`, { ids }),
  muteClip: (film: string, clipId: string, muted: boolean) =>
    request<FilmView>("PATCH", `${f(film)}/timeline/${enc(clipId)}`, { muted }),
  setSoundtrack: (film: string, filename: string | null, offsetSec: number) =>
    request<FilmView>("PUT", `${f(film)}/soundtrack`, { filename, offsetSec }),
  setAspect: (film: string, aspectRatio: AspectRatio) => request<FilmView>("PUT", `${f(film)}/aspect-ratio`, { aspectRatio }),
  render: (film: string, kind: "preview" | "export") => request<RenderStatus>("POST", `${f(film)}/render`, { kind }),
};

export const mediaUrl = {
  source: (film: string, file: string) => `/media/${enc(film)}/source/${enc(file)}`,
  generation: (film: string, id: string) => `/media/${enc(film)}/gen/${enc(id)}`,
};

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
