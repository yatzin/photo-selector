import { describe, expect, it } from "vitest"
import {
  clipRect, dragCorner, dragEdge, dragMove, IDENTITY, isIdentity, isValidTransform, normalizeTransform, scaleAbout, snapCorner, snapToCanvas, type Transform,
} from "./transform"

const W = 1920
const H = 1080
const t = (over: Partial<Transform>): Transform => ({ ...IDENTITY, ...over })

describe("isIdentity", () => {
  it("is true for no transform and the identity", () => {
    expect(isIdentity(undefined)).toBe(true)
    expect(isIdentity({ x: 0, y: 0, scale: 1, cropTop: 0, cropBottom: 0 })).toBe(true)
    expect(isIdentity(t({ scale: 0.5 }))).toBe(false)
    expect(isIdentity(t({ cropBottom: 0.1 }))).toBe(false)
    expect(isIdentity(t({ x: 0.01 }))).toBe(false)
  })
})

describe("isValidTransform", () => {
  it("accepts values inside the limits", () => {
    expect(isValidTransform(IDENTITY)).toBe(true)
    expect(isValidTransform({ x: -2, y: 2, scale: 0.1, cropTop: 0.9, cropBottom: 0.05 })).toBe(true)
    expect(isValidTransform({ x: 0, y: 0, scale: 5, cropTop: 0.45, cropBottom: 0.5 })).toBe(true)
  })

  it("rejects out-of-range, missing and non-finite values", () => {
    for (const bad of [
      null, 1, "x", [], {},
      { ...IDENTITY, scale: 0.09 }, { ...IDENTITY, scale: 5.1 }, { ...IDENTITY, x: 2.01 }, { ...IDENTITY, y: -2.01 },
      { ...IDENTITY, cropTop: -0.01 }, { ...IDENTITY, cropBottom: 0.91 }, { ...IDENTITY, cropTop: 0.5, cropBottom: 0.46 },
      { ...IDENTITY, x: NaN }, { ...IDENTITY, scale: Infinity }, { ...IDENTITY, y: "0" }, { x: 0, y: 0, scale: 1, cropTop: 0 },
    ]) expect(isValidTransform(bad)).toBe(false)
  })
})

describe("normalizeTransform", () => {
  it("clamps every field into its limits", () => {
    expect(normalizeTransform({ x: 3, y: -3, scale: 9, cropTop: -1, cropBottom: 2 })).toEqual({ x: 2, y: -2, scale: 5, cropTop: 0, cropBottom: 0.9 })
    expect(normalizeTransform(t({ scale: 0 }))).toEqual(t({ scale: 0.1 }))
  })

  it("takes the excess of a crop sum over 0.95 off the bottom", () => {
    expect(normalizeTransform(t({ cropTop: 0.6, cropBottom: 0.6 }))).toEqual(t({ cropTop: 0.6, cropBottom: 0.35 }))
  })

  it("turns non-finite values into the identity's", () => {
    expect(normalizeTransform({ x: NaN, y: Infinity, scale: NaN, cropTop: NaN, cropBottom: -Infinity })).toEqual(IDENTITY)
  })
})

describe("clipRect", () => {
  it("fits a 16:9 picture to a 16:9 canvas", () => {
    const r = clipRect(16 / 9, W, H, IDENTITY)
    expect(r).toEqual({ x: 0, y: 0, w: W, h: H, visible: { x: 0, y: 0, w: W, h: H } })
  })

  it("letterboxes a portrait picture in the middle", () => {
    const r = clipRect(9 / 16, W, H, IDENTITY)
    expect(r.h).toBeCloseTo(H)
    expect(r.w).toBeCloseTo(H * 9 / 16)
    expect(r.x).toBeCloseTo((W - r.w) / 2)
    expect(r.y).toBeCloseTo(0)
  })

  it("scales about the centre and moves by fractions of the canvas", () => {
    const r = clipRect(16 / 9, W, H, t({ scale: 0.5, x: 0.25, y: -0.1 }))
    expect(r.w).toBeCloseTo(960)
    expect(r.h).toBeCloseTo(540)
    expect(r.x).toBeCloseTo(W / 2 + 0.25 * W - 480)
    expect(r.y).toBeCloseTo(H / 2 - 0.1 * H - 270)
  })

  it("crops the top and bottom without moving what's left", () => {
    const r = clipRect(16 / 9, W, H, t({ cropTop: 0.25, cropBottom: 0.5 }))
    expect(r).toMatchObject({ x: 0, y: 0, w: W, h: H })
    expect(r.visible.x).toBe(0)
    expect(r.visible.w).toBe(W)
    expect(r.visible.y).toBeCloseTo(0.25 * H)
    expect(r.visible.h).toBeCloseTo(0.25 * H)
  })

  it("falls back to the canvas aspect for a bad aspect", () => {
    expect(clipRect(NaN, W, H, IDENTITY)).toEqual(clipRect(W / H, W, H, IDENTITY))
    expect(clipRect(0, W, H, IDENTITY)).toEqual(clipRect(W / H, W, H, IDENTITY))
  })
})

