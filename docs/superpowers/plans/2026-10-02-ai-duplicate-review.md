# AI Duplicate Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An "AI" tab that scans one folder for groups of near-identical photos, asks an external vision model to rank each group, saves the results, and lets the user finish each group with one click.

**Architecture:** Grouping runs locally (capture time + dHash + colour grid computed from cached thumbnails). A background runner inside the Next.js server claims queued runs from SQLite, groups the folder, then sends one group at a time to an OpenAI-compatible chat endpoint and persists each verdict. Review actions reuse the existing move/trash code.

**Tech Stack:** Next.js 16 (App Router, server actions, `instrumentation.ts`), Prisma 7 + SQLite (libsql adapter), sharp, `exif-reader`, zod, vitest, Tailwind/shadcn (base-ui).

**Spec:** `docs/superpowers/specs/2026-10-02-ai-duplicate-review-design.md`

## Global Constraints

- External AI only: OpenAI-compatible `POST {baseUrl}/chat/completions`, non-streaming. No local ML models.
- Scan scope: one folder, that folder only (no subfolders). Images only; videos skipped.
- `timeoutSeconds` null = 120. `groupWindowSeconds` default 60, range 5–600. `similarity` ∈ `strict | similar | loose`, default `similar`. `imageMaxPx` default 768, range 384–1536. `maxGroupSize` default 12, range 2–20. `customPrompt` ≤ 2000 chars.
- `extraBody` may not set `model`, `messages`, `stream`.
- Retry delays 2 s then 8 s. 3 consecutive connection/timeout group failures → run FAILED "AI server unreachable". 401/403 or 404 → run FAILED immediately.
- AI reply notes ≤ 200 chars, reason ≤ 1000 chars.
- API key: AES-256-GCM via `lib/secret-box.ts`, salt `photo-selector.secret-box`; never sent to the browser; never sent to a different origin than it was saved for.
- Any signed-in user may run/review; only admins may change AI settings.
- Photos are never acted on if their version changed since the scan.
- Every new pure module lives under `lib/` with a sibling `*.test.ts` (vitest only includes `lib/**/*.test.ts`).
- Run `npx tsc --noEmit`, `npx eslint`, `npm test` before each commit.

## Review Focus

1. A photo renamed, rotated, moved or deleted between scan and resolve → shown as "no longer here", never moved/trashed. Pinned in Task 11 (`classifyPhotos`).
2. The model wraps its JSON in prose or ``` fences, or repeats/omits photo numbers → still parsed per the spec rules. Pinned in Task 8.
3. A burst of 40 near-identical shots → split into chunks ≤ `maxGroupSize`, never leaving a chunk of 1. Pinned in Task 6.
4. A text-only model (HTTP 400 on image input) → that group fails without retries and the run keeps going, not "unreachable". Pinned in Task 10.
5. Folder names with spaces, `%`, `#` or `..` sent to start a scan → resolved safely or rejected. Pinned in Task 11 (`scanFolderSegments`).

---

### Task 0: Baseline commit

The app code written so far is uncommitted; tasks below commit incrementally on top of it.

**Files:** all current untracked files (`.gitignore` already excludes `.env`, `node_modules`, `dev-photos`, `.data`, `prisma/dev.db`).

- [ ] **Step 1: Verify the tree is green**

Run: `npx tsc --noEmit && npx eslint && npm test`
Expected: no type or lint errors; all tests pass.

- [ ] **Step 2: Remove test leftovers if still present**

Run: `git status --short` and confirm `.ps-mkuser.ts` and `dev-photos/upload/jessi/probe.jpg` are not about to be committed (`dev-photos` is ignored; delete `.ps-mkuser.ts` or add it to `.git/info/exclude`).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: photo selector app — library grid, thumbnails, sorting actions, viewer"
```

---

### Task 1: Database tables and secret box

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_ai_review/migration.sql` (generated)
- Create: `lib/secret-box.ts`
- Test: `lib/secret-box.test.ts`

**Interfaces:**
- Produces: Prisma models `AiSettings`, `AiRun`, `AiGroup`, `AiGroupPhoto`; enums `AiRunStatus`, `AiGroupStatus`, `AiDecision`. `encrypt(plaintext: string): string`, `decrypt(payload: string): string | null`.

- [ ] **Step 1: Write the failing secret-box test**

`lib/secret-box.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { decrypt, encrypt } from "./secret-box"

describe("secret box", () => {
  const original = process.env.AUTH_SECRET
  beforeEach(() => void (process.env.AUTH_SECRET = "test-secret-one"))
  afterEach(() => void (process.env.AUTH_SECRET = original))

  it("round-trips a value", () => {
    const enc = encrypt("sk-abc123")
    expect(enc).not.toContain("sk-abc123")
    expect(decrypt(enc)).toBe("sk-abc123")
  })

  it("returns null when AUTH_SECRET changed", () => {
    const enc = encrypt("sk-abc123")
    process.env.AUTH_SECRET = "a-different-secret"
    expect(decrypt(enc)).toBeNull()
  })

  it("returns null for garbage", () => {
    expect(decrypt("nonsense")).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/secret-box.test.ts`
Expected: FAIL — cannot find module `./secret-box`.

- [ ] **Step 3: Create `lib/secret-box.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto"

// AES-256-GCM for the few secrets kept in the database (the AI API key). The
// database file is copied into NAS snapshots and backups far more casually
// than the compose file, so a stored key shouldn't be readable from one.
//
// The key derives from AUTH_SECRET. Rotating AUTH_SECRET makes existing
// ciphertext unreadable: decrypt() returns null so callers can ask for the
// value again.

const VERSION = "v1"
const SALT = "photo-selector.secret-box"

function key() {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error("AUTH_SECRET is not set — cannot encrypt stored secrets")
  return scryptSync(secret, SALT, 32)
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":")
}

/** Null when the value can't be decrypted — usually a rotated AUTH_SECRET. */
export function decrypt(payload: string): string | null {
  try {
    const [version, iv, tag, data] = payload.split(":")
    if (version !== VERSION || !iv || !tag || !data) return null
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"))
    decipher.setAuthTag(Buffer.from(tag, "base64"))
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8")
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run lib/secret-box.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Add the models to `prisma/schema.prisma`**

Append, and add the two back-relation fields to `User`:

```prisma
enum AiRunStatus {
  QUEUED
  GROUPING
  ANALYZING
  DONE
  FAILED
  CANCELLED
}

enum AiGroupStatus {
  PENDING
  ANALYZED
  FAILED
  RESOLVED
  DISMISSED
}

enum AiDecision {
  KEEP
  TRASH
}

/// Single row (id "singleton"). Edited under Settings → AI by admins.
model AiSettings {
  id                 String   @id @default("singleton")
  enabled            Boolean  @default(false)
  /// e.g. http://192.168.1.20:11434/v1 — no trailing slash.
  baseUrl            String?
  /// AES-256-GCM via lib/secret-box.ts. Never leaves the server.
  apiKeyEnc          String?
  model              String?
  temperature        Float?
  maxTokens          Int?
  /// Per AI request; null = 120.
  timeoutSeconds     Int?
  /// JSON object merged into every request.
  extraBody          String?
  /// Appended to the built-in instruction.
  customPrompt       String?
  groupWindowSeconds Int      @default(60)
  /// strict | similar | loose
  similarity         String   @default("similar")
  imageMaxPx         Int      @default(768)
  maxGroupSize       Int      @default(12)
  updatedAt          DateTime @updatedAt
}

model AiRun {
  id            String      @id @default(cuid())
  /// upload | dropoff
  root          String
  /// Path inside the root, "/"-separated; "" = the root itself.
  folder        String
  fresh         Boolean     @default(false)
  status        AiRunStatus @default(QUEUED)
  photoCount    Int         @default(0)
  groupCount    Int         @default(0)
  analyzedCount Int         @default(0)
  failedCount   Int         @default(0)
  model         String?
  error         String?
  createdById   String?
  createdBy     User?       @relation(fields: [createdById], references: [id], onDelete: SetNull)
  createdAt     DateTime    @default(now())
  startedAt     DateTime?
  /// Set when grouping finished; a run with it set resumes at analysis.
  groupedAt     DateTime?
  finishedAt    DateTime?
  groups        AiGroup[]

  @@index([status, createdAt])
}

model AiGroup {
  id           String         @id @default(cuid())
  runId        String
  run          AiRun          @relation(fields: [runId], references: [id], onDelete: Cascade)
  root         String
  folder       String
  takenAt      DateTime
  status       AiGroupStatus  @default(PENDING)
  reason       String?
  error        String?
  trashBatchId String?
  resolvedById String?
  resolvedBy   User?          @relation(fields: [resolvedById], references: [id], onDelete: SetNull)
  resolvedAt   DateTime?
  photos       AiGroupPhoto[]

  @@index([root, folder, status])
  @@index([runId, status])
}

model AiGroupPhoto {
  id        String      @id @default(cuid())
  groupId   String
  group     AiGroup     @relation(fields: [groupId], references: [id], onDelete: Cascade)
  name      String
  version   String
  takenAt   DateTime
  rank      Int?
  note      String?
  suggested Boolean     @default(false)
  decision  AiDecision?

  @@unique([groupId, name])
}
```

In `model User { ... }` add:

```prisma
  aiRuns        AiRun[]
  aiResolved    AiGroup[]
```

- [ ] **Step 6: Generate the migration and client**

Run: `npx prisma migrate dev --name ai_review`
Expected: "Your database is now in sync with your schema" and a new folder under `prisma/migrations/`.

- [ ] **Step 7: Verify and commit**

Run: `npx tsc --noEmit && npx eslint && npm test`

```bash
git add prisma lib/secret-box.ts lib/secret-box.test.ts
git commit -m "feat(ai): database tables for AI review runs and settings"
```

---

### Task 2: AI settings validation

**Files:**
- Create: `lib/ai/settings-schema.ts`
- Test: `lib/ai/settings-schema.test.ts`

**Interfaces:**
- Produces:
  - `SIMILARITY_LEVELS = ["strict", "similar", "loose"] as const`, `type Similarity`
  - `AI_PRESETS: { id: string; label: string; baseUrl: string }[]`
  - `AI_DEFAULTS = { timeoutSeconds: 120, groupWindowSeconds: 60, similarity: "similar", imageMaxPx: 768, maxGroupSize: 12 }`
  - `type AiSettingsInput` (all form fields as strings/booleans, plus `apiKey?: string`, `clearApiKey?: boolean`)
  - `type ParsedAiSettings = { enabled; baseUrl: string|null; model: string|null; temperature: number|null; maxTokens: number|null; timeoutSeconds: number|null; extraBody: string|null; customPrompt: string|null; groupWindowSeconds: number; similarity: Similarity; imageMaxPx: number; maxGroupSize: number }`
  - `parseAiSettings(input: AiSettingsInput, opts?: { requireComplete?: boolean }): { ok: true; value: ParsedAiSettings } | { ok: false; error: string }`
  - `isAiReady(c: { enabled: boolean; baseUrl: string|null; model: string|null; keyUnreadable: boolean }): boolean`
  - `originChanged(saved: string|null, next: string|null): boolean`
  - `parseExtraBody(raw: string|null|undefined): Record<string, unknown> | null`

- [ ] **Step 1: Write the failing tests**

`lib/ai/settings-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { isAiReady, originChanged, parseAiSettings, parseExtraBody, type AiSettingsInput } from "./settings-schema"

const base: AiSettingsInput = {
  enabled: true,
  baseUrl: "http://nas:11434/v1/",
  model: "qwen2.5vl:7b",
  groupWindowSeconds: "60",
  similarity: "similar",
  imageMaxPx: "768",
  maxGroupSize: "12",
}

describe("parseAiSettings", () => {
  it("accepts a complete form and trims the URL", () => {
    const r = parseAiSettings(base)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.baseUrl).toBe("http://nas:11434/v1")
      expect(r.value.similarity).toBe("similar")
      expect(r.value.timeoutSeconds).toBeNull()
    }
  })

  it("requires URL and model to turn AI on", () => {
    expect(parseAiSettings({ ...base, model: "" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, enabled: false, model: "" }).ok).toBe(true)
    expect(parseAiSettings({ ...base, model: "" }, { requireComplete: false }).ok).toBe(true)
  })

  it("rejects non-http URLs", () => {
    expect(parseAiSettings({ ...base, baseUrl: "ftp://x" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, baseUrl: "not a url" }).ok).toBe(false)
  })

  it("enforces numeric ranges", () => {
    expect(parseAiSettings({ ...base, groupWindowSeconds: "4" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, groupWindowSeconds: "601" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, imageMaxPx: "383" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, imageMaxPx: "1537" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, maxGroupSize: "1" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, maxGroupSize: "21" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, temperature: "2.5" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, timeoutSeconds: "9" }).ok).toBe(false)
  })

  it("rejects an unknown similarity level", () => {
    expect(parseAiSettings({ ...base, similarity: "fuzzy" }).ok).toBe(false)
  })

  it("rejects extra JSON that overrides reserved fields", () => {
    expect(parseAiSettings({ ...base, extraBody: '{"model":"x"}' }).ok).toBe(false)
    expect(parseAiSettings({ ...base, extraBody: "[1]" }).ok).toBe(false)
    const ok = parseAiSettings({ ...base, extraBody: '{ "keep_alive": "10m" }' })
    expect(ok.ok && ok.value.extraBody).toBe('{"keep_alive":"10m"}')
  })

  it("limits the custom prompt", () => {
    expect(parseAiSettings({ ...base, customPrompt: "x".repeat(2001) }).ok).toBe(false)
  })
})

