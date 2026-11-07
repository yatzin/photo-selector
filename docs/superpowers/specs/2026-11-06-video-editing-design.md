# Video Editing tool: design

## Intent

Users send phone photos and videos to the Video Editing Inbox (done). This tool
turns them into finished videos inside the app: pick clips, arrange them on a
timeline, trim them, add text and transitions, export a new video. It should
feel like a polished consumer editor (iPhone / CapCut class), not a form.

## Goals

- Multiple projects per user. Open, create, rename, delete.
- Import clips from the Inbox into a project; see them in a small file tree on the left.
- Drag clips onto a timeline, trim either edge with drag handles (live frame preview), reorder, split.
- Preview with play, pause and scrub, instant while editing.
- Export the timeline to an MP4 on the server.
- Projects are plain folders and files, so they can be copied and used as templates later.

## Non-goals (this design covers slice 1 only)

- Text overlays, transitions, audio, animations: later slices (2 text, 3 transitions, 4 audio). The file format and timeline model must leave room for them (a `tracks` list, per-clip `transitionIn`), but nothing for them is built now.
- Collaboration, real-time multi-user editing of one project.
- Mobile layout. Desktop browser first.

## Anti-goals

- A form-style UI with number inputs for trim times.
- Re-encoding while editing. Preview must never wait on ffmpeg.
- Losing a user's work: autosave, and export never overwrites a previous output.

## Layout of a project

`Projects/<user>/<project>/` (user folder name from `tempFolderName`; project folder name is the project name, cleaned the same way):

```
project.json   the timeline: tracks, clips, trims, order, settings (the only file the editor reads and writes)
assets/        clips imported from the Inbox (copied in)
output/        the latest rendered video and .export-state.json (see Decisions)
config/        export.json: resolution, fps, codec presets (reusable when templating)
```

`project.json` is versioned (`"version": 2`) and holds `tracks`, each
`{ id, muted?, clips }`, with clips as `{ id, asset, in, out, start? }`
(seconds into the asset; `start` is the timeline position, on overlay tracks
only). A version 1 file (one flat `clips` list) is read as version 2 with
those clips on the base track `t1`, and saved as version 2 from then on.
Writes are atomic (temp file then rename).

## Decisions made with the user

- Files, not SQL, for project state and configuration (templating later).
- Subfolders per project for what's being built, outputs and configuration.
- Server-side ffmpeg export; slice order: skeleton, text, transitions, audio.

## Decisions made by me (change any of these)

- Import copies the file into `assets/` and leaves the Inbox original, so a project is self-contained. Copy, not move, not link.
- Preview plays the asset files directly in the browser (HTML5 video via the existing media route), no proxy files. Formats the browser can't play (some HEVC/MOV) fall back to a generated proxy later, not in slice 1.
- Timeline built in React with pointer events, no editor library. Matches the existing shadcn look.
- Export runs as a background job on the server with progress shown in the UI. Cuts only in slice 1: concat of trimmed clips, normalised to the project resolution and fps (default 1080p, 30 fps).
- Images on the timeline are supported. An image asset has `kind: "image"`; its clip starts at 5 s (`DEFAULT_IMAGE`) and stretches from 0.2 s to 10 minutes (`MAX_IMAGE`), with `in` always 0. Export loops the converted preview still for the clip's length with silence; the browser preview shows it as an image on the clock.
- An imported asset records its Inbox path as `source`. Importing the same Inbox file again (Import button or dragging it onto the timeline) reuses that asset while its file is still in `assets/`, instead of copying it again.
- Autosave to `project.json` after each edit, debounced.
- Routes: `/tools/video-editing` (project list), `/tools/video-editing/<project>` (editor). Sidebar "Video Editing" label links to the list.
- Access: a user sees and edits only their own `Projects/<user>/` folder in this tool.
- ~~`project.json` in v1 holds one flat `clips` list.~~ Superseded: version 2 has `tracks` (layers), up to 4 (`MAX_TRACKS`). Track 0 is the base: magnetic, clips end to end, edits ripple. Tracks 1 to 3 are overlays: clips sit at their own `start`, gaps allowed, no overlaps (a drop or move slides to the next free slot after the clip it would overlap). A higher track draws over a lower one, opaque and full frame (letterboxed, no position, scale or opacity yet); every unmuted track's audio is mixed. The timeline's length is the latest clip end on any track. Undo covers `{ tracks }`, mute toggles included. `transitionIn` still isn't there.
- Export with layers: the base track is concatenated as before (a single-track project exports exactly as it did), laid over a black canvas the timeline's length, and each overlay clip, shifted to its start, overlaid in track order with `enable=between(t,start,end)`. Audio mixes the base track and each unmuted overlay clip (delayed with `adelay`) over silence the timeline's length (`amix`, `normalize=0`).
- Preview with layers: each track has its own pair of video elements (8 at most); all play from one clock, the topmost track with a clip is shown and the others are heard. The lowest track playing a healthy video drives the clock; other tracks are re-seeked if they drift more than 0.3 s.
- `config/export.json` is written when a project is created, but export reads width, height and fps from `project.json`. The config file is kept for export templating later.
- Projects are keyed by the user's display-name folder (`Projects/<display name>/`), the same way User Temp Storage keys its folders.
- ~~Outputs are kept per export, never overwritten.~~ Superseded: `output/` keeps one copy. A successful export writes `output/.export-state.json` (`{ file, fingerprint, createdAt }`, the fingerprint a SHA-256 of what affects the video: size, fps, tracks and the used assets) and deletes every other file in `output/`; a failed one changes nothing. An export whose fingerprint matches a copy still there reuses it without running ffmpeg. Either way the browser downloads the copy from `/api/video-projects/<project>/download`.
- In the library, Video Editing Projects is read-only: no move, delete or rotate, and Move to Video Editing/Temp only copies from it. The editor owns those files.

## Constraints

- Next.js in this repo has breaking changes: read `node_modules/next/dist/docs/` before writing routes, actions or route handlers.
- Follow existing patterns: server actions in `lib/actions/`, `*-server.ts` for disk code, `resolveInside` for every user-supplied path, no clobbering writes.
- Feature work stays on `feat/video-editing`. Nothing is committed unless the user asks.
- ffmpeg path comes from `FFMPEG_PATH` as in `lib/thumbs-server.ts`.

## Left to the builder

- Timeline component structure, zoom behaviour, snapping, keyboard shortcuts.
- The export job runner and how progress reaches the UI (polling is fine).
- Test strategy: unit tests for project.json read/write and the timeline model, and for the ffmpeg command builder; manual check in the browser for the drag and trim feel.
