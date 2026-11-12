import "server-only"
import { execFile, spawn } from "child_process"
import fs from "fs/promises"
import { parsePictureSize, parseStreams, type ProbedStreams } from "./import"
import { ECHO_DELAYS, PHONE_BAND, sweepCutoff, tapeRates } from "./audio-fx"
import { audioLevelFilters, type ClipAudio } from "./audio-levels"
import { adjoins, allClips, clipLength, expandLoops, isAudioClip, isContiguousFromZero, isStill, isTextClip, totalLength, type Clip, type Project } from "./project"
import { baseFontPx, textLayout, textSize } from "./text"
import { alphaWindow, animationExprs, isAnimated, printExpr, typewriterBoxes } from "./text-animation"
import { cropLeftOf, cropRightOf, IDENTITY, isIdentity, rotatedBounds, rotationOf, type Transform } from "./transform"
import { customExpr, stepsFor, whipBlurFilters } from "./transition-expr"
import { CUT_AUDIO_FADE, isAudioCurve, isAudioTransitionType, isCustomTransition, isTransitionType, type AudioCurve, type EdgeTransition, type TransitionType } from "./transition-types"

/** The ffmpeg binary to run: FFMPEG_PATH, or "ffmpeg" on the PATH. */
export const ffmpegPath = () => process.env.FFMPEG_PATH || "ffmpeg"
const ffmpeg = ffmpegPath

/** Parses `ffmpeg -i` stderr: "Duration: 00:01:02.50" and an "Audio:" stream line. */
export function parseProbe(stderr: string): { duration: number; hasAudio: boolean } {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (!m) throw new Error("Couldn't read the video's length.")
  const duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return { duration, hasAudio: /Stream #[^\n]*Audio:/.test(stderr) }
}

/** `ffmpeg -i <file>` run with no output: it exits non-zero but prints the file's streams on stderr, which `read` parses. */
function probeWith<T>(file: string, read: (stderr: string) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg(), ["-hide_banner", "-i", file], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
      try {
        resolve(read(String(stderr ?? "")))
      } catch (parseError) {
        reject(err && (err as NodeJS.ErrnoException).code === "ENOENT" ? err : parseError)
      }
    })
  })
}

/** Length and whether there is sound. */
export function probeMedia(file: string): Promise<{ duration: number; hasAudio: boolean }> {
  return probeWith(file, parseProbe)
}

/**
 * What a file holds (lib/video/import parseStreams): its length (null when
 * ffmpeg gives none, as for a still), and whether it has a picture (cover art
 * doesn't count) and sound. Rejects only when ffmpeg can't run; a file it
 * can't read comes back with neither.
 */
export function probeStreams(file: string): Promise<ProbedStreams> {
  return probeWith(file, parseStreams)
}

const num = (n: number) => String(Number(n.toFixed(3)))
/** A transform fraction: six decimals keep the placement well under a pixel. */
const frac = (n: number) => String(Number(n.toFixed(6)))
const signed = (n: number) => `${n < 0 ? "-" : "+"}${frac(Math.abs(n))}`

/**
 * A clip's sound as the export takes it: cut from its source [from, to),
 * at 48 kHz stereo, then through its audio levels (gain, then its effects in
 * order) and cut back to `length` s, so an echo's or a reverb's tail doesn't
 * run on. Ends with a comma, ready for the next filter. The Audio levels
 * dialog's rendered preview (audio-preview-server) runs the same chain.
 */
export function clipSoundChain(from: number, to: number, audio: ClipAudio | undefined, length = to - from): string {
  const levelFilters = audioLevelFilters(audio)
  const levels = levelFilters.length > 0 ? `${levelFilters.join(",")},atrim=end=${num(length)},` : ""
  return `atrim=${num(from)}:${num(to)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,${levels}`
}

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
  const b = rotatedBounds(textSize(c.text, Math.min(W, H)), W, H, t)
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
  const box = textSize(c.text, Math.min(p.width, p.height))
  const unit = textLayout(c.text, TEXT_FONT_STEP)
  const most = Math.max(1, Math.floor(MAX_TEXT_RASTER / Math.max(unit.w, unit.h)))
  const fontPx = TEXT_FONT_STEP * Math.min(most, Math.max(1, Math.ceil((baseFontPx(Math.min(p.width, p.height)) * scale) / TEXT_FONT_STEP - 1e-9)))
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2)
  return { fontPx, w: even(box.w * scale), h: even(box.h * scale) }
}

