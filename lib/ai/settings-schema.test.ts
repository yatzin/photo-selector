import { describe, expect, it } from "vitest"
import { DEFAULT_INSTRUCTIONS } from "./prompt"
import { DEFAULT_SCREENSHOT_INSTRUCTIONS } from "./screenshot-prompt"
import { isAiReady, keyMayFollow, originChanged, parseAiSettings, parseExtraBody, type AiSettingsInput } from "./settings-schema"

const base: AiSettingsInput = {
  enabled: true,
  baseUrl: "http://nas:11434/v1/",
  model: "qwen2.5vl:7b",
  groupWindowSeconds: "60",
  similarity: "similar",
  imageMaxPx: "768",
  maxGroupSize: "12",
}

describe("parseAiSettings", () => {
  it("accepts a complete form and trims the URL", () => {
    const r = parseAiSettings(base)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.baseUrl).toBe("http://nas:11434/v1")
      expect(r.value.similarity).toBe("similar")
      expect(r.value.timeoutSeconds).toBeNull()
    }
  })

  it("requires URL and model to turn AI on", () => {
    expect(parseAiSettings({ ...base, model: "" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, enabled: false, model: "" }).ok).toBe(true)
    expect(parseAiSettings({ ...base, model: "" }, { requireComplete: false }).ok).toBe(true)
  })

  it("rejects non-http URLs", () => {
    expect(parseAiSettings({ ...base, baseUrl: "ftp://x" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, baseUrl: "not a url" }).ok).toBe(false)
  })

  it("enforces numeric ranges", () => {
    expect(parseAiSettings({ ...base, groupWindowSeconds: "4" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, groupWindowSeconds: "601" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, imageMaxPx: "383" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, imageMaxPx: "1537" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, maxGroupSize: "1" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, maxGroupSize: "21" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, temperature: "2.5" }).ok).toBe(false)
    expect(parseAiSettings({ ...base, timeoutSeconds: "9" }).ok).toBe(false)
  })

  it("rejects an unknown similarity level", () => {
    expect(parseAiSettings({ ...base, similarity: "fuzzy" }).ok).toBe(false)
  })

  it("rejects extra JSON that overrides reserved fields", () => {
    expect(parseAiSettings({ ...base, extraBody: '{"model":"x"}' }).ok).toBe(false)
    expect(parseAiSettings({ ...base, extraBody: "[1]" }).ok).toBe(false)
    const ok = parseAiSettings({ ...base, extraBody: '{ "keep_alive": "10m" }' })
    expect(ok.ok && ok.value.extraBody).toBe('{"keep_alive":"10m"}')
  })

  it("limits the instructions", () => {
    expect(parseAiSettings({ ...base, instructions: "x".repeat(4001) }).ok).toBe(false)
    expect(parseAiSettings({ ...base, instructions: "x".repeat(4000) }).ok).toBe(true)
  })

  it("saves edited instructions and treats unedited or blank ones as the default", () => {
    const edited = parseAiSettings({ ...base, instructions: "  Pick the sharpest photo.  " })
    expect(edited.ok && edited.value.instructions).toBe("Pick the sharpest photo.")
    const unedited = parseAiSettings({ ...base, instructions: DEFAULT_INSTRUCTIONS })
    expect(unedited.ok && unedited.value.instructions).toBeNull()
    const blank = parseAiSettings({ ...base, instructions: "" })
    expect(blank.ok && blank.value.instructions).toBeNull()
  })

  it("keeps the screenshot instructions separately, with their own default", () => {
    const edited = parseAiSettings({ ...base, screenshotInstructions: " Only chat screenshots. " })
    expect(edited.ok && edited.value).toMatchObject({ screenshotInstructions: "Only chat screenshots.", instructions: null })
    const unedited = parseAiSettings({ ...base, screenshotInstructions: DEFAULT_SCREENSHOT_INSTRUCTIONS })
    expect(unedited.ok && unedited.value.screenshotInstructions).toBeNull()
    expect(parseAiSettings({ ...base, screenshotInstructions: "x".repeat(4001) }).ok).toBe(false)
  })
})

describe("helpers", () => {
  it("isAiReady needs everything", () => {
    expect(isAiReady({ enabled: true, baseUrl: "http://a", model: "m", keyUnreadable: false })).toBe(true)
    expect(isAiReady({ enabled: true, baseUrl: "http://a", model: "m", keyUnreadable: true })).toBe(false)
    expect(isAiReady({ enabled: false, baseUrl: "http://a", model: "m", keyUnreadable: false })).toBe(false)
  })

  it("originChanged compares origins only", () => {
    expect(originChanged("http://a:1/v1", "http://a:1/v2")).toBe(false)
    expect(originChanged("http://a:1/v1", "http://b:1/v1")).toBe(true)
    expect(originChanged(null, "http://b")).toBe(false)
  })

  it("parseExtraBody only accepts objects", () => {
    expect(parseExtraBody('{"a":1}')).toEqual({ a: 1 })
    expect(parseExtraBody("1")).toBeNull()
    expect(parseExtraBody("")).toBeNull()
  })
})

describe("keyMayFollow", () => {
  it("lets a stored key go only to the origin it was saved for", () => {
    expect(keyMayFollow("http://a:1/v1", "http://a:1/v2")).toBe(true)
    expect(keyMayFollow("http://a:1/v1", "http://b:1/v1")).toBe(false)
  })

  it("never sends a key whose original server is unknown", () => {
    expect(keyMayFollow(null, "http://b/v1")).toBe(false)
    expect(keyMayFollow("http://a/v1", null)).toBe(false)
    expect(keyMayFollow("not a url", "http://a/v1")).toBe(false)
  })
})