describe("helpers", () => {
  it("isAiReady needs everything", () => {
    expect(isAiReady({ enabled: true, baseUrl: "http://a", model: "m", keyUnreadable: false })).toBe(true)
    expect(isAiReady({ enabled: true, baseUrl: "http://a", model: "m", keyUnreadable: true })).toBe(false)
    expect(isAiReady({ enabled: false, baseUrl: "http://a", model: "m", keyUnreadable: false })).toBe(false)
  })

  it("originChanged compares origins only", () => {
    expect(originChanged("http://a:1/v1", "http://a:1/v2")).toBe(false)
    expect(originChanged("http://a:1/v1", "http://b:1/v1")).toBe(true)
    expect(originChanged(null, "http://b")).toBe(false)
  })

  it("parseExtraBody only accepts objects", () => {
    expect(parseExtraBody('{"a":1}')).toEqual({ a: 1 })
    expect(parseExtraBody("1")).toBeNull()
    expect(parseExtraBody("")).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/ai/settings-schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/ai/settings-schema.ts`**

```ts
import { z } from "zod"

// Pure validation for Settings → AI. Shared by the server actions and the
// runner's readiness check; no database access here.

export const SIMILARITY_LEVELS = ["strict", "similar", "loose"] as const
export type Similarity = (typeof SIMILARITY_LEVELS)[number]

export const AI_PRESETS = [
  { id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
] as const

export const AI_DEFAULTS = {
  timeoutSeconds: 120,
  groupWindowSeconds: 60,
  similarity: "similar" as Similarity,
  imageMaxPx: 768,
  maxGroupSize: 12,
}

const RESERVED_FIELDS = ["model", "messages", "stream"]

const schema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().trim(),
  // Empty = keep the stored key; the browser never sees it.
  apiKey: z.string().optional(),
  clearApiKey: z.boolean().optional(),
  model: z.string().trim(),
  temperature: z.string().trim().optional(),
  maxTokens: z.string().trim().optional(),
  timeoutSeconds: z.string().trim().optional(),
  extraBody: z.string().trim().max(2000).optional(),
  customPrompt: z.string().trim().optional(),
  groupWindowSeconds: z.string().trim(),
  similarity: z.string().trim(),
  imageMaxPx: z.string().trim(),
  maxGroupSize: z.string().trim(),
})

export type AiSettingsInput = z.infer<typeof schema>

export type ParsedAiSettings = {
  enabled: boolean
  baseUrl: string | null
  model: string | null
  temperature: number | null
  maxTokens: number | null
  timeoutSeconds: number | null
  extraBody: string | null
  customPrompt: string | null
  groupWindowSeconds: number
  similarity: Similarity
  imageMaxPx: number
  maxGroupSize: number
}

type Result = { ok: true; value: ParsedAiSettings } | { ok: false; error: string }

function intIn(raw: string, min: number, max: number): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

export function parseAiSettings(input: AiSettingsInput, opts: { requireComplete?: boolean } = {}): Result {
  const parsed = schema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid input." }
  const v = parsed.data

  let baseUrl: string | null = null
  if (v.baseUrl) {
    let url: URL
    try {
      url = new URL(v.baseUrl)
    } catch {
      return { ok: false, error: "Base URL must be an http(s) URL." }
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "Base URL must be an http(s) URL." }
    baseUrl = v.baseUrl.replace(/\/+$/, "")
  }

  let temperature: number | null = null
  if (v.temperature) {
    const n = Number(v.temperature)
    if (!Number.isFinite(n) || n < 0 || n > 2) return { ok: false, error: "Temperature must be between 0 and 2." }
    temperature = n
  }

  let maxTokens: number | null = null
  if (v.maxTokens) {
    maxTokens = intIn(v.maxTokens, 1, 32000)
    if (maxTokens === null) return { ok: false, error: "Max tokens must be a whole number from 1 to 32000." }
  }

  let timeoutSeconds: number | null = null
  if (v.timeoutSeconds) {
    timeoutSeconds = intIn(v.timeoutSeconds, 10, 900)
    if (timeoutSeconds === null) return { ok: false, error: "Time limit must be a whole number of seconds from 10 to 900." }
  }

  let extraBody: string | null = null
  if (v.extraBody) {
    const obj = parseExtraBody(v.extraBody)
    if (!obj) return { ok: false, error: "Extra request JSON must be a JSON object." }
    const reserved = RESERVED_FIELDS.filter((f) => f in obj)
    if (reserved.length) return { ok: false, error: `Extra request JSON can't set ${reserved.join(", ")}.` }
    extraBody = JSON.stringify(obj)
  }

  if ((v.customPrompt ?? "").length > 2000) return { ok: false, error: "Extra instructions are limited to 2000 characters." }

  const groupWindowSeconds = intIn(v.groupWindowSeconds, 5, 600)
  if (groupWindowSeconds === null) return { ok: false, error: "Time window must be 5 to 600 seconds." }
  if (!(SIMILARITY_LEVELS as readonly string[]).includes(v.similarity)) return { ok: false, error: "Unknown similarity level." }
  const imageMaxPx = intIn(v.imageMaxPx, 384, 1536)
  if (imageMaxPx === null) return { ok: false, error: "Image size must be 384 to 1536 pixels." }
  const maxGroupSize = intIn(v.maxGroupSize, 2, 20)
  if (maxGroupSize === null) return { ok: false, error: "Largest group must be 2 to 20 photos." }

  const model = v.model || null
  if ((opts.requireComplete ?? true) && v.enabled && (!baseUrl || !model)) {
    return { ok: false, error: "Base URL and model are required to turn AI on." }
  }

  return {
    ok: true,
    value: {
      enabled: v.enabled, baseUrl, model, temperature, maxTokens, timeoutSeconds, extraBody,
      customPrompt: v.customPrompt || null, groupWindowSeconds, similarity: v.similarity as Similarity, imageMaxPx, maxGroupSize,
    },
  }
}

export function isAiReady(c: { enabled: boolean; baseUrl: string | null; model: string | null; keyUnreadable: boolean }): boolean {
  return c.enabled && !!c.baseUrl && !!c.model && !c.keyUnreadable
}

/** A stored key belongs to the server it was saved for. */
export function originChanged(saved: string | null, next: string | null): boolean {
  if (!saved || !next) return false
  try {
    return new URL(saved).origin !== new URL(next).origin
  } catch {
    return true
  }
}

export function parseExtraBody(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/ai/settings-schema.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/settings-schema.ts lib/ai/settings-schema.test.ts
git commit -m "feat(ai): settings validation"
```

---

### Task 3: AI chat client

**Files:**
- Create: `lib/ai/client.ts`
- Test: `lib/ai/client.test.ts`

**Interfaces:**
- Produces:
  - `type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }`
  - `type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] }`
  - `type AiClientConfig = { baseUrl: string; apiKey: string | null; model: string; temperature: number | null; maxTokens: number | null; timeoutSeconds: number; extraBody: Record<string, unknown> | null }`
  - `type AiErrorKind = "auth" | "model" | "bad-request" | "server" | "timeout" | "network" | "cancelled"`
  - `class AiError extends Error { kind: AiErrorKind; get retryable(): boolean }` — retryable for `server | timeout | network`
  - `chatOnce(cfg, messages, signal?): Promise<string>` — assistant text
  - `chatWithRetry(cfg, messages, opts?: { signal?: AbortSignal; delaysMs?: number[]; sleep?: (ms: number) => Promise<void> }): Promise<string>`

- [ ] **Step 1: Write failing tests against a local fake server**

`lib/ai/client.test.ts`:

```ts
import http from "http"
import type { AddressInfo } from "net"
import { afterEach, describe, expect, it } from "vitest"
import { AiError, chatOnce, chatWithRetry, type AiClientConfig } from "./client"

type Handler = (body: Record<string, unknown>, req: http.IncomingMessage) => { status: number; json?: unknown; delayMs?: number }

let server: http.Server | null = null
let calls: Record<string, unknown>[] = []

async function start(handler: Handler): Promise<AiClientConfig> {
  calls = []
  server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = JSON.parse(raw || "{}")
      calls.push({ ...body, _auth: req.headers.authorization, _path: req.url })
      const out = handler(body, req)
      setTimeout(() => {
        res.writeHead(out.status, { "Content-Type": "application/json" })
        res.end(JSON.stringify(out.json ?? {}))
      }, out.delayMs ?? 0)
    })
  })
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r))
  const port = (server!.address() as AddressInfo).port
  return { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-test", model: "vision", temperature: 0.2, maxTokens: 500, timeoutSeconds: 5, extraBody: { keep_alive: "5m" } }
}

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

const reply = (content: unknown) => ({ status: 200, json: { choices: [{ message: { role: "assistant", content } }] } })
const noSleep = async () => {}