/**
 * A piece of a clip's sound worked on its own: source seconds [from, to)
 * through `filters`, giving `out` seconds. With `rates`, it plays as that many
 * equal stretches of output, each at its rate (pitch and speed together, a
 * tape's), and then `filters`.
 */
type Piece = { from: number; to: number; out: number; filters: string[]; rates?: number[] }

/**
 * A clip's sound in the uniform graph: `pre` seconds of it before its start
 * and `post` past its end, fading in over `fadeIn` from its first sample (or
 * from `inAt` s into it) and out over `fadeOut` to its last (or from `outAt`)
 * (0: no fade), on ffmpeg's afade curves. A creative transition or edge
 * works its first (`head`) or last (`tail`) stretch on its own (Piece); the
 * rest (the main stretch) plays as it is, `shorten` seconds less of it at the
 * end (a tape start's head takes that time).
 */
type SoundSpan = {
  pre: number; post: number; fadeIn: number; fadeOut: number; inCurve: string; outCurve: string
  inAt?: number; outAt?: number; head?: Piece; tail?: Piece; shorten?: number
}

/** ffmpeg's afade curve for each audio crossfade (and edge fade) curve. */
export const AFADE_CURVE: Record<AudioCurve, string> = { "audio-linear": "tri", "audio-equalpower": "qsin", "audio-scurve": "hsin", "audio-log": "log", "audio-exp": "exp" }

/** A low-pass sweep's steps. */
const SWEEP_STEPS = 8

/** A low-pass sweep over `d` s as filters: the cutoff steps down from SWEEP_OPEN to SWEEP_CLOSED (`closing`) or up, each step enabled for its slice of the piece's time. */
function sweep(d: number, closing: boolean): string[] {
  return Array.from({ length: SWEEP_STEPS }, (_, k) => {
    const f = Math.round(sweepCutoff((k + 0.5) / SWEEP_STEPS, closing))
    return `lowpass=f=${f}:enable='between(t,${num((k * d) / SWEEP_STEPS)},${num(((k + 1) * d) / SWEEP_STEPS)})'`
  })
}

const fadeUp = (d: number) => `afade=t=in:st=0:d=${num(d)}:curve=qsin`
const fadeDown = (at: number, d: number) => `afade=t=out:st=${num(at)}:d=${num(d)}:curve=qsin`

/** An echo trail over `out` s: the dry sound (`src` s of it, its last 30% faded) padded with silence, echoed (ECHO_DELAYS), its last half faded away. */
const echoTail = (src: number, out: number) => [
  fadeDown(src * 0.7, src * 0.3), `apad=whole_dur=${num(out)}`, `aecho=0.8:0.9:${ECHO_DELAYS.map((e) => Math.round(e.delay * 1000)).join("|")}:${ECHO_DELAYS.map((e) => e.decay).join("|")}`,
  `atrim=0:${num(out)}`, fadeDown(out / 2, out / 2),
]

/** The telephone band's filters, on until `until` s into the piece (always when absent). */
const phone = (until?: number) => {
  const on = until === undefined ? "" : `:enable='lt(t,${num(until)})'`
  return [`highpass=f=${PHONE_BAND.low}${on}`, `lowpass=f=${PHONE_BAND.high}${on}`]
}

/**
 * Where the sound of `clips[k]` (one track's) runs. A transition at a cut
 * overlaps the two sounds by half its length each way, crossfading them
 * (equal power, qsin, over the whole transition). An audio overlap at the cut
 * replaces that: a J-cut starts the incoming sound its length before the cut
 * and an L-cut runs the outgoing one on that long past it, with a linear fade
 * (tri) of CUT_AUDIO_FADE (at most the overlap) at the new edge; the other
 * sound cuts at the cut. Never before the timeline's 0 or the source's start,
 * nor past the source's end.
 *
 * Between audio clips the transition's own type decides: a curve crossfades
 * on its afade curve (AFADE_CURVE), Dip to silence fades the outgoing sound
 * out over the first 40% and the incoming one in over the last 40%, and the
 * creative ones work the outgoing sound's last stretch (a low-pass sweep or a
 * telephone band while it fades over the transition; a tape stop or an echo
 * trail from half the transition before its out point, the transition long)
 * while the incoming one fades in (in the telephone band for its first three
 * quarters, for the telephone swap). At a free edge a picture clip's sound
 * fades with its picture (equal power), and an audio clip's as its edge
 * transition says, inside the clip.
 */
