import { describe, expect, it } from "vitest"
import { buildSearchUrl, dragPayload, formatDuration, hasMore, mergeResults, errorNotes, safePageUrl } from "./panel-state"
import type { StockResult } from "./types"

const r = (source: StockResult["source"], id: string, extra: Partial<StockResult> = {}): StockResult => ({
  source, id, kind: "image", title: id, thumbUrl: "t", pageUrl: "p", ...extra,
})

describe("buildSearchUrl", () => {
  it("encodes query and filters, no cursors on the first page", () => {
    const url = buildSearchUrl({ q: "a b&c", kind: "gif", source: "pexels" })
    const p = new URL(url, "http://x").searchParams
    expect(url.startsWith("/api/stock/search?")).toBe(true)
    expect(p.get("q")).toBe("a b&c")
    expect(p.get("kind")).toBe("gif")
    expect(p.get("source")).toBe("pexels")
    expect(p.has("cursors")).toBe(false)
  })
  it("sends cursors as JSON, keeping nulls", () => {
    const url = buildSearchUrl({ q: "x", kind: "all", source: "all", cursors: { openverse: "2", pixabay: null } })
    expect(JSON.parse(new URL(url, "http://x").searchParams.get("cursors")!)).toEqual({ openverse: "2", pixabay: null })
  })
  it("omits empty cursors", () => {
    expect(buildSearchUrl({ q: "x", kind: "all", source: "all", cursors: {} })).not.toContain("cursors")
  })
})

describe("hasMore", () => {
  it("is true when any cursor is a string", () => {
    expect(hasMore({ openverse: null, pexels: "3" })).toBe(true)
  })
  it("is false when every cursor is null, missing or empty", () => {
    expect(hasMore({ openverse: null, pexels: null })).toBe(false)
    expect(hasMore({})).toBe(false)
  })
})

describe("mergeResults", () => {
  it("appends and drops duplicates by source and id", () => {
    const merged = mergeResults([r("openverse", "1")], [r("openverse", "1"), r("pexels", "1"), r("openverse", "2")])
    expect(merged.map((x) => `${x.source}:${x.id}`)).toEqual(["openverse:1", "pexels:1", "openverse:2"])
  })
})

describe("formatDuration", () => {
  it("formats m:ss", () => {
    expect(formatDuration(0)).toBe("0:00")
    expect(formatDuration(65.4)).toBe("1:05")
    expect(formatDuration(600)).toBe("10:00")
  })
  it("returns empty for unknown or invalid", () => {
    expect(formatDuration(undefined)).toBe("")
    expect(formatDuration(NaN)).toBe("")
    expect(formatDuration(-3)).toBe("")
  })
})

describe("dragPayload", () => {
  it("includes duration only when known", () => {
    expect(JSON.parse(dragPayload(r("pexels", "9", { kind: "video", duration: 12 })))).toEqual({ source: "pexels", id: "9", kind: "video", duration: 12 })
    expect(JSON.parse(dragPayload(r("openverse", "9")))).toEqual({ source: "openverse", id: "9", kind: "image" })
  })
})

describe("safePageUrl", () => {
  it("rejects unsafe or unusable values", () => {
    for (const u of ["javascript:alert(1)", "data:text/html,x", "", undefined, "//evil.example", "https://user:pw@x.test/"]) {
      expect(safePageUrl(u)).toBeNull()
    }
  })
  it("returns http(s) URLs", () => {
    expect(safePageUrl("https://www.pexels.com/photo/x/")).toBe("https://www.pexels.com/photo/x/")
    expect(safePageUrl("http://example.org/a?b=c")).toBe("http://example.org/a?b=c")
  })
})

describe("notes", () => {
  it("labels errors by source name", () => {
    expect(errorNotes({ pexels: "rate limited", openverse: "down" })).toEqual(["Openverse: down", "Pexels: rate limited"])
  })
})
