import type { CustomTransition } from "./transition-types"

// The app's own transitions (CUSTOM_TRANSITIONS): collage, exchange, page
// turn, reveal, heart, glitch, glitch reveal and the four whips. Their motion
// is written once, as functions of the progress q (0 to 1), and both the
// preview (its CSS at the playhead) and the export (lib/video/transition-expr,
// the numbers baked into xfade's custom expression for each frame) use them,
// so the two follow the same curves. The pseudo-random parts (the glitches)
// come from a hash of a step number, the same in both. (The functions take
// an algebra, Alg, so a curve could also be written out as an expression.)
//
// The preview draws them as layers (lib/video/transition-preview): the two
// pictures, copies of either one (a canvas-sized clone, styled on its own)
// and flat or shaded boxes over them. The export draws them per pixel with
// xfade's custom expression on planar RGB with alpha (gbrap: planes 0 G, 1 B,
// 2 R, 3 A), sampling either frame with a0..a3(x, y) and b0..b3(x, y). The
// whips' motion blur is ffmpeg's gblur over the composite, in three steps
// (whipBlurStages), which the preview's blur filters match level for level.

/** Numbers or ffmpeg expression text. */
type Alg<T> = {
  n: (x: number) => T
  add: (a: T, b: T) => T
  sub: (a: T, b: T) => T
  mul: (a: T, b: T) => T
  div: (a: T, b: T) => T
  clamp01: (a: T) => T
  floor: (a: T) => T
  sin: (a: T) => T
  min: (a: T, b: T) => T
  abs: (a: T) => T
}

const NUM: Alg<number> = {
  n: (x) => x,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  clamp01: (a) => Math.min(1, Math.max(0, a)),
  floor: Math.floor,
  sin: Math.sin,
  min: Math.min,
  abs: Math.abs,
}

/** A number as ffmpeg expression text: six decimals at most, negatives bracketed. */
export const fx = (x: number) => {
  const s = String(Number(x.toFixed(6)))
  return x < 0 && s !== "0" ? `(${s})` : s
}


/** Smoothstep of x clamped to 0..1: eases in and out. */
function ease<T>(m: Alg<T>, x: T): T {
  const c = m.clamp01(x)
  return m.mul(m.mul(c, c), m.sub(m.n(3), m.mul(m.n(2), c)))
}
/** (q - from) / span, eased. */
const phase = <T>(m: Alg<T>, q: T, from: number, span: number) => ease(m, m.div(m.sub(q, m.n(from)), m.n(span)))

// Exchange: the outgoing picture shrinks to a card (0 to 0.4), the cards swap over sliding left (0.3 to 0.7), the incoming card grows to fill the frame (0.6 to 1).
export function exchangeParams<T>(m: Alg<T>, q: T) {
  const slide = phase(m, q, 0.3, 0.4)
  return {
    sA: m.sub(m.n(1), m.mul(m.n(0.4), phase(m, q, 0, 0.4))),
    cxA: m.sub(m.n(0), slide),
    sB: m.add(m.n(0.6), m.mul(m.n(0.4), phase(m, q, 0.6, 0.4))),
    cxB: m.sub(m.n(1), slide),
  }
}

/** Reveal: how far (a fraction of the width) each half of the outgoing picture has slid away. */
export const revealOffset = <T>(m: Alg<T>, q: T) => m.mul(m.n(0.5), ease(m, q))

// Page turn: the fold moves from the right edge to the left; the turned part
// stands up as a flap half as wide as the page turned (foreshortened), its
// plain back showing, and casts a shadow on the incoming picture beside the fold.
export const PAGE_SHADOW = 0.06
export const PAPER = { outer: 206, fold: 246 }
export function pageParams<T>(m: Alg<T>, q: T) {
  const fold = m.sub(m.n(1), ease(m, q))
  const flap = m.mul(m.n(0.5), m.sub(m.n(1), fold))
  // The shadow is darkest mid-turn: 0.45 at most.
  const shadow = m.mul(m.n(1.8), m.mul(q, m.sub(m.n(1), q)))
  return { fold, flapStart: m.sub(fold, flap), shadow }
}

