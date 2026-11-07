import "server-only"
import { execFile, spawn } from "child_process"
import fs from "fs/promises"
import { adjoins, allClips, clipLength, isContiguousFromZero, isStill, isTextClip, totalLength, type Clip, type Project } from "./project"
import { baseFontPx, textLayout, textSize } from "./text"
import { alphaWindow, animationExprs, isAnimated, printExpr, typewriterBoxes } from "./text-animation"
import { cropLeftOf, cropRightOf, IDENTITY, isIdentity, rotatedBounds, rotationOf, type Transform } from "./transform"

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
/** A transform fraction: six decimals keep the placement well under a pixel. */
const frac = (n: number) => String(Number(n.toFixed(6)))
const signed = (n: number) => `${n < 0 ? "-" : "+"}${frac(Math.abs(n))}`

/**
 * The overlay filter's x and y for a clip's picture (ffmpeg expressions in W,
 * H: the canvas, and w, h: the cropped picture), the same place clipRect
 * gives the visible strip: centred, moved by fractions of the canvas, and the
 * crop's top and left cut back in (h / keep is the picture's height before the
 * crop, w / keepW its width). With no left or right crop x is the plain form.
 * `turned`: the frame is a turned one (a rotation, or a text's spin).
 */
export function overlayPosition(t: Transform, turned = rotationOf(t) !== 0): { x: string; y: string } {
  // Turned, the picture keeps its full scaled size (the crop is transparent) and its centre is the content centre.
  if (turned) return { x: `(W-w)/2${signed(t.x)}*W`, y: `(H-h)/2${signed(t.y)}*H` }
  const keep = frac(1 - t.cropTop - t.cropBottom)
  const cl = cropLeftOf(t)
  const cr = cropRightOf(t)
  const keepW = frac(1 - cl - cr)
  const x = cl > 0 || cr > 0 ? `(W-w/${keepW})/2${signed(t.x)}*W+${frac(cl)}*w/${keepW}` : `(W-w)/2${signed(t.x)}*W`
  return { x, y: `(H-h/${keep})/2${signed(t.y)}*H+${frac(t.cropTop)}*h/${keep}` }
}

/** The crop filter for a transform (even sizes and offsets), or null with no crop. */
function cropFilter(t: Transform): string | null {
  const cl = cropLeftOf(t)
  const cr = cropRightOf(t)
  const sides = cl > 0 || cr > 0
  const ends = t.cropTop > 0 || t.cropBottom > 0
  if (!sides && !ends) return null
  const w = sides ? `round(iw*${frac(1 - cl - cr)}/2)*2` : "iw"
  const x = sides ? `round(iw*${frac(cl)}/2)*2` : "0"
  const h = ends ? `round(ih*${frac(1 - t.cropTop - t.cropBottom)}/2)*2` : "ih"
  const y = ends ? `round(ih*${frac(t.cropTop)}/2)*2` : "0"
  return `crop=${w}:${h}:${x}:${y}`
}

/**
 * A turned picture's crop: the cut sides made transparent in place (the frame
 * keeps its full scaled size, so its centre stays the content centre that
 * rotate turns about), on an RGBA frame.
 */
