import fs from "fs"
import path from "path"
import { describe, expect, it } from "vitest"
import { CHARSET, DEFAULT_FONT, fontById, fontFamily, FONTS, isFontId, lineWidth } from "./fonts"

const FONT_DIR = path.resolve("public/fonts")

/** What the registry needs from a TrueType file: units per em, hhea ascender/descender, each code point's glyph, advance and ink box. */
function readTtf(file: string) {
  const b = fs.readFileSync(file)
  const t: Record<string, number> = {}
  for (let i = 0; i < b.readUInt16BE(4); i++) t[b.toString("latin1", 12 + i * 16, 16 + i * 16)] = b.readUInt32BE(20 + i * 16)
  const upm = b.readUInt16BE(t.head + 18)
  const longLoca = b.readInt16BE(t.head + 50) === 1
  const nH = b.readUInt16BE(t.hhea + 34)
  let cmap4 = 0
  for (let i = 0; i < b.readUInt16BE(t.cmap + 2); i++) {
    const pid = b.readUInt16BE(t.cmap + 4 + i * 8)
    const eid = b.readUInt16BE(t.cmap + 6 + i * 8)
    const off = t.cmap + b.readUInt32BE(t.cmap + 8 + i * 8)
    if (b.readUInt16BE(off) === 4 && (pid === 0 || (pid === 3 && eid === 1)) && !cmap4) cmap4 = off
  }
  const glyph = (cp: number) => {
    const n = b.readUInt16BE(cmap4 + 6) / 2
    const ends = cmap4 + 14
    const starts = ends + 2 * n + 2
    for (let i = 0; i < n; i++) {
      if (cp > b.readUInt16BE(ends + 2 * i)) continue
      const start = b.readUInt16BE(starts + 2 * i)
      if (cp < start) return 0
      const delta = b.readInt16BE(starts + 2 * n + 2 * i)
      const ro = starts + 4 * n + 2 * i
      if (b.readUInt16BE(ro) === 0) return (cp + delta) & 0xffff
      const g = b.readUInt16BE(ro + b.readUInt16BE(ro) + 2 * (cp - start))
      return g === 0 ? 0 : (g + delta) & 0xffff
    }
    return 0
  }
  const advance = (g: number) => b.readUInt16BE(t.hmtx + 4 * Math.min(g, nH - 1))
  const loca = (g: number) => (longLoca ? b.readUInt32BE(t.loca + 4 * g) : 2 * b.readUInt16BE(t.loca + 2 * g))
  const ink = (g: number) => {
    if (loca(g + 1) <= loca(g)) return null
    const o = t.glyf + loca(g)
    return { xMin: b.readInt16BE(o + 2), yMin: b.readInt16BE(o + 4), xMax: b.readInt16BE(o + 6), yMax: b.readInt16BE(o + 8) }
  }
  return { upm, ascender: b.readInt16BE(t.hhea + 4), descender: b.readInt16BE(t.hhea + 6), glyph, advance, ink }
}

const ceil20 = (v: number) => Math.ceil(v * 20 - 1e-9) / 20

