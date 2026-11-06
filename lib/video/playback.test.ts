import { describe, expect, it } from "vitest"
import { clipAt, type Clip } from "./project"

const clips: Clip[] = [
  { id: "a", asset: "x", in: 2, out: 5 }, // timeline 0-3
  { id: "b", asset: "y", in: 10, out: 12 }, // timeline 3-5
]

describe("clipAt", () => {
  it("at time 0 is the first clip at its in point", () => {
    expect(clipAt(clips, 0)).toEqual({ index: 0, sourceTime: 2 })
  })
  it("maps a time inside a clip to source time", () => {
    expect(clipAt(clips, 1.5)).toEqual({ index: 0, sourceTime: 3.5 })
    expect(clipAt(clips, 4)).toEqual({ index: 1, sourceTime: 11 })
  })
  it("at the boundary between clips is the next clip", () => {
    expect(clipAt(clips, 3)).toEqual({ index: 1, sourceTime: 10 })
  })
  it("at the total length is null", () => {
    expect(clipAt(clips, 5)).toBeNull()
  })
  it("is null for an empty timeline or negative time", () => {
    expect(clipAt([], 0)).toBeNull()
    expect(clipAt(clips, -1)).toBeNull()
  })
})
