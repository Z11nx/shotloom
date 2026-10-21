# Architecture

A browser UI (React + Vite) talks to a local Bun server over JSON. The server
owns all state, all provider calls and all FFmpeg work. In production one
process serves both the API and the built UI. In development, Vite proxies
`/api` and `/media` to the server.

```
shared/            used by server and browser
  domain.ts        Zod schemas + types: film state, generations, trims; trim validation
  models.ts        model descriptors (durations, resolutions, seed, accepted images)
  prompt.ts        composePrompt(): the single prompt-assembly rule
  api.ts           request-body schemas and response types

server/
  main.ts          startup: config, films-root lock, recovery, listen on 127.0.0.1
  app.ts           wires services; Host/Origin checks; serves built UI
  config.ts        .env → AppConfig
  errors.ts        AppError (status + code + user-facing message)
  films/
    paths.ts       name rules (Windows-strict), single decode, inside-root + realpath checks
    scanner.ts     discovers images/audio directly in a film folder
    layout.ts      every on-disk path in one place
    store.ts       per-film versioned JSON, serialized atomic mutations, discovery merge
  generation/
    providers/types.ts   the provider contract
    providers/fal.ts     fal.ai adapter (minimax/h3-max/image-to-video)
    providers/mock.ts    local fake provider (FFmpeg)
    service.ts           queue, worker loop, backoff, recovery, deletion rules
  media/
    ffmpeg.ts      spawn ffmpeg/ffprobe with argument arrays
    probe.ts       duration / size / streams
    render.ts      the one render pipeline (preview == export)
    renderService.ts  one render at a time, status per film
  http/
    router.ts      tiny router; params decoded once after structural match
    respond.ts     JSON + error envelope, body validation, range-capable file serving
    routes.ts      thin handlers
  system/
    opener.ts      open a folder in Explorer / Finder / xdg-open
    status.ts      dependency and configuration check

src/               React UI (no provider schemas, no model ids)
  lib/api.ts       typed client
  lib/drafts.ts    typing-safe drafts + flush-before-generate
  lib/filmContext.tsx  shared context, sequence-guarded view updates
  components/      TopBar, LeftPanel, ShotList, OutputViewer, ShotNav, Timeline, Lightbox, …
```

## Prompt assembly

`composePrompt(blocks, shotText)` takes the enabled blocks in display order,
then the shot text. It trims each segment, drops empty ones, and joins them
with a blank line. The server uses it when snapshotting a job, and the UI uses
the same function for its read-only preview.

**Generate** first saves every unsaved prompt block of the current film. If
any save fails, nothing is sent: the edited text stays in the editor with an
error, and clicking Gen again retries. It then sends:
- the shot's **visible** text,
- settings parsed strictly from the visible fields (invalid text disables the
  buttons; nothing falls back to older values),
- `expectedPrompt`, the full prompt the editor shows.

The server saves the text and builds the snapshot in one serialized mutation,
and refuses with `PROMPT_CHANGED` (no change at all) if its own prompt
differs. Background polling never replaces text while its field has focus or
unsaved edits.

## Film selection sessions (client)

Every film selection, including returning to a film seen earlier, starts a
new session with its own epoch (`src/lib/viewGate.ts`). The editor is
remounted per session, so components capture that session's helpers. Every
async update is applied only if its session is still the current one, the
response is for that film, and nothing newer has been applied. Updates
include mutation results, draft saves, polling results and polling errors.
A Gen that was waiting on saves when the user switched films is cancelled
before it is sent.

## Generation lifecycle

```
queued ──upload──▶ submitting ──submit──▶ submitted ⇄ processing ──▶ downloading ──▶ completed
   │                   │                                  │               │
   └─▶ failed          └─▶ failed (definite rejection)     └───────────────┴─▶ failed (permanent, or
                       └─▶ uncertain (network/5xx/crash)                            too many transient errors)
```

- **Snapshot at creation.** Each job records its provider id, model key, model
  id, settings (with its own seed), submitted prompt, and a source-file
  fingerprint. Later edits never touch it. After submission it also records
  the exact request body that was sent, which never includes credentials.
- **Upload happens while the job is still `queued`.** Uploading is not
  billable, so a crash there simply retries.
- **`submitting` is persisted before the submit call.** If the app dies
  before it can record the request id, recovery marks the job `uncertain`
  rather than resubmitting. You decide what to do: check the fal dashboard,
  **Mark as failed**, then generate again if needed.
- **The fal submit is attempted exactly once.** It deliberately bypasses the
  fal client's automatic retries. A network error or 5xx reply means
  acceptance is unknown (`uncertain`). A 4xx reply is a definite rejection
  (`failed`).
- **Status, result and download errors are classified.** Transient ones
  (network, 5xx, 429, 408) back off exponentially (2 s doubling up to 60 s, at
  most 8 consecutive attempts). Permanent ones fail the job with the
  provider's message. A job that gave up can be **resumed**. Resuming re-polls
  the same request id; it is never a new generation.
