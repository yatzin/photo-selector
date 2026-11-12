import { describe, expect, it } from "vitest"
import { isStockKey, parseStockDrag, stockKey } from "./drag"
import { dragPayload } from "./panel-state"
import type { StockResult } from "./types"

const r = (extra: Partial<StockResult> = {}): StockResult => ({
  source: "pixabay", id: "123", kind: "image", title: "t", thumbUrl: "t", pageUrl: "p", ...extra,
})

describe("stockKey", () => {
  it("matches the server's asset source key (stockSourceKey)", () => {
    expect(stockKey({ source: "pexels", id: "42", kind: "video" })).toBe("stock:pexels:42")
  })
  it("tells stock keys from Personal Storage ones", () => {
    expect(isStockKey("stock:pexels:42")).toBe(true)
    expect(isStockKey("mike/sub/IMG_1.jpg")).toBe(false)
    expect(isStockKey(null)).toBe(false)
  })
})

describe("parseStockDrag", () => {
  it("round-trips dragPayload", () => {
    expect(parseStockDrag(dragPayload(r()))).toEqual({ source: "pixabay", id: "123", kind: "image" })
    expect(parseStockDrag(dragPayload(r({ source: "pexels", kind: "video", duration: 12.5 })))).toEqual({ source: "pexels", id: "123", kind: "video", duration: 12.5 })
    const uuid = "0aff3595-8168-440b-83ff-7a80b65dea42"
    expect(parseStockDrag(dragPayload(r({ source: "openverse", id: uuid, kind: "audio", duration: 30 })))).toEqual({ source: "openverse", id: uuid, kind: "audio", duration: 30 })
    expect(parseStockDrag(dragPayload(r({ kind: "gif" })))).toEqual({ source: "pixabay", id: "123", kind: "gif" })
  })

  it("drops extra keys", () => {
    const out = parseStockDrag(JSON.stringify({ source: "pixabay", id: "1", kind: "image", url: "https://evil.test/x", __proto__x: 1 }))
    expect(out).toEqual({ source: "pixabay", id: "1", kind: "image" })
  })

  it("rejects non-JSON and non-objects", () => {
    for (const raw of ["", "not json", "{", "null", "1", '"x"', "[]", '["pixabay","1","image"]']) {
      expect(parseStockDrag(raw)).toBeNull()
    }
  })

  it("rejects unknown sources and kinds and wrong types", () => {
    const bad = [
      { source: "flickr", id: "1", kind: "image" },
      { source: "PIXABAY", id: "1", kind: "image" },
      { source: "pixabay", id: "1", kind: "document" },
      { source: "pixabay", id: 1, kind: "image" },
      { source: "pixabay", kind: "image" },
      { id: "1", kind: "image" },
      { source: "pixabay", id: "1" },
    ]
    for (const b of bad) expect(parseStockDrag(JSON.stringify(b))).toBeNull()
  })

  it("rejects hostile ids", () => {
    for (const id of ["", "a".repeat(65), "../x", "a/b", "a b", "x\n", "%2e%2e", "a.b"]) {
      expect(parseStockDrag(JSON.stringify({ source: "pixabay", id, kind: "image" }))).toBeNull()
    }
    expect(parseStockDrag(JSON.stringify({ source: "pixabay", id: "a".repeat(64), kind: "image" }))).not.toBeNull()
  })

  it("refuses raw JSON whose duration parses to Infinity, zero or a negative", () => {
    expect(JSON.parse('{"duration":1e400}').duration).toBe(Infinity)
    for (const d of ["1e400", "-1e400", "0", "-0", "-3"]) {
      expect(parseStockDrag(`{"source":"pexels","id":"1","kind":"video","duration":${d}}`)).toBeNull()
    }
  })

  it("rejects a bad duration rather than guessing", () => {
    for (const duration of [0, -1, "5", null, true, 1e400]) {
      expect(parseStockDrag(JSON.stringify({ source: "pixabay", id: "1", kind: "video", duration }))).toBeNull()
    }
  })
})
