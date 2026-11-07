import fs from "fs"
import os from "os"
import path from "path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fontById } from "./fonts"
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

  /** Its size, how many pixels are see-through and how many are fully opaque, and the opaque ones' mean colour. */
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
    return { w: info.width, h: info.height, clear, solid, colour: sum.map((v) => v / Math.max(1, solid)), data }
  }

  it("draws horizontal text in its colour on a transparent PNG the size of its content box", async () => {
    const text: ClipText = { content: "Hello\nab", color: "#ff8800", orientation: "horizontal" }
    const out = path.join(dir, "h.png")
    await rasteriseText(text, 100, out, dir)
    const r = await read(out)
    const box = textLayout(text, 100)
    expect([r.w, r.h]).toEqual([Math.ceil(box.w), Math.ceil(box.h)])
    expect(r.solid).toBeGreaterThan(1000)
    expect(r.clear).toBeGreaterThan(r.w * r.h * 0.5)
    expect(r.colour[0]).toBeGreaterThan(240)
    expect(Math.abs(r.colour[1] - 136)).toBeLessThan(10)
    expect(r.colour[2]).toBeLessThan(15)
    // The padding is clear all round; the work folder is gone.
    for (let x = 0; x < r.w; x++) expect(r.data[x * 4 + 3]).toBe(0)
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("text-"))).toEqual([])
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

  it("draws text as it is: no %{...} expansion, quotes and colons are fine", async () => {
    const out = path.join(dir, "s.png")
    await rasteriseText({ content: "%{pts} 'a:b' \\ ;,[x]", color: "#00ff00", orientation: "horizontal" }, 40, out, dir)
    const r = await read(out)
    expect(r.solid).toBeGreaterThan(100)
  }, 30_000)
})
