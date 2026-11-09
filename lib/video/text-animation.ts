import { fontById, lineWidth } from "./fonts"
import { textLayout, type AnimType, type ClipText, type TextAnim } from "./text"

// A text clip's in and out animations (lib/video/text: animIn, animOut). The
// maths is written once, as small expressions (E below): the preview
// evaluates them at the playhead (animationState) and the export prints the
// very same expressions into ffmpeg's filters (textAnimationFilters), so the
// two agree by construction.
//
// Timing, in the clip's own time t (0 at its start, `length` at its end): the
// in animation runs over [0, in), the out one over (length - out, length];
// they never overlap (fitAnims keeps in + out within the clip) and between
// them the text rests as the user placed it. Progress p runs 0 to 1 towards
// the rest: for in p = t / in, for out p = (length - t) / out, so an out
// animation is its in animation played backwards. Most types ease with
// e = 1 - (1 - p)^3: ease-out coming in, which is ease-in going out.
//
// Each type, at p (1 is at rest):
// - fade: opacity e.
// - slide (left, right, up, down): the whole text travels in from beyond
//   that canvas edge (out: off past it); the distance puts the text's turned
//   bounds just outside the canvas.
// - sweep (left, right, up, down): a wipe inside the text's own box, the
//   revealed part growing from that side (out: shrinking back towards it),
//   in the box's axes after its flips (so on screen when it isn't turned).
// - explode: scale 1 + (1 - e) (twice the size at p 0) and opacity e: in, it
//   lands from large; out, it bursts outwards as it fades.
// - implode: scale e and opacity e: out, it shrinks away to nothing; in, it
//   grows out of a point (the backwards of its out).
// - pop: scale with a small overshoot (ease-out-back), no fade.
// - spin: rotation -360 (1 - e) degrees and scale e.
// - bounce: drops in from above the canvas with bounces (ease-out-bounce); out,
//   the same played backwards but downwards, falling off the bottom.
// - typewriter: the characters show one by one in reading order (vertical
//   text top to bottom), in equal steps; out, they go from the end. A text of
//   more than MAX_TYPE_STEPS characters steps by blocks of characters.
// Offsets are fractions of the canvas, scale and rotation are about the
// content centre, all on top of the clip's own transform.

/** A side of the canvas, or of the text's box. */
export type Side = "left" | "right" | "up" | "down"
export type AnimState = {
  opacity: number
  /** Canvas widths and heights. */
  offsetX: number
  offsetY: number
  scale: number
  rotationDeg: number
  /** A sweep: the fraction of the box shown, from `dir`'s side. */
  reveal: { dir: Side; fraction: number } | null
  /** Typewriter: how many characters show. */
  chars: number | null
}
/** What animationState needs to know about the text where it rests: its turned bounds on the canvas (fractions of it) and its typewriter units. */
export type AnimGeometry = { bounds: { x: number; y: number; w: number; h: number }; units: number }

export const REST: AnimState = { opacity: 1, offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, reveal: null, chars: null }
/** A typewriter shows at most this many steps; a longer text steps by blocks of characters. */
export const MAX_TYPE_STEPS = 100
const EXPLODE_SCALE = 2

/** Every animation type with how the Edit text dialog names it, in groups; `out` is the name for an out animation where it differs. */
export const ANIM_GROUPS: { label: string; types: { type: AnimType; label: string; out?: string }[] }[] = [
  { label: "Fade", types: [{ type: "fade", label: "Fade" }] },
  {
    label: "Slide",
    types: [
      { type: "slide-left", label: "Slide from left", out: "Slide to left" },
      { type: "slide-right", label: "Slide from right", out: "Slide to right" },
      { type: "slide-up", label: "Slide from top", out: "Slide to top" },
      { type: "slide-down", label: "Slide from bottom", out: "Slide to bottom" },
    ],
  },
  {
    label: "Sweep",
    types: [
      { type: "sweep-left", label: "Sweep from left", out: "Sweep to left" },
      { type: "sweep-right", label: "Sweep from right", out: "Sweep to right" },
      { type: "sweep-up", label: "Sweep from top", out: "Sweep to top" },
      { type: "sweep-down", label: "Sweep from bottom", out: "Sweep to bottom" },
    ],
  },
  {
    label: "Scale",
    types: [
      { type: "explode", label: "Explode" },
      { type: "implode", label: "Implode" },
      { type: "pop", label: "Pop" },
      { type: "spin", label: "Spin" },
      { type: "bounce", label: "Bounce" },
    ],
  },
  { label: "Text", types: [{ type: "typewriter", label: "Typewriter" }] },
]

