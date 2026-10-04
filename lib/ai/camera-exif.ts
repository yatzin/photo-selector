import path from "path"
import exifReader from "exif-reader"
import sharp from "sharp"
import { captureTimeFromExif } from "@/lib/ai/capture-time"

// Find Screenshots skips photos that are clearly from a camera, so only the
// rest go to the AI. A camera writes its make/model and exposure into EXIF;
// screenshots, memes and forwarded images (whose EXIF messaging apps strip)
// have none of it.

// Phones save screenshots as PNG/JPEG; HEIC/HEIF and raw DNG only come from
// the camera.
const CAMERA_ONLY = new Set([".heic", ".heif", ".dng"])

export function cameraExif(exif: Buffer | undefined): boolean {
  if (!exif) return false
  try {
    const data = exifReader(exif) as {
      Image?: { Make?: unknown; Model?: unknown }
      Photo?: { ExposureTime?: unknown; FNumber?: unknown; ISOSpeedRatings?: unknown; FocalLength?: unknown }
    }
    const has = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== ""
    const cameraName = has(data.Image?.Make) || has(data.Image?.Model)
    const exposure = has(data.Photo?.ExposureTime) || has(data.Photo?.FNumber) || has(data.Photo?.ISOSpeedRatings) || has(data.Photo?.FocalLength)
    return cameraName || exposure
  } catch {
    return false
  }
}

/**
 * Whether a file is certainly a camera photo (unknown or unreadable counts as
 * no), and when it was taken; one read of its metadata for both.
 */
export async function photoInfo(file: string, mtimeMs: number): Promise<{ camera: boolean; takenAt: number }> {
  if (CAMERA_ONLY.has(path.extname(file).toLowerCase())) return { camera: true, takenAt: mtimeMs }
  try {
    const { exif } = await sharp(file).metadata()
    return { camera: cameraExif(exif), takenAt: captureTimeFromExif(exif, mtimeMs) }
  } catch {
    return { camera: false, takenAt: mtimeMs }
  }
}
