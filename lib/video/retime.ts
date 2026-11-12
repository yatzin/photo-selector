// Speed and reverse for a video or sound clip. A browser can't play a video backwards,
// and the player is tuned for normal-rate playback, so a retimed clip points at
// a generated copy of the part of the original it uses (an asset marked
// `retime`, hidden from Project media). The original file is never touched:
// the Speed dialog always works from it (sourceWindow maps the clip's trim back
// to the original), and Reset puts the clip back on it.

export const MIN_SPEED = 0.1
export const MAX_SPEED = 8
/** ffmpeg's `reverse` holds every frame in memory: the part reversed is at most this long (s). */
export const MAX_REVERSE_SECONDS = 60
/** Speed presets the dialog offers. */
export const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4] as const

/** What a retimed asset was made from: the original asset's id and the part of it (s) played at `speed` (1 = normal), `reverse`d or not. */
export type Retime = { source: string; speed: number; reverse: boolean; from: number; to: number }

export function isValidRetime(v: unknown): v is Retime {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.source === "string" && r.source.length > 0 && r.source.length <= 100 &&
    typeof r.speed === "number" && r.speed >= MIN_SPEED && r.speed <= MAX_SPEED &&
    typeof r.reverse === "boolean" &&
    typeof r.from === "number" && Number.isFinite(r.from) && r.from >= 0 &&
    typeof r.to === "number" && Number.isFinite(r.to) && r.to > r.from
  )
}

const r6 = (n: number) => Number(n.toFixed(6))

/** How long the retimed part is (s). */
export const retimedLength = (from: number, to: number, speed: number): number => (to - from) / speed

/**
 * The part of the original media a clip shows: the clip's trim `inSec` to
 * `outSec` of `asset` (an original, or a retimed copy), as a window of the
 * original and the id of the original (`assetId` for an original).
 */
export function sourceWindow(assetId: string, asset: { retime?: Retime }, inSec: number, outSec: number): { source: string; from: number; to: number } {
  const r = asset.retime
  if (!r) return { source: assetId, from: inSec, to: outSec }
  return r.reverse
    ? { source: r.source, from: r.to - outSec * r.speed, to: r.to - inSec * r.speed }
    : { source: r.source, from: r.from + inSec * r.speed, to: r.from + outSec * r.speed }
}

/** Why a speed, direction and window can't be made, or null. */
export function retimeError(speed: number, reverse: boolean, from: number, to: number): string | null {
  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) return `Speed must be between ${MIN_SPEED}× and ${MAX_SPEED}×.`
  if (!(Number.isFinite(from) && Number.isFinite(to)) || from < 0 || to <= from) return "That part of the video is not valid."
  if (reverse && to - from > MAX_REVERSE_SECONDS + 1e-6) return `Reverse works on up to ${MAX_REVERSE_SECONDS} s at a time. Trim the clip first.`
  return null
}

/** atempo factors (each 0.5 to 2, the range one atempo takes) that multiply to `speed`. */
export function atempoChain(speed: number): number[] {
  const out: number[] = []
  let s = speed
  while (s > 2 + 1e-9) {
    out.push(2)
    s /= 2
  }
  while (s < 0.5 - 1e-9) {
    out.push(0.5)
    s /= 0.5
  }
  out.push(r6(s))
  return out
}

/** The video and sound filters that retime a part cut from the original (null sound: none). */
export function retimeFilters(speed: number, reverse: boolean, hasAudio: boolean): { video: string; audio: string | null } {
  return {
    video: `${reverse ? "reverse," : ""}setpts=(PTS-STARTPTS)/${r6(speed)},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    audio: hasAudio ? `${reverse ? "areverse," : ""}${atempoChain(speed).map((f) => `atempo=${f}`).join(",")}` : null,
  }
}

/** ffmpeg arguments that make the retimed copy of `input` (an argument list, no shell). */
export function retimeArgs(input: string, output: string, o: { from: number; to: number; speed: number; reverse: boolean; hasAudio: boolean; /** A sound file: no picture (cover art is dropped). */ audioOnly?: boolean; /** A small, quick copy for listening to (480 px wide, low bitrate). */ preview?: boolean }): string[] {
  const f = retimeFilters(o.speed, o.reverse, o.hasAudio)
  const head = ["-hide_banner", "-nostdin", "-ss", String(r6(o.from)), "-t", String(r6(o.to - o.from)), "-i", input]
  if (o.audioOnly) {
    return [...head, "-filter_complex", `[0:a]${f.audio ?? "anull"}[a]`, "-map", "[a]", "-vn", "-c:a", "aac", "-b:a", o.preview ? "96k" : "192k", "-movflags", "+faststart", "-y", output]
  }
  const video = o.preview ? f.video.replace("scale=trunc(iw/2)*2:trunc(ih/2)*2", "scale=480:-2") : f.video
  const graph = `[0:v]${video}[v]${f.audio ? `;[0:a]${f.audio}[a]` : ""}`
  return [
    ...head,
    "-filter_complex", graph, "-map", "[v]", ...(f.audio ? ["-map", "[a]"] : []),
    "-c:v", "libx264", "-crf", o.preview ? "30" : "16", "-preset", o.preview ? "veryfast" : "fast", "-pix_fmt", "yuv420p",
    ...(f.audio ? ["-c:a", "aac", "-b:a", o.preview ? "96k" : "192k"] : ["-an"]),
    "-movflags", "+faststart", "-threads", "4", "-y", output,
  ]
}

/** Longest a preview plays for (s of output). */
export const PREVIEW_SECONDS = 6

/** The short stretch of `from`..`to` a preview plays: from the middle, as much as plays for `seconds` at `speed` (all of it when that's shorter). */
export function previewWindow(from: number, to: number, speed: number, seconds = PREVIEW_SECONDS): { from: number; to: number } {
  const length = Math.min(to - from, seconds * speed)
  const mid = (from + to) / 2
  return { from: mid - length / 2, to: mid + length / 2 }
}

/** "0.5×", "2×" */
export const speedText = (speed: number): string => `${Number(speed.toFixed(2))}×`

/** The media item's title for a retimed copy: "Beach (0.5×, reversed)". */
export function retimeTitle(base: string, speed: number, reverse: boolean): string {
  const parts = [...(speed !== 1 ? [speedText(speed)] : []), ...(reverse ? ["reversed"] : [])]
  return parts.length ? `${base} (${parts.join(", ")})` : base
}
