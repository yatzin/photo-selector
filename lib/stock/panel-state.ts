import type { StockKind, StockResult, StockSource } from "./types"

export type Cursors = Partial<Record<StockSource, string | null>>

export const SOURCE_NAMES: Record<StockSource, string> = { openverse: "Openverse", pixabay: "Pixabay", pexels: "Pexels" }
const SOURCE_ORDER: StockSource[] = ["openverse", "pixabay", "pexels"]

/** The request for a page of results; `cursors` (from the previous response) asks for the next page. */
export function buildSearchUrl(o: { q: string; kind: StockKind | "all"; source: StockSource | "all"; cursors?: Cursors }): string {
  const p = new URLSearchParams({ q: o.q, kind: o.kind, source: o.source })
  if (o.cursors && Object.keys(o.cursors).length > 0) p.set("cursors", JSON.stringify(o.cursors))
  return `/api/stock/search?${p.toString()}`
}

/** True while any source still has a next page (a string cursor; null means exhausted). */
export function hasMore(cursors: Cursors): boolean {
  return Object.values(cursors).some((c) => typeof c === "string")
}

/** Appends a page, skipping results already shown. */
export function mergeResults(prev: StockResult[], next: StockResult[]): StockResult[] {
  const seen = new Set(prev.map((r) => `${r.source}:${r.id}`))
  const out = [...prev]
  for (const r of next) {
    const k = `${r.source}:${r.id}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

/** The URL when it is an absolute http(s) address without credentials, else null (never link anything else). */
export function safePageUrl(u: unknown): string | null {
  if (typeof u !== "string" || !u) return null
  try {
    const url = new URL(u)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

/** m:ss, or "" when the length is unknown. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return ""
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** What a dragged card carries (duration only when known). */
export function dragPayload(r: StockResult): string {
  return JSON.stringify({ source: r.source, id: r.id, kind: r.kind, ...(r.duration !== undefined ? { duration: r.duration } : {}) })
}

/** "Pexels: rate limited" lines, in a stable source order. */
export function errorNotes(errors: Partial<Record<StockSource, string>>): string[] {
  return SOURCE_ORDER.filter((s) => errors[s]).map((s) => `${SOURCE_NAMES[s]}: ${errors[s]}`)
}

