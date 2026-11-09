import "server-only"
import sharp from "sharp"
import { probePictureSize } from "./ffmpeg-server"

// The size a picture or video is shown at, for choosing a new project's format.

/** An image's size with its EXIF turn applied, or a video's with its rotation applied; null when it can't be read. */
export async function mediaSize(file: string, kind: "image" | "video"): Promise<{ width: number; height: number } | null> {
  if (kind === "image") {
    try {
      const m = await sharp(file, { failOn: "none", limitInputPixels: false }).metadata()
      if (m.width && m.height) return (m.orientation ?? 1) >= 5 ? { width: m.height, height: m.width } : { width: m.width, height: m.height }
    } catch {
      // fall through to ffmpeg
    }
  }
  try {
    return await probePictureSize(file)
  } catch {
    return null
  }
}
