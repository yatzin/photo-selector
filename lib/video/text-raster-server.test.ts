import fs from "fs"
import os from "os"
import path from "path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fontById, FONTS, lineWidth } from "./fonts"
import { textLayout, type ClipText } from "./text"
import { rasteriseText, textFontPath } from "./text-raster-server"

const FFMPEG = path.resolve(".data/ffmpeg.exe")
const canRun = fs.existsSync(FFMPEG)

if (!canRun) console.warn(`Text rasteriser tests skipped: need ${FFMPEG}`)

describe("textFontPath", () => {
  it("names the bundled font, which ships with the app", () => {
    expect(textFontPath().endsWith(path.join("public", "fonts", "GeistMono-Bold.ttf"))).toBe(true)
    expect(fs.existsSync(textFontPath())).toBe(true)
  })

  it("names each font's own file", () => {
    expect(textFontPath("pacifico").endsWith(path.join("public", "fonts", "Pacifico-Regular.ttf"))).toBe(true)
    expect(textFontPath("press-start")).not.toBe(textFontPath("pacifico"))
    expect(fs.existsSync(textFontPath("press-start"))).toBe(true)
  })
})

;(canRun ? describe : describe.skip)(canRun ? "rasteriseText with real ffmpeg" : "rasteriseText with real ffmpeg (SKIPPED: .data/ffmpeg.exe not found)", () => {
  const dir = path.join(os.tmpdir(), `ps-text-${process.pid}-${Date.now()}`)
  beforeAll(() => {
    process.env.FFMPEG_PATH = FFMPEG
    fs.mkdirSync(dir, { recursive: true })
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  /** Its size, how many pixels are see-through and how many are fully opaque, and the opaque ones' mean color. */
  async function read(file: string) {
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let clear = 0
    let solid = 0
    const sum = [0, 0, 0]
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) clear++
      if (data[i + 3] === 255) {
        solid++
        for (let k = 0; k < 3; k++) sum[k] += data[i + k]
      }
    }
    return { w: info.width, h: info.height, clear, solid, color: sum.map((v) => v / Math.max(1, solid)), data }
  }

  it("draws horizontal text in its color on a transparent PNG the size of its content box", async () => {
    const text: ClipText = { content: "Hello\nab", color: "#ff8800", orientation: "horizontal" }
    const out = path.join(dir, "h.png")
    await rasteriseText(text, 100, out, dir)
    const r = await read(out)
    const box = textLayout(text, 100)
    expect([r.w, r.h]).toEqual([Math.ceil(box.w), Math.ceil(box.h)])
    expect(r.solid).toBeGreaterThan(1000)
    expect(r.clear).toBeGreaterThan(r.w * r.h * 0.5)
    expect(r.color[0]).toBeGreaterThan(240)
    expect(Math.abs(r.color[1] - 136)).toBeLessThan(10)
    expect(r.color[2]).toBeLessThan(15)
    // The padding is clear all round; the work folder is gone.
    for (let x = 0; x < r.w; x++) expect(r.data[x * 4 + 3]).toBe(0)
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("text-"))).toEqual([])
  }, 30_000)

  it("draws a shadow: pixels of the shadow color appear down and right of the letters", async () => {
    const text: ClipText = { content: "I", color: "#ffffff", orientation: "horizontal", shadow: { color: "#ff0000", angle: 45, distance: 10 } }
    const out = path.join(dir, "s.png")
    await rasteriseText(text, 100, out, dir)
    const r = await read(out)
    let red = 0
    for (let i = 0; i < r.data.length; i += 4) if (r.data[i + 3] > 200 && r.data[i] > 200 && r.data[i + 1] < 60) red++
    expect(red).toBeGreaterThan(50)
  }, 30_000)

  it("stacks vertical text: taller than wide for a multi-character string", async () => {
    const out = path.join(dir, "v.png")
    await rasteriseText({ content: "Wow it", color: "#ffffff", orientation: "vertical" }, 40, out, dir)
    const r = await read(out)
    expect(r.h).toBeGreaterThan(r.w * 3)
    expect(r.solid).toBeGreaterThan(100)
  }, 30_000)

  /** The opaque-ish (alpha over half) pixels' bounding box. */
  function ink(r: Awaited<ReturnType<typeof read>>) {
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        if (r.data[(y * r.w + x) * 4 + 3] <= 127) continue
        left = Math.min(left, x)
        right = Math.max(right, x + 1)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y + 1)
      }
    }
    return { left, right, top, bottom }
  }

  it("draws a proportional font in its own box: centred across it, on the layout's baseline, inside the padding", async () => {
    // "Hello" in Pacifico, a script font: no descenders, so the ink ends at the baseline.
    const text: ClipText = { content: "Hello", color: "#ffffff", orientation: "horizontal", font: "pacifico" }
    const out = path.join(dir, "p.png")
    await rasteriseText(text, 100, out, dir)
    const r = await read(out)
    const box = textLayout(text, 100)
    expect([r.w, r.h]).toEqual([Math.ceil(box.w - 1e-6), Math.ceil(box.h - 1e-6)])
    const i = ink(r)
    expect(Math.abs((i.left + i.right) / 2 - box.w / 2)).toBeLessThan(4)
    expect(Math.abs(i.bottom - box.lines[0].baseline)).toBeLessThan(3)
    expect(i.left).toBeGreaterThan(0)
    expect(i.right).toBeLessThan(r.w)
    expect(i.top).toBeGreaterThan(0)
  }, 30_000)

  it("draws a pixel font at its advances: Press Start 2P's 1 em letters fill the box less its padding", async () => {
    const text: ClipText = { content: "GAME", color: "#ffffff", orientation: "horizontal", font: "press-start" }
    const out = path.join(dir, "ps.png")
    await rasteriseText(text, 100, out, dir)
    const r = await read(out)
    const i = ink(r)
    const pad = fontById("press-start").pad * 100
    // Four 100 px cells; the last letter's ink stops short of its cell's right edge.
    expect(i.left).toBeGreaterThanOrEqual(pad - 1)
    expect(i.left).toBeLessThanOrEqual(pad + 1)
    expect(i.right).toBeGreaterThan(pad + 350)
    expect(i.right).toBeLessThanOrEqual(r.w - pad + 1)
    // Its capitals stand one pixel of its 8 x 8 grid (an eighth of the font size) above the baseline.
    expect(Math.abs(i.bottom - (textLayout(text, 100).lines[0].baseline - 12.5))).toBeLessThan(2)
  }, 30_000)

  it("draws the same text differently in different fonts", async () => {
    const a = path.join(dir, "fa.png")
    const b = path.join(dir, "fb.png")
    await rasteriseText({ content: "Boo", color: "#ffffff", orientation: "horizontal", font: "anton" }, 40, a, dir)
    await rasteriseText({ content: "Boo", color: "#ffffff", orientation: "horizontal", font: "creepster" }, 40, b, dir)
    const [ra, rb] = [await read(a), await read(b)]
    expect([ra.w, ra.h]).not.toEqual([rb.w, rb.h])
    expect(ra.solid).toBeGreaterThan(50)
    expect(rb.solid).toBeGreaterThan(50)
  }, 30_000)

  // Ink on the PNG's outermost pixels was cut by its edge; a swash may come within a pixel or two of it (the pad is its reach rounded up to a twentieth).
  const MIN_MARGIN = 0
  /** The least distance (px) from any drawn pixel to the PNG's edge. */
  const margin = (r: Awaited<ReturnType<typeof read>>) => {
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        if (!r.data[(y * r.w + x) * 4 + 3]) continue
        left = Math.min(left, x)
        right = Math.max(right, x + 1)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y + 1)
      }
    }
    return Math.min(left, top, r.w - right, r.h - bottom)
  }

  it("keeps the swashes of elegant scripts and a blackletter's and horror font's ink inside the box", async () => {
    for (const font of ["monsieur-la-doulaise", "great-vibes", "unifraktur-maguntia", "eater"]) {
      const text: ClipText = { content: "jJY Quiz &\nJoy Fizz! QfNKT", color: "#ffffff", orientation: "horizontal", font }
      const out = path.join(dir, `e-${font}.png`)
      await rasteriseText(text, 100, out, dir)
      const r = await read(out)
      const box = textLayout(text, 100)
      expect([r.w, r.h], font).toEqual([Math.ceil(box.w - 1e-6), Math.ceil(box.h - 1e-6)])
      expect(r.solid, font).toBeGreaterThan(2000)
      expect(margin(r), font).toBeGreaterThan(MIN_MARGIN)
    }
  }, 60_000)

  it("draws a script's swashes past the line's advances, as the preview does (drawtext alone cuts them there)", async () => {
    // Great Vibes' j reaches 0.4 of the font size left of its advance, its T 0.48 right; Monsieur La Doulaise's further.
    for (const font of ["great-vibes", "monsieur-la-doulaise"]) {
      const text: ClipText = { content: "jJY QfNKT", color: "#ffffff", orientation: "horizontal", font }
      const out = path.join(dir, `sw-${font}.png`)
      await rasteriseText(text, 100, out, dir)
      const r = await read(out)
      const half = (lineWidth(fontById(font), text.content) * 100) / 2
      const i = ink(r)
      expect(i.left, font).toBeLessThan(r.w / 2 - half - 30)
      expect(i.right, font).toBeGreaterThan(r.w / 2 + half + 30)
    }
  }, 60_000)

  it("draws every font inside the box the layout gives it, the PNG exactly that box", async () => {
    // Capitals and descenders at both ends of the line, where scripts' swashes reach furthest past the advances.
    const results = await Promise.all(FONTS.map(async (f) => {
      const text: ClipText = { content: "jJY Joy & Fizz! QgfNKT", color: "#ffffff", orientation: "horizontal", font: f.id }
      const out = path.join(dir, `all-${f.id}.png`)
      await rasteriseText(text, 60, out, dir)
      const r = await read(out)
      const box = textLayout(text, 60)
      return { id: f.id, size: [r.w, r.h], box: [Math.ceil(box.w - 1e-6), Math.ceil(box.h - 1e-6)], solid: r.solid, margin: margin(r) }
    }))
    for (const r of results) {
      expect(r.size, r.id).toEqual(r.box)
      expect(r.solid, r.id).toBeGreaterThan(200)
      expect(r.margin, r.id).toBeGreaterThan(MIN_MARGIN)
    }
  }, 120_000)

  it("draws text as it is: no %{...} expansion, quotes and colons are fine", async () => {
    const out = path.join(dir, "s.png")
    await rasteriseText({ content: "%{pts} 'a:b' \\ ;,[x]", color: "#00ff00", orientation: "horizontal" }, 40, out, dir)
    const r = await read(out)
    expect(r.solid).toBeGreaterThan(100)
  }, 30_000)
})
