import { describe, expect, it } from "vitest"
import { addClip, newProject, type Asset } from "./project"
import { isValidTransform } from "./transform"
import { STOCK_DROP_SCALE, withStockDropSize } from "./stock-drop"

const video: Asset = { file: "a.mp4", duration: 10, hasAudio: false }

describe("stock drop size", () => {
  it("is about a sixth of the frame's area, centred", () => {
    expect(STOCK_DROP_SCALE * STOCK_DROP_SCALE).toBeGreaterThan(1 / 8)
    expect(STOCK_DROP_SCALE * STOCK_DROP_SCALE).toBeLessThan(1 / 4)
  })

  it("shrinks the added clip, centred, and leaves the rest of the project alone", () => {
    const base = { ...newProject("t"), assets: { a: video } }
    const added = addClip(base, "a", 0, { start: 0 }, "c1")
    const small = withStockDropSize(added, "c1")
    const clip = small.tracks[0].clips.find((c) => c.id === "c1")!
    expect(clip.transform).toMatchObject({ x: 0, y: 0, scale: STOCK_DROP_SCALE })
    expect(isValidTransform(clip.transform)).toBe(true)
    expect(clip.in).toBe(0)
    expect(clip.out).toBe(10)
  })

  it("does nothing for an unknown clip or an audio clip", () => {
    const base = { ...newProject("t"), assets: { a: video } }
    expect(withStockDropSize(base, "nope")).toBe(base)
  })
})
