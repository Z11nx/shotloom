/**
 * Local drafts for text the user is typing.
 *
 * - A draft ignores server refreshes while it is focused or has unsaved edits,
 *   so background polling never overwrites typing.
 * - Edits are saved after a short pause.
 * - Drafts register in named groups. Generate calls flushDrafts(group) for the
 *   current film's prompt blocks and refuses to submit if any save fails.
 *   A failed draft keeps its text and stays "unsaved" so it can be retried.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

interface Entry {
  group: string;
  flush: () => Promise<void>;
  value: () => string;
  /** Unsaved edits or a save in flight. */
  pending: () => boolean;
  /** The last save attempt failed. */
  failed: () => boolean;
}
const registry = new Map<string, Entry>();

// --- read-only save summary for the status indicator ---------------------------
// Purely observational: it reports draft state and never changes saving.
const summaryListeners = new Set<() => void>();
let summarySnapshot = "idle";
function recomputeSummary(): void {
  let pending = false;
  let failed = false;
  for (const e of registry.values()) {
    if (e.failed()) failed = true;
    else if (e.pending()) pending = true;
  }
  const next = failed ? "failed" : pending ? "saving" : "idle";
  if (next !== summarySnapshot) {
    summarySnapshot = next;
    summaryListeners.forEach((l) => l());
  }
}
function scheduleSummary(): void {
  queueMicrotask(recomputeSummary);
}
/** "saving" while any draft has unsaved edits, "failed" if a save failed, else "idle". */
export function useSaveSummary(): "idle" | "saving" | "failed" {
  return useSyncExternalStore(
    (l) => {
      summaryListeners.add(l);
      return () => summaryListeners.delete(l);
    },
    () => summarySnapshot as "idle" | "saving" | "failed",
  );
}

export class DraftSaveError extends Error {
  constructor(
    readonly failures: number,
    readonly firstMessage: string,
  ) {
    super(failures === 1 ? firstMessage : `${failures} edits could not be saved (first: ${firstMessage})`);
    this.name = "DraftSaveError";
  }
}

/** Saves every unsaved draft in `group`. Rejects with DraftSaveError if any save fails. */
export async function flushDrafts(group: string): Promise<void> {
  const entries = [...registry.values()].filter((e) => e.group === group);
  const results = await Promise.allSettled(entries.map((e) => e.flush()));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length) {
    const msg = failed[0]!.reason instanceof Error ? failed[0]!.reason.message : String(failed[0]!.reason);
    throw new DraftSaveError(failed.length, msg);
  }
}

/** The text currently visible in a registered draft, if it exists. */
export function draftValue(key: string): string | undefined {
  return registry.get(key)?.value();
}

