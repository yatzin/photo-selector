import { describe, expect, it } from "vitest"
import sharp from "sharp"
import { applyEdit, isJpeg, orientationEdit, readOrientation, rotateOrientation } from "./exif-orientation"

async function jpeg(orientation?: number): Promise<Uint8Array> {
  // 4x2 image: a non-square size makes rotation visible in the metadata.
  let img = sharp({ create: { width: 4, height: 2, channels: 3, background: "#c33" } }).jpeg()
  if (orientation) img = img.withMetadata({ orientation })
  return new Uint8Array(await img.toBuffer())
}

describe("rotateOrientation", () => {
  it("cycles through the four rotations clockwise", () => {
    expect([1, 6, 3, 8].map((o) => rotateOrientation(o, "cw"))).toEqual([6, 3, 8, 1])
  })

  it("undoes a clockwise turn with a counter-clockwise one, mirrored or not", () => {
    for (let o = 1; o <= 8; o++) expect(rotateOrientation(rotateOrientation(o, "cw"), "ccw")).toBe(o)
  })

  it("four turns come back to the start", () => {
    for (let o = 1; o <= 8; o++) {
      let v = o
      for (let i = 0; i < 4; i++) v = rotateOrientation(v, "cw")
      expect(v).toBe(o)
    }
  })

  it("treats an unknown value as upright", () => {
    expect(rotateOrientation(0, "cw")).toBe(6)
  })
})

describe("readOrientation / orientationEdit", () => {
  it("reads the tag sharp writes", async () => {
    expect(readOrientation(await jpeg(6))).toBe(6)
    expect(readOrientation(await jpeg())).toBe(1)
  })

  it("patches an existing tag in place, changing two bytes", async () => {
    const src = await jpeg(1)
    const edit = orientationEdit(src, 6)
    expect(edit.kind).toBe("patch")
    const out = applyEdit(src, edit)
    expect(out.length).toBe(src.length)
    expect(out.filter((b, i) => b !== src[i]).length).toBeLessThanOrEqual(2)
    expect((await sharp(out).metadata()).orientation).toBe(6)
  })

  it("inserts a minimal EXIF block when there is none, leaving the pixels alone", async () => {
    const src = await jpeg()
    const edit = orientationEdit(src, 8)
    expect(edit.kind).toBe("rewrite")
    const out = applyEdit(src, edit)
    expect(isJpeg(out)).toBe(true)
    expect(readOrientation(out)).toBe(8)
    const meta = await sharp(out).metadata()
    expect(meta.orientation).toBe(8)
    expect([meta.width, meta.height]).toEqual([4, 2])
    // The image data after the inserted segment is byte-for-byte the original.
    expect(Buffer.from(out.subarray(out.length - 100)).equals(Buffer.from(src.subarray(src.length - 100)))).toBe(true)
  })

  it("rejects non-JPEG data and bad values", async () => {
    expect(() => orientationEdit(new Uint8Array([1, 2, 3, 4]), 6)).toThrow()
    expect(() => orientationEdit(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 9)).toThrow()
  })
})