function soundSpan(p: Project, clips: Clip[], k: number): SoundSpan {
  const c = clips[k]
  const next = clips[k + 1]
  const span: SoundSpan = { pre: 0, post: 0, fadeIn: 0, fadeOut: 0, inCurve: "qsin", outCurve: "qsin" }
  // What a creative type works on its own, built once pre and post are known.
  let head: ((s: SoundSpan) => void) | null = null
  let tail: ((s: SoundSpan) => void) | null = null
  const length = clipLength(c)
  const audioClip = isAudioClip(p, c)
  if (k > 0 && adjoins(clips[k - 1], c)) {
    const a = c.cutAudio
    const tr = c.transition
    if (a?.mode === "j") Object.assign(span, { pre: a.duration, fadeIn: Math.min(CUT_AUDIO_FADE, a.duration), inCurve: "tri" })
    else if (!a && tr && isAudioTransitionType(tr.type)) {
      const d = tr.duration
      if (isAudioCurve(tr.type)) Object.assign(span, { pre: d / 2, fadeIn: d, inCurve: AFADE_CURVE[tr.type] })
      else if (tr.type === "audio-dip") Object.assign(span, { inAt: 0.1 * d, fadeIn: 0.4 * d })
      else if (tr.type === "audio-telephone") {
        span.pre = d / 2
        head = (s) => {
          s.head = { from: c.in - s.pre, to: c.in + d / 2, out: s.pre + d / 2, filters: [...phone(0.75 * (s.pre + d / 2)), fadeUp(s.pre + d / 2)] }
        }
      } else Object.assign(span, { pre: d / 2, fadeIn: d })
    } else if (!a && tr) Object.assign(span, { pre: tr.duration / 2, fadeIn: tr.duration })
  } else if (c.edgeIn) {
    const e = c.edgeIn
    const d = e.duration
    if (!audioClip || isAudioCurve(e.type)) Object.assign(span, { fadeIn: d, inCurve: audioClip && isAudioCurve(e.type) ? AFADE_CURVE[e.type] : "qsin" })
    else if (e.type === "audio-lowpass") head = (s) => { s.head = { from: c.in, to: c.in + d, out: d, filters: [...sweep(d, false), fadeUp(d)] } }
    else if (e.type === "audio-tapestop") head = (s) => { Object.assign(s, { head: { from: c.in, to: c.in + d / 2, out: d, rates: tapeRates(false), filters: [fadeUp(0.3 * d)] }, shorten: d / 2 }) }
  }
  if (adjoins(c, next)) {
    const a = next!.cutAudio
    const tr = next!.transition
    if (a?.mode === "l") Object.assign(span, { post: a.duration, fadeOut: Math.min(CUT_AUDIO_FADE, a.duration), outCurve: "tri" })
    else if (!a && tr && isAudioTransitionType(tr.type)) {
      const d = tr.duration
      if (isAudioCurve(tr.type)) Object.assign(span, { post: d / 2, fadeOut: d, outCurve: AFADE_CURVE[tr.type] })
      else if (tr.type === "audio-dip") tail = (s) => { Object.assign(s, { outAt: s.pre + length - d / 2, fadeOut: 0.4 * d }) }
      else if (tr.type === "audio-lowpass" || tr.type === "audio-telephone") {
        span.post = d / 2
        tail = (s) => {
          const out = d / 2 + s.post
          s.tail = { from: c.out - d / 2, to: c.out + s.post, out, filters: [...(tr.type === "audio-lowpass" ? sweep(out, true) : phone()), fadeDown(0, out)] }
        }
      } else if (tr.type === "audio-tapestop") tail = (s) => { s.tail = { from: c.out - d / 2, to: c.out, out: d, rates: tapeRates(true), filters: [fadeDown(0.7 * d, 0.3 * d)] } }
      else tail = (s) => { s.tail = { from: c.out - d / 2, to: c.out, out: d, filters: echoTail(d / 2, d) } }
    } else if (!a && tr) Object.assign(span, { post: tr.duration / 2, fadeOut: tr.duration })
  } else if (c.edgeOut) {
    const e = c.edgeOut
    const d = e.duration
    if (!audioClip || isAudioCurve(e.type)) Object.assign(span, { fadeOut: d, outCurve: audioClip && isAudioCurve(e.type) ? AFADE_CURVE[e.type] : "qsin" })
    else if (e.type === "audio-lowpass") tail = (s) => { s.tail = { from: c.out - d, to: c.out, out: d, filters: [...sweep(d, true), fadeDown(0, d)] } }
    else if (e.type === "audio-tapestop") tail = (s) => { s.tail = { from: c.out - d, to: c.out - d / 2, out: d, rates: tapeRates(true), filters: [fadeDown(0.7 * d, 0.3 * d)] } }
    else if (e.type === "audio-echo") tail = (s) => { s.tail = { from: c.out - d, to: c.out - d / 2, out: d, filters: echoTail(d / 2, d) } }
  }
  // A forged or stale project can ask for more than there is: no negative delay, no sound from before the source or past its end.
  const pre = Math.max(0, Math.min(span.pre, c.in, c.start))
  if (pre < span.pre) Object.assign(span, { pre, fadeIn: Math.min(span.fadeIn, pre) })
  const asset = Object.hasOwn(p.assets, c.asset) ? p.assets[c.asset] : undefined
  const post = Math.max(0, Math.min(span.post, asset ? asset.duration - c.out : 0))
  if (post < span.post) Object.assign(span, { post, fadeOut: Math.min(span.fadeOut, post) })
  head?.(span)
  tail?.(span)
  return span
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
 * the canvases one after another (the type is xfade's own name; the app's own
 * transitions are xfade's custom expression on planar RGB, from
 * lib/video/transition-expr, a whip's motion blur gblur after it), each at the
 * start of its transition, so the run keeps its clips' places and length;
 * the run is overlaid like one clip. The sounds overlap by the same spans,
 * fading out and in (equal power). A clip in no run is placed as before, so a
 * project without transitions builds the same graph.
 *
 * Audio overlaps (J- and L-cuts) move only the sound (soundSpan): the
 * incoming clip's starts early or the outgoing clip's runs on, mixed with
 * the other clip's as it is (no ducking); the pictures are unchanged.
 *
 * The audio layer's clips (inputs after every picture's) add only their
 * sound, trimmed and delayed to their start like a video clip's (silent when
 * muted); with no picture clip at all the canvas stays black. Their audio
 * transitions shape the two sounds at a cut (soundSpan); nothing else moves.
 *
 * Audio levels (Clip.audio, lib/video/audio-levels): a clip's sound goes
 * through its gain and its effects in order right after it's cut from the
 * source (atrim, asetpts) and before its fades, delay and the mix, and is cut
 * back to its own length after them. A muted clip has no sound to process.
 *
 * Edge transitions: a clip with an in or out edge transition takes the run
 * path (a run of its own), and its run's joined picture is xfaded with a copy
 * of itself whose alpha is 0 (edgeOf), so the effect uncovers or covers the
 * layers under it; its sound fades with it (soundSpan).
 */