function cropBoxes(t: Transform): string[] {
  const box = (x: string, y: string, w: string, h: string) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@0:t=fill:replace=1`
  const boxes: string[] = []
  const cl = cropLeftOf(t)
  const cr = cropRightOf(t)
  if (t.cropTop > 0) boxes.push(box("0", "0", "iw", `round(ih*${frac(t.cropTop)})`))
  if (t.cropBottom > 0) boxes.push(box("0", `ih-round(ih*${frac(t.cropBottom)})`, "iw", `round(ih*${frac(t.cropBottom)})`))
  if (cl > 0) boxes.push(box("0", "0", `round(iw*${frac(cl)})`, "ih"))
  if (cr > 0) boxes.push(box(`iw-round(iw*${frac(cr)})`, "0", `round(iw*${frac(cr)})`, "ih"))
  return boxes
}

/**
 * The filters after the fit and the scale for a transform, in the canonical
 * order (lib/video/transform): flip, crop, rotate. With no rotation the crop
 * cuts the frame down (overlayPosition puts the strip back in place); turned,
 * the cut sides go transparent instead and rotate turns the frame about its
 * centre, the content centre, into a frame big enough to hold it (transparent
 * corners). The output keeps its alpha (yuva420p) when turned.
 *
 * A text's animation adds `afterFlips` (its alpha, lib/video/text-animation)
 * and `angle`, a turn in radians that changes with `t` (its spin, on top of
 * the rotation): the frame is then turned every frame into a square frame
 * that holds it at any angle.
 */
function transformFilters(t: Transform, anim: { afterFlips?: string[]; angle?: string } = {}): string[] {
  const flips = [...(t.flipH ? ["hflip"] : []), ...(t.flipV ? ["vflip"] : []), ...(anim.afterFlips ?? [])]
  const deg = rotationOf(t)
  if (deg === 0 && !anim.angle) {
    const crop = cropFilter(t)
    return [...flips, ...(crop ? [crop] : []), "setsar=1"]
  }
  const rad = frac((deg * Math.PI) / 180)
  const rotate = anim.angle ? `rotate=a='${anim.angle}':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=black@0` : `rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):c=black@0`
  return [...flips, "format=rgba", ...cropBoxes(t), rotate, "setsar=1", "format=yuva420p"]
}

/**
 * A text clip's in and out animations as filters, from the same expressions
 * the preview evaluates (lib/video/text-animation), each on the clip's own
 * time: `boxes`, the typewriter's (on its RGBA frame, before the flips);
 * `alpha`, a geq multiplying the alpha by the fade and a sweep's mask (after
 * the flips, while one runs); `angle`, the turn (radians, the rotation plus
 * a spin); `scale`, a resize of the finished frame about its centre (the
 * content centre: a turned frame is centred on it, and an unturned cropped
 * strip's overlay position scales with its size); and the overlay's x and y
 * with the slide or bounce added, on the timeline's time from `start`. Null
 * where nothing moves.
 */
function textAnimation(p: Project, c: Clip & { text: NonNullable<Clip["text"]> }) {
  const { width: W, height: H } = p
  const length = clipLength(c)
  const t = c.transform ?? IDENTITY
  const b = rotatedBounds(textSize(c.text, H), W, H, t)
  const x = animationExprs(c.text, length, { bounds: { x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H }, units: 0 })
  const local = `(t-${num(c.start)})`
  const window = alphaWindow(c.text, length)
  return {
    boxes: typewriterBoxes(c.text, length),
    alpha: x.alpha === null ? null : `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${printExpr(x.alpha, { t: "T" })}':enable='${window}'`,
    angle: x.rotationDeg === null ? null : `${frac((rotationOf(t) * Math.PI) / 180)}+${printExpr(x.rotationDeg, { t: "t" })}*PI/180`,
    scale: x.scale === null ? null : ((s: string) => `scale=w='max(2,trunc(iw*${s}/2)*2)':h='max(2,trunc(ih*${s}/2)*2)':eval=frame`)(printExpr(x.scale, { t: "t" })),
    x: x.offsetX === null ? null : `${printExpr(x.offsetX, { t: local })}*W`,
    y: x.offsetY === null ? null : `${printExpr(x.offsetY, { t: local })}*H`,
  }
}

/** The key a text clip's rasterised PNG has in buildExportGraph's `files`. */
export const textFileKey = (c: Clip) => `text:${c.id}`

/** Largest side (px) a text clip's PNG is drawn at; a bigger box is drawn smaller and scaled up. */
const MAX_TEXT_RASTER = 8192
/** Text is drawn at a multiple of this font size (px), which makes its content box whole pixels (lib/video/text's fractions are twentieths). */
const TEXT_FONT_STEP = 20

