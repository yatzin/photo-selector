# Stock Media Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Stock" tab beside Personal Storage in the video editor's media panel that searches CC0/public-domain and attribution-free media (Openverse, Pixabay, Pexels), downloads dropped results into the project, and add a per-clip Loop option for videos (GIFs default to loop on).

**Architecture:** Provider clients live in `lib/stock/` behind one `StockClient` interface; the browser only talks to our own search route and a download server action, so keys and the licence gate stay server-side. A dropped result is downloaded (SSRF-guarded, capped) into the project's assets through the existing import pipeline, then behaves like any asset. Looping is a per-clip flag; preview and export both consume `expandLoops(project)`, a pure function that rewrites looping clips into back-to-back copies, so neither engine needs loop logic of its own.

**Tech Stack:** Next.js (non-standard version, see constraints), React, TypeScript, Prisma 7 + SQLite (libsql adapter), zod, vitest, ffmpeg via `FFMPEG_PATH`.

**Spec:** `docs/superpowers/specs/2026-11-11-stock-media-tab-design.md`

## Global Constraints

- This is not the Next.js you know: before writing any route handler, server action or page code, read the relevant guide in `node_modules/next/dist/docs/` (AGENTS.md).
- **Licence (REQUIRED):** Openverse is always queried with `license=cc0,pdm`; results whose `license` is not `cc0` or `pdm` are dropped server-side and refused again at download. Anything needing attribution must never be offered or importable.
- Video stock downloads use the 1080p rendition (closest at or below 1080p; if none, the smallest above).
- Stock downloads: max 1 GB, 10 minute timeout, https only, private/loopback/link-local addresses refused (re-checked after every redirect), only URLs the server got from a provider API response are fetched (the browser sends `{source,id,kind}`, never a URL).
- Keys are encrypted with `lib/secret-box.ts` and never sent to the browser. Settings → Stock Media is admin only; any signed-in user may search.
- Videos default to loop OFF; GIFs (converted to mp4) are added with loop ON.
- Tests never call live provider APIs: use a local `http.createServer` fake like `lib/ai/client.test.ts`. vitest only runs `lib/**/*.test.ts`, so keep logic in `lib/` and UI thin.
- No commits: the user commits when ready. Leave changes in the working tree. Never add AI attribution anywhere. Subagents must not commit either.
- After code or dependency changes run `npx prisma generate`, `npx tsc --noEmit`, `npm run lint`, `npm test` before reporting done.
- Work stays on branch `feat/temporary`.

## Review Focus

1. Openverse result with licence `by`/`by-sa` (or missing licence) must never reach the browser or be downloaded. (Task 7, Task 11)
2. A provider redirect or API URL pointing at `127.0.0.1`/`10.x`/`169.254.x` must be refused. (Task 10)
3. Existing projects (no `loop` field) must load unchanged; turning loop off on a clip longer than its source clamps it to the source length. (Task 1)
4. One provider failing or rate-limited must not blank the results from the others. (Task 9)
5. Dropping the same stock result twice, or two at once, must produce one asset. (Task 11)

---

## File Structure

- Modify `lib/video/project.ts` — `Clip.loop`, `Asset.loopByDefault`, parse/validate, `setClipLoop`, stretch rules, `expandLoops`.
- Modify `lib/video/ffmpeg-server.ts`, `components/video/use-preview-player.ts` (+ other Project→ffmpeg modules) — consume `expandLoops`.
- Modify `components/video/timeline.tsx`, `components/video/preview.tsx`, `components/video/file-tree.tsx`, `components/video/editor.tsx` — Loop menu item, stock drag type, tab bar.
- Create `lib/stock/types.ts`, `licence.ts`, `config.ts`, `openverse.ts`, `pixabay.ts`, `pexels.ts`, `search.ts`, `download.ts`, `gif.ts` (+ `.test.ts` each).
- Create `lib/video/stock-import-server.ts`, `lib/actions/stock.ts`, `app/api/stock/search/route.ts`.
- Create `lib/actions/stock-settings.ts`, `lib/stock/settings-schema.ts`, `components/settings/stock-settings.tsx`; modify `lib/settings-sections.ts` (+test), `app/(app)/settings/page.tsx`, `prisma/schema.prisma`, new migration.
- Create `components/video/stock-panel.tsx`.

