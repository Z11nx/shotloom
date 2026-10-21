/**
 * Generated output for one shot, split into three parts for the compact row:
 *   VariationControls  – ‹ n / m ›, timeline toggle and a "More actions" menu (text column)
 *   GeneratedPreview   – 16:9 frame with the clip (or job status) and a thin trim line
 *   GenerationDetails  – optional full-width details below the row
 * They share one useVariations() state owned by the shot row.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { effectiveTrim, usableDurationSec, type Generation, type Shot, type Trim } from "../../shared/domain";
import { getModel } from "../../shared/models";
import { api, mediaUrl } from "../lib/api";
import { useFilm } from "../lib/filmContext";
import { isTypingTarget, secs, when } from "../lib/format";
import { loopWithinRange } from "../lib/loopRange";
import { CheckIcon, ChevronLeft, ChevronRight, ExpandIcon, MoreIcon, PlusIcon } from "./icons";
import { Popover } from "./Popover";

const STATUS_TEXT: Record<Generation["status"], string> = {
  queued: "Queued · uploading source",
  submitting: "Submitting",
  submitted: "Waiting in provider queue",
  processing: "Generating",
  downloading: "Downloading result",
  completed: "Ready",
  failed: "Failed",
  uncertain: "Submission uncertain",
};

export interface Variations {
  gens: Generation[];
  index: number;
  setIndex: (i: number) => void;
  current: Generation | undefined;
}

export function useVariations(shot: Shot, followLatest: number): Variations {
  const gens = useMemo(
    () => [...shot.generations].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [shot.generations],
  );
  const [index, setIndex] = useState(Math.max(0, gens.length - 1));
  // Jump to the newest variation after this row submits.
  useEffect(() => {
    if (followLatest > 0) setIndex(gens.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followLatest]);
  useEffect(() => {
    if (index > gens.length - 1) setIndex(Math.max(0, gens.length - 1));
  }, [gens.length, index]);
  return { gens, index, setIndex, current: gens[index] };
}

/** m:ss, with tenths when the value is not a whole second. */
export function shortClock(n: number): string {
  const whole = Math.abs(n - Math.round(n)) < 0.05;
  const v = whole ? Math.round(n) : n;
  const m = Math.floor(v / 60);
  const s = v - m * 60;
  return `${m}:${whole ? String(Math.round(s)).padStart(2, "0") : s.toFixed(1).padStart(4, "0")}`;
}

const resumable = (g: Generation) =>
  g.status === "failed" && !!g.requestId && !!g.error && ["status", "result", "download", "probe"].includes(g.error.stage);

