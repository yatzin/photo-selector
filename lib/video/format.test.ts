import { describe, expect, it } from "vitest"
import { formatFromSource, orientationOf, resolutionOf, sizeFor, turnTo } from "./format"
import { parsePictureSize } from "./import"

describe("format", () => {
  it("gives even 16:9 sizes, turned on their side for Vertical", () => {
    expect(sizeFor("horizontal", "fhd")).toEqual({ width: 1920, height: 1080 })
    expect(sizeFor("vertical", "fhd")).toEqual({ width: 1080, height: 1920 })
    expect(sizeFor("horizontal", "uhd")).toEqual({ width: 3840, height: 2160 })
    expect(sizeFor("horizontal", "sd")).toEqual({ width: 854, height: 480 })
  })

  it("names a canvas back", () => {
    expect(orientationOf(1080, 1920)).toBe("vertical")
    expect(orientationOf(1080, 1080)).toBe("horizontal")
    expect(resolutionOf(1920, 1080)).toBe("fhd")
    expect(resolutionOf(720, 1280)).toBe("hd")
    expect(resolutionOf(1000, 700)).toBeNull()
  })

  it("takes a new project's format from its first picture, up to Full HD", () => {
    expect(formatFromSource(1920, 1080)).toEqual({ width: 1920, height: 1080 })
    expect(formatFromSource(2160, 3840)).toEqual({ width: 1080, height: 1920 })
    expect(formatFromSource(3840, 2160)).toEqual({ width: 1920, height: 1080 })
    expect(formatFromSource(1280, 720)).toEqual({ width: 1280, height: 720 })
    expect(formatFromSource(640, 360)).toEqual({ width: 854, height: 480 })
  })

  it("keeps the resolution when the orientation turns", () => {
    expect(turnTo("vertical", 1280, 720)).toEqual({ width: 720, height: 1280 })
    expect(turnTo("horizontal", 1080, 1920)).toEqual({ width: 1920, height: 1080 })
    expect(turnTo("vertical", 1000, 700)).toEqual({ width: 700, height: 1000 })
  })
})

describe("parsePictureSize", () => {
  it("reads the first picture's size", () => {
    expect(parsePictureSize("  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps\n")).toEqual({ width: 1920, height: 1080 })
  })

  it("turns a phone video that says it is rotated", () => {
    const text = "  Stream #0:0[0x1](und): Video: hevc (Main), yuv420p, 1920x1080, 30 fps\n    Side data:\n      displaymatrix: rotation of -90.00 degrees\n  Stream #0:1: Audio: aac\n"
    expect(parsePictureSize(text)).toEqual({ width: 1080, height: 1920 })
    expect(parsePictureSize("  Stream #0:0: Video: h264, 1280x720\n    Metadata:\n      rotate          : 90\n")).toEqual({ width: 720, height: 1280 })
  })

  it("skips cover art and finds nothing in a sound file", () => {
    expect(parsePictureSize("  Stream #0:0: Audio: mp3\n  Stream #0:1: Video: mjpeg, 500x500 (attached pic)\n")).toBeNull()
  })
})