describe("the font registry", () => {
  it("has unique ids and names, Mono first and the default, about a dozen fonts", () => {
    expect(new Set(FONTS.map((f) => f.id)).size).toBe(FONTS.length)
    expect(new Set(FONTS.map((f) => f.name)).size).toBe(FONTS.length)
    expect(new Set(FONTS.map((f) => fontFamily(f))).size).toBe(FONTS.length)
    expect(FONTS[0].id).toBe(DEFAULT_FONT)
    expect(FONTS[0].name).toBe("Mono")
    expect(FONTS.length).toBeGreaterThanOrEqual(12)
    for (const f of FONTS) expect(f.id).toMatch(/^[a-z0-9-]+$/)
  })

  it("ships every font file and its licence text (OFL or Apache), under about 3 MB in all", () => {
    let bytes = 0
    for (const f of FONTS) {
      const file = path.join(FONT_DIR, f.file)
      expect(fs.existsSync(file), f.file).toBe(true)
      expect(f.file).toMatch(/\.ttf$/)
      bytes += fs.statSync(file).size
      const licence = fs.readFileSync(path.join(FONT_DIR, f.licenceFile), "utf8")
      expect(licence).toContain(f.licence === "OFL-1.1" ? "SIL OPEN FONT LICENSE Version 1.1" : "Apache License")
    }
    expect(bytes).toBeLessThan(3 * 1024 * 1024)
  })

  it("declares an @font-face for each font in globals.css, its family and file", () => {
    const css = fs.readFileSync(path.resolve("app/globals.css"), "utf8").replace(/\r\n/g, "\n")
    for (const f of FONTS) {
      expect(css).toContain(`font-family: "${fontFamily(f)}";\n  src: url("/fonts/${f.file}") format("truetype");`)
    }
  })

  it("has a glyph for every printable ASCII character in every font", () => {
    for (const f of FONTS) {
      const ttf = readTtf(path.join(FONT_DIR, f.file))
      const missing = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).filter((ch) => ttf.glyph(ch.charCodeAt(0)) === 0)
      expect(missing, f.name).toEqual([])
    }
  })

  it("matches each font file: advances, units per em and the line metrics derived from it", () => {
    for (const f of FONTS) {
      const ttf = readTtf(path.join(FONT_DIR, f.file))
      expect(f.upm, f.name).toBe(ttf.upm)
      expect(f.advances.length, f.name).toBe(Array.from(CHARSET).length)
      let yMax = ttf.ascender
      let yMin = ttf.descender
      let over = 0
      Array.from(CHARSET).forEach((ch, i) => {
        const g = ttf.glyph(ch.codePointAt(0)!)
        expect(f.advances[i], `${f.name} ${ch}`).toBe(ttf.advance(g))
        const box = g ? ttf.ink(g) : null
        if (!box) return
        yMax = Math.max(yMax, box.yMax)
        yMin = Math.min(yMin, box.yMin)
        over = Math.max(over, -box.xMin, box.xMax - ttf.advance(g))
      })
      const tall = (yMax - yMin) / ttf.upm
      expect(f.line, f.name).toBe(Math.max(1.2, ceil20(tall)))
      expect(f.ascent, f.name).toBeCloseTo(yMax / ttf.upm + (f.line - tall) / 2, 3)
      expect(f.pad, f.name).toBe(Math.max(0.25, ceil20(over / ttf.upm)))
      const letters = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz").map((ch) => ttf.advance(ttf.glyph(ch.charCodeAt(0))))
      expect(f.other, f.name).toBe(Math.round(letters.reduce((a, v) => a + v, 0) / letters.length))
      // Line and padding in twentieths, so a box at a multiple of 20 px is whole pixels.
      expect(Number.isInteger(Math.round(f.line * 20 * 1e6) / 1e6)).toBe(true)
      expect(Number.isInteger(Math.round(f.pad * 20 * 1e6) / 1e6)).toBe(true)
    }
  })

  it("keeps Mono's metrics as text clips always had them", () => {
    const mono = fontById(DEFAULT_FONT)
    expect([mono.file, mono.ascent, mono.line, mono.pad, mono.other / mono.upm]).toEqual(["GeistMono-Bold.ttf", 1.005, 1.3, 0.25, 0.6])
    expect(fontFamily(mono)).toBe("PS Video Text")
  })
})

describe("isFontId, fontById and lineWidth", () => {
  it("knows the registry's ids only", () => {
    expect(isFontId("pacifico")).toBe(true)
    for (const bad of ["Pacifico", "comic-sans", "", undefined, null, 3]) expect(isFontId(bad)).toBe(false)
  })

  it("falls back to Mono for no font or an unknown one", () => {
    expect(fontById(undefined).id).toBe("mono")
    expect(fontById("nope").id).toBe("mono")
    expect(fontById("anton").name).toBe("Anton")
  })

  it("adds up advances, in font sizes, using `other` outside CHARSET", () => {
    const f = fontById("pacifico")
    const adv = (ch: string) => f.advances[CHARSET.indexOf(ch)]
    expect(lineWidth(f, "Hi!")).toBeCloseTo((adv("H") + adv("i") + adv("!")) / f.upm, 12)
    expect(lineWidth(f, "a😀")).toBeCloseTo((adv("a") + f.other) / f.upm, 12)
    expect(lineWidth(f, "")).toBe(0)
    expect(lineWidth(fontById("mono"), "Hello")).toBeCloseTo(3, 12)
  })
})