// Expressions: a number, a variable or an operation. They evaluate in JS and print as ffmpeg expressions.
type Op = "+" | "-" | "*" | "/" | "pow" | "lt" | "gt" | "gte" | "if" | "clip" | "max" | "min" | "floor"
export type E = number | { v: string } | { op: Op; args: E[] }

const FN: Record<Op, (...a: number[]) => number> = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  pow: (a, b) => Math.pow(a, b),
  lt: (a, b) => (a < b ? 1 : 0),
  gt: (a, b) => (a > b ? 1 : 0),
  gte: (a, b) => (a >= b ? 1 : 0),
  if: (c, a, b) => (c !== 0 ? a : b),
  clip: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
  max: (a, b) => Math.max(a, b),
  min: (a, b) => Math.min(a, b),
  floor: (a) => Math.floor(a),
}

/** An operation, worked out at once when its arguments are numbers. */
function op(o: Op, ...args: E[]): E {
  if (args.every((a) => typeof a === "number")) return FN[o](...(args as number[]))
  if (o === "if" && typeof args[0] === "number") return args[0] !== 0 ? args[1] : args[2]
  if (o === "*" && (args[0] === 0 || args[1] === 0)) return 0
  if (o === "*" && args[0] === 1) return args[1]
  if (o === "*" && args[1] === 1) return args[0]
  if ((o === "+" || o === "-") && args[1] === 0) return args[0]
  return { op: o, args }
}
const V = (name: string): E => ({ v: name })
const add = (a: E, b: E) => op("+", a, b)
const sub = (a: E, b: E) => op("-", a, b)
const mul = (a: E, b: E) => op("*", a, b)
const div = (a: E, b: E) => op("/", a, b)
const pow = (a: E, b: E) => op("pow", a, b)
const lt = (a: E, b: E) => op("lt", a, b)
const gt = (a: E, b: E) => op("gt", a, b)
const gte = (a: E, b: E) => op("gte", a, b)
const iff = (c: E, a: E, b: E) => op("if", c, a, b)
const clip01 = (x: E) => op("clip", x, 0, 1)

/** `e`'s value with `vars` for its variables. */
export function evaluate(e: E, vars: Record<string, number>): number {
  if (typeof e === "number") return e
  if ("v" in e) return vars[e.v]
  return FN[e.op](...e.args.map((a) => evaluate(a, vars)))
}

const fmt = (n: number) => {
  const s = String(Number(n.toFixed(6)))
  return n < 0 && s !== "0" ? `(${s})` : s
}

/** `e` as an ffmpeg expression, each variable written as `vars` says. */
export function printExpr(e: E, vars: Record<string, string>): string {
  if (typeof e === "number") return fmt(e)
  if ("v" in e) return vars[e.v] ?? e.v
  const a = e.args.map((x) => printExpr(x, vars))
  return e.op === "+" || e.op === "-" || e.op === "*" || e.op === "/" ? `(${a[0]}${e.op}${a[1]})` : `${e.op}(${a.join(",")})`
}

