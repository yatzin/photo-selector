import { describe, expect, it } from "vitest"
import {
  clipRect, containsPoint, contentCentre, dragCorner, dragEdge, dragMove, IDENTITY, isIdentity, isValidTransform, normalizeAngle, normalizeTransform, rotatedBounds,
  rotatedCorners, rotatePoint, scaleAbout, snapAngle, snapCorner, snapEdge, snapToCanvas, toggleFlip, toLocal, withRotation, type Transform,
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
    expect(isIdentity(t({ cropLeft: 0.1 }))).toBe(false)
    expect(isIdentity(t({ cropRight: 0.1 }))).toBe(false)
    expect(isIdentity(t({ cropLeft: 0, cropRight: 0 }))).toBe(true)
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
      { ...IDENTITY, cropLeft: -0.01 }, { ...IDENTITY, cropRight: 0.91 }, { ...IDENTITY, cropLeft: 0.5, cropRight: 0.46 },
      { ...IDENTITY, cropLeft: NaN }, { ...IDENTITY, cropRight: "0.1" }, { ...IDENTITY, cropLeft: null },
    ]) expect(isValidTransform(bad)).toBe(false)
  })

  it("accepts a left and right crop, or none (absent is 0)", () => {
    expect(isValidTransform({ ...IDENTITY, cropLeft: 0.9, cropRight: 0.05 })).toBe(true)
    expect(isValidTransform({ ...IDENTITY, cropLeft: 0.45, cropRight: 0.5 })).toBe(true)
    expect(isValidTransform({ ...IDENTITY, cropRight: 0.2 })).toBe(true)
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

  it("clamps the left and right crop, takes the excess off the right, and leaves out a zero one", () => {
    expect(normalizeTransform(t({ cropLeft: 0.6, cropRight: 0.6 }))).toEqual(t({ cropLeft: 0.6, cropRight: 0.35 }))
    expect(normalizeTransform(t({ cropLeft: 2, cropRight: -1 }))).toEqual(t({ cropLeft: 0.9 }))
    const zero = normalizeTransform(t({ cropLeft: 0, cropRight: NaN }))
    expect(zero).toEqual(IDENTITY)
    expect("cropLeft" in zero || "cropRight" in zero).toBe(false)
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

  it("crops the left and right without moving or scaling what's left", () => {
    const t0 = t({ scale: 0.5, x: 0.1, cropLeft: 0.2, cropRight: 0.3, cropTop: 0.1 })
    const r = clipRect(16 / 9, W, H, t0)
    const full = clipRect(16 / 9, W, H, t({ scale: 0.5, x: 0.1 }))
    expect(r).toMatchObject({ x: full.x, y: full.y, w: full.w, h: full.h })
    expect(r.visible.x).toBeCloseTo(full.x + 0.2 * 960)
    expect(r.visible.w).toBeCloseTo(0.5 * 960)
    expect(r.visible.y).toBeCloseTo(full.y + 0.1 * 540)
    expect(r.visible.h).toBeCloseTo(0.9 * 540)
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

  it("crops the left when dragged right and the right when dragged left, against the scaled width", () => {
    expect(dragEdge(IDENTITY, "left", 16 / 9, W, H, 192).cropLeft).toBeCloseTo(0.1)
    expect(dragEdge(IDENTITY, "right", 16 / 9, W, H, -384).cropRight).toBeCloseTo(0.2)
    expect(dragEdge(t({ scale: 0.5 }), "left", 16 / 9, W, H, 96).cropLeft).toBeCloseTo(0.1)
  })

  it("un-crops left and right when dragged outward, down to 0 (the field goes)", () => {
    expect(dragEdge(t({ cropLeft: 0.2 }), "left", 16 / 9, W, H, -192).cropLeft).toBeCloseTo(0.1)
    expect(dragEdge(t({ cropLeft: 0.2 }), "left", 16 / 9, W, H, -5000)).toEqual(IDENTITY)
    expect(dragEdge(t({ cropRight: 0.2 }), "right", 16 / 9, W, H, 5000)).toEqual(IDENTITY)
  })

  it("stops left and right at 0.9 each and 0.95 together, and leaves the rest alone", () => {
    expect(dragEdge(IDENTITY, "left", 16 / 9, W, H, 50000).cropLeft).toBe(0.9)
    const r = dragEdge(t({ cropLeft: 0.5, cropTop: 0.2 }), "right", 16 / 9, W, H, -50000)
    expect(r.cropLeft).toBe(0.5)
    expect(r.cropRight).toBeCloseTo(0.45)
    expect(r.cropTop).toBe(0.2)
    const left = dragEdge(t({ cropRight: 0.1 }), "left", 16 / 9, W, H, 100)
    expect(left).toMatchObject({ x: 0, y: 0, scale: 1, cropTop: 0, cropBottom: 0, cropRight: 0.1 })
  })

  it("keeps the opposite corner of the visible strip on a corner drag with a left/right crop", () => {
    const t0 = t({ scale: 0.6, cropLeft: 0.2, cropRight: 0.1 })
    const before = clipRect(16 / 9, W, H, t0).visible
    const after = clipRect(16 / 9, W, H, dragCorner(t0, "tl", 16 / 9, W, H, 50, 28)).visible
    expect(after.x + after.w).toBeCloseTo(before.x + before.w, 6)
    expect(after.y + after.h).toBeCloseTo(before.y + before.h, 6)
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

  it("snaps the centre onto the vertical centre line from either side", () => {
    // Centre 955 -> 960 and 964 -> 960; the y is far from every line.
    expect(snapToCanvas({ x: 755, y: 100, w: 400, h: 200 }, W, H, 6)).toEqual({ dx: 5, dy: 0, guides: { x: [960], y: [] } })
    expect(snapToCanvas({ x: 764, y: 100, w: 400, h: 200 }, W, H, 6)).toEqual({ dx: -4, dy: 0, guides: { x: [960], y: [] } })
    // Just outside the threshold.
    expect(snapToCanvas({ x: 753, y: 100, w: 400, h: 200 }, W, H, 6).guides.x).toEqual([])
  })

  it("reports every line a snapped rect sits on, so a full-width picture shows the vertical centre line too", () => {
    // A picture as wide and tall as the canvas, nudged 3 px: its left edge, centre and right edge all land on lines.
    expect(snapToCanvas({ x: 3, y: -2, w: W, h: H }, W, H, 6)).toEqual({ dx: -3, dy: 2, guides: { x: [0, 960, W], y: [0, 540, H] } })
    // A centred half-width picture: only the centre is on a line.
    expect(snapToCanvas({ x: 482, y: 100, w: 960, h: 200 }, W, H, 6).guides.x).toEqual([960])
  })
})

describe("snapEdge", () => {
  it("snaps a dragged crop edge onto the vertical centre line", () => {
    // Full-size picture: the left edge dragged 957 px in lands on 960.
    const { t: snapped, guides } = snapEdge(IDENTITY, "left", 16 / 9, W, H, 957, 6)
    const v = clipRect(16 / 9, W, H, snapped).visible
    expect(v.x).toBeCloseTo(960)
    expect(guides).toEqual({ x: [960], y: [] })
  })

  it("snaps the right edge to the canvas edge and a bottom edge to the horizontal centre", () => {
    const half = t({ scale: 0.5 })
    // Right edge at 1440 dragged out 476 px: 1916, near 1920 but the picture ends at 1440, so it can only un-crop to 1440.
    expect(snapEdge(half, "right", 16 / 9, W, H, 476, 6).guides.x).toEqual([])
    const r = snapEdge(half, "bottom", 16 / 9, W, H, -266, 6)
    // Bottom edge 810 -> 544 snaps to 540.
    expect(clipRect(16 / 9, W, H, r.t).visible.y + clipRect(16 / 9, W, H, r.t).visible.h).toBeCloseTo(540)
    expect(r.guides).toEqual({ x: [], y: [540] })
  })

  it("is a plain dragEdge away from the lines", () => {
    expect(snapEdge(IDENTITY, "top", 16 / 9, W, H, 100, 6)).toEqual({ t: dragEdge(IDENTITY, "top", 16 / 9, W, H, 100), guides: { x: [], y: [] } })
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

describe("rotation and flips", () => {
  it("count as a transform, and their absence or zero as none", () => {
    expect(isIdentity(t({ rotation: 0, flipH: false, flipV: false }))).toBe(true)
    expect(isIdentity(t({ rotation: 1 }))).toBe(false)
    expect(isIdentity(t({ flipH: true }))).toBe(false)
    expect(isIdentity(t({ flipV: true }))).toBe(false)
  })

  it("validate: a finite rotation in (-180, 180] and boolean flips", () => {
    expect(isValidTransform(t({ rotation: 180, flipH: true, flipV: false }))).toBe(true)
    expect(isValidTransform(t({ rotation: -179.5 }))).toBe(true)
    for (const bad of [{ rotation: -180 }, { rotation: 181 }, { rotation: NaN }, { rotation: "5" }, { flipH: 1 }, { flipV: "true" }, { flipH: null }]) {
      expect(isValidTransform({ ...IDENTITY, ...bad })).toBe(false)
    }
  })

  it("normalise: the angle into (-180, 180], zero and false left out", () => {
    expect(normalizeAngle(190)).toBe(-170)
    expect(normalizeAngle(-180)).toBe(180)
    expect(normalizeAngle(540)).toBe(180)
    expect(normalizeAngle(-360)).toBe(0)
    expect(Object.is(normalizeAngle(-0), 0)).toBe(true)
    expect(normalizeTransform(t({ rotation: 370, flipH: true, flipV: false }))).toEqual(t({ rotation: 10, flipH: true }))
    const plain = normalizeTransform(t({ rotation: 360, flipH: false }))
    expect(plain).toEqual(IDENTITY)
    expect("rotation" in plain || "flipH" in plain || "flipV" in plain).toBe(false)
    expect(normalizeTransform(t({ rotation: NaN }))).toEqual(IDENTITY)
  })

  it("withRotation and toggleFlip change only their field", () => {
    const t0 = t({ x: 0.1, scale: 0.5, cropLeft: 0.2 })
    expect(withRotation(t0, -200)).toEqual({ ...t0, rotation: 160 })
    expect(withRotation(withRotation(t0, 45), 0)).toEqual(t0)
    expect(toggleFlip(t0, "h")).toEqual({ ...t0, flipH: true })
    expect(toggleFlip(toggleFlip(t0, "v"), "v")).toEqual(t0)
  })

  it("leave clipRect alone: flips mirror inside the same window, and the rect is the unturned one", () => {
    const t0 = t({ x: 0.1, scale: 0.5, cropLeft: 0.2, cropTop: 0.1 })
    expect(clipRect(4 / 3, W, H, { ...t0, rotation: 30, flipH: true, flipV: true })).toEqual(clipRect(4 / 3, W, H, t0))
  })
})

describe("rotation geometry", () => {
  it("turns points clockwise (y down) about a centre", () => {
    const p = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90)
    expect(p.x).toBeCloseTo(0, 9)
    expect(p.y).toBeCloseTo(10, 9)
    const back = toLocal(p.x, p.y, 90)
    expect(back.x).toBeCloseTo(10, 9)
    expect(back.y).toBeCloseTo(0, 9)
  })

  it("rotates the visible strip's corners about the content centre, not the strip's own centre", () => {
    // Full width, the left half cropped: the strip is the right half, and it turns about the canvas centre.
    const t0 = t({ cropLeft: 0.5, rotation: 180 })
    const v = clipRect(16 / 9, W, H, t0).visible
    const [tl, tr, br, bl] = rotatedCorners(v, contentCentre(W, H, t0), 180)
    expect(tl.x).toBeCloseTo(960, 6)
    expect(tl.y).toBeCloseTo(1080, 6)
    expect(tr.x).toBeCloseTo(0, 6)
    expect(br.y).toBeCloseTo(0, 6)
    expect(bl.x).toBeCloseTo(960, 6)
    const b = rotatedBounds(16 / 9, W, H, t0)
    expect(b.x).toBeCloseTo(0, 6)
    expect(b.w).toBeCloseTo(960, 6)
  })

  it("takes a 90 degree picture's bounds with width and height swapped", () => {
    const b = rotatedBounds(16 / 9, W, H, t({ scale: 0.5, rotation: 90 }))
    expect(b.w).toBeCloseTo(540, 6)
    expect(b.h).toBeCloseTo(960, 6)
    expect(b.x + b.w / 2).toBeCloseTo(960, 6)
  })

  it("hit-tests the turned strip", () => {
    const t0 = t({ scale: 0.5, rotation: 90 })
    // Unturned the strip is x 480-1440, y 270-810; turned it is x 690-1230, y 60-1020.
    expect(containsPoint(16 / 9, W, H, t0, 960, 100)).toBe(true)
    expect(containsPoint(16 / 9, W, H, t0, 500, 540)).toBe(false)
    expect(containsPoint(16 / 9, W, H, t({ scale: 0.5 }), 500, 540)).toBe(true)
  })

  it("snaps the angle to 15 degree steps within 3 degrees", () => {
    expect(snapAngle(43)).toBe(45)
    expect(snapAngle(41)).toBe(41)
    expect(snapAngle(-2.5)).toBe(0)
    expect(snapAngle(88)).toBe(90)
    expect(snapAngle(179)).toBe(180)
    expect(snapAngle(-178)).toBe(180)
  })

  it("scales a rotated picture about the opposite corner where it shows, in its own axes", () => {
    const aspect = 4 / 3
    for (const rotation of [30, 90, -135]) {
      const t0 = t({ scale: 0.6, x: 0.1, y: -0.1, cropTop: 0.1, cropLeft: 0.2, rotation })
      const shown = (tt: Transform) => rotatedCorners(clipRect(aspect, W, H, tt).visible, contentCentre(W, H, tt), rotation)
      // The bottom right corner dragged outward along the picture's own diagonal: the top left stays where it shows.
      const v = clipRect(aspect, W, H, t0).visible
      const out = rotatePoint({ x: v.w * 0.1, y: v.h * 0.1 }, { x: 0, y: 0 }, rotation)
      const t1 = dragCorner(t0, "br", aspect, W, H, out.x, out.y, { anchor: "opposite" })
      expect(t1.scale).toBeCloseTo(0.66, 9)
      expect(t1.rotation).toBe(rotation)
      const [a0] = shown(t0)
      const [a1] = shown(t1)
      expect(a1.x).toBeCloseTo(a0.x, 6)
      expect(a1.y).toBeCloseTo(a0.y, 6)
      // Keyboard scaling (scaleAbout) keeps that corner too.
      const [a2] = shown(scaleAbout(t0, aspect, W, H, "br", 0.8))
      expect(a2.x).toBeCloseTo(a0.x, 6)
      expect(a2.y).toBeCloseTo(a0.y, 6)
    }
  })

  it("keeps the content centre (the pivot) when an edge is cropped, so the rest stays on screen", () => {
    const t0 = t({ scale: 0.7, rotation: 40 })
    const t1 = dragEdge(t0, "left", 16 / 9, W, H, 100)
    expect(contentCentre(W, H, t1)).toEqual(contentCentre(W, H, t0))
    const [, tr0, br0] = rotatedCorners(clipRect(16 / 9, W, H, t0).visible, contentCentre(W, H, t0), 40)
    const [, tr1, br1] = rotatedCorners(clipRect(16 / 9, W, H, t1).visible, contentCentre(W, H, t1), 40)
    expect(tr1.x).toBeCloseTo(tr0.x, 6)
    expect(br1.y).toBeCloseTo(br0.y, 6)
  })
})
