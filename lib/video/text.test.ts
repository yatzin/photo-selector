import { describe, expect, it } from "vitest"
import { fontById, FONTS, lineWidth } from "./fonts"
import { DEFAULT_TEXT, fitAnims, isValidAnim, isValidText, MAX_TEXT, MIN_ANIM, normalizeText, sameText, splitAnims, textLayout, textLines, textSize } from "./text"

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
    expect(sameText(DEFAULT_TEXT, { ...DEFAULT_TEXT, font: "anton" })).toBe(false)
    expect(sameText({ ...DEFAULT_TEXT, font: "anton" }, { ...DEFAULT_TEXT, font: "anton" })).toBe(true)
  })

  it("takes a font from the registry and refuses an unknown one", () => {
    expect(isValidText({ ...DEFAULT_TEXT, font: "pacifico" })).toBe(true)
    expect(normalizeText({ ...DEFAULT_TEXT, font: "pacifico" })).toEqual({ ...DEFAULT_TEXT, font: "pacifico" })
    for (const f of FONTS) expect(isValidText({ ...DEFAULT_TEXT, font: f.id }), f.id).toBe(true)
    expect(FONTS.length).toBe(50)
    for (const font of ["Pacifico", "comic-sans", "great vibes", "", 7, null]) {
      expect(isValidText({ ...DEFAULT_TEXT, font })).toBe(false)
      expect(normalizeText({ ...DEFAULT_TEXT, font })).toBeNull()
    }
  })

  it("leaves Mono, the default font, out, so a text in it is the text it always was", () => {
    expect(normalizeText({ ...DEFAULT_TEXT, font: "mono" })).toEqual(DEFAULT_TEXT)
    expect(normalizeText(DEFAULT_TEXT)).not.toHaveProperty("font")
    expect(sameText(DEFAULT_TEXT, { ...DEFAULT_TEXT, font: "mono" })).toBe(true)
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

describe("textLayout with a proportional font", () => {
  const pacifico = fontById("pacifico")

  it("sizes the box from the font's advances (longest line rounded up to a twentieth) and its line metrics", () => {
    const l = textLayout({ content: "Hi\nwow", orientation: "horizontal", font: "pacifico" }, 100)
    const longest = Math.max(lineWidth(pacifico, "Hi"), lineWidth(pacifico, "wow"))
    expect(l.w).toBeCloseTo((Math.ceil(longest * 20) / 20 + 2 * pacifico.pad) * 100, 9)
    expect(l.h).toBeCloseTo((2 * pacifico.line + 2 * pacifico.pad) * 100, 9)
    expect(l.lines.map((x) => x.cx)).toEqual([l.w / 2, l.w / 2])
    expect(l.lines[0].baseline).toBeCloseTo((pacifico.pad + pacifico.ascent) * 100, 9)
    expect(l.lines[1].baseline).toBeCloseTo((pacifico.pad + pacifico.line + pacifico.ascent) * 100, 9)
  })

  it("gives different fonts different boxes for the same text, and narrow letters a narrower box than wide ones", () => {
    const box = (font: string, content = "Boo!") => textLayout({ content, orientation: "horizontal", font }, 100)
    expect(box("press-start").w).toBeGreaterThan(box("anton").w)
    expect(box("anton", "iiii").w).toBeLessThan(box("anton", "WWWW").w)
  })

  it("is the same numbers every time, at every font size (preview and export use the one function)", () => {
    const text = { content: "Scary\nnight", orientation: "horizontal" as const, font: "creepster" }
    const a = textLayout(text, 20)
    const b = textLayout(text, 120)
    expect(b.w).toBeCloseTo(6 * a.w, 9)
    expect(b.h).toBeCloseTo(6 * a.h, 9)
    // A box at a multiple of 20 px is whole pixels (the export draws there).
    expect(a.w).toBeCloseTo(Math.round(a.w), 9)
    expect(a.h).toBeCloseTo(Math.round(a.h), 9)
  })

  it("stacks vertical text in the widest character's width", () => {
    const l = textLayout({ content: "Mi", orientation: "vertical", font: "playfair" }, 100)
    const playfair = fontById("playfair")
    expect(l.w).toBeCloseTo((Math.ceil(lineWidth(playfair, "M") * 20) / 20 + 2 * playfair.pad) * 100, 9)
    expect(l.h).toBeCloseTo((2 * playfair.line + 2 * playfair.pad) * 100, 9)
  })
})

describe("text animations", () => {
  const fade = (duration: number) => ({ type: "fade" as const, duration })

  it("accepts a known type with a duration from MIN_ANIM to 600 s", () => {
    expect(isValidAnim(fade(MIN_ANIM))).toBe(true)
    expect(isValidAnim({ type: "typewriter", duration: 600 })).toBe(true)
    for (const bad of [null, "fade", [], { type: "none", duration: 1 }, fade(0.09), fade(601), fade(NaN), { type: "fade", duration: "1" }]) expect(isValidAnim(bad)).toBe(false)
    expect(isValidText({ ...DEFAULT_TEXT, animIn: fade(1), animOut: { type: "slide-left", duration: 2 } })).toBe(true)
    expect(isValidText({ ...DEFAULT_TEXT, animOut: fade(0) })).toBe(false)
  })

  it("keeps only an animation's own fields and compares them", () => {
    expect(normalizeText({ ...DEFAULT_TEXT, animIn: { ...fade(1), extra: 2 } })).toEqual({ ...DEFAULT_TEXT, animIn: fade(1) })
    expect(sameText({ ...DEFAULT_TEXT, animIn: fade(1) }, { ...DEFAULT_TEXT, animIn: fade(1) })).toBe(true)
    expect(sameText({ ...DEFAULT_TEXT, animIn: fade(1) }, { ...DEFAULT_TEXT, animIn: fade(2) })).toBe(false)
    expect(sameText({ ...DEFAULT_TEXT, animIn: fade(1) }, { ...DEFAULT_TEXT, animOut: fade(1) })).toBe(false)
    expect(sameText(DEFAULT_TEXT, { ...DEFAULT_TEXT, animIn: { type: "pop", duration: 1 } })).toBe(false)
  })

  it("fits in and out into the clip: unchanged when they fit, else both shrink in proportion, never below MIN_ANIM", () => {
    const t = { ...DEFAULT_TEXT, animIn: fade(2), animOut: fade(1) }
    expect(fitAnims(t, 3)).toBe(t)
    expect(fitAnims(t, 1.5)).toEqual({ ...DEFAULT_TEXT, animIn: fade(1), animOut: fade(0.5) })
    expect(fitAnims({ ...DEFAULT_TEXT, animIn: fade(5), animOut: fade(0.2) }, 0.3)).toEqual({ ...DEFAULT_TEXT, animIn: fade(0.2), animOut: fade(0.1) })
    expect(fitAnims(t, 0.2)).toEqual({ ...DEFAULT_TEXT, animIn: fade(0.1), animOut: fade(0.1) })
    expect(fitAnims({ ...DEFAULT_TEXT, animOut: fade(4) }, 2.5)).toEqual({ ...DEFAULT_TEXT, animOut: fade(2.5) })
    expect(fitAnims(DEFAULT_TEXT, 0.2)).toBe(DEFAULT_TEXT)
    // Rounded down to milliseconds, so they add up to no more than the clip.
    const odd = fitAnims(t, 1)
    expect(odd.animIn!.duration + odd.animOut!.duration).toBeLessThanOrEqual(1)
    expect(odd.animIn!.duration).toBe(0.666)
  })

  it("splits: the first piece keeps the in animation, the second the out one", () => {
    const t = { ...DEFAULT_TEXT, animIn: fade(2), animOut: fade(1) }
    expect(splitAnims(t, 1, 4)).toEqual([{ ...DEFAULT_TEXT, animIn: fade(1) }, { ...DEFAULT_TEXT, animOut: fade(1) }])
  })
})