const easeOut = (p: E) => sub(1, pow(sub(1, p), 3))
/** Ease-out-back: overshoots by about 10% before it settles. */
const easeBack = (p: E) => add(add(1, mul(2.70158, pow(sub(p, 1), 3))), mul(1.70158, pow(sub(p, 1), 2)))
/** Ease-out-bounce: three bounces, each smaller, before it settles. */
function easeBounce(x: E): E {
  const n = 7.5625
  const d = 2.75
  return iff(
    lt(x, 1 / d), mul(n, pow(x, 2)),
    iff(
      lt(x, 2 / d), add(mul(n, pow(sub(x, 1.5 / d), 2)), 0.75),
      iff(lt(x, 2.5 / d), add(mul(n, pow(sub(x, 2.25 / d), 2)), 0.9375), add(mul(n, pow(sub(x, 2.625 / d), 2)), 0.984375))
    )
  )
}

type Channel = "opacity" | "offsetX" | "offsetY" | "scale" | "rotationDeg" | "reveal"
type Channels = Partial<Record<Channel, E>>

const sideOf = (type: AnimType): Side => type.slice(type.indexOf("-") + 1) as Side

/** A type's state at progress `p` (1: at rest) as expressions; `out` for an out animation. */
function channels(type: AnimType, p: E, out: boolean, geo: AnimGeometry): Channels {
  const e = easeOut(p)
  const b = geo.bounds
  switch (type) {
    case "fade":
      return { opacity: e }
    case "slide-left":
      return { offsetX: mul(sub(1, e), -(b.x + b.w)) }
    case "slide-right":
      return { offsetX: mul(sub(1, e), 1 - b.x) }
    case "slide-up":
      return { offsetY: mul(sub(1, e), -(b.y + b.h)) }
    case "slide-down":
      return { offsetY: mul(sub(1, e), 1 - b.y) }
    case "sweep-left":
    case "sweep-right":
    case "sweep-up":
    case "sweep-down":
      return { reveal: e }
    case "explode":
      return { scale: add(1, mul(EXPLODE_SCALE - 1, sub(1, e))), opacity: e }
    case "implode":
      return { scale: e, opacity: e }
    case "pop":
      return { scale: easeBack(p) }
    case "spin":
      return { rotationDeg: mul(-360, sub(1, e)), scale: e }
    case "bounce":
      return { offsetY: mul(sub(1, easeBounce(p)), out ? 1 - b.y : -(b.y + b.h)) }
    case "typewriter":
      return {}
  }
}

