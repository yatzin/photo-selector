import exifReader from "exif-reader"
import sharp from "sharp"

// When a photo was taken: EXIF DateTimeOriginal, else DateTime, else the
// file's modified time. EXIF has no time zone; exif-reader returns the
// wall-clock time as UTC, which is consistent within a folder — all grouping
// needs is the order and gaps between shots.

function valid(d: unknown): number | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) && d.getUTCFullYear() > 1990 ? d.getTime() : null
}

export function captureTimeFromExif(exif: Buffer | undefined, fallbackMs: number): number {
  if (!exif) return fallbackMs
  try {
    const data = exifReader(exif) as { Photo?: { DateTimeOriginal?: unknown }; Image?: { DateTime?: unknown } }
    return valid(data.Photo?.DateTimeOriginal) ?? valid(data.Image?.DateTime) ?? fallbackMs
  } catch {
    return fallbackMs
  }
}

export async function readCaptureTime(file: string, fallbackMs: number): Promise<number> {
  try {
    const { exif } = await sharp(file).metadata()
    return captureTimeFromExif(exif, fallbackMs)
  } catch {
    return fallbackMs // e.g. HEIC sharp can't open, or the file vanished
  }
}
