import { describe, expect, it } from "vitest"
import type { Clip } from "./project"
import { pxToTime, snapStart, timeToPx, trimDelta } from "./timeline-math"

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
