# Validation report

This is the development log of what was tested, how, and what was not. It
was written for the project owner during development, so "you" and "your PC"
mean the owner and their Windows machine, and "Claude" is the AI assistant
that wrote and tested the code with them. Windows results were run by the
owner and reported; sandbox results come from a Linux test environment.

Ten runs are recorded here, newest first. **Run 10** makes clips match the
requested length and removes the hairline side bars. Runs 9–1 are kept
unchanged below it for comparison.

## Release prep for v0.1.0 (2026-10-20)

No app behavior changed. Added the MIT `LICENSE`, `.gitattributes` (keeps
`start-windows.cmd` byte-exact with CRLF), a README screenshot made from a
synthetic mock film, and setup step 1 ("Get the code"). Removed a personal
Windows path from this log. Before publishing, every tracked file was scanned
for keys, tokens, personal paths and media; `.env`, `films/`, generated clips,
renders and `dist/` stay untracked. The checks were re-run on a fresh copy of
exactly the published files (see the release notes).

## Run 10: requested length and edge-to-edge previews (2026-10-19, Linux sandbox)

**Environment.** Linux sandbox, mock provider only, no fal requests.
**Not yet run on Windows or with real fal clips.**

**What changed.**
- **Clips use the requested length.** fal returned about 5.2 s for a 5 s
  request. A clip more than 0.05 s longer than requested is now treated as
  the requested length everywhere: preview loop, scrub bar, timecodes, trim
  limits, timeline tile lengths, total, preview and export
  (`usableDurationSec` / `effectiveTrim` in `shared/domain.ts`).
  - **Files kept.** Downloaded files are not modified or re-encoded. Clips
    you already generated get the same treatment automatically.
  - **Details** still shows the real length, adding "using the first 5.0s,
    as requested".
  - **Saved trims.** A saved trim that ends in the ignored tail stops at the
    requested end. An invalid trim past the file's end is still rejected.
- **Frame-accurate looping.** Previews and the enlarged view jump back at
  the out point using `requestVideoFrameCallback` (`src/lib/loopRange.ts`), so
  the extra tail, or anything past a trim, never shows. Before, the jump
  could lag up to about 0.25 s.
- **No side bars.** The hairline bars came from clips slightly narrower than
  16:9 (e.g. 1364×768) being letterboxed. Generated clips within 3% of 16:9
  now fill the frame (`object-fit: cover`, cropping at most a few pixels).
  Clips of other shapes, such as portrait, are still letterboxed whole.

### Results

| Check | Result |
| --- | --- |
| `bun run check` | pass; `bun test` 142 pass (6 new) |
| Browser suite | **20 pass, 0 fail**; new preview checks repeated 4× alone, all pass |

**New checks:**
- **Unit tests** (`tests/duration.test.ts`): the usable-length rule, trims in
  the tail, and invalid trims still being rejected.
- **Export:** a 5.3 s clip requested at 5 s exports at 5.0 s (±0.05).
- **Browser:**
  - Over 7 s of real playback, a mock clip (6.3 s for a 6 s request) never
    passes 6.06 s.
  - Near-16:9 previews use `cover`, and a portrait clip uses `contain`.
  - Scrubbing maps the bar to the requested 6 s.
  - The workflow export now totals the requested lengths: 8.4 s, where 8.7 s
    used to include the overrun.
- **Pixel check:** the first and last pixel columns of a preview are video
  content, not black.

### Not verified

- **On your PC with real fal clips.** Your clips' exact size (e.g. 1364×768)
  isn't known here; Details shows it.

## Run 9: launcher adds new settings to .env (2026-10-19, Linux sandbox)

**What changed.** On each start, `scripts/launch.ts` (what `start-windows.cmd`
runs) calls `scripts/envFile.ts`:
- **No `.env`:** it is created as a copy of `.env.example`, in mock mode.
- **`.env` exists:** any setting that `.env.example` sets but `.env` doesn't
  mention at all is appended with its comment. A setting that is commented
  out counts as mentioned and is left alone.
  - Existing lines are never changed, line endings (CRLF) are kept, and
    writes are atomic. Values are never printed; the launcher prints only the
    key names it added.
  - Every example value equals the built-in default (a test enforces this),
    so an added line never changes behavior.
- **Your `.env`:** on your next start, it will gain `FAL_BILLING_KEY=` (empty)
  and nothing else.
- The launcher test passes the new `--no-env-update` flag, so `bun test`
  never touches your real `.env`.

### Results

