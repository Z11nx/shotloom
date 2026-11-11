/**
 * Cut-to-beat controls (in the soundtrack bar) and the beat map under the
 * clips. All cut math lives in shared/beats.ts, shared with the renderer.
 */
import { useEffect, useState } from "react";
import { BEATS_CHOICES, LOW_CONFIDENCE, TEMPO_SCALES, beatGrid, beatTime, defaultBeatSync, type BeatAnalysis, type BeatPlan } from "../../shared/beats";
import type { BeatSync, Soundtrack } from "../../shared/domain";
import { api, messageOf } from "../lib/api";
import { ChevronLeft, ChevronRight } from "./icons";

export type BeatsState = { status: "idle" } | { status: "loading" } | { status: "ready"; analysis: BeatAnalysis } | { status: "error"; message: string };

/** Loads the soundtrack's beat analysis while cut-to-beat is on (analyzed once on the server, then cached). */
export function useBeatAnalysis(film: string, filename: string | null, wanted: boolean): BeatsState {
  const [state, setState] = useState<BeatsState>({ status: "idle" });
  useEffect(() => {
    if (!wanted || !filename) {
      setState({ status: "idle" });
      return;
    }
    let alive = true;
    setState({ status: "loading" });
    api
      .beats(film)
      .then((analysis) => alive && setState({ status: "ready", analysis }))
      .catch((err) => alive && setState({ status: "error", message: messageOf(err) }));
    return () => {
      alive = false;
    };
  }, [film, filename, wanted]);
  return state;
}

const clock = (n: number) => {
  const m = Math.floor(n / 60);
  return `${m}:${(n - m * 60).toFixed(1).padStart(4, "0")}`;
};

