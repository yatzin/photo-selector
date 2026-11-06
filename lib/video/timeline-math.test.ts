import { describe, expect, it } from "vitest"
import type { Clip } from "./project"
import { clipIdAt, dropIndex, pxToTime, timeToPx, trimDelta } from "./timeline-math"

const clip = (id: string, a: number, b: number): Clip => ({ id, asset: "a", in: a, out: b })

describe("pxToTime / timeToPx", () => {
  it("round trips", () => {
    expect(pxToTime(timeToPx(3.5, 60), 60)).toBeCloseTo(3.5)
    expect(timeToPx(2, 50)).toBe(100)
  })
})

describe("dropIndex", () => {
  const clips = [clip("a", 0, 4), clip("b", 0, 2)] // a: 0-4 (mid 2), b: 4-6 (mid 5)
  it("lands before the first clip left of its midpoint", () => {
    expect(dropIndex(clips, 0)).toBe(0)
    expect(dropIndex(clips, 1.9)).toBe(0)
  })
  it("lands between clips past the first midpoint", () => {
    expect(dropIndex(clips, 2.1)).toBe(1)
    expect(dropIndex(clips, 4.9)).toBe(1)
  })
  it("lands at the end past the last midpoint", () => {
    expect(dropIndex(clips, 5.1)).toBe(2)
    expect(dropIndex(clips, 999)).toBe(2)
  })
  it("is 0 for an empty timeline", () => {
    expect(dropIndex([], 3)).toBe(0)
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

describe("clipIdAt", () => {
  const clips = [clip("a", 0, 4), clip("b", 0, 2)]
  it("finds the clip containing the time", () => {
    expect(clipIdAt(clips, 0)).toBe("a")
    expect(clipIdAt(clips, 3.9)).toBe("a")
    expect(clipIdAt(clips, 4)).toBe("b")
    expect(clipIdAt(clips, 5.9)).toBe("b")
  })
  it("is null past the end or for an empty timeline", () => {
    expect(clipIdAt(clips, 6)).toBeNull()
    expect(clipIdAt([], 0)).toBeNull()
  })
})
