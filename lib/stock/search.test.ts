import { describe, expect, it, vi } from "vitest"
import { searchStock } from "./search"
import type { StockClient, StockKind, StockResult, StockSource } from "./types"

const res = (source: StockSource, n: number, kind: StockKind = "image"): StockResult => ({
  source, id: `${source}${n}`, kind, title: `${source}${n}`, thumbUrl: "t", pageUrl: "p",
})

function stub(source: StockSource, opts: { kinds?: StockKind[]; configured?: boolean; count?: number; next?: string | null; error?: Error } = {}) {
  const search = vi.fn(async () => {
    if (opts.error) throw opts.error
    return { results: Array.from({ length: opts.count ?? 2 }, (_, i) => res(source, i + 1)), next: opts.next === undefined ? "n2" : opts.next }
  })
  const client: StockClient = {
    source,
    kinds: opts.kinds ?? ["image", "gif", "video"],
    configured: () => opts.configured ?? true,
    search,
    resolve: vi.fn(),
  }
  return { client, search }
}
const base = { query: "cat", kind: "all" as const, source: "all" as const, cursors: {} }

describe("searchStock", () => {
  it("merges round-robin", async () => {
    const out = await searchStock([stub("openverse").client, stub("pixabay").client], base)
    expect(out.results.map((r) => r.id)).toEqual(["openverse1", "pixabay1", "openverse2", "pixabay2"])
  })
  it("round-robin with uneven lengths", async () => {
    const out = await searchStock([stub("openverse", { count: 3 }).client, stub("pixabay", { count: 1 }).client], base)
    expect(out.results.map((r) => r.id)).toEqual(["openverse1", "pixabay1", "openverse2", "openverse3"])
  })
  it("a failing source is reported and others still return", async () => {
    const out = await searchStock([stub("openverse", { error: new Error("boom") }).client, stub("pixabay").client], base)
    expect(Object.keys(out.errors)).toEqual(["openverse"])
    expect(out.errors.openverse).toBeTruthy()
    expect(out.results.map((r) => r.id)).toEqual(["pixabay1", "pixabay2"])
  })
  it("error text never carries URLs or keys", async () => {
    const out = await searchStock([stub("pexels", { error: new Error("fetch failed https://x/?key=SECRET") }).client], base)
    expect(JSON.stringify(out)).not.toContain("SECRET")
    expect(JSON.stringify(out)).not.toContain("https://")
  })
  it("maps rate limits to a readable message", async () => {
    const out = await searchStock([stub("pexels", { error: new Error("Pexels rate limit reached (HTTP 429)") }).client], base)
    expect(out.errors.pexels).toBe("Pexels: rate limited")
  })
  it("skips clients lacking the kind", async () => {
    const a = stub("openverse", { kinds: ["image", "audio"] })
    const b = stub("pixabay")
    const out = await searchStock([a.client, b.client], { ...base, kind: "audio" })
    expect(a.search).toHaveBeenCalledTimes(1)
    expect(b.search).not.toHaveBeenCalled()
    expect(out.unconfigured).toEqual([])
    expect(out.cursors.pixabay).toBeUndefined()
  })
  it("lists unconfigured clients and never calls them", async () => {
    const a = stub("openverse", { configured: false })
    const out = await searchStock([a.client, stub("pixabay").client], base)
    expect(a.search).not.toHaveBeenCalled()
    expect(out.unconfigured).toEqual(["openverse"])
  })
  it("skips a source whose cursor is null, queries undefined and string cursors", async () => {
    const a = stub("openverse"), b = stub("pixabay"), c = stub("pexels")
    const out = await searchStock([a.client, b.client, c.client], { ...base, cursors: { openverse: null, pexels: "p3" } })
    expect(a.search).not.toHaveBeenCalled()
    expect(b.search).toHaveBeenCalledWith({ query: "cat", kind: "all", cursor: null })
    expect(c.search).toHaveBeenCalledWith({ query: "cat", kind: "all", cursor: "p3" })
    expect(out.cursors).toEqual({ openverse: null, pixabay: "n2", pexels: "n2" })
  })
  it("source filter narrows to one client", async () => {
    const a = stub("openverse"), b = stub("pixabay")
    const out = await searchStock([a.client, b.client], { ...base, source: "pixabay" })
    expect(a.search).not.toHaveBeenCalled()
    expect(out.results.every((r) => r.source === "pixabay")).toBe(true)
  })
  it("returns the new cursor, null when exhausted", async () => {
    const out = await searchStock([stub("openverse", { next: null }).client, stub("pixabay", { next: "z" }).client], base)
    expect(out.cursors).toEqual({ openverse: null, pixabay: "z" })
  })
})
