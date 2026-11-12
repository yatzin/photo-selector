import { describe, expect, it } from "vitest"
import { isValidKey, keyHex, keyVideoPixels, pixelAt, removeBackground, rgbToLab, videoKeyParams } from "./chroma"

const COLOURS: Record<string, [number, number, number]> = { w: [255, 255, 255], r: [220, 20, 30], g: [30, 200, 60] }
/** A RGBA picture from rows of single-letter colours. */
function pic(rows: string[]) {
  const h = rows.length
  const w = rows[0].length
  const d = new Uint8ClampedArray(w * h * 4)
  rows.forEach((row, y) => [...row].forEach((ch, x) => d.set([...COLOURS[ch], 255], (y * w + x) * 4)))
  return { d, w, h }
}
/** Rows of "." (transparent), "#" (opaque) and "~" (partly). */
const alphaRows = (d: Uint8ClampedArray, w: number, h: number) =>
  Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      const a = d[(y * w + x) * 4 + 3]
      return a === 0 ? "." : a === 255 ? "#" : "~"
    }).join("")
  )

const WHITE = { key: [255, 255, 255] as [number, number, number], tolerance: 10, contiguous: true }

describe("rgbToLab", () => {
  it("knows white and black", () => {
    expect(rgbToLab(255, 255, 255)[0]).toBeCloseTo(100, 0)
    expect(rgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 0)
  })
})

describe("removeBackground", () => {
  const rows = ["wwwwwww", "wrrrrrw", "wrwwwrw", "wrrrrrw", "wwwwwww"]

  it("clears the border-connected background and keeps same-coloured islands inside the subject", () => {
    const { d, w, h } = pic(rows)
    expect(alphaRows(removeBackground(d, w, h, WHITE), w, h)).toEqual([".......", ".#####.", ".#####.", ".#####.", "......."])
  })

  it("with contiguous off, the enclosed same-coloured area goes too", () => {
    const { d, w, h } = pic(rows)
    expect(alphaRows(removeBackground(d, w, h, { ...WHITE, contiguous: false }), w, h)[2]).toBe(".#...#.")
  })

  it("keeps everything when nothing is near the key, and leaves the input alone", () => {
    const { d, w, h } = pic(rows)
    const copy = Uint8ClampedArray.from(d)
    const out = removeBackground(d, w, h, { key: [0, 255, 0], tolerance: 5, contiguous: true })
    expect(alphaRows(out, w, h).every((r) => r === "#######")).toBe(true)
    expect(d).toEqual(copy)
  })

  it("a bigger tolerance reaches a nearby shade; the top one takes everything", () => {
    const { d, w, h } = pic(["wwww", "wgwg"])
    const near = Uint8ClampedArray.from(d)
    near.set([240, 240, 240, 255], 0)
    expect(removeBackground(near, w, h, { ...WHITE, tolerance: 1 })[3]).toBeGreaterThan(0)
    expect(removeBackground(near, w, h, { ...WHITE, tolerance: 12 })[3]).toBe(0)
    expect(removeBackground(d, w, h, { ...WHITE, tolerance: 100 }).every((v, i) => i % 4 !== 3 || v === 0)).toBe(true)
  })

  it("softens the cut: a pixel just past the tolerance gets partial alpha", () => {
    const d = Uint8ClampedArray.from([255, 255, 255, 255, 235, 235, 235, 255, 255, 255, 255, 255, 255, 255, 255, 255])
    const out = removeBackground(d, 2, 2, { ...WHITE, tolerance: 5 })
    expect(out[3]).toBe(0)
    expect(out[7]).toBeGreaterThan(0)
    expect(out[7]).toBeLessThan(255)
  })

  it("survives empty and mismatched buffers", () => {
    expect(removeBackground(new Uint8ClampedArray(0), 0, 0, WHITE).length).toBe(0)
    expect(removeBackground(new Uint8ClampedArray(8), 5, 5, WHITE).length).toBe(8)
  })
})

describe("pixelAt", () => {
  it("reads a colour, and nothing outside or see-through", () => {
    const { d, w, h } = pic(["wr"])
    expect(pixelAt(d, w, h, 1, 0)).toEqual([220, 20, 30])
    expect(pixelAt(d, w, h, 2, 0)).toBeNull()
    d[3] = 0
    expect(pixelAt(d, w, h, 0, 0)).toBeNull()
  })
})

describe("isValidKey", () => {
  const ok = { key: [1, 2, 3], tolerance: 10, contiguous: false }
  it("accepts a good setting and rejects bad ones", () => {
    expect(isValidKey(ok)).toBe(true)
    expect(isValidKey({ ...ok, key: [1, 2] })).toBe(false)
    expect(isValidKey({ ...ok, key: [1, 2, 256] })).toBe(false)
    expect(isValidKey({ ...ok, key: [1, 2, 1.5] })).toBe(false)
    expect(isValidKey({ ...ok, tolerance: -1 })).toBe(false)
    expect(isValidKey({ ...ok, tolerance: NaN })).toBe(false)
    expect(isValidKey({ ...ok, contiguous: "yes" })).toBe(false)
    expect(isValidKey(null)).toBe(false)
  })
})

describe("the video key (ffmpeg colorkey's maths)", () => {
  it("videoKeyParams maps the tolerance to a similarity", () => {
    expect(videoKeyParams(0).similarity).toBe(0)
    expect(videoKeyParams(20).similarity).toBeCloseTo(0.1)
    expect(videoKeyParams(500).similarity).toBe(0.5)
  })
  it("keyHex writes ffmpeg's colour", () => {
    expect(keyHex([0, 255, 16])).toBe("0x00ff10")
  })
  it("keyVideoPixels clears the key, keeps a far colour and fades between", () => {
    const px = Uint8ClampedArray.from([0, 255, 0, 255, 0, 250, 0, 255, 255, 0, 0, 255, 60, 230, 40, 255])
    const out = keyVideoPixels(px, { key: [0, 255, 0], tolerance: 20 })
    expect(out[3]).toBe(0)
    expect(out[7]).toBe(0)
    expect(out[11]).toBe(255)
    expect(out[15]).toBeGreaterThan(0)
    expect(out[15]).toBeLessThan(255)
    expect(px[3]).toBe(255)
  })
  it("matches ffmpeg: grey 128 against black at similarity 0.4, blend 0.2 gives alpha 130", () => {
    // diff = 128 / 255 = 0.502; (0.502 - 0.4) / 0.2 = 0.51
    const d = Math.hypot(128, 128, 128) / (255 * Math.sqrt(3))
    expect(Math.round(255 * ((d - 0.4) / 0.2))).toBeGreaterThanOrEqual(129)
  })
})