/**
 * A text clip's picture in the export: the font size (px) its PNG is drawn
 * at (rasteriseText), the first multiple of TEXT_FONT_STEP at or above its
 * size on the canvas (so it's scaled down, never up, unless the PNG would pass
 * MAX_TEXT_RASTER), and the frame it's scaled to: its content box at its
 * scale, in even pixels, as a scaled image is.
 */
export function textRaster(p: Project, c: Clip & { text: NonNullable<Clip["text"]> }): { fontPx: number; w: number; h: number } {
  const scale = (c.transform ?? IDENTITY).scale
  const box = textSize(c.text, p.height)
  const unit = textLayout(c.text, TEXT_FONT_STEP)
  const most = Math.max(1, Math.floor(MAX_TEXT_RASTER / Math.max(unit.w, unit.h)))
  const fontPx = TEXT_FONT_STEP * Math.min(most, Math.max(1, Math.ceil((baseFontPx(p.height) * scale) / TEXT_FONT_STEP - 1e-9)))
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2)
  return { fontPx, w: even(box.w * scale), h: even(box.h * scale) }
}

/**
 * The uniform graph, used when any clip is moved, scaled or cropped or the
 * base track has a gap: every clip, base track included, is overlaid on a
 * black canvas the timeline's length, track by track (lowest first) and
 * enabled for its own span, so a gap shows black (and is silent). A
 * transformed clip is fit inside the canvas, scaled (to even sizes), cropped
 * and placed as clipRect says; an untransformed one fills the canvas
 * letterboxed in black as it always has, so it hides what's under it in both
 * graphs. A flipped or turned clip follows the canonical order
 * (transformFilters). A text clip is its PNG (an image input) scaled to its
 * frame (textRaster), then flipped, cropped and turned the same way, keeping
 * its transparency. Audio as in the layered graph: each heard clip's sound delayed to
 * its start, over silence.
 *
 * Transitions: clips a track joins with transitions are one run. Each clip
 * of a run is extended by half of each of its transitions (centred on the
 * cut: the footage past its out point, before its in point, a still's frame
 * held), placed on a transparent canvas of its own as above, and xfade joins
 * the canvases one after another (the type is xfade's own name), each at the
 * start of its transition, so the run keeps its clips' places and length;
 * the run is overlaid like one clip. The sounds overlap by the same spans,
 * fading out and in (equal power). A clip in no run is placed as before, so a
 * project without transitions builds the same graph.
 */
