import { describe, expect, it } from "vitest"
import { clampViewZoom, MAX_VIEW_ZOOM, MIN_VIEW_ZOOM, parseViewZoom, stepViewZoom, wheelViewZoom, zoomAt, type ZoomSize } from "./viewer-zoom"

const size: ZoomSize = { fitW: 400, fitH: 225, viewW: 500, viewH: 300, pad: 16 }

describe("clampViewZoom", () => {
  it("keeps the range and falls back to fit for junk", () => {
    expect(clampViewZoom(0.01)).toBe(MIN_VIEW_ZOOM)
    expect(clampViewZoom(99)).toBe(MAX_VIEW_ZOOM)
    expect(clampViewZoom(2)).toBe(2)
    expect(clampViewZoom(NaN)).toBe(1)
  })
})

describe("stepViewZoom", () => {
  it("steps through presets, passing through 100%", () => {
    expect(stepViewZoom(1, 1)).toBeGreaterThan(1)
    expect(stepViewZoom(1, -1)).toBeLessThan(1)
    expect(stepViewZoom(0.5, 1)).toBeLessThanOrEqual(0.75)
    expect(stepViewZoom(0.8, 1)).toBe(1)
    expect(stepViewZoom(MAX_VIEW_ZOOM, 1)).toBe(MAX_VIEW_ZOOM)
    expect(stepViewZoom(MIN_VIEW_ZOOM, -1)).toBe(MIN_VIEW_ZOOM)
  })
})

describe("wheelViewZoom", () => {
  it("zooms in on a scroll up, out on a scroll down, and clamps", () => {
    expect(wheelViewZoom(1, -100)).toBeGreaterThan(1)
    expect(wheelViewZoom(1, 100)).toBeLessThan(1)
    expect(wheelViewZoom(MAX_VIEW_ZOOM, -1000)).toBe(MAX_VIEW_ZOOM)
    expect(wheelViewZoom(1, 0)).toBe(1)
  })
})

describe("parseViewZoom", () => {
  it("reads a percent and clamps it", () => {
    expect(parseViewZoom("150")).toBe(1.5)
    expect(parseViewZoom(" 200 % ")).toBe(2)
    expect(parseViewZoom("5")).toBe(MIN_VIEW_ZOOM)
    expect(parseViewZoom("abc")).toBeNull()
  })
})

describe("zoomAt", () => {
  const contentW = (z: number) => Math.max(size.fitW * z + 2 * size.pad, size.viewW)
  const offX = (z: number) => (contentW(z) - size.fitW * z) / 2
  it("keeps the canvas point under the pointer fixed", () => {
    const scroll = { x: 120, y: 40 }
    const pointer = { x: 300, y: 100 }
    const next = zoomAt(scroll, size, pointer, 2, 3)
    const before = (scroll.x + pointer.x - offX(2)) / (size.fitW * 2)
    const after = (next.x + pointer.x - offX(3)) / (size.fitW * 3)
    expect(after).toBeCloseTo(before, 6)
  })
  it("stays at 0 when the canvas is smaller than the view (centred)", () => {
    expect(zoomAt({ x: 0, y: 0 }, size, { x: 100, y: 100 }, 0.5, 0.75)).toEqual({ x: 0, y: 0 })
  })
  it("clamps to the scrollable range", () => {
    const next = zoomAt({ x: 0, y: 0 }, size, { x: 499, y: 299 }, 1, 8)
    expect(next.x).toBeLessThanOrEqual(contentW(8) - size.viewW)
    expect(next.x).toBeGreaterThanOrEqual(0)
    const back = zoomAt({ x: 5000, y: 5000 }, size, { x: 0, y: 0 }, 8, 1)
    expect(back).toEqual({ x: 0, y: 0 })
  })
  it("zooming in at the corner pointer from fit keeps that point", () => {
    const next = zoomAt({ x: 0, y: 0 }, size, { x: 250, y: 150 }, 1, 2)
    expect(next.x).toBeGreaterThan(0)
    expect(next.y).toBeGreaterThanOrEqual(0)
  })
})
