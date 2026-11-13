import {
  COLLAGE_ROWS, COLLAGE_SWIPE, collageCols, collageTile, exchangeParams, fx, GLITCH_BLOCKS_FROM, GLITCH_STRIPS, glitchAmount, glitchFrame, glitchStep, heartScale, num, PAGE_SHADOW, pageParams, PAPER,
  revealOffset, STRIP_GLITCH, STRIP_SPLIT, stripJitter, stripStep, stripSwap, WHIP_BLUR, WHIP_VECTORS, whipBlurStages, whipDir, whipOffset,
} from "./transition-fx"
import type { CustomTransition } from "./transition-types"

// The export's half of lib/video/transition-fx: each of the app's own
// transitions as the expression of xfade's custom transition, worked out per
// pixel on gbrap frames (planes 0 G, 1 B, 2 R, 3 A; transparent black
// outside a picture). A: the outgoing frame's value here, B: the incoming
// one's; a0..a3(x, y) and b0..b3(x, y) sample a plane elsewhere (clamped to
// the frame). xfade's P runs from 1 to 0, so the progress is 1 - P.
//
// xfade evaluates the expression for every pixel of every plane, and it has
// nowhere to keep a value between pixels, so anything worked out from the
// progress alone would be worked out millions of times a frame. Instead the
// transition's motion is worked out here, in numbers (the same functions the
// preview uses), once per frame of the transition, and the expression picks
// the frame's own expression (all constants) from a balanced tree of
// comparisons on the progress: a handful of comparisons and a few sums a
// pixel. A long transition uses at most MAX_STEPS steps (the motion then
// moves on every few frames).

/** Most distinct steps a transition's expression holds. */
export const MAX_STEPS = 150

/** How many steps a transition `duration` s long at `fps` gets: one a frame, up to MAX_STEPS. */
export const stepsFor = (duration: number, fps: number) => Math.max(1, Math.min(MAX_STEPS, Math.round(duration * fps)))

/** Plane `p` of the outgoing ("a") or incoming ("b") frame at x, y. */
const at = (src: "a" | "b", p: number, x: string, y: string) => `${src}${p}(${x},${y})`
/** The current plane of the outgoing or incoming frame at x, y. */
const sample = (src: "a" | "b", x: string, y: string) => `if(eq(PLANE,0),${at(src, 0, x, y)},if(eq(PLANE,1),${at(src, 1, x, y)},if(eq(PLANE,2),${at(src, 2, x, y)},${at(src, 3, x, y)})))`
/** One expression per plane, chosen by PLANE. */
const perPlane = (f: (p: number) => string) => `if(eq(PLANE,0),${f(0)},if(eq(PLANE,1),${f(1)},if(eq(PLANE,2),${f(2)},${f(3)})))`

/** True (1) when v is from lo (inclusive) to hi (exclusive). */
const within = (v: string, lo: string, hi: string) => `gte(${v},${lo})*lt(${v},${hi})`
/** A fraction of the width or height. */
const w = (f: number) => `${fx(f)}*W`
const h = (f: number) => `${fx(f)}*H`

/** `pick(k)` for each of `count` bands of `v` (equal, from 0 to `size`), chosen by a balanced tree of comparisons. */
function bands(v: string, size: string, count: number, pick: (k: number) => string): string {
  const tree = (lo: number, hi: number): string => {
    if (lo === hi) return pick(lo)
    const mid = Math.ceil((lo + hi) / 2)
    return `if(lt(${v},${fx(mid / count)}*${size}),${tree(lo, mid - 1)},${tree(mid, hi)})`
  }
  return tree(0, count - 1)
}

/** The expression for each step's progress q = k / steps, the nearest step chosen for the frame's progress. */
function stepped(steps: number, step: (q: number) => string): string {
  const tree = (lo: number, hi: number): string => {
    if (lo === hi) return step(lo / steps)
    const mid = Math.ceil((lo + hi) / 2)
    // q < threshold, written on P (= 1 - q) to save a subtraction a pixel.
    return `if(gt(P,${fx(1 - (mid - 0.5) / steps)}),${tree(lo, mid - 1)},${tree(mid, hi)})`
  }
  return tree(0, steps - 1)
}

