import { describe, expect, it } from "vitest"
import { parseStockSettings } from "./settings-schema"

describe("parseStockSettings", () => {
  it("trims whitespace", () => {
    expect(parseStockSettings({ pixabayKey: "  abc  ", openverseClientId: " id " })).toEqual({
      value: { pixabayKey: "abc", openverseClientId: "id" },
    })
  })

  it("treats an empty key as keep (field absent)", () => {
    const r = parseStockSettings({ pixabayKey: "", pexelsKey: "   ", openverseClientSecret: "" })
    expect(r).toEqual({ value: {} })
    expect("value" in r && "pixabayKey" in r.value).toBe(false)
  })

  it("rejects a key over 200 characters", () => {
    expect(parseStockSettings({ pexelsKey: "x".repeat(201) })).toHaveProperty("error")
    expect(parseStockSettings({ pexelsKey: "x".repeat(200) })).toEqual({ value: { pexelsKey: "x".repeat(200) } })
  })

  it("rejects non-objects", () => {
    expect(parseStockSettings(null)).toHaveProperty("error")
    expect(parseStockSettings("nope")).toHaveProperty("error")
    expect(parseStockSettings([])).toHaveProperty("error")
  })

  it("passes clear flags through", () => {
    expect(parseStockSettings({ clearPixabayKey: true, clearOpenverseSecret: false })).toEqual({
      value: { clearPixabayKey: true, clearOpenverseSecret: false },
    })
  })
})
