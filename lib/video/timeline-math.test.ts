import { describe, expect, it } from "vitest"
import type { Clip } from "./project"
import {
  autoPanSpeed, clampRowZoom, clampZoom, MAX_ZOOM, MIN_ZOOM, pxToTime, rowHeight, snapStart, timeToPx, timelineWidth, trimDelta, wheelPixels, wheelZoomFactor, zoomAround,
} from "./timeline-math"

const clip = (id: string, a: number, b: number): Clip => ({ id, asset: "a", in: a, out: b, start: 0 })

describe("pxToTime / timeToPx", () => {
  it("round trips", () => {
    expect(pxToTime(timeToPx(3.5, 60), 60)).toBeCloseTo(3.5)
    expect(timeToPx(2, 50)).toBe(100)
  })
})

describe("trimDelta", () => {
  const c = clip("a", 1, 6)
  it("moves the in edge right by deltaPx / zoom seconds", () => {
    expect(trimDelta("in", c, 100, 50)).toBeCloseTo(3)
  })
  it("moves the out edge left for a negative drag", () => {
    expect(trimDelta("out", c, -50, 50)).toBeCloseTo(5)
  })
})

describe("snapStart", () => {
  // 8 px at 40 px/s is 0.2 s.
  const snap = (start: number, length: number, points: number[]) => snapStart(start, length, points, 8, 40)
  it("snaps the start to a point within the threshold", () => {
    expect(snap(2.15, 1, [2])).toBe(2)
    expect(snap(1.85, 1, [2])).toBe(2)
  })
  it("snaps the end to a point when the start has none near", () => {
    expect(snap(0.9, 1, [2])).toBe(1)
  })
  it("takes the nearest of several points", () => {
    expect(snap(2.1, 1, [2, 2.15])).toBe(2.15)
    expect(snap(2.1, 1, [2, 3.05])).toBe(2.05)
  })
  it("leaves the start alone when nothing is near, and never goes below 0", () => {
    expect(snap(2.5, 1, [2, 4])).toBe(2.5)
    expect(snap(-0.5, 1, [])).toBe(0)
  })
})

describe("autoPanSpeed", () => {
  // A viewport from x 100 to 900, the default 48 px edge zones and 900 px/s cap.
  const speed = (x: number) => autoPanSpeed(x, 100, 900)
  it("is 0 away from the edges", () => {
    expect(speed(500)).toBe(0)
    expect(speed(148)).toBe(0)
    expect(speed(852)).toBe(0)
  })
  it("pans right near the right edge, faster the closer the pointer", () => {
    expect(speed(876)).toBeCloseTo(450)
    expect(speed(888)).toBeGreaterThan(speed(876))
    expect(speed(900)).toBeCloseTo(900)
  })
  it("pans left near the left edge", () => {
    expect(speed(124)).toBeCloseTo(-450)
    expect(speed(100)).toBeCloseTo(-900)
  })
  it("is capped past the edges", () => {
    expect(speed(1200)).toBe(900)
    expect(speed(-300)).toBe(-900)
  })
  it("takes its own edge and cap", () => {
    expect(autoPanSpeed(990, 0, 1000, 20, 200)).toBeCloseTo(100)
  })
  it("uses the nearer edge in a viewport narrower than both zones", () => {
    expect(autoPanSpeed(10, 0, 60)).toBeLessThan(0)
    expect(autoPanSpeed(50, 0, 60)).toBeGreaterThan(0)
    expect(autoPanSpeed(30, 0, 60)).toBe(0)
  })
})

