import { useState } from "react";
import { api, messageOf, type ApiError } from "../lib/api";

export function EmptyNoFilms({ onCreate, root }: { onCreate: (name: string) => Promise<string | null>; root: string }) {
  const [name, setName] = useState("My first film");
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="center-state">
      <div className="empty-card">
        <h1>Make your first film</h1>
        <p>
          A film is a folder of source images. Shotloom turns each image into a shot you can describe, generate, trim
          and cut together.
        </p>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const err = await onCreate(name.trim());
            if (err) setError(err);
          }}
        >
          <label htmlFor="first-film">Film name</label>
          <input id="first-film" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
            Create film
          </button>
        </form>
        {error && <p className="field-error" role="alert">{error}</p>}
        {root && <p className="muted small">Films are stored in {root}</p>}
      </div>
    </main>
  );
}

export function BrokenFilm({
  film,
  error,
  onFixed,
  notify,
}: {
  film: string;
  error: ApiError;
  onFixed: () => void;
  notify: (m: string) => void;
}) {
  const recoverable = error.code === "STATE_UNREADABLE" || error.code === "STATE_MISSING";
  return (
    <main className="center-state">
      <div className="empty-card" role="alert">
        <h1>“{film}” can't be opened</h1>
        <p>{error.message}</p>
        <div className="row-actions">
          <button type="button" className="btn" onClick={onFixed}>
            Try again
          </button>
          <button type="button" className="btn" onClick={() => api.openFolder(film, "film").catch((e) => notify(messageOf(e)))}>
            Open film folder
          </button>
          {recoverable && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                if (!confirm("Keep the unreadable state file under a new name and start this film fresh? Prompt blocks, shot text, timeline and generation history will start empty (clip files stay on disk).")) return;
                try {
                  const r = await api.startFresh(film);
                  notify(r.keptAs ? `Started fresh. The old file was kept as ${r.keptAs}.` : "Started fresh.");
                  onFixed();
                } catch (e) {
                  notify(messageOf(e));
                }
              }}
            >
              Start fresh (keeps the old file)
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