function collage(q: number, aspect: number): string {
  const cols = collageCols(aspect)
  const tw = 1 / cols
  const th = 1 / COLLAGE_ROWS
  // The square in column c, row r if this pixel is inside it as it is now, else `otherwise`.
  const square = (c: number, r: number, own: boolean, otherwise: string) => {
    const u = collageTile(num, q, c, r, cols)
    if (u >= 1) return otherwise
    // At rest a square covers its own cell exactly.
    if (u <= 0) return own ? "A" : otherwise
    const s = 1 - u
    const cx = (c + 0.5) * tw
    const cy = (r + 0.5) * th
    const dx = u * COLLAGE_SWIPE * tw
    const inside = `lt(abs(X-${w(cx + dx)}),${w((s * tw) / 2)})*lt(abs(Y-${h(cy)}),${h((s * th) / 2)})`
    return `if(${inside},${sample("a", `${w(cx)}+(X-${w(cx + dx)})/${fx(s)}`, `${h(cy)}+(Y-${h(cy)})/${fx(s)}`)},${otherwise})`
  }
  // In column c the square of column c is on top of the one from the left, which can swipe over it.
  return bands("X", "W", cols, (c) => bands("Y", "H", COLLAGE_ROWS, (r) => square(c, r, true, c > 0 ? square(c - 1, r, false, "B") : "B")))
}

function exchange(q: number): string {
  const e = exchangeParams(num, q)
  const card = (src: "a" | "b", s: number, cx: number, otherwise: string) => {
    const u = `((X-${w(0.5 + cx)})/${fx(s)}+W/2)`
    const v = `((Y-H/2)/${fx(s)}+H/2)`
    // Wholly off the frame: nothing to test.
    if (0.5 + cx + s / 2 <= 0 || 0.5 + cx - s / 2 >= 1) return otherwise
    return `if(${within(u, "0", "W")}*${within(v, "0", "H")},${sample(src, u, v)},${otherwise})`
  }
  return card("b", e.sB, e.cxB, card("a", e.sA, e.cxA, "0"))
}

function pageturn(q: number): string {
  const g = pageParams(num, q)
  if (g.fold - g.flapStart <= 0) return "A"
  const paper = `(${PAPER.outer}+${fx((PAPER.fold - PAPER.outer) / (g.fold - g.flapStart))}*(X/W-${fx(g.flapStart)}))`
  const shade = `B*(1-${fx(g.shadow)}*(1-(X/W-${fx(g.fold)})/${fx(PAGE_SHADOW)}))`
  return `if(lt(X,${w(g.flapStart)}),A,if(lt(X,${w(g.fold)}),if(eq(PLANE,3),255,${paper}),if(eq(PLANE,3)+gte(X,${w(g.fold + PAGE_SHADOW)}),B,${shade})))`
}

function reveal(q: number): string {
  const o = revealOffset(num, q)
  if (o <= 0) return "A"
  return `if(lt(X,${w(0.5 - o)}),${sample("a", `X+${w(o)}`, "Y")},if(gte(X,${w(0.5 + o)}),${sample("a", `X-${w(o)}`, "Y")},B))`
}

function heart(q: number, aspect: number): string {
  const r = heartScale(num, q, aspect) / 2
  if (r <= 0) return "A"
  // (x² + y² - 1)³ - x²y³ < 0 with x = u / R, y = v / R (R = r * H px), times R⁶; u, v from the centre, v up.
  const R = h(r)
  const u2 = "(X-W/2)*(X-W/2)"
  const v = "(H/2-Y)"
  const t = `(${u2}+${v}*${v}-${R}*${R})`
  // Cheap answers first: outside the heart's box (x within 1.2, y from -1.05 to 1.3) it's A; inside the circle of radius 0.7 it's B.
  const outside = `gt(abs(X-W/2),${h(r * 1.2)})+gt(${v},${h(r * 1.3)})+lt(${v},-${h(r * 1.05)})`
  return `if(${outside},A,if(lt(${u2}+${v}*${v},${h(r * 0.7)}*${h(r * 0.7)}),B,if(lt(${t}*${t}*${t},${u2}*${v}*${v}*${v}*${R}),B,A)))`
}