export function BeatControls({
  film,
  soundtrack,
  sync,
  beats,
  save,
}: {
  film: string;
  soundtrack: Soundtrack;
  sync: BeatSync | null;
  beats: BeatsState;
  save: (label: string, next: BeatSync | null) => Promise<void>;
}) {
  // Shows the click right away; the saved state takes over when the server answers.
  const [pending, setPending] = useState<boolean | null>(null);
  const on = pending ?? sync?.enabled ?? false;

  async function toggle(next: boolean) {
    const base = sync ?? defaultBeatSync();
    setPending(next);
    if (!next) {
      try {
        return await save("Cut to beat", { ...base, enabled: false });
      } finally {
        setPending(null);
      }
    }
    try {
      // Start on the first beat at or after the current soundtrack start, so turning it on keeps the film where it was.
      const analysis = beats.status === "ready" ? beats.analysis : await api.beats(film);
      const times = beatGrid(analysis, base).times;
      const first = times.findIndex((t) => t >= soundtrack.offsetSec - 0.05);
      await save("Cut to beat", { ...base, enabled: true, startBeat: Math.max(0, first) });
    } catch {
      await save("Cut to beat", { ...base, enabled: true }); // the bar shows why beats are unavailable
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <span className="bar-sep" aria-hidden="true" />
      <label className="inline-field small beat-toggle">
        <input type="checkbox" checked={on} disabled={pending !== null} onChange={(e) => void toggle(e.target.checked)} />
        Cut to beat
      </label>
      {pending === true && !sync?.enabled && (
        <span className="inline-field small" role="status">
          <span className="progress inline" aria-hidden="true" /> Finding beats…
        </span>
      )}
      {on && sync?.enabled && <BeatSettings sync={sync} beats={beats} save={save} />}
    </>
  );
}

function BeatSettings({ sync, beats, save }: { sync: BeatSync; beats: BeatsState; save: (label: string, next: BeatSync) => Promise<void> }) {
  if (beats.status === "loading" || beats.status === "idle") {
    return (
      <span className="inline-field small" role="status">
        <span className="progress inline" aria-hidden="true" /> Finding beats…
      </span>
    );
  }
  if (beats.status === "error") {
    return (
      <span className="small field-error" role="alert">
        {beats.message}
      </span>
    );
  }
  const a = beats.analysis;
  const grid = beatGrid(a, sync);
  const set = (label: string, patch: Partial<BeatSync>) => void save(label, { ...sync, ...patch });
  const scaleIndex = TEMPO_SCALES.indexOf(sync.scale);
  const changeTempo = (factor: 0.5 | 2) => {
    if (sync.bpm !== null) {
      const bpm = Math.round(sync.bpm * factor * 10) / 10;
      if (bpm >= 30 && bpm <= 300) set("Tempo", { bpm, startBeat: Math.round(sync.startBeat * factor) });
    } else {
      const next = TEMPO_SCALES[scaleIndex + (factor === 2 ? 1 : -1)];
      if (next !== undefined) set("Tempo", { scale: next, startBeat: Math.round(sync.startBeat * factor) });
    }
  };
  const custom = sync.bpm !== null || sync.scale !== 1 || sync.nudgeSec !== 0;
  const lastStart = Math.max(0, grid.times.length - 1);
  const startAt = beatTime(grid, Math.min(sync.startBeat, lastStart));

  return (
    <>
      {a.beats.length < 2 && sync.bpm === null ? (
        <span className="chip chip-warn">No beats found in this song. Type its tempo.</span>
      ) : (
        a.confidence < LOW_CONFIDENCE && <span className="chip chip-warn" title="The beat is hard to hear in this song. If cuts feel off, type its tempo or nudge the grid.">Beats unclear</span>
      )}
      <div className="variation-nav" role="group" aria-label="Tempo">
        <button type="button" className="nav-btn" aria-label="Half tempo" title="Half tempo (count every other beat)" onClick={() => changeTempo(0.5)}>
          ½
        </button>
        <NumberField
          key={`bpm-${grid.bpm}`}
          value={grid.bpm}
          min={30}
          max={300}
          step={0.1}
          className="bpm-input tabular"
          label="Tempo in beats per minute"
          title={`Detected ${a.bpm} BPM. Type a tempo to override it.`}
          onCommit={(bpm) => set("Tempo", { bpm })}
        />
        <span className="bpm-unit">BPM</span>
        <button type="button" className="nav-btn" aria-label="Double tempo" title="Double tempo (count half-beats)" onClick={() => changeTempo(2)}>
          ×2
        </button>
      </div>
      <label className="inline-field small">
        each clip
        <select
          className="select-sm select-beats"
          aria-label="Beats per clip"
          value={sync.beatsPerClip}
          onChange={(e) => set("Beats per clip", { beatsPerClip: Number(e.target.value) })}
        >
          {withCurrent(BEATS_CHOICES, sync.beatsPerClip).map((n) => (
            <option key={n} value={n}>
              {n} beat{n === 1 ? "" : "s"}
            </option>
          ))}
        </select>
      </label>
      <span className="inline-field small">
        starts on beat
        <span className="variation-nav" role="group" aria-label="Start beat">
          <button type="button" className="nav-btn" aria-label="Start one beat earlier" disabled={sync.startBeat === 0} onClick={() => set("Start beat", { startBeat: sync.startBeat - 1 })}>
            <ChevronLeft />
          </button>
          <span className="tabular" aria-live="polite" title={`The film starts ${clock(startAt)} into the song`}>
            {sync.startBeat + 1} · {clock(startAt)}
          </span>
          <button type="button" className="nav-btn" aria-label="Start one beat later" disabled={sync.startBeat >= lastStart} onClick={() => set("Start beat", { startBeat: sync.startBeat + 1 })}>
            <ChevronRight />
          </button>
        </span>
      </span>
      <label className="inline-field small" title="Shift every cut slightly if they feel early (+) or late (−)">
        nudge
        <NumberField key={`nudge-${sync.nudgeSec}`} value={sync.nudgeSec} min={-0.5} max={0.5} step={0.01} className="offset-input" label="Nudge the beat grid in seconds" onCommit={(nudgeSec) => set("Nudge", { nudgeSec })} />
        s
      </label>
      {custom && (
        <button type="button" className="link-btn" onClick={() => set("Tempo", { bpm: null, scale: 1, nudgeSec: 0, startBeat: 0 })}>
          Use detected beats
        </button>
      )}
    </>
  );
}

function withCurrent(choices: readonly number[], current: number): number[] {
  return choices.includes(current) ? [...choices] : [...choices, current].sort((x, y) => x - y);
}

function NumberField({
  value,
  min,
  max,
  step,
  className,
  label,
  title,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  className: string;
  label: string;
  title?: string;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const commit = () => {
    const n = Number(text);
    if (text.trim() !== "" && Number.isFinite(n) && n >= min && n <= max && n !== value) onCommit(n);
    else setText(String(value));
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      className={className}
      aria-label={label}
      title={title}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

/** Slim map under the clips: one segment per clip, beat ticks (taller = louder), cuts on beats. */
export function BeatStrip({ plan, short }: { plan: BeatPlan; short: Set<string> }) {
  const total = plan.totalSec;
  if (total <= 0) return null;
  const pct = (sec: number) => `${(sec / total) * 100}%`;
  const ticks: { at: number; energy: number }[] = [];
  const first = plan.cuts[0]?.startBeat ?? 0;
  const last = plan.cuts.length ? plan.cuts[plan.cuts.length - 1]!.startBeat + plan.cuts[plan.cuts.length - 1]!.beats : first;
  for (let k = first; k <= last; k++) {
    ticks.push({ at: beatTime(plan.grid, k) - plan.offsetSec, energy: plan.grid.energy[k] ?? 0.3 });
  }
  return (
    <div className="beat-strip" aria-hidden="true">
      {plan.cuts.map((c, i) => (
        <span
          key={c.clipId}
          className={`beat-seg${i % 2 ? " alt" : ""}${short.has(c.clipId) ? " is-short" : ""}`}
          style={{ left: pct(c.startSec), width: pct(c.endSec - c.startSec) }}
          title={`Clip ${i + 1} · ${c.beats} beat${c.beats === 1 ? "" : "s"} · ${(c.endSec - c.startSec).toFixed(1)}s`}
        >
          <span className="beat-seg-num tabular">{String(i + 1).padStart(2, "0")}</span>
        </span>
      ))}
      {ticks.map((t, i) => (
        <span key={i} className="beat-tick" style={{ left: pct(Math.min(total, Math.max(0, t.at))), height: `${30 + 70 * t.energy}%` }} />
      ))}
    </div>
  );
}