// Collage: a grid of `cols` x COLLAGE_ROWS squares (roughly square for the
// frame's shape); each square shrinks to nothing while swiping right by 60%
// of its width, starting one after another from the top left.
export const COLLAGE_ROWS = 3
export const collageCols = (aspect: number) => Math.max(2, Math.round(COLLAGE_ROWS * aspect))
const COLLAGE_STAGGER = 0.45
const COLLAGE_SPAN = 0.55
export const COLLAGE_SWIPE = 0.6
/** How far (0 to 1) the square in column c, row r is through its exit. */
export function collageTile<T>(m: Alg<T>, q: T, c: T, r: T, cols: number): T {
  const delay = m.mul(m.n(COLLAGE_STAGGER / (cols + COLLAGE_ROWS - 2)), m.add(c, r))
  return ease(m, m.div(m.sub(q, delay), m.n(COLLAGE_SPAN)))
}

// Heart: the classic implicit heart, (x² + y² - 1)³ - x²y³ <= 0 (y up),
// centred on the frame, grown from nothing to heartCover times half the
// frame's height per unit, which takes in the corners.
export const heartF = (x: number, y: number) => (x * x + y * y - 1) ** 3 - x * x * y ** 3
/** The heart's outline: points (x, y up) round it, from rays out of its centre. */
export function heartOutline(steps = 144): [number, number][] {
  const pts: [number, number][] = []
  for (let k = 0; k < steps; k++) {
    const a = (2 * Math.PI * k) / steps
    let lo = 0
    let hi = 2
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2
      if (heartF(mid * Math.cos(a), mid * Math.sin(a)) <= 0) lo = mid
      else hi = mid
    }
    pts.push([lo * Math.cos(a), lo * Math.sin(a)])
  }
  return pts
}
const covers = new Map<number, number>()
/** The heart's scale (units per half the frame's height) at which it covers a frame of `aspect`, edges and corners, with 2% to spare. */
export function heartCover(aspect: number): number {
  const known = covers.get(aspect)
  if (known !== undefined) return known
  const inside = (s: number) => {
    for (let i = 0; i <= 200; i++) {
      const t = -1 + (2 * i) / 200
      for (const [x, y] of [[t * aspect, -1], [t * aspect, 1], [-aspect, t], [aspect, t]]) if (heartF(x / s, y / s) > 0) return false
    }
    return true
  }
  let lo = 0.5
  let hi = 20
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (inside(mid)) hi = mid
    else lo = mid
  }
  const s = Math.round(hi * 1.02 * 1000) / 1000
  covers.set(aspect, s)
  return s
}
export const heartScale = <T>(m: Alg<T>, q: T, aspect: number) => m.mul(m.n(heartCover(aspect)), ease(m, q))

