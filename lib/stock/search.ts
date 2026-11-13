import type { StockClient, StockKind, StockResult, StockSource } from "./types"

export type SearchInput = {
  query: string
  kind: StockKind | "all"
  source: StockSource | "all"
  /** undefined = first page, a string = next page, null = exhausted (not queried again). */
  cursors: Partial<Record<StockSource, string | null>>
}

export type SearchOutput = {
  results: StockResult[]
  cursors: Partial<Record<StockSource, string | null>>
  errors: Partial<Record<StockSource, string>>
  unconfigured: StockSource[]
}

const NAMES: Record<StockSource, string> = { openverse: "Openverse", pixabay: "Pixabay", pexels: "Pexels", freesound: "Freesound" }

// Short, fixed strings only: the thrown text can carry URLs or keys.
function safeMessage(source: StockSource, e: unknown): string {
  const text = e instanceof Error ? e.message : ""
  const name = NAMES[source]
  if (/rate limit|\b429\b/i.test(text)) return `${name}: rate limited`
  if (/authentication|\b40[13]\b/i.test(text)) return `${name}: sign-in or key rejected`
  if (/not configured/i.test(text)) return `${name}: not configured`
  return `${name}: unavailable`
}

export async function searchStock(clients: StockClient[], q: SearchInput): Promise<SearchOutput> {
  const cursors: SearchOutput["cursors"] = {}
  const errors: SearchOutput["errors"] = {}
  const unconfigured: StockSource[] = []
  const active: StockClient[] = []

  for (const c of clients) {
    if (q.source !== "all" && c.source !== q.source) continue
    if (q.kind !== "all" && !c.kinds.includes(q.kind)) continue
    if (!c.configured()) {
      unconfigured.push(c.source)
      continue
    }
    if (q.cursors[c.source] === null) {
      cursors[c.source] = null
      continue
    }
    active.push(c)
  }

  const settled = await Promise.allSettled(
    active.map((c) => c.search({ query: q.query, kind: q.kind, cursor: q.cursors[c.source] ?? null })),
  )

  const lists: StockResult[][] = []
  settled.forEach((s, i) => {
    const source = active[i].source
    if (s.status === "fulfilled") {
      lists.push(s.value.results)
      cursors[source] = s.value.next
    } else {
      errors[source] = safeMessage(source, s.reason)
      // Keep the caller's cursor so a retry asks for the same page.
      const prev = q.cursors[source]
      if (prev !== undefined) cursors[source] = prev
    }
  })

  const results: StockResult[] = []
  const longest = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; i < longest; i++) for (const l of lists) if (i < l.length) results.push(l[i])

  return { results, cursors, errors, unconfigured }
}
