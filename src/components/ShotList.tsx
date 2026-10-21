import { useMemo, useState } from "react";
import type { FilmView } from "../../shared/api";
import type { Shot } from "../../shared/domain";
import { composePrompt } from "../../shared/prompt";
import { api, mediaUrl, messageOf } from "../lib/api";
import { blockGroup, blockKey, draftValue, flushDrafts, useDraft } from "../lib/drafts";
import { parseSettings } from "../lib/settings";
import { useFilm } from "../lib/filmContext";
import { GeneratedPreview, GenerationDetails, useVariations, VariationControls } from "./OutputViewer";

export function visibleShots(view: FilmView): Shot[] {
  return Object.values(view.state.shots)
    .filter((s) => s.missingSince === null)
    .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
}

export const shotDomId = (i: number) => `shot-row-${i}`;

export function ShotList() {
  const { view, film } = useFilm();
  const shots = useMemo(() => visibleShots(view), [view]);
  const missing = useMemo(
    () => Object.values(view.state.shots).filter((s) => s.missingSince !== null),
    [view],
  );

  return (
    <main className="shot-list" aria-label="Shots">
      {shots.length === 0 ? (
        <div className="empty-card empty-shots">
          <h2>Add images to start</h2>
          <p>
            Put JPG, PNG or WebP images into this film's folder. Each image becomes a shot here within a few seconds;
            no restart needed. Audio files you add there can be used as the soundtrack.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => api.openFolder(film, "film").catch(() => undefined)}>
            Open film folder
          </button>
        </div>
      ) : (
        <>
          <div className="shot-head" aria-hidden="true">
            <span />
            <span />
            <span>Source</span>
            <span>Generated</span>
          </div>
          {shots.map((shot, i) => (
            <ShotRow key={shot.filename} shot={shot} index={i} />
          ))}
        </>
      )}
      {missing.length > 0 && (
        <details className="missing">
          <summary>
            {missing.length} source image{missing.length === 1 ? " is" : "s are"} missing from the folder
          </summary>
          <p className="muted small">
            Their descriptions and generation history are kept. Put the file back with the same name to reconnect it.
            Clips from these shots that are already on the timeline still export.
          </p>
          <ul>
            {missing.map((s) => (
              <li key={s.filename}>
                {s.filename} · {s.generations.length} generation{s.generations.length === 1 ? "" : "s"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}

function ShotRow({ shot, index }: { shot: Shot; index: number }) {
  const ctx = useFilm();
  const { film, view, status, parsedSettings, applyView, nextSeq, notify, openLightbox } = ctx;
  const draft = useDraft(
    `shot:${film}:${shot.filename}`,
    shot.text,
    async (text) => {
      const token = nextSeq();
      applyView(await api.saveShotText(film, shot.filename, text), token);
    },
    { group: `shots:${film}`, onLostSave: (m) => notify(`The description of ${shot.filename} could not be saved: ${m}`) },
  );
  const [busy, setBusy] = useState<0 | 1 | 4>(0);
  const [genError, setGenError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [followLatest, setFollowLatest] = useState(0);

  const source = view.sources.find((s) => s.filename === shot.filename);
  const provider = status?.provider;
  const blockedReason = !provider
    ? "Loading…"
    : !provider.ready
      ? provider.reason
      : source && !source.generatable
        ? source.reason
        : null;
  const gen1Problems = parsedSettings?.gen1Problems ?? ["Loading settings…"];
  const gen4Problems = parsedSettings?.gen4Problems ?? ["Loading settings…"];
  const preview = composePrompt(view.state.promptBlocks, draft.value);

  async function generate(count: 1 | 4) {
    // Validate the settings exactly as they are visible right now.
    const model = ctx.status?.activeModel;
    const parsed = model ? parseSettings(model, ctx.settingsDraft) : null;
    const settings = count === 1 ? parsed?.gen1 : parsed?.gen4;
    if (!settings) {
      const problems = count === 1 ? parsed?.gen1Problems : parsed?.gen4Problems;
      setGenError(`Nothing was submitted. Fix the generation settings first: ${problems?.join(" ") ?? "settings are still loading."}`);
      return;
    }
    setBusy(count);
    setGenError(null);
    try {
      // Every edited prompt block of this film must be saved before anything is sent.
      try {
        await flushDrafts(blockGroup(film));
      } catch (err) {
        const msg =
          `Nothing was submitted: a prompt block could not be saved (${messageOf(err)}). ` +
          `Your edits are still in the editor. Fix the problem, then click Gen ${count} again.`;
        setGenError(msg);
        notify(msg);
        return;
      }
      if (!ctx.isCurrent()) {
        notify(`Gen ${count} for ${shot.filename} was cancelled because you switched films before it was sent. Nothing was submitted.`);
        return;
      }
      // Send the visible shot text together with the full prompt we expect the
      // server to build; it refuses (and creates nothing) if they differ.
      // The revision is read from the draft's live state, not from this render.
      const sentRevision = draft.revision();
      const text = draftValue(`shot:${film}:${shot.filename}`) ?? draft.value;
      const latest = ctx.latestView();
      const blocks = latest.state.promptBlocks.map((b) => ({ ...b, text: draftValue(blockKey(film, b.id)) ?? b.text }));
      const expectedPrompt = composePrompt(blocks, text);
      const token = nextSeq();
      const res = await api.generate(film, shot.filename, { text, settings, count, expectedPrompt });
      // Acknowledge only the revision that was sent; newer edits stay unsaved and are saved again.
      draft.acknowledge(sentRevision);
      applyView(res.view, token);
      setFollowLatest((n) => n + 1);
    } catch (err) {
      const msg = `Generate failed: ${messageOf(err)}`;
      setGenError(msg);
      notify(msg);
    } finally {
      setBusy(0);
    }
  }

  const mock = provider?.isMock;
  const gen1Disabled = busy !== 0 || blockedReason !== null || gen1Problems.length > 0;
  const gen4Disabled = busy !== 0 || blockedReason !== null || gen4Problems.length > 0;
  const settingsNote =
    gen4Problems.length > 0
      ? `Fix the generation settings first: ${gen4Problems.join(" ")}`
      : gen1Problems.length > 0
        ? `Fix the generation settings to use Gen 1: ${gen1Problems.join(" ")} Gen 4 still works because it always picks random seeds.`
        : null;
  const note = blockedReason ?? settingsNote ?? genError;
  const variations = useVariations(shot, followLatest);
  const [showDetails, setShowDetails] = useState(false);
  const id = shotDomId(index);
  return (
    <article className="shot" id={id} aria-labelledby={`${id}-title`}>
      <div className="shot-num tabular" aria-hidden="true">
        {String(index + 1).padStart(2, "0")}
      </div>
      <div className="shot-text">
        <h3 id={`${id}-title`} className="shot-title" title={shot.filename}>
          {shot.filename}
        </h3>
        <label className="visually-hidden" htmlFor={`${id}-desc`}>
          Description for {shot.filename}
        </label>
        <textarea
          id={`${id}-desc`}
          className="shot-desc"
          rows={3}
          value={draft.value}
          placeholder="Describe the shot: action, camera, sound…"
          onChange={(e) => draft.setValue(e.target.value)}
          onFocus={draft.onFocus}
          onBlur={draft.onBlur}
        />
        {draft.error && <div className="field-error small">Not saved: {draft.error}</div>}
        <div className="gen-buttons">
          <button
            type="button"
            className="btn btn-xs btn-primary"
            disabled={gen1Disabled}
            onClick={() => void generate(1)}
            aria-describedby={`${id}-gen-note`}
            title="Generate one variation"
          >
            {busy === 1 ? "Sending…" : "Gen 1"}
          </button>
          <button
            type="button"
            className="btn btn-xs"
            disabled={gen4Disabled}
            onClick={() => void generate(4)}
            aria-describedby={`${id}-gen-note`}
            title={
              mock
                ? "Gen 4 makes four separate mock clips with random seeds."
                : "Gen 4 sends four separate paid requests to fal, each with a random seed."
            }
          >
            {busy === 4 ? "Sending…" : "Gen 4"}
          </button>
        </div>
        <VariationControls
          v={variations}
          detailsOpen={showDetails}
          onToggleDetails={() => setShowDetails((v) => !v)}
          promptOpen={showPreview}
          onTogglePrompt={() => setShowPreview((v) => !v)}
        />
        {note ? (
          <p id={`${id}-gen-note`} className="gen-note field-error small" role="alert">
            {note}
          </p>
        ) : (
          <p id={`${id}-gen-note`} className="visually-hidden">
            {mock
              ? "Gen 4 makes four separate mock clips with random seeds."
              : "Gen 4 sends four separate paid requests to fal, each with a random seed."}
          </p>
        )}
      </div>

      <figure className="media-cell">
        <button
          type="button"
          className="media-frame source-frame"
          onClick={() =>
            openLightbox({ items: [{ kind: "image", src: mediaUrl.source(film, shot.filename), title: shot.filename }], index: 0 })
          }
          aria-label={`Enlarge source image ${shot.filename}`}
        >
          <img src={mediaUrl.source(film, shot.filename)} alt="" loading="lazy" />
        </button>
      </figure>

      <GeneratedPreview shot={shot} v={variations} />

      {(showPreview || (showDetails && variations.current)) && (
        <div className="shot-extra">
          {showPreview && (
            <div>
              <h4>Text that will be sent</h4>
              <pre className="prompt-preview" aria-label="Text that will be sent">
                {preview || <span className="muted">Nothing yet. Write a description or enable a prompt block.</span>}
              </pre>
            </div>
          )}
          {showDetails && variations.current && <GenerationDetails g={variations.current} />}
        </div>
      )}
    </article>
  );
}
