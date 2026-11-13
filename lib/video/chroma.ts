// Background removal for a still: the usual "magic wand" way. The picked color
// matches pixels within `tolerance` of it in the CIE Lab color space (a
// distance close to how different two colors look). Matching pixels connected
// to the picture's border become transparent, so the same color inside the
// subject (a few dots, an eye) stays; with `contiguous` off, every matching
// pixel goes. The pixels along the cut get a partly transparent edge and the
// key color is taken back out of them (despill), so no halo is left.

export type Rgb = [number, number, number]
export type KeyOptions = {
  key: Rgb
  /** Lab distance (0 exact match; about 2 is just visible; 100 everything). */
  tolerance: number
  /** Only matching areas touching the border. */
  contiguous: boolean
}

export const MAX_TOLERANCE = 100

/** A stored key setting that is well formed (a color of whole 0-255 channels, a tolerance in range, a flag). */
export function isValidKey(v: unknown): v is KeyOptions {
  if (typeof v !== "object" || v === null) return false
  const k = v as Record<string, unknown>
  return (
    Array.isArray(k.key) && k.key.length === 3 && k.key.every((c) => Number.isInteger(c) && c >= 0 && c <= 255) &&
    typeof k.tolerance === "number" && Number.isFinite(k.tolerance) && k.tolerance >= 0 && k.tolerance <= MAX_TOLERANCE &&
    typeof k.contiguous === "boolean"
  )
}
const SOFT = 0.6 // the edge ramps from `tolerance` to tolerance * (1 + SOFT)

const toLinear = new Float32Array(256).map((_, i) => {
  const c = i / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})

/** sRGB (0-255 each) as CIE Lab (D65). */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = toLinear[r], lg = toLinear[g], lb = toLinear[b]
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
  const fx = f(x), fy = f(y), fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

/** The picture's color at pixel x, y of an RGBA buffer; null outside it or where it is (nearly) transparent. */
export function pixelAt(rgba: ArrayLike<number>, w: number, h: number, x: number, y: number): Rgb | null {
  if (!(x >= 0 && y >= 0 && x < w && y < h)) return null
  const i = (Math.floor(y) * w + Math.floor(x)) * 4
  return rgba[i + 3] < 8 ? null : [rgba[i], rgba[i + 1], rgba[i + 2]]
}

/** A copy of the RGBA picture with the background made transparent. */
export function removeBackground(rgba: ArrayLike<number>, w: number, h: number, o: KeyOptions): Uint8ClampedArray {
  const n = w * h
  const out = Uint8ClampedArray.from(rgba)
  if (!(w > 0 && h > 0) || out.length !== n * 4) return out
  const tol = Math.min(MAX_TOLERANCE, Math.max(0, o.tolerance))
  const [kl, ka, kb] = rgbToLab(o.key[0], o.key[1], o.key[2])
  const dist = new Float32Array(n)
  const matches = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    const i = p * 4
    if (out[i + 3] < 8) {
      // Already see-through: it matches, so the fill spreads through it.
      matches[p] = 1
      continue
    }
    const [l, a, b] = rgbToLab(out[i], out[i + 1], out[i + 2])
    const d = Math.hypot(l - kl, a - ka, b - kb)
    dist[p] = d
    if (d <= tol) matches[p] = 1
  }

  const bg = new Uint8Array(n)
  if (o.contiguous) {
    const stack = new Int32Array(n)
    let top = 0
    const seed = (p: number) => {
      if (matches[p] && !bg[p]) {
        bg[p] = 1
        stack[top++] = p
      }
    }
    for (let x = 0; x < w; x++) {
      seed(x)
      seed((h - 1) * w + x)
    }
    for (let y = 0; y < h; y++) {
      seed(y * w)
      seed(y * w + w - 1)
    }
    while (top > 0) {
      const p = stack[--top]
      const x = p % w
      if (x > 0) seed(p - 1)
      if (x < w - 1) seed(p + 1)
      if (p >= w) seed(p - w)
      if (p < n - w) seed(p + w)
    }
  } else {
    bg.set(matches)
  }

  // The cut's edge: pixels beside the background fade by how far off the key they are, with the key color taken out.
  const ramp = tol * SOFT + 1
  const edge: number[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (bg[p]) continue
      let near = false
      for (let dy = -1; dy <= 1 && !near; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx >= 0 && xx < w && bg[yy * w + xx]) {
            near = true
            break
          }
        }
      }
      if (near) edge.push(p)
    }
  }
  for (const p of edge) {
    const a = Math.min(1, Math.max(0, (dist[p] - tol) / ramp))
    if (a >= 1) continue
    const i = p * 4
    if (a > 0.02) for (let c = 0; c < 3; c++) out[i + c] = clampByte((out[i + c] - (1 - a) * o.key[c]) / a)
    out[i + 3] = clampByte(out[i + 3] * a)
  }
  for (let p = 0; p < n; p++) if (bg[p]) out[p * 4 + 3] = 0
  return out
}

// A video clip's key is the plain color key ffmpeg's `colorkey` filter does
// (the export) and the player's shader repeats (the preview): a pixel's
// distance from the key color, as a fraction of the longest possible RGB
// distance, below `similarity` goes transparent and fades in over `blend`.
// KeyOptions.tolerance (0-100) sets the similarity; `contiguous` isn't used.

const VIDEO_BLEND = 0.08
const MAX_RGB_DISTANCE = 255 * Math.sqrt(3)

/** ffmpeg colorkey's (and the shader's) similarity and blend for a tolerance. */
export function videoKeyParams(tolerance: number): { similarity: number; blend: number } {
  return { similarity: Math.min(MAX_TOLERANCE, Math.max(0, tolerance)) / 200, blend: VIDEO_BLEND }
}

/** The key color as ffmpeg writes it, "0xRRGGBB". */
export const keyHex = (key: Rgb): string => `0x${key.map((c) => c.toString(16).padStart(2, "0")).join("")}`

/** A copy of the RGBA frame with the key color cleared the way the export does it. */
export function keyVideoPixels(rgba: ArrayLike<number>, o: Pick<KeyOptions, "key" | "tolerance">): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(rgba)
  const { similarity, blend } = videoKeyParams(o.tolerance)
  for (let i = 0; i + 3 < out.length; i += 4) {
    const d = Math.hypot(out[i] - o.key[0], out[i + 1] - o.key[1], out[i + 2] - o.key[2]) / MAX_RGB_DISTANCE
    out[i + 3] = Math.round(out[i + 3] * Math.min(1, Math.max(0, (d - similarity) / blend)))
  }
  return out
}
