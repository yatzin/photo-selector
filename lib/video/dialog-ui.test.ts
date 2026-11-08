import { describe, expect, it } from "vitest"
import { dbText, gridMove, isGridKey, lengthSummary, levelsSummary, matchesQuery, scrubValue, secondsText, trimSummary } from "./dialog-ui"

describe("gridMove", () => {
  // Two groups: 5 items then 3, 3 columns:
  // row 0: 0 1 2 / row 1: 3 4 / row 2: 5 6 7
  const groups = [5, 3]

  it("steps left and right, wrapping at the ends", () => {
    expect(gridMove(groups, 3, 0, "ArrowRight")).toBe(1)
    expect(gridMove(groups, 3, 4, "ArrowRight")).toBe(5)
    expect(gridMove(groups, 3, 7, "ArrowRight")).toBe(0)
    expect(gridMove(groups, 3, 0, "ArrowLeft")).toBe(7)
  })

  it("moves up and down a row in the same column, rows restarting in each group", () => {
    expect(gridMove(groups, 3, 1, "ArrowDown")).toBe(4)
    expect(gridMove(groups, 3, 4, "ArrowDown")).toBe(6)
    expect(gridMove(groups, 3, 6, "ArrowUp")).toBe(4)
    expect(gridMove(groups, 3, 3, "ArrowUp")).toBe(0)
  })

  it("lands on the nearest item of a shorter row", () => {
    expect(gridMove(groups, 3, 2, "ArrowDown")).toBe(4)
    expect(gridMove(groups, 3, 7, "ArrowUp")).toBe(4)
  })

  it("stays put at the top and bottom rows", () => {
    expect(gridMove(groups, 3, 1, "ArrowUp")).toBe(1)
    expect(gridMove(groups, 3, 6, "ArrowDown")).toBe(6)
  })

  it("goes to the ends with Home and End, and between groups with PageUp and PageDown", () => {
    expect(gridMove(groups, 3, 4, "Home")).toBe(0)
    expect(gridMove(groups, 3, 1, "End")).toBe(7)
    expect(gridMove(groups, 3, 2, "PageDown")).toBe(5)
    expect(gridMove(groups, 3, 7, "PageUp")).toBe(0)
    expect(gridMove(groups, 3, 6, "PageDown")).toBe(6)
    expect(gridMove(groups, 3, 3, "PageUp")).toBe(0)
  })

  it("skips empty groups and works as a single column", () => {
    expect(gridMove([2, 0, 2], 4, 0, "PageDown")).toBe(2)
    expect(gridMove([4], 1, 1, "ArrowDown")).toBe(2)
    expect(gridMove([4], 1, 3, "ArrowDown")).toBe(3)
  })

  it("is null for other keys, an empty grid or an index outside it", () => {
    expect(gridMove(groups, 3, 0, "a")).toBeNull()
    expect(gridMove([], 3, 0, "ArrowRight")).toBeNull()
    expect(gridMove(groups, 3, 8, "ArrowRight")).toBeNull()
    expect(isGridKey("Enter")).toBe(false)
    expect(isGridKey("PageDown")).toBe(true)
  })
})

describe("matchesQuery", () => {
  it("finds every word anywhere, ignoring case and accents", () => {
    expect(matchesQuery("Slide from left", "slide left")).toBe(true)
    expect(matchesQuery("Crème Brûlée", "creme")).toBe(true)
    expect(matchesQuery("Dip to black", "white")).toBe(false)
  })

  it("matches everything for a blank query", () => {
    expect(matchesQuery("Fade", "  ")).toBe(true)
  })
})

describe("scrubValue", () => {
  it("moves one step per 4 px by default, a tenth with fine", () => {
    expect(scrubValue(1, 8, { step: 0.1 })).toBe(1.2)
    expect(scrubValue(1, -12, { step: 0.1 })).toBe(0.7)
    expect(scrubValue(1, 8, { step: 0.1, fine: true })).toBe(1.02)
  })

  it("keeps within min and max and rounds to the step", () => {
    expect(scrubValue(0, 400, { step: 0.5, max: 24 })).toBe(24)
    expect(scrubValue(0.2, -40, { step: 0.1, min: 0.2 })).toBe(0.2)
    expect(scrubValue(0, 12, { step: 0.5, pxPerStep: 6 })).toBe(1)
  })

  it("ignores a part step of drag", () => {
    expect(scrubValue(2, 3, { step: 1 })).toBe(2)
    expect(scrubValue(2, -3, { step: 1 })).toBe(2)
  })
})

describe("summaries", () => {
  it("writes seconds and dB", () => {
    expect(secondsText(0.4)).toBe("0.4 s")
    expect(secondsText(1.256)).toBe("1.26 s")
    expect(dbText(3)).toBe("+3 dB")
    expect(dbText(-6.5)).toBe("−6.5 dB")
    expect(dbText(0)).toBe("0 dB")
  })

  it("says what a cut trims and how far later clips move", () => {
    const names = { outgoing: "Beach.mp4", incoming: "Sunset.mp4" }
    expect(trimSummary({ outgoing: 0.4, incoming: 0, ripple: 0.4 }, names, true)).toBe("Trims 0.4 s from the end of Beach.mp4; later clips move 0.4 s earlier")
    expect(trimSummary({ outgoing: 0.3, incoming: 0.2, ripple: 0.5 }, names, false)).toBe("Trims 0.3 s from the end of Beach.mp4 and 0.2 s from the start of Sunset.mp4")
    expect(trimSummary({ outgoing: 0, incoming: 0, ripple: 0 }, names, true)).toBeNull()
  })

  it("says what a new length does", () => {
    expect(lengthSummary({ start: 1, length: 2.4 }, { start: 1, length: 3.2 })).toBe("3.2 s long (+0.8 s)")
    expect(lengthSummary({ start: 1, length: 2 }, { start: 1.5, length: 1.5 })).toBe("1.5 s long (−0.5 s), starts at 1.5 s")
    expect(lengthSummary({ start: 1, length: 2 }, { start: 2, length: 2 })).toBe("Starts at 2 s")
    expect(lengthSummary({ start: 1, length: 2 }, { start: 1.001, length: 2.002 })).toBeNull()
  })

  it("says what audio levels set", () => {
    expect(levelsSummary(0, 0)).toBe("As recorded")
    expect(levelsSummary(-3, 2)).toBe("−3 dB, 2 effects")
    expect(levelsSummary(0, 1)).toBe("1 effect")
    expect(levelsSummary(4.5, 0)).toBe("+4.5 dB")
  })
})