function uniformGraph(p: Project, frame: string, fileFor: (c: Clip) => string, isImage: (c: Clip) => boolean): { graph: string; inputs: string[][] } {
  const { width: W, height: H, fps } = p
  const inputs: string[][] = []
  const parts: string[] = []
  const total = num(totalLength(p))
  parts.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${total},format=yuv420p[bg]`)
  const mix = ["[asil]"]
  /**
   * A clip's picture as stream [v<i>] on the timeline's time, and its sound
   * into the mix; the overlay's x, y options for it. `pre` and `post` extend it
   * (s) before its start and past its end for a transition: a video plays the
   * footage beyond its in and out points, a still holds its first and last
   * frame (tpad), and the sound fades in over 2 x pre and out over 2 x post
   * (equal power, qsin).
   */
  const source = (c: Clip, pre = 0, post = 0) => {
    const i = inputs.length
    const file = fileFor(c)
    const t = c.transform ?? IDENTITY
    const text = isTextClip(c) ? textRaster(p, c) : null
    const anim = isTextClip(c) && isAnimated(c.text) ? textAnimation(p, c) : null
    // The overlay position below puts a full-canvas frame at 0, 0.
    const place = text
      ? [
          `scale=${text.w}:${text.h}`, `setsar=1,fps=${fps},format=rgba`, ...(anim?.boxes ?? []),
          ...transformFilters(t, anim ? { ...(anim.alpha ? { afterFlips: [anim.alpha] } : {}), ...(anim.angle ? { angle: anim.angle } : {}) } : {}),
          ...(anim?.scale ? [anim.scale] : []),
        ].join(",")
      : isIdentity(c.transform)
      ? frame
      : [
          `scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1,fps=${fps}`,
          `scale=trunc(iw*${frac(t.scale)}/2)*2:trunc(ih*${frac(t.scale)}/2)*2`,
          ...transformFilters(t),
        ].join(",")
    const shift = `setpts=PTS+${num(c.start - pre)}/TB`
    if (isImage(c)) {
      inputs.push(["-loop", "1", "-framerate", String(fps), "-t", num(clipLength(c)), "-i", file])
      const hold = pre > 0 || post > 0 ? `,tpad=start_duration=${num(pre)}:stop_duration=${num(post)}:start_mode=clone:stop_mode=clone` : ""
      // A turned still keeps its transparent corners, and text its transparency.
      parts.push(`[${i}:v]setpts=PTS-STARTPTS,${place},format=${text || rotationOf(t) !== 0 ? "yuva420p" : "yuv420p"}${hold},${shift}[v${i}]`)
    } else {
      inputs.push(["-i", file])
      parts.push(`[${i}:v]trim=${num(c.in - pre)}:${num(c.out + post)},setpts=PTS-STARTPTS,${place},${shift}[v${i}]`)
      if (!c.muted && p.assets[c.asset]?.hasAudio !== false) {
        const fades = [
          ...(pre > 0 ? [`afade=t=in:st=0:d=${num(2 * pre)}:curve=qsin`] : []),
          ...(post > 0 ? [`afade=t=out:st=${num(clipLength(c) + pre - post)}:d=${num(2 * post)}:curve=qsin`] : []),
        ].map((f) => `${f},`).join("")
        parts.push(
          `[${i}:a]atrim=${num(c.in - pre)}:${num(c.out + post)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,${fades}adelay=delays=${Math.round((c.start - pre) * 48000)}S:all=1[a${i}]`
        )
        mix.push(`[a${i}]`)
      }
    }
    const { x, y } = overlayPosition(t, rotationOf(t) !== 0 || Boolean(anim?.angle))
    // A text that moves or changes size is placed afresh every frame.
    const moving = anim !== null && (anim.x !== null || anim.y !== null || anim.scale !== null)
    const at = moving ? `x='${x}${anim.x ? `+${anim.x}` : ""}':y='${y}${anim.y ? `+${anim.y}` : ""}':eval=frame` : `x=${x}:y=${y}:eval=init`
    return { label: `[v${i}]`, i, at }
  }
  // Each track's clips in runs joined by transitions; a clip with none is a run of its own.
  const runs: Clip[][] = []
  for (const track of p.tracks) {
    track.clips.forEach((c, k) => {
      if (k > 0 && c.transition && adjoins(track.clips[k - 1], c)) runs[runs.length - 1].push(c)
      else runs.push([c])
    })
  }
  let under = "[bg]"
  runs.forEach((run, n) => {
    const out = n === runs.length - 1 ? "[v]" : `[l${n + 1}]`
    const first = run[0]
    const last = run[run.length - 1]
    const end = last.start + clipLength(last)
    if (run.length === 1) {
      const s = source(first)
      parts.push(`${under}${s.label}overlay=${s.at}:enable='between(t,${num(first.start)},${num(end)})':eof_action=pass${out}`)
      under = out
      return
    }
    // A run with transitions: each clip, extended by half of each of its transitions, is placed on a
    // transparent canvas of its own, and xfade joins them, each at the start of its transition.
    let joined = ""
    run.forEach((c, k) => {
      const pre = c.transition && k > 0 ? c.transition.duration / 2 : 0
      const next = run[k + 1]
      const post = next?.transition ? next.transition.duration / 2 : 0
      const s = source(c, pre, post)
      const from = c.start - pre
      parts.push(`color=c=black@0:s=${W}x${H}:r=${fps}:d=${num(clipLength(c) + pre + post)},format=yuva420p,setpts=PTS+${num(from)}/TB[tc${s.i}]`)
      parts.push(`[tc${s.i}]${s.label}overlay=${s.at}:eof_action=pass:format=auto,setpts=PTS-STARTPTS[ts${s.i}]`)
      if (k === 0) {
        joined = `[ts${s.i}]`
        return
      }
      parts.push(`${joined}[ts${s.i}]xfade=transition=${c.transition!.type}:duration=${num(c.transition!.duration)}:offset=${num(from - first.start)}[tx${s.i}]`)
      joined = `[tx${s.i}]`
    })
    parts.push(`${joined}setpts=PTS+${num(first.start)}/TB[u${n}]`)
    parts.push(`${under}[u${n}]overlay=x=0:y=0:enable='between(t,${num(first.start)},${num(end)})':eof_action=pass${out}`)
    under = out
  })
  parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${total}[asil]`)
  parts.push(`${mix.join("")}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0[a]`)
  return { graph: parts.join(";"), inputs }
}

