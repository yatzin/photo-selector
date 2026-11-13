import "server-only"
import { spawn } from "child_process"
import fs from "fs/promises"
import { ffmpegPath } from "@/lib/video/ffmpeg-server"

// A stock GIF becomes a short silent mp4 before it goes into a project: the
// editor and the export handle video, and an H.264 mp4 is far smaller than
// the GIF. yuv420p needs even sides, hence the scale filter.

const TIMEOUT_MS = 5 * 60 * 1000
const FAILED = "Couldn't convert the GIF."
/** Largest side and area a GIF may declare: each decoded frame is width x height in memory, and the encoder holds dozens. */
export const MAX_GIF_SIDE = 4096
export const MAX_GIF_PIXELS = 16_000_000
export const GIF_TOO_LARGE = "That GIF is too large."

/** True when a GIF's declared picture (probePictureSize) is too big to convert, or its size couldn't be read. */
export function gifTooLarge(size: { width: number; height: number } | null): boolean {
  if (!size || !(size.width > 0) || !(size.height > 0)) return true
  return size.width > MAX_GIF_SIDE || size.height > MAX_GIF_SIDE || size.width * size.height > MAX_GIF_PIXELS
}

/** ffmpeg arguments that turn `input` (a GIF) into a faststart yuv420p mp4 with no sound at `output`, at most 10 minutes long, on two threads. */
export function gifToMp4Args(input: string, output: string): string[] {
  return ["-hide_banner", "-nostdin", "-i", input, "-an", "-movflags", "+faststart", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-t", "600", "-threads", "2", "-y", output]
}

/**
 * Converts the GIF at `input` to an mp4 at `output` with ffmpeg (an argument
 * list, no shell). Rejects with a short message that names no path when
 * ffmpeg fails, takes over five minutes or leaves an empty file; the partial
 * output is removed then.
 */
export function convertGifToMp4(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), gifToMp4Args(input, output), { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] })
    let settled = false
    const done = async (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (ok) {
        const size = await fs.stat(output).then((s) => s.size, () => 0)
        if (size > 0) return resolve()
      }
      await fs.rm(output, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
      reject(new Error(FAILED))
    }
    // Killed on timeout; the clean-up waits for "close", as Windows won't delete a file ffmpeg still has open.
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS)
    child.on("error", () => void done(false))
    child.on("close", (code) => void done(code === 0))
  })
}
