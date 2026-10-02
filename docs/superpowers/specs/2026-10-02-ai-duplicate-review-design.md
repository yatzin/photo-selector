# AI duplicate review — design

Date: 2026-10-02
Status: approved in conversation, awaiting written-spec review

## Purpose

Phone uploads contain bursts: several takes of the same moment. Picking the
keeper from each burst by hand is the slowest part of sorting. This feature
finds those groups automatically, asks an external vision AI which take is
best (eyes open, looking at the camera, smiling, sharp), and lets the user
finish each group with one click. Scans run unattended and are saved, so a
user can start one, walk away, and review later.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Who judges "best" | External vision model via an OpenAI-compatible server (Ollama, LM Studio, OpenAI, OpenRouter). No local ML models. |
| Grouping | Local, no AI: capture-time window + perceptual hash + colour grid. |
| Scan scope | One chosen folder, that folder only (no subfolders). Groups never span folders. |
| Re-scan | Skip photos already in resolved/dismissed groups; "Start fresh" checkbox re-does everything. |
| Ranking | AI ranks every photo in a group; only the best is pre-selected. |
| Group action | One button per group: "Move picks to Dropoff, trash the rest" (in Sort Dropoff: "Keep picks, trash the rest"). Plus "Not duplicates". No folder-wide action. |
| Job execution | In-process background runner inside the Next.js server, state persisted in SQLite, resumes after restart. |
| Settings | Settings → AI, adapted from HomeCenter's assistant settings, admin only. |

## Data model (Prisma, SQLite)

### `AiSettings` (single row, id `"singleton"`)

- `enabled` Boolean, default false
- `baseUrl` String? — no trailing slash
- `apiKeyEnc` String? — AES-256-GCM via `lib/secret-box.ts` (key from `AUTH_SECRET`); never sent to the browser
- `model` String?
- `temperature` Float? — null = provider default
- `maxTokens` Int? — null = provider default
- `timeoutSeconds` Int? — per AI request; null = 120
- `extraBody` String? — JSON object merged into each request; may not set `model`, `messages`, `stream`
- `customPrompt` String? — appended to the built-in instruction, max 2000 chars
- `groupWindowSeconds` Int, default 60 (range 5–600)
- `similarity` String, default `"similar"` (`strict` | `similar` | `loose`)
- `imageMaxPx` Int, default 768 (range 384–1536)
- `maxGroupSize` Int, default 12 (range 2–20)
- `updatedAt`

### `AiRun`

- `id`, `root` (`upload` | `dropoff`), `folder` (path inside root, `/`-separated, `""` = root)
- `fresh` Boolean
- `status`: `QUEUED` → `GROUPING` → `ANALYZING` → `DONE`; or `FAILED` / `CANCELLED`
- `photoCount`, `groupCount`, `analyzedCount`, `failedCount` Int
- `model` String? — snapshot of the model used
- `error` String?
- `createdById` → User (set null on user delete), `createdAt`, `startedAt?`, `finishedAt?`

### `AiGroup`

- `id`, `runId` → AiRun (cascade delete), `root`, `folder`
- `takenAt` DateTime — first photo's capture time, for ordering
- `status`: `PENDING` → `ANALYZED` | `FAILED` → `RESOLVED` | `DISMISSED`
- `reason` String? — AI's one-paragraph explanation
- `error` String?
- `trashBatchId` String? — set when resolving, for Undo
- `resolvedById` → User (set null), `resolvedAt?`

### `AiGroupPhoto`

