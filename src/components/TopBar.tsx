import { useEffect, useRef, useState } from "react";
import type { FalBalanceResponse, StatusResponse } from "../../shared/api";
import { api } from "../lib/api";
import { useSaveSummary } from "../lib/drafts";
import { BrandIcon, FolderIcon, PlusIcon } from "./icons";

interface Props {
  status: StatusResponse | null;
  films: string[] | null;
  film: string | null;
  onSelect: (film: string) => void;
  onCreate: (name: string) => Promise<string | null>;
  onOpenFolder: () => void;
  /** Count of finished clips in the open film; a change triggers a balance refresh. */
  finishedClips: number;
}

export function TopBar({ status, films, film, onSelect, onCreate, onOpenFolder, finishedClips }: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const err = await onCreate(name.trim());
    setBusy(false);
    if (err) setError(err);
    else {
      setCreating(false);
      setName("");
      setError(null);
    }
  }

  const provider = status?.provider;
  const balance = useFalBalance(Boolean(provider && !provider.isMock && provider.ready), finishedClips);
  return (
    <header className="topbar">
      <div className="brand">
        <BrandIcon />
        <span>Shotloom</span>
      </div>

      {films && films.length > 0 && (
        <select className="film-select" aria-label="Film" value={film ?? ""} onChange={(e) => onSelect(e.target.value)}>
          {films.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      )}

      {creating ? (
        <form className="new-film" onSubmit={submit}>
          <label className="visually-hidden" htmlFor="new-film-name">
            New film name
          </label>
          <input
            id="new-film-name"
            autoFocus
            value={name}
            maxLength={64}
            placeholder="Film name"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !name.trim()}>
            Create
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setCreating(false)}>
            Cancel
          </button>
          {error && (
            <span className="field-error small" role="alert">
              {error}
            </span>
          )}
        </form>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}>
          <PlusIcon />
          New film
        </button>
      )}

      <div className="topbar-status">
        {provider?.isMock && (
          <span className="chip chip-mock" title="Generations are fake videos made on this computer. Nothing is sent to fal.">
            Mock mode · no charges
          </span>
        )}
        {provider && !provider.isMock && provider.ready && <FalChip balance={balance} />}
        {provider && !provider.ready && (
          <span className="chip chip-warn" title={provider.reason ?? ""}>
            Generation off: {provider.reason}
          </span>
        )}
        {film && <SaveStatus />}
        {film && (
          <button type="button" className="icon-btn" aria-label="Open film folder" title="Open film folder" onClick={onOpenFolder}>
            <FolderIcon />
          </button>
        )}
      </div>
    </header>
  );
}

/** Reflects the real autosave state of descriptions and prompt blocks. */
function SaveStatus() {
  const state = useSaveSummary();
  const text = state === "failed" ? "Changes not saved" : state === "saving" ? "Saving…" : "Saved locally";
  return (
    <span className={`save-status save-${state}`} role="status" aria-live="polite">
      <span className="save-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

const PAID_NOTE = "Generate uploads the source image and prompt to fal.ai and is billed to your fal account.";
const LOW_BALANCE = 1;

/** The live-mode chip: fal credits left when they can be read, otherwise "paid generation". */
function FalChip({ balance }: { balance: FalBalanceResponse | null }) {
  if (balance?.state === "ok") {
    const at = new Date(balance.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const low = balance.balance < LOW_BALANCE;
    return (
      <span
        className={`chip chip-live${low ? " chip-low" : ""}`}
        data-testid="fal-credits"
        title={`${PAID_NOTE}\nCredits checked at ${at}. Updates every minute and after each clip finishes.`}
      >
        fal.ai · {money(balance.balance, balance.currency)} credits{low ? " · low" : ""}
      </span>
    );
  }
  if (balance?.state === "unavailable") {
    return (
      <span className="chip chip-live" data-testid="fal-credits" title={`${PAID_NOTE}\n${balance.message}`}>
        fal.ai · paid · credits unavailable
      </span>
    );
  }
  return (
    <span className="chip chip-live" title={PAID_NOTE}>
      fal.ai · paid generation
    </span>
  );
}

function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`; // unknown currency code
  }
}

/**
 * Reads the fal balance while real generation is active: on load, every
 * minute, when the window regains focus, and a few seconds after a clip
 * finishes (fal may take a moment to post the charge). The server caches and
 * rate-limits, so these are cheap.
 */
function useFalBalance(enabled: boolean, finishedClips: number): FalBalanceResponse | null {
  const [balance, setBalance] = useState<FalBalanceResponse | null>(null);
  const alive = useRef(true);
  const load = (refresh: boolean) =>
    api
      .falBalance(refresh)
      .then((b) => alive.current && setBalance(b))
      .catch(() => undefined); // keep the last value; the server may be restarting

  useEffect(() => {
    alive.current = true;
    if (!enabled) {
      setBalance(null);
      return;
    }
    void load(false);
    const timer = window.setInterval(() => void load(false), 60_000);
    const onFocus = () => void load(true);
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const seen = useRef(finishedClips);
  useEffect(() => {
    if (finishedClips === seen.current) return;
    const grew = finishedClips > seen.current;
    seen.current = finishedClips;
    if (!enabled || !grew) return;
    const t = window.setTimeout(() => void load(true), 4_000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedClips, enabled]);

  return balance;
}