function glitch(q: number): string {
  const g = glitchAmount(num, q)
  const f = glitchFrame(glitchStep(q))
  const src = q < 0.5 ? "a" : "b"
  return perPlane((p) => {
    // Red pulled right and blue left (a pixel shows red from its left): the color split on everything outside the strips.
    const split = f.split * g
    let e = split === 0 ? (src === "a" ? "A" : "B") : at(src, p, p === 2 ? `X-${w(split)}` : p === 1 ? `X+${w(split)}` : "X", "Y")
    for (const band of f.bands) {
      if (band.shift * g === 0) continue
      e = `if(${within("Y", h(band.y), h(band.y + band.h))},${at(src, p, `X-${w(band.shift * g)}`, "Y")},${e})`
    }
    if (g > GLITCH_BLOCKS_FROM) {
      for (const k of f.blocks) e = `if(${within("X", w(k.x), w(k.x + k.w))}*${within("Y", h(k.y), h(k.y + k.h))},${p === 3 ? 255 : k.rgb[[1, 2, 0][p]]},${e})`
    }
    return e
  })
}

function glitchreveal(q: number): string {
  const j = stripJitter(stripStep(q))
  // A glitching strip: the incoming picture shifted by the jitter, red and blue split either side of it; the outgoing one where it has moved off.
  const glitching = perPlane((p) => {
    const shift = j + (p === 2 ? STRIP_SPLIT : p === 1 ? -STRIP_SPLIT : 0)
    return `if(${within(`X-${w(j)}`, "0", "W")},${at("b", p, `X-${w(shift)}`, "Y")},A)`
  })
  return bands("Y", "H", GLITCH_STRIPS, (k) => {
    const swap = stripSwap(num, k)
    return q >= swap + STRIP_GLITCH ? "B" : q < swap - STRIP_GLITCH ? "A" : glitching
  })
}

function whip(t: CustomTransition, q: number): string {
  const [vx, vy] = WHIP_VECTORS[whipDir(t)!]
  const o = whipOffset(num, q)
  const move = (k: number) => [vx === 0 ? "X" : `X-${w(vx * k)}`, vy === 0 ? "Y" : `Y-${h(vy * k)}`]
  const [ax, ay] = move(o)
  const [bx, by] = move(o - 1)
  return `if(${within(ax, "0", "W")}*${within(ay, "0", "H")},${sample("a", ax, ay)},${sample("b", bx, by)})`
}

/** The custom xfade expression for one of the app's own transitions, on a frame `aspect` (width / height) wide, in `steps` steps (stepsFor). */
export function customExpr(t: CustomTransition, aspect: number, steps: number): string {
  return stepped(steps, (q) => {
    switch (t) {
      case "zoomfromfull":
      case "zoomtofull":
        // Zoom cuts have no overlap: the export turns them into a zoom inside one clip first (lib/video/zoom-cut).
        throw new Error("A zoom cut is not an xfade transition")
      case "collage":
        return collage(q, aspect)
      case "exchange":
        return exchange(q)
      case "pageturn":
        return pageturn(q)
      case "reveal":
        return reveal(q)
      case "heart":
        return heart(q, aspect)
      case "glitch":
        return glitch(q)
      case "glitchreveal":
        return glitchreveal(q)
      default:
        return whip(t, q)
    }
  })
}

/**
 * A whip's motion blur after its xfade: a gblur along the move (sigma in
 * pixels of the frame's side along it) for each blur stage, on while the
 * transition (starting at `start` s on the joined stream, `duration` long) is
 * within the stage; empty for any other transition.
 */
export function whipBlurFilters(t: CustomTransition, width: number, height: number, start: number, duration: number): string[] {
  const dir = whipDir(t)
  if (!dir) return []
  const horizontal = WHIP_VECTORS[dir][0] !== 0
  const size = horizontal ? width : height
  return whipBlurStages().map(({ sigma, from, to }) => {
    const s = fx(sigma * WHIP_BLUR * size)
    const blur = horizontal ? `gblur=sigma=${s}:sigmaV=0` : `gblur=sigma=0:sigmaV=${s}`
    return `${blur}:enable='between(t,${fx(start + from * duration)},${fx(start + to * duration)})'`
  })
}
