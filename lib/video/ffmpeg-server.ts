import "server-only"
import { execFile, spawn } from "child_process"
import fs from "fs/promises"
import { allClips, assetKind, clipLength, totalLength, type Clip, type Project } from "./project"

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
 * The filtergraph text for the whole timeline, plus each clip's input
 * arguments (base track first, then each overlay track, in clip order).
 *
 * The base track is trimmed, letterboxed and concatenated as it always was;
 * with nothing on the overlay tracks that is the whole graph. With overlays,
 * the base stream goes over a black canvas the timeline's length, and every
 * overlay clip (shifted to its start) over that, lower tracks first, enabled
 * for its own span. Audio is the base track's plus each unmuted overlay clip's
 * (delayed to its start), mixed over silence the timeline's length.
 */
export function buildExportGraph(p: Project, files: Record<string, string>): { graph: string; inputs: string[][] } {
  if (allClips(p).length === 0) throw new Error("Nothing to export")
  const { width: W, height: H, fps } = p
  const inputs: string[][] = []
  const parts: string[] = []
  const frame = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`
  const fileFor = (c: Clip) => {
    const file = files[c.asset]
    if (!file) throw new Error("Missing asset file")
    return file
  }
  const isImage = (c: Clip) => {
    const asset = p.assets[c.asset]
    return asset !== undefined && assetKind(asset) === "image"
  }

  // The base track: one concatenated stream, with silence where a clip has no sound (or the track is muted).
  const [baseTrack, ...overlays] = p.tracks
  const layered = overlays.some((t) => t.clips.length > 0)
  const labels: string[] = []
  baseTrack.clips.forEach((c) => {
    const i = inputs.length
    const file = fileFor(c)
    const silence = `anullsrc=r=48000:cl=stereo,atrim=0:${num(clipLength(c))},asetpts=PTS-STARTPTS[a${i}]`
    if (isImage(c)) {
      // A still image repeats for the clip's length; there's nothing to trim.
      inputs.push(["-loop", "1", "-framerate", String(fps), "-t", num(clipLength(c)), "-i", file])
      parts.push(`[${i}:v]setpts=PTS-STARTPTS,${frame},format=yuv420p[v${i}]`)
      parts.push(silence)
      labels.push(`[v${i}][a${i}]`)
      return
    }
    inputs.push(["-i", file])
    parts.push(`[${i}:v]trim=${num(c.in)}:${num(c.out)},setpts=PTS-STARTPTS,${frame}[v${i}]`)
    parts.push(
      p.assets[c.asset]?.hasAudio === false || baseTrack.muted
        ? silence
        : `[${i}:a]atrim=${num(c.in)}:${num(c.out)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`
    )
    labels.push(`[v${i}][a${i}]`)
  })
  if (!layered) {
    parts.push(`${labels.join("")}concat=n=${baseTrack.clips.length}:v=1:a=1[v][a]`)
    return { graph: parts.join(";"), inputs }
  }

  const total = num(totalLength(p))
  parts.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${total},format=yuv420p[bg]`)
  const mix = ["[asil]"]
  let under = "[bg]"
  if (baseTrack.clips.length > 0) {
    parts.push(`${labels.join("")}concat=n=${baseTrack.clips.length}:v=1:a=1[bv][ba]`)
    // The base ends before a later overlay: the canvas shows through (eof_action=pass).
    parts.push(`[bg][bv]overlay=eof_action=pass[l0]`)
    under = "[l0]"
    mix.push("[ba]")
  }
  const overlayClips = overlays.flatMap((t) => t.clips.map((c) => ({ c, muted: Boolean(t.muted) })))
  overlayClips.forEach(({ c, muted }, n) => {
    const i = inputs.length
    const file = fileFor(c)
    const start = c.start ?? 0
    const shift = `setpts=PTS+${num(start)}/TB`
    if (isImage(c)) {
      inputs.push(["-loop", "1", "-framerate", String(fps), "-t", num(clipLength(c)), "-i", file])
      parts.push(`[${i}:v]setpts=PTS-STARTPTS,${frame},format=yuv420p,${shift}[v${i}]`)
    } else {
      inputs.push(["-i", file])
      parts.push(`[${i}:v]trim=${num(c.in)}:${num(c.out)},setpts=PTS-STARTPTS,${frame},${shift}[v${i}]`)
      if (!muted && p.assets[c.asset]?.hasAudio !== false) {
        parts.push(
          `[${i}:a]atrim=${num(c.in)}:${num(c.out)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,adelay=delays=${Math.round(start * 48000)}S:all=1[a${i}]`
        )
        mix.push(`[a${i}]`)
      }
    }
    const out = n === overlayClips.length - 1 ? "[v]" : `[l${n + 1}]`
    parts.push(`${under}[v${i}]overlay=enable='between(t,${num(start)},${num(start + clipLength(c))})':eof_action=pass${out}`)
    under = out
  })
  // Silence the timeline's length sets the mix's length (duration=first) and keeps it continuous.
  parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total}[asil]`)
  parts.push(`${mix.join("")}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0[a]`)
  return { graph: parts.join(";"), inputs }
}

/**
 * ffmpeg arguments for the whole timeline: every clip is trimmed, scaled into
 * the project frame with a letterbox pad (never stretched), then the base
 * track concatenated and any overlay tracks layered on top (buildExportGraph).
 * `files` maps asset id to absolute path (for an image, a still ffmpeg can
 * read); one input per clip keeps each filter label used once. A clip from a
 * silent asset or an image gets generated silence; an image input loops.
 * With `graphFile` the filtergraph is read from that file (the caller writes
 * `buildExportGraph(...).graph` there) so a long timeline can't overflow the
 * command line (`-/filter_complex <file>`, needs ffmpeg 7 or newer; the old
 * `-filter_complex_script` is gone in 9); without it the graph is inline.
 */
export function buildExportArgs(p: Project, files: Record<string, string>, outFile: string, graphFile?: string): string[] {
  const { graph, inputs } = buildExportGraph(p, files)
  const args = ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1"]
  for (const input of inputs) args.push(...input)
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
