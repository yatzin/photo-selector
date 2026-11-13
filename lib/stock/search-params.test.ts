import { describe, expect, it } from "vitest"
import { parseSearchParams } from "./search-params"

const p = (s: string) => new URLSearchParams(s)

describe("parseSearchParams", () => {
  it("accepts a minimal query with defaults", () => {
    expect(parseSearchParams(p("q=cat"))).toEqual({ value: { query: "cat", kind: "all", source: "all", cursors: {} } })
  })
  it("trims q", () => {
    expect(parseSearchParams(p("q=%20cat%20"))).toMatchObject({ value: { query: "cat" } })
  })
  it("rejects empty, missing, whitespace and over-long q", () => {
    for (const s of ["", "q=", "q=%20%20", `q=${"a".repeat(201)}`]) expect(parseSearchParams(p(s))).toHaveProperty("error")
    expect(parseSearchParams(p(`q=${"a".repeat(200)}`))).toHaveProperty("value")
  })
  it("validates kind and source", () => {
    for (const k of ["all", "image", "gif", "video", "audio"]) expect(parseSearchParams(p(`q=a&kind=${k}`))).toHaveProperty("value")
    for (const s of ["all", "openverse", "pixabay", "pexels"]) expect(parseSearchParams(p(`q=a&source=${s}`))).toHaveProperty("value")
    expect(parseSearchParams(p("q=a&kind=pdf"))).toHaveProperty("error")
    expect(parseSearchParams(p("q=a&source=flickr"))).toHaveProperty("error")
  })
  it("parses cursors", () => {
    const c = encodeURIComponent(JSON.stringify({ openverse: "2", pexels: null }))
    expect(parseSearchParams(p(`q=a&cursors=${c}`))).toMatchObject({ value: { cursors: { openverse: "2", pexels: null } } })
  })
  it("rejects bad cursors", () => {
    for (const bad of ["notjson", "[]", "null", "5", '{"flickr":"1"}', '{"pexels":5}', '{"pexels":{}}']) {
      expect(parseSearchParams(p(`q=a&cursors=${encodeURIComponent(bad)}`))).toHaveProperty("error")
    }
  })
})
