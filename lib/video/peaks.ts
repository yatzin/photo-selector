// Audio peaks for the timeline's waveforms. The server decodes an asset's
// sound once (mono, 8 kHz), keeps the loudest sample of every 80 (100 peaks a
// second) as a byte, and caches them beside the asset as `.<file>.peaks`:
// a version byte, the peaks' rate as a little-endian uint16, then the peaks.
// No Node APIs here, so the browser can read the file and draw from it too.

export const PEAKS_VERSION = 1
/** Peaks per second. */
export const PEAKS_RATE = 100
const HEADER = 3

/** The cache file's name in assets/ for an asset file: a dot-file, so it never looks like media. */
export const peaksFileName = (file: string) => `.${file}.peaks`

const scale = (max: number) => Math.min(255, Math.round((max * 255) / 32767))

/**
 * Bins a stream of signed 16-bit little-endian samples as it arrives: the
 * loudest absolute sample of every `binSize`, scaled 0..255, a short last bin
 * included. A chunk may end in the middle of a sample.
 */
export function createPeakBinner(binSize: number) {
  const out: number[] = []
  let max = 0
  let count = 0
  let odd: number | null = null
  const add = (s: number) => {
    const a = s < 0 ? -s : s
    if (a > max) max = a
    if (++count === binSize) {
      out.push(scale(max))
      max = 0
      count = 0
    }
  }
  return {
    push(chunk: Uint8Array) {
      let i = 0
      if (odd !== null && chunk.length > 0) {
        add(((chunk[0] << 8) | odd) << 16 >> 16)
        odd = null
        i = 1
      }
      for (; i + 1 < chunk.length; i += 2) add(((chunk[i + 1] << 8) | chunk[i]) << 16 >> 16)
      if (i < chunk.length) odd = chunk[i]
    },
    finish(): Uint8Array {
      if (count > 0) out.push(scale(max))
      max = 0
      count = 0
      return Uint8Array.from(out)
    },
  }
}

/** Peaks of a whole PCM buffer (samples, or s16le bytes): the loudest absolute sample per `binSize`, 0..255. */
export function peaksFromPcm(samples: Int16Array | Uint8Array, binSize: number): Uint8Array {
  const b = createPeakBinner(binSize)
  b.push(samples instanceof Int16Array ? new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength) : samples)
  return b.finish()
}

/** The cache file's bytes: version, rate (uint16 LE), peaks. */
export function encodePeaks(peaks: Uint8Array, rate: number): Uint8Array {
  const bytes = new Uint8Array(HEADER + peaks.length)
  bytes[0] = PEAKS_VERSION
  bytes[1] = rate & 0xff
  bytes[2] = (rate >> 8) & 0xff
  bytes.set(peaks, HEADER)
  return bytes
}

/** The rate and peaks of a cache file, or null when it isn't one this version reads. */
export function decodePeaks(bytes: Uint8Array): { rate: number; peaks: Uint8Array } | null {
  if (bytes.length < HEADER || bytes[0] !== PEAKS_VERSION) return null
  const rate = bytes[1] | (bytes[2] << 8)
  if (rate <= 0) return null
  return { rate, peaks: bytes.subarray(HEADER) }
}

/**
 * Bar heights (0..1) for drawing the source range [inSec, outSec) of `peaks`
 * (`rate` per second) across `widthPx`: one per `step` px (a partial last step
 * counts), each the loudest bin its pixels cover, or that bin alone when the
 * clip is zoomed in past one bin per step. Past the end of the peaks it's 0.
 */
export function waveformBars(peaks: Uint8Array, rate: number, inSec: number, outSec: number, widthPx: number, step = 2): number[] {
  const duration = outSec - inSec
  if (!(duration > 0) || !(widthPx > 0) || !(rate > 0) || !(step > 0)) return []
  const n = Math.ceil(widthPx / step)
  const bars = new Array<number>(n)
  for (let j = 0; j < n; j++) {
    const t0 = inSec + ((j * step) / widthPx) * duration
    const t1 = inSec + (Math.min(widthPx, (j + 1) * step) / widthPx) * duration
    const b0 = Math.max(0, Math.floor(t0 * rate + 1e-9))
    const b1 = Math.min(peaks.length, Math.max(b0 + 1, Math.ceil(t1 * rate - 1e-9)))
    let max = 0
    for (let b = b0; b < b1; b++) if (peaks[b] > max) max = peaks[b]
    bars[j] = max / 255
  }
  return bars
}