describe("chatOnce", () => {
  it("posts an OpenAI-style request and returns the text", async () => {
    const cfg = await start(() => reply("hello"))
    const text = await chatOnce(cfg, [{ role: "user", content: "hi" }])
    expect(text).toBe("hello")
    expect(calls[0]._path).toBe("/v1/chat/completions")
    expect(calls[0]._auth).toBe("Bearer sk-test")
    expect(calls[0]).toMatchObject({ model: "vision", stream: false, temperature: 0.2, max_tokens: 500, keep_alive: "5m" })
  })

  it("joins array content parts", async () => {
    const cfg = await start(() => reply([{ type: "text", text: "a" }, { type: "text", text: "b" }]))
    expect(await chatOnce(cfg, [{ role: "user", content: "hi" }])).toBe("ab")
  })

  it("omits auth without a key", async () => {
    const cfg = await start(() => reply("x"))
    await chatOnce({ ...cfg, apiKey: null }, [{ role: "user", content: "hi" }])
    expect(calls[0]._auth).toBeUndefined()
  })

  it.each([
    [401, "auth"], [403, "auth"], [404, "model"], [400, "bad-request"], [500, "server"], [429, "server"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const cfg = await start(() => ({ status, json: { error: { message: "nope" } } }))
    await expect(chatOnce(cfg, [{ role: "user", content: "hi" }])).rejects.toMatchObject({ kind })
  })

  it("times out", async () => {
    const cfg = await start(() => ({ ...reply("late"), delayMs: 1500 }))
    await expect(chatOnce({ ...cfg, timeoutSeconds: 1 }, [{ role: "user", content: "hi" }])).rejects.toMatchObject({ kind: "timeout" })
  })

  it("reports an unreachable server as network", async () => {
    const cfg = await start(() => reply("x"))
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
    await expect(chatOnce(cfg, [{ role: "user", content: "hi" }])).rejects.toMatchObject({ kind: "network" })
  })
})

describe("chatWithRetry", () => {
  it("retries server errors, then succeeds", async () => {
    let n = 0
    const cfg = await start(() => (++n < 3 ? { status: 503 } : reply("ok")))
    expect(await chatWithRetry(cfg, [{ role: "user", content: "hi" }], { sleep: noSleep })).toBe("ok")
    expect(n).toBe(3)
  })

  it("gives up after two retries", async () => {
    const cfg = await start(() => ({ status: 500 }))
    await expect(chatWithRetry(cfg, [{ role: "user", content: "hi" }], { sleep: noSleep })).rejects.toBeInstanceOf(AiError)
    expect(calls.length).toBe(3)
  })

  it("does not retry auth or bad requests", async () => {
    const cfg = await start(() => ({ status: 400 }))
    await expect(chatWithRetry(cfg, [{ role: "user", content: "hi" }], { sleep: noSleep })).rejects.toMatchObject({ kind: "bad-request" })
    expect(calls.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/ai/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/ai/client.ts`**

```ts
// Minimal OpenAI-compatible chat client with image parts, a per-request time
// limit, error classification, and retries for transient failures.

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] }

export type AiClientConfig = {
  baseUrl: string
  apiKey: string | null
  model: string
  temperature: number | null
  maxTokens: number | null
  timeoutSeconds: number
  extraBody: Record<string, unknown> | null
}

export type AiErrorKind = "auth" | "model" | "bad-request" | "server" | "timeout" | "network" | "cancelled"

export class AiError extends Error {
  constructor(public kind: AiErrorKind, message: string) {
    super(message)
    this.name = "AiError"
  }
  get retryable(): boolean {
    return this.kind === "server" || this.kind === "timeout" || this.kind === "network"
  }
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string }
    const e = body.error
    return (typeof e === "string" ? e : e?.message) ?? body.message ?? ""
  } catch {
    return ""
  }
}

export async function chatOnce(cfg: AiClientConfig, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(cfg.timeoutSeconds * 1000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const body: Record<string, unknown> = {
    ...(cfg.extraBody ?? {}),
    model: cfg.model,
    messages,
    stream: false,
    ...(cfg.temperature !== null ? { temperature: cfg.temperature } : {}),
    ...(cfg.maxTokens !== null ? { max_tokens: cfg.maxTokens } : {}),
  }

  let res: Response
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: combined,
    })
  } catch (error) {
    if (signal?.aborted) throw new AiError("cancelled", "Cancelled.")
    if (timeout.aborted) throw new AiError("timeout", `The AI server didn't answer within ${cfg.timeoutSeconds} s.`)
    throw new AiError("network", `Can't reach the AI server at ${cfg.baseUrl} (${error instanceof Error ? error.message : String(error)}).`)
  }

  if (!res.ok) {
    const detail = await errorDetail(res)
    const suffix = detail ? `: ${detail}` : ""
    if (res.status === 401 || res.status === 403) throw new AiError("auth", `The AI server refused the API key (HTTP ${res.status})${suffix}`)
    if (res.status === 404) throw new AiError("model", `Model or URL not found (HTTP 404)${suffix}`)
    if (res.status === 429 || res.status >= 500) throw new AiError("server", `AI server error (HTTP ${res.status})${suffix}`)
    throw new AiError("bad-request", `The AI server rejected the request (HTTP ${res.status})${suffix}`)
  }

  let json: { choices?: { message?: { content?: unknown } }[] }
  try {
    json = await res.json()
  } catch {
    throw new AiError("server", "The AI server sent a reply that isn't JSON.")
  }
  const content = json.choices?.[0]?.message?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("")
  }
  throw new AiError("server", "The AI server's reply had no message.")
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Transient failures (timeouts, 5xx, 429, network) are retried after 2 s and 8 s. */
export async function chatWithRetry(
  cfg: AiClientConfig,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; delaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {}
): Promise<string> {
  const delays = opts.delaysMs ?? [2000, 8000]
  const sleep = opts.sleep ?? sleepReal
  for (let attempt = 0; ; attempt++) {
    try {
      return await chatOnce(cfg, messages, opts.signal)
    } catch (error) {
      if (!(error instanceof AiError) || !error.retryable || attempt >= delays.length) throw error
      await sleep(delays[attempt])
      if (opts.signal?.aborted) throw new AiError("cancelled", "Cancelled.")
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/ai/client.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/client.ts lib/ai/client.test.ts
git commit -m "feat(ai): OpenAI-compatible chat client with retries"
```

---

### Task 4: Settings loader, actions and Settings → AI page

**Files:**
- Create: `lib/ai/config.ts`
- Create: `lib/actions/ai-settings.ts`
- Create: `components/settings/ai-settings.tsx`
- Modify: `lib/settings-sections.ts`, `lib/settings-sections.test.ts`
- Modify: `app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `encrypt`/`decrypt` (Task 1); `parseAiSettings`, `isAiReady`, `originChanged`, `parseExtraBody`, `AI_DEFAULTS`, `AI_PRESETS`, `SIMILARITY_LEVELS` (Task 2); `chatOnce`, `AiError`, `AiClientConfig` (Task 3).
- Produces:
  - `AI_SETTINGS_ID = "singleton"`
  - `type AiConfig = ParsedAiSettings & { apiKey: string | null; hasStoredKey: boolean; keyUnreadable: boolean }`
  - `loadAiConfig(): Promise<AiConfig>`
  - `clientConfig(c: AiConfig): AiClientConfig` (throws if baseUrl/model missing)
  - `aiReady(): Promise<boolean>`
  - Server actions `updateAiSettings(data: AiSettingsInput)`, `testAiConnection(data: AiSettingsInput)`
  - Settings section id `"ai"`

- [ ] **Step 1: Update the settings-sections test first**

In `lib/settings-sections.test.ts` change the admin list and add a case:

```ts
    expect(visibleSections(true).map((s) => s.id)).toEqual(["account", "storage", "ai", "users"])
```

```ts
  it("keeps AI settings from non-admins", () => {
    expect(resolveSection("ai", false).id).toBe("account")
    expect(resolveSection("ai", true).id).toBe("ai")
  })
```

Run: `npx vitest run lib/settings-sections.test.ts` — Expected: FAIL.

- [ ] **Step 2: Add the section in `lib/settings-sections.ts`**

```ts
import { HardDrive, Sparkles, UserRound, Users } from "lucide-react"
// ...
export type SettingsSectionId = "account" | "storage" | "ai" | "users"
// in SETTINGS_SECTIONS, between storage and users:
  { id: "ai", label: "AI", description: "Vision AI server and duplicate grouping", icon: Sparkles, adminOnly: true },
```

Run: `npx vitest run lib/settings-sections.test.ts` — Expected: PASS.

- [ ] **Step 3: Create `lib/ai/config.ts`**

```ts
import "server-only"
import { prisma } from "@/lib/prisma"
import { decrypt } from "@/lib/secret-box"
import { AI_DEFAULTS, isAiReady, parseExtraBody, type ParsedAiSettings, type Similarity } from "@/lib/ai/settings-schema"
import type { AiClientConfig } from "@/lib/ai/client"

export const AI_SETTINGS_ID = "singleton"

export type AiConfig = ParsedAiSettings & {
  apiKey: string | null
  hasStoredKey: boolean
  /** A key is stored but AUTH_SECRET can no longer decrypt it. */
  keyUnreadable: boolean
}

export async function loadAiConfig(): Promise<AiConfig> {
  const row = await prisma.aiSettings.findUnique({ where: { id: AI_SETTINGS_ID } })
  const apiKey = row?.apiKeyEnc ? decrypt(row.apiKeyEnc) : null
  return {
    enabled: row?.enabled ?? false,
    baseUrl: row?.baseUrl ?? null,
    model: row?.model ?? null,
    temperature: row?.temperature ?? null,
    maxTokens: row?.maxTokens ?? null,
    timeoutSeconds: row?.timeoutSeconds ?? null,
    extraBody: row?.extraBody ?? null,
    customPrompt: row?.customPrompt ?? null,
    groupWindowSeconds: row?.groupWindowSeconds ?? AI_DEFAULTS.groupWindowSeconds,
    similarity: (row?.similarity as Similarity | undefined) ?? AI_DEFAULTS.similarity,
    imageMaxPx: row?.imageMaxPx ?? AI_DEFAULTS.imageMaxPx,
    maxGroupSize: row?.maxGroupSize ?? AI_DEFAULTS.maxGroupSize,
    apiKey,
    hasStoredKey: Boolean(row?.apiKeyEnc),
    keyUnreadable: Boolean(row?.apiKeyEnc) && apiKey === null,
  }
}

export function clientConfig(c: AiConfig): AiClientConfig {
  if (!c.baseUrl || !c.model) throw new Error("AI is not set up.")
  return {
    baseUrl: c.baseUrl,
    apiKey: c.apiKey,
    model: c.model,
    temperature: c.temperature,
    maxTokens: c.maxTokens,
    timeoutSeconds: c.timeoutSeconds ?? AI_DEFAULTS.timeoutSeconds,
    extraBody: parseExtraBody(c.extraBody),
  }
}

/** Cheap check for pages (no decryption). */
export async function aiReady(): Promise<boolean> {
  const row = await prisma.aiSettings.findUnique({ where: { id: AI_SETTINGS_ID }, select: { enabled: true, baseUrl: true, model: true } })
  return isAiReady({ enabled: row?.enabled ?? false, baseUrl: row?.baseUrl ?? null, model: row?.model ?? null, keyUnreadable: false })
}
```

- [ ] **Step 4: Create `lib/actions/ai-settings.ts`**

```ts
"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import sharp from "sharp"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { encrypt } from "@/lib/secret-box"
import { AI_SETTINGS_ID, loadAiConfig } from "@/lib/ai/config"
import { AI_DEFAULTS, originChanged, parseAiSettings, parseExtraBody, type AiSettingsInput } from "@/lib/ai/settings-schema"
import { AiError, chatOnce } from "@/lib/ai/client"

async function requireAdmin() {
  const session = await auth()
  if (!session) redirect("/login")
  if (session.user.role !== "ADMIN") redirect("/")
  return session
}

export async function updateAiSettings(data: AiSettingsInput): Promise<{ error: string } | { success: true }> {
  await requireAdmin()
  const result = parseAiSettings(data)
  if (!result.ok) return { error: result.error }

  const saved = await prisma.aiSettings.findUnique({ where: { id: AI_SETTINGS_ID }, select: { baseUrl: true } })
  // A stored key never follows the settings to a different server.
  const serverChanged = originChanged(saved?.baseUrl ?? null, result.value.baseUrl)
  const apiKeyEnc = data.clearApiKey ? null : data.apiKey ? encrypt(data.apiKey) : serverChanged ? null : undefined

  await prisma.aiSettings.upsert({
    where: { id: AI_SETTINGS_ID },
    create: { id: AI_SETTINGS_ID, ...result.value, apiKeyEnc: apiKeyEnc ?? null },
    update: { ...result.value, ...(apiKeyEnc === undefined ? {} : { apiKeyEnc }) },
  })
  revalidatePath("/", "layout")
  return { success: true }
}

export type AiTestResult = { error: string } | { success: true; model: string; seesImages: boolean; detail: string }

/**
 * Sends a tiny solid-red image and asks for its colour. Tests what's on
 * screen, falling back to saved values; a saved key only goes to its own server.
 */
export async function testAiConnection(data: AiSettingsInput): Promise<AiTestResult> {
  await requireAdmin()
  const parsed = parseAiSettings(data, { requireComplete: false })
  if (!parsed.ok) return { error: parsed.error }

  const saved = await loadAiConfig()
  const baseUrl = parsed.value.baseUrl ?? saved.baseUrl
  const model = parsed.value.model ?? saved.model
  if (!baseUrl || !model) return { error: "Enter a base URL and model first." }
  const savedKey = originChanged(saved.baseUrl, baseUrl) ? null : saved.apiKey
  const apiKey = data.clearApiKey ? null : data.apiKey || savedKey

  const red = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ff0000" } }).jpeg().toBuffer()
  try {
    const text = await chatOnce(
      {
        baseUrl, apiKey, model,
        temperature: 0,
        maxTokens: parsed.value.maxTokens,
        timeoutSeconds: parsed.value.timeoutSeconds ?? AI_DEFAULTS.timeoutSeconds,
        extraBody: parseExtraBody(parsed.value.extraBody),
      },
      [
        {
          role: "user",
          content: [
            { type: "text", text: 'What single colour fills this image? Reply only with JSON like {"color":"blue"}.' },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${red.toString("base64")}` } },
          ],
        },
      ]
    )
    const seesImages = /red/i.test(text)
    return {
      success: true,
      model,
      seesImages,
      detail: seesImages ? "Connected — the model can see images." : `Connected, but the model didn't recognise the test image. It replied: ${text.slice(0, 200)}`,
    }
  } catch (error) {
    if (error instanceof AiError && error.kind === "bad-request") {
      return { error: `Connected, but this model doesn't accept images — choose a vision model. (${error.message})` }
    }
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
```

- [ ] **Step 5: Create `components/settings/ai-settings.tsx`**

```tsx
"use client"

import { useState } from "react"
import { toast } from "sonner"
import { CircleCheck, CircleX, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { testAiConnection, updateAiSettings, type AiTestResult } from "@/lib/actions/ai-settings"
import { AI_PRESETS, type AiSettingsInput } from "@/lib/ai/settings-schema"

export type AiSettingsInitial = Omit<AiSettingsInput, "apiKey" | "clearApiKey">

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function AiSettings({ initial, hasStoredKey, keyUnreadable }: { initial: AiSettingsInitial; hasStoredKey: boolean; keyUnreadable: boolean }) {
  const [form, setForm] = useState<AiSettingsInitial>(initial)
  const [apiKey, setApiKey] = useState("")
  const [clearApiKey, setClearApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<AiTestResult | null>(null)

  const set = <K extends keyof AiSettingsInitial>(key: K, value: AiSettingsInitial[K]) => setForm((f) => ({ ...f, [key]: value }))
  const payload = (): AiSettingsInput => ({ ...form, apiKey: apiKey || undefined, clearApiKey })

  async function save() {
    setSaving(true)
    const r = await updateAiSettings(payload())
    setSaving(false)
    if ("error" in r) toast.error(r.error)
    else {
      toast.success("AI settings saved.")
      setApiKey("")
      setClearApiKey(false)
    }
  }

  async function runTest() {
    setTesting(true)
    setTest(null)
    setTest(await testAiConnection(payload()))
    setTesting(false)
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Connection</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} className="h-4 w-4 accent-primary" />
            AI review on
          </label>
        </div>
        <div className="rounded-lg border bg-card p-4 space-y-4">
          <div className="flex flex-wrap gap-2">
            {AI_PRESETS.map((p) => (
              <Button key={p.id} type="button" variant="outline" size="sm" onClick={() => set("baseUrl", p.baseUrl)}>{p.label}</Button>
            ))}
          </div>
          <Field id="ai-url" label="Base URL" hint="Any OpenAI-compatible server. For Ollama on another PC use http://<pc-address>:11434/v1.">
            <Input id="ai-url" value={form.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="http://192.168.1.20:11434/v1" />
          </Field>
          <Field
            id="ai-key"
            label="API key"
            hint={keyUnreadable ? "The stored key can't be read (AUTH_SECRET changed). Enter it again." : hasStoredKey ? "A key is stored. Leave blank to keep it." : "Not needed for local servers."}
          >
            <div className="flex items-center gap-3">
              <Input id="ai-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={clearApiKey} />
              {hasStoredKey && (
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <input type="checkbox" checked={clearApiKey} onChange={(e) => setClearApiKey(e.target.checked)} /> Clear key
                </label>
              )}
            </div>
          </Field>
          <Field id="ai-model" label="Model" hint="Must accept images, e.g. qwen2.5vl:7b, llava, gpt-4o-mini.">
            <Input id="ai-model" value={form.model} onChange={(e) => set("model", e.target.value)} />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={runTest} disabled={testing}>
              {testing && <Loader2 className="h-4 w-4 animate-spin" />} Test connection
            </Button>
            {test && "error" in test && <span className="inline-flex items-center gap-1 text-sm text-destructive"><CircleX className="h-4 w-4" />{test.error}</span>}
            {test && "success" in test && (
              <span className={test.seesImages ? "inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400" : "inline-flex items-center gap-1 text-sm text-amber-700 dark:text-amber-400"}>
                {test.seesImages ? <CircleCheck className="h-4 w-4" /> : <CircleX className="h-4 w-4" />}{test.detail}
              </span>
            )}
          </div>
        </div>
      </section>

      <details className="group rounded-lg border bg-card p-4">
        <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field id="ai-temp" label="Temperature" hint="Blank = server default.">
            <Input id="ai-temp" inputMode="decimal" value={form.temperature ?? ""} onChange={(e) => set("temperature", e.target.value)} />
          </Field>
          <Field id="ai-max" label="Max tokens" hint="Blank = server default.">
            <Input id="ai-max" inputMode="numeric" value={form.maxTokens ?? ""} onChange={(e) => set("maxTokens", e.target.value)} />
          </Field>
          <Field id="ai-timeout" label="Time limit (s)" hint="Per group. Blank = 120.">
            <Input id="ai-timeout" inputMode="numeric" value={form.timeoutSeconds ?? ""} onChange={(e) => set("timeoutSeconds", e.target.value)} />
          </Field>
        </div>
        <div className="mt-4 space-y-4">
          <Field id="ai-extra" label="Extra request JSON" hint='Merged into every request, e.g. {"keep_alive":"10m"}.'>
            <Textarea id="ai-extra" rows={3} className="font-mono text-xs" value={form.extraBody ?? ""} onChange={(e) => set("extraBody", e.target.value)} />
          </Field>
          <Field id="ai-prompt" label="Extra instructions" hint="Added to the built-in instructions, e.g. “Prefer photos where the kids are in focus.”">
            <Textarea id="ai-prompt" rows={3} maxLength={2000} value={form.customPrompt ?? ""} onChange={(e) => set("customPrompt", e.target.value)} />
          </Field>
        </div>
      </details>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Grouping</h2>
        <div className="rounded-lg border bg-card p-4 grid gap-4 sm:grid-cols-2">
          <Field id="ai-window" label="Time window (seconds)" hint="Photos further apart than this are never grouped.">
            <Input id="ai-window" inputMode="numeric" value={form.groupWindowSeconds} onChange={(e) => set("groupWindowSeconds", e.target.value)} />
          </Field>
          <Field id="ai-sim" label="How similar" hint="Loose groups more; strict only near-identical shots.">
            <select id="ai-sim" value={form.similarity} onChange={(e) => set("similarity", e.target.value)} className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm">
              <option value="strict">Strict</option>
              <option value="similar">Similar</option>
              <option value="loose">Loose</option>
            </select>
          </Field>
          <Field id="ai-px" label="Image size sent (pixels)" hint="Long edge. Bigger is slower but sees faces better.">
            <Input id="ai-px" inputMode="numeric" value={form.imageMaxPx} onChange={(e) => set("imageMaxPx", e.target.value)} />
          </Field>
          <Field id="ai-group" label="Largest group" hint="Bigger bursts are split into chunks of this size.">
            <Input id="ai-group" inputMode="numeric" value={form.maxGroupSize} onChange={(e) => set("maxGroupSize", e.target.value)} />
          </Field>
        </div>
      </section>

      <Button onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Save</Button>
    </div>
  )
}
```

- [ ] **Step 6: Render it from `app/(app)/settings/page.tsx`**

Add imports:

```ts
import { AiSettings } from "@/components/settings/ai-settings"
import { loadAiConfig } from "@/lib/ai/config"
```

Add `is("ai") ? loadAiConfig() : Promise.resolve(null)` as a fourth entry of the `Promise.all` (destructure as `ai`), and in the content column:

```tsx
          {is("ai") && ai && (
            <AiSettings
              initial={{
                enabled: ai.enabled,
                baseUrl: ai.baseUrl ?? "",
                model: ai.model ?? "",
                temperature: ai.temperature?.toString() ?? "",
                maxTokens: ai.maxTokens?.toString() ?? "",
                timeoutSeconds: ai.timeoutSeconds?.toString() ?? "",
                extraBody: ai.extraBody ? JSON.stringify(JSON.parse(ai.extraBody), null, 2) : "",
                customPrompt: ai.customPrompt ?? "",
                groupWindowSeconds: String(ai.groupWindowSeconds),
                similarity: ai.similarity,
                imageMaxPx: String(ai.imageMaxPx),
                maxGroupSize: String(ai.maxGroupSize),
              }}
              hasStoredKey={ai.hasStoredKey}
              keyUnreadable={ai.keyUnreadable}
            />
          )}
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx eslint && npm test`
Manual: as admin open `/settings?tab=ai`, click "Ollama", enter a model, Save → toast "AI settings saved"; reload → values persist; API key field is blank with "A key is stored" after saving one. As a non-admin `/settings?tab=ai` shows Account.

- [ ] **Step 8: Commit**

```bash
git add lib/ai/config.ts lib/actions/ai-settings.ts components/settings/ai-settings.tsx lib/settings-sections.ts lib/settings-sections.test.ts "app/(app)/settings/page.tsx"
git commit -m "feat(ai): Settings → AI with connection test"
```

---

### Task 5: Photo fingerprints

**Files:**
- Create: `lib/ai/fingerprint.ts`
- Test: `lib/ai/fingerprint.test.ts`

**Interfaces:**
- Produces:
  - `type Fingerprint = { hash: bigint; colors: number[] }` (48 colour values: 4×4×RGB)
  - `dHash(gray: Uint8Array): bigint` — input 9×8 grayscale, row-major
  - `hamming(a: bigint, b: bigint): number`
  - `colorDistance(a: number[], b: number[]): number` — mean absolute difference, 0–255
  - `fingerprintImage(input: string | Buffer): Promise<Fingerprint>`

- [ ] **Step 1: Write failing tests**

`lib/ai/fingerprint.test.ts`:

```ts
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { colorDistance, dHash, fingerprintImage, hamming } from "./fingerprint"

// A "scene": sky gradient, a sun and a figure. `dx` shifts the figure,
// `brightness` simulates a slightly different exposure.
function scene(opts: { dx?: number; brightness?: number; variant?: "a" | "b" } = {}): Buffer {
  const { dx = 0, variant = "a" } = opts
  const svg =
    variant === "a"
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
          <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a7bd5"/><stop offset="1" stop-color="#e0eafc"/></linearGradient></defs>
          <rect width="400" height="300" fill="url(#g)"/><circle cx="320" cy="70" r="40" fill="#ffd200"/>
          <rect x="${150 + dx}" y="120" width="60" height="160" fill="#7b3f00"/><rect x="0" y="260" width="400" height="40" fill="#2e7d32"/>
        </svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
          <rect width="400" height="300" fill="#202020"/><rect x="20" y="20" width="120" height="260" fill="#c62828"/>
          <circle cx="280" cy="200" r="80" fill="#f5f5f5"/>
        </svg>`
  return Buffer.from(svg)
}

async function jpeg(svg: Buffer, brightness = 1): Promise<Buffer> {
  return sharp(svg).modulate({ brightness }).jpeg({ quality: 85 }).toBuffer()
}

describe("dHash / hamming", () => {
  it("is 0 for a flat image and counts differing bits", () => {
    expect(dHash(new Uint8Array(72))).toBe(0n)
    const ramp = Uint8Array.from({ length: 72 }, (_, i) => 255 - (i % 9) * 20)
    expect(hamming(dHash(ramp), 0n)).toBe(64)
  })
})

describe("colorDistance", () => {
  it("averages absolute differences", () => {
    expect(colorDistance([0, 0, 0], [30, 0, 0])).toBe(10)
    expect(colorDistance([5, 5], [5, 5])).toBe(0)
  })
})

describe("fingerprintImage", () => {
  it("rates two takes of the same scene as close", async () => {
    const a = await fingerprintImage(await jpeg(scene()))
    const b = await fingerprintImage(await jpeg(scene({ dx: 6 }), 1.06))
    expect(hamming(a.hash, b.hash)).toBeLessThanOrEqual(12)
    expect(colorDistance(a.colors, b.colors)).toBeLessThanOrEqual(20)
  })

  it("rates a different scene as far", async () => {
    const a = await fingerprintImage(await jpeg(scene()))
    const c = await fingerprintImage(await jpeg(scene({ variant: "b" })))
    const far = hamming(a.hash, c.hash) > 12 || colorDistance(a.colors, c.colors) > 20
    expect(far).toBe(true)
  })

  it("returns 48 colour values", async () => {
    const a = await fingerprintImage(await jpeg(scene()))
    expect(a.colors).toHaveLength(48)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/ai/fingerprint.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `lib/ai/fingerprint.ts`**

```ts
import sharp from "sharp"

// Cheap visual fingerprints for grouping near-identical shots — no AI.
// dHash captures shapes and layout; a 4×4 colour grid stops two different
// scenes with similar shapes from matching.

export type Fingerprint = { hash: bigint; colors: number[] }

/** Difference hash of a 9×8 grayscale image (row-major): 64 bits, 1 where a pixel is brighter than its right neighbour. */
export function dHash(gray: Uint8Array): bigint {
  let hash = 0n
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      hash = (hash << 1n) | (gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1n : 0n)
    }
  }
  return hash
}

export function hamming(a: bigint, b: bigint): number {
  let v = a ^ b
  let count = 0
  while (v) {
    count += Number(v & 1n)
    v >>= 1n
  }
  return count
}

/** Mean absolute difference between two equal-length colour lists, 0–255. */
export function colorDistance(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

export async function fingerprintImage(input: string | Buffer): Promise<Fingerprint> {
  const [gray, color] = await Promise.all([
    sharp(input).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer(),
    sharp(input).removeAlpha().toColourspace("srgb").resize(4, 4, { fit: "fill" }).raw().toBuffer(),
  ])
  return { hash: dHash(new Uint8Array(gray)), colors: Array.from(color) }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/ai/fingerprint.test.ts` — Expected: all pass. If "same scene" exceeds a bound, inspect the printed distances and adjust only the test scene shift (not the thresholds, which Task 6 owns).

- [ ] **Step 5: Commit**

```bash
git add lib/ai/fingerprint.ts lib/ai/fingerprint.test.ts
git commit -m "feat(ai): perceptual fingerprints for grouping"
```

---

### Task 6: Grouping

**Files:**
- Create: `lib/ai/grouping.ts`
- Test: `lib/ai/grouping.test.ts`

**Interfaces:**
- Consumes: `Fingerprint`, `hamming`, `colorDistance` (Task 5); `Similarity` (Task 2).
- Produces:
  - `THRESHOLDS: Record<Similarity, { hash: number; color: number }>` = strict `{6,12}`, similar `{12,20}`, loose `{18,30}`
  - `type GroupInput = { name: string; takenAt: number; fp: Fingerprint }` (`takenAt` epoch ms)
  - `isSimilar(a: Fingerprint, b: Fingerprint, level: Similarity): boolean`
  - `splitGroup<T>(items: T[], max: number): T[][]`
  - `groupPhotos(photos: GroupInput[], opts: { windowSeconds: number; similarity: Similarity; maxGroupSize: number }): GroupInput[][]` — each group time-ordered, groups ordered by first photo time, only groups of ≥2.

- [ ] **Step 1: Write failing tests**

`lib/ai/grouping.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { groupPhotos, isSimilar, splitGroup, type GroupInput } from "./grouping"

const fp = (hash: bigint, shade = 100) => ({ hash, colors: Array(48).fill(shade) })
const p = (name: string, sec: number, hash: bigint, shade = 100): GroupInput => ({ name, takenAt: sec * 1000, fp: fp(hash, shade) })
const opts = { windowSeconds: 60, similarity: "similar" as const, maxGroupSize: 12 }
const names = (groups: GroupInput[][]) => groups.map((g) => g.map((x) => x.name))

const A = 0b1010_1010n
const A2 = A ^ 0b111n // 3 bits away
const FAR = ~A & ((1n << 64n) - 1n) // 64 bits away

describe("isSimilar", () => {
  it("needs both shape and colour to be close", () => {
    expect(isSimilar(fp(A), fp(A2), "similar")).toBe(true)
    expect(isSimilar(fp(A), fp(FAR), "similar")).toBe(false)
    expect(isSimilar(fp(A, 100), fp(A, 160), "similar")).toBe(false)
  })

  it("strict is stricter than loose", () => {
    const tenAway = A ^ 0b11_1111_1111n
    expect(isSimilar(fp(A), fp(tenAway), "strict")).toBe(false)
    expect(isSimilar(fp(A), fp(tenAway), "loose")).toBe(true)
  })
})

describe("groupPhotos", () => {
  it("groups similar shots taken close together", () => {
    expect(names(groupPhotos([p("1", 0, A), p("2", 5, A2), p("3", 10, A)], opts))).toEqual([["1", "2", "3"]])
  })

  it("drops singletons and different scenes", () => {
    expect(names(groupPhotos([p("1", 0, A), p("2", 5, FAR)], opts))).toEqual([])
  })

  it("never groups across the time window", () => {
    expect(names(groupPhotos([p("1", 0, A), p("2", 61, A)], opts))).toEqual([])
    expect(names(groupPhotos([p("1", 0, A), p("2", 60, A)], opts))).toEqual([["1", "2"]])
  })

  it("chains A~B~C even when A and C are outside the window", () => {
    expect(names(groupPhotos([p("1", 0, A), p("2", 50, A), p("3", 100, A)], opts))).toEqual([["1", "2", "3"]])
  })

  it("sorts by time regardless of input order and orders groups by first photo", () => {
    const out = groupPhotos([p("d", 500, FAR), p("b", 10, A), p("c", 490, FAR), p("a", 0, A)], opts)
    expect(names(out)).toEqual([["a", "b"], ["c", "d"]])
  })

  it("splits a 40-shot burst into chunks no larger than the max, with no chunk of 1", () => {
    const burst = Array.from({ length: 40 }, (_, i) => p(`b${i}`, i, A))
    const out = groupPhotos(burst, { ...opts, maxGroupSize: 12 })
    expect(out.map((g) => g.length)).toEqual([12, 12, 12, 4])
    const out13 = groupPhotos(burst.slice(0, 13), { ...opts, maxGroupSize: 12 })
    expect(out13.every((g) => g.length >= 2 && g.length <= 13)).toBe(true)
    expect(out13.flat()).toHaveLength(13)
  })
})

describe("splitGroup", () => {
  it("merges a trailing single into the previous chunk", () => {
    expect(splitGroup([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4, 5]])
    expect(splitGroup([1, 2, 3], 5)).toEqual([[1, 2, 3]])
    expect(splitGroup([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/ai/grouping.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `lib/ai/grouping.ts`**

```ts
import { colorDistance, hamming, type Fingerprint } from "@/lib/ai/fingerprint"
import type { Similarity } from "@/lib/ai/settings-schema"

// Groups takes of the same moment: photos within the time window whose
// fingerprints are close. Matches chain (A~B and B~C → one group). Starting
// values; tune against real bursts.

export const THRESHOLDS: Record<Similarity, { hash: number; color: number }> = {
  strict: { hash: 6, color: 12 },
  similar: { hash: 12, color: 20 },
  loose: { hash: 18, color: 30 },
}

export type GroupInput = { name: string; takenAt: number; fp: Fingerprint }

export function isSimilar(a: Fingerprint, b: Fingerprint, level: Similarity): boolean {
  const t = THRESHOLDS[level]
  return hamming(a.hash, b.hash) <= t.hash && colorDistance(a.colors, b.colors) <= t.color
}

/** Consecutive chunks of at most `max`; a trailing chunk of 1 joins the previous chunk. */
export function splitGroup<T>(items: T[], max: number): T[][] {
  if (items.length <= max) return [items]
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += max) chunks.push(items.slice(i, i + max))
  if (chunks.length > 1 && chunks[chunks.length - 1].length === 1) {
    const last = chunks.pop()!
    chunks[chunks.length - 1].push(...last)
  }
  return chunks
}

export function groupPhotos(
  photos: GroupInput[],
  opts: { windowSeconds: number; similarity: Similarity; maxGroupSize: number }
): GroupInput[][] {
  const sorted = [...photos].sort((a, b) => a.takenAt - b.takenAt || a.name.localeCompare(b.name))
  const parent = sorted.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const windowMs = opts.windowSeconds * 1000

  for (let i = 1; i < sorted.length; i++) {
    for (let j = i - 1; j >= 0 && sorted[i].takenAt - sorted[j].takenAt <= windowMs; j--) {
      if (isSimilar(sorted[i].fp, sorted[j].fp, opts.similarity)) parent[find(i)] = find(j)
    }
  }

  const byRoot = new Map<number, GroupInput[]>()
  sorted.forEach((photo, i) => {
    const r = find(i)
    byRoot.set(r, [...(byRoot.get(r) ?? []), photo])
  })

  return [...byRoot.values()]
    .filter((g) => g.length >= 2)
    .sort((a, b) => a[0].takenAt - b[0].takenAt)
    .flatMap((g) => splitGroup(g, opts.maxGroupSize))
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/ai/grouping.test.ts` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/ai/grouping.ts lib/ai/grouping.test.ts
git commit -m "feat(ai): time-window + fingerprint grouping"
```

---

### Task 7: Capture time

**Files:**
- Create: `lib/ai/capture-time.ts`
- Test: `lib/ai/capture-time.test.ts`
- Modify: `package.json` (dependency `exif-reader`)

**Interfaces:**
- Produces:
  - `captureTimeFromExif(exif: Buffer | undefined, fallbackMs: number): number`
  - `readCaptureTime(file: string, fallbackMs: number): Promise<number>`

- [ ] **Step 1: Install the parser**

Run: `npm install exif-reader@^2.0.3`

- [ ] **Step 2: Write failing tests**

`lib/ai/capture-time.test.ts`:

```ts
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { captureTimeFromExif, readCaptureTime } from "./capture-time"

async function withDate(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
    .withExif({ IFD0: { DateTime: "2024:05:01 10:00:00" } })
    .jpeg()
    .toBuffer()
}

describe("captureTimeFromExif", () => {
  it("reads the EXIF date (as wall-clock UTC)", async () => {
    const exif = (await sharp(await withDate()).metadata()).exif
    expect(captureTimeFromExif(exif, 0)).toBe(Date.UTC(2024, 4, 1, 10, 0, 0))
  })

  it("falls back when there is no EXIF or it is garbage", () => {
    expect(captureTimeFromExif(undefined, 123)).toBe(123)
    expect(captureTimeFromExif(Buffer.from("not exif"), 456)).toBe(456)
  })
})

describe("readCaptureTime", () => {
  it("falls back for a file that can't be read", async () => {
    expect(await readCaptureTime("/definitely/not/here.jpg", 789)).toBe(789)
  })
})
```

Run: `npx vitest run lib/ai/capture-time.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `lib/ai/capture-time.ts`**

```ts
import exifReader from "exif-reader"
import sharp from "sharp"

// When a photo was taken: EXIF DateTimeOriginal, else DateTime, else the
// file's modified time. EXIF has no time zone; exif-reader returns the
// wall-clock time as UTC, which is consistent within a folder — all grouping
// needs is the order and gaps between shots.

function valid(d: unknown): number | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) && d.getUTCFullYear() > 1990 ? d.getTime() : null
}

export function captureTimeFromExif(exif: Buffer | undefined, fallbackMs: number): number {
  if (!exif) return fallbackMs
  try {
    const data = exifReader(exif) as { Photo?: { DateTimeOriginal?: unknown }; Image?: { DateTime?: unknown } }
    return valid(data.Photo?.DateTimeOriginal) ?? valid(data.Image?.DateTime) ?? fallbackMs
  } catch {
    return fallbackMs
  }
}

export async function readCaptureTime(file: string, fallbackMs: number): Promise<number> {
  try {
    const { exif } = await sharp(file).metadata()
    return captureTimeFromExif(exif, fallbackMs)
  } catch {
    return fallbackMs // e.g. HEIC sharp can't open, or the file vanished
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/ai/capture-time.test.ts` — Expected: pass. If TypeScript reports no types for `exif-reader`, add `declare module "exif-reader"` with `export default function exifReader(buf: Buffer): unknown` in `types/exif-reader.d.ts` (v2 ships its own types, so this is only a fallback).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json lib/ai/capture-time.ts lib/ai/capture-time.test.ts
git commit -m "feat(ai): capture time from EXIF with fallback"
```

---

### Task 8: Prompt and reply parsing

**Files:**
- Create: `lib/ai/prompt.ts`
- Test: `lib/ai/prompt.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` (Task 3).
- Produces:
  - `BUILTIN_INSTRUCTION: string`
  - `buildMessages(images: string[], customPrompt: string | null, previousError?: string): ChatMessage[]` — `images` are data URLs, in photo order 1..n
  - `type AiVerdict = { ranking: { photo: number; note: string }[]; best: number[]; reason: string }`
  - `parseVerdict(text: string, n: number): { ok: true; value: AiVerdict } | { ok: false; error: string }`

- [ ] **Step 1: Write failing tests**

`lib/ai/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { buildMessages, parseVerdict } from "./prompt"

describe("buildMessages", () => {
  it("numbers the photos and adds the custom prompt and retry note", () => {
    const msgs = buildMessages(["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"], "Prefer the dog in focus.", "best was empty")
    expect(msgs[0].role).toBe("system")
    expect(String(msgs[0].content)).toContain("Prefer the dog in focus.")
    const parts = msgs[1].content as { type: string; text?: string; image_url?: { url: string } }[]
    expect(parts.filter((p) => p.type === "image_url").map((p) => p.image_url!.url)).toEqual(["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"])
    expect(parts.some((p) => p.text?.includes("Photo 2"))).toBe(true)
    expect(parts.some((p) => p.text?.includes("best was empty"))).toBe(true)
  })
})

describe("parseVerdict", () => {
  const good = { ranking: [{ photo: 2, note: "all looking" }, { photo: 1, note: "blink" }], best: [2], reason: "Everyone smiling in 2." }

  it("parses plain JSON", () => {
    const r = parseVerdict(JSON.stringify(good), 2)
    expect(r).toEqual({ ok: true, value: good })
  })

  it("finds JSON inside prose and code fences", () => {
    const r = parseVerdict("Sure! Here you go:\n```json\n" + JSON.stringify(good) + "\n```\nHope that helps.", 2)
    expect(r.ok).toBe(true)
  })

  it("appends photos the model left out, in order", () => {
    const r = parseVerdict(JSON.stringify({ ranking: [{ photo: 3, note: "" }], best: [3], reason: "x" }), 3)
    expect(r.ok && r.value.ranking.map((x) => x.photo)).toEqual([3, 1, 2])
  })

  it("drops repeated photo numbers, keeping the first", () => {
    const r = parseVerdict(JSON.stringify({ ranking: [{ photo: 1, note: "a" }, { photo: 1, note: "b" }, { photo: 2, note: "" }], best: [1], reason: "" }), 2)
    expect(r.ok && r.value.ranking).toEqual([{ photo: 1, note: "a" }, { photo: 2, note: "" }])
  })

  it("accepts best as a single number and fills best from rank 1 when missing", () => {
    const one = parseVerdict(JSON.stringify({ ...good, best: 2 }), 2)
    expect(one.ok && one.value.best).toEqual([2])
    const none = parseVerdict(JSON.stringify({ ranking: good.ranking, reason: "" }), 2)
    expect(none.ok && none.value.best).toEqual([2])
  })

  it("rejects unknown photo numbers", () => {
    expect(parseVerdict(JSON.stringify({ ...good, ranking: [{ photo: 5, note: "" }] }), 2).ok).toBe(false)
    expect(parseVerdict(JSON.stringify({ ...good, best: [0] }), 2).ok).toBe(false)
  })

  it("rejects text with no JSON object", () => {
    expect(parseVerdict("I think photo 2 is best.", 2).ok).toBe(false)
    expect(parseVerdict("{not json}", 2).ok).toBe(false)
  })

  it("trims long notes and reasons", () => {
    const r = parseVerdict(JSON.stringify({ ranking: [{ photo: 1, note: "n".repeat(500) }, { photo: 2 }], best: [1], reason: "r".repeat(5000) }), 2)
    expect(r.ok && r.value.ranking[0].note.length).toBe(200)
    expect(r.ok && r.value.reason.length).toBe(1000)
    expect(r.ok && r.value.ranking[1].note).toBe("")
  })
})
```

Run: `npx vitest run lib/ai/prompt.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement `lib/ai/prompt.ts`**

```ts
import { z } from "zod"
import type { ChatMessage, ContentPart } from "@/lib/ai/client"

export const BUILTIN_INSTRUCTION = `You help a family choose the best photo from a burst of near-identical takes of the same moment.
Judge the main subjects only (the people the photo is clearly about); ignore people in the background.
Rank every photo from best to worst using, in order of importance:
1. Main subjects' eyes are open (no blinks, no half-closed eyes).
2. Main subjects are looking at the camera.
3. Natural smiles and pleasant expressions.
4. Sharp focus on faces, no motion blur.
5. Good exposure; nobody important cut off at the edges.
If there are no people, judge sharpness, exposure and composition.
Reply with JSON only, no other text, in exactly this shape:
{"ranking":[{"photo":<number>,"note":"<short reason, under 15 words>"}],"best":[<photo number>],"reason":"<one or two sentences on why the best photo wins>"}
"ranking" must include every photo number exactly once. "best" is usually one photo; list two only if they are equally good.`

export function buildMessages(images: string[], customPrompt: string | null, previousError?: string): ChatMessage[] {
  const system = customPrompt ? `${BUILTIN_INSTRUCTION}\n\nAdditional instructions from the family:\n${customPrompt}` : BUILTIN_INSTRUCTION
  const parts: ContentPart[] = [{ type: "text", text: `Here are ${images.length} photos of the same moment, numbered 1 to ${images.length}.` }]
  images.forEach((url, i) => {
    parts.push({ type: "text", text: `Photo ${i + 1}:` })
    parts.push({ type: "image_url", image_url: { url } })
  })
  if (previousError) parts.push({ type: "text", text: `Your previous reply could not be used (${previousError}). Reply again with valid JSON only.` })
  return [{ role: "system", content: system }, { role: "user", content: parts }]
}

export type AiVerdict = { ranking: { photo: number; note: string }[]; best: number[]; reason: string }

const replySchema = z.object({
  ranking: z.array(z.object({ photo: z.coerce.number().int(), note: z.string().optional().nullable() })).min(1),
  best: z.union([z.coerce.number().int(), z.array(z.coerce.number().int())]).optional(),
  reason: z.string().optional().nullable(),
})

function extractJson(text: string): unknown {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("no JSON object in the reply")
  return JSON.parse(text.slice(start, end + 1))
}

export function parseVerdict(text: string, n: number): { ok: true; value: AiVerdict } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = extractJson(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" }
  }
  const parsed = replySchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: "the JSON doesn't match the requested shape" }

  const inRange = (x: number) => x >= 1 && x <= n
  const seen = new Set<number>()
  const ranking: AiVerdict["ranking"] = []
  for (const r of parsed.data.ranking) {
    if (!inRange(r.photo)) return { ok: false, error: `photo ${r.photo} doesn't exist (there are ${n})` }
    if (seen.has(r.photo)) continue
    seen.add(r.photo)
    ranking.push({ photo: r.photo, note: (r.note ?? "").slice(0, 200) })
  }
  for (let i = 1; i <= n; i++) if (!seen.has(i)) ranking.push({ photo: i, note: "" })

  const bestRaw = parsed.data.best
  const best = bestRaw === undefined ? [ranking[0].photo] : [...new Set(Array.isArray(bestRaw) ? bestRaw : [bestRaw])]
  if (best.length === 0 || !best.every(inRange)) return { ok: false, error: "best must name existing photos" }

  return { ok: true, value: { ranking, best, reason: (parsed.data.reason ?? "").slice(0, 1000) } }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run lib/ai/prompt.test.ts` — Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add lib/ai/prompt.ts lib/ai/prompt.test.ts
git commit -m "feat(ai): prompt building and verdict parsing"
```

---

### Task 9: Scan priority lane in the thumbnail queue

**Files:**
- Modify: `lib/task-queue.ts`, `lib/task-queue.test.ts`
- Modify: `lib/thumbs-server.ts` (only the `Priority` import already flows through; no code change needed beyond the type)

**Interfaces:**
- Produces: `type Priority = "high" | "low" | "scan"`; order high → low → scan; a waiting job is promoted when requested at a higher priority.

- [ ] **Step 1: Add failing tests to `lib/task-queue.test.ts`**

```ts
  it("runs scan work after background work", async () => {
    const q = createTaskQueue(1)
    const gate = deferred()
    const order: string[] = []
    const blocker = q.run("blocker", () => gate.promise)
    const scan = q.run("scan", async () => void order.push("scan"), "scan")
    const low = q.run("low", async () => void order.push("low"), "low")
    gate.resolve()
    await Promise.all([blocker, scan, low])
    expect(order).toEqual(["low", "scan"])
  })

  it("promotes a queued scan job to high when someone views it", async () => {
    const q = createTaskQueue(1)
    const gate = deferred()
    const order: string[] = []
    const blocker = q.run("blocker", () => gate.promise)
    const low = q.run("low", async () => void order.push("low"), "low")
    const scan = q.run("x", async () => void order.push("x"), "scan")
    const view = q.run("x", async () => void order.push("dup"), "high")
    gate.resolve()
    await Promise.all([blocker, low, scan, view])
    expect(order).toEqual(["x", "low"])
  })
```

Run: `npx vitest run lib/task-queue.test.ts` — Expected: FAIL (type error / wrong order).

- [ ] **Step 2: Generalise `lib/task-queue.ts`**

Replace the lane logic:

```ts
export type Priority = "high" | "low" | "scan"
const ORDER: Priority[] = ["high", "low", "scan"]
```

- `const lanes: Record<Priority, Job[]> = { high: [], low: [], scan: [] }`
- In `next()`: `const job = ORDER.map((p) => lanes[p]).find((l) => l.length)?.shift()`
- Promotion in `run()`:

```ts
      if (existing) {
        if (existing.job && ORDER.indexOf(priority) < ORDER.indexOf(existing.priority)) {
          const lane = lanes[existing.priority]
          const i = lane.indexOf(existing.job)
          if (i >= 0) {
            lane.splice(i, 1)
            lanes[priority].push(existing.job)
            existing.priority = priority
          }
        }
        return existing.promise as Promise<T>
      }
```

- `pending` getter: `return ORDER.reduce((n, p) => n + lanes[p].length, 0)`
- Update the file's header comment: "Three lanes: thumbnails someone is looking at, the background worker's backlog, then AI scan preparation."

- [ ] **Step 3: Run tests**

Run: `npx vitest run lib/task-queue.test.ts && npx tsc --noEmit` — Expected: pass, no type errors.

- [ ] **Step 4: Commit**

```bash
git add lib/task-queue.ts lib/task-queue.test.ts
git commit -m "feat(ai): scan lane in the thumbnail queue"
```

---

### Task 10: Analysis loop (testable core of the runner)

**Files:**
- Create: `lib/ai/analysis-loop.ts`
- Test: `lib/ai/analysis-loop.test.ts`

**Interfaces:**
- Consumes: `AiError` (Task 3); `buildMessages`, `parseVerdict`, `AiVerdict` (Task 8).
- Produces:
  - `type PendingGroup = { id: string; photoCount: number }`
  - `type LoopDeps = { prepareImages(groupId: string): Promise<string[]>; callAi(messages: ChatMessage[]): Promise<string>; onAnalyzed(groupId: string, verdict: AiVerdict): Promise<void>; onFailed(groupId: string, error: string): Promise<void>; isCancelled(): Promise<boolean>; customPrompt: string | null }`
  - `type LoopOutcome = { status: "done" } | { status: "cancelled" } | { status: "failed"; error: string }`
  - `analyzeGroups(groups: PendingGroup[], deps: LoopDeps): Promise<LoopOutcome>`
  - `UNREACHABLE_AFTER = 3`

- [ ] **Step 1: Write failing tests**

`lib/ai/analysis-loop.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { AiError } from "./client"
import { analyzeGroups, type LoopDeps } from "./analysis-loop"

const verdict = (best = 1) => JSON.stringify({ ranking: [{ photo: 1, note: "" }, { photo: 2, note: "" }], best: [best], reason: "ok" })
const groups = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `g${i}`, photoCount: 2 }))

function deps(replies: (string | Error)[], extra: Partial<LoopDeps> = {}) {
  const analyzed: string[] = []
  const failed: { id: string; error: string }[] = []
  let call = 0
  const d: LoopDeps = {
    prepareImages: async () => ["data:a", "data:b"],
    callAi: async () => {
      const r = replies[Math.min(call++, replies.length - 1)]
      if (r instanceof Error) throw r
      return r
    },
    onAnalyzed: async (id) => void analyzed.push(id),
    onFailed: async (id, error) => void failed.push({ id, error }),
    isCancelled: async () => false,
    customPrompt: null,
    ...extra,
  }
  return { d, analyzed, failed, calls: () => call }
}

describe("analyzeGroups", () => {
  it("analyzes every group", async () => {
    const { d, analyzed } = deps([verdict()])
    expect(await analyzeGroups(groups(3), d)).toEqual({ status: "done" })
    expect(analyzed).toEqual(["g0", "g1", "g2"])
  })

  it("asks again once after an unusable reply", async () => {
    const { d, analyzed, calls } = deps(["no json here", verdict()])
    await analyzeGroups(groups(1), d)
    expect(analyzed).toEqual(["g0"])
    expect(calls()).toBe(2)
  })

  it("fails the group after two unusable replies and moves on", async () => {
    const { d, analyzed, failed } = deps(["nope", "still nope", verdict()])
    expect(await analyzeGroups(groups(2), d)).toEqual({ status: "done" })
    expect(failed.map((f) => f.id)).toEqual(["g0"])
    expect(analyzed).toEqual(["g1"])
  })

  it("stops the run after 3 groups in a row can't reach the server", async () => {
    const { d, failed } = deps([new AiError("network", "down")])
    const out = await analyzeGroups(groups(5), d)
    expect(out.status).toBe("failed")
    expect(out.status === "failed" && out.error).toMatch(/unreachable/i)
    expect(failed).toHaveLength(3)
  })

  it("resets the unreachable count after a success", async () => {
    const down = new AiError("timeout", "slow")
    const { d } = deps([down, down, verdict(), down, down, verdict()])
    expect((await analyzeGroups(groups(4), d)).status).toBe("done")
  })

  it("stops at once on a bad key or unknown model", async () => {
    const { d, failed } = deps([new AiError("auth", "bad key")])
    expect(await analyzeGroups(groups(3), d)).toEqual({ status: "failed", error: "bad key" })
    expect(failed).toHaveLength(0)
  })

  it("fails only the group when the model rejects images, and keeps going", async () => {
    const { d, failed, analyzed } = deps([new AiError("bad-request", "images not supported"), verdict(), verdict()])
    expect((await analyzeGroups(groups(3), d)).status).toBe("done")
    expect(failed.map((f) => f.id)).toEqual(["g0"])
    expect(analyzed).toEqual(["g1", "g2"])
  })

  it("fails a group whose photos can't be prepared, without counting it as unreachable", async () => {
    let n = 0
    const { d, failed } = deps([verdict()], { prepareImages: async () => { if (n++ === 0) throw new Error("photo gone"); return ["a", "b"] } })
    expect((await analyzeGroups(groups(2), d)).status).toBe("done")
    expect(failed[0]).toEqual({ id: "g0", error: "photo gone" })
  })

  it("stops between groups when cancelled", async () => {
    let checks = 0
    const { d, analyzed } = deps([verdict()], { isCancelled: async () => ++checks > 1 })
    expect(await analyzeGroups(groups(3), d)).toEqual({ status: "cancelled" })
    expect(analyzed).toEqual(["g0"])
  })

  it("treats an aborted request as cancelled", async () => {
    const { d } = deps([new AiError("cancelled", "Cancelled.")])
    expect(await analyzeGroups(groups(2), d)).toEqual({ status: "cancelled" })
  })
})
```

Run: `npx vitest run lib/ai/analysis-loop.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement `lib/ai/analysis-loop.ts`**

```ts
import { AiError, type ChatMessage } from "@/lib/ai/client"
import { buildMessages, parseVerdict, type AiVerdict } from "@/lib/ai/prompt"

// Sends groups to the AI one at a time and reports each result through
// callbacks, so the rules (retry once on a bad reply, stop on a bad key,
// stop after repeated connection failures, honour cancel) are testable
// without a database.

export const UNREACHABLE_AFTER = 3

export type PendingGroup = { id: string; photoCount: number }

export type LoopDeps = {
  prepareImages(groupId: string): Promise<string[]>
  callAi(messages: ChatMessage[]): Promise<string>
  onAnalyzed(groupId: string, verdict: AiVerdict): Promise<void>
  onFailed(groupId: string, error: string): Promise<void>
  isCancelled(): Promise<boolean>
  customPrompt: string | null
}

export type LoopOutcome = { status: "done" } | { status: "cancelled" } | { status: "failed"; error: string }

export async function analyzeGroups(groups: PendingGroup[], deps: LoopDeps): Promise<LoopOutcome> {
  let unreachable = 0

  for (const group of groups) {
    if (await deps.isCancelled()) return { status: "cancelled" }

    let images: string[]
    try {
      images = await deps.prepareImages(group.id)
    } catch (error) {
      await deps.onFailed(group.id, error instanceof Error ? error.message : String(error))
      continue
    }

    try {
      let text = await deps.callAi(buildMessages(images, deps.customPrompt))
      let verdict = parseVerdict(text, images.length)
      if (!verdict.ok) {
        text = await deps.callAi(buildMessages(images, deps.customPrompt, verdict.error))
        verdict = parseVerdict(text, images.length)
      }
      if (verdict.ok) await deps.onAnalyzed(group.id, verdict.value)
      else await deps.onFailed(group.id, `The AI's reply couldn't be used: ${verdict.error}.`)
      unreachable = 0
    } catch (error) {
      if (!(error instanceof AiError)) {
        await deps.onFailed(group.id, error instanceof Error ? error.message : String(error))
        continue
      }
      if (error.kind === "cancelled") return { status: "cancelled" }
      if (error.kind === "auth" || error.kind === "model") return { status: "failed", error: error.message }
      await deps.onFailed(group.id, error.message)
      if (error.kind === "network" || error.kind === "timeout") {
        if (++unreachable >= UNREACHABLE_AFTER) return { status: "failed", error: `AI server unreachable: ${error.message}` }
      } else {
        unreachable = 0
      }
    }
  }
  return { status: "done" }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run lib/ai/analysis-loop.test.ts` — Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add lib/ai/analysis-loop.ts lib/ai/analysis-loop.test.ts
git commit -m "feat(ai): analysis loop with retry, cancel and unreachable rules"
```

---

### Task 11: Runner, review logic and server actions

**Files:**
- Create: `lib/ai/review.ts` (pure) + `lib/ai/review.test.ts`
- Create: `lib/ai/runner-server.ts`
- Create: `lib/ai/review-server.ts`
- Create: `lib/actions/ai.ts`
- Modify: `instrumentation.ts`
- Modify: `lib/library-server.ts` (add `listScanFolders`)

**Interfaces:**
- Consumes: everything from Tasks 1–10; `rootPath`, `resolveInside`, `mediaKind`, `fileVersion`, `isRootKey`, `isSkippedDir`, `safeSegments`, `RootKey` (existing); `ensureVariant` (existing, now with `"scan"` priority); `moveToDropoff`, `trashFiles`, `restoreBatch` (existing).
- Produces:
  - `lib/ai/review.ts`: `scanFolderSegments(folder: string): string[] | null`; `folderKey(segments: string[]): string`; `classifyPhotos(stored: { name: string; version: string }[], current: Map<string, string>): { valid: string[]; missing: string[] }`; `planResolution(valid: string[], keep: string[]): { keep: string[]; trash: string[] } | { error: string }`
  - `lib/ai/runner-server.ts`: `startAiRunner(): void`, `kickRunner(): void`, `abortRun(runId: string): void`
  - `lib/ai/review-server.ts`: `currentVersions(root: RootKey, folder: string, names: string[]): Promise<Map<string, string>>`, `resolveGroup(groupId: string, keep: string[], userId: string)`, `dismissGroup(groupId: string, userId: string)`, `undoGroup(groupId: string)`
  - `lib/actions/ai.ts`: `startRunAction({ root, folder, fresh })`, `cancelRunAction(runId)`, `retryRunAction(runId)`, `removeRunAction(runId)`, `resolveGroupAction(groupId, keep)`, `dismissGroupAction(groupId)`, `undoGroupAction(groupId)`
  - `lib/library-server.ts`: `type ScanFolder = { root: RootKey; folder: string; imageCount: number }`, `listScanFolders(): Promise<ScanFolder[]>`

- [ ] **Step 1: Write failing tests for the pure review helpers**

`lib/ai/review.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { classifyPhotos, folderKey, planResolution, scanFolderSegments } from "./review"

describe("scanFolderSegments", () => {
  it("accepts the root and nested folders with odd characters", () => {
    expect(scanFolderSegments("")).toEqual([])
    expect(scanFolderSegments("jessi/Trip 2026")).toEqual(["jessi", "Trip 2026"])
    expect(scanFolderSegments("50% off/#1")).toEqual(["50% off", "#1"])
  })

  it("rejects anything that climbs out", () => {
    expect(scanFolderSegments("../etc")).toBeNull()
    expect(scanFolderSegments("jessi/../../x")).toBeNull()
  })

  it("round-trips through folderKey", () => {
    expect(folderKey(scanFolderSegments("a/b c")!)).toBe("a/b c")
  })
})

describe("classifyPhotos", () => {
  it("keeps only photos whose version is unchanged", () => {
    const stored = [{ name: "a.jpg", version: "1" }, { name: "b.jpg", version: "1" }, { name: "c.jpg", version: "1" }]
    const current = new Map([["a.jpg", "1"], ["b.jpg", "2"]]) // b rotated, c gone
    expect(classifyPhotos(stored, current)).toEqual({ valid: ["a.jpg"], missing: ["b.jpg", "c.jpg"] })
  })
})

describe("planResolution", () => {
  it("splits valid photos into keep and trash", () => {
    expect(planResolution(["a", "b", "c"], ["b"])).toEqual({ keep: ["b"], trash: ["a", "c"] })
  })

  it("ignores keeps that are no longer valid and needs at least one keeper", () => {
    expect(planResolution(["a", "b"], ["z"])).toEqual({ error: "Keep at least one photo." })
    expect(planResolution(["a", "b"], ["a", "z"])).toEqual({ keep: ["a"], trash: ["b"] })
  })
})
```

Run: `npx vitest run lib/ai/review.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement `lib/ai/review.ts`**

```ts
import { safeSegments } from "@/lib/media"

// Pure rules for acting on a reviewed group.

/** Folder string as stored on a run ("a/b", "" = root) → safe segments, or null. */
export function scanFolderSegments(folder: string): string[] | null {
  if (folder === "") return []
  return safeSegments(folder.split("/"))
}

export function folderKey(segments: string[]): string {
  return segments.join("/")
}

/** A photo is safe to act on only if it still exists with the version seen at scan time. */
export function classifyPhotos(stored: { name: string; version: string }[], current: Map<string, string>): { valid: string[]; missing: string[] } {
  const valid: string[] = []
  const missing: string[] = []
  for (const p of stored) (current.get(p.name) === p.version ? valid : missing).push(p.name)
  return { valid, missing }
}

export function planResolution(valid: string[], keep: string[]): { keep: string[]; trash: string[] } | { error: string } {
  const keepSet = new Set(keep)
  const kept = valid.filter((n) => keepSet.has(n))
  if (kept.length === 0) return { error: "Keep at least one photo." }
  return { keep: kept, trash: valid.filter((n) => !keepSet.has(n)) }
}
```

Run: `npx vitest run lib/ai/review.test.ts` — Expected: PASS.

- [ ] **Step 3: Add `listScanFolders` to `lib/library-server.ts`**

```ts
export type ScanFolder = { root: RootKey; folder: string; imageCount: number }

/** Every folder in both roots (depth ≤ 6) with the number of images directly inside, for the AI scan picker. */
export async function listScanFolders(): Promise<ScanFolder[]> {
  const out: ScanFolder[] = []
  async function walk(root: RootKey, segments: string[], depth: number) {
    let entries
    try {
      entries = await fs.readdir(path.join(rootPath(root), ...segments), { withFileTypes: true })
    } catch {
      return
    }
    const imageCount = entries.filter((e) => e.isFile() && mediaKind(e.name) === "image").length
    out.push({ root, folder: segments.join("/"), imageCount })
    if (depth >= 6) return
    for (const e of entries) if (e.isDirectory() && !isSkippedDir(e.name)) await walk(root, [...segments, e.name], depth + 1)
  }
  for (const root of ROOT_KEYS) await walk(root, [], 0)
  return out
}
```

- [ ] **Step 4: Create `lib/ai/review-server.ts`**

```ts
import "server-only"
import fs from "fs/promises"
import path from "path"
import { prisma } from "@/lib/prisma"
import { rootPath } from "@/lib/library-server"
import { fileVersion, isRootKey, type RootKey } from "@/lib/media"
import { moveToDropoff, restoreBatch, trashFiles } from "@/lib/file-ops-server"
import { classifyPhotos, planResolution, scanFolderSegments } from "@/lib/ai/review"

export async function currentVersions(root: RootKey, folder: string, names: string[]): Promise<Map<string, string>> {
  const segs = scanFolderSegments(folder)
  const map = new Map<string, string>()
  if (!segs) return map
  const dir = path.join(rootPath(root), ...segs)
  await Promise.all(
    names.map(async (name) => {
      try {
        map.set(name, fileVersion(await fs.stat(path.join(dir, name))))
      } catch {
        // gone
      }
    })
  )
  return map
}

export type ResolveResult = { error: string } | { moved: number; kept: number; trashed: number; missing: number }

export async function resolveGroup(groupId: string, keep: string[], userId: string): Promise<ResolveResult> {
  const group = await prisma.aiGroup.findUnique({ where: { id: groupId }, include: { photos: true } })
  if (!group || !isRootKey(group.root)) return { error: "That group no longer exists." }
  if (group.status !== "ANALYZED") return { error: "That group has already been handled." }
  const segs = scanFolderSegments(group.folder)
  if (!segs) return { error: "Invalid folder." }

  const current = await currentVersions(group.root, group.folder, group.photos.map((p) => p.name))
  const { valid, missing } = classifyPhotos(group.photos, current)
  const plan = planResolution(valid, keep)
  if ("error" in plan) return plan

  // Claim the group first so a double click or a second user can't act twice.
  const claimed = await prisma.aiGroup.updateMany({ where: { id: groupId, status: "ANALYZED" }, data: { status: "RESOLVED", resolvedById: userId, resolvedAt: new Date() } })
  if (claimed.count === 0) return { error: "That group has already been handled." }

  let moved = 0
  let trashBatchId: string | null = null
  let trashedNames: string[] = []
  try {
    if (group.root === "upload" && plan.keep.length) moved = (await moveToDropoff(segs, plan.keep)).ok.length
    if (plan.trash.length) {
      const t = await trashFiles(group.root, segs, plan.trash)
      trashBatchId = t.batchId
      trashedNames = t.ok
    }
  } catch (error) {
    await prisma.aiGroup.update({ where: { id: groupId }, data: { status: "ANALYZED", resolvedById: null, resolvedAt: null } })
    return { error: error instanceof Error ? error.message : String(error) }
  }

  const keepSet = new Set(plan.keep)
  const trashSet = new Set(trashedNames)
  await prisma.$transaction([
    ...group.photos.map((p) =>
      prisma.aiGroupPhoto.update({
        where: { id: p.id },
        data: { decision: keepSet.has(p.name) ? "KEEP" : trashSet.has(p.name) ? "TRASH" : null },
      })
    ),
    prisma.aiGroup.update({ where: { id: groupId }, data: { trashBatchId } }),
  ])
  return { moved, kept: plan.keep.length, trashed: trashedNames.length, missing: missing.length }
}

export async function dismissGroup(groupId: string, userId: string): Promise<{ error: string } | { ok: true }> {
  const r = await prisma.aiGroup.updateMany({
    where: { id: groupId, status: { in: ["ANALYZED", "FAILED"] } },
    data: { status: "DISMISSED", resolvedById: userId, resolvedAt: new Date() },
  })
  return r.count ? { ok: true } : { error: "That group has already been handled." }
}

export async function undoGroup(groupId: string): Promise<{ error: string } | { restored: number }> {
  const group = await prisma.aiGroup.findUnique({ where: { id: groupId } })
  if (!group || !isRootKey(group.root)) return { error: "That group no longer exists." }
  if (group.status !== "RESOLVED" && group.status !== "DISMISSED") return { error: "Nothing to undo." }
  let restored = 0
  if (group.trashBatchId) restored = (await restoreBatch(group.root, group.trashBatchId)).ok.length
  await prisma.$transaction([
    prisma.aiGroupPhoto.updateMany({ where: { groupId }, data: { decision: null } }),
    prisma.aiGroup.update({ where: { id: groupId }, data: { status: "ANALYZED", trashBatchId: null, resolvedById: null, resolvedAt: null } }),
  ])
  return { restored }
}
```

Note: after Undo, photos that were moved to Sort Dropoff no longer match the folder, so the card shows them as "no longer here" — consistent with the spec ("moved photos stay in Sort Dropoff").

- [ ] **Step 5: Create `lib/ai/runner-server.ts`**

```ts
import "server-only"
import fs from "fs/promises"
import path from "path"
import sharp from "sharp"
import { prisma } from "@/lib/prisma"
import { rootPath } from "@/lib/library-server"
import { fileVersion, isRootKey, mediaKind, type RootKey } from "@/lib/media"
import { ensureVariant } from "@/lib/thumbs-server"
import { clientConfig, loadAiConfig, type AiConfig } from "@/lib/ai/config"
import { isAiReady } from "@/lib/ai/settings-schema"
import { chatWithRetry } from "@/lib/ai/client"
import { fingerprintImage } from "@/lib/ai/fingerprint"
import { groupPhotos, type GroupInput } from "@/lib/ai/grouping"
import { readCaptureTime } from "@/lib/ai/capture-time"
import { analyzeGroups } from "@/lib/ai/analysis-loop"
import { scanFolderSegments } from "@/lib/ai/review"
import type { AiRun } from "@/app/generated/prisma/client"

// Runs AI review scans in the background, one at a time. All state lives in
// the database, so a restart resumes: a run without groupedAt is grouped
// (again), a grouped run continues with its PENDING groups.

const POLL_MS = 5_000

type State = { started: boolean; busy: boolean; timer: NodeJS.Timeout | null; current: { runId: string; controller: AbortController } | null }
const g = globalThis as unknown as { __psAiRunner?: State }
const state: State = (g.__psAiRunner ??= { started: false, busy: false, timer: null, current: null })

export function startAiRunner() {
  if (state.started) return
  state.started = true
  state.timer = setInterval(() => void tick(), POLL_MS)
  state.timer.unref()
  void tick()
}

export function kickRunner() {
  void tick()
}

export function abortRun(runId: string) {
  if (state.current?.runId === runId) state.current.controller.abort()
}

async function tick() {
  if (state.busy) return
  state.busy = true
  try {
    for (;;) {
      const run =
        (await prisma.aiRun.findFirst({ where: { status: { in: ["GROUPING", "ANALYZING"] } }, orderBy: { createdAt: "asc" } })) ??
        (await prisma.aiRun.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } }))
      if (!run) return
      await processRun(run)
    }
  } catch (error) {
    console.error("[ai] runner error:", error)
  } finally {
    state.busy = false
  }
}

async function finish(runId: string, data: { status: "DONE" | "FAILED" | "CANCELLED"; error?: string }) {
  const [analyzed, failed] = await Promise.all([
    prisma.aiGroup.count({ where: { runId, status: { in: ["ANALYZED", "RESOLVED", "DISMISSED"] } } }),
    prisma.aiGroup.count({ where: { runId, status: "FAILED" } }),
  ])
  // Don't overwrite a cancel that arrived while we were working.
  const current = await prisma.aiRun.findUnique({ where: { id: runId }, select: { status: true } })
  const status = current?.status === "CANCELLED" ? "CANCELLED" : data.status
  await prisma.aiRun.update({
    where: { id: runId },
    data: { status, error: data.error ?? null, analyzedCount: analyzed, failedCount: failed, finishedAt: new Date() },
  })
}

async function processRun(run: AiRun) {
  const config = await loadAiConfig()
  if (!isAiReady(config)) return finish(run.id, { status: "FAILED", error: "AI is not set up. Check Settings → AI." })
  if (!isRootKey(run.root)) return finish(run.id, { status: "FAILED", error: "Unknown library folder." })
  const segs = scanFolderSegments(run.folder)
  if (!segs) return finish(run.id, { status: "FAILED", error: "Invalid folder." })

  if (!run.groupedAt) {
    await prisma.aiRun.update({ where: { id: run.id }, data: { status: "GROUPING", startedAt: run.startedAt ?? new Date(), model: config.model, error: null } })
    try {
      await groupRun(run, run.root, segs, config)
    } catch (error) {
      return finish(run.id, { status: "FAILED", error: error instanceof Error ? error.message : String(error) })
    }
  } else {
    await prisma.aiRun.update({ where: { id: run.id }, data: { status: "ANALYZING", model: config.model, error: null, finishedAt: null } })
  }

  const pending = await prisma.aiGroup.findMany({
    where: { runId: run.id, status: "PENDING" },
    orderBy: { takenAt: "asc" },
    include: { _count: { select: { photos: true } } },
  })
  const controller = new AbortController()
  state.current = { runId: run.id, controller }
  const root = run.root as RootKey
  const dir = path.join(rootPath(root), ...segs)
  const cfg = clientConfig(config)

  try {
    const outcome = await analyzeGroups(
      pending.map((p) => ({ id: p.id, photoCount: p._count.photos })),
      {
        customPrompt: config.customPrompt,
        isCancelled: async () => (await prisma.aiRun.findUnique({ where: { id: run.id }, select: { status: true } }))?.status === "CANCELLED",
        callAi: (messages) => chatWithRetry(cfg, messages, { signal: controller.signal }),
        prepareImages: async (groupId) => {
          const photos = await prisma.aiGroupPhoto.findMany({ where: { groupId }, orderBy: { takenAt: "asc" } })
          return Promise.all(
            photos.map(async (p) => {
              const file = path.join(dir, p.name)
              const preview = await ensureVariant(root, [...segs, p.name].join("/"), file, "preview", "scan").catch(() => ({ failed: true as const }))
              if ("failed" in preview) throw new Error(`${p.name} is no longer readable.`)
              const jpeg = await sharp(preview.path)
                .resize({ width: config.imageMaxPx, height: config.imageMaxPx, fit: "inside", withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer()
              return `data:image/jpeg;base64,${jpeg.toString("base64")}`
            })
          )
        },
        onAnalyzed: async (groupId, verdict) => {
          const photos = await prisma.aiGroupPhoto.findMany({ where: { groupId }, orderBy: { takenAt: "asc" } })
          const best = new Set(verdict.best)
          await prisma.$transaction([
            ...verdict.ranking.map((r, i) =>
              prisma.aiGroupPhoto.update({ where: { id: photos[r.photo - 1].id }, data: { rank: i + 1, note: r.note || null, suggested: best.has(r.photo) } })
            ),
            prisma.aiGroup.update({ where: { id: groupId }, data: { status: "ANALYZED", reason: verdict.reason || null, error: null } }),
            prisma.aiRun.update({ where: { id: run.id }, data: { analyzedCount: { increment: 1 } } }),
          ])
        },
        onFailed: async (groupId, error) => {
          await prisma.$transaction([
            prisma.aiGroup.update({ where: { id: groupId }, data: { status: "FAILED", error } }),
            prisma.aiRun.update({ where: { id: run.id }, data: { failedCount: { increment: 1 } } }),
          ])
        },
      }
    )
    if (outcome.status === "failed") await finish(run.id, { status: "FAILED", error: outcome.error })
    else await finish(run.id, { status: outcome.status === "cancelled" ? "CANCELLED" : "DONE" })
  } finally {
    state.current = null
  }
}

async function groupRun(run: AiRun, root: RootKey, segs: string[], config: AiConfig) {
  const dir = path.join(rootPath(root), ...segs)
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    throw new Error("The folder no longer exists.")
  }

  // Earlier unfinished groups of this folder are replaced by this run.
  await prisma.aiGroup.deleteMany({ where: { root, folder: run.folder, status: { in: ["PENDING", "ANALYZED", "FAILED"] } } })

  const settled = new Set<string>()
  if (!run.fresh) {
    const done = await prisma.aiGroupPhoto.findMany({
      where: { group: { root, folder: run.folder, status: { in: ["RESOLVED", "DISMISSED"] } } },
      select: { name: true, version: true },
    })
    for (const p of done) settled.add(`${p.name}\0${p.version}`)
  }

  const inputs: (GroupInput & { version: string })[] = []
  for (const e of entries) {
    if (!e.isFile() || mediaKind(e.name) !== "image") continue
    const file = path.join(dir, e.name)
    try {
      const st = await fs.stat(file)
      const version = fileVersion(st)
      if (settled.has(`${e.name}\0${version}`)) continue
      const thumb = await ensureVariant(root, [...segs, e.name].join("/"), file, "thumb", "scan")
      if ("failed" in thumb) continue
      inputs.push({ name: e.name, version, takenAt: await readCaptureTime(file, st.mtimeMs), fp: await fingerprintImage(thumb.path) })
    } catch {
      // unreadable or removed mid-scan
    }
    if ((await prisma.aiRun.findUnique({ where: { id: run.id }, select: { status: true } }))?.status === "CANCELLED") return
  }

  const groups = groupPhotos(inputs, { windowSeconds: config.groupWindowSeconds, similarity: config.similarity, maxGroupSize: config.maxGroupSize })
  const versions = new Map(inputs.map((i) => [i.name, i.version]))
  for (const group of groups) {
    await prisma.aiGroup.create({
      data: {
        runId: run.id, root, folder: run.folder, takenAt: new Date(group[0].takenAt),
        photos: { create: group.map((p) => ({ name: p.name, version: versions.get(p.name)!, takenAt: new Date(p.takenAt) })) },
      },
    })
  }
  await prisma.aiRun.update({
    where: { id: run.id },
    data: { status: "ANALYZING", groupedAt: new Date(), photoCount: inputs.length, groupCount: groups.length, analyzedCount: 0, failedCount: 0 },
  })
}
```

Note: `groupRun` checks the run status per photo; a cancel during grouping stops it, and `processRun` then finishes the run as CANCELLED because `analyzeGroups` sees the cancel immediately.

- [ ] **Step 6: Create `lib/actions/ai.ts`**

```ts
"use server"

import fs from "fs/promises"
import path from "path"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { rootPath } from "@/lib/library-server"
import { isRootKey } from "@/lib/media"
import { aiReady } from "@/lib/ai/config"
import { folderKey, scanFolderSegments } from "@/lib/ai/review"
import { abortRun, kickRunner } from "@/lib/ai/runner-server"
import { dismissGroup, resolveGroup, undoGroup } from "@/lib/ai/review-server"

async function requireUser() {
  const session = await auth()
  if (!session) redirect("/login")
  return session
}

function refresh() {
  revalidatePath("/ai", "layout")
  revalidatePath("/library", "layout")
}

const ACTIVE = ["QUEUED", "GROUPING", "ANALYZING"] as const

export async function startRunAction(input: { root: string; folder: string; fresh: boolean }): Promise<{ error: string } | { runId: string }> {
  const session = await requireUser()
  const parsed = z.object({ root: z.string(), folder: z.string().max(1024), fresh: z.boolean() }).safeParse(input)
  if (!parsed.success || !isRootKey(parsed.data.root)) return { error: "Invalid request." }
  const segs = scanFolderSegments(parsed.data.folder)
  if (!segs) return { error: "Invalid folder." }
  if (!(await aiReady())) return { error: "AI is not set up. Ask an admin to configure Settings → AI." }
  try {
    if (!(await fs.stat(path.join(rootPath(parsed.data.root), ...segs))).isDirectory()) return { error: "That folder doesn't exist." }
  } catch {
    return { error: "That folder doesn't exist." }
  }
  const run = await prisma.aiRun.create({
    data: { root: parsed.data.root, folder: folderKey(segs), fresh: parsed.data.fresh, createdById: session.user.id },
  })
  kickRunner()
  refresh()
  return { runId: run.id }
}

export async function cancelRunAction(runId: string) {
  await requireUser()
  await prisma.aiRun.updateMany({ where: { id: runId, status: { in: [...ACTIVE] } }, data: { status: "CANCELLED", finishedAt: new Date() } })
  abortRun(runId)
  refresh()
  return { ok: true }
}

export async function retryRunAction(runId: string) {
  await requireUser()
  const run = await prisma.aiRun.findUnique({ where: { id: runId } })
  if (!run || (ACTIVE as readonly string[]).includes(run.status)) return { error: "That scan is still running." }
  await prisma.$transaction([
    prisma.aiGroup.updateMany({ where: { runId, status: "FAILED" }, data: { status: "PENDING", error: null } }),
    prisma.aiRun.update({ where: { id: runId }, data: { status: "QUEUED", error: null, finishedAt: null } }),
  ])
  kickRunner()
  refresh()
  return { ok: true }
}

export async function removeRunAction(runId: string) {
  await requireUser()
  await prisma.aiRun.updateMany({ where: { id: runId, status: { in: [...ACTIVE] } }, data: { status: "CANCELLED" } })
  abortRun(runId)
  await prisma.aiRun.deleteMany({ where: { id: runId } })
  refresh()
  return { ok: true }
}

export async function resolveGroupAction(groupId: string, keep: string[]) {
  const session = await requireUser()
  const parsed = z.object({ groupId: z.string().min(1), keep: z.array(z.string()).max(50) }).safeParse({ groupId, keep })
  if (!parsed.success) return { error: "Invalid request." }
  const result = await resolveGroup(parsed.data.groupId, parsed.data.keep, session.user.id)
  refresh()
  return result
}

export async function dismissGroupAction(groupId: string) {
  const session = await requireUser()
  const result = await dismissGroup(groupId, session.user.id)
  refresh()
  return result
}

export async function undoGroupAction(groupId: string) {
  await requireUser()
  const result = await undoGroup(groupId)
  refresh()
  return result
}
```

- [ ] **Step 7: Start the runner from `instrumentation.ts`**

```ts
  const { startWorker } = await import("@/lib/worker-server")
  startWorker()

  const { startAiRunner } = await import("@/lib/ai/runner-server")
  startAiRunner()
```

- [ ] **Step 8: Verify**

Run: `npx tsc --noEmit && npx eslint && npm test`
Expected: clean; all tests pass.

- [ ] **Step 9: Commit**

```bash
git add lib/ai/review.ts lib/ai/review.test.ts lib/ai/review-server.ts lib/ai/runner-server.ts lib/actions/ai.ts lib/library-server.ts instrumentation.ts
git commit -m "feat(ai): background runner, review logic and actions"
```

---

### Task 12: AI tab — new scan and scans list

**Files:**
- Create: `app/(app)/ai/page.tsx`
- Create: `components/ai/new-scan-form.tsx`, `components/ai/runs-table.tsx`, `components/ai/auto-refresh.tsx`
- Modify: `components/sidebar.tsx` (AI item + badge), `app/(app)/layout.tsx` (pass count)

**Interfaces:**
- Consumes: `listScanFolders`, `ScanFolder` (Task 11); `aiReady` (Task 4); actions from Task 11; `ROOT_LABELS` (existing).
- Produces: `AutoRefresh({ active }: { active: boolean })`; `Sidebar({ aiPending }: { aiPending: number })`, `MobileSidebarTrigger({ aiPending })`; `type RunRow` (below).

- [ ] **Step 1: `components/ai/auto-refresh.tsx`**

```tsx
"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

/** Re-renders the page from the server every few seconds while something is running. */
export function AutoRefresh({ active, intervalMs = 3000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter()
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => router.refresh(), intervalMs)
    return () => clearInterval(t)
  }, [active, intervalMs, router])
  return null
}
```

- [ ] **Step 2: `components/ai/new-scan-form.tsx`**

```tsx
"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { startRunAction } from "@/lib/actions/ai"
import { ROOT_LABELS, type RootKey } from "@/lib/media"

type Folder = { root: RootKey; folder: string; imageCount: number }

export function NewScanForm({ folders, ready, isAdmin }: { folders: Folder[]; ready: boolean; isAdmin: boolean }) {
  const router = useRouter()
  const options = folders.filter((f) => f.imageCount >= 2)
  const [value, setValue] = useState(options[0] ? `${options[0].root}|${options[0].folder}` : "")
  const [fresh, setFresh] = useState(false)
  const [busy, setBusy] = useState(false)

  async function run() {
    const [root, ...rest] = value.split("|")
    setBusy(true)
    const r = await startRunAction({ root, folder: rest.join("|"), fresh })
    setBusy(false)
    if ("error" in r) toast.error(r.error)
    else {
      toast.success("Scan started. You can leave this page.")
      setFresh(false)
      router.refresh()
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <h2 className="font-semibold">Find duplicates</h2>
      {!ready && (
        <p className="text-sm text-muted-foreground">
          AI isn&apos;t set up yet.{" "}
          {isAdmin ? <Link href="/settings?tab=ai" className="text-primary underline-offset-2 hover:underline">Open Settings → AI</Link> : "Ask an admin to set it up."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Folder to scan"
          className="h-8 min-w-64 max-w-full rounded-lg border border-input bg-transparent px-2 text-sm"
        >
          {options.map((f) => (
            <option key={`${f.root}|${f.folder}`} value={`${f.root}|${f.folder}`}>
              {ROOT_LABELS[f.root]}{f.folder ? ` / ${f.folder.split("/").join(" / ")}` : ""} ({f.imageCount})
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} /> Start fresh
        </label>
        <Button onClick={run} disabled={!ready || !value || busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Run
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Scans one folder (not its subfolders). Photos you&apos;ve already reviewed there are skipped unless you start fresh.
      </p>
    </div>
  )
}
```

- [ ] **Step 3: `components/ai/runs-table.tsx`**

```tsx
"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { cancelRunAction, removeRunAction, retryRunAction } from "@/lib/actions/ai"
import { ROOT_LABELS, type RootKey } from "@/lib/media"

export type RunRow = {
  id: string
  root: RootKey
  folder: string
  status: "QUEUED" | "GROUPING" | "ANALYZING" | "DONE" | "FAILED" | "CANCELLED"
  groupCount: number
  analyzedCount: number
  failedCount: number
  toReview: number
  error: string | null
  createdAt: string
  createdBy: string | null
}

const LABEL: Record<RunRow["status"], string> = {
  QUEUED: "Waiting", GROUPING: "Grouping photos", ANALYZING: "Asking the AI", DONE: "Done", FAILED: "Stopped", CANCELLED: "Cancelled",
}

export function RunsTable({ runs }: { runs: RunRow[] }) {
  const router = useRouter()
  if (runs.length === 0) return <p className="text-sm text-muted-foreground">No scans yet.</p>

  async function act(fn: () => Promise<unknown>, done: string) {
    const r = (await fn()) as { error?: string }
    if (r?.error) toast.error(r.error)
    else toast.success(done)
    router.refresh()
  }

  return (
    <div className="rounded-lg border overflow-hidden bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th className="text-left font-medium px-4 py-2.5">Folder</th>
            <th className="text-left font-medium px-4 py-2.5 hidden md:table-cell">Started</th>
            <th className="text-left font-medium px-4 py-2.5">Status</th>
            <th className="text-right font-medium px-4 py-2.5">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {runs.map((r) => {
            const active = r.status === "QUEUED" || r.status === "GROUPING" || r.status === "ANALYZING"
            const pct = r.groupCount ? Math.round(((r.analyzedCount + r.failedCount) / r.groupCount) * 100) : 0
            return (
              <tr key={r.id}>
                <td className="px-4 py-3">
                  <div className="font-medium">{ROOT_LABELS[r.root]}{r.folder ? ` / ${r.folder.split("/").join(" / ")}` : ""}</div>
                  {r.toReview > 0 && <div className="text-xs text-primary">{r.toReview} group{r.toReview === 1 ? "" : "s"} to review</div>}
                </td>
                <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                  {new Date(r.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                  {r.createdBy && <span> · {r.createdBy}</span>}
                </td>
                <td className="px-4 py-3">
                  <div>{LABEL[r.status]}{r.status === "ANALYZING" && r.groupCount > 0 && <> — {r.analyzedCount + r.failedCount} of {r.groupCount}</>}</div>
                  {r.status === "ANALYZING" && <div className="mt-1 h-1.5 w-40 rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} /></div>}
                  {r.status === "DONE" && <div className="text-xs text-muted-foreground">{r.groupCount} group{r.groupCount === 1 ? "" : "s"}{r.failedCount > 0 && `, ${r.failedCount} failed`}</div>}
                  {r.error && <div className="text-xs text-destructive">{r.error}</div>}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1.5">
                    {r.groupCount > 0 && <Link href={`/ai/runs/${r.id}`} className="inline-flex h-7 items-center rounded-lg border px-2.5 text-[0.8rem] font-medium hover:bg-muted">Review</Link>}
                    {active && <Button variant="ghost" size="sm" onClick={() => act(() => cancelRunAction(r.id), "Scan cancelled.")}>Cancel</Button>}
                    {!active && (r.failedCount > 0 || r.status === "CANCELLED" || r.status === "FAILED") && (
                      <Button variant="ghost" size="sm" onClick={() => act(() => retryRunAction(r.id), "Scan queued again.")}>{r.status === "CANCELLED" ? "Resume" : "Retry failed"}</Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => confirm("Remove this scan's saved results? Photos are not touched.") && act(() => removeRunAction(r.id), "Scan removed.")}
                    >
                      Remove
                    </Button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 4: `app/(app)/ai/page.tsx`**

```tsx
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { aiReady } from "@/lib/ai/config"
import { listScanFolders } from "@/lib/library-server"
import { isRootKey } from "@/lib/media"
import { NewScanForm } from "@/components/ai/new-scan-form"
import { RunsTable, type RunRow } from "@/components/ai/runs-table"
import { AutoRefresh } from "@/components/ai/auto-refresh"

export default async function AiPage() {
  const session = await auth()
  if (!session) redirect("/login")

  const [ready, folders, runs] = await Promise.all([
    aiReady(),
    listScanFolders(),
    prisma.aiRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { createdBy: { select: { name: true } }, _count: { select: { groups: { where: { status: "ANALYZED" } } } } },
    }),
  ])

  const rows: RunRow[] = runs
    .filter((r) => isRootKey(r.root))
    .map((r) => ({
      id: r.id, root: r.root as RunRow["root"], folder: r.folder, status: r.status,
      groupCount: r.groupCount, analyzedCount: r.analyzedCount, failedCount: r.failedCount,
      toReview: r._count.groups, error: r.error, createdAt: r.createdAt.toISOString(), createdBy: r.createdBy?.name ?? null,
    }))
  const active = rows.some((r) => r.status === "QUEUED" || r.status === "GROUPING" || r.status === "ANALYZING")

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold">AI</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Find bursts of similar photos and let AI suggest the best of each.</p>
      </div>
      <NewScanForm folders={folders} ready={ready} isAdmin={session.user.role === "ADMIN"} />
      <section className="space-y-3">
        <h2 className="font-semibold">Scans</h2>
        <RunsTable runs={rows} />
      </section>
      <AutoRefresh active={active} />
    </div>
  )
}
```

- [ ] **Step 5: Sidebar item and badge**

In `components/sidebar.tsx`:
- import `Sparkles`.
- Change `NavItem` to `{ href: string; label: string; icon: React.ElementType; badge?: number }` and render the badge in `NavLink` after the label:

```tsx
      {label}
      {badge ? <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">{badge}</span> : null}
```

- `SidebarContent({ onNavClick, aiPending })` renders after the library items:

```tsx
        <p className="mt-3 px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Review</p>
        <NavLink href="/ai" label="AI" icon={Sparkles} badge={aiPending} onClick={onNavClick} />
```

- `Sidebar({ aiPending }: { aiPending: number })` and `MobileSidebarTrigger({ aiPending }: { aiPending: number })` pass it through.

In `app/(app)/layout.tsx`:

```tsx
import { prisma } from "@/lib/prisma"
// after the session check:
  const aiPending = await prisma.aiGroup.count({ where: { status: "ANALYZED" } })
// and:
      <Sidebar aiPending={aiPending} />
// ...
          <MobileSidebarTrigger aiPending={aiPending} />
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx eslint && npm test`
Manual (dev server restarted so the runner starts): `/ai` shows the folder picker with image counts; with AI off, Run is disabled and admins see the Settings link; with AI on, Run creates a row that moves Waiting → Grouping photos → Asking the AI with a progress bar, refreshing itself; Cancel stops it; Remove deletes the row.

- [ ] **Step 7: Commit**

```bash
git add "app/(app)/ai/page.tsx" components/ai components/sidebar.tsx "app/(app)/layout.tsx"
git commit -m "feat(ai): AI tab with scan launcher and progress list"
```

---

### Task 13: Review page

**Files:**
- Create: `app/(app)/ai/runs/[id]/page.tsx`
- Create: `components/ai/review-group.tsx`

**Interfaces:**
- Consumes: `currentVersions` (Task 11), `resolveGroupAction`, `dismissGroupAction`, `undoGroupAction` (Task 11), `Lightbox` (existing: props `root, folder, items, index, canMove, canEdit, busy, onIndex, onClose, onMove, onDelete, onRotate`), `mediaUrl` (existing), `FileEntry` (existing).
- Produces: `ReviewGroup` component with props below.

- [ ] **Step 1: `components/ai/review-group.tsx`**

```tsx
"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Check, Loader2, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { mediaUrl } from "@/lib/format"
import { dismissGroupAction, resolveGroupAction, undoGroupAction } from "@/lib/actions/ai"
import type { FileEntry } from "@/lib/library-server"
import { Lightbox } from "@/components/library/lightbox"

export type ReviewPhoto = { name: string; rank: number | null; note: string | null; suggested: boolean; decision: "KEEP" | "TRASH" | null; current: FileEntry | null }

export type ReviewGroupProps = {
  id: string
  root: "upload" | "dropoff"
  folder: string[]
  status: "PENDING" | "ANALYZED" | "FAILED" | "RESOLVED" | "DISMISSED"
  reason: string | null
  error: string | null
  photos: ReviewPhoto[]
}

export function ReviewGroup({ id, root, folder, status, reason, error, photos }: ReviewGroupProps) {
  const router = useRouter()
  const ordered = useMemo(() => [...photos].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)), [photos])
  const present = ordered.filter((p) => p.current)
  const [keep, setKeep] = useState<Set<string>>(() => new Set(present.filter((p) => p.suggested).map((p) => p.name)))
  const [busy, setBusy] = useState(false)
  const [viewer, setViewer] = useState<number | null>(null)
  const items = present.map((p) => p.current!)

  useEffect(() => {
    if (viewer === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewer(null)
      else if (e.key === "ArrowRight") setViewer((v) => (v !== null && v < items.length - 1 ? v + 1 : v))
      else if (e.key === "ArrowLeft") setViewer((v) => (v !== null && v > 0 ? v - 1 : v))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [viewer, items.length])

  const kept = present.filter((p) => keep.has(p.name)).length
  const trashed = present.length - kept
  const done = status === "RESOLVED" || status === "DISMISSED"

  async function act(fn: () => Promise<unknown>, success: (r: Record<string, number>) => string) {
    setBusy(true)
    const r = (await fn()) as { error?: string } & Record<string, number>
    setBusy(false)
    if (r.error) toast.error(r.error)
    else toast.success(success(r))
    router.refresh()
  }

  if (done) {
    const keptNames = photos.filter((p) => p.decision === "KEEP").length
    const trashedNames = photos.filter((p) => p.decision === "TRASH").length
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
        <span className="text-muted-foreground">
          {status === "DISMISSED" ? "Marked as not duplicates" : `${root === "upload" ? "Moved" : "Kept"} ${keptNames}, trashed ${trashedNames}`}
        </span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(() => undoGroupAction(id), (r) => (r.restored ? `Restored ${r.restored} from trash.` : "Back in To review."))}>
          <Undo2 className="h-4 w-4" /> Undo
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      {reason && <p className="text-sm">{reason}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(180px, 42vw), 1fr))" }}>
        {ordered.map((p) => {
          const selected = keep.has(p.name)
          if (!p.current) {
            return (
              <div key={p.name} className="flex aspect-square flex-col items-center justify-center rounded-md border border-dashed p-2 text-center text-xs text-muted-foreground">
                <span className="font-medium">No longer here</span>
                <span className="break-all">{p.name}</span>
              </div>
            )
          }
          const index = items.indexOf(p.current)
          return (
            <div key={p.name} className="space-y-1">
              <button
                type="button"
                onClick={() => setKeep((prev) => { const n = new Set(prev); if (n.has(p.name)) n.delete(p.name); else n.add(p.name); return n })}
                onDoubleClick={() => setViewer(index)}
                title={`${p.name} — click to keep or trash, double-click to view`}
                style={{ touchAction: "manipulation" }}
                className={cn(
                  "relative block aspect-square w-full overflow-hidden rounded-md bg-muted",
                  selected ? "ring-[3px] ring-primary ring-offset-2 ring-offset-background" : "opacity-60 hover:opacity-90"
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- served from our own cache */}
                <img src={mediaUrl(root, folder, p.name, "thumb", p.current.version)} alt={p.name} loading="lazy" className="h-full w-full object-cover" />
                {p.rank !== null && <span className="absolute left-1.5 top-1.5 rounded-full bg-black/65 px-1.5 py-0.5 text-[11px] font-semibold text-white">#{p.rank}</span>}
                {selected && <span className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="h-3.5 w-3.5" strokeWidth={3} /></span>}
              </button>
              {p.note && <p className="text-xs text-muted-foreground line-clamp-2">{p.note}</p>}
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(() => dismissGroupAction(id), () => "Marked as not duplicates.")}>
          {present.length < 2 ? "Done" : "Not duplicates"}
        </Button>
        {status === "ANALYZED" && present.length >= 2 && (
          <Button
            size="sm"
            disabled={busy || kept === 0}
            onClick={() => act(() => resolveGroupAction(id, [...keep]), (r) => `${root === "upload" ? `Moved ${r.moved}` : `Kept ${r.kept}`}, trashed ${r.trashed}.`)}
          >
            {root === "upload" ? `Move ${kept} to Dropoff` : `Keep ${kept}`}, trash {trashed}
          </Button>
        )}
      </div>
      {viewer !== null && items[viewer] && (
        <Lightbox
          root={root}
          folder={folder}
          items={items}
          index={viewer}
          canMove={false}
          canEdit={false}
          busy={false}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
          onMove={() => {}}
          onDelete={() => {}}
          onRotate={() => {}}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: `app/(app)/ai/runs/[id]/page.tsx`**

```tsx
import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { cn } from "@/lib/utils"
import { isRootKey, mediaKind, ROOT_LABELS } from "@/lib/media"
import { currentVersions } from "@/lib/ai/review-server"
import { scanFolderSegments } from "@/lib/ai/review"
import { AutoRefresh } from "@/components/ai/auto-refresh"
import { ReviewGroup, type ReviewPhoto } from "@/components/ai/review-group"
import fs from "fs/promises"
import path from "path"
import { rootPath } from "@/lib/library-server"

const TABS = [
  { id: "review", label: "To review", statuses: ["ANALYZED"] },
  { id: "done", label: "Done", statuses: ["RESOLVED", "DISMISSED"] },
  { id: "failed", label: "Failed", statuses: ["FAILED"] },
] as const

export default async function RunReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const session = await auth()
  if (!session) redirect("/login")
  const [{ id }, { tab }] = await Promise.all([params, searchParams])
  const run = await prisma.aiRun.findUnique({ where: { id } })
  if (!run || !isRootKey(run.root)) notFound()
  const segs = scanFolderSegments(run.folder)
  if (!segs) notFound()
  const active = TABS.find((t) => t.id === tab) ?? TABS[0]

  const [groups, counts] = await Promise.all([
    prisma.aiGroup.findMany({ where: { runId: id, status: { in: [...active.statuses] } }, orderBy: { takenAt: "asc" }, include: { photos: true } }),
    prisma.aiGroup.groupBy({ by: ["status"], where: { runId: id }, _count: true }),
  ])
  const count = (statuses: readonly string[]) => counts.filter((c) => statuses.includes(c.status)).reduce((n, c) => n + c._count, 0)

  const allNames = [...new Set(groups.flatMap((g) => g.photos.map((p) => p.name)))]
  const versions = await currentVersions(run.root, run.folder, allNames)
  const dir = path.join(rootPath(run.root), ...segs)
  const stats = new Map(
    await Promise.all(allNames.map(async (n) => [n, await fs.stat(path.join(dir, n)).catch(() => null)] as const))
  )

  const running = run.status === "QUEUED" || run.status === "GROUPING" || run.status === "ANALYZING"
  const where = `${ROOT_LABELS[run.root]}${segs.length ? ` / ${segs.join(" / ")}` : ""}`

  return (
    <div className="max-w-6xl space-y-5">
      <div>
        <Link href="/ai" className="text-sm text-muted-foreground hover:text-foreground">← AI</Link>
        <h1 className="mt-1 font-heading text-2xl font-semibold">{where}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {run.groupCount} group{run.groupCount === 1 ? "" : "s"} from {run.photoCount} photos
          {running && " · still analyzing — new groups appear as they finish"}
          {run.model && ` · ${run.model}`}
        </p>
      </div>

      <nav className="flex gap-1 border-b">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/ai/runs/${id}?tab=${t.id}`}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", t.id === active.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t.label} <span className="text-xs text-muted-foreground">({count(t.statuses)})</span>
          </Link>
        ))}
      </nav>

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {active.id === "review" ? (running ? "Waiting for the AI…" : "All caught up.") : "Nothing here."}
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const photos: ReviewPhoto[] = g.photos.map((p) => {
              const st = stats.get(p.name)
              const same = versions.get(p.name) === p.version
              return {
                name: p.name, rank: p.rank, note: p.note, suggested: p.suggested, decision: p.decision,
                current: same && st ? { name: p.name, kind: mediaKind(p.name) ?? "image", size: st.size, modified: st.mtimeMs, version: p.version } : null,
              }
            })
            return <ReviewGroup key={g.id} id={g.id} root={run.root as "upload" | "dropoff"} folder={segs} status={g.status} reason={g.reason} error={g.error} photos={photos} />
          })}
        </div>
      )}
      <AutoRefresh active={running} intervalMs={5000} />
    </div>
  )
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx eslint && npm test`
Manual: on a run with analyzed groups — cards show reason, rank badges and notes; best is pre-selected; clicking toggles; the button text updates ("Move 2 to Dropoff, trash 3"); double-click opens the viewer (←/→/Esc work); resolving moves/trashes the files (check the folders) and the card collapses with Undo; Undo restores trashed photos and the group returns to To review; "Not duplicates" moves it to Done without touching files; renaming a photo in Explorer before resolving shows "No longer here" and it is not touched.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/ai/runs" components/ai/review-group.tsx
git commit -m "feat(ai): review page with per-group resolve, dismiss and undo"
```

---

### Task 14: End-to-end check and docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README section**

Add after "Folders":

```markdown
## AI duplicate review

The **AI** tab scans one folder for bursts of near-identical photos (grouped
locally by capture time and visual similarity — no AI involved), then asks a
vision model which take is best: eyes open, looking at the camera, smiling,
sharp. Results are saved; start a scan, leave, and review later. Each group
has one button: move the picks to Sort Dropoff and trash the rest (undoable).

Set it up under **Settings → AI** (admins): any OpenAI-compatible server with
a vision model, e.g. Ollama on a PC with a GPU (`ollama pull qwen2.5vl:7b`,
base URL `http://<pc>:11434/v1`; start Ollama with `OLLAMA_HOST=0.0.0.0` so
the NAS can reach it). Thumbnails of each group are sent to that server.
```

- [ ] **Step 2: Full verification**

Run: `npx tsc --noEmit && npx eslint && npm test && npm run build`
Expected: all clean; build lists `/ai` and `/ai/runs/[id]`.

- [ ] **Step 3: Manual end-to-end with a real model**

1. Put 2–3 bursts (3–6 near-identical shots each, plus a few unrelated photos) in `dev-photos/upload/mike`.
2. Settings → AI: Ollama preset, base URL of the PC, a vision model; Test connection → "can see images"; Save.
3. AI tab → choose `Mobile Upload / mike` → Run. Watch Grouping → Asking the AI → Done.
4. Review: each burst is one group; unrelated photos are not grouped; picks look sensible. Resolve one group, Undo it, dismiss another.
5. Re-run the same folder without "Start fresh": the dismissed group's photos are skipped. With "Start fresh": they're grouped again.
6. Stop Ollama mid-scan: after 3 groups the run shows "Stopped — AI server unreachable"; start Ollama, click Retry failed, it completes.

Record any threshold changes made for real bursts in `lib/ai/grouping.ts` with a comment.

- [ ] **Step 4: Commit**

```bash
git add README.md lib/ai/grouping.ts
git commit -m "docs: AI duplicate review setup"
```
