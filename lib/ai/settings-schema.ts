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