Note: "Personal Storage" is the lower half of the left Media `<aside>` inside `FileTree` (`file-tree.tsx`, below the `ResizeHandle`), not a separate window. The tab bar goes at the top of that lower half.

---

### Task 1: Loop flag in the project model

**Files:**
- Modify: `lib/video/project.ts` (types ~16/36, `addClip` ~662, `tailHandle` ~281, `headHandle` ~288, `trimClip` ~732, `parseProject` ~916-1015), `lib/video/clip-timing.ts`
- Test: `lib/video/project.test.ts` (extend; create if absent)

**Interfaces:**
- Produces: `Clip.loop?: true`; `Asset.loopByDefault?: true`; `setClipLoop(p: Project, clipId: string, loop: boolean): Project`; `isLooping(p: Project, c: Clip): boolean` (true for a video clip with `loop`).
- Rules: a looping clip has `in === 0` and `out` up to `MAX_TIMELINE` (stretchable like a still: `tailHandle` = `Infinity`, `headHandle` = 0). `setClipLoop(…, true)` sets `out = out - in`, `in = 0`; `setClipLoop(…, false)` clamps `out` to `asset.duration`. Loop applies only to video-kind assets (no-op for image/audio/text). `addClip` on an asset with `loopByDefault` creates `loop: true`, `out = DEFAULT_IMAGE`.

- [ ] **Step 1: Write failing tests** in `lib/video/project.test.ts`: `parseProject` round-trips a clip with `loop: true` and `out > asset.duration`; a clip without `loop` and `out > asset.duration` is still rejected; a looping clip with `in > 0` is rejected; `setClipLoop(p,id,true)` on a 10 s source clip `in=2,out=6` gives `in=0,out=4,loop=true`; `setClipLoop(p,id,false)` on `out=25` with duration 10 gives `out=10`; `setClipLoop` on an image clip returns the project unchanged; `addClip` with an asset `{loopByDefault:true,duration:2}` gives `loop:true,out:5`; `tailHandle` of a looping clip is `Infinity`.
- [ ] **Step 2: Run** `npx vitest run lib/video/project.test.ts` — expect FAIL (missing exports/fields).
- [ ] **Step 3: Implement** the types, `isLooping`, `setClipLoop`, the `addClip`/`tailHandle`/`headHandle`/`trimClip`/`setClipTiming` changes, and `parseProject` validation (keep `loop` and `loopByDefault` only when `true`; replace the `out <= asset.duration` check for looping clips with `in === 0 && out <= MAX_TIMELINE`). Absent flags must parse exactly as today.
- [ ] **Step 4: Run** `npx vitest run lib/video/project.test.ts` — expect PASS, and `npx vitest run lib/video` to confirm nothing else broke.

### Task 2: `expandLoops`

**Files:**
- Modify: `lib/video/project.ts`
- Test: `lib/video/project.test.ts`

**Interfaces:**
- Consumes: `isLooping` (Task 1).
- Produces: `expandLoops(p: Project): Project` — pure; returns `p` itself (same reference) when no clip loops past its source. A looping clip of length L on a source of duration D becomes `ceil(L/D)` clips on the same track: copy `n` has `start = c.start + n*D`, `in = 0`, `out = min(D, L - n*D)`, id `${c.id}~${n}` (copy 0 keeps `c.id`), no `loop`. In-side fields (`edgeIn`, in-transition) stay on copy 0, out-side fields (`edgeOut`) on the last copy; all other per-clip settings (transform, muted, audio levels) copy to every copy.

- [ ] **Step 1: Write failing tests:** a loop clip `start=3,out=25` on D=10 expands to three clips `[3..13)`,`[13..23)`,`[23..25)` with `in=0` and outs `10,10,2`; total length equals the original; no clip has `loop`; ids unique; a project with no loop clips returns the identical reference; a loop clip with `out <= D` returns a single clip; other tracks and clips are untouched.
- [ ] **Step 2: Run** `npx vitest run lib/video/project.test.ts -t expandLoops` — expect FAIL.
- [ ] **Step 3: Implement** `expandLoops` per the rules above.
- [ ] **Step 4: Run** the same command — expect PASS.

### Task 3: Preview and export honour loops

