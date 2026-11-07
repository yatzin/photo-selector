import { describe, expect, it } from "vitest"
import { createPeakBinner, decodePeaks, encodePeaks, PEAKS_RATE, peaksFileName, peaksFromPcm, waveformBars } from "./peaks"

describe("peaksFromPcm", () => {
  it("takes the loudest absolute sample of each bin, scaled 0..255, a short last bin included", () => {
    const samples = Int16Array.from([0, 100, -32768, 5, 32767, -16384, 0, 0, 16384])
    expect(Array.from(peaksFromPcm(samples, 3))).toEqual([255, 255, 128])
    expect(Array.from(peaksFromPcm(samples, 4))).toEqual([255, 255, 128])
    expect(Array.from(peaksFromPcm(Int16Array.from([0, 0, 0]), 2))).toEqual([0, 0])
  })

  it("reads a Buffer as signed 16-bit little-endian samples", () => {
    const buf = Buffer.alloc(8)
    buf.writeInt16LE(-32768, 0)
    buf.writeInt16LE(0, 2)
    buf.writeInt16LE(8192, 4)
    buf.writeInt16LE(-8192, 6)
    expect(Array.from(peaksFromPcm(buf, 2))).toEqual([255, 64])
  })

  it("gives nothing for no samples", () => {
    expect(peaksFromPcm(new Int16Array(0), 80)).toHaveLength(0)
    expect(peaksFromPcm(Buffer.alloc(0), 80)).toHaveLength(0)
  })
})

describe("createPeakBinner", () => {
  it("bins a stream the same as the whole buffer, whatever the chunk boundaries (odd bytes too)", () => {
    const samples = Int16Array.from({ length: 1001 }, (_, i) => Math.round(Math.sin(i / 7) * 3000 * (1 + (i % 13))))
    const whole = Buffer.from(samples.buffer)
    const expected = Array.from(peaksFromPcm(samples, 80))
    for (const size of [1, 3, 7, 160, 999, 5000]) {
      const b = createPeakBinner(80)
      for (let i = 0; i < whole.length; i += size) b.push(whole.subarray(i, i + size))
      expect(Array.from(b.finish())).toEqual(expected)
    }
  })
})

describe("encodePeaks and decodePeaks", () => {
  it("round-trips the rate and the peaks behind a version byte", () => {
    const bytes = encodePeaks(Uint8Array.from([1, 2, 255]), PEAKS_RATE)
    expect(Array.from(bytes.subarray(0, 3))).toEqual([1, 100, 0])
    expect(decodePeaks(bytes)).toEqual({ rate: 100, peaks: Uint8Array.from([1, 2, 255]) })
    expect(decodePeaks(encodePeaks(new Uint8Array(0), 300))).toEqual({ rate: 300, peaks: new Uint8Array(0) })
  })

  it("refuses a short file, another version or a zero rate", () => {
    expect(decodePeaks(Uint8Array.from([1, 100]))).toBeNull()
    expect(decodePeaks(Uint8Array.from([2, 100, 0, 5]))).toBeNull()
    expect(decodePeaks(Uint8Array.from([1, 0, 0, 5]))).toBeNull()
  })
})

describe("peaksFileName", () => {
  it("is a dot-file named after the asset file", () => {
    expect(peaksFileName("clip (1).mp4")).toBe(".clip (1).mp4.peaks")
  })
})

describe("waveformBars", () => {
  // 10 peaks per second for 2 s: 0, 10, 20 ... 190 (out of 255).
  const peaks = Uint8Array.from({ length: 20 }, (_, i) => i * 10)

  it("gives one 0..1 height per step pixels, the loudest bin each covers", () => {
    const bars = waveformBars(peaks, 10, 0, 2, 20, 2)
    expect(bars).toHaveLength(10)
    expect(bars.map((b) => Math.round(b * 255))).toEqual([10, 30, 50, 70, 90, 110, 130, 150, 170, 190])
  })

  it("covers only the trimmed range [in, out)", () => {
    const bars = waveformBars(peaks, 10, 0.5, 1, 10, 2)
    expect(bars.map((b) => Math.round(b * 255))).toEqual([50, 60, 70, 80, 90])
  })

  it("repeats a bin when the clip is wider than its bins (zoomed in), and scales with the width", () => {
    const bars = waveformBars(peaks, 10, 0, 0.5, 40, 2)
    expect(bars).toHaveLength(20)
    expect(bars.map((b) => Math.round(b * 255))).toEqual([0, 0, 0, 0, 10, 10, 10, 10, 20, 20, 20, 20, 30, 30, 30, 30, 40, 40, 40, 40])
    expect(waveformBars(peaks, 10, 0, 2, 2000, 2)).toHaveLength(1000)
  })

  it("rounds a partial last step up so the bars reach the clip's end", () => {
    expect(waveformBars(peaks, 10, 0, 2, 5, 2)).toHaveLength(3)
  })

  it("gives zeros past the end of short peaks, and nothing for an empty range or width", () => {
    expect(waveformBars(Uint8Array.from([255]), 10, 0, 1, 4, 2)).toEqual([1, 0])
    expect(waveformBars(new Uint8Array(0), 10, 0, 1, 4, 2)).toEqual([0, 0])
    expect(waveformBars(peaks, 10, 1, 1, 10)).toEqual([])
    expect(waveformBars(peaks, 10, 0, 1, 0)).toEqual([])
    expect(waveformBars(peaks, 0, 0, 1, 10)).toEqual([])
  })
})
