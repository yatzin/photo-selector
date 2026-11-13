# Stock media tab — design

Date: 2026-11-11
Status: approved 2026-11-11

## Purpose

The video editor's bottom window shows Personal Storage only. Editors often
need a clip, picture, GIF or sound they don't own. This adds a second tab,
"Stock", that searches free-to-use media from Openverse, Pixabay and Pexels
and lets the user drag a result onto the timeline/scene/media exactly like a
Personal Storage file. A dropped result is downloaded into the project, so it
exports like any imported file.

## Goals

- Tab bar at the very top of the bottom window: `Personal Storage` | `Stock`.
  Personal Storage tab behaves exactly as today.
- Stock tab: search box, type filter (All / Image / GIF / Video / Audio),
  source filter (All / Openverse / Pixabay / Pexels), paged result grid with
  thumbnails, source badge, duration for video/audio.
- Drag a result to the timeline, preview, or Media list: same drop targets and
  behaviour as a Personal Storage file.
- Admin-only Settings → Stock Media for the API keys.
- **GIFs (your decision):** a dropped GIF is converted on download to a
  looping video (ffmpeg, which the app already uses) and imports as a normal
  video asset. It is added with loop ON (every other video defaults to loop OFF; see next item), so it fills
  whatever length the clip is given.
- **Loop any video clip (your addition, applies to all videos, not just GIFs):**
  a right-click menu item "Loop" on a timeline clip (in `clip-menu.tsx`, a
  checked toggle like the other radio-style items) turns looping on or off.
  A looping clip repeats its source to fill the clip's length, so it can be
  stretched past the source's own duration. Preview and export must both
  honour it, and it is saved in the project. The project model has no loop
  concept today (checked `lib/video/project.ts`), so this adds a per-clip
  `loop` flag and a migration for existing projects (absent = off). Audio
  clips are out of scope unless the builder finds it nearly free.

## Non-goals

- No attribution tracking or credits file (not required by the allowed licences).
- No other sources, no paid stock, no account/login flows with the providers.
- No hotlinking: results are never played from the provider at export time.
- No loop for still images (they already stretch to any length).
- No saving a copy into Personal Storage (project media only).

## Anti-goals

- **A result with an attribution-required licence must never be offered or
  importable.** This is the one hard requirement. If the filter can't be
  guaranteed for a source, that source is off, not "best effort".

## Licence rule (REQUIRED)

- **Openverse:** query with `license=cc0,pdm` (CC0 + Public Domain Mark). The
  server also drops any result whose `license` is not `cc0` or `pdm` before it
  reaches the browser, and re-checks it again at download time. Audio is
  Openverse only.
- **Pixabay / Pexels:** their own licences allow free use without attribution
  and have no per-licence filter; everything they serve qualifies. Each result
  carries its source badge so the user can see where it came from.
- The builder must confirm both statements against the providers' current
  terms/docs while building and record the check in the plan; if either has
  changed to require attribution, disable that source and tell the user.

## Sources and coverage (from the API docs as understood; verify while building)

| Type | Openverse | Pixabay | Pexels |
|---|---|---|---|
| Image | yes | yes | yes |
| GIF | yes (images that are GIFs) | yes (where returned) | no |
| Video | no | yes | yes |
| Audio | yes | no | no |

Type filter greys out / skips sources that don't offer that type.

## Keys and settings

- New single-row Prisma model `StockSettings` (id `"singleton"`), same pattern
  as `AiSettings`: `pixabayKeyEnc`, `pexelsKeyEnc`, `openverseClientId`,
  `openverseClientSecretEnc`, `updatedAt`. Secrets encrypted with
  `lib/secret-box.ts`; never sent to the browser (UI shows "set"/"not set").
- Settings → Stock Media, admin only, added to the settings sections list the
  same way Settings → AI is.
- Openverse works without credentials (lower rate limits); optional
  client id/secret raise the limit. Pixabay and Pexels need a key.
- A source without a key is disabled in the Stock tab. Admins see a link to
  Settings → Stock Media; other users see "not configured by an admin".

## Architecture

