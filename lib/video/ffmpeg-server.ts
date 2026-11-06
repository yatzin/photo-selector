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

/** The filtergraph text for the whole timeline, plus the input files in clip order. */
export function buildExportGraph(p: Project, files: Record<string, string>): { graph: string; inputs: string[] } {
  if (p.clips.length === 0) throw new Error("Nothing to export")
  const { width: W, height: H, fps } = p
  const inputs: string[] = []
  const parts: string[] = []
  const labels: string[] = []
  p.clips.forEach((c, i) => {
    const file = files[c.asset]
    if (!file) throw new Error("Missing asset file")
    inputs.push(file)
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
  return { graph: parts.join(";"), inputs }
}

/**
 * ffmpeg arguments for the whole timeline: every clip is trimmed, scaled into
 * the project frame with a letterbox pad (never stretched), then concatenated.
 * `files` maps asset id to absolute path; one input per clip keeps each
 * filter label used once. A clip from a silent asset gets generated silence.
 * With `graphFile` the filtergraph is read from that file (the caller writes
 * `buildExportGraph(...).graph` there) so a long timeline can't overflow the
 * command line (`-/filter_complex <file>`, needs ffmpeg 7 or newer; the old
 * `-filter_complex_script` is gone in 9); without it the graph is inline.
 */
export function buildExportArgs(p: Project, files: Record<string, string>, outFile: string, graphFile?: string): string[] {
  const { graph, inputs } = buildExportGraph(p, files)
  const args = ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1"]
  for (const file of inputs) args.push("-i", file)
  args.push(
    graphFile ? "-/filter_complex" : "-filter_complex", graphFile ?? graph,
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

/** Longest an export may run: four times the video's length plus five minutes. */
export const exportTimeoutMs = (totalSeconds: number) => (4 * totalSeconds + 300) * 1000

/**
 * Runs ffmpeg writing to `outFile`. On failure (or timeout) kills the process,
 * removes `outFile` once ffmpeg has let go of it, and rejects with ffmpeg's
 * last stderr line. Always settles, even if removing the file fails.
 */
export function runExport(
  args: string[],
  outFile: string,
  totalSeconds: number,
  onProgress: (fraction: number) => void,
  timeoutMs: number = exportTimeoutMs(totalSeconds)
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let lastErr = ""
    let buffered = ""
    let settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const finish = () => {
        fs.rm(outFile, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}).then(() => reject(new Error(message)))
      }
      // Windows won't delete a file ffmpeg still has open, so wait for it to exit.
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
        child.kill("SIGKILL")
        finish()
      } else {
        child.once("exit", finish)
        child.kill("SIGKILL")
      }
    }
    const timer = setTimeout(() => fail("The export timed out."), timeoutMs)
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
        clearTimeout(timer)
        resolve()
      } else {
        fail(lastErr || `ffmpeg exited with code ${code}.`)
      }
    })
  })
}