function uniformGraph(p: Project, frame: string, fileFor: (c: Clip) => string, isImage: (c: Clip) => boolean): { graph: string; inputs: string[][] } {
  const { width: W, height: H, fps } = p
  const inputs: string[][] = []
  const parts: string[] = []
  const total = num(totalLength(p))
  parts.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${total},format=yuv420p[bg]`)
  const mix = ["[asil]"]
  const sounds = new Map<string, SoundSpan>()
  for (const track of p.tracks) track.clips.forEach((c, k) => sounds.set(c.id, soundSpan(p, track.clips, k)))
  const audioClips = p.audioTrack?.clips ?? []
  audioClips.forEach((c, k) => sounds.set(c.id, soundSpan(p, audioClips, k)))
  /** Input `i`'s sound for clip `c` into the mix, as soundSpan says (nothing when it's muted or its file has none). */
  const sound = (c: Clip, i: number) => {
    if (c.muted || p.assets[c.asset]?.hasAudio === false) return
    const a = sounds.get(c.id)!
    // The main stretch: between any head and tail piece, `shorten` less at its end.
    const mainFrom = a.head ? a.head.to : c.in - a.pre
    const mainTo = (a.tail ? a.tail.from : c.out + a.post) - (a.shorten ?? 0)
    const total = (a.head?.out ?? 0) + (mainTo - mainFrom) + (a.tail?.out ?? 0)
    const fades = [
      ...(a.fadeIn > 0 ? [`afade=t=in:st=${num(a.inAt ?? 0)}:d=${num(a.fadeIn)}:curve=${a.inCurve}`] : []),
      ...(a.fadeOut > 0 ? [`afade=t=out:st=${num(a.outAt ?? (a.head || a.tail ? total : clipLength(c) + a.pre + a.post) - a.fadeOut)}:d=${num(a.fadeOut)}:curve=${a.outCurve}`] : []),
    ].map((f) => `${f},`).join("")
    const delay = `adelay=delays=${Math.round((c.start - a.pre) * 48000)}S:all=1[a${i}]`
    // The clip's audio levels (gain, then its effects in order) before the fades, cut back to the stretch's length (an echo's or a reverb's tail would run on).
    const levelFilters = audioLevelFilters(c.audio)
    const levels = (length: number) => (levelFilters.length > 0 ? `${levelFilters.join(",")},atrim=end=${num(length)},` : "")
    if (!a.head && !a.tail) {
      parts.push(`[${i}:a]${clipSoundChain(c.in - a.pre, c.out + a.post, c.audio, clipLength(c) + a.pre + a.post)}${fades}${delay}`)
      mix.push(`[a${i}]`)
      return
    }
    // Pieces worked on their own (a creative transition or edge), joined end to end: each stretch is cut from its own copy of the sound.
    const pieces: Piece[] = [...(a.head ? [a.head] : []), { from: mainFrom, to: mainTo, out: mainTo - mainFrom, filters: [] }, ...(a.tail ? [a.tail] : [])]
    const cuts = pieces.flatMap((piece) => (piece.rates ? piece.rates.map((rate, k) => ({ rate, from: piece.from + ((piece.to - piece.from) * k) / piece.rates!.length, to: piece.from + ((piece.to - piece.from) * (k + 1)) / piece.rates!.length })) : [{ rate: 1, from: piece.from, to: piece.to }]))
    parts.push(`[${i}:a]asplit=${cuts.length}${cuts.map((_, k) => `[s${i}x${k}]`).join("")}`)
    let n = 0
    const joined = pieces.map((piece, j) => {
      const own = (piece.rates ?? [1]).map(() => {
        const cut = cuts[n]
        const label = `[s${i}y${n}]`
        // A tape's stretch at its speed: the samples relabelled at a lower rate (slower and lower), then resampled.
        const speed = piece.rates ? `,asetrate=${Math.round(48000 * cut.rate)},aresample=48000` : ""
        parts.push(`[s${i}x${n}]atrim=${num(cut.from)}:${num(cut.to)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo${speed}${label}`)
        n++
        return label
      })
      const after = piece.filters.length > 0 ? `,${piece.filters.join(",")}` : ""
      parts.push(`${own.join("")}${own.length > 1 ? `concat=n=${own.length}:v=0:a=1` : "anull"}${after}[s${i}p${j}]`)
      return `[s${i}p${j}]`
    })
    parts.push(`${joined.join("")}concat=n=${joined.length}:v=0:a=1,${levels(total)}${fades}${delay}`)
    mix.push(`[a${i}]`)
  }
  /**
   * A clip's picture as stream [v<i>] on the timeline's time, and its sound
   * into the mix; the overlay's x, y options for it. `pre` and `post` extend the
   * picture (s) before its start and past its end for a transition: a video
   * plays the footage beyond its in and out points, a still holds its first
   * and last frame (tpad). The sound runs as soundSpan says.
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
      sound(c, i)
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
  /**
   * A run's in or out edge transition on its joined stream (`joined`, on its
   * own time from 0, `length` long): xfade between the run and a copy of it
   * with its alpha set to 0 (the same picture, transparent), so the effect
   * uncovers or covers whatever is under the run. The in edge fades from the
   * copy's first `d` s into the run; the out edge from the run into the
   * copy's last `d` s. The app's own transitions work on planar RGB, as at a cut.
   */
  const edgeOf = (joined: string, edge: "in" | "out", e: EdgeTransition, length: number, n: number): string => {
    const type = e.type as TransitionType
    const d = e.duration
    const id = `${edge === "in" ? "ei" : "eo"}${n}`
    parts.push(`${joined}format=yuva420p,split[${id}r][${id}c]`)
    const copy = edge === "in" ? `trim=duration=${num(d)}` : `trim=start=${num(length - d)}`
    parts.push(`[${id}c]${copy},setpts=PTS-STARTPTS,lutyuv=a=0[${id}t]`)
    const [a, b] = edge === "in" ? [`[${id}t]`, `[${id}r]`] : [`[${id}r]`, `[${id}t]`]
    const timing = `duration=${num(d)}:offset=${num(edge === "in" ? 0 : length - d)}`
    if (isCustomTransition(type)) {
      const blur = whipBlurFilters(type, W, H, edge === "in" ? 0 : length - d, d).map((f) => `,${f}`).join("")
      parts.push(`${a}format=gbrap[${id}a]`, `${b}format=gbrap[${id}b]`)
      parts.push(`[${id}a][${id}b]xfade=transition=custom:${timing}:expr='${customExpr(type, W / H, stepsFor(d, fps))}',format=yuva420p${blur}[${id}x]`)
    } else {
      parts.push(`${a}${b}xfade=transition=${type}:${timing}[${id}x]`)
    }
    return `[${id}x]`
  }
  let under = "[bg]"
  runs.forEach((run, n) => {
    const out = n === runs.length - 1 ? "[v]" : `[l${n + 1}]`
    const first = run[0]
    const last = run[run.length - 1]
    const end = last.start + clipLength(last)
    // Picture edge transitions only (a text clip has none; parse keeps it so).
    const edgeIn = first.edgeIn && isTransitionType(first.edgeIn.type) ? first.edgeIn : undefined
    const edgeOut = last.edgeOut && isTransitionType(last.edgeOut.type) ? last.edgeOut : undefined
    if (run.length === 1 && !edgeIn && !edgeOut) {
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
      const type = c.transition!.type as TransitionType
      const timing = `duration=${num(c.transition!.duration)}:offset=${num(from - first.start)}`
      if (isCustomTransition(type)) {
        // The app's own transitions: xfade's custom expression on planar RGB (lib/video/transition-expr), a whip's blur after it.
        const blur = whipBlurFilters(type, W, H, from - first.start, c.transition!.duration).map((f) => `,${f}`).join("")
        parts.push(`${joined}format=gbrap[ga${s.i}]`, `[ts${s.i}]format=gbrap[gb${s.i}]`)
        parts.push(`[ga${s.i}][gb${s.i}]xfade=transition=custom:${timing}:expr='${customExpr(type, W / H, stepsFor(c.transition!.duration, fps))}',format=yuva420p${blur}[tx${s.i}]`)
      } else {
        parts.push(`${joined}[ts${s.i}]xfade=transition=${type}:${timing}[tx${s.i}]`)
      }
      joined = `[tx${s.i}]`
    })
    if (edgeIn) joined = edgeOf(joined, "in", edgeIn, end - first.start, n)
    if (edgeOut) joined = edgeOf(joined, "out", edgeOut, end - first.start, n)
    parts.push(`${joined}setpts=PTS+${num(first.start)}/TB[u${n}]`)
    parts.push(`${under}[u${n}]overlay=x=0:y=0:enable='between(t,${num(first.start)},${num(end)})':eof_action=pass${out}`)
    under = out
  })
  // Nothing but audio clips: the picture is the black canvas.
  if (runs.length === 0) parts.push("[bg]null[v]")
  // The audio layer's clips: sound only, mixed like a video clip's.
  for (const c of audioClips) {
    const i = inputs.length
    inputs.push(["-i", fileFor(c)])
    sound(c, i)
  }
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
 * under textFileKey), a transition, an audio overlap, an edge transition,
 * audio levels (Clip.audio) or a clip on the audio layer always takes the
 * uniform graph.
 */
export function buildExportGraph(project: Project, files: Record<string, string>): { graph: string; inputs: string[][] } {
  // A looping clip exports as its back-to-back copies; everything below sees plain clips.
  const p = expandLoops(project)
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
  if (
    (p.audioTrack?.clips.length ?? 0) > 0 ||
    allClips(p).some((c) => !isIdentity(c.transform) || isTextClip(c) || c.transition || c.cutAudio || c.edgeIn || c.edgeOut || c.audio) ||
    !isContiguousFromZero(p.tracks[0].clips)
  ) return uniformGraph(p, frame, fileFor, isImage)


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
 * last stderr line. Always settles, even if removing the file fails. An
 * aborted `signal` kills it the same way ("Cancelled.").
 */
export function runExport(
  args: string[],
  outFile: string,
  totalSeconds: number,
  onProgress: (fraction: number) => void,
  timeoutMs: number = exportTimeoutMs(totalSeconds),
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Cancelled."))
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
    const cancel = () => fail("Cancelled.")
    signal?.addEventListener("abort", cancel, { once: true })
    child.once("close", () => signal?.removeEventListener("abort", cancel))
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

/** A file's picture size as shown (turned phone video comes back upright), or null when ffmpeg finds no picture. */
export function probePictureSize(file: string): Promise<{ width: number; height: number } | null> {
  return probeWith(file, parsePictureSize)
}