- `id`, `groupId` → AiGroup (cascade delete)
- `name` String, `version` String (`fileVersion` at scan time), `takenAt` DateTime
- `rank` Int? (1 = best), `note` String? (AI's short note), `suggested` Boolean
- `decision`: null | `KEEP` | `TRASH`
- Unique (`groupId`, `name`)

### Re-scan rules

- Without "Start fresh": a photo (same root + folder + name + version) that
  belongs to a `RESOLVED` or `DISMISSED` group is excluded from grouping.
- Starting a run deletes `PENDING` / `ANALYZED` / `FAILED` groups from earlier
  runs of the same root + folder, so a group is never reviewed twice.
- "Start fresh": also ignores resolved/dismissed history when choosing photos.
  History rows are kept.

## Scan pipeline

### Step 1 — grouping (no AI)

1. List media in the folder (one level). **Images only**; videos are skipped.
2. Apply the re-scan exclusion.
3. Capture time: EXIF `DateTimeOriginal` (fallback `DateTime`), else file mtime.
   EXIF read from the file header via sharp metadata + a small EXIF parser.
   HEIC photos whose EXIF can't be read use mtime.
4. Fingerprint from the cached thumbnail (`ensureVariant(..., "thumb", "scan")`):
   - dHash: grayscale 9×8, 64-bit difference hash
   - colour grid: 4×4 average RGB (48 values)
5. Similarity thresholds (dHash Hamming distance / mean colour distance 0–255):
   - strict: ≤ 6 / ≤ 12
   - similar: ≤ 12 / ≤ 20
   - loose: ≤ 18 / ≤ 30
   Thresholds are constants in `grouping.ts`, tuned against real bursts during
   implementation; the preset names are what users choose.
6. Sort by capture time; compare each photo with earlier photos within
   `groupWindowSeconds`; matching pairs are joined (union-find), so A~B and
   B~C put A, B, C in one group.
7. Keep groups with ≥ 2 photos. Split groups larger than `maxGroupSize` into
   consecutive time-ordered chunks of at most `maxGroupSize` (a trailing chunk
   of 1 is merged into the previous chunk).
8. Persist groups as `PENDING`; set `groupCount`, `photoCount`; status → `ANALYZING`.

A photo whose thumbnail can't be made (unreadable file) is left out of
grouping.

### Step 2 — AI analysis (one group at a time, sequential)

Request: `POST {baseUrl}/chat/completions`, non-streaming:

- system: built-in instruction + `customPrompt`
- user: text "Photos 1..n are takes of the same moment…" followed by one
  `image_url` part per photo, as `data:image/jpeg;base64,…`, resized from the
  cached preview to `imageMaxPx` on the long edge (JPEG q80).
- `temperature`, `max_tokens`, `extraBody` from settings.

Built-in criteria: main subjects' eyes open; main subjects looking at the
camera; natural smiles / good expressions; sharp focus, no motion blur; good
exposure; nobody important cut off; ignore background people.

Required reply (JSON, extracted from the first `{…}` block in the text):

```json
{ "ranking": [{ "photo": 3, "note": "everyone looking, sharp" }, …],
  "best": [3],
  "reason": "…" }
```

Validation: `ranking` must list each photo number 1..n exactly once (missing
numbers are appended last; unknown numbers rejected); `best` must be a
non-empty subset; notes ≤ 200 chars, reason ≤ 1000 chars. Invalid → ask once
more with the error appended; still invalid → group `FAILED`.

Each answer is written immediately: ranks, notes, `suggested = photo in best`,
group `ANALYZED`, run `analyzedCount++`.

### Failure handling

- Timeout / 5xx / network error: retry twice with backoff (2 s, 8 s). Then group
  `FAILED` with the error; run continues; `failedCount++`.
- 3 consecutive groups failing on connection/timeout → run `FAILED`
  ("AI server unreachable").
- 401/403 or 404 model → run `FAILED` immediately with a clear message.
- Cancel: run → `CANCELLED`; checked between groups (in-flight request is
  aborted). Analyzed groups stay reviewable.
- Retry failed: resets `FAILED` groups to `PENDING`, run → `QUEUED`.
- Restart: on boot the runner resumes runs in `GROUPING` (delete that run's
  groups, regroup) or `ANALYZING` (continue `PENDING` groups).
- One run at a time; others wait as `QUEUED` (oldest first).
- AI settings off or incomplete when a run starts → run `FAILED` with
  "AI is not set up".

### Test connection

Sends a generated 64×64 solid-red JPEG and asks for its colour as JSON.
Results: "Connected — model can see images", "Connected, but this model
doesn't accept images (choose a vision model)", or the connection error.
Tests the form's values (falling back to saved values; a saved key is never
sent to a different origin).

## Screens

### Sidebar

New "AI" item (Sparkles icon) with a badge: count of `ANALYZED` groups.

