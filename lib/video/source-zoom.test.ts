import { describe, expect, it } from "vitest"
import { sourceTicks } from "./source-window"
import { clampViewport, fullViewport, maxZoom, nextZoom, panViewport, viewTicks, viewTimeToX, viewXToTime, zoomOf, zoomViewport, ZOOM_STEP } from "./source-zoom"

describe("maxZoom and nextZoom", () => {
  it("stops at 32x or a one-second view, whichever comes first", () => {
    expect(maxZoom(60)).toBe(32)
    expect(maxZoom(9)).toBe(9)
    expect(maxZoom(0.5)).toBe(1)
  })

  it("steps by ZOOM_STEP from 1x, clamped to the limits", () => {
    expect(nextZoom(1, 1, 60)).toBe(ZOOM_STEP)
    expect(nextZoom(ZOOM_STEP, -1, 60)).toBe(1)
    expect(nextZoom(1, -1, 60)).toBe(1)
    expect(nextZoom(30, 1, 60)).toBe(32)
    expect(nextZoom(8, 1, 9)).toBe(9)
  })
})

describe("clampViewport", () => {
  it("keeps the view inside the file and within the zoom limits", () => {
    expect(clampViewport({ start: -2, span: 5 }, 20)).toEqual({ start: 0, span: 5 })
    expect(clampViewport({ start: 18, span: 5 }, 20)).toEqual({ start: 15, span: 5 })
    expect(clampViewport({ start: 3, span: 40 }, 20)).toEqual({ start: 0, span: 20 })
    expect(clampViewport({ start: 3, span: 0.1 }, 20)).toEqual({ start: 3, span: 1 })
  })
})

describe("zoomViewport", () => {
  const d = 20

  it("zooming in centres the selection when it fits", () => {
    const v = zoomViewport(fullViewport(d), 2, { in: 6, out: 8 }, d)
    expect(v).toEqual({ start: 2, span: 10 })
    expect(zoomOf(v, d)).toBe(2)
  })

  it("anchors the selection's start at the left when it's wider than the view", () => {
    expect(zoomViewport({ start: 0, span: 10 }, 2, { in: 3, out: 9 }, d)).toEqual({ start: 3, span: 5 })
  })

  it("zooming out keeps the selection's centre where it is on screen", () => {
    // Centre 7 sits a quarter of the way across a view from 4.5 to 14.5.
    const v = zoomViewport({ start: 4.5, span: 10 }, 0.5, { in: 6, out: 8 }, d)
    expect(v.span).toBe(20)
    expect(v.start).toBe(0)
    const w = zoomViewport({ start: 4, span: 4 }, 0.5, { in: 5, out: 6 }, d)
    expect(w).toEqual({ start: 2.5, span: 8 })
  })

  it("stays inside the file", () => {
    expect(zoomViewport(fullViewport(d), 4, { in: 0, out: 1 }, d)).toEqual({ start: 0, span: 5 })
    expect(zoomViewport(fullViewport(d), 4, { in: 19, out: 20 }, d)).toEqual({ start: 15, span: 5 })
  })

  it("never zooms past the limit", () => {
    expect(zoomViewport({ start: 0, span: 1.2 }, 4, { in: 0.2, out: 0.4 }, 9).span).toBe(1)
  })
})

describe("panViewport", () => {
  it("moves the view by seconds, clamped to the file", () => {
    expect(panViewport({ start: 4, span: 5 }, 3, 20)).toEqual({ start: 7, span: 5 })
    expect(panViewport({ start: 4, span: 5 }, -10, 20)).toEqual({ start: 0, span: 5 })
    expect(panViewport({ start: 4, span: 5 }, 30, 20)).toEqual({ start: 15, span: 5 })
  })
})

describe("pixels and seconds in a zoomed view", () => {
  const v = { start: 5, span: 2 }
  it("maps both ways", () => {
    expect(viewTimeToX(6, v, 400)).toBe(200)
    expect(viewTimeToX(4, v, 400)).toBe(-200)
    expect(viewXToTime(100, v, 400, 20)).toBe(5.5)
  })

  it("clamps a time to the file, not the view", () => {
    expect(viewXToTime(-1000, v, 400, 20)).toBe(0)
    expect(viewXToTime(500, v, 400, 20)).toBe(7.5)
    expect(viewXToTime(1e6, v, 400, 20)).toBe(20)
  })
})

describe("viewTicks", () => {
  it("matches the whole-file ticks at 1x", () => {
    expect(viewTicks(fullViewport(10), 400, 70)).toEqual(sourceTicks(10, 400, 70))
    expect(viewTicks(fullViewport(60), 600, 70)).toEqual(sourceTicks(60, 600, 70))
  })

  it("gets finer as the view zooms in, inside the view only", () => {
    expect(viewTicks({ start: 4, span: 2 }, 400, 70)).toEqual([4.5, 5, 5.5])
    expect(viewTicks({ start: 3.3, span: 1 }, 700, 70)).toEqual([3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4, 4.1, 4.2])
  })

  it("is empty for an empty view or strip", () => {
    expect(viewTicks({ start: 0, span: 0 }, 400)).toEqual([])
    expect(viewTicks({ start: 0, span: 10 }, 0)).toEqual([])
  })
})
