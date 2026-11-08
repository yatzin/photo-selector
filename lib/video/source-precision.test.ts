import { describe, expect, it } from "vitest"
import {
  formatClock, formatSeconds, keepPlaying, loopTick, parseTime, playheadEdge, roundMs, seekInSelection, selectionOffset, stepSize, stepTime, typedEdge,
} from "./source-precision"

describe("parseTime", () => {
  it("reads m:ss.mmm", () => {
    expect(parseTime("1:02.350")).toBeCloseTo(62.35, 9)
    expect(parseTime("0:05")).toBe(5)
    expect(parseTime(" 2:00.5 ")).toBeCloseTo(120.5, 9)
  })

  it("reads plain seconds", () => {
    expect(parseTime("62.35")).toBeCloseTo(62.35, 9)
    expect(parseTime("3")).toBe(3)
    expect(parseTime(".5")).toBe(0.5)
  })

  it("is null for anything else", () => {
    for (const bad of ["", "  ", "abc", "1:", ":30", "1:60", "1:2:3", "-1", "1e3", "1:-2", "Infinity", "0x10"]) expect(parseTime(bad)).toBeNull()
  })
})

describe("formatting", () => {
  it("shows field seconds with 3 decimals and the readout as m:ss.hh", () => {
    expect(formatSeconds(1.0300001575)).toBe("1.030")
    expect(formatSeconds(62.35)).toBe("62.350")
    expect(formatClock(2.4)).toBe("0:02.40")
    expect(formatClock(65.004)).toBe("1:05.00")
    expect(formatClock(-1)).toBe("0:00.00")
  })
})

describe("stepping", () => {
  it("steps 0.01, 0.1 with Shift, 0.001 with Alt", () => {
    expect(stepSize({})).toBe(0.01)
    expect(stepSize({ shift: true })).toBe(0.1)
    expect(stepSize({ alt: true })).toBe(0.001)
  })

  it("lands on whole milliseconds", () => {
    expect(stepTime(1.0300001575, 1, {})).toBe(1.04)
    expect(stepTime(1.03, -1, { shift: true })).toBe(0.93)
    expect(stepTime(0.1, 1, { alt: true })).toBe(0.101)
  })
})

describe("roundMs", () => {
  it("rounds to whole milliseconds", () => {
    expect(roundMs(1.0300001575)).toBe(1.03)
    expect(roundMs(2.0004999)).toBe(2)
    expect(roundMs(2.0005)).toBe(2.001)
  })
})

describe("typedEdge", () => {
  const sel = { in: 1, out: 5 }

  it("takes a value inside the limits", () => {
    expect(typedEdge(sel, "in", 2.5, 10, 0.2)).toEqual({ ok: true, selection: { in: 2.5, out: 5 } })
    expect(typedEdge(sel, "out", 9, 10, 0.2)).toEqual({ ok: true, selection: { in: 1, out: 9 } })
  })

  it("refuses with a message and the clamped value outside them (minimum length, 0 and the file's end)", () => {
    const late = typedEdge(sel, "in", 4.9, 10, 0.2)
    expect(late.ok).toBe(false)
    expect(late.selection.in).toBeCloseTo(4.8, 9)
    expect(late.message).toMatch(/0\.2 s/)
    const neg = typedEdge(sel, "in", -1, 10, 0.2)
    expect(neg).toMatchObject({ ok: false, selection: { in: 0, out: 5 } })
    const long = typedEdge(sel, "out", 12, 10, 0.2)
    expect(long).toMatchObject({ ok: false, selection: { in: 1, out: 10 } })
    expect(long.message).toMatch(/10\.000/)
    const short = typedEdge(sel, "out", 1.1, 10, 0.2)
    expect(short.ok).toBe(false)
    expect(short.selection.out).toBeCloseTo(1.2, 9)
  })
})

describe("preview loop maths", () => {
  const sel = { in: 2, out: 4 }

  it("gives the position inside the selection", () => {
    expect(selectionOffset(3, sel)).toBe(1)
    expect(selectionOffset(1, sel)).toBe(0)
    expect(selectionOffset(9, sel)).toBe(2)
  })

  it("seeks inside the selection, never at or past out", () => {
    expect(seekInSelection(sel, 0.5)).toBe(2.5)
    expect(seekInSelection(sel, -1)).toBe(2)
    expect(seekInSelection(sel, 5)).toBeLessThan(4)
    expect(seekInSelection(sel, 5)).toBeGreaterThan(3.9)
  })

  it("restarts at out with loop on, stops there with it off, and pulls a stray time back to in", () => {
    expect(loopTick(3, sel, true)).toBe("play")
    expect(loopTick(3.99, sel, true)).toBe("restart")
    expect(loopTick(4.2, sel, false)).toBe("stop")
    expect(loopTick(1, sel, true)).toBe("restart")
  })

  it("keeps playing where it is when the new selection still holds it, else starts again at in", () => {
    expect(keepPlaying(3, { in: 2.5, out: 5 })).toBe(3)
    expect(keepPlaying(3, { in: 3.5, out: 5 })).toBe(3.5)
    expect(keepPlaying(3, { in: 1, out: 2.9 })).toBe(1)
  })
})

describe("playheadEdge", () => {
  const sel = { in: 2, out: 6 }

  it("sets in or out at the playhead, to the millisecond", () => {
    expect(playheadEdge(sel, "in", 3.0300001, 10, 0.2)).toEqual({ in: 3.03, out: 6 })
    expect(playheadEdge(sel, "out", 4.5004, 10, 0.2)).toEqual({ in: 2, out: 4.5 })
  })

  it("keeps the minimum length", () => {
    expect(playheadEdge(sel, "in", 5.95, 10, 0.2).in).toBeCloseTo(5.8, 9)
    expect(playheadEdge(sel, "out", 2.05, 10, 0.2).out).toBeCloseTo(2.2, 9)
  })
})