- **Completion is last.** Output goes to `<id>.mp4.part`, is probed with
  ffprobe, renamed into place, and only then marked `completed`. The measured
  duration is stored alongside the requested one.
- **One worker per job.** In-process, a lock set keyed by film and job means
  overlapping ticks skip owned jobs. Across processes, `films/.shotloom/server.lock`
  stops a second server from starting on the same films root.
- **Bounded queue.** At most 2 uploads/submits run at once, and at most 24
  jobs may wait to submit.
- **Restart recovery.** `submitting` becomes `uncertain`, `downloading`
  becomes `processing` (it is fetched again), and `submitted`/`processing`
  jobs keep polling their stored request ids.
- **Deletion.** Only `completed` and `failed` jobs can be deleted. Deleting
  removes the clip file, its sidecar and its timeline uses, never the source
  image. Active jobs can't be deleted, because removing the local record
  would not stop the remote job or its cost.

## Render pipeline (preview and export)

`buildRenderPlan` validates everything first and captures a snapshot:

- The timeline is not empty.
- Every clip is a completed generation whose file exists.
- Every trim satisfies `0 ≤ in < out ≤ actual duration` and lasts at least
  one frame.
- **Requested length.** fal's MiniMax returns slightly long clips (about
  5.2 s for 5 s). `usableDurationSec` in `shared/domain.ts` treats a clip as
  its requested length when it overruns by more than 0.05 s. `effectiveTrim`
  builds on it, so preview, timeline and export all ignore the tail. The
  downloaded file is kept exactly as received, and clips generated earlier get
  the same treatment.
- The soundtrack, if set, exists, has audio, and its offset falls inside it.

`renderPlan` then:

1. **Per clip:** seeks to the in point and cuts to length, scales to cover the
   canvas and center-crops (16:9 → 1440×810, 1:1 → 1080×1080,
   9:16 → 810×1440), then sets square pixels, 30 fps, yuv420p and H.264. Audio
   becomes 48 kHz stereo PCM. Muted or silent clips get synthesized silence, so
   every segment has the same streams.
2. **Concatenate** with the concat demuxer, copying video. The list file holds
   only generated segment names.
3. **Encode audio once** as AAC, mixed with the soundtrack if one is set
   (`amix duration=first`, limiter), with a fade-out over
   `min(3 s, half the film)`. Output length is pinned to the timeline length,
   so a short soundtrack never shortens the video.

The result is written as `.part`, probed, then renamed. Exports go to
`exports/` with unique names. Previews go to `.shotloom/preview/` with a fresh
name each time, so the browser never shows a cached old preview. Only one
render runs at a time, and scratch files are removed whether it succeeds or
fails.

## Local safety

- The server binds to `127.0.0.1`. Every request's `Host` must be
  localhost/127.0.0.1/[::1] on the app or Vite port (DNS-rebinding guard).
  Writes from another `Origin` are refused, and writes must be
  `application/json`, which blocks simple cross-site form posts.
- Vite binds to `127.0.0.1` with its host check **on**. The reference's
  `allowedHosts: true` was not carried over.
- Path parameters are decoded exactly once. A segment that decodes to `/`,
  `\` or NUL is rejected.
- Film and file names follow Windows rules: no reserved device names, no
  trailing dot or space, no `:` alternate streams.
- **Containment is anchored on the configured films root**, resolved to its
  real location, so a root that is itself a link works.
  - Every filesystem operation on film data goes through
    `FilmStore.guard()`/`filmPath()`. That covers state reads and writes,
    discovery, source and clip serving, generation downloads and deletes,
    sidecars, previews, exports, render scratch cleanup, open-folder, and the
    server lock.
  - Each path must resolve (lexically and via `realpath`) inside that root.
    A path that doesn't exist yet is checked through its nearest existing
    ancestor; a dangling link is refused.
  - Comparison is per path component (`path.relative`, never string prefixes)
    and case-insensitive on Windows.
  - A film folder, or a folder inside it, that is a link or junction leading
    outside the root is refused before anything is read, written or deleted.
- Only intended media is served: discovered sources, recorded outputs by id,
  `preview-<n>.mp4`, and `.mp4` exports. State, config and hidden files never
  are. Range requests are supported for seeking.
- FFmpeg and the file manager are spawned with argument arrays, never through
  a shell.
- `FAL_KEY` exists only in the server process. Status responses expose only
  whether a key is configured.
- The credit balance (`server/system/falBalance.ts`) is read from
  `GET https://api.fal.ai/v1/account/billing?expand=credits` with
  `FAL_BILLING_KEY` if set, otherwise `FAL_KEY`, only in fal mode. The browser
  gets only the number or a message written by Shotloom, never the key or
  fal's raw error text.