| Check | Result |
| --- | --- |
| `bun run check` | pass; `bun test` 136 pass (7 new in `tests/envFile.test.ts`, symlink case skipped where links aren't allowed) |
| Browser suite | 20 pass, 0 fail (unchanged) |

**Not verified:** the update on your actual `.env`. Claude didn't read or
copy your `.env`, because it holds your fal key. Start Shotloom once and the
launcher window will say "Added new setting to .env: FAL_BILLING_KEY".

## Run 8: preview bar and fal credits (2026-10-19, Linux sandbox)

**Environment.** Linux sandbox, Bun 1.4.2, FFmpeg 6.1.1, Playwright 1.56 with
bundled Chromium 141. Mock provider only. **No request was sent to fal**: the
balance code was tested with a fake `fetch`, and the browser test fakes the
server's answers. **Not yet run on Windows or against your real fal account.**

**What changed.**
- **Bar under each preview.** It is solid green over the part that plays
  (all of it unless trimmed; grey outside a trim). The progress fill is gone.
  A small black playhead appears only while the pointer is over the clip, and
  follows scrubbing and playback.
- **fal credits in the top bar** (fal mode only), e.g. "fal.ai · $24.50
  credits". It turns amber with "low" under $1, and shows "credits unavailable"
  with an explanatory tooltip if the lookup fails.
  - **Server:** `server/system/falBalance.ts` and `GET /api/fal/balance`.
    Results are cached for 60 s (10 min after a permission error); refreshes
    are limited to one per 10 s, and concurrent reads share one request.
  - **Key:** uses the new optional `FAL_BILLING_KEY`, otherwise `FAL_KEY`.
  - **Endpoint:** fal's documented
    `GET https://api.fal.ai/v1/account/billing?expand=credits`. fal requires
    billing-read permission for it; an ordinary "API" key may be refused.
  - **Updates:** on load, every minute, on window focus, and 4 s after a clip
    finishes.
- `.env.example` documents `FAL_BILLING_KEY`. Your `.env` was not touched.

### Results

| Check | Result |
| --- | --- |
| `bun run check` (type check, `bun test`, production build) | pass; `bun test` 129 pass (9 new) |
| Browser suite (`bun run test:browser`) | **20 pass, 0 fail**: 19 earlier scenarios (one extended) plus 1 new |

**New unit tests** (`tests/falBalance.test.ts`, fake `fetch` only):
- Mock mode and a missing key make no request.
- The correct URL and `Authorization: Key …` header are used.
- `FAL_BILLING_KEY` is preferred over `FAL_KEY`.
- Caching, refresh limits and shared concurrent requests behave as described.
- 401/403 point to `FAL_BILLING_KEY` and never include a key or fal's own
  error text.
- HTTP 500, network errors, timeouts and malformed bodies are reported, not
  thrown.
- The HTTP route returns only the numbers.

**Browser checks:**
- **Preview scenario, extended.** The bar is ≥99% green with no progress
  fill. No playhead appears before hovering. While scrubbing to 80%, the
  playhead sits within 10% of 80%. It hides when the pointer leaves.
- **New credits scenario.** Live status and balance answers are faked inside
  the test browser. It checks the chip text, the paid-generation tooltip,
  the low-balance styling, that window focus asks for a refresh, and the
  "credits unavailable" tooltip mentioning `FAL_BILLING_KEY`.

### Not verified

- **Your real balance.** Whether your current `FAL_KEY` can read billing
  isn't known. If the top bar says "credits unavailable", add a BILLING-preset
  key as `FAL_BILLING_KEY`.
- **How quickly fal's balance reflects a finished clip.**
- **On Windows/Edge.** 20 browser scenarios are expected.

## Run 7: looping silent previews (2026-10-19, Linux sandbox)

**Environment.** Linux sandbox, Bun 1.4.2, FFmpeg 6.1.1, Playwright 1.56 with
bundled Chromium 141. Mock provider only, `FAL_KEY` blank, no fal requests.
**Not yet run on Windows or in Edge.**

**What changed.** Client only; no server code or APIs changed.
- **Previews loop on their own, muted**, inside the trim if there is one.
  Only previews on screen play, and nothing plays while the tab is hidden, so
  long films stay light.
- **Hovering adds sound** to that clip only. Browsers allow sound only after
  the page has had a click or key press. Until then a hovered clip keeps
  playing silently.
- **Scrubbing still works.** Moving the pointer shows the frame under it, and
  playback continues from there once the pointer rests for 0.35 s.
- **Click (or Enter) enlarges** the clip with sound, looping, and silences
  the preview behind it. Clicking used to play the clip in place. Generated
  clips also loop in the enlarged view; film previews and exports still play
  once.
- **Space pauses or resumes** the hovered clip, and a "Paused" label shows
  while it's paused.
- **Drag-to-trim is unchanged.** Playback resumes after the drag.
- Timeline tiles still show a still frame.

### Results

| Check | Result |
| --- | --- |
| `bun run check` (type check, `bun test`, production build) | pass |
| Browser suite (`bun run test:browser`) | **19 pass, 0 fail**: the 18 earlier scenarios plus 1 new one |
| New scenario repeated alone | 5 of 5 passes |
| Screenshot tool (`tests/browser/screens.ts`) | runs; layout unchanged, previews captured mid-playback |

**The new scenario** checks, with two generated clips:
- Both previews play muted and looping, and keep advancing without
  interaction.
- After one click on the page, hovering unmutes only that clip, and both keep
  playing.
- Moving the pointer to 80% pauses on that point; after it rests, playback
  continues from there with sound.
- Leaving mutes the clip again, and it keeps playing.
- Clicking opens the enlarged view, which plays looping with sound while the
  preview behind it is muted. Escape closes it.
- Space pauses the hovered clip, showing "Paused", and Space resumes it.

**Test-only change.** The VP9 stand-in that lets the sandbox's Chromium play
clips moved from `screens.ts` into `harness.ts` and now answers byte-range
requests, so seeking and looping can be tested here. Edge and Chrome, which
play H.264, still get the original files.

### Not verified

- **On Windows/Edge.** Run `bun run test:browser` on your PC; 19 scenarios
  are expected.
- **Hearing the sound.** The tests check the browser's muted state, not
  audio output. The sandbox's stand-in clips have no audio track.

## Run 6: redesign on Windows (2026-10-19, on your PC)

**Who ran it.** You ran this on your Windows PC
(the project folder on the owner's PC) and reported the result. Claude
did not observe the run. Windows, Bun and browser versions were not recorded.
The browser was most likely Edge: the harness picks bundled Chromium only if
it is installed, otherwise Edge, and Run 4 used Edge.

### Result (as reported)

| Check | Result |
| --- | --- |
| `bun run test:browser` (18 scenarios, mock mode, disposable fixtures) | **All 18 passed** |

No code changed for this run.

### Now verified on Windows

- **Run 5's top open item.** The redesigned layout passed every browser
  scenario on Windows: the 16:9 frame and portrait-containment checks, the
  More actions menu, and the save indicator.
- **The 15 earlier scenarios on the new UI.** Prompt-save failures, film-switch
  isolation, settings validation, description edits during a pending Gen, and
  generate → trim → reorder → export.

### Still not verified

- **Real fal.ai generation.** Every run so far used mock mode.
- **Hover scrubbing and Space/Enter playback, as seen by eye on the new
  layout.** The automated scenarios don't check these frame by frame. Using
  the app for a minute would cover them.
- **File-symlink containment on Windows**, if those tests were skipped (see
  Run 4).

## Run 5: compact UI redesign (2026-10-18, Linux sandbox)

**Environment.** Linux sandbox, Bun 1.4.2, FFmpeg 6.1.1, Playwright 1.56 with
bundled Chromium 141. Mock provider only, `FAL_KEY` blank, no fal requests.
**Not yet run on Windows or in Edge.**

**What changed.** The work was visual and structural only. No server code or
APIs changed.
- **Saving.** Prompt-save, film-switch, settings and description-revision
  logic is untouched.
- **`src/lib/drafts.ts`** gained a read-only save summary for the new "Saved
  locally / Saving… / Changes not saved" indicator. It only observes draft
  state and changes no save behavior.
- **Previews.** Both are exact 16:9 frames with media pinned inside and
  `object-fit: contain`.
- **Secondary actions** (trim times, use full clip, details, sent-text
  preview, delete) moved into a per-row "More actions" menu.

### Results

| Check | Result |
| --- | --- |
| `tsc --noEmit` | pass |
| `bun test` | 120 pass, 0 fail, 0 skipped (final run). One earlier run had 1 unexplained failure (`toBe` mismatch); it did not recur in 7 later full runs. |
| `vite build` | pass |
| Browser suite (`tests/browser/editor.e2e.ts`, 18 scenarios) | **18 pass, 0 fail**: the 15 earlier scenarios plus 3 new ones |
| Layout measurements (`tests/browser/screens.ts`) | see below |

**New browser scenarios:**
- **Layout.** At 1774×887: every frame is 16:9 within 0.002, source and
  generated frames share one width, and a portrait source is contained, not
  cropped. The description is 190–220px wide, a timeline tile is at most
  140×90px, and there's more than 300px of blank space to the right.
- **More actions menu.** Exact trim (`1`–`3.5` saved, label
  `0:01–0:03.5 · 2.50s`), Use full clip, Details, sent-text preview, and
  Escape closing the menu with focus returned to its button.
- **Save indicator.** "Saving…" while an edit is pending, "Saved locally"
  after the save, "Changes not saved" after an HTTP 500.

### Layout measurements (real running app, mock fixture with 6 shots and 12 timeline clips)

| Viewport | Frames 16:9 | Preview width | Description | Timeline | Notes |
| --- | --- | --- | --- | --- | --- |
| 1774×887 | all 1.7778 | 320px | 212px | 12 tiles × 128px, no scroll | 474px blank space to the right |
| 1920×1080 | all 1.7778 | 320px | 212px | 12 tiles, no scroll | 620px blank space |
| 1366×768 | all 1.7778 | 320px | 212px | scrolls (12 tiles don't fit) | — |
| 1024×768 | all 1.7778 | 302px | 360px (stacked) | scrolls | Text above the two previews |
| 800×900 | all 1.7778 | 236px | 360px (stacked) | scrolls | Navigator hidden |

**At every size:**
- No overlapping or clipped controls, and no horizontal page scroll.
- With the list scrolled to the end, the last row sits fully above the docked
  timeline (48px clearance).
- The portrait source is drawn at 101×180 inside its 320×180 frame (aspect
  preserved).
- Tabbing into a timeline tile reveals its tools (focus on "Move clip 1
  later", opacity 1).
- The lightbox opens from the enlarge button and closes on Escape.

**Bug found and fixed while measuring.** Source images were sized from
percentage heights inside an aspect-ratio grid button, so a portrait image's
element measured 320×569 inside a 320×180 frame. It was cropped, not
contained, which the old layout also did. Media is now absolutely pinned to
the frame.

**Screenshot method.** The sandbox's Chromium has no H.264 decoder. The
screenshot script therefore serves VP9 copies of the mock clips to the test
browser only (see `serveVp9Copies` in `tests/browser/screens.ts`). The app
and server are unchanged, and real browsers play the H.264 originals.

### Not verified

- **Windows/Edge rendering of the new layout.** Run `bun run test:browser`
  on your PC.
- **Hover-scrub frame movement on screen.** The substituted VP9 copies don't
  support seeking in the sandbox. The scrubbing code is unchanged from the
  version you verified in Edge.
- **Playback via Space and Enter.** The handlers exist and are labeled, but
  headless Chromium can't play the H.264 clips to show it.


## Run 4: Windows verification (2026-10-18, on your PC)

**Who ran it.** You ran these commands on your Windows PC
(the project folder on the owner's PC) and reported the results.
Claude had file access to the project folder but no shell on the PC, so it
did not observe the runs. It did confirm the `node_modules` contents and read
the failure screenshot described below. Windows, Bun and Edge versions were
not recorded.

**Setup issue found first.** `bun run check` reported 20 type errors and
`bun run test:browser` could not find `playwright-core`. The cause was that
`node_modules` predated the dev dependency added in Run 2; the launcher only
installs when `node_modules` is missing entirely. Recreating that state in
the sandbox gave exactly the same 20 errors, all in `tests/browser/`.
Running `bun install` once fixed both.

### Results (as reported)

| Check | Result |
| --- | --- |
| `bun run check` (type check, `bun test`, production build) | **All passed** |
| `bun run test:browser`, first run (Edge) | 14 pass, **1 fail**: "the newer edit finishes saving before the delayed Gen response arrives" |
| `bun run test:browser`, after the test fix below | **All passed** (15 scenarios) |
| `start-windows.cmd` (double-click launcher) | **Works** |

Whether the file-symlink tests were skipped on Windows (they skip only
without Developer Mode or admin rights, with a printed reason) was not
reported.

**The one browser failure was a test bug, not an app bug.**
- The failure screenshot (`tests/.tmp/fail-11.png`) showed the app in the
  correct state: the newer description was on screen and saved, and the Gen
  response was still deliberately held.
- The test checked a list filled by Playwright's response event right after
  the server reported the new text. On Windows, that event arrived a moment
  later.
- The scenario now waits for the save response explicitly
  (`page.waitForResponse`). Only `tests/browser/editor.e2e.ts` changed;
  application code was untouched.
- After the fix, the scenario passed 5 times in a row in the sandbox, the
  full suite passed 15/15 there, and then all scenarios passed on your PC.

### Now verified on Windows

These were listed as unverified in Runs 1–3 and have since been checked on
your PC:
- The launcher (`start-windows.cmd` → `scripts/launch.ts`) starts Shotloom.
- The full automated suite runs on Windows, including the containment tests
  using real directory junctions.
- The browser regression suite passes in Microsoft Edge: prompt-save
  failures, film-switch isolation, settings validation, description edits
  during a pending Gen, and the generate → trim → reorder → export workflow.
- From your earlier reports: Windows export tests, plus Edge playback,
  trimming and drag reordering.

### Still not verified

- **Real fal.ai generation.** Every run so far used mock mode. The optional
  paid check is `bun run smoke:live -- <image> --yes-spend-money` (one 5 s /
  480P request).
- **File-symlink containment on Windows**, if those two tests were skipped.
  Running the suite once from an elevated terminal, or with Developer Mode
  on, would cover them.


## Run 3: description edits during a pending Gen (2026-10-18)

**Environment.** Same as Run 2: Linux sandbox, Bun 1.4.2, FFmpeg 6.1.1,
Playwright 1.56 with bundled Chromium 141. Mock provider only, `FAL_KEY`
blank, no fal requests. **Not run on Windows or in Edge.** The Edge
reproduction you reported was not repeated here.

**Root cause.**
- When a Gen request finished, `ShotList` ran
  `if (draft.value === text) draft.markSaved()`. Both values came from the
  render that started the Gen, so the check was always true.
- `markSaved()` then cleared the dirty flag and cancelled the pending autosave
  of any edit typed while the request was pending. That edit stayed visible
  but was never saved.
- Related ordering problem: if a newer description save reached the server
  *before* a delayed generate request, the generate rewrote the older text.
- Same family: the draft's own autosave marked text clean by comparing
  values, not revisions.

**Fix** (`src/lib/drafts.ts`, `src/components/ShotList.tsx`,
`src/components/LeftPanel.tsx`):
- Every edit gets a revision number. Generate reads the live revision and text
  when it sends, then calls `draft.acknowledge(revision)`.
- Only that exact revision is marked saved. If the text has changed since, or
  a save of another revision is in flight, the edits stay unsaved and the
  visible text is saved again. A pending autosave is left alone.
- The draft's autosave now marks text clean by revision, not by comparing
  values.
- Delayed generate responses are still ordered by the existing view gate, so
  an older response cannot replace a newer saved description on screen.
- `markSaved()` is removed. Block deletion, its other caller, now uses an
  explicit `discardPending()`.

### Results

| Check | Before this fix | After |
| --- | --- | --- |
| `tsc --noEmit` | pass | pass |
| `bun test` | 120 pass | **120 pass, 0 fail, 0 skipped** |
| `vite build` | pass | pass |
| Browser suite (15 scenarios) | 6 new scenarios run against the pre-fix code: 3 pass, **3 fail** (the race cases marked below). The 9 existing scenarios had passed in Run 2 and were not re-run before the fix. | **15 pass, 0 fail** in one full run; the 6 new scenarios were repeated 3 more times, all passing |

The race tests hold the generate response, or request, with request
interception, and release it under test control. Each also asserts its
precondition: no autosave of the newer edit was sent before the response was
released. So a pass cannot come from the autosave happening to fire first.

New browser scenarios:

1. **Gen 1** and 2. **Gen 4**: the server processes the request, the response
   is held, and `NEW EDIT WHILE SAVING` is typed. The response is released
   before the autosave fires, then the box is blurred. The newer text is
   persisted and survives reload; every generation record keeps
   `STYLE\n\nORIGINAL TEXT SENT`. *Failed before the fix.*
3. **The newer edit is saved before the delayed response arrives.** It stays
   visible and persisted after the stale response, the new generation still
   appears, and it survives reload.
4. **A newer edit is saved before the delayed generate request reaches the
   server.** The generate writes the old text, and the editor restores the
   newer text automatically. *Failed before the fix.*
5. **No edits while pending.** The response acknowledges the sent text, no
   redundant save follows within 1.5 s, no "Not saved" appears, and it
   survives reload. Editing afterwards saves normally.
6. **Switching films while the response is pending.** Film B's editor never
   shows A's content, and B's description, blocks and generations are
   untouched. A keeps its generation (original prompt) and its newer
   description.

**Not verified:** Windows, Edge, and real fal timing.


The Windows run you did between them is not reproduced here. As you reported
it: type check, build and Windows export tests passed; Edge playback, trimming
and drag reordering worked; `bun test` gave 77 passes and 1 failure, because
Windows refused to create a file symlink.

## Run 2: repair of five reproduced defects (2026-10-18)

**Environment.** Linux sandbox (kernel 6.18), Bun 1.4.2, FFmpeg/ffprobe
6.1.1, Playwright 1.56 (playwright-core) with bundled Chromium 141. Mock
provider only: `GENERATION_PROVIDER=mock`, and `FAL_KEY` was blank in every
run. No fal request was made.

**Not run on Windows.** This session could read and write the project
folder on the Windows PC, but had no shell there. Nothing below was executed
on Windows.

### Results

| Check | On the original code | After the repair |
| --- | --- | --- |
| `tsc --noEmit` | pass | pass |
| `bun test` | 85 pass, 13 fail (all 13 are the new regression tests) | **120 pass, 0 fail, 0 skipped** |
| `vite build` | pass | pass |
| `bun run test:browser` (9 scenarios, Chromium) | 3 pass, 6 fail (the 6 defect scenarios) | **9 pass, 0 fail** |
| `start-windows.cmd` on Windows | not run | **not run (unverified)** |

The original-code column comes from running the final test files against a
checkout of the original code. A regression test "fails on the original" when
it fails there. The 3 browser scenarios that pass on the original are
deliberate preservation checks: two focused-input cases and the end-to-end
workflow.

**Skips.** No test skipped here, because Linux permits file symlinks. On
Windows without Developer Mode or administrator rights, exactly two tests
will skip, each printing its reason:

- `paths.test.ts`: "blocks file symlink escape"
- `containment.test.ts`: "a source file symlinked to outside the root is not served"

A skip happens only when the probe sees `EPERM` or `EACCES`; any other error
fails the run. Directory cases use junctions on Windows, which need no
privilege, so they still run.

### Regression cases by defect

**1. Windows launcher** (`tests/launcher.test.ts`, 7 tests)
- Static checks on `start-windows.cmd`: CRLF throughout; no `/dev/null`;
  every redirection targets `nul` or `&1`; `cd /d "%~dp0"` quoting; no
  hard-coded port or `where ffmpeg`; hands off to `scripts/launch.ts`.
  These checks are **not** evidence that the batch file runs on Windows.
- `scripts/launch.ts` runs for real:
  - It opens the URL for `PORT`.
  - It checks the configured `FFMPEG_PATH`/`FFPROBE_PATH`, including
    paths with spaces, and names the bad path.
  - It starts the server on a custom port and keeps going after warning
    about a missing ffmpeg.

**2. Failed prompt saves** (browser, Gen 1 and Gen 4 each)
- A block save answered with HTTP 500 results in 0 generate requests and 0
  jobs. The edited text stays visible, the server still holds the old block,
  and an error says nothing was submitted.
- After saves succeed, clicking again sends exactly one request, and every
  job's submitted prompt is `EDITED BLOCK n\n\nthe shot`.
- Typing in the shot box (focus still there, block edited moments earlier)
  and clicking Gen sends the latest text of both.
- `http.test.ts`: a generate whose `expectedPrompt` differs from the
  server's composition returns 409 `PROMPT_CHANGED`. No job is created and
  no text is saved.

**3. Cross-film responses** (browser, held responses controlled by the test)
- Film A's block save is held, Gen 1 is clicked, and the user switches to B.
  After release, A's shot name and block text never appear in B's editor
  (watched continuously), and no generate request is sent for A. A's own
  edit is saved to A. A later edit in B changes only B.
- A background poll for A is held and answered with an error after
  switching to B. B stays on screen; no "can't be opened" appears.
- Switching A → B → A while a session-one Gen is waiting: the obsolete
  session sends nothing, and a marked response is never shown. Edits in the
  new A session save correctly.
- `client.test.ts`: the `ViewGate` rejects other films, older responses,
  tokens from an earlier session of the same film, and tokens taken late
  for an old selection.

**4. Invalid visible settings** (browser + `client.test.ts`)
- Duration `""`, `6.5`, `2`, `16`, `0` and `-3` each disable Gen 1 and
  Gen 4 with an explanation; 0 requests are sent.
- Seeds `-1`, `1.5`, `99999999999` and `1e3` disable Gen 1 with an
  explanation.
- Gen 4 stays available with an invalid seed, because it never reads the
  seed (it sends `seed: null` and the server picks four distinct seeds).
- What is sent matches what is visible: `{9, "480P", 4242}`;
  `{9, "480P", null}` for Gen 4; `{12, "480P", null}` for a blank seed.
- Unit tests cover the same rules, plus `6.0`, `1e1`, `six` and an unknown
  resolution.

**5. Films-root containment** (`tests/containment.test.ts` through the HTTP
API, plus `paths.test.ts`)
- **Film folder linked outside the root.** The film isn't listed. These are
  all refused: view, media, shot edit, block add, aspect change, render,
  start fresh, open folder, generate, and import-from. The outside folder is
  byte-for-byte unchanged and no `.shotloom` is created there.
- **Linked `.shotloom`.** Reads and writes are refused, and a decoy
  `state.json` outside is neither read nor modified.
- **Linked `exports`.** Export, open-folder and export media are refused;
  nothing is created outside.
- **Linked `.shotloom/tmp` and `.shotloom/preview`.** Renders are refused.
  On the original, render cleanup would have **deleted files in the outside
  folder**; those files survive now.
- **Linked `.shotloom/generations`.** The clip isn't served and delete is
  refused (the outside file survives). A new mock job fails instead of
  writing outside.
- **Source file symlinked outside.** Not listed and not served (one of the
  privilege-dependent skips on Windows).
- **Films root that is itself a link.** Works, and its files land in the
  link's target.
- **Ordinary film.** Generation, export, open-folder and delete still work
  (control).
- **Unit tests:** dangling links are refused, not-yet-existing paths under
  real folders are allowed, and a prefix-sharing sibling (`films-evil`) is
  refused.

### Preserved behavior

The workflow browser scenario runs Gen 4, drag-trims a variation, adds two
clips, reorders them with the arrow button, switches to 9:16 and exports.
The export is 810×1440, its length matches clip + trim within 0.15 s, and
the trim and order persist on the server. All Run 1 tests still pass,
including export, audio, recovery and range tests.

### Remaining limitations

- **The launcher is unverified on Windows.** That covers `start-windows.cmd`
  itself, opening Edge or your default browser via `explorer.exe`, and Ctrl+C
  shutdown through cmd.
- **Junction behavior is unverified on Windows.** Junctions were tested
  using Linux directory symlinks. The code paths are the same (`realpath`
  plus case-insensitive comparison on win32), but nothing ran on Windows.
- **Containment is checked right before each operation.** A link swapped in
  during the tiny window between check and use is not detected. For a
  single-user local app this is an accepted limit.
- **The "text that will be sent" preview** reflects block text once it is
  saved (it lags while you type). What is *sent* is always the visible text:
  the server refuses with `PROMPT_CHANGED` if it would compose something
  different.
- **Gen and switching films.** If you click Gen and switch films before the
  prompt finishes saving, that Gen is cancelled and a notice says nothing
  was submitted. Jobs already submitted keep running.

---

## Run 1: initial MVP (2026-10-18, Linux sandbox)

**Environment.** Linux sandbox, Bun 1.4.2, FFmpeg/ffprobe 6.1.1, and
Playwright's headless Chromium 1194. Date: 2026-10-18.

**No paid generation was run.** `FAL_KEY` was never set during development
or testing, and `bun run check` blanks it explicitly.

### Summary

| Check | Result |
| --- | --- |
| `tsc --noEmit` (server, shared, UI, tests, scripts) | Pass |
| `bun test`: 78 tests in 7 files | 78 pass, 0 fail |
| `vite build` (production) | Pass |
| Headless-browser walkthrough (mock mode, 1366×768 and 1100×700) | Pass, with the limits listed below |
| Export media probing (ffprobe + frame color + volume detection) | Pass |
| Live fal generation | **Not run** (not authorized) |
| Running on Windows | **Not run** (no Windows machine available) |

### Acceptance scenarios

| Scenario | How it was verified |
| --- | --- |
| Create a film, add images, discover them without restarting | Browser: created a film in the UI, copied files into its folder, and all four shots appeared without a reload. Test: `images added later are discovered without restarting`. |
| Edit, toggle, reorder and import prompt blocks; exact composition order | Browser: added a block, edited it, moved it up, and disabled the default. The preview showed `Shot on 16mm.\n\nClouds drift.` Tests: 6 composition tests, plus `prompt blocks: add, edit, toggle, reorder, import as independent copies`. |
| Edit a shot and immediately generate; latest text captured | Browser: typed, then clicked Gen 1 with focus still in the textarea; the submission ended with the typed text. Browser: edited a **block** and clicked Gen 1 with no blur or debounce wait; the submission contained the edit (`…Rain on glass.`). Tests: `Gen 1 creates one job…`, `generate captures the text sent with the request`. |
| Gen 1 creates one job; Gen 4 creates four independent records and seeds | Tests check four ids, four distinct seeds, one batch id, and the shared seed overridden. The browser run produced four distinct seeds. |
| Mock jobs progress and fail visibly without contacting fal | A real-FFmpeg mock test covers success, `mock:fail` and `mock:silent`. The browser showed the red *Failed* state with its message. The mock never opens network connections. |
| Known submitted jobs recover after restart without duplicate submission | Tests use a fresh store and service after a "restart": 0 uploads and 0 submits, and the job completes. Interrupted submissions become `uncertain`; interrupted downloads download again. |
| Historical prompts and settings unchanged after later edits | Test: `historical prompt and settings stay unchanged after later edits`. |
| Trims and timeline order survive refresh and restart | Process restart on the same films root: order, the dragged trim `[1.26–4.41]`, soundtrack and aspect ratio all persisted. |
| Missing source images retain generation history | Tests cover store-level hide and reconnect, and service-level history plus timeline. |
| Two trimmed clips export in order and aspect ratio | Test samples frame colors to confirm blue then red, 1440×810, and a 3.5 s duration (1.5 + 2.0). 1:1 → 1080×1080 and 9:16 → 810×1440. The browser export showed 1:1 at 1080×1080 with the reordered timeline. |
| Exports with clip audio, muted clips, silent clips and a soundtrack | Tests: a clip with no audio track gets synthesized silence (below −60 dB) while the toned clip is audible; muting gives silence overall; a 1.5 s soundtrack under a 3.5 s timeline keeps full length with video to the end; the fade-out is quieter at the tail. |
| Missing dependencies, malformed state, invalid paths and failed provider requests give useful errors | Tests cover: missing `FAL_KEY` (503 with reason, editing still works); malformed, invalid and future-version state (409 naming the untouched file, plus start-fresh); traversal, encoded separators, reserved names and symlink escapes (400/404, nothing leaked); and fal 4xx/5xx/network classification. Missing FFmpeg shows a top banner driven by `/api/status` (status check verified; the banner is not tested with FFmpeg actually removed). |

### Other checks

- **Local safety.** A foreign `Host` header and a cross-site `Origin` both
  return 403, and form-encoded writes return 415. The Vite dev server
  refuses a foreign Host (403) and listens only on 127.0.0.1. Range requests
  return 206, suffix ranges work, and out-of-range requests return 416.
- **Single server per films folder.** A second instance exits with code 1 and
  an explanation. A stale lock from a dead process is ignored.
- **Secrets.** Status output never contains the key. Sidecar metadata and
  request snapshots contain no credentials. The fal adapter test asserts that
  the key appears only in the `Authorization` header.
- **Keyboard.** Typing spaces in a textarea while the pointer rests on a clip
  types normally. Focus outlines are visible. Escape closes the lightbox.

### Fixed during validation

- `store.mutate` applied the change before merging newly discovered files.
  A mutation could therefore miss a shot added a moment earlier. It now
  merges first.
- A file added within the last second could 404 from the media route because
  the folder scan is throttled. The route now rescans before refusing.
- The block on/off checkbox waited for the server round-trip; it is now
  optimistic.
- The film selector's accessible name included option text; it now has an
  explicit label.
- The resolution select overflowed its column, and short timeline clips
  overflowed their tools.
- A clip the browser can't decode now explains itself instead of showing black.

### Not verified, and why

- **Live fal generation.** Not authorized, so not run. The adapter is tested
  against fakes. The request fields (`prompt`, `image_url`, `duration`,
  `resolution`, `seed`, `prompt_expansion_mode`) and response fields
  (`video.url`, `expanded_prompt`) were checked against fal's model API page
  on 2026-10-18. To test live, use `bun run smoke:live -- image.jpg --yes-spend-money`
  (one 5 s / 480P request).
- **Windows.** Everything ran on Linux. Windows-specific behavior is
  implemented but unexercised:
  - `explorer.exe` folder opening
  - rename retry on sharing violations
  - junction escapes (the test used a Linux directory symlink)
  - `start-windows.cmd`
  - Windows paths with FFmpeg
- **Video playback in the browser.** Playwright's Chromium has no H.264
  decoder, so clips showed the new "can't play" note instead of frames.
  Several things were therefore not visually confirmed:
  - hover scrubbing
  - play/pause, and the autoplay fallback
  - looping inside a trim
  - lightbox video playback

  Pointer-driven drag-to-trim *was* verified: the drag produced the expected
  trim request and it persisted. Chrome, Edge and Firefox on Windows decode
  H.264.
- **Mouse drag-reordering** of blocks and timeline clips (HTML5 drag and
  drop) was not driven in the browser. Arrow-button reordering and the
  reorder API were verified.
- **Open-folder buttons.** There is no file manager in the sandbox; the
  spawn path is untested.