/**
 * The filtergraph text for the whole timeline, plus each clip's input
 * arguments (base track first, then each overlay track, in clip order).
 *
 * The base track is trimmed, letterboxed and concatenated as it always was;
 * with nothing on the overlay tracks that is the whole graph. With overlays,
 * the base stream goes over a black canvas the timeline's length, and every
 * overlay clip (shifted to its start) over that, lower tracks first, enabled
 * for its own span. Audio is the base track's (silence for a muted clip) plus each unmuted overlay clip's
 * (delayed to its start), mixed over silence the timeline's length. When any
 * clip has a transform, or the base track isn't one run of clips from 0 (a
 * gap), every clip is placed on the canvas instead (uniformGraph); otherwise
 * the graph is the same as it always was. A text clip (its PNG in `files`
 * under textFileKey) or a transition always takes the uniform graph.
 */
export function buildExportGraph(p: Project, files: Record<string, string>): { graph: string; inputs: string[][] } {
  if (allClips(p).length === 0) throw new Error("Nothing to export")
  const { width: W, height: H, fps } = p
  const inputs: string[][] = []
  const parts: string[] = []
  const frame = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`
  const fileFor = (c: Clip) => {
    const file = files[isTextClip(c) ? textFileKey(c) : c.asset]
    if (!file) throw new Error(isTextClip(c) ? "Missing text picture" : "Missing asset file")
    return file
  }
  // A still: an image's clip or a text clip's PNG.
  const isImage = (c: Clip) => isStill(p, c)
  if (allClips(p).some((c) => !isIdentity(c.transform) || isTextClip(c) || c.transition) || !isContiguousFromZero(p.tracks[0].clips)) return uniformGraph(p, frame, fileFor, isImage)

  // The base track: one concatenated stream, with silence where a clip has no sound (or is muted).
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
      p.assets[c.asset]?.hasAudio === false || c.muted
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
  const overlayClips = overlays.flatMap((t) => t.clips)
  overlayClips.forEach((c, n) => {
    const i = inputs.length
    const file = fileFor(c)
    const start = c.start
    const shift = `setpts=PTS+${num(start)}/TB`
    if (isImage(c)) {
      inputs.push(["-loop", "1", "-framerate", String(fps), "-t", num(clipLength(c)), "-i", file])
      parts.push(`[${i}:v]setpts=PTS-STARTPTS,${frame},format=yuv420p,${shift}[v${i}]`)
    } else {
      inputs.push(["-i", file])
      parts.push(`[${i}:v]trim=${num(c.in)}:${num(c.out)},setpts=PTS-STARTPTS,${frame},${shift}[v${i}]`)
      if (!c.muted && p.assets[c.asset]?.hasAudio !== false) {
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
