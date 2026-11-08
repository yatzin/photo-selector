import { describe, expect, it } from "vitest"
import { parsePreviewRequest, PREVIEW_CAP, previewKey, previewWindow } from "./audio-preview"

describe("previewWindow", () => {
  it("covers at most the first PREVIEW_CAP seconds of the clip's window", () => {
    expect(PREVIEW_CAP).toBe(12)
    expect(previewWindow(3, 30)).toEqual({ in: 3, out: 15 })
    expect(previewWindow(3, 8)).toEqual({ in: 3, out: 8 })
  })

  it("works in whole milliseconds and takes another cap", () => {
    expect(previewWindow(1.0300001, 6.5000004)).toEqual({ in: 1.03, out: 6.5 })
    expect(previewWindow(1, 40, 5)).toEqual({ in: 1, out: 6 })
  })
})

describe("parsePreviewRequest", () => {
  const ok = { assetId: "a1", in: 1, out: 5, gainDb: 3, fx: [{ type: "chipmunk" }] }

  it("takes an asset, a window and audio levels the project would store", () => {
    expect(parsePreviewRequest(ok)).toEqual({ assetId: "a1", in: 1, out: 5, audio: { gainDb: 3, fx: [{ type: "chipmunk" }] } })
    expect(parsePreviewRequest({ assetId: "a1", in: 0, out: 2 })).toEqual({ assetId: "a1", in: 0, out: 2, audio: undefined })
  })

  it("refuses a bad body, asset, window or levels", () => {
    for (const bad of [
      null, [], "x", {},
      { ...ok, assetId: "" }, { ...ok, assetId: 5 }, { ...ok, assetId: "x".repeat(201) },
      { ...ok, in: -1 }, { ...ok, in: "1" }, { ...ok, out: 1 }, { ...ok, out: Infinity }, { ...ok, in: 4.99 },
      { ...ok, gainDb: 99 }, { ...ok, fx: [{ type: "nope" }] }, { ...ok, fx: "chipmunk" }, { ...ok, fx: [{ type: "chipmunk", amount: 2 }] },
    ]) {
      expect(parsePreviewRequest(bad)).toHaveProperty("error")
    }
  })
})

describe("previewKey", () => {
  const win = { in: 1, out: 5 }

  it("is the same for the same sound and differs when anything heard changes", () => {
    const a = previewKey("a1", win, { fx: [{ type: "chipmunk" }] })
    expect(previewKey("a1", win, { fx: [{ type: "chipmunk" }] })).toBe(a)
    expect(previewKey("a2", win, { fx: [{ type: "chipmunk" }] })).not.toBe(a)
    expect(previewKey("a1", { in: 1, out: 6 }, { fx: [{ type: "chipmunk" }] })).not.toBe(a)
    expect(previewKey("a1", win, { gainDb: 2, fx: [{ type: "chipmunk" }] })).not.toBe(a)
    expect(previewKey("a1", win, { fx: [{ type: "deep" }] })).not.toBe(a)
    expect(previewKey("a1", win, { fx: [{ type: "lowcut", amount: 0.3 }] })).not.toBe(previewKey("a1", win, { fx: [{ type: "lowcut" }] }))
  })

  it("counts a default intensity and an absent one as the same", () => {
    expect(previewKey("a1", win, { fx: [{ type: "lowcut", amount: 0.5 }] })).toBe(previewKey("a1", win, { fx: [{ type: "lowcut" }] }))
  })
})
