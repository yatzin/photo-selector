import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { colorDistance, dHash, fingerprintImage, hamming } from "./fingerprint"

// A "scene": sky gradient, a sun and a figure. `dx` shifts the figure,
// `brightness` simulates a slightly different exposure.
function scene(opts: { dx?: number; variant?: "a" | "b" } = {}): Buffer {
  const { dx = 0, variant = "a" } = opts
  const svg =
    variant === "a"
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
          <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a7bd5"/><stop offset="1" stop-color="#e0eafc"/></linearGradient></defs>
          <rect width="400" height="300" fill="url(#g)"/><circle cx="320" cy="70" r="40" fill="#ffd200"/>
          <rect x="${150 + dx}" y="120" width="60" height="160" fill="#7b3f00"/><rect x="0" y="260" width="400" height="40" fill="#2e7d32"/>
        </svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
          <rect width="400" height="300" fill="#202020"/><rect x="20" y="20" width="120" height="260" fill="#c62828"/>
          <circle cx="280" cy="200" r="80" fill="#f5f5f5"/>
        </svg>`
  return Buffer.from(svg)
}

async function jpeg(svg: Buffer, brightness = 1): Promise<Buffer> {
  return sharp(svg).modulate({ brightness }).jpeg({ quality: 85 }).toBuffer()
}

describe("dHash / hamming", () => {
  it("is 0 for a flat image and counts differing bits", () => {
    expect(dHash(new Uint8Array(72))).toBe(0n)
    const ramp = Uint8Array.from({ length: 72 }, (_, i) => 255 - (i % 9) * 20)
    expect(hamming(dHash(ramp), 0n)).toBe(64)
  })
})

describe("colorDistance", () => {
  it("averages absolute differences", () => {
    expect(colorDistance([0, 0, 0], [30, 0, 0])).toBe(10)
    expect(colorDistance([5, 5], [5, 5])).toBe(0)
  })
})

describe("fingerprintImage", () => {
  it("rates two takes of the same scene as close", async () => {
    const a = await fingerprintImage(await jpeg(scene()))
    const b = await fingerprintImage(await jpeg(scene({ dx: 6 }), 1.06))
    expect(hamming(a.hash, b.hash)).toBeLessThanOrEqual(12)
    expect(colorDistance(a.colors, b.colors)).toBeLessThanOrEqual(20)
  })

  it("rates a different scene as far", async () => {
    const a = await fingerprintImage(await jpeg(scene()))
    const c = await fingerprintImage(await jpeg(scene({ variant: "b" })))
    const far = hamming(a.hash, c.hash) > 12 || colorDistance(a.colors, c.colors) > 20
    expect(far).toBe(true)
  })

  it("returns 48 colour values", async () => {
    const a = await fingerprintImage(await jpeg(scene()))
    expect(a.colors).toHaveLength(48)
  })
})
