import type { StockKind, StockSource } from "./types"
import type { SearchInput } from "./search"

const KINDS = ["all", "image", "gif", "video", "audio"] as const
const SOURCES = ["all", "openverse", "pixabay", "pexels"] as const
const REAL_SOURCES: readonly string[] = ["openverse", "pixabay", "pexels"]
export const MAX_QUERY_LENGTH = 200

export function parseSearchParams(params: URLSearchParams): { error: string } | { value: SearchInput } {
  const query = (params.get("q") ?? "").trim()
  if (!query) return { error: "Type something to search for." }
  if (query.length > MAX_QUERY_LENGTH) return { error: "That search is too long." }

  const kind = params.get("kind") ?? "all"
  if (!(KINDS as readonly string[]).includes(kind)) return { error: "Unknown type." }
  const source = params.get("source") ?? "all"
  if (!(SOURCES as readonly string[]).includes(source)) return { error: "Unknown source." }

  const cursors: SearchInput["cursors"] = {}
  const raw = params.get("cursors")
  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { error: "Invalid cursors." }
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "Invalid cursors." }
    for (const [k, v] of Object.entries(parsed)) {
      if (!REAL_SOURCES.includes(k) || (v !== null && typeof v !== "string")) return { error: "Invalid cursors." }
      cursors[k as StockSource] = v as string | null
    }
  }
  return { value: { query, kind: kind as StockKind | "all", source: source as StockSource | "all", cursors } }
}