describe("dragMove", () => {
  it("adds the fractions and clamps", () => {
    expect(dragMove(t({ x: 0.1 }), 0.2, -0.3)).toEqual(t({ x: 0.30000000000000004, y: -0.3 }))
    expect(dragMove(t({ x: 1.9 }), 0.5, 0).x).toBe(2)
  })
})

describe("dragCorner", () => {
  const corner = (r: ReturnType<typeof clipRect>["visible"], c: "tl" | "tr" | "bl" | "br") => ({
    x: c.endsWith("l") ? r.x : r.x + r.w,
    y: c.startsWith("t") ? r.y : r.y + r.h,
  })
  const opposite = { tl: "br", tr: "bl", bl: "tr", br: "tl" } as const

  it("keeps the opposite corner fixed and the aspect ratio", () => {
    for (const c of ["tl", "tr", "bl", "br"] as const) {
      for (const t0 of [IDENTITY, t({ scale: 0.6, x: 0.1, y: -0.2, cropTop: 0.2, cropBottom: 0.1 })]) {
        const aspect = 4 / 3
        const before = clipRect(aspect, W, H, t0)
        const sign = { x: c.endsWith("l") ? 1 : -1, y: c.startsWith("t") ? 1 : -1 }
        const after = clipRect(aspect, W, H, dragCorner(t0, c, aspect, W, H, sign.x * 100, sign.y * 50, { anchor: "opposite" }))
        const a0 = corner(before.visible, opposite[c])
        const a1 = corner(after.visible, opposite[c])
        expect(a1.x).toBeCloseTo(a0.x, 6)
        expect(a1.y).toBeCloseTo(a0.y, 6)
        expect(after.w / after.h).toBeCloseTo(aspect, 9)
        // Dragging the corner inward shrinks it.
        expect(after.w).toBeLessThan(before.w)
      }
    }
  })

  it("grows when dragged outward, by the drag projected on the diagonal", () => {
    const after = dragCorner(IDENTITY, "br", 16 / 9, W, H, 192, 108, { anchor: "opposite" })
    expect(after.scale).toBeCloseTo(1.1)
  })

  it("clamps the scale", () => {
    expect(dragCorner(IDENTITY, "br", 16 / 9, W, H, -5000, -5000, { anchor: "opposite" }).scale).toBe(0.1)
    expect(dragCorner(IDENTITY, "br", 16 / 9, W, H, 50000, 50000, { anchor: "opposite" }).scale).toBe(5)
  })

  it("leaves the crop fractions alone", () => {
    const t0 = t({ cropTop: 0.2, cropBottom: 0.3 })
    const after = dragCorner(t0, "tl", 16 / 9, W, H, 100, 100, { anchor: "opposite" })
    expect(after.cropTop).toBe(0.2)
    expect(after.cropBottom).toBe(0.3)
  })
})

describe("scaleAbout", () => {
  it("scales by a factor about a corner of the visible strip", () => {
    const t0 = t({ cropBottom: 0.5 })
    const after = scaleAbout(t0, 16 / 9, W, H, "br", 0.5)
    expect(after.scale).toBe(0.5)
    const v = clipRect(16 / 9, W, H, after).visible
    // The top-left of the strip (the corner opposite br) stays at 0, 0.
    expect(v.x).toBeCloseTo(0)
    expect(v.y).toBeCloseTo(0)
    expect(v.w).toBeCloseTo(W / 2)
    expect(v.h).toBeCloseTo(H / 4)
  })
})

