import { useEffect, useRef, useState } from "react";
import { BEATS_CHOICES, activeBeatSync, availableFromIn, beatGrid, fitsSlot, planBeatCuts } from "../../shared/beats";
import { VIDEO_FPS, clipDuration, effectiveTrim, findGeneration, type AspectRatio, type BeatSync } from "../../shared/domain";
import { api, mediaUrl, messageOf } from "../lib/api";
import { useFilm } from "../lib/filmContext";
import { secs } from "../lib/format";
import { BeatControls, BeatStrip, useBeatAnalysis } from "./BeatSync";
import { ExportIcon, MusicIcon, PlayIcon } from "./icons";

export function Timeline() {
  const { film, view, run, notify, openLightbox } = useFilm();
  const { timeline, soundtrack, aspectRatio } = view.state;
  const [dragId, setDragId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const render = view.render;
  const busy = starting || render?.state === "running";

  const clips = timeline.map((c) => ({ clip: c, found: findGeneration(view.state, c.generationId) }));

  // Cut to beat: the same plan the renderer uses (shared/beats.ts).
  const sync = activeBeatSync(view.state);
  const beats = useBeatAnalysis(film, soundtrack?.filename ?? null, sync !== null);
  const plan = (() => {
    if (!sync || beats.status !== "ready") return null;
    const grid = beatGrid(beats.analysis, sync);
    if (grid.times.length < 2 && sync.bpm === null) return null;
    return planBeatCuts(grid, sync, timeline, VIDEO_FPS);
  })();
  const cutFor = new Map(plan?.cuts.map((c) => [c.clipId, c]));
  const tooShortIds = new Set(
    clips.filter(({ clip, found }) => found && cutFor.has(clip.id) && !fitsSlot(found.generation, cutFor.get(clip.id)!.frames / VIDEO_FPS, VIDEO_FPS)).map(({ clip }) => clip.id),
  );
  const total = plan ? plan.totalSec : clips.reduce((sum, { found }) => sum + (found ? clipDuration(found.generation) : 0), 0);
  const saveBeatSync = async (label: string, next: BeatSync | null) => {
    await run(label, () => api.setBeatSync(film, next));
  };

  // Open a preview this tab asked for as soon as it finishes.
  const awaitingPreview = useRef<string | null>(null);
  useEffect(() => {
    if (render && render.id === awaitingPreview.current && render.state !== "running") {
      awaitingPreview.current = null;
      if (render.state === "done" && render.output) {
        openLightbox({ items: [{ kind: "video", src: render.output.url, title: "Preview" }], index: 0 });
      }
    }
  }, [render, openLightbox]);

  function reorder(ids: string[]) {
    void run("Reorder timeline", () => api.reorderClips(film, ids));
  }
  function move(id: string, delta: number) {
    const ids = timeline.map((c) => c.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder(ids);
  }
  async function startRender(kind: "preview" | "export") {
    setStarting(true);
    try {
      const status = await api.render(film, kind);
      if (kind === "preview") awaitingPreview.current = status.id;
    } catch (err) {
      notify(`${kind === "preview" ? "Preview" : "Export"} not started: ${messageOf(err)}`);
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="timeline-bar">
        <h2>Timeline</h2>
        <span className="tabular muted timeline-meta" aria-label={`${timeline.length} clips, total length ${secs(total)}`}>
          {timeline.length} clip{timeline.length === 1 ? "" : "s"} · {tileClock(total)}
          {plan && ` · ${plan.grid.bpm} BPM`}
        </span>
        <RenderLine film={film} notify={notify} />
        <div className="timeline-actions">
          <select
            aria-label="Frame"
            title="Export frame (center-cropped)"
            className="select-sm"
            value={aspectRatio}
            onChange={(e) => void run("Aspect ratio", () => api.setAspect(film, e.target.value as AspectRatio))}
          >
            <option value="16:9">16:9</option>
            <option value="1:1">1:1</option>
            <option value="9:16">9:16</option>
          </select>
          <button type="button" className="btn btn-sm" disabled={busy || timeline.length === 0} onClick={() => void startRender("preview")}>
            <PlayIcon />
            Preview
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || timeline.length === 0} onClick={() => void startRender("export")}>
            <ExportIcon />
            Export
          </button>
        </div>
      </div>

      {timeline.length === 0 ? (
        <p className="muted timeline-empty small">
          Use “+ Timeline” on a finished clip. Clips play in this order; drag them, or use the arrows that appear on hover, to rearrange.
        </p>
      ) : (
        <ol className="clips" aria-label="Clips in order">
          {clips.map(({ clip, found }, i) => {
            const g = found?.generation;
            const cut = cutFor.get(clip.id);
            const d = cut ? cut.frames / VIDEO_FPS : g ? clipDuration(g) : 0;
            const baseTrim = g ? effectiveTrim(g) : null;
            // In beat mode a clip plays from its in-point for its beat slot.
            const trim = baseTrim && cut ? { inSec: baseTrim.inSec, outSec: baseTrim.inSec + d } : baseTrim;
            const tooShort = tooShortIds.has(clip.id);
            const label = found ? found.shot.filename : "Missing clip";
            const short = found ? label.replace(/\.[^.]+$/, "") : label;
            return (
              <li
                key={clip.id}
                className={`clip${dragId === clip.id ? " dragging" : ""}${clip.muted ? " muted-clip" : ""}${tooShort ? " clip-short" : ""}`}
                draggable
                onDragStart={(e) => {
                  setDragId(clip.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => dragId && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!dragId || dragId === clip.id) return;
                  const ids = timeline.map((c) => c.id).filter((x) => x !== dragId);
                  ids.splice(ids.indexOf(clip.id), 0, dragId);
                  setDragId(null);
                  reorder(ids);
                }}
              >
                <button
                  type="button"
                  className="clip-thumb"
                  aria-label={`Play clip ${i + 1}, ${label}`}
                  disabled={!g}
                  onClick={() =>
                    g &&
                    openLightbox({
                      items: [{ kind: "video", src: mediaUrl.generation(film, g.id), title: `Clip ${i + 1} · ${label}`, range: trim ?? undefined, loop: true }],
                      index: 0,
                    })
                  }
                >
                  {g && <video src={`${mediaUrl.generation(film, g.id)}#t=${trim?.inSec ?? 0}`} muted preload="metadata" tabIndex={-1} />}
                  {clip.muted && <span className="clip-badge">Muted</span>}
                  {tooShort && <span className="clip-badge clip-badge-warn">Too short</span>}
                </button>
                <div className="clip-tools">
                  <button type="button" className="tool-btn" aria-label={`Move clip ${i + 1} earlier`} title="Move earlier" disabled={i === 0} onClick={() => move(clip.id, -1)}>
                    ←
                  </button>
                  <button
                    type="button"
                    className="tool-btn"
                    aria-label={`Move clip ${i + 1} later`}
                    title="Move later"
                    disabled={i === timeline.length - 1}
                    onClick={() => move(clip.id, 1)}
                  >
                    →
                  </button>
                  <button
                    type="button"
                    className={`tool-btn mute-toggle${clip.muted ? " is-muted" : ""}`}
                    aria-pressed={clip.muted}
                    aria-label={`Mute clip ${i + 1} audio`}
                    title={g && !g.output?.hasAudio ? "This clip has no audio of its own" : clip.muted ? "Clip audio muted" : "Mute clip audio"}
                    onClick={() => void run("Mute", () => api.muteClip(film, clip.id, !clip.muted))}
                  >
                    ♪
                  </button>
                  <button type="button" className="tool-btn" aria-label={`Remove clip ${i + 1} from timeline`} title="Remove from timeline" onClick={() => void run("Remove", () => api.removeClip(film, clip.id))}>
                    ×
                  </button>
                </div>
                <div className="clip-meta">
                  <span className="clip-name" title={label}>
                    <span className="clip-num tabular">{String(i + 1).padStart(2, "0")}</span> {short}
                  </span>
                  {cut && sync ? (
                    <span
                      className="clip-dur clip-beats tabular"
                      title={
                        tooShort && g
                          ? `This clip has ${availableFromIn(g).toFixed(1)}s of video from its in-point, but ${cut.beats} beats need ${d.toFixed(1)}s. Choose fewer beats or move its in-point earlier.`
                          : `Plays ${d.toFixed(1)}s from its in-point`
                      }
                    >
                      <select
                        className="beats-select"
                        aria-label={`Beats for clip ${i + 1}`}
                        value={clip.beats ?? ""}
                        onChange={(e) => void run("Clip beats", () => api.setClipBeats(film, clip.id, e.target.value === "" ? null : Number(e.target.value)))}
                      >
                        <option value="">{sync.beatsPerClip} beat{sync.beatsPerClip === 1 ? "" : "s"}</option>
                        {BEATS_CHOICES.map((n) => (
                          <option key={n} value={n}>
                            {n} beat{n === 1 ? "" : "s"}
                          </option>
                        ))}
                      </select>
                      · {tileClock(d)}
                    </span>
                  ) : (
                    <span className="tabular muted clip-dur">{tileClock(d)}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {plan && timeline.length > 0 && <BeatStrip plan={plan} short={tooShortIds} />}

      <div className="soundtrack-bar">
        <MusicIcon />
        <label className="inline-field">
          <span className="visually-hidden">Soundtrack</span>
          <select
            className="select-bare"
            value={soundtrack?.filename ?? ""}
            onChange={(e) => void run("Soundtrack", () => api.setSoundtrack(film, e.target.value || null, 0))}
          >
            <option value="">{view.audioFiles.length ? "+ Soundtrack (none: clip audio only)" : "No audio files in the film folder"}</option>
            {soundtrack && !view.audioFiles.includes(soundtrack.filename) && (
              <option value={soundtrack.filename}>{soundtrack.filename} (missing)</option>
            )}
            {view.audioFiles.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        {soundtrack && !sync && (
          <OffsetField
            key={`${soundtrack.filename}-${soundtrack.offsetSec}`}
            value={soundtrack.offsetSec}
            onCommit={(n) => void run("Soundtrack start", () => api.setSoundtrack(film, soundtrack.filename, n))}
          />
        )}
        {soundtrack && <BeatControls film={film} soundtrack={soundtrack} sync={view.state.beatSync} beats={beats} save={saveBeatSync} />}
      </div>
    </section>
  );
}

/** 00:06 for whole seconds, 00:02.5 otherwise. */
function tileClock(n: number): string {
  const whole = Math.abs(n - Math.round(n)) < 0.05;
  const v = whole ? Math.round(n) : Math.round(n * 10) / 10;
  const m = Math.floor(v / 60);
  const s = v - m * 60;
  return `${String(m).padStart(2, "0")}:${whole ? String(Math.round(s)).padStart(2, "0") : s.toFixed(1).padStart(4, "0")}`;
}

function OffsetField({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n) && n >= 0 && n !== value) onCommit(n);
    else setText(String(value));
  };
  return (
    <label className="inline-field small">
      starts at
      <input
        type="number"
        min={0}
        step={0.5}
        value={text}
        className="offset-input"
        aria-label="Soundtrack start offset in seconds"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      s
    </label>
  );
}

function RenderLine({ film, notify }: { film: string; notify: (m: string) => void }) {
  const { view, openLightbox } = useFilm();
  const r = view.render;
  if (!r) return null;
  if (r.state === "running") {
    return (
      <p className="render-line" role="status" aria-busy="true">
        <span className="progress inline" aria-hidden="true" /> {r.kind === "preview" ? "Rendering preview" : "Exporting"}: {r.step}
      </p>
    );
  }
  if (r.state === "failed") {
    return (
      <p className="render-line field-error" role="alert">
        {r.kind === "preview" ? "Preview" : "Export"} failed: {r.error}
      </p>
    );
  }
  if (!r.output) return null;
  const o = r.output;
  return (
    <p className="render-line" role="status">
      {r.kind === "export" ? "Exported" : "Preview ready"}: {o.filename} · {secs(o.durationSec)} · {o.width}×{o.height}
      {o.hasAudio ? "" : " · no audio"}{" "}
      <button type="button" className="link-btn" onClick={() => openLightbox({ items: [{ kind: "video", src: o.url, title: o.filename }], index: 0 })}>
        Watch
      </button>
      {r.kind === "export" && (
        <>
          {" · "}
          <button type="button" className="link-btn" onClick={() => api.openFolder(film, "exports").catch((e) => notify(messageOf(e)))}>
            Open exports folder
          </button>
        </>
      )}
    </p>
  );
}