**Files:**
- Modify: `components/video/use-preview-player.ts`, `lib/video/ffmpeg-server.ts` (`buildExportGraph` ~594, `buildExportArgs` ~696), and every other module that builds ffmpeg args from a `Project` (find with `grep -rn "Project" lib/video/*-server.ts lib/video/audio-*.ts`, e.g. `audio-preview-server`, `audio-export`, `audio-levels-export`).
- Test: `lib/video/ffmpeg-server.test.ts` (extend)

**Interfaces:**
- Consumes: `expandLoops(p: Project): Project`.
- Produces: no new exports. Rule: call `expandLoops` once at the entry where a `Project` is turned into playback state or ffmpeg input (memoized in the preview hook; the editor's stored project is never mutated).

- [ ] **Step 1: Write failing test:** `buildExportGraph(looped, files)` deep-equals `buildExportGraph(expandLoops(looped), files)` for a 25 s loop of a 10 s video, and `buildExportArgs` for it references the asset file three times or once with three segments (whatever the existing builder does for three adjacent clips of one asset).
- [ ] **Step 2: Run** `npx vitest run lib/video/ffmpeg-server.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** by applying `expandLoops` at each entry point listed above; in `use-preview-player.ts` wrap the incoming project in `useMemo(() => expandLoops(project), [project])`.
- [ ] **Step 4: Run** `npx vitest run lib/video` — expect PASS.

### Task 4: Loop item in the clip menu

**Files:**
- Modify: `components/video/timeline.tsx` (`menuItems` ~1052)

**Interfaces:**
- Consumes: `setClipLoop`, `isLooping`, `assetKind` (project.ts).
- Produces: a `ClipMenuItem` `{label: "Loop", checked: isLooping(...), onSelect}` shown only for video-kind clips, placed after "Edit length...". "Split at playhead" is disabled while a clip loops (user turns loop off first; my call, spec silent).

- [ ] **Step 1: Implement** the menu item calling `onChange(p => setClipLoop(p, clip.id, !isLooping(p, clip)))`, and disable "Split at playhead" for looping clips (also guard the `S` key path).
- [ ] **Step 2: Verify** `npx tsc --noEmit` and `npm run lint` pass; then `npm run dev`, open a video project, right-click a video clip: "Loop" appears with a check mark when on; drag its right edge past the source length (allowed only when on); turn it off (clip shrinks to source length); play the preview across a repeat seam and export a 3-repeat clip, confirming three repeats.

### Task 5: Stock settings storage

**Files:**
- Modify: `prisma/schema.prisma`; create `prisma/migrations/20261111120000_stock_settings/migration.sql`
- Create: `lib/stock/config.ts`, `lib/stock/settings-schema.ts`
- Test: `lib/stock/settings-schema.test.ts`

**Interfaces:**
- Produces: Prisma model `StockSettings { id @default("singleton"); pixabayKeyEnc String?; pexelsKeyEnc String?; openverseClientId String?; openverseClientSecretEnc String?; updatedAt @updatedAt }`.
  `STOCK_SETTINGS_ID = "singleton"`; `loadStockConfig(): Promise<StockConfig>` (`import "server-only"`) with `StockConfig = { pixabayKey: string|null; pexelsKey: string|null; openverseClientId: string|null; openverseClientSecret: string|null; hasPixabayKey: boolean; hasPexelsKey: boolean; hasOpenverseSecret: boolean; unreadable: boolean }` (`unreadable` when decrypt returns null).
  `StockSettingsInput = { pixabayKey?: string; pexelsKey?: string; openverseClientId?: string; openverseClientSecret?: string; clearPixabayKey?: boolean; clearPexelsKey?: boolean; clearOpenverseSecret?: boolean }`; `parseStockSettings(data: unknown): {error: string} | {value: StockSettingsInput}` (trims; empty key = keep stored; keys max 200 chars).

- [ ] **Step 1: Write failing tests** for `parseStockSettings`: trims whitespace; empty key string means "keep" (field absent in `value`); a 201-char key returns `{error}`; non-object returns `{error}`.
- [ ] **Step 2: Run** `npx vitest run lib/stock/settings-schema.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the zod schema (mirror `lib/ai/settings-schema.ts`), the Prisma model and hand-written migration SQL (mirror the `AiSettings` migration), then `npx prisma generate`; implement `loadStockConfig` mirroring `lib/ai/config.ts`.
- [ ] **Step 4: Run** the test — expect PASS; run `npx prisma migrate deploy` against the dev DB with no error.

### Task 6: Stock settings action, section and form

**Files:**
- Create: `lib/actions/stock-settings.ts`, `components/settings/stock-settings.tsx`
- Modify: `lib/settings-sections.ts`, `lib/settings-sections.test.ts`, `app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `parseStockSettings`, `loadStockConfig`, `encrypt` (Task 5).
- Produces: `updateStockSettings(data: StockSettingsInput): Promise<{error: string} | {success: true}>` (`"use server"`, admin check like `requireAdmin()` in `lib/actions/ai-settings.ts`, upsert singleton, `revalidatePath("/","layout")`); section `{ id: "stock", label: "Stock Media", adminOnly: true, icon: Images }` after `ai`; component `StockSettings({ initial, hasPixabayKey, hasPexelsKey, hasOpenverseSecret, unreadable })` showing "set / not set" and clear buttons, never the key.

- [ ] **Step 1: Update the failing test** `lib/settings-sections.test.ts`: `visibleSections(true)` ids equal `["account","storage","ai","stock","users"]`; `visibleSections(false)` has no `stock`.
- [ ] **Step 2: Run** `npx vitest run lib/settings-sections.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the section entry, action, form (mirror `components/settings/ai-settings.tsx`), and render it in the settings page when `tab=stock`.
- [ ] **Step 4: Run** the test — expect PASS; `npx tsc --noEmit`; in `npm run dev` as admin open `/settings?tab=stock`, save a key, reload: shows "set", never the value; a non-admin gets redirected.

### Task 7: Stock types, Openverse client and licence gate

**Files:**
- Create: `lib/stock/types.ts`, `lib/stock/licence.ts`, `lib/stock/openverse.ts`
- Test: `lib/stock/licence.test.ts`, `lib/stock/openverse.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  `StockSource = "openverse"|"pixabay"|"pexels"`; `StockKind = "image"|"gif"|"video"|"audio"`; `StockRef = {source; id: string; kind}`; `StockResult = StockRef & {title; thumbUrl; previewUrl?; duration?: number; width?: number; height?: number; pageUrl}`; `StockPage = {results: StockResult[]; next: string|null}`; `StockDownload = {url: string; fileName: string; gif: boolean}`;
  `StockQuery = {query: string; kind: StockKind|"all"; cursor: string|null}`;
  `StockClient = {source: StockSource; kinds: StockKind[]; configured(): boolean; search(q: StockQuery): Promise<StockPage>; resolve(ref: StockRef): Promise<StockDownload>}`.
  (`licence.ts`): `isOpenLicence(licence: unknown): boolean` — true only for `"cc0"` and `"pdm"` (case-insensitive, trimmed).
  (`openverse.ts`): `createOpenverse(cfg: {baseUrl?: string; clientId?: string|null; clientSecret?: string|null}): StockClient`; default `baseUrl` `https://api.openverse.org/v1`. Searches `/images/` (adds `extension=gif` for `gif`; excludes gifs from `image` by dropping results whose file is `.gif`) and `/audio/` with `license=cc0,pdm`, `page_size=20`; token from `/auth_token/` (client credentials) when id+secret are set, anonymous otherwise; `configured()` always true. `resolve` fetches `/{images|audio}/{id}/`, re-checks `isOpenLicence`, throws `Error("Not CC0 / public domain")` otherwise.

- [ ] **Step 1: Write failing tests:** `isOpenLicence` true for `cc0`, `PDM`, false for `by`, `by-sa`, `cc0-1.0x`, `""`, `undefined`. Against a fake `http.createServer`: search sends `license=cc0,pdm` and `page_size=20`; a fake result with `license:"by"` mixed into the response is dropped; `kind:"gif"` sends `extension=gif`; `resolve` on a `by` item rejects with "Not CC0 / public domain"; audio result maps `duration` from milliseconds to seconds (check the fake's field name against the live API docs at https://api.openverse.org/v1/ before fixing it); `next` is the next page number or `null` on the last page.
- [ ] **Step 2: Run** `npx vitest run lib/stock` — expect FAIL.
- [ ] **Step 3: Implement** the files above using global `fetch` with a 15 s `AbortSignal.timeout`.
- [ ] **Step 4: Run** `npx vitest run lib/stock` — expect PASS.

### Task 8: Pixabay and Pexels clients

**Files:**
- Create: `lib/stock/pixabay.ts`, `lib/stock/pexels.ts`
- Test: `lib/stock/pixabay.test.ts`, `lib/stock/pexels.test.ts`

**Interfaces:**
- Consumes: types from Task 7.
- Produces: `createPixabay(cfg: {baseUrl?: string; key: string|null}): StockClient` (kinds `image`,`gif`,`video`; `configured()` = key present; endpoints `/api/` and `/api/videos/`; GIF = image hit whose file URL ends `.gif`); `createPexels(cfg: {baseUrl?: string; key: string|null}): StockClient` (kinds `image`,`video`; `Authorization` header; endpoints `/v1/search`, `/videos/search`). `pickVideoFile(files: {width: number; height: number; url: string}[]): {url: string} | null` exported from `lib/stock/rendition.ts` — picks the file whose `height` is closest to 1080 without exceeding it; if every file is taller than 1080, the one with the smallest height; `null` for an empty list.
- Verify both providers' current licence/terms and endpoint shapes against https://pixabay.com/api/docs/ and https://www.pexels.com/api/documentation/ before coding; if either now requires attribution, stop and tell the user (spec "Licence rule").

- [ ] **Step 1: Write failing tests:** `pickVideoFile` picks 1920×1080 over 3840×2160 and 1280×720; picks the 2560×1440 only when nothing ≤1080 exists; returns `null` for `[]`. Per client against a fake server: search maps hits to `StockResult` with `pageUrl`; Pexels sends the `Authorization` header with the key; `configured()` is false without a key; a `.gif` Pixabay hit is `kind:"gif"` and `resolve` returns `gif: true`; `resolve` for video returns the 1080p file URL.
- [ ] **Step 2: Run** `npx vitest run lib/stock` — expect FAIL.
- [ ] **Step 3: Implement** both clients and `rendition.ts`.
- [ ] **Step 4: Run** `npx vitest run lib/stock` — expect PASS.

### Task 9: Aggregated search and API route

**Files:**
- Create: `lib/stock/search.ts`, `app/api/stock/search/route.ts`
- Test: `lib/stock/search.test.ts`

**Interfaces:**
- Consumes: `StockClient`s, `loadStockConfig`.
- Produces: `searchStock(clients: StockClient[], q: {query: string; kind: StockKind|"all"; source: StockSource|"all"; cursors: Partial<Record<StockSource,string|null>>}): Promise<{results: StockResult[]; cursors: Partial<Record<StockSource,string|null>>; errors: Partial<Record<StockSource,string>>; unconfigured: StockSource[]}>`. Skips clients whose `kinds` lack the type or that are not `configured()`; runs the rest in parallel with `Promise.allSettled` (a failing source goes in `errors`, others still return); merges round-robin; a source with cursor `null` after its first page is not queried again. Route `GET /api/stock/search?q=&kind=&source=&cursors=<json>`: `auth()` session required (401 otherwise), `mustResetPassword` → 403, empty `q` → 400, builds clients from `loadStockConfig()`.

- [ ] **Step 1: Write failing tests** with stub clients: round-robin order `A1,B1,A2,B2`; a throwing client yields its name in `errors` and the others' results; `kind:"audio"` skips clients without `audio`; unconfigured clients are listed in `unconfigured` and not called; a `null` cursor source is skipped.
- [ ] **Step 2: Run** `npx vitest run lib/stock/search.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `searchStock` and the route (read the Next.js route-handler guide first; set `runtime = "nodejs"`).
- [ ] **Step 4: Run** the test — expect PASS.

### Task 10: Safe downloader

**Files:**
- Create: `lib/stock/download.ts`
- Test: `lib/stock/download.test.ts`

**Interfaces:**
- Produces: `isPublicAddress(ip: string): boolean` (false for loopback, private, link-local, unspecified, unique-local, IPv4-mapped private); `downloadToFile(url: string, destPath: string, opts?: {maxBytes?: number; timeoutMs?: number; allowHttp?: boolean; lookup?: (host: string) => Promise<string[]>}): Promise<{bytes: number}>` — defaults 1 GB and 600 000 ms; https only unless `allowHttp` (tests only); resolves the host and refuses non-public addresses before connecting; follows at most 5 redirects, re-validating each hop; aborts and deletes the partial file when over `maxBytes` or the timeout; rejects with clear `Error` messages (`"Download too large"`, `"Download timed out"`, `"Blocked address"`).

- [ ] **Step 1: Write failing tests:** `isPublicAddress` false for `127.0.0.1`, `10.1.2.3`, `192.168.0.5`, `169.254.169.254`, `::1`, `fd00::1`, `::ffff:10.0.0.1`; true for `8.8.8.8`. Downloader against a local fake server (`allowHttp`, injected `lookup` returning a public IP): writes the body; a redirect to a host whose `lookup` returns `127.0.0.1` rejects "Blocked address"; a body larger than `maxBytes: 100` rejects "Download too large" and leaves no file; a slow server with `timeoutMs: 50` rejects "Download timed out"; `http://` without `allowHttp` rejects.
- [ ] **Step 2: Run** `npx vitest run lib/stock/download.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** with `fetch` (`redirect: "manual"`), streaming the body through `Readable.fromWeb` + `pipeline` with a byte counter.
- [ ] **Step 4: Run** the test — expect PASS.

### Task 11: GIF conversion and stock import

**Files:**
- Create: `lib/stock/gif.ts`, `lib/video/stock-import-server.ts`, `lib/actions/stock.ts`
- Modify: `lib/video/import-server.ts` (extract the probe-and-place half of `finishUpload`), `lib/video/projects-server.ts` if `reusableAsset` needs a stock key
- Test: `lib/stock/gif.test.ts`, `lib/video/stock-import-server.test.ts`

**Interfaces:**
- Consumes: `StockClient.resolve`, `downloadToFile`, `loadStockConfig`, `finishUpload`'s probe/place logic, `reusableAsset`, `importAssetAction` (the pattern in `lib/actions/video-projects.ts:106`).
- Produces: `gifToMp4Args(input: string, output: string): string[]` (`-i input -an -movflags +faststart -pix_fmt yuv420p -vf scale=trunc(iw/2)*2:trunc(ih/2)*2 -y output`); `convertGifToMp4(input: string, output: string): Promise<void>` (uses the project's `FFMPEG_PATH` helper); `finishDownload(userFolder: string, folder: string, partPath: string, name: string): Promise<{id: string; asset: Asset} | UploadError>` extracted from `finishUpload` (existing tests stay green); `stockSourceKey(ref: StockRef): string` → `"stock:<source>:<id>"`; `importStockAction(folder: string, ref: StockRef): Promise<{id: string; asset: Asset; reused?: true; format?: …} | {error: string}>` (`"use server"`; same auth/lock pattern as `importAssetAction`: `withLock`, `readProject`/`writeProject`). It rebuilds the client from `loadStockConfig()`, calls `resolve(ref)`, downloads to a staging file, converts a GIF to mp4 (asset gets `loopByDefault: true`, kind video), runs `finishDownload`, stores `source = stockSourceKey(ref)`. An asset whose `source` already equals the key is reused without downloading. Errors from licence refusal, size, timeout or blocked address are returned as `{error}` with the message.

- [ ] **Step 1: Write failing tests:** `gifToMp4Args("in.gif","out.mp4")` contains `-an`, `-pix_fmt`, `yuv420p`, the even-size scale filter and ends with `out.mp4`; `stockSourceKey({source:"pexels",id:"42",kind:"video"})` is `"stock:pexels:42"`; with a stub client and local fake server, importing the same ref twice gives one asset and `reused: true` the second time; two concurrent imports of the same ref yield one asset (the lock serialises them); a `resolve` that throws "Not CC0 / public domain" returns `{error:"Not CC0 / public domain"}` and leaves nothing in the project's assets folder.
- [ ] **Step 2: Run** `npx vitest run lib/stock/gif.test.ts lib/video/stock-import-server.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the extraction first (run `npx vitest run lib/video/import-server.test.ts` — still PASS), then the rest.
- [ ] **Step 4: Run** `npx vitest run lib` — expect PASS.

### Task 12: Stock panel UI and tab bar

**Files:**
- Create: `components/video/stock-panel.tsx`
- Modify: `components/video/file-tree.tsx` (lower section, ~line 445), `components/video/editor.tsx` (~line 677)

**Interfaces:**
- Consumes: `GET /api/stock/search` (Task 9), `StockResult`/`StockRef` (Task 7), `STOCK_DRAG_TYPE` (Task 13).
- Produces: `StockPanel({ project: Project }): JSX` — search box (Enter/debounced), type filter (All/Image/GIF/Video/Audio), source filter (All/Openverse/Pixabay/Pexels), thumbnail grid with source badge (links to the result's `pageUrl`), duration on video/audio, "Load more" using the per-source cursors, states for empty query, no results, per-source errors ("Pexels unavailable"), unconfigured sources (greyed; admins get a link to `/settings?tab=stock`, others "not set up by an admin"). Each result card is `draggable`, sets `STOCK_DRAG_TYPE` JSON `{source,id,kind,duration?}` on dragstart with `effectAllowed = "copy"`. `FileTree` renders a `role="tablist"` bar ("Personal Storage" | "Stock") at the top of its lower section; the Personal Storage tab content is unchanged; tab choice kept in component state (remember in `sessionStorage` wrapped in try/catch).

- [ ] **Step 1: Implement** the panel and tab bar following the existing styling in `file-tree.tsx`; keyboard: arrow keys move between tabs.
- [ ] **Step 2: Verify** `npx tsc --noEmit` and `npm run lint`; `npm run dev`, open a video project: tab bar sits above "Personal Storage"; Stock tab searches, filters, pages, and shows errors/empty/unconfigured states (check with no keys saved: Pixabay/Pexels greyed, Openverse live).

### Task 13: Drag stock results onto the project

**Files:**
- Modify: `components/video/timeline.tsx` (`INBOX_DRAG_TYPE` ~85, `hasMediaDrag` 130, dragstart ~420-447, `dropOn` ~993, `onDropInbox` prop ~224), `components/video/preview.tsx` (`MediaDrop` 21, `drop` ~379), `components/video/file-tree.tsx` (project-media drop ~355), `components/video/editor.tsx` (`dropFromInbox` ~316, `dropOnPlayer` ~337, `copyToMedia` ~309)

**Interfaces:**
- Consumes: `importStockAction` (Task 11).
- Produces: `export const STOCK_DRAG_TYPE = "application/x-ps-stock"` in `timeline.tsx`; `hasMediaDrag` also true for it; `MediaDrop` gains `{kind: "stock"; ref: StockRef}`; editor functions `importStock(ref: StockRef): Promise<{id: string; asset: Asset} | null>` (same `importingRef` guard, merge-asset and `applySize` handling as `importFile`, shows the returned `error` the way import errors are shown today), `dropFromStock(ref: StockRef, target: DropTarget): void` (import then `addClip`). Ghost length at dragstart: payload `duration` for video/audio, `DEFAULT_IMAGE` for image/gif. Audio results only drop on the audio track (existing refusal logic). Dropping onto the Media list imports without adding a clip.

- [ ] **Step 1: Implement** the drag type, drop handlers and editor functions, mirroring the inbox path at every site listed.
- [ ] **Step 2: Verify** `npx tsc --noEmit`, `npm run lint`, `npm test`; then manually with a configured Pixabay/Pexels key and anonymous Openverse: drag an image, a video, a GIF and an audio result to the timeline, the preview and the Media list; the clip appears after download with the existing "copying" feedback; the GIF loops (loop checked in its menu) and stretches past 2 s; dragging the same result again reuses the asset; export a project containing a stock video and a GIF and play the file.

### Task 14: Final verification

- [ ] **Step 1:** `npx prisma generate && npx tsc --noEmit && npm run lint && npm test` — all pass (report exact output).
- [ ] **Step 2:** Walk the spec's Goals and Anti-goals: confirm in the UI that no Openverse result shown carries a `by`-type licence (inspect network responses), that a source without a key is disabled, and that Settings → Stock Media is invisible to non-admins.
- [ ] **Step 3:** Tell the user what changed and leave everything uncommitted.
