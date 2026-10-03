// Lossless JPEG rotation: instead of re-encoding pixels, change the EXIF
// Orientation tag that tells viewers how to display them. Pure byte handling,
// no disk access.
//
// Orientation values (EXIF 2.3): 1 normal, 2 mirrored, 3 180°, 4 mirrored
// vertically, 5 transposed, 6 90° CW, 7 transversed, 8 90° CCW.

const ORIENTATION_TAG = 0x0112
const SHORT = 3

// Orientation after turning the displayed image 90° clockwise. Derived by
// composing a 90° rotation with each orientation's transform.
const CLOCKWISE: Record<number, number> = { 1: 6, 6: 3, 3: 8, 8: 1, 2: 7, 7: 4, 4: 5, 5: 2 }
const COUNTER_CLOCKWISE: Record<number, number> = Object.fromEntries(
  Object.entries(CLOCKWISE).map(([from, to]) => [to, Number(from)])
)

export type RotateDirection = "cw" | "ccw"

export function rotateOrientation(current: number, direction: RotateDirection): number {
  const table = direction === "cw" ? CLOCKWISE : COUNTER_CLOCKWISE
  return table[current] ?? table[1]
}

export function isJpeg(buf: Uint8Array): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
}

type ExifLocation = {
  /** Offset of the TIFF header inside the file. */
  tiff: number
  littleEndian: boolean
  /** Offset of the Orientation value's two bytes, or null when the tag is absent. */
  orientationValue: number | null
}

type Segments = { exif: ExifLocation | null; /** Where a new APP1 belongs: after SOI and any APP0. */ insertAt: number }

function readU16(buf: Uint8Array, at: number, le: boolean): number {
  return le ? buf[at] | (buf[at + 1] << 8) : (buf[at] << 8) | buf[at + 1]
}

function readU32(buf: Uint8Array, at: number, le: boolean): number {
  return le
    ? (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0
    : ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0
}

function findExif(buf: Uint8Array, segStart: number, segEnd: number): ExifLocation | null {
  // APP1 payload: "Exif\0\0" then a TIFF header.
  const header = segStart + 4
  if (segEnd - header < 14) return null
  if (String.fromCharCode(...buf.subarray(header, header + 4)) !== "Exif" || buf[header + 4] !== 0 || buf[header + 5] !== 0) return null
  const tiff = header + 6
  const order = String.fromCharCode(buf[tiff], buf[tiff + 1])
  if (order !== "II" && order !== "MM") return null
  const le = order === "II"
  if (readU16(buf, tiff + 2, le) !== 42) return null
  const ifd0 = tiff + readU32(buf, tiff + 4, le)
  if (ifd0 + 2 > segEnd) return null
  const count = readU16(buf, ifd0, le)
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12
    if (entry + 12 > segEnd) break
    if (readU16(buf, entry, le) === ORIENTATION_TAG && readU16(buf, entry + 2, le) === SHORT) {
      return { tiff, littleEndian: le, orientationValue: entry + 8 }
    }
  }
  return { tiff, littleEndian: le, orientationValue: null }
}

function scan(buf: Uint8Array): Segments {
  if (!isJpeg(buf)) throw new Error("Not a JPEG file.")
  let at = 2
  let insertAt = 2
  let exif: ExifLocation | null = null
  while (at + 4 <= buf.length && buf[at] === 0xff) {
    const marker = buf[at + 1]
    // Start of scan: image data follows, no more metadata segments.
    if (marker === 0xda || marker === 0xd9) break
    const length = (buf[at + 2] << 8) | buf[at + 3]
    const end = at + 2 + length
    if (length < 2 || end > buf.length) break
    if (marker === 0xe0 && insertAt === at) insertAt = end // keep JFIF APP0 first
    if (marker === 0xe1 && !exif) exif = findExif(buf, at, end)
    at = end
  }
  return { exif, insertAt }
}

/** The file's EXIF orientation, 1 when it has none. */
export function readOrientation(buf: Uint8Array): number {
  const { exif } = scan(buf)
  if (!exif || exif.orientationValue === null) return 1
  const value = readU16(buf, exif.orientationValue, exif.littleEndian)
  return value >= 1 && value <= 8 ? value : 1
}

/**
 * How to give `buf` a new orientation. A file that already has the tag gets
 * a two-byte patch at a known offset (the rest of the file is untouched); a
 * file with no EXIF at all gets a minimal EXIF segment inserted.
 */
export type OrientationEdit =
  | { kind: "patch"; offset: number; bytes: Uint8Array }
  | { kind: "rewrite"; buffer: Uint8Array }

export function orientationEdit(buf: Uint8Array, orientation: number): OrientationEdit {
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) throw new Error("Invalid orientation.")
  const { exif, insertAt } = scan(buf)

  if (exif && exif.orientationValue !== null) {
    const bytes = exif.littleEndian ? [orientation & 0xff, 0] : [0, orientation & 0xff]
    return { kind: "patch", offset: exif.orientationValue, bytes: Uint8Array.from(bytes) }
  }
  if (exif) {
    // EXIF without an Orientation entry: adding one means rewriting the IFD
    // and every offset after it. Phones always write the tag, so refuse
    // rather than risk damaging the metadata.
    throw new Error("This photo's EXIF data has no orientation tag to change.")
  }

  // "Exif\0\0" + big-endian TIFF header + IFD0 with a single Orientation entry.
  const payload = [
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]
  const length = payload.length + 2
  const segment = Uint8Array.from([0xff, 0xe1, length >> 8, length & 0xff, ...payload])
  const out = new Uint8Array(buf.length + segment.length)
  out.set(buf.subarray(0, insertAt), 0)
  out.set(segment, insertAt)
  out.set(buf.subarray(insertAt), insertAt + segment.length)
  return { kind: "rewrite", buffer: out }
}

export function applyEdit(buf: Uint8Array, edit: OrientationEdit): Uint8Array {
  if (edit.kind === "rewrite") return edit.buffer
  const out = Uint8Array.from(buf)
  out.set(edit.bytes, edit.offset)
  return out
}