export interface Draft {
  value: string;
  setValue: (v: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  /** Saves now if there are unsaved edits. Rejects if the save fails. */
  flush: () => Promise<void>;
  /** The revision of the text visible right now. Every edit creates a new revision. */
  revision: () => number;
  /**
   * Another request (e.g. Gen) persisted the text of revision `rev`. Only that
   * exact revision is marked saved. If newer edits exist, they stay unsaved and
   * are saved again afterwards, so the older text cannot win on the server.
   */
  acknowledge: (rev: number) => void;
  /** Drops unsaved edits and any pending autosave (e.g. the item is being deleted). */
  discardPending: () => void;
  dirty: boolean;
  error: string | null;
}

export interface DraftOptions {
  group?: string;
  delayMs?: number;
  /** Called if the final save after unmounting (e.g. switching films) fails. */
  onLostSave?: (message: string) => void;
}

export function useDraft(key: string, serverValue: string, save: (v: string) => Promise<void>, opts: DraftOptions = {}): Draft {
  const delayMs = opts.delayMs ?? 700;
  const [value, setValueState] = useState(serverValue);
  const [dirty, setDirty] = useState(false);
  const [error, setErrorState] = useState<string | null>(null);
  const errorRef = useRef<string | null>(null);
  const setError = (e: string | null) => {
    errorRef.current = e;
    setErrorState(e);
  };
  const valueRef = useRef(serverValue);
  const dirtyRef = useRef(false);
  const focusedRef = useRef(false);
  const mountedRef = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  /** Revision of the visible text; incremented on every edit. */
  const revRef = useRef(0);
  /** Revision carried by the save currently in flight (if any). */
  const inflightRevRef = useRef<number | null>(null);
  /** Save the current text even if it looks clean (another request may have overwritten it). */
  const forceRef = useRef(false);
  const saveRef = useRef(save);
  saveRef.current = save;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Adopt server value only when the user is not editing.
  useEffect(() => {
    if (!dirtyRef.current && !focusedRef.current && serverValue !== valueRef.current) {
      valueRef.current = serverValue;
      setValueState(serverValue);
    }
  }, [serverValue]);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inflight.current) await inflight.current.catch(() => undefined);
    if (!dirtyRef.current && !forceRef.current) return;
    forceRef.current = false;
    const sending = valueRef.current;
    const sendingRev = revRef.current;
    inflightRevRef.current = sendingRev;
    const p = saveRef
      .current(sending)
      .then(() => {
        if (mountedRef.current) setError(null);
        // Clean only if no edit happened while this save was in flight.
        if (revRef.current === sendingRev) {
          dirtyRef.current = false;
          if (mountedRef.current) setDirty(false);
        }
      })
      .catch((err: unknown) => {
        if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
        throw err;
      })
      .finally(() => {
        if (inflight.current === p) {
          inflight.current = null;
          inflightRevRef.current = null;
        }
      });
    inflight.current = p;
    scheduleSummary();
    p.finally(scheduleSummary).catch(() => undefined);
    await p;
  }, []);

  // Keep the save indicator current (observational only).
  useEffect(scheduleSummary, [dirty, error]);

  useEffect(() => {
    mountedRef.current = true;
    const entry: Entry = {
      group: optsRef.current.group ?? "default",
      flush,
      value: () => valueRef.current,
      pending: () => dirtyRef.current || inflight.current !== null,
      failed: () => errorRef.current !== null,
    };
    registry.set(key, entry);
    return () => {
      mountedRef.current = false;
      if (registry.get(key) === entry) registry.delete(key);
      scheduleSummary();
      // Save on unmount (e.g. switching films) to the film this draft belongs to.
      void flush().catch((err: unknown) => optsRef.current.onLostSave?.(err instanceof Error ? err.message : String(err)));
    };
  }, [key, flush]);

  const setValue = useCallback(
    (v: string) => {
      valueRef.current = v;
      revRef.current += 1;
      setValueState(v);
      dirtyRef.current = true;
      setDirty(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush().catch(() => undefined), delayMs);
    },
    [delayMs, flush],
  );

  const revision = useCallback(() => revRef.current, []);

  const acknowledge = useCallback(
    (rev: number) => {
      const inflightRev = inflightRevRef.current;
      if (revRef.current === rev && (inflightRev === null || inflightRev === rev)) {
        // The persisted text is exactly what is visible: nothing left to save.
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        dirtyRef.current = false;
        forceRef.current = false;
        if (mountedRef.current) setDirty(false);
        return;
      }
      // Newer edits exist, or a save of another revision may have reached the
      // server before or after the request being acknowledged. Keep the edits
      // unsaved and save the visible text again; a pending autosave stays as is.
      dirtyRef.current = true;
      forceRef.current = true;
      if (mountedRef.current) setDirty(true);
      if (!timer.current) void flush().catch(() => undefined);
    },
    [flush],
  );

  const discardPending = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    dirtyRef.current = false;
    forceRef.current = false;
    if (mountedRef.current) setDirty(false);
  }, []);

  return {
    value,
    setValue,
    dirty,
    error,
    flush,
    revision,
    acknowledge,
    discardPending,
    onFocus: () => {
      focusedRef.current = true;
    },
    onBlur: () => {
      focusedRef.current = false;
      void flush().catch(() => undefined);
    },
  };
}

export const blockGroup = (film: string) => `blocks:${film}`;
export const blockKey = (film: string, id: string) => `block:${film}:${id}`;
