# HTTP API

Local only: `http://127.0.0.1:8787`. Request and response types live in
`shared/api.ts` and `shared/domain.ts`. Bodies are JSON
(`Content-Type: application/json`) and are validated at runtime.

**Errors** always look like this:

```json
{ "error": { "code": "BAD_REQUEST", "message": "Human-readable explanation", "details": {} } }
```

Common codes:

| Code | Status | Meaning |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | The request or one of its values is invalid |
| `NOT_FOUND` | 404 | The film, shot, clip or file doesn't exist |
| `METHOD_NOT_ALLOWED` | 405 | The path exists, but not for this method |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | The body wasn't sent as JSON |
| `FILM_EXISTS` | 409 | A film with that name already exists |
| `STATE_UNREADABLE` / `STATE_MISSING` | 409 | The film's state file can't be used; nothing was changed |
| `STALE_ORDER` | 409 | A reorder was based on an out-of-date list |
| `JOB_ACTIVE` | 409 | The job is still running and can't be deleted |
| `NOT_RESUMABLE` | 409 | The job can't be resumed |
| `RENDER_BUSY` | 409 | A render is already running |
| `TIMELINE_INVALID` | 400 | The timeline can't be rendered as it stands |
| `QUEUE_FULL` | 429 | Too many jobs are waiting to submit |
| `PROVIDER_UNAVAILABLE` | 503 | Generation isn't available (e.g. no `FAL_KEY`) |
| `PROMPT_CHANGED` | 409 | `expectedPrompt` differs from the server's prompt; nothing was saved or created |
| `PATH_OUTSIDE_ROOT` | 400 | The path goes through a link or junction leading outside the films folder |
| `HOST_NOT_ALLOWED` / `ORIGIN_NOT_ALLOWED` | 403 | The request didn't come from this machine |

Most write routes return the updated **FilmView**:

```ts
{
  name: string;
  state: FilmState;
  sources: { filename: string; generatable: boolean; reason: string | null }[];
  audioFiles: string[];
  render: RenderStatus | null;
}
```

## Routes

`:film` is the URL-encoded film name, `:shot` the URL-encoded image file
name, and `:id` a generation id.

### Status and films

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api/status` | – | `StatusResponse`: provider readiness, active model descriptor, ffmpeg/ffprobe/films-root checks, `falKeyConfigured` (boolean only) |
| GET | `/api/fal/balance` | `?refresh=1` optional | `FalBalanceResponse`: `{ state: "ok", balance, currency, checkedAt }`, `{ state: "off" }` (mock mode or no key), or `{ state: "unavailable", needsBillingKey, message, checkedAt }`. Cached 60 s (10 min after a permission error); `refresh` is honored at most every 10 s. Never contains a key. |
| GET | `/api/films` | – | `{ films: { name }[] }` |
| POST | `/api/films` | `{ name }` | `{ film }` (201); opens the new folder |
| GET | `/api/films/:film` | – | FilmView (also rescans the folder) |
| POST | `/api/films/:film/open-folder` | `{ target: "film" \| "exports" }` | `{ ok }` |
| POST | `/api/films/:film/state/start-fresh` | `{}` | `{ keptAs, view }` |
| PUT | `/api/films/:film/settings` | `{ durationSec, resolution, seed \| null }` | FilmView |

### Prompt blocks

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/api/films/:film/prompt-blocks` | `{ text, enabled? }` | FilmView |
| PATCH | `/api/films/:film/prompt-blocks/:id` | `{ text?, enabled? }` | FilmView |
| DELETE | `/api/films/:film/prompt-blocks/:id` | – | FilmView |
| PUT | `/api/films/:film/prompt-blocks/order` | `{ ids: string[] }` (every id, exactly once) | FilmView |
| POST | `/api/films/:film/prompt-blocks/import` | `{ sourceFilm }` (appends independent copies) | FilmView |

### Shots and generations

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| PATCH | `/api/films/:film/shots/:shot` | `{ text }` | FilmView |
| POST | `/api/films/:film/shots/:shot/generate` | `{ text, settings, count: 1 \| 4, expectedPrompt? }` (with `expectedPrompt`, refused with 409 unless the server's composed prompt matches exactly) | `{ generationIds, view }` (202) |
| PATCH | `/api/films/:film/generations/:id` | `{ trim: { inSec, outSec } \| null }` (`null` = full clip) | FilmView |
| DELETE | `/api/films/:film/generations/:id` | – (completed or failed only) | FilmView |
| POST | `/api/films/:film/generations/:id/resume` | `{}` (re-polls; never resubmits) | FilmView |
| POST | `/api/films/:film/generations/:id/mark-failed` | `{}` (uncertain → failed) | FilmView |

### Timeline, soundtrack and rendering

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/api/films/:film/timeline` | `{ generationId }` (completed; once per generation) | FilmView |
| PUT | `/api/films/:film/timeline/order` | `{ ids: clipId[] }` | FilmView |
| PATCH | `/api/films/:film/timeline/:clipId` | `{ muted }` | FilmView |
| DELETE | `/api/films/:film/timeline/:clipId` | – | FilmView |
| PUT | `/api/films/:film/soundtrack` | `{ filename \| null, offsetSec ≥ 0 }` | FilmView |
| PUT | `/api/films/:film/aspect-ratio` | `{ aspectRatio: "16:9" \| "1:1" \| "9:16" }` | FilmView |
| POST | `/api/films/:film/render` | `{ kind: "preview" \| "export" }` | `RenderStatus` (202); progress appears in `FilmView.render` |

## Media

All media routes support `Range` requests.

| Path | Serves |
| --- | --- |
| `/media/:film/source/:file` | A discovered image or audio file in the film folder |
| `/media/:film/gen/:id` | The output of a completed generation |
| `/media/:film/preview/preview-<n>.mp4` | The current preview (`Cache-Control: no-store`) |
| `/media/:film/exports/<name>.mp4` | A finished export |

Nothing else under a film is reachable over HTTP.