export function VariationControls({
  v,
  detailsOpen,
  onToggleDetails,
  promptOpen,
  onTogglePrompt,
}: {
  v: Variations;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  promptOpen: boolean;
  onTogglePrompt: () => void;
}) {
  const { film, view, run } = useFilm();
  const { gens, index, setIndex, current: g } = v;
  const onTimeline = g ? view.state.timeline.find((c) => c.generationId === g.id) : undefined;

  return (
    <div className="output-controls">
      {gens.length > 0 && (
        <div className="variation-nav" role="group" aria-label="Variations">
          <button type="button" className="nav-btn" aria-label="Previous variation" disabled={index === 0} onClick={() => setIndex(index - 1)}>
            <ChevronLeft />
          </button>
          <span className="tabular" aria-live="polite">
            {index + 1} / {gens.length}
          </span>
          <button
            type="button"
            className="nav-btn"
            aria-label="Next variation"
            disabled={index >= gens.length - 1}
            onClick={() => setIndex(index + 1)}
          >
            <ChevronRight />
          </button>
        </div>
      )}
      {g?.status === "completed" &&
        (onTimeline ? (
          <button
            type="button"
            className="btn btn-xs btn-on"
            aria-label="On timeline"
            title="On the timeline (click to remove)"
            onClick={() => void run("Remove from timeline", () => api.removeClip(film, onTimeline.id))}
          >
            <CheckIcon />
            Timeline
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-xs"
            aria-label="Add to timeline"
            title="Add this variation to the timeline"
            onClick={() => void run("Add to timeline", () => api.addClip(film, g.id))}
          >
            <PlusIcon />
            Timeline
          </button>
        ))}
      {g && resumable(g) && (
        <button
          type="button"
          className="btn btn-xs"
          title="Checks the same request again. Does not start a new generation."
          onClick={() => void run("Resume", () => api.resume(film, g.id))}
        >
          Resume
        </button>
      )}
      {g?.status === "uncertain" && (
        <button
          type="button"
          className="btn btn-xs"
          title="Records this as failed. It does not cancel anything at the provider."
          onClick={() => void run("Mark as failed", () => api.markFailed(film, g.id))}
        >
          Mark as failed
        </button>
      )}
      <Popover label="More actions" trigger={<MoreIcon />} triggerClassName="btn btn-xs btn-icon-only" align="start">
        {(close) => (
          <div className="menu">
            {g?.status === "completed" && g.output && <TrimMenu key={g.id + JSON.stringify(g.trim)} generation={g} onDone={close} />}
            <button type="button" className="menu-item" aria-expanded={promptOpen} onClick={() => { onTogglePrompt(); close(); }}>
              {promptOpen ? "Hide" : "Show"} text that will be sent
            </button>
            {g && (
              <button type="button" className="menu-item" aria-expanded={detailsOpen} onClick={() => { onToggleDetails(); close(); }}>
                {detailsOpen ? "Hide details" : "Details"}
              </button>
            )}
            {g && (g.status === "completed" || g.status === "failed") && (
              <button
                type="button"
                className="menu-item menu-danger"
                onClick={() => {
                  close();
                  const msg = onTimeline
                    ? "Delete this clip? It will also be removed from the timeline. The source image is not affected."
                    : "Delete this clip? The source image is not affected.";
                  if (confirm(msg)) void run("Delete", () => api.deleteGeneration(film, g.id));
                }}
              >
                Delete variation
              </button>
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}

export function GeneratedPreview({ shot, v }: { shot: Shot; v: Variations }) {
  const { film, openLightbox } = useFilm();
  const { gens, current: g } = v;
  if (!g) {
    return (
      <figure className="media-cell">
        <div className="media-frame output-empty">
          <span className="muted small">No generations yet</span>
        </div>
      </figure>
    );
  }
  const completed = gens.filter((x) => x.status === "completed" && x.output);
  const openLarge = () =>
    openLightbox({
      items: completed.map((x) => ({
        kind: "video" as const,
        src: mediaUrl.generation(film, x.id),
        title: `${shot.filename} · variation ${gens.indexOf(x) + 1} of ${gens.length}`,
        range: effectiveTrim(x) ?? undefined,
        loop: true,
      })),
      index: Math.max(0, completed.findIndex((x) => x.id === g.id)),
    });
  return (
    <figure className="media-cell output-cell">
      {g.status === "completed" && g.output ? (
        <ClipPlayer key={g.id} film={film} generation={g} label={`variation ${v.index + 1} of ${gens.length}`} onEnlarge={openLarge} />
      ) : (
        <div className={`media-frame status-frame status-${g.status}`} role="status">
          <span className="status-label">{STATUS_TEXT[g.status]}</span>
          {g.status !== "failed" && g.status !== "uncertain" && <span className="progress" aria-hidden="true" />}
          {g.error && <span className="small status-error">{g.error.message}</span>}
        </div>
      )}
    </figure>
  );
}

export function GenerationDetails({ g }: { g: Generation }) {
  const model = getModel(g.modelKey);
  return (
    <div className="gen-details">
      <dl>
        <dt>Model</dt>
        <dd>{model?.label ?? g.modelKey}</dd>
        <dt>Requested</dt>
        <dd>
          {g.settings.durationSec}s · {g.settings.resolution} · seed {g.settings.seed ?? "random (chosen by provider)"}
        </dd>
        {g.output && (
          <>
            <dt>Actual clip</dt>
            <dd>
              {secs(g.output.durationSec)} · {g.output.width}×{g.output.height} · {g.output.hasAudio ? "has audio" : "no audio"}
              {usableDurationSec(g) < g.output.durationSec && ` · using the first ${secs(usableDurationSec(g))}, as requested`}
            </dd>
          </>
        )}
        <dt>Status</dt>
        <dd>{STATUS_TEXT[g.status]}</dd>
        {g.error && (
          <>
            <dt>Message</dt>
            <dd>{g.error.message}</dd>
          </>
        )}
        <dt>Created</dt>
        <dd>{when(g.createdAt)}</dd>
        {g.completedAt && (
          <>
            <dt>Finished</dt>
            <dd>{when(g.completedAt)}</dd>
          </>
        )}
        {g.requestId && (
          <>
            <dt>Request id</dt>
            <dd className="break">{g.requestId}</dd>
          </>
        )}
      </dl>
      <div>
        <h4>Submitted text</h4>
        <pre className="prompt-preview">{g.submittedPrompt}</pre>
        {g.expandedPrompt ? (
          <>
            <h4>Provider-expanded prompt</h4>
            <pre className="prompt-preview">{g.expandedPrompt}</pre>
          </>
        ) : (
          <p className="muted small">The provider may rewrite the text before generating; no rewritten version was reported for this clip.</p>
        )}
      </div>
    </div>
  );
}

/** How long the pointer must rest after scrubbing before the clip plays on from there. */
const RESUME_AFTER_SCRUB_MS = 350;

/**
 * Browsers pause a playing video that is unmuted before the page has had a
 * click or key press. Until then a hovered clip stays muted (and keeps playing).
 */
function soundAllowed(): boolean {
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return ua ? ua.hasBeenActive : true;
}

/**
 * Generated clip preview. It plays on its own, muted and looping inside the
 * trim, whenever it is on screen. Hovering adds sound and scrubs (the clip
 * plays on from where the pointer rests); clicking enlarges it; dragging
 * across it sets in/out; Space pauses or resumes.
 */
function ClipPlayer({ film, generation, label, onEnlarge }: { film: string; generation: Generation; label: string; onEnlarge: () => void }) {
  const { run } = useFilm();
  const video = useRef<HTMLVideoElement>(null);
  const output = generation.output!;
  /** The requested length; any extra tail the provider returned is ignored. */
  const dur = usableDurationSec(generation);
  const trim = effectiveTrim(generation)!;
  // Near-16:9 clips (e.g. 1364×768) fill the frame instead of showing hairline bars; others are letterboxed.
  const fill = Math.abs(output.width / output.height / (16 / 9) - 1) < 0.03;
  const trimRef = useRef(trim);
  trimRef.current = trim;
  const [userPaused, setUserPaused] = useState(false);
  const [unplayable, setUnplayable] = useState(false);
  const [pending, setPending] = useState<Trim | null>(null);
  const [time, setTime] = useState(trim.inSec);
  /** The pointer is over the clip: show the playhead on the bar. */
  const [over, setOver] = useState(false);
  const drag = useRef<{ startX: number; startT: number; moved: boolean } | null>(null);
  // Inputs to sync(); refs so event handlers and observers always see the latest.
  const hovered = useRef(false);
  const visible = useRef(false);
  const paused = useRef(false);
  const scrubbing = useRef(false);
  const resumeTimer = useRef<number | undefined>(undefined);
  const shown = pending ?? trim;
  const trimmed = generation.trim !== null || pending !== null;

  const timeAt = (clientX: number) => {
    const rect = video.current!.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * dur;
  };

  /** Applies the rules: sound only while hovered; play while visible, unless paused, scrubbing or dragging. */
  function sync() {
    const v = video.current;
    if (!v) return;
    const muted = !(hovered.current && soundAllowed());
    if (v.muted !== muted) v.muted = muted;
    const shouldPlay = visible.current && !paused.current && !scrubbing.current && !drag.current && !document.hidden;
    if (shouldPlay && v.paused) {
      const t = trimRef.current;
      if (v.currentTime < t.inSec || v.currentTime >= t.outSec - 0.05) v.currentTime = t.inSec;
      v.play().catch(() => {
        // Refused with sound: fall back to silent playback. Refused silently: the clip can't play here.
        if (!v.muted) {
          v.muted = true;
          void v.play().catch(() => undefined);
        }
      });
    } else if (!shouldPlay && !v.paused) {
      v.pause();
    }
  }

  function setPaused(p: boolean) {
    paused.current = p;
    setUserPaused(p);
    sync();
  }

  function enlarge() {
    // The enlarged view has its own sound; silence this preview behind it.
    hovered.current = false;
    setOver(false);
    scrubbing.current = false;
    window.clearTimeout(resumeTimer.current);
    sync();
    onEnlarge();
  }

  // Play only while on screen (and the tab is visible), so long films stay light.
  useEffect(() => {
    const v = video.current!;
    const io = new IntersectionObserver(
      ([entry]) => {
        visible.current = !!entry?.isIntersecting;
        sync();
      },
      { threshold: 0.01 },
    );
    io.observe(v);
    const stopLoop = loopWithinRange(v, () => trimRef.current);
    const onVisibility = () => sync();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      io.disconnect();
      stopLoop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearTimeout(resumeTimer.current);
    };
    // sync() reads only refs, so the first instance stays correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Space pauses or resumes while the pointer is over this clip (never while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hovered.current || e.key !== " " || isTypingTarget(e.target) || e.target === video.current) return;
      e.preventDefault();
      setPaused(!paused.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function commitTrim(t: Trim | null) {
    setPending(t);
    void run("Trim", () => api.setTrim(film, generation.id, t)).then(() => setPending(null));
  }

  const pct = (n: number) => `${(Math.min(Math.max(n, 0), dur) / dur) * 100}%`;
  return (
    <div className="clip-player">
      <div
        className="media-frame video-frame"
        onPointerEnter={(e) => {
          if (e.pointerType !== "mouse") return;
          hovered.current = true;
          setOver(true);
          sync();
        }}
        onPointerLeave={() => {
          hovered.current = false;
          setOver(false);
          scrubbing.current = false;
          window.clearTimeout(resumeTimer.current);
          sync();
        }}
      >
        <video
          ref={video}
          src={mediaUrl.generation(film, generation.id)}
          className={fill ? "fill" : undefined}
          muted
          loop
          playsInline
          preload="metadata"
          tabIndex={0}
          aria-label={`Generated clip, ${label}. ${userPaused ? "Paused" : "Plays on a silent loop; hover for sound"}. Press Enter to enlarge, Space to pause or resume. Drag across the clip to set in and out points; exact trim times are under More actions.`}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              enlarge();
            } else if (e.key === " ") {
              e.preventDefault();
              setPaused(!paused.current);
            }
          }}
          onError={() => setUnplayable(true)}
          onLoadedMetadata={(e) => {
            e.currentTarget.currentTime = trimRef.current.inSec;
            sync();
          }}
          onLoadedData={() => setUnplayable(false)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setTime(v.currentTime);
            const t = trimRef.current;
            // Loop inside the trim (the native loop covers untrimmed clips).
            if (!v.paused && (v.currentTime >= t.outSec || v.currentTime < t.inSec - 0.1)) v.currentTime = t.inSec;
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            window.clearTimeout(resumeTimer.current);
            drag.current = { startX: e.clientX, startT: timeAt(e.clientX), moved: false };
          }}
          onPointerMove={(e) => {
            const v = video.current!;
            const t = timeAt(e.clientX);
            if (drag.current) {
              if (Math.abs(e.clientX - drag.current.startX) > 4) drag.current.moved = true;
              if (drag.current.moved) {
                const a = drag.current.startT;
                setPending({ inSec: Math.min(a, t), outSec: Math.max(a, t) });
                if (!v.paused) v.pause();
                v.currentTime = t;
              }
              return;
            }
            if (e.pointerType !== "mouse") return;
            // Hover scrub: show the frame under the pointer, then play on from there once it rests.
            scrubbing.current = true;
            if (!v.paused) v.pause();
            v.currentTime = t;
            setTime(t);
            window.clearTimeout(resumeTimer.current);
            resumeTimer.current = window.setTimeout(() => {
              scrubbing.current = false;
              sync();
            }, RESUME_AFTER_SCRUB_MS);
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            if (!d) return;
            if (!d.moved) {
              enlarge();
              return;
            }
            const t = timeAt(e.clientX);
            const inSec = Math.min(d.startT, t);
            const outSec = Math.max(d.startT, t);
            if (outSec - inSec < 0.1) setPending(null);
            else commitTrim({ inSec: round(inSec), outSec: round(Math.min(outSec, dur)) });
            sync();
          }}
          onPointerCancel={() => {
            drag.current = null;
            setPending(null);
            sync();
          }}
        />
        {unplayable && (
          <p className="unplayable small" role="note">
            This browser can't play this clip (H.264 MP4). Use Chrome, Edge or Firefox. Trimming by dragging still works.
          </p>
        )}
        {userPaused && (
          <span className="paused-badge" aria-hidden="true">
            Paused
          </span>
        )}
        <button type="button" className="enlarge" aria-label="Enlarge clip" title="Enlarge" onClick={enlarge}>
          <ExpandIcon />
        </button>
      </div>

      {/* Green over the part that plays (all of it unless trimmed); the playhead shows while the pointer is over the clip. */}
      <div className={`scrub-line${trimmed ? " is-trimmed" : ""}`} aria-hidden="true">
        <span className="trim-range" style={{ left: pct(shown.inSec), width: `${((shown.outSec - shown.inSec) / dur) * 100}%` }} />
        {(over || pending !== null) && <span className="playhead" style={{ left: pct(time) }} />}
      </div>
      <div className="timecodes tabular" aria-hidden="true">
        <span>{shortClock(Math.min(time, dur))}</span>
        {trimmed && (
          <span className="trim-label" title="Trimmed range">
            {shortClock(shown.inSec)}–{shortClock(shown.outSec)} · {secs(shown.outSec - shown.inSec)}
          </span>
        )}
        <span>{shortClock(dur)}</span>
      </div>
    </div>
  );
}

/** Exact in/out entry, inside the "More actions" menu. */
function TrimMenu({ generation, onDone }: { generation: Generation; onDone: () => void }) {
  const { film, run } = useFilm();
  const duration = usableDurationSec(generation);
  const trim = effectiveTrim(generation)!;
  const [inText, setIn] = useState(trim.inSec.toFixed(2));
  const [outText, setOut] = useState(trim.outSec.toFixed(2));
  const [error, setError] = useState<string | null>(null);

  function apply(t: Trim | null) {
    void run("Trim", () => api.setTrim(film, generation.id, t)).then((v) => v && onDone());
  }
  function commit() {
    const a = Number(inText);
    const b = Number(outText);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a || b > duration + 0.001) {
      setError(`Use 0 ≤ in < out ≤ ${duration.toFixed(2)}`);
      return;
    }
    setError(null);
    apply({ inSec: a, outSec: Math.min(b, duration) });
  }

  return (
    <form
      className="trim-menu"
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      <div className="menu-title">Trim · clip is {secs(duration)}</div>
      <div className="trim-inputs">
        <label>
          In
          <input type="number" step="0.1" min={0} max={duration} value={inText} onChange={(e) => setIn(e.target.value)} />
        </label>
        <label>
          Out
          <input type="number" step="0.1" min={0} max={duration} value={outText} onChange={(e) => setOut(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-xs">
          Set
        </button>
      </div>
      {error && (
        <div className="field-error small" role="alert">
          {error}
        </div>
      )}
      {generation.trim !== null && (
        <button type="button" className="menu-item" onClick={() => apply(null)}>
          Use full clip
        </button>
      )}
    </form>
  );
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}