// Glitch: a hard switch at the middle, the damage growing to it and fading after.
export const GLITCH_STEPS = 12
/** A pseudo-random number from 0 to 1 for step `n` and slot `k`, the same in the preview and the export. */
export function hash(n: number, k: number): number {
  const v = Math.sin(n * 12.9898 + k * 78.233 + 1.618) * 43758.5453
  return v - Math.floor(v)
}
/** The glitch's damage at q: 0 at the ends, 1 at the middle. */
export const glitchAmount = <T>(m: Alg<T>, q: T) => m.sub(m.n(1), m.abs(m.sub(m.mul(m.n(2), q), m.n(1))))
/** The step q falls in (0 to GLITCH_STEPS - 1). */
export const glitchStep = (q: number) => Math.min(GLITCH_STEPS - 1, Math.max(0, Math.floor(q * GLITCH_STEPS)))
export type GlitchBand = { y: number; h: number; shift: number }
export type GlitchBlock = { x: number; y: number; w: number; h: number; rgb: [number, number, number] }
/** A step's fixed parts: the color split (fraction of the width, at full damage), three displaced strips (shift at full damage) and two noise blocks. */
export function glitchFrame(n: number): { split: number; bands: GlitchBand[]; blocks: GlitchBlock[] } {
  const h = (k: number) => hash(n, k)
  const grey = Math.round(80 + 150 * h(18))
  return {
    split: 0.012 * (0.6 + 0.4 * h(0)),
    bands: [0, 1, 2].map((k) => ({ y: 0.85 * h(1 + k), h: 0.03 + 0.07 * h(4 + k), shift: (h(7 + k) - 0.5) * 0.2 })),
    blocks: [0, 1].map((k) => ({
      x: 0.85 * h(10 + k), y: 0.9 * h(12 + k), w: 0.05 + 0.1 * h(14 + k), h: 0.02 + 0.04 * h(16 + k),
      rgb: k === 0 ? [grey, grey, grey] : h(19) > 0.5 ? [255, 0, 255] : [0, 255, 255],
    })),
  }
}
/** Noise blocks show while the damage is over this. */
export const GLITCH_BLOCKS_FROM = 0.35

// Glitch reveal: GLITCH_STRIPS horizontal strips, each swapping to the incoming
// picture at its own time, glitching (shifted, colors split) for a short while around it.
export const GLITCH_STRIPS = 10
export const STRIP_GLITCH = 0.07
export const STRIP_SPLIT = 0.012
export const STRIP_STEPS = 16
/** When strip k swaps over (its glitch runs STRIP_GLITCH either side of it). */
export function stripSwap<T>(m: Alg<T>, k: T): T {
  const v = m.add(m.mul(k, m.n(0.618034)), m.n(0.31))
  return m.add(m.n(0.12), m.mul(m.n(0.76), m.sub(v, m.floor(v))))
}
/** The glitching strips' sideways jitter (fraction of the width) at step n. */
export const stripJitter = (n: number) => (hash(n, 20) - 0.5) * 0.08
export const stripStep = (q: number) => Math.min(STRIP_STEPS - 1, Math.max(0, Math.floor(q * STRIP_STEPS)))

// Whip: both pictures travel one frame's length together, easing in and out.
export const whipOffset = <T>(m: Alg<T>, q: T) => ease(m, q)
export type WhipDir = "left" | "right" | "up" | "down"
export const whipDir = (t: CustomTransition): WhipDir | null => (t.startsWith("whip-") ? (t.slice(5) as WhipDir) : null)
export const WHIP_VECTORS: Record<WhipDir, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }
/** The heaviest motion blur, a Gaussian's sigma as a fraction of the frame's size along the move. */
export const WHIP_BLUR = 0.03
/**
 * The motion blur in three steps: each adds a Gaussian of `sigma` (a fraction
 * of WHIP_BLUR, so together they make 0.35, 0.68 and 0.95 of it) while the
 * transition is between `from` and `to` (progress), where the move is fastest.
 */
export const whipBlurStages = (): { sigma: number; from: number; to: number }[] =>
  [
    { at: 0.2, sigma: 0.35 },
    { at: 0.5, sigma: Math.sqrt(0.68 ** 2 - 0.35 ** 2) },
    { at: 0.85, sigma: Math.sqrt(0.95 ** 2 - 0.68 ** 2) },
  ].map(({ at, sigma }) => {
    // sin²(πq) >= at between these.
    const from = Math.asin(Math.sqrt(at)) / Math.PI
    return { sigma, from: Math.round(from * 1000) / 1000, to: Math.round((1 - from) * 1000) / 1000 }
  })
/** How many blur stages are on at q (0 to 3), the preview's blur level. */
export const whipBlurLevel = (q: number) => whipBlurStages().filter((s) => q >= s.from && q < s.to).length
/** The preview's total blur at each level (fraction of WHIP_BLUR). */
export const WHIP_LEVELS = [0, 0.35, 0.68, 0.95]

export const num = NUM
export type { Alg }
