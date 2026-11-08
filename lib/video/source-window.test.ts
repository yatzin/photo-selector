import { describe, expect, it } from "vitest"
import { dragSelection, sourceTicks, stepSelection, timeToX, xToTime } from "./source-window"

const near = (a: { in: number; out: number }, b: { in: number; out: number }) => {
  expect(a.in).toBeCloseTo(b.in, 9)
  expect(a.out).toBeCloseTo(b.out, 9)
}

describe("timeToX / xToTime", () => {
  it("maps the whole source onto the strip's width and back", () => {
    expect(timeToX(5, 10, 400)).toBe(200)
    expect(timeToX(10, 10, 400)).toBe(400)
    expect(xToTime(100, 10, 400)).toBe(2.5)
  })

  it("clamps a pointer outside the strip to the source's ends", () => {
    expect(xToTime(-30, 10, 400)).toBe(0)
    expect(xToTime(450, 10, 400)).toBe(10)
  })

  it("is 0 for an empty strip or source", () => {
    expect(timeToX(3, 0, 400)).toBe(0)
    expect(xToTime(30, 10, 0)).toBe(0)
  })
})

describe("dragSelection", () => {
  const sel = { in: 2, out: 6 }

  it("moves the in point with the left handle and the out point with the right one", () => {
    near(dragSelection("in", 10, sel, 1, 0.2, [], false), { in: 3, out: 6 })
    near(dragSelection("out", 10, sel, -1.5, 0.2, [], false), { in: 2, out: 4.5 })
  })

  it("clamps at the source's ends", () => {
    near(dragSelection("in", 10, sel, -5, 0.2, [], false), { in: 0, out: 6 })
    near(dragSelection("out", 10, sel, 9, 0.2, [], false), { in: 2, out: 10 })
  })

  it("keeps at least the minimum length", () => {
    near(dragSelection("in", 10, sel, 9, 0.2, [], false), { in: 5.8, out: 6 })
    near(dragSelection("out", 10, sel, -9, 0.2, [], false), { in: 2, out: 2.2 })
  })

  it("slides the window keeping its length, stopping at either end", () => {
    near(dragSelection("move", 10, sel, 1.25, 0.2, [], false), { in: 3.25, out: 7.25 })
    near(dragSelection("move", 10, sel, 20, 0.2, [], false), { in: 6, out: 10 })
    near(dragSelection("move", 10, sel, -20, 0.2, [], false), { in: 0, out: 4 })
  })

  it("snaps a handle to a nearby tick or end, and not past the snap distance", () => {
    near(dragSelection("in", 10, sel, 0.95, 0.2, [0, 3, 10], true, 0.1), { in: 3, out: 6 })
    near(dragSelection("in", 10, sel, 0.85, 0.2, [0, 3, 10], true, 0.1), { in: 2.85, out: 6 })
    near(dragSelection("out", 10, sel, 3.93, 0.2, [0, 10], true, 0.1), { in: 2, out: 10 })
  })

  it("snaps the sliding window by whichever edge is nearer a point", () => {
    // in would be 3.05 (0.05 from 3), out 7.05 (0.05 from 7.1 is further): in snaps.
    near(dragSelection("move", 10, sel, 1.05, 0.2, [3, 7.12], true, 0.1), { in: 3, out: 7 })
    // out would be 7.95, 0.05 from 8.
    near(dragSelection("move", 10, sel, 1.95, 0.2, [8], true, 0.1), { in: 4, out: 8 })
  })

  it("doesn't snap with snapping off (Alt held)", () => {
    near(dragSelection("in", 10, sel, 0.95, 0.2, [3], false, 0.1), { in: 2.95, out: 6 })
    near(dragSelection("move", 10, sel, 1.05, 0.2, [3], false, 0.1), { in: 3.05, out: 7.05 })
  })

  it("never lets a snap break the minimum length", () => {
    near(dragSelection("in", 10, sel, 3.95, 0.2, [6], true, 0.1), { in: 5.8, out: 6 })
  })

  it("selects the whole of a source shorter than the minimum", () => {
    near(dragSelection("out", 0.1, { in: 0, out: 0.1 }, -1, 0.2, [], false), { in: 0, out: 0.1 })
  })
})

describe("stepSelection", () => {
  const sel = { in: 2, out: 6 }

  it("moves a handle or the window by 0.01 s, or 0.1 s with Shift", () => {
    near(stepSelection("in", 10, sel, "ArrowRight", false, 0.2)!, { in: 2.01, out: 6 })
    near(stepSelection("out", 10, sel, "ArrowLeft", true, 0.2)!, { in: 2, out: 5.9 })
    near(stepSelection("move", 10, sel, "ArrowRight", true, 0.2)!, { in: 2.1, out: 6.1 })
  })

  it("jumps to the limits with Home and End", () => {
    near(stepSelection("in", 10, sel, "Home", false, 0.2)!, { in: 0, out: 6 })
    near(stepSelection("in", 10, sel, "End", false, 0.2)!, { in: 5.8, out: 6 })
    near(stepSelection("out", 10, sel, "Home", false, 0.2)!, { in: 2, out: 2.2 })
    near(stepSelection("out", 10, sel, "End", false, 0.2)!, { in: 2, out: 10 })
    near(stepSelection("move", 10, sel, "Home", false, 0.2)!, { in: 0, out: 4 })
    near(stepSelection("move", 10, sel, "End", false, 0.2)!, { in: 6, out: 10 })
  })

  it("lands on whole hundredths after many steps (no float drift into the project)", () => {
    let s = { in: 7, out: 9 }
    for (let i = 0; i < 10; i++) s = stepSelection("move", 10, s, "ArrowLeft", true, 0.2)!
    expect(s).toEqual({ in: 6, out: 8 })
  })

  it("clamps a step at the ends and ignores other keys", () => {
    near(stepSelection("out", 10, { in: 2, out: 9.99 }, "ArrowRight", true, 0.2)!, { in: 2, out: 10 })
    expect(stepSelection("in", 10, sel, "Enter", false, 0.2)).toBeNull()
  })
})

describe("sourceTicks", () => {
  it("picks a round step that leaves room for labels, inside the source", () => {
    expect(sourceTicks(10, 400, 70)).toEqual([2, 4, 6, 8])
    expect(sourceTicks(60, 600, 70)).toEqual([10, 20, 30, 40, 50])
  })

  it("leaves out a tick too close to the end to label", () => {
    // Step 2 on 9 s: 8 is 1 s (44 px) from the end label.
    expect(sourceTicks(9, 400, 70)).toEqual([2, 4, 6])
  })

  it("is empty for an empty strip", () => {
    expect(sourceTicks(0, 400)).toEqual([])
    expect(sourceTicks(10, 0)).toEqual([])
  })
})
