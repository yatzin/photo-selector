import "server-only"
import { execFile, spawn } from "child_process"
import fs from "fs/promises"
import { clipLength, type Project } from "./project"

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

const num = (n: number) => String(Number(n.toFixed(3)))

/**
 * ffmpeg arguments for the whole timeline: every clip is trimmed, scaled into
 * the project frame with a letterbox pad (never stretched), then concatenated.
 * `files` maps asset id to absolute path; one input per clip keeps each
 * filter label used once. A clip from a silent asset gets generated silence.
 */
export function buildExportArgs(p: Project, files: Record<string, string>, outFile: string): string[] {
  if (p.clips.length === 0) throw new Error("Nothing to export")
  const { width: W, height: H, fps } = p
  const args = ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1"]
  const parts: string[] = []
  const labels: string[] = []
  p.clips.forEach((c, i) => {
    const file = files[c.asset]
    if (!file) throw new Error("Missing asset file")
    args.push("-i", file)
    parts.push(
      `[${i}:v]trim=${num(c.in)}:${num(c.out)},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${i}]`
    )
    parts.push(
      p.assets[c.asset]?.hasAudio === false
        ? `anullsrc=r=48000:cl=stereo,atrim=0:${num(clipLength(c))},asetpts=PTS-STARTPTS[a${i}]`
        : `[${i}:a]atrim=${num(c.in)}:${num(c.out)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`
    )
    labels.push(`[v${i}][a${i}]`)
  })
  parts.push(`${labels.join("")}concat=n=${p.clips.length}:v=1:a=1[v][a]`)
  args.push(
    "-filter_complex", parts.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
    "-f", "mp4", outFile
  )
  return args
}

/** Fraction done (0..1) from an ffmpeg `-progress` line. out_time_ms is microseconds despite its name. */
export function parseProgressLine(line: string, totalSeconds: number): number | null {
  const m = /^out_time_(?:ms|us)=(-?\d+)\s*$/.exec(line.trim())
  if (!m || !(totalSeconds > 0)) return null
  return Math.max(0, Math.min(1, Number(m[1]) / 1_000_000 / totalSeconds))
}

/** Runs ffmpeg writing to `outFile`. On failure kills the process, removes `outFile` and rejects with ffmpeg's last stderr line. */
export function runExport(args: string[], outFile: string, totalSeconds: number, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let lastErr = ""
    let buffered = ""
    let settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      child.kill()
      void fs.rm(outFile, { force: true }).then(() => reject(new Error(message)))
    }
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString()
      const lines = buffered.split(/\r?\n/)
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        const f = parseProgressLine(line, totalSeconds)
        if (f !== null) onProgress(f)
      }
    })
    child.stderr.on("data", (chunk: Buffer) => {
      const last = chunk.toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()
      if (last) lastErr = last
    })
    child.on("error", (error) => fail(error.message))
    child.on("close", (code) => {
      if (code === 0) {
        if (settled) return
        settled = true
        resolve()
      } else {
        fail(lastErr || `ffmpeg exited with code ${code}.`)
      }
    })
  })
}
