import { describe, expect, it } from "vitest"
import { DEFAULT_TEXT, isValidText, MAX_TEXT, normalizeText, sameText, textLayout, textLines, textSize } from "./text"

describe("isValidText and normalizeText", () => {
  it("accepts 1 to MAX_TEXT characters, a #rrggbb colour and an orientation", () => {
    expect(isValidText(DEFAULT_TEXT)).toBe(true)
    expect(isValidText({ content: "x".repeat(MAX_TEXT), color: "#A0b1C2", orientation: "vertical" })).toBe(true)
  })

  it("refuses empty or blank content, too long content, a bad colour or orientation", () => {
    for (const bad of [
      null, "Text", [], {},
      { ...DEFAULT_TEXT, content: "" }, { ...DEFAULT_TEXT, content: "  \n\t" }, { ...DEFAULT_TEXT, content: "x".repeat(MAX_TEXT + 1) }, { ...DEFAULT_TEXT, content: 5 },
      { ...DEFAULT_TEXT, color: "white" }, { ...DEFAULT_TEXT, color: "#fff" }, { ...DEFAULT_TEXT, color: "#ffffffff" }, { ...DEFAULT_TEXT, color: "#gggggg" },
      { ...DEFAULT_TEXT, orientation: "diagonal" }, { content: "a", color: "#ffffff" },
    ]) {
      expect(isValidText(bad)).toBe(false)
      expect(normalizeText(bad)).toBeNull()
    }
  })

  it("keeps only the text's fields, lower-cases the colour and turns CRLF into LF", () => {
    expect(normalizeText({ content: "a\r\nb\rc", color: "#ABCDEF", orientation: "horizontal", extra: 1 })).toEqual({ content: "a\nb\nc", color: "#abcdef", orientation: "horizontal" })
  })

  it("compares texts field by field", () => {
    expect(sameText(DEFAULT_TEXT, { ...DEFAULT_TEXT })).toBe(true)
    expect(sameText(DEFAULT_TEXT, { ...DEFAULT_TEXT, orientation: "vertical" })).toBe(false)
    expect(sameText(undefined, DEFAULT_TEXT)).toBe(false)
  })
})

describe("textLines", () => {
  it("breaks horizontal text at newlines only", () => {
    expect(textLines({ content: "Hello world\nsecond line", orientation: "horizontal" })).toEqual(["Hello world", "second line"])
  })

  it("stacks vertical text one character a line, a space or newline leaving a blank line", () => {
    expect(textLines({ content: "Hi yo\nX", orientation: "vertical" })).toEqual(["H", "i", "", "y", "o", "", "X"])
  })

  it("counts a character outside the BMP as one", () => {
    expect(textLines({ content: "a😀", orientation: "vertical" })).toEqual(["a", "😀"])
  })
})

describe("textLayout and textSize", () => {
  it("sizes the box from the longest line and the line count (monospaced, padded)", () => {
    // 5 columns x 0.6 + 0.5 padding = 3.5 font sizes wide; 2 lines x 1.3 + 0.5 = 3.1 tall.
    const l = textLayout({ content: "Hello\nab", orientation: "horizontal" }, 100)
    expect(l.w).toBeCloseTo(350, 9)
    expect(l.h).toBeCloseTo(310, 9)
    expect(l.lines.map((x) => x.text)).toEqual(["Hello", "ab"])
    // Every line centred across the box; baselines 1.3 apart, the first at the padding plus the ascent.
    expect(l.lines.map((x) => x.cx)).toEqual([175, 175])
    expect(l.lines[0].baseline).toBeCloseTo(25 + 100.5, 9)
    expect(l.lines[1].baseline).toBeCloseTo(25 + 130 + 100.5, 9)
  })

  it("makes vertical text taller than wide for several characters", () => {
    const h = textLayout({ content: "Title", orientation: "horizontal" }, 100)
    const v = textLayout({ content: "Title", orientation: "vertical" }, 100)
    expect(h.w).toBeGreaterThan(h.h)
    expect(v.h).toBeGreaterThan(v.w)
    expect(v.w).toBeCloseTo(110, 9)
    expect(v.h).toBeCloseTo(5 * 130 + 50, 9)
  })

  it("scales with the font size: twice the font, twice the box and the positions", () => {
    const a = textLayout({ content: "ab\ncde", orientation: "horizontal" }, 50)
    const b = textLayout({ content: "ab\ncde", orientation: "horizontal" }, 100)
    expect(b.w).toBeCloseTo(2 * a.w, 9)
    expect(b.h).toBeCloseTo(2 * a.h, 9)
    b.lines.forEach((line, i) => expect(line.baseline).toBeCloseTo(2 * a.lines[i].baseline, 9))
  })

  it("bases the natural size on a tenth of the canvas height", () => {
    const s = textSize(DEFAULT_TEXT, 1080)
    expect(s.w).toBeCloseTo(4 * 0.6 * 108 + 0.5 * 108, 9)
    expect(s.h).toBeCloseTo(1.3 * 108 + 0.5 * 108, 9)
  })
})
