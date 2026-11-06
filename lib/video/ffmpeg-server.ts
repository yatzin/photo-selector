import "server-only"
import { execFile } from "child_process"

const ffmpeg = () => process.env.FFMPEG_PATH || "ffmpeg"

/** Parses `ffmpeg -i` stderr: "Duration: 00:01:02.50" and an "Audio:" stream line. */
export function parseProbe(stderr: string): { duration: number; hasAudio: boolean } {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (!m) throw new Error("Couldn't read the video's length.")
  const duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return { duration, hasAudio: /Stream #[^\n]*Audio:/.test(stderr) }
}

/** Length and whether there is sound. `ffmpeg -i` with no output exits non-zero but prints what we need on stderr. */
export function probeMedia(file: string): Promise<{ duration: number; hasAudio: boolean }> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg(), ["-hide_banner", "-i", file], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
      try {
        resolve(parseProbe(String(stderr ?? "")))
      } catch (parseError) {
        reject(err && (err as NodeJS.ErrnoException).code === "ENOENT" ? err : parseError)
      }
    })
  })
}
