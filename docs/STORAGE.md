# Storage, backup and restore

## Layout

```
<FILMS_ROOT>/                          default: shotloom/films (set FILMS_ROOT in .env)
  .shotloom/server.lock                stops two servers using one films folder
  <Film name>/
    *.jpg *.png *.webp *.gif           your source images (you manage these)
    *.mp3 *.wav *.m4a *.aac *.ogg *.flac   your soundtrack candidates
    exports/<Film>-YYYYMMDD-HHMMSS.mp4 finished videos (never overwritten)
    .shotloom/
      state.json                       everything you edited (see below)
      state.prev.json                  the previous good state, refreshed on every save
      generations/<id>.mp4             generated clips
      generations/<id>.json            readable metadata per clip (no secrets)
      preview/preview-<n>.mp4          the latest preview only (disposable)
      tmp/                             render scratch (cleared automatically)
```

Shotloom reads only files sitting directly in the film folder. Subfolders,
hidden files and symlinks are ignored.

## What `state.json` holds

It is versioned JSON (`"version": 1`) containing:

- Prompt blocks, with their order and on/off state
- Each shot's description
- Every generation record: provider, model, request id, the requested
  settings, the submitted prompt, any provider-expanded prompt, status and
  errors, output info, and trim
- Timeline order and per-clip mute
- Soundtrack and offset
- Aspect ratio
- Last-used generation settings

Saves are serialized, written to a temporary file, flushed, then renamed
over `state.json`. A crash mid-save therefore leaves either the old file or
the new one, never half of each.

If `state.json` can't be read (invalid JSON, wrong shape, or written by a
newer version), Shotloom **does not reset it**. The film shows an error with
three choices: fix the file, restore the backup, or use
**Start fresh (keeps the old file)**, which renames it
`state.unreadable-<time>.json`.

## Missing images

If you remove or rename a source image, its shot is hidden from the main list
and listed under *“N source images are missing”*. Its description and
generation history are kept, and its clips can still export. Put the file back
under the same name and the shot reconnects.

## Backup

- **One film:** copy the whole film folder, including the hidden `.shotloom`
  folder. On Windows, enable *View → Show → Hidden items* to see it in File
  Explorer, although copying the parent folder includes it either way.
- **Everything:** copy the films root.
- Back up while Shotloom is stopped, or while nothing is generating or
  rendering.
- You can skip `.shotloom/preview` and `.shotloom/tmp`. You can also skip
  `exports/` if you keep exports elsewhere.

## Restore

- **Restore a film:** stop Shotloom, then copy the film folder back into the
  films root.
- **Roll back the last save:** stop Shotloom, then replace `state.json` with
  `state.prev.json`.

## Version control

`.gitignore` excludes `.env`, the default `films/` root, `.shotloom/`
folders, `*.part` files and `dist/`. If you point `FILMS_ROOT` inside a
repository you also commit, exclude it there too. Your media and generated
files should not be committed.