/** Typewriter: the characters showing at progress `p` of `units`, in equal steps (blocks of characters past MAX_TYPE_STEPS). */
export function typeChars(p: number, units: number): number {
  const block = Math.max(1, Math.ceil(units / MAX_TYPE_STEPS))
  const steps = Math.ceil(units / block)
  return Math.min(units, Math.floor(p * steps + 1e-9) * block)
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/** The animation playing at clip time `t` and its progress (1: at rest), or null between them. */
function phase(text: Pick<ClipText, "animIn" | "animOut">, t: number, length: number): { anim: TextAnim; p: number; out: boolean } | null {
  if (text.animIn && t < text.animIn.duration) return { anim: text.animIn, p: clamp01(t / text.animIn.duration), out: false }
  if (text.animOut && t > length - text.animOut.duration) return { anim: text.animOut, p: clamp01((length - t) / text.animOut.duration), out: true }
  return null
}

const WHOLE: AnimGeometry = { bounds: { x: 0, y: 0, w: 1, h: 1 }, units: 1 }

/** True when the text has an in or an out animation. */
export const isAnimated = (text: Pick<ClipText, "animIn" | "animOut">) => text.animIn !== undefined || text.animOut !== undefined

/** How long the text rests between its in and out in the dialog's looping demo (seconds). */
export const DEMO_HOLD = 1

/** The length of a looping demo of the animations (in, a rest, out), or null when there are none. */
export function demoLength(text: Pick<ClipText, "animIn" | "animOut">): number | null {
  return isAnimated(text) ? (text.animIn?.duration ?? 0) + DEMO_HOLD + (text.animOut?.duration ?? 0) : null
}

/** How the text shows at clip time `t` (seconds from its start) of a clip `length` long; `geo` says where it rests (slides, bounce) and its typewriter units. */
export function animationState(text: Pick<ClipText, "animIn" | "animOut">, t: number, length: number, geo: AnimGeometry = WHOLE): AnimState {
  const at = phase(text, t, length)
  if (!at) return REST
  const { type } = at.anim
  const c = channels(type, at.p, at.out, geo)
  const num = (e: E | undefined, rest: number) => (e === undefined ? rest : evaluate(e, {}))
  return {
    opacity: num(c.opacity, 1),
    offsetX: num(c.offsetX, 0),
    offsetY: num(c.offsetY, 0),
    scale: num(c.scale, 1),
    rotationDeg: num(c.rotationDeg, 0),
    reveal: c.reveal === undefined ? null : { dir: sideOf(type), fraction: num(c.reveal, 1) },
    chars: type === "typewriter" ? typeChars(at.p, geo.units) : null,
  }
}

/**
 * One channel over the whole clip as an expression in `t` (clip time): the in
 * animation's before `in`, the out one's after `length - out`, the rest value
 * between; null when neither animation moves it. `pick` reads the channel
 * from a type's channels (a sweep's mask, say).
 */
function track(
  text: Pick<ClipText, "animIn" | "animOut">, length: number, geo: AnimGeometry, rest: number,
  pick: (c: Channels, type: AnimType) => E | undefined
): E | null {
  const t = V("t")
  const a = text.animIn
  const b = text.animOut
  const inE = a ? pick(channels(a.type, clip01(div(t, a.duration)), false, geo), a.type) : undefined
  const outE = b ? pick(channels(b.type, clip01(div(sub(length, t), b.duration)), true, geo), b.type) : undefined
  if (inE === undefined && outE === undefined) return null
  let e: E = rest
  if (b && outE !== undefined) e = iff(gt(t, length - b.duration), outE, e)
  if (a && inE !== undefined) e = iff(lt(t, a.duration), inE, e)
  return e
}

/** A sweep's mask at pixel X, Y of a W x H box (1: shown), sampled at the pixel's centre. */
function sweepMask(type: AnimType, f: E): E {
  const X = add(V("X"), 0.5)
  const Y = add(V("Y"), 0.5)
  switch (sideOf(type)) {
    case "left":
      return lt(X, mul(V("W"), f))
    case "right":
      return gte(X, mul(V("W"), sub(1, f)))
    case "up":
      return lt(Y, mul(V("H"), f))
    default:
      return gte(Y, mul(V("H"), sub(1, f)))
  }
}

/** Every channel as an expression in clip time `t` (null: not animated); the alpha is a sweep's mask times the opacity, in X, Y, W, H too. */
export function animationExprs(text: Pick<ClipText, "animIn" | "animOut">, length: number, geo: AnimGeometry) {
  const opacity = track(text, length, geo, 1, (c) => c.opacity)
  const mask = track(text, length, geo, 1, (c, type) => (c.reveal === undefined ? undefined : sweepMask(type, c.reveal)))
  return {
    alpha: opacity === null && mask === null ? null : mul(opacity ?? 1, mask ?? 1),
    offsetX: track(text, length, geo, 0, (c) => c.offsetX),
    offsetY: track(text, length, geo, 0, (c) => c.offsetY),
    scale: track(text, length, geo, 1, (c) => c.scale),
    rotationDeg: track(text, length, geo, 0, (c) => c.rotationDeg),
  }
}

/** Where a typewriter unit starts in the text's box (fractions of it): `x` across its row, the row from `top` to `bottom` (the first and last rows reach the box's edges). */
export type TypeCut = { x: number; top: number; bottom: number }

/**
 * A text's typewriter units (characters in reading order: each line's
 * characters, no newlines; for vertical text every stacked line, a blank one
 * too) and where each starts in the box, from the font's advances.
 */
export function typewriterCuts(text: Pick<ClipText, "content" | "orientation" | "font">): TypeCut[] {
  const px = 100
  const font = fontById(text.font)
  const l = textLayout(text, px)
  const pad = font.pad * px
  const slot = font.line * px
  const last = l.lines.length - 1
  const cuts: TypeCut[] = []
  l.lines.forEach((line, i) => {
    const top = i === 0 ? 0 : (pad + i * slot) / l.h
    const bottom = i === last ? 1 : (pad + (i + 1) * slot) / l.h
    if (text.orientation === "vertical") return cuts.push({ x: 0, top, bottom })
    const chars = Array.from(line.text)
    const left = line.cx - (lineWidth(font, line.text) * px) / 2
    chars.forEach((_, j) => cuts.push({ x: j === 0 ? 0 : (left + lineWidth(font, chars.slice(0, j).join("")) * px) / l.w, top, bottom }))
  })
  return cuts
}

/** The part of the box (fractions) hidden while `chars` of `cuts` show: the rest of the first hidden unit's row and every row below. Empty when all show. */
export function typewriterHidden(cuts: TypeCut[], chars: number): { x: number; y: number; w: number; h: number }[] {
  const c = cuts[chars]
  if (!c) return []
  const rects = [{ x: c.x, y: c.top, w: 1 - c.x, h: c.bottom - c.top }]
  if (c.bottom < 1) rects.push({ x: 0, y: c.bottom, w: 1, h: 1 - c.bottom })
  return rects
}

const f6 = (n: number) => String(Number(n.toFixed(6)))

/**
 * The typewriter as ffmpeg drawboxes on the text's RGBA frame (before its
 * flips): per step, the region typewriterHidden gives for that step, cleared
 * (transparent) while the step hasn't been reached, enabled on clip time `t`.
 * A step j (its first hidden unit j x block) is hidden while
 * floor(p x steps) <= j, which is t < (j + 1) / steps x in coming in and
 * t > length - (j + 1) / steps x out going out.
 */
export function typewriterBoxes(text: Pick<ClipText, "content" | "orientation" | "font" | "animIn" | "animOut">, length: number): string[] {
  const a = text.animIn?.type === "typewriter" ? text.animIn : undefined
  const b = text.animOut?.type === "typewriter" ? text.animOut : undefined
  if (!a && !b) return []
  const cuts = typewriterCuts(text)
  const units = cuts.length
  const block = Math.max(1, Math.ceil(units / MAX_TYPE_STEPS))
  const steps = Math.ceil(units / block)
  const boxes: string[] = []
  for (let j = 0; j < steps; j++) {
    const when = [
      ...(a ? [`lt(t,${f6(((j + 1) / steps) * a.duration)})`] : []),
      ...(b ? [`gt(t,${f6(length - ((j + 1) / steps) * b.duration)})`] : []),
    ].join("+")
    // A hidden rect runs to the box's right edge; the first one ends at its row's bottom, the second at the box's.
    typewriterHidden(cuts, j * block).forEach((r, k) => {
      const x = `round(iw*${f6(r.x)})`
      const y = `round(ih*${f6(r.y)})`
      const h = k === 0 && r.y + r.h < 1 ? `round(ih*${f6(r.y + r.h)})-${y}` : `ih-${y}`
      boxes.push(`drawbox=x=${x}:y=${y}:w=iw-${x}:h=${h}:color=black@0:t=fill:replace=1:enable='${when}'`)
    })
  }
  return boxes
}

/** The clip times an animation that changes the alpha runs over, as an ffmpeg timeline condition on `t`; null when none does. */
export function alphaWindow(text: Pick<ClipText, "animIn" | "animOut">, length: number): string | null {
  const moves = (anim: TextAnim | undefined) => {
    if (!anim) return false
    const c = channels(anim.type, 0, false, WHOLE)
    return c.opacity !== undefined || c.reveal !== undefined
  }
  const parts = [
    ...(moves(text.animIn) ? [`lt(t,${f6(text.animIn!.duration)})`] : []),
    ...(moves(text.animOut) ? [`gt(t,${f6(length - text.animOut!.duration)})`] : []),
  ]
  return parts.length ? parts.join("+") : null
}
