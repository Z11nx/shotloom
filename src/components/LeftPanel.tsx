import { useEffect, useState } from "react";
import type { PromptBlock } from "../../shared/domain";
import { api, messageOf } from "../lib/api";
import { blockGroup, blockKey, useDraft } from "../lib/drafts";
import { useFilm } from "../lib/filmContext";
import { ImportIcon, PlusIcon } from "./icons";
import { Popover } from "./Popover";

export function LeftPanel() {
  return (
    <aside className="left-panel" aria-label="Generation settings and prompt blocks">
      <GenerationSettingsPanel />
      <PromptBlocks />
    </aside>
  );
}

function GenerationSettingsPanel() {
  const { status, settingsDraft: draft, setSettingsDraft, parsedSettings } = useFilm();
  const model = status?.activeModel;
  if (!model || !parsedSettings) return null;
  const d = model.duration;
  const { errors } = parsedSettings;

  return (
    <section className="panel-section">
      <h2 title={model.label}>Generation</h2>
      <div className="field-pair">
        <div className="field">
          <label htmlFor="set-duration">Duration</label>
          <div className={`input-suffix${errors.duration ? " invalid" : ""}`}>
            <input
              id="set-duration"
              type="number"
              inputMode="numeric"
              min={d.min}
              max={d.max}
              step={d.step}
              value={draft.durationText}
              title={`${d.min}–${d.max} seconds`}
              aria-invalid={errors.duration !== null}
              aria-describedby="duration-help"
              onChange={(e) => setSettingsDraft({ ...draft, durationText: e.target.value })}
            />
            <span aria-hidden="true">s</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="set-resolution">Resolution</label>
          <select
            id="set-resolution"
            value={draft.resolution}
            aria-invalid={errors.resolution !== null}
            onChange={(e) => setSettingsDraft({ ...draft, resolution: e.target.value })}
          >
            {!model.resolutions.some((r) => r.value === draft.resolution) && (
              <option value={draft.resolution}>{draft.resolution} (not available)</option>
            )}
            {model.resolutions.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div id="duration-help" className={errors.duration ? "field-error small" : "visually-hidden"} role={errors.duration ? "alert" : undefined}>
        {errors.duration ?? `${d.min}–${d.max} seconds`}
      </div>
      {errors.resolution && <div className="field-error small">{errors.resolution}</div>}

      {model.seed.supported && (
        <div className="field">
          <label htmlFor="set-seed">Seed</label>
          <input
            id="set-seed"
            type="number"
            inputMode="numeric"
            placeholder="Random"
            value={draft.seedText}
            title="Used by Gen 1; leave blank for random. Gen 4 picks four random seeds."
            aria-invalid={errors.seed !== null}
            aria-describedby="seed-help"
            onChange={(e) => setSettingsDraft({ ...draft, seedText: e.target.value })}
          />
          <div id="seed-help" className={errors.seed ? "field-error small" : "visually-hidden"} role={errors.seed ? "alert" : undefined}>
            {errors.seed ?? "Used by Gen 1; leave blank for random. Gen 4 picks four random seeds."}
          </div>
        </div>
      )}
    </section>
  );
}

function PromptBlocks() {
  const { film, view, films, run } = useFilm();
  const blocks = view.state.promptBlocks;
  const [importFrom, setImportFrom] = useState("");
  const others = films.filter((f) => f !== film);
  const [dragId, setDragId] = useState<string | null>(null);

  function move(id: string, delta: number) {
    const ids = blocks.map((b) => b.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void run("Reorder blocks", () => api.reorderBlocks(film, ids));
  }

  function dropOn(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const ids = blocks.map((b) => b.id).filter((x) => x !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    setDragId(null);
    void run("Reorder blocks", () => api.reorderBlocks(film, ids));
  }

  return (
    <section className="panel-section">
      <div className="section-head">
        <h2 title="Enabled prompts are added, in this order, before every shot's description in this film.">Shared prompts</h2>
        {others.length > 0 && (
          <Popover
            label="Import prompts from another film"
            align="end"
            triggerClassName="btn btn-xs btn-quiet"
            trigger={
              <>
                <ImportIcon />
                Import
              </>
            }
          >
            {(close) => (
              <form
                className="import-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!importFrom) return;
                  void run("Import blocks", () => api.importBlocks(film, importFrom)).then(close);
                }}
              >
                <label htmlFor="import-from" className="small">
                  Copy prompts from
                </label>
                <select id="import-from" value={importFrom} onChange={(e) => setImportFrom(e.target.value)}>
                  <option value="">Choose film…</option>
                  {others.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <button type="submit" className="btn btn-sm" disabled={!importFrom}>
                  Copy
                </button>
              </form>
            )}
          </Popover>
        )}
      </div>
      {blocks.length === 0 && <p className="muted small">No shared prompts yet.</p>}
      <ol className="blocks">
        {blocks.map((b, i) => (
          <li
            key={b.id}
            className={`block${b.enabled ? "" : " block-off"}${dragId === b.id ? " dragging" : ""}`}
            draggable
            onDragStart={(e) => {
              if ((e.target as HTMLElement).closest("textarea, button, input")) return e.preventDefault();
              setDragId(b.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => dragId && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              dropOn(b.id);
            }}
          >
            <BlockEditor block={b} index={i} count={blocks.length} onMove={move} />
          </li>
        ))}
      </ol>
      <button type="button" className="btn btn-block btn-add" onClick={() => void run("Add block", () => api.addBlock(film, ""))}>
        <PlusIcon />
        Add prompt
      </button>
    </section>
  );
}

function BlockEditor({
  block,
  index,
  count,
  onMove,
}: {
  block: PromptBlock;
  index: number;
  count: number;
  onMove: (id: string, delta: number) => void;
}) {
  const { film, run, applyView, nextSeq, notify } = useFilm();
  const draft = useDraft(
    blockKey(film, block.id),
    block.text,
    async (text) => {
      const token = nextSeq();
      applyView(await api.updateBlock(film, block.id, { text }), token);
    },
    { group: blockGroup(film), onLostSave: (m) => notify(`A prompt block edit could not be saved: ${m}`) },
  );
  const n = index + 1;
  // Optimistic toggle: show the new state immediately, fall back if saving fails.
  const [enabled, setEnabled] = useState(block.enabled);
  useEffect(() => setEnabled(block.enabled), [block.enabled]);
  return (
    <>
      <div className="block-row">
        <label className="block-check" title={enabled ? "Used in every shot (click to turn off)" : "Not used (click to turn on)"}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              const next = e.target.checked;
              setEnabled(next);
              void run("Toggle block", () => api.updateBlock(film, block.id, { enabled: next })).then((v) => {
                if (!v) setEnabled(!next);
              });
            }}
          />
          <span className="visually-hidden">Use prompt block {n}</span>
        </label>
        <textarea
          aria-label={`Prompt block ${n}`}
          rows={2}
          value={draft.value}
          placeholder="e.g. Shot on 16mm, soft light"
          onChange={(e) => draft.setValue(e.target.value)}
          onFocus={draft.onFocus}
          onBlur={draft.onBlur}
        />
        <span className="block-tools">
          <button type="button" className="tool-btn" aria-label={`Move block ${n} up`} title="Move up" disabled={index === 0} onClick={() => onMove(block.id, -1)}>
            ↑
          </button>
          <button
            type="button"
            className="tool-btn"
            aria-label={`Move block ${n} down`}
            title="Move down"
            disabled={index === count - 1}
            onClick={() => onMove(block.id, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="tool-btn"
            aria-label={`Delete block ${n}`}
            title="Delete"
            onClick={() => {
              if (!block.text.trim() || confirm("Delete this prompt block?")) {
                draft.discardPending(); // the block is being deleted: do not save it afterwards
                void run("Delete block", () => api.deleteBlock(film, block.id));
              }
            }}
          >
            ×
          </button>
        </span>
      </div>
      {draft.error && <div className="field-error small">Not saved: {messageOf(draft.error)}</div>}
    </>
  );
}