describe("timelineWidth", () => {
  const base = { contentEnd: 10, zoom: 50, viewport: 300, pad: 240, dragEnd: null, extra: 10 }
  it("is the content plus the padding, at least the viewport", () => {
    expect(timelineWidth(base)).toBe(740)
    expect(timelineWidth({ ...base, contentEnd: 0 })).toBe(300)
    expect(timelineWidth({ ...base, viewport: 1000 })).toBe(1000)
  })
  it("grows while a drag reaches past the content, by `extra` seconds past the dragged end", () => {
    expect(timelineWidth({ ...base, dragEnd: 30 })).toBe(2000)
    // A drag inside the content adds nothing beyond its extra room.
    expect(timelineWidth({ ...base, dragEnd: 2 })).toBe(740)
  })
  it("shrinks back to the content when the content ends earlier", () => {
    expect(timelineWidth({ ...base, contentEnd: 4 })).toBe(440)
  })
})

describe("rowHeight / clampRowZoom", () => {
  it("keeps full rows for one or two layers, scaled by the zoom", () => {
    expect(rowHeight(1, 1)).toBe(80)
    expect(rowHeight(1, 2)).toBe(160)
    expect(rowHeight(2, 0.6)).toBe(48)
  })
  it("halves rows from three layers and scales them by the zoom", () => {
    expect(rowHeight(3, 1)).toBe(40)
    expect(rowHeight(4, 2)).toBe(80)
    expect(rowHeight(4, 0.6)).toBe(24)
  })
  it("clamps the zoom between 0.6 and 2 and falls back to 1 for junk", () => {
    expect(clampRowZoom(5)).toBe(2)
    expect(clampRowZoom(0.1)).toBe(0.6)
    expect(clampRowZoom(Number.NaN)).toBe(1)
    expect(clampRowZoom(1.25)).toBe(1.25)
  })
})

describe("zoomAround", () => {
  it("keeps the time under the pointer under it", () => {
    // At 50 px/s scrolled 100 px, the pointer 200 px in is at 6 s; at 100 px/s 6 s is 600 px in, so scroll 400.
    expect(zoomAround(50, 100, 200, 100)).toBe(400)
    expect(zoomAround(100, 50, 200, 400)).toBe(100)
    const t = (zoom: number, x: number, scroll: number) => (scroll + x) / zoom
    for (const [z, nz, x, sl] of [[60, 64.8, 333, 1200], [37, 20, 10, 0], [200, 180, 640, 5000]]) {
      const next = zoomAround(z, nz, x, sl)
      if (next > 0) expect(t(nz, x, next)).toBeCloseTo(t(z, x, sl))
    }
  })

  it("never scrolls before the start", () => {
    expect(zoomAround(100, 50, 300, 100)).toBe(0)
    expect(zoomAround(60, 60, 0, 0)).toBe(0)
  })
})

describe("clampZoom", () => {
  it("keeps the horizontal zoom in the slider's range", () => {
    expect([MIN_ZOOM, MAX_ZOOM]).toEqual([20, 200])
    expect(clampZoom(5)).toBe(20)
    expect(clampZoom(500)).toBe(200)
    expect(clampZoom(64.8)).toBe(64.8)
    expect(clampZoom(Number.NaN)).toBe(60)
  })
})

describe("wheelPixels", () => {
  it("turns line and page deltas into pixels and passes pixels through", () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 100, deltaMode: 0 }, 600)).toEqual({ x: 0, y: 100 })
    expect(wheelPixels({ deltaX: 1, deltaY: -3, deltaMode: 1 }, 600)).toEqual({ x: 40, y: -120 })
    expect(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 600)).toEqual({ x: 0, y: 600 })
  })
})

describe("wheelZoomFactor", () => {
  it("zooms in about 8% for a notch up, out by the same for a notch down", () => {
    expect(wheelZoomFactor(-100)).toBeCloseTo(1.08)
    expect(wheelZoomFactor(100)).toBeCloseTo(1 / 1.08)
    expect(wheelZoomFactor(0)).toBe(1)
  })

  it("follows small trackpad deltas smoothly and caps a huge one at three notches", () => {
    expect(wheelZoomFactor(-4)).toBeGreaterThan(1)
    expect(wheelZoomFactor(-4)).toBeLessThan(1.01)
    expect(wheelZoomFactor(-5000)).toBeCloseTo(1.08 ** 3)
  })
})
