# Video Editing Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can create projects, import Inbox clips, arrange and trim them on a timeline, preview, and export an MP4.

**Architecture:** Project state lives as files under the `video-projects` root (`<user>/<project>/project.json` plus `assets/`, `output/`, `config/`). A pure timeline model (`lib/video/`) holds all edit math and is unit tested. Server code (`lib/video/*-server.ts`) reads and writes project folders and runs ffmpeg; server actions expose it. The editor is a client component that edits an in-memory project, autosaves it, and previews by playing asset files through the existing `/api/media/<root>/<path>?v=original` route.

**Tech Stack:** Next.js (breaking-change version, see constraints), React, TypeScript, Vitest, ffmpeg via `FFMPEG_PATH`, existing shadcn components and lucide icons.

**Spec:** `docs/superpowers/specs/2026-11-06-video-editing-design.md`

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing any route, page or server action (AGENTS.md).
- Work on branch `feat/video-editing`. Do not commit unless the user asks (user CLAUDE.md); the commit steps below are "leave staged-free, report changed files" instead. Never push.
- Project folder: `Projects/<user>/<project>/` containing `project.json`, `assets/`, `output/`, `config/export.json`. User folder name from `tempFolderName(name, email)`.
- `project.json` has `"version": 1`; writes are atomic (temp file then rename); outputs never overwrite (use `numberedName`).
- Every user-supplied path goes through `safeSegments` / `resolveInside` (`lib/media.ts`).
- Import copies from `video-inbox` into `assets/`; the Inbox original stays.
- Defaults: 1920x1080, 30 fps. Video clips only, cuts only in slice 1.
- A user only sees and edits their own `Projects/<user>/` folder.
- Preview never calls ffmpeg. ffmpeg path from `FFMPEG_PATH`, else `ffmpeg` (as `lib/thumbs-server.ts`).
- Code style: no semicolons, double quotes, 2 spaces, `import "server-only"` on server modules, as in existing files.
- Verify with `npx tsc --noEmit`, `npm run lint`, `npm test` after each task.

## Review Focus

- Source file deleted or missing on disk: project still opens, clip shows as missing, export fails with a clear message (Task 2, Task 8).
- Two project names that clean to the same folder name, or a name with `..`, `/`, trailing dots: second create is rejected, nothing escapes the user folder (Task 2).
- Clip with no audio stream in the export: output still has continuous audio, no ffmpeg error (Task 8).
- Phone videos shot portrait (rotated metadata) or at another size/fps: export normalises to 1920x1080 30 fps with letterbox, not stretch (Task 8).
- Trim to zero or negative length, trim past the source duration, split at the clip edge: model refuses or clamps, never produces a clip with `out <= in` (Task 1).
- Two autosaves in flight at once: last write wins, `project.json` is never half-written (Task 2).
- Browser can't decode a clip (HEVC): preview shows a "can't preview this clip" tile, export still works (Task 7).

---

### Task 1: Timeline model

**Files:**
- Create: `lib/video/project.ts`
- Test: `lib/video/project.test.ts`

**Interfaces:**
- Produces:
  - `type Asset = { file: string; duration: number; hasAudio: boolean }` (`file` is the name inside `assets/`)
  - `type Clip = { id: string; asset: string; in: number; out: number }` (`asset` is the key into `assets`; seconds)
  - `type Project = { version: 1; name: string; width: number; height: number; fps: number; assets: Record<string, Asset>; clips: Clip[] }`
  - `MIN_CLIP = 0.2` (seconds)
  - `newProject(name: string): Project`
  - `clipLength(c: Clip): number`
  - `clipStarts(clips: Clip[]): number[]` (start time of each clip on the timeline)
  - `totalLength(clips: Clip[]): number`
  - `addClip(p: Project, assetId: string, at: number, id: string): Project` (inserts at index `at`, full asset length)
  - `trimClip(p: Project, id: string, edge: "in" | "out", seconds: number): Project` (seconds = new source time; clamped to `[0, asset.duration]` and keeping `out - in >= MIN_CLIP`)
  - `splitClip(p: Project, id: string, timelineTime: number, newId: string): Project` (no-op when the point is within `MIN_CLIP` of either edge)
  - `moveClip(p: Project, id: string, toIndex: number): Project`
  - `removeClip(p: Project, id: string): Project`
  - `parseProject(json: unknown): Project | null` (null when version/shape is wrong)
  - All functions are pure and return new objects.