### `/ai`

- New scan card: folder dropdown (every folder in both roots, with image
  counts), "Start fresh" checkbox, Run. Disabled with an explanation when AI
  isn't configured (admins get a link to Settings → AI).
- Scans list (newest first): folder, started (time, user), status + progress
  bar, groups to review; actions Review, Cancel, Retry failed, Remove (deletes
  the run's saved results only).
- Polls (router refresh every 3 s) only while a run is `QUEUED`, `GROUPING`
  or `ANALYZING`.

### `/ai/runs/[id]`

- Tabs: To review (`ANALYZED`) / Done (`RESOLVED`, `DISMISSED`) / Failed.
- Group card: reason; photos in rank order, larger tiles, rank badge and note;
  suggested photos pre-selected (ring). Click toggles keep/trash; double-click
  opens the existing `Lightbox`.
- Buttons: "Move N to Dropoff, trash M" (upload) / "Keep N, trash M"
  (dropoff), counts live; "Not duplicates".
- Resolve: kept photos moved via `moveToDropoff` (upload only); others via
  `trashFiles` (one trash batch per group, id stored). Decisions saved; group
  `RESOLVED`. Card collapses to a summary with Undo (restores the trash batch;
  moved photos stay in Sort Dropoff). Undo sets the group back to `ANALYZED`.
- Before acting, each photo's current version is checked; changed or missing
  photos are shown as "no longer here" and excluded. With fewer than 2
  remaining, only "Done" (dismiss) is offered.
- Action requires at least one kept photo.

### Settings → AI (admin only)

Adapted from HomeCenter `components/settings/llm-settings.tsx`:
enabled switch; presets (Ollama, LM Studio, OpenAI, OpenRouter); base URL;
API key (write-only, "clear key"); model; Test connection; Advanced
(temperature, max tokens, time limit, extra request JSON, extra instructions);
Grouping (time window, similarity preset, image size, largest group).

### Permissions

Any signed-in user: start/cancel/retry/remove runs, review groups.
Admins only: AI settings.

## Code layout

| Unit | Responsibility |
|---|---|
| `lib/ai/fingerprint.ts` | dHash + colour grid from raw pixels; distances (pure) |
| `lib/ai/grouping.ts` | window + union-find grouping, splitting (pure) |
| `lib/ai/capture-time.ts` | EXIF date parse with fallback |
| `lib/ai/prompt.ts` | build messages; parse/validate reply (pure) |
| `lib/ai/settings-schema.ts` | settings form validation (pure) |
| `lib/ai/client.ts` | chat call with images, timeout, retries, error classes |
| `lib/ai/config.ts` | load settings, decrypt key |
| `lib/ai/runner-server.ts` | background loop: claim run, group, analyze, resume |
| `lib/ai/review-server.ts` | resolve / dismiss / undo using `file-ops-server` |
| `lib/actions/ai.ts`, `lib/actions/ai-settings.ts` | server actions |
| `lib/secret-box.ts` | copied from HomeCenter, salt `photo-selector.secret-box` |
| `app/(app)/ai/page.tsx`, `app/(app)/ai/runs/[id]/page.tsx` | pages |
| `components/ai/*`, `components/settings/ai-settings.tsx` | UI |
| `lib/task-queue.ts` | gains a third lane, `scan`, below `low` |
| `instrumentation.ts` | also starts the AI runner |
| Prisma migration | four tables |

## Testing

- Unit: fingerprint distances on generated images (same image shifted/brightened
  vs different image); grouping (chaining, window edges, splitting, singletons,
  trailing-chunk merge); reply validation (valid, malformed, missing/unknown
  numbers, empty best); settings schema; capture-time fallback; task queue
  third lane.
- Runner integration: local fake OpenAI server with canned replies — success,
  invalid-then-valid, invalid twice, timeout, unreachable ×3 → run failed,
  cancel mid-run, resume after simulated restart.
- Manual: real Ollama vision model on real burst photos.

## Out of scope

Videos; grouping across folders or subfolders; scheduled/automatic scans;
review-page keyboard shortcuts; undoing moves to Sort Dropoff; local ML models.
