import { describe, expect, it } from "vitest"
import { parseProbe } from "./ffmpeg-server"

describe("parseProbe", () => {
  it("reads duration and audio", () => {
    const err = "  Duration: 00:01:02.50, start: 0.0, bitrate: 1000 kb/s\n  Stream #0:0: Video: h264\n  Stream #0:1(und): Audio: aac, 48000 Hz\n"
    expect(parseProbe(err)).toEqual({ duration: 62.5, hasAudio: true })
  })

  it("reports a silent video", () => {
    expect(parseProbe("  Duration: 01:00:00.00, start: 0\n  Stream #0:0: Video: h264\n")).toEqual({ duration: 3600, hasAudio: false })
  })

  it("throws when there is no duration", () => {
    expect(() => parseProbe("Invalid data found when processing input")).toThrow()
  })
})