- [ ] **Step 1: Write failing tests** in `lib/video/project.test.ts`: `clipStarts` of clips lengths 3 and 2 is `[0, 3]`; `trimClip` "in" past `out - MIN_CLIP` clamps to `out - MIN_CLIP`; `trimClip` "out" past asset duration clamps to duration; negative seconds clamp to 0; `splitClip` at 1.0 of a 0..3 clip gives clips 0..1 and 1..3 with the second keyed `newId`; split 0.1s from an edge returns the project unchanged; `moveClip` to the end reorders; `parseProject` returns null for `{version: 2}` and for clips referencing an unknown asset; `newProject` defaults are 1920, 1080, 30.
- [ ] **Step 2: Run** `npx vitest run lib/video/project.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the functions above in `lib/video/project.ts` (no I/O, no imports from server modules).
- [ ] **Step 4: Run** the test file. Expected: all PASS. Then `npx tsc --noEmit`.

### Task 2: Project store (disk)

**Files:**
- Create: `lib/video/projects-server.ts`
- Modify: `lib/media.ts` (add `projectFolderName(name: string): string`, same cleaning rules as `tempFolderName`, falling back to `"Untitled"`)
- Test: `lib/video/projects-server.test.ts`, `lib/media.test.ts` (add cases)

**Interfaces:**
- Consumes: Task 1 `Project`, `newProject`, `parseProject`; `rootPath("video-projects")`, `rootPath("video-inbox")` from `lib/library-server`; `numberedName`, `resolveInside`, `mediaKind` from `lib/media`; `moveNoClobber`-style copy helpers are not reused, write a small `copyInto`.
- Produces (all `async`, `userFolder: string` first param):
  - `listProjects(userFolder): Promise<{ folder: string; name: string; clips: number; modified: number }[]>`
  - `createProject(userFolder, name): Promise<{ folder: string } | { error: string }>` (creates `assets/`, `output/`, `config/export.json` `{ "width": 1920, "height": 1080, "fps": 30 }`, `project.json`; error when the cleaned folder exists)
  - `readProject(userFolder, folder): Promise<Project | null>`
  - `writeProject(userFolder, folder, p: Project): Promise<void>` (atomic: write `project.json.<rand>.tmp`, rename)
  - `renameProject(userFolder, folder, name): Promise<{ folder: string } | { error: string }>` (renames the directory and updates `name` in `project.json`)
  - `deleteProject(userFolder, folder): Promise<void>`
  - `importAsset(userFolder, folder, inboxFolder: string[], fileName: string): Promise<{ id: string; asset: Asset } | { error: string }>` (copies from `video-inbox/<inboxFolder>/<fileName>` into `assets/` without clobbering, probes duration and audio via `probeMedia`, see ordering note)
  - `assetPath(userFolder, folder, file): string | null`

**Ordering note:** `probeMedia` lives in `lib/video/ffmpeg-server.ts` (Task 2 creates it with only `probeMedia(file: string): Promise<{ duration: number; hasAudio: boolean }>`, parsing `ffmpeg -i` stderr for `Duration:` and an `Audio:` stream; Task 8 adds export to the same file).

- [ ] **Step 1: Write failing tests** (temp dir via `PHOTOS_TEMP_DIR`-style env: set `PHOTOS_VIDEO_PROJECTS_DIR` and `PHOTOS_VIDEO_INBOX_DIR` to temp folders, as `lib/file-ops-server.test.ts` does): create makes the four entries; creating "My Trip" twice returns `{ error }`; names `"../x"`, `"a/b"`, `"trip. "` produce folders inside the user folder; `readProject` of a hand-corrupted `project.json` returns null; 20 concurrent `writeProject` calls leave a parseable file and no `.tmp`; `importAsset` copies the file, leaves the Inbox original, a second import of the same name gets `" (1)"`; `listProjects` returns clip counts; `projectFolderName` cases in `lib/media.test.ts`.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement** `projectFolderName`, `ffmpeg-server.ts` (`probeMedia`, using `execFile` with the same `FFMPEG_PATH` logic), and `projects-server.ts`. Tests mock `probeMedia` with `vi.mock`.
- [ ] **Step 4: Run** tests, `tsc`, lint. Expected: PASS.

### Task 3: Server actions

**Files:**
- Create: `lib/actions/video-projects.ts`
- Test: none beyond Task 2 (thin wrappers); verified by Task 4's manual check.

**Interfaces:**
- Consumes: Task 2 store functions; `auth`, `prisma`, `tempFolderName` as `lib/actions/temp.ts` does.
- Produces (`"use server"`, each calls `requireUser()` then derives `userFolder` from the session user, never from input):
  - `createProjectAction(name: string): Promise<{ folder: string } | { error: string }>`
  - `renameProjectAction(folder: string, name: string)`
  - `deleteProjectAction(folder: string)`
  - `saveProjectAction(folder: string, project: unknown): Promise<{ ok: true } | { error: string }>` (validates with `parseProject`)
  - `importAssetAction(folder: string, inboxFolder: string[], fileName: string)`
  - `listInboxAction(): Promise<{ folder: string; files: { name: string; size: number }[] }[]>` (the current user's own Inbox folder first, then others; videos only via `mediaKind(name) === "video"`)
  - All validate with zod and `safeSegments`; return `{ error }` instead of throwing.

- [ ] **Step 1:** Read `node_modules/next/dist/docs/` guide on server actions; confirm `"use server"` file rules still match `lib/actions/temp.ts`.
- [ ] **Step 2: Implement** the actions above.
- [ ] **Step 3: Run** `npx tsc --noEmit` and `npm run lint`. Expected: clean.

### Task 4: Routes and navigation

**Files:**
- Create: `app/(app)/tools/video-editing/page.tsx` (project list: cards, "New project" dialog, rename, delete with confirm)
- Create: `components/video/project-list.tsx` (client component)
- Modify: `components/sidebar.tsx` (the "Video Editing" label becomes a link to `/tools/video-editing`; Inbox and Projects sub-links stay)

**Interfaces:**
- Consumes: Task 3 actions; `listProjects` for the server-rendered list.
- Produces: route `/tools/video-editing`; opening a card goes to `/tools/video-editing/<folder>` (Task 5).

- [ ] **Step 1:** Read the Next.js docs for pages and dynamic `params` (promise-based, as `app/(app)/library/[root]/[[...path]]/page.tsx` does).
- [ ] **Step 2: Implement** the page and list component; empty state text "No projects yet. Create one to start editing."; creating navigates to the editor.
- [ ] **Step 3: Verify** `tsc`, lint, then manual: create, rename, delete a project in the running app; folders appear under `.data/VideoEditing/Projects/<user>/`.

### Task 5: Editor shell

**Files:**
- Create: `app/(app)/tools/video-editing/[project]/page.tsx` (server: load project, 404 if null)
- Create: `components/video/editor.tsx` (client: layout, state, autosave)
- Create: `components/video/file-tree.tsx` (left: Inbox files and project Assets)
- Create: `components/video/timeline.tsx` (bottom, render only in this task)
- Create: `components/video/use-autosave.ts`

**Interfaces:**
- Consumes: Task 1 model; Task 3 actions; `mediaUrl` from `lib/format`.
- Produces:
  - `Editor({ folder, initial }: { folder: string; initial: Project })`
  - `useAutosave(folder: string, project: Project): "saved" | "saving" | "error"` (debounce 800 ms, skips first render, flushes on unmount)
  - `FileTree` props `{ inbox: InboxFolder[]; project: Project; onImport(folder: string[], name: string): void; onDragStartAsset(assetId: string): void }`
  - `Timeline` props `{ project: Project; selectedId: string | null; playhead: number; onSelect(id: string | null): void; onChange(p: Project): void; onSeek(t: number): void; zoom: number }`

Layout: left tree (240 px), centre preview (aspect 16:9, black), bottom timeline (ruler, one video track of clips with thumbnails, playhead), top bar (back, project name, save state, Export button wired in Task 8). The editor fills the viewport under the header; the `main` padding is removed on this route with a negative margin or a wrapper height, no layout rewrite.

- [ ] **Step 1: Implement** the files above; clips render as rounded blocks sized `clipLength * zoom` px with a thumbnail from `mediaUrl("video-projects", [user, folder, "assets"], file, "thumb", ...)`.
- [ ] **Step 2: Verify** manual: open a project, import an Inbox clip via a button in the tree (drag comes in Task 6), see the asset listed; reload the page, state persists; `tsc` and lint clean.

### Task 6: Timeline interactions

**Files:**
- Create: `lib/video/timeline-math.ts`
- Test: `lib/video/timeline-math.test.ts`
- Modify: `components/video/timeline.tsx`, `components/video/file-tree.tsx`, `components/video/editor.tsx`

**Interfaces:**
- Consumes: Task 1 model functions.
- Produces:
  - `pxToTime(px: number, zoom: number): number`, `timeToPx(t: number, zoom: number): number`
  - `dropIndex(clips: Clip[], timelineTime: number): number` (index where a dragged clip lands, by nearest clip midpoint)
  - `trimDelta(edge: "in" | "out", clip: Clip, deltaPx: number, zoom: number): number` (new source time for the edge being dragged)
  - Editor behaviour: drag an asset from the tree onto the timeline (`addClip`), drag clip body to reorder (`moveClip`), drag left/right edge handles to trim (`trimClip`, live thumbnail of the edge frame in the preview), `S` splits at the playhead, `Delete` removes the selection, `Space` plays/pauses, zoom slider.

- [ ] **Step 1: Write failing tests** for `pxToTime`/`timeToPx` round trip, `dropIndex` before the first midpoint is 0 and after the last is `clips.length`, `trimDelta` for the "in" edge dragged right by 100 px at zoom 50 adds 2 s to `in`.
- [ ] **Step 2: Run** `npx vitest run lib/video/timeline-math.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `timeline-math.ts`; then wire pointer events (use `setPointerCapture`) in `timeline.tsx` with rounded handles, snap to neighbouring clip edges within 6 px, and spring-eased reorder (CSS transform transitions).
- [ ] **Step 4: Run** tests, `tsc`, lint. Manual check: all interactions above work with mouse; trimming never goes below `MIN_CLIP` or past the source.

