import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { captureTimeFromExif, readCaptureTime } from "./capture-time"

async function withDate(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
    .withExif({ IFD0: { DateTime: "2024:05:01 10:00:00" } })
    .jpeg()
    .toBuffer()
}

describe("captureTimeFromExif", () => {
  it("reads the EXIF date (as wall-clock UTC)", async () => {
    const exif = (await sharp(await withDate()).metadata()).exif
    expect(captureTimeFromExif(exif, 0)).toBe(Date.UTC(2024, 4, 1, 10, 0, 0))
  })

  it("falls back when there is no EXIF or it is garbage", () => {
    expect(captureTimeFromExif(undefined, 123)).toBe(123)
    expect(captureTimeFromExif(Buffer.from("not exif"), 456)).toBe(456)
  })
})

describe("readCaptureTime", () => {
  it("falls back for a file that can't be read", async () => {
    expect(await readCaptureTime("/definitely/not/here.jpg", 789)).toBe(789)
  })
})
