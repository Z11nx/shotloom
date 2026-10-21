/**
 * Shared editor context for ONE film selection session.
 *
 * App creates a new context value (and remounts the editor) for every
 * selection, so everything a component captures from here — the film name,
 * the selection token, the helpers — belongs to the session it was rendered
 * in. Responses that finish after the user has moved on are dropped by the
 * ViewGate instead of being shown in another film's editor.
 */
import { createContext, useContext } from "react";
import type { FilmView, StatusResponse } from "../../shared/api";
import type { ParsedSettings, SettingsDraft } from "./settings";
import type { Selection, ViewToken } from "./viewGate";

export interface LightboxItem {
  kind: "image" | "video";
  src: string;
  title: string;
  /** Optional range to loop within (trimmed clips). */
  range?: { inSec: number; outSec: number };
  /** Play on repeat (generated clips). Film previews and exports play once. */
  loop?: boolean;
}

export interface LightboxRequest {
  items: LightboxItem[];
  index: number;
}

export interface FilmCtx {
  film: string;
  selection: Selection;
  view: FilmView;
  status: StatusResponse | null;
  films: string[];
  settingsDraft: SettingsDraft;
  setSettingsDraft: (d: SettingsDraft) => void;
  parsedSettings: ParsedSettings | null;
  /** Runs a mutation that returns a FilmView, applies it if still relevant, reports errors. */
  run: (label: string, op: () => Promise<FilmView>) => Promise<FilmView | null>;
  /** A token for work started now on behalf of this selection. */
  nextSeq: () => ViewToken;
  /** Applies a view obtained with `token`; returns false if it was stale and dropped. */
  applyView: (v: FilmView, token: ViewToken) => boolean;
  /** True while this context's selection is still the one on screen. */
  isCurrent: () => boolean;
  /** Latest view applied in this selection (fresher than `view` inside async handlers). */
  latestView: () => FilmView;
  notify: (message: string) => void;
  openLightbox: (req: LightboxRequest) => void;
}

export const FilmContext = createContext<FilmCtx | null>(null);

export function useFilm(): FilmCtx {
  const ctx = useContext(FilmContext);
  if (!ctx) throw new Error("useFilm outside FilmContext");
  return ctx;
}