### Task 7: Preview playback

**Files:**
- Create: `components/video/use-preview-player.ts`
- Create: `components/video/preview.tsx`
- Test: `lib/video/playback.test.ts` with pure helper `clipAt(clips: Clip[], timelineTime: number): { index: number; sourceTime: number } | null` added to `lib/video/project.ts`

**Interfaces:**
- Consumes: Task 1 `clipStarts`, `clipLength`; Task 5 `Editor` state.
- Produces:
  - `clipAt` (above; end of timeline returns null)
  - `usePreviewPlayer(project: Project, urlFor: (assetId: string) => string): { playing: boolean; time: number; play(): void; pause(): void; seek(t: number): void; videoRef: RefObject<HTMLVideoElement | null>; failed: Set<string> }`
  - Behaviour: one `<video>` element; on clip boundary swap `src` and seek to `in`; pre-create a hidden second video for the next clip to avoid a gap; when a `<video>` errors, add the asset id to `failed` and the preview shows "Can't preview this clip, it will still export."

- [ ] **Step 1: Write failing tests** for `clipAt`: time 0 gives index 0 sourceTime = clip `in`; time at the boundary between clips 0 and 1 gives index 1; time at total length gives null.
- [ ] **Step 2: Run** `npx vitest run lib/video/playback.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `clipAt`, the hook and `preview.tsx`; playhead in the timeline follows `time` via `requestAnimationFrame`; scrubbing the ruler calls `seek`.
- [ ] **Step 4: Run** tests, `tsc`, lint. Manual: play three clips end to end with no visible gap; scrub; a clip the browser can't decode shows the message.

### Task 8: Export

**Files:**
- Modify: `lib/video/ffmpeg-server.ts` (add `buildExportArgs`, `runExport`)
- Create: `lib/video/export-jobs-server.ts` (in-memory job table on `globalThis`, like `__psRootCounts` in `lib/library-server.ts`)
- Modify: `lib/actions/video-projects.ts` (add `startExportAction`, `exportStatusAction`)
- Modify: `components/video/editor.tsx` (Export button, progress, link to the output)
- Test: `lib/video/ffmpeg-server.test.ts`

**Interfaces:**
- Consumes: Task 1 `Project`; Task 2 `assetPath`, `probeMedia`, `numberedName`.
- Produces:
  - `buildExportArgs(p: Project, files: Record<string, string>, outFile: string): string[]` (pure; `files` maps asset id to absolute path)
  - `startExportAction(folder: string): Promise<{ jobId: string } | { error: string }>`
  - `exportStatusAction(jobId: string): Promise<{ state: "running" | "done" | "failed"; progress: number; output?: string; error?: string }>` (progress 0..1 from ffmpeg `-progress pipe:1` `out_time_ms` over `totalLength`; polled every second by the UI)
  - Output file `output/<project name> <yyyy-mm-dd hh-mm>.mp4`, numbered if taken; written to a `.tmp` name and renamed when ffmpeg exits 0.

Export filtergraph per clip: `[i:v]trim=in:out,setpts=PTS-STARTPTS,scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=FPS[v i]`; audio `[i:a]atrim=in:out,asetpts=PTS-STARTPTS,aresample=48000[a i]`, or for an asset with `hasAudio: false` `anullsrc=r=48000:cl=stereo,atrim=0:LEN,asetpts=PTS-STARTPTS[a i]`; then `concat=n=N:v=1:a=1`; codec `libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart`. ffmpeg auto-rotates portrait phone video on input, so scale/pad after it gives the letterbox.

- [ ] **Step 1: Write failing tests** for `buildExportArgs`: two clips produce `concat=n=2:v=1:a=1`; a clip with `hasAudio: false` produces an `anullsrc` segment and no `[i:a]` reference for it; trim values appear as `trim=1:3`; scale target is `1920:1080` with `pad`; a project with zero clips returns an error (make the function throw `Error("Nothing to export")`, and `startExportAction` returns `{ error }`).
- [ ] **Step 2: Run** `npx vitest run lib/video/ffmpeg-server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `buildExportArgs`, `runExport` (spawn, parse progress, kill on failure and remove the `.tmp`), the job table, the two actions, and the UI. A missing asset file makes `startExportAction` return `{ error: "<name> is missing from the project's assets." }` before spawning.
- [ ] **Step 4: Run** tests, `tsc`, lint. Manual: export the three-clip sample project from `dev-photos`; the output plays, has the expected length and audio, and an earlier output is untouched by a second export.

### Task 9: Docs and final check

**Files:**
- Modify: `README.md` (Video Editing section: folders, project layout, export), `.env.example` (nothing new expected; confirm)
- Run: `docufix` skill for the docs.

- [ ] **Step 1:** Add the README section describing Tools > Video Editing, the project folder layout and slice-1 limits (video only, cuts only).
- [ ] **Step 2:** Run `npx tsc --noEmit`, `npm run lint`, `npm test`. Expected: all clean. Report results and the "Left open" list (slices 2 to 4).