describe("dragEdge", () => {
  it("crops the top when dragged down and the bottom when dragged up", () => {
    expect(dragEdge(IDENTITY, "top", 16 / 9, W, H, 108).cropTop).toBeCloseTo(0.1)
    expect(dragEdge(IDENTITY, "bottom", 16 / 9, W, H, -216).cropBottom).toBeCloseTo(0.2)
  })

  it("measures against the scaled height", () => {
    expect(dragEdge(t({ scale: 0.5 }), "top", 16 / 9, W, H, 54).cropTop).toBeCloseTo(0.1)
  })

  it("un-crops when dragged outward, down to 0", () => {
    expect(dragEdge(t({ cropTop: 0.2 }), "top", 16 / 9, W, H, -108).cropTop).toBeCloseTo(0.1)
    expect(dragEdge(t({ cropTop: 0.2 }), "top", 16 / 9, W, H, -5000).cropTop).toBe(0)
    expect(dragEdge(t({ cropBottom: 0.2 }), "bottom", 16 / 9, W, H, 5000).cropBottom).toBe(0)
  })

  it("stops at 0.9 per edge and 0.95 together, giving way on the dragged edge", () => {
    expect(dragEdge(IDENTITY, "top", 16 / 9, W, H, 5000).cropTop).toBe(0.9)
    const r = dragEdge(t({ cropTop: 0.5 }), "bottom", 16 / 9, W, H, -5000)
    expect(r.cropTop).toBe(0.5)
    expect(r.cropBottom).toBeCloseTo(0.45)
  })

  it("changes nothing but the crop", () => {
    const t0 = t({ x: 0.2, y: 0.1, scale: 0.7 })
    const r = dragEdge(t0, "bottom", 16 / 9, W, H, -50)
    expect({ ...r, cropBottom: 0 }).toEqual(t0)
  })
})

describe("snapToCanvas", () => {
  it("snaps the nearest edge or centre within the threshold and reports the guides", () => {
    expect(snapToCanvas({ x: 4, y: 300, w: 500, h: 200 }, W, H, 6)).toEqual({ dx: -4, dy: 0, guides: { x: [0], y: [] } })
    // Centre 962,543 -> 960,540
    expect(snapToCanvas({ x: 712, y: 443, w: 500, h: 200 }, W, H, 6)).toEqual({ dx: -2, dy: -3, guides: { x: [960], y: [540] } })
    // Right edge 1915 -> 1920, bottom 1083 -> 1080
    expect(snapToCanvas({ x: 1415, y: 883, w: 500, h: 200 }, W, H, 6)).toEqual({ dx: 5, dy: -3, guides: { x: [1920], y: [1080] } })
  })

  it("leaves a rect far from every line alone", () => {
    expect(snapToCanvas({ x: 100, y: 100, w: 500, h: 200 }, W, H, 6)).toEqual({ dx: 0, dy: 0, guides: { x: [], y: [] } })
  })
})

describe("snapCorner", () => {
  it("snaps the dragged corner to a canvas line while keeping the opposite corner", () => {
    const t0 = t({ scale: 0.5 })
    // Dragging br of a centred half-size picture out to near the right edge.
    const t1 = dragCorner(t0, "br", 16 / 9, W, H, 476, 268, { anchor: "opposite" })
    const { t: snapped, guides } = snapCorner(t0, "br", 16 / 9, W, H, t1, 6)
    const v = clipRect(16 / 9, W, H, snapped).visible
    expect(v.x + v.w).toBeCloseTo(W)
    expect(guides.x).toEqual([W])
    expect(v.x).toBeCloseTo(480)
  })

  it("does nothing away from the lines", () => {
    const t1 = dragCorner(t({ scale: 0.5 }), "br", 16 / 9, W, H, 100, 56, { anchor: "opposite" })
    expect(snapCorner(t({ scale: 0.5 }), "br", 16 / 9, W, H, t1, 6)).toEqual({ t: t1, guides: { x: [], y: [] } })
  })
})
