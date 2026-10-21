import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FilmView, StatusResponse } from "../shared/api";
import { api, ApiError, messageOf, OfflineError } from "./lib/api";
import { FilmContext, type FilmCtx, type LightboxRequest } from "./lib/filmContext";
import { draftFromSettings, parseSettings, type SettingsDraft } from "./lib/settings";
import { ViewGate, type Selection, type ViewToken } from "./lib/viewGate";
import { TopBar } from "./components/TopBar";
import { LeftPanel } from "./components/LeftPanel";
import { ShotList } from "./components/ShotList";
import { ShotNav } from "./components/ShotNav";
import { Timeline } from "./components/Timeline";
import { Lightbox } from "./components/Lightbox";
import { Toasts, useToasts } from "./components/Toasts";
import { BrokenFilm, EmptyNoFilms } from "./components/EmptyStates";

const SELECTED_KEY = "shotloom.selectedFilm";

function readSelected(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}
function writeSelected(film: string | null) {
  try {
    if (film) localStorage.setItem(SELECTED_KEY, film);
    else localStorage.removeItem(SELECTED_KEY);
  } catch {
    /* storage unavailable: selection just isn't remembered */
  }
}

export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [films, setFilms] = useState<string[] | null>(null);
  const gate = useRef(new ViewGate()).current;
  const [selection, setSelection] = useState<Selection | null>(() => gate.select(readSelected()));
  const [view, setView] = useState<FilmView | null>(null);
  const viewRef = useRef<FilmView | null>(null);
  const [filmError, setFilmError] = useState<ApiError | null>(null);
  const [offline, setOffline] = useState(false);
  const [settingsDraft, setSettingsDraftState] = useState<SettingsDraft | null>(null);
  const [lightbox, setLightbox] = useState<LightboxRequest | null>(null);
  const toasts = useToasts();
  const film = selection?.film ?? null;

  /** Applies a view only if it belongs to the current selection and is not older than what is shown. */
  const applyView = useCallback(
    (v: FilmView, token: ViewToken) => {
      if (!gate.accept(token, v.name)) return false;
      viewRef.current = v;
      setView(v);
      setFilmError(null);
      return true;
    },
    [gate],
  );

  const select = useCallback(
    (name: string | null) => {
      const sel = gate.select(name);
      viewRef.current = null;
      setSelection(sel);
      setView(null);
      setFilmError(null);
      setSettingsDraftState(null);
      setLightbox(null);
      writeSelected(name);
    },
    [gate],
  );

  // --- status and film list -------------------------------------------------------
  const refreshFilms = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([api.status(), api.films()]);
      setStatus(s);
      setFilms(list.films.map((f) => f.name));
      setOffline(false);
    } catch (err) {
      if (err instanceof OfflineError) setOffline(true);
    }
  }, []);

  useEffect(() => {
    void refreshFilms();
    const t = setInterval(() => void refreshFilms(), 8000);
    return () => clearInterval(t);
  }, [refreshFilms]);

  // Choose a film once the list is known (or when the selected one disappears).
  useEffect(() => {
    if (!films) return;
    if (film && films.includes(film)) return;
    select(films[0] ?? null);
  }, [films, film, select]);

  // --- film polling (discovers new files, job progress, render progress) ----------
  const pollFilm = useCallback(
    async (sel: Selection) => {
      const token = gate.token(sel);
      try {
        const v = await api.film(sel.film);
        applyView(v, token);
        if (gate.isCurrent(sel)) setOffline(false);
      } catch (err) {
        if (!gate.isCurrent(sel)) return; // a stale failure must not touch the film now on screen
        if (err instanceof OfflineError) setOffline(true);
        else if (err instanceof ApiError) {
          viewRef.current = null;
          setFilmError(err);
          setView(null);
        }
      }
    },
    [applyView, gate],
  );

  useEffect(() => {
    if (!selection) return;
    void pollFilm(selection);
    const t = setInterval(() => void pollFilm(selection), 2000);
    return () => clearInterval(t);
  }, [selection, pollFilm]);

  // Settings are edited as visible text; initialize from the film once per selection.
  useEffect(() => {
    if (view && !settingsDraft) setSettingsDraftState(draftFromSettings(view.state.generationSettings));
  }, [view, settingsDraft]);

  const settingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const model = status?.activeModel ?? null;
  const setSettingsDraft = useCallback(
    (sel: Selection, d: SettingsDraft) => {
      if (!gate.isCurrent(sel)) return;
      setSettingsDraftState(d);
      if (settingsTimer.current) clearTimeout(settingsTimer.current);
      if (!model) return;
      const parsed = parseSettings(model, d).gen1;
      if (!parsed) return; // only fully valid visible settings are remembered
      settingsTimer.current = setTimeout(() => {
        // Saved to the film these settings were typed in, even if the user has since switched.
        api.saveSettings(sel.film, parsed).catch(() => undefined);
      }, 500);
    },
    [gate, model],
  );

  const createFilm = useCallback(
    async (name: string): Promise<string | null> => {
      try {
        const { film: created } = await api.createFilm(name);
        await refreshFilms();
        select(created);
        return null;
      } catch (err) {
        return messageOf(err);
      }
    },
    [refreshFilms, select],
  );

  const parsedSettings = useMemo(
    () => (model && settingsDraft ? parseSettings(model, settingsDraft) : null),
    [model, settingsDraft],
  );

  const ctx: FilmCtx | null = useMemo(() => {
    if (!selection || !view || view.name !== selection.film || !settingsDraft) return null;
    const sel = selection;
    const notify = (m: string) => toasts.push(gate.isCurrent(sel) ? m : `${sel.film}: ${m}`);
    return {
      film: sel.film,
      selection: sel,
      view,
      status,
      films: films ?? [],
      settingsDraft,
      setSettingsDraft: (d) => setSettingsDraft(sel, d),
      parsedSettings,
      nextSeq: () => gate.token(sel),
      applyView,
      isCurrent: () => gate.isCurrent(sel),
      latestView: () => (gate.isCurrent(sel) && viewRef.current ? viewRef.current : view),
      run: async (label, op) => {
        const token = gate.token(sel);
        try {
          const v = await op();
          return applyView(v, token) ? v : null;
        } catch (err) {
          notify(`${label}: ${messageOf(err)}`);
          return null;
        }
      },
      notify,
      openLightbox: (req) => {
        if (gate.isCurrent(sel)) setLightbox(req);
      },
    };
  }, [selection, view, status, films, settingsDraft, setSettingsDraft, parsedSettings, applyView, gate, toasts.push]);

  // Changes whenever a clip finishes, so the top bar can re-read the fal balance.
  const finishedClips = view
    ? Object.values(view.state.shots).reduce((n, s) => n + s.generations.filter((g) => g.status === "completed" || g.status === "failed").length, 0)
    : 0;

  return (
    <div className="app">
      <TopBar
        status={status}
        films={films}
        film={film}
        onSelect={select}
        onCreate={createFilm}
        onOpenFolder={() => film && api.openFolder(film, "film").catch((e) => toasts.push(messageOf(e)))}
        finishedClips={finishedClips}
      />
      {offline && (
        <div className="banner banner-error" role="alert">
          Can't reach the Shotloom server. Make sure it is still running; this page retries automatically.
        </div>
      )}
      {status && !status.ffmpeg.ok && (
        <div className="banner banner-error" role="alert">
          FFmpeg is missing, so clips can't be checked, previewed or exported. {status.ffmpeg.detail}
        </div>
      )}
      {status && status.ffmpeg.ok && !status.ffprobe.ok && (
        <div className="banner banner-error" role="alert">{status.ffprobe.detail}</div>
      )}
      {status && !status.filmsRoot.ok && (
        <div className="banner banner-error" role="alert">{status.filmsRoot.detail}</div>
      )}

      {films === null && !offline ? (
        <main className="center-state" aria-busy="true">
          Loading…
        </main>
      ) : films && films.length === 0 ? (
        <EmptyNoFilms onCreate={createFilm} root={status?.filmsRoot.path ?? ""} />
      ) : filmError && selection ? (
        <BrokenFilm
          film={selection.film}
          error={filmError}
          onFixed={() => void pollFilm(selection)}
          notify={toasts.push}
        />
      ) : !ctx ? (
        <main className="center-state" aria-busy="true">
          Opening film…
        </main>
      ) : (
        // Keyed by selection session: nothing editor-local survives a film switch.
        <FilmContext.Provider key={`${ctx.selection.film}#${ctx.selection.epoch}`} value={ctx}>
          <div className="workspace">
            <LeftPanel />
            <ShotList />
            <ShotNav />
          </div>
          <Timeline />
        </FilmContext.Provider>
      )}
      {lightbox && <Lightbox request={lightbox} onClose={() => setLightbox(null)} />}
      <Toasts toasts={toasts.items} onDismiss={toasts.dismiss} />
    </div>
  );
}
