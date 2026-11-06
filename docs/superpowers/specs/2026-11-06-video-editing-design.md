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
project.json   the timeline: clips, trims, order, settings (the only file the editor reads and writes)
assets/        clips imported from the Inbox (copied in)
output/        rendered videos, one file per export, never overwritten
config/        export.json: resolution, fps, codec presets (reusable when templating)
```

`project.json` is versioned (`"version": 1`) and holds ordered clips as
`{ id, asset, in, out }` (seconds into the asset). Writes are atomic (temp file then rename).

## Decisions made with the user

- Files, not SQL, for project state and configuration (templating later).
- Subfolders per project for what's being built, outputs and configuration.
- Server-side ffmpeg export; slice order: skeleton, text, transitions, audio.

## Decisions made by me (change any of these)

- Import copies the file into `assets/` and leaves the Inbox original, so a project is self-contained. Copy, not move, not link.
- Preview plays the asset files directly in the browser (HTML5 video via the existing media route), no proxy files. Formats the browser can't play (some HEVC/MOV) fall back to a generated proxy later, not in slice 1.
- Timeline built in React with pointer events, no editor library. Matches the existing shadcn look.
- Export runs as a background job on the server with progress shown in the UI. Cuts only in slice 1: concat of trimmed clips, normalised to the project resolution and fps (default 1080p, 30 fps).
- Images on the timeline are not supported in slice 1 (video clips only).
- Autosave to `project.json` after each edit, debounced.
- Routes: `/tools/video-editing` (project list), `/tools/video-editing/<project>` (editor). Sidebar "Video Editing" label links to the list.
- Access: a user sees and edits only their own `Projects/<user>/` folder in this tool.
- `project.json` in v1 holds one flat `clips` list: no tracks and no `transitionIn` yet. The file carries `version: 1`, so v2 can migrate it when tracks and transitions arrive.
- `config/export.json` is written when a project is created, but export reads width, height and fps from `project.json`. The config file is kept for export templating later.
- Projects are keyed by the user's display-name folder (`Projects/<display name>/`), the same way User Temp Storage keys its folders.
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