- All provider calls happen on the server (route handlers/server actions) so
  keys stay server-side. Browser calls one internal search endpoint with
  `{ query, type, source, page }` and gets a normalised result list:
  `{ source, id, kind, title, thumbUrl, previewUrl?, duration?, width?, height?, downloadRef }`.
  Any signed-in user may search; only admins edit settings.
- Thumbnails/previews come from the provider's CDN; the builder decides
  whether to hotlink them in `<img>`/`<video>` or proxy them.
- Download: the server resolves `downloadRef` itself (never trusts a
  browser-supplied URL; allow-list the provider hosts to avoid SSRF), streams
  the file into the project's media through the existing import path
  (`lib/video/import*`, same size limit, same probe/validation), and returns
  an asset like a normal import.
- **Video quality decision (yours): download the 1080p rendition.** If a video
  has no 1080p file, use the closest rendition at or below 1080p; if none,
  the smallest above it.
- Images use the largest standard (non-"original/raw") size; the builder picks
  a sensible cap. Audio uses the file as offered. GIFs are converted to video (see Goals).

## Drag and drop

- Existing drags use MIME types `application/x-ps-asset` and
  `application/x-ps-inbox` (`components/video/timeline.tsx`, `file-tree.tsx`);
  `hasMediaDrag` gates every drop target. Add a third type for stock results,
  carrying source/id/kind and the API-reported duration so the timeline can
  size the drag ghost at dragstart, and teach `hasMediaDrag` and the drop
  handlers about it.
- On drop the file is downloaded and added to the target exactly as an
  inbox (Personal Storage) drop is today, including any "copying…" state and
  failure message. The builder should follow the inbox path as the model.
- Audio results can only drop on the audio layer, same as audio files today.

## Errors and states

Empty query (show hint), no results, provider error/rate limit (show which
source failed, other sources still show), source not configured, download
failure (toast/message like import failures), licence check failure at
download (refuse, message "not CC0/public domain").

## Calls made while reviewing (my calls, not yours — check these)

- **GIF detection:** Openverse via its `extension=gif` filter, Pixabay by
  file extension after the fact. A result is a GIF only if its file is `.gif`.
- **"All" type/source:** first page of each source, merged round-robin; "Load
  more" fetches the next page per source (a cursor per source). Audio results
  appear only when type is All or Audio, never interleaved ahead of
  image/video results.
- **Download limits:** stock downloads capped at 1 GB and a 10 minute timeout
  (tighter than the 4 GB import cap); over the cap = refuse with a message.
- **Drop end state:** the clip is added once the download finishes, with the
  same "copying…" feedback as an inbox drop today. Dropping the same result
  twice reuses the first downloaded asset (dedupe key = source + id).
- **Download hosts (SSRF):** no fixed host list, because Openverse results
  point at many upstream hosts. Instead: https only, refuse private/loopback/
  link-local addresses (re-checked after each redirect), and only ever fetch
  URLs the server itself got from a provider API response, never a URL sent
  by the browser.
- **Pexels/Pixabay attribution:** not required by their licences. Pexels'
  API guidelines ask for a visible link to Pexels, so the source badge on
  each result links to the provider. Both licences forbid reselling the file
  unaltered; using it inside an edited video is allowed. If the builder finds
  that wrong, disable the source and report it (see Licence rule).
- **Stock tab visibility:** always shown; Openverse works without a key, so
  at least one source is live.
- **Bottom window:** the builder confirms it is the same component that hosts
  Personal Storage in `editor.tsx` and tells me if a refactor is needed.

## Left to the builder

Layout details of the tab bar and grid, paging vs infinite scroll, debounce,
thumbnail proxying, caching of search results, exact normalised result shape,
Openverse OAuth token handling, test strategy (mock provider responses; never
call live APIs in tests).

## Constraints

- This is not stock Next.js: read the relevant guide in
  `node_modules/next/dist/docs/` before writing any code (AGENTS.md).
- Work stays on the current feature branch; no commits unless asked.
- Docker/NAS deploy: no new native dependencies; outbound HTTPS to the three
  providers must be the only new network requirement.
