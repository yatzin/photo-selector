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
