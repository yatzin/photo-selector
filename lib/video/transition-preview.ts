import {
  COLLAGE_ROWS, COLLAGE_SWIPE, collageCols, collageTile, exchangeParams, GLITCH_BLOCKS_FROM, GLITCH_STRIPS, glitchAmount, glitchFrame, glitchStep, heartOutline, heartScale, num, PAGE_SHADOW,
  pageParams, PAPER, revealOffset, STRIP_GLITCH, STRIP_SPLIT, stripJitter, stripStep, stripSwap, WHIP_VECTORS, whipBlurLevel, whipDir, whipOffset,
} from "./transition-fx"
import { isCustomTransition, type CustomTransition, type CutAudio, type Edge, type TransitionType } from "./transition-types"
import { cutGains } from "./transitions"

// How the preview draws a transition: CSS for the outgoing picture (`from`),
// the incoming one (`to`, drawn over it) and an optional flat colour over both
// (`tint`), at progress p from 0 to 1. Each picture sits in a canvas-sized
// layer, so percentages are of the canvas. Fades, wipes, slides, the circles,
// the radial sweep and zoom follow ffmpeg's xfade (the export); pixelate and
// blur are drawn as a blur crossfade and dissolve as a plain crossfade, the
// closest cheap stand-ins a browser has (the export draws the real thing).
//
// The app's own transitions (lib/video/transition-fx) may also draw copies of
// either picture (`fromCopies`, `toCopies`: a clone of the layer, styled on its
// own, drawn just over it), boxes over everything (`overlays`, fractions of
// the canvas) and the outgoing picture over the incoming one (`fromOnTop`).
// Their colour splits and blurs use SVG filters by id (TRANSITION_FILTERS).

export type LayerStyle = {
  opacity?: number
  transform?: string
  transformOrigin?: string
  clipPath?: string
  maskImage?: string
  maskSize?: string
  maskPosition?: string
  maskRepeat?: string
  filter?: string
  mixBlendMode?: "plus-lighter"
  maskComposite?: "exclude"
}

export type Overlay = { x: number; y: number; w: number; h: number; background: string; opacity?: number }

export type TransitionLook = {
  from: LayerStyle
  to: LayerStyle
  tint?: { color: string; opacity: number }
  fromCopies?: LayerStyle[]
  toCopies?: LayerStyle[]
  overlays?: Overlay[]
  fromOnTop?: boolean
}

/**
 * The SVG filters the looks name (each `url(#id)`): one colour channel kept
 * (r, g, b), and a whip's motion blur, sideways (h) or up and down (v), at
 * levels 1 to 3 (transition-fx's WHIP_LEVELS).
 */
export const TRANSITION_FILTERS = {
  channels: { r: "ps-fx-r", g: "ps-fx-g", b: "ps-fx-b" },
  blur: (axis: "h" | "v", level: number) => `ps-fx-${axis}${level}`,
}

const pct = (n: number) => `${Math.round(n * 10000) / 100}%`
const round = (n: number) => Math.round(n * 1000) / 1000

/** What the two pictures look like `p` (0 to 1) of the way through a transition of `type`, on a canvas `aspect` (width / height) wide. */
export function transitionLook(type: TransitionType, p: number, aspect = 16 / 9): TransitionLook {
  const q = Math.min(1, Math.max(0, p))
  if (isCustomTransition(type)) return customLook(type, q, aspect)
  const rest = 1 - q
  // Rising to 1 at the middle and back: how far through the dip (black, white, blur) it is.
  const dip = 1 - Math.abs(2 * q - 1)
  switch (type) {
    case "fade":
      return { from: {}, to: { opacity: round(q) } }
    case "dissolve":
      return { from: {}, to: { opacity: round(q) } }
    case "fadeblack":
    case "fadewhite":
      return { from: { opacity: q < 0.5 ? 1 : 0 }, to: { opacity: q < 0.5 ? 0 : 1 }, tint: { color: type === "fadeblack" ? "#000" : "#fff", opacity: round(dip) } }
    case "wipeleft":
      return { from: {}, to: { clipPath: `inset(0 0 0 ${pct(rest)})` } }
    case "wiperight":
      return { from: {}, to: { clipPath: `inset(0 ${pct(rest)} 0 0)` } }
    case "wipeup":
      return { from: {}, to: { clipPath: `inset(${pct(rest)} 0 0 0)` } }
    case "wipedown":
      return { from: {}, to: { clipPath: `inset(0 0 ${pct(rest)} 0)` } }
    case "slideleft":
      return { from: { transform: `translateX(${pct(-q)})` }, to: { transform: `translateX(${pct(rest)})` } }
    case "slideright":
      return { from: { transform: `translateX(${pct(q)})` }, to: { transform: `translateX(${pct(-rest)})` } }
    case "slideup":
      return { from: { transform: `translateY(${pct(-q)})` }, to: { transform: `translateY(${pct(rest)})` } }
    case "slidedown":
      return { from: { transform: `translateY(${pct(q)})` }, to: { transform: `translateY(${pct(-rest)})` } }
    case "circleopen":
      // The incoming picture inside a circle growing from the centre to the corners.
      return { from: {}, to: { maskImage: `radial-gradient(circle farthest-corner at 50% 50%, #000 ${pct(q)}, transparent ${pct(q)})` } }
    case "circleclose":
      // The outgoing picture inside a circle shrinking to the centre.
      return { from: {}, to: { maskImage: `radial-gradient(circle farthest-corner at 50% 50%, transparent ${pct(rest)}, #000 ${pct(rest)})` } }
    case "radial":
      // A clock hand sweeping round from twelve o'clock.
      return { from: {}, to: { maskImage: `conic-gradient(from 0deg at 50% 50%, #000 ${round(q * 360)}deg, transparent ${round(q * 360)}deg)` } }
    case "zoomin":
      // The outgoing picture grows, and the incoming one fades in over the second half.
      return { from: { transform: `scale(${round(1 + q)})` }, to: { opacity: round(Math.max(0, 2 * q - 1)) } }
    case "pixelize":
    case "hblur": {
      const blur = `blur(${round(dip * (type === "pixelize" ? 6 : 10))}px)`
      return { from: { filter: blur }, to: { opacity: round(q), filter: blur } }
    }
  }
}

const url = (id: string) => `url(#${id})`
const inset = (top: number, right: number, bottom: number, left: number) => `inset(${pct(top)} ${pct(right)} ${pct(bottom)} ${pct(left)})`
const translate = (x: number, y = 0) => (y === 0 ? `translateX(${pct(x)})` : `translate(${pct(x)}, ${pct(y)})`)

let heartMask = ""
/** The heart's outline as an SVG mask image, three units (-1.5 to 1.5) a side, y down. */
function heartImage(): string {
  if (!heartMask) {
    const points = heartOutline().map(([x, y]) => `${round(x)},${round(-y)}`).join(" ")
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1.5 -1.5 3 3"><polygon points="${points}" fill="#000"/></svg>`
    heartMask = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  }
  return heartMask
}

/** A mask showing the horizontal strips in `on` (of GLITCH_STRIPS), as a hard-stopped gradient. */
function stripMask(on: boolean[]): string {
  const stops = on.map((shown, k) => `${shown ? "#000" : "transparent"} ${pct(k / GLITCH_STRIPS)} ${pct((k + 1) / GLITCH_STRIPS)}`)
  return `linear-gradient(to bottom, ${stops.join(", ")})`
}

function customLook(type: CustomTransition, q: number, aspect: number): TransitionLook {
  switch (type) {
    case "collage": {
      // Each square of the outgoing picture is a copy clipped to it, shrinking about its centre as it swipes right.
      const cols = collageCols(aspect)
      const tw = 1 / cols
      const th = 1 / COLLAGE_ROWS
      const tiles: LayerStyle[] = []
      for (let r = 0; r < COLLAGE_ROWS; r++) {
        for (let c = 0; c < cols; c++) {
          const u = collageTile(num, q, c, r, cols)
          tiles.push({
            clipPath: inset(r * th, 1 - (c + 1) * tw, 1 - (r + 1) * th, c * tw),
            transform: `${translate(u * COLLAGE_SWIPE * tw)} scale(${round(1 - u)})`,
            transformOrigin: `${pct((c + 0.5) * tw)} ${pct((r + 0.5) * th)}`,
          })
        }
      }
      return { from: tiles[0], fromCopies: tiles.slice(1), to: {}, fromOnTop: true }
    }
    case "exchange": {
      const e = exchangeParams(num, q)
      return { from: { transform: `${translate(e.cxA)} scale(${round(e.sA)})` }, to: { transform: `${translate(e.cxB)} scale(${round(e.sB)})` } }
    }
    case "pageturn": {
      const g = pageParams(num, q)
      const grey = (v: number) => `rgb(${v},${v},${v})`
      return {
        from: { clipPath: inset(0, 1 - g.flapStart, 0, 0) },
        to: {},
        fromOnTop: true,
        overlays: [
          { x: g.flapStart, y: 0, w: g.fold - g.flapStart, h: 1, background: `linear-gradient(to right, ${grey(PAPER.outer)}, ${grey(PAPER.fold)})` },
          { x: g.fold, y: 0, w: PAGE_SHADOW, h: 1, background: `linear-gradient(to right, rgba(0,0,0,${round(g.shadow)}), rgba(0,0,0,0))` },
        ],
      }
    }
    case "reveal": {
      const o = revealOffset(num, q)
      return { from: { clipPath: inset(0, 0.5, 0, 0), transform: translate(-o) }, fromCopies: [{ clipPath: inset(0, 0, 0, 0.5), transform: translate(o) }], to: {}, fromOnTop: true }
    }
    case "heart": {
      const s = heartScale(num, q, aspect)
      return { from: {}, to: { maskImage: heartImage(), maskSize: `${pct((1.5 * s) / aspect)} ${pct(1.5 * s)}`, maskPosition: "50% 50%", maskRepeat: "no-repeat" } }
    }
    case "glitch": {
      // The picture on show (the outgoing one, then the incoming one from the middle) in three colour channels, red and blue
      // pulled apart, with three strips of it shifted sideways over them, and two noise blocks.
      const g = glitchAmount(num, q)
      const f = glitchFrame(glitchStep(q))
      const split = f.split * g
      const { r, g: green, b } = TRANSITION_FILTERS.channels
      const shown = (on: boolean): { base: LayerStyle; copies: LayerStyle[] } => {
        const hide = on ? {} : { opacity: 0 }
        return {
          base: { filter: url(green), ...hide },
          copies: [
            { filter: url(r), transform: translate(split), mixBlendMode: "plus-lighter", ...hide },
            { filter: url(b), transform: translate(-split), mixBlendMode: "plus-lighter", ...hide },
            ...f.bands.map((band) => ({ clipPath: inset(band.y, 0, 1 - band.y - band.h, 0), transform: translate(band.shift * g), ...hide })),
          ],
        }
      }
      const before = shown(q < 0.5)
      const after = shown(q >= 0.5)
      return {
        from: before.base, fromCopies: before.copies, to: after.base, toCopies: after.copies,
        overlays: f.blocks.map((k) => ({ x: k.x, y: k.y, w: k.w, h: k.h, background: `rgb(${k.rgb.join(",")})`, opacity: g > GLITCH_BLOCKS_FROM ? 1 : 0 })),
      }
    }
    case "glitchreveal": {
      // Strips that have swapped show the incoming picture; the ones swapping show it shifted, its colours split.
      const states = Array.from({ length: GLITCH_STRIPS }, (_, k) => {
        const at = stripSwap(num, k)
        return q >= at + STRIP_GLITCH ? "in" : q >= at - STRIP_GLITCH ? "glitch" : "out"
      })
      const j = stripJitter(stripStep(q))
      const glitching = stripMask(states.map((s) => s === "glitch"))
      const { r, g, b } = TRANSITION_FILTERS.channels
      return {
        from: {},
        to: { maskImage: stripMask(states.map((s) => s === "in")) },
        toCopies: [
          { maskImage: glitching, filter: url(g), transform: translate(j) },
          { maskImage: glitching, filter: url(r), transform: translate(j + STRIP_SPLIT), mixBlendMode: "plus-lighter" },
          { maskImage: glitching, filter: url(b), transform: translate(j - STRIP_SPLIT), mixBlendMode: "plus-lighter" },
        ],
      }
    }
    default: {
      // The whips: both pictures travel together, blurred along the move while it's fastest.
      const [vx, vy] = WHIP_VECTORS[whipDir(type)!]
      const o = whipOffset(num, q)
      const level = whipBlurLevel(q)
      const filter = level > 0 ? url(TRANSITION_FILTERS.blur(vx !== 0 ? "h" : "v", level)) : undefined
      return { from: { transform: translate(vx * o, vy * o), filter }, to: { transform: translate(vx * (o - 1), vy * (o - 1)), filter } }
    }
  }
}

/**
 * What a clip looks like `p` (0 to 1) of the way through its edge transition
 * at `edge`, against nothing (the layers below show where it doesn't): the
 * same maths as a cut's look, with the other picture transparent, as the
 * export builds it (xfade against a transparent copy of the clip). At an in
 * edge the clip is the incoming picture; where the outgoing one would cover
 * it (a page turn's and a reveal's), it is clipped away. At an out edge it is
 * the outgoing picture, hidden wherever the incoming one would show. The
 * clip's own style is `to` (with `toCopies`); `from` is empty.
 */
export function edgeLook(type: TransitionType, edge: Edge, p: number, aspect = 16 / 9): TransitionLook {
  const q = Math.min(1, Math.max(0, p))
  const look = transitionLook(type, q, aspect)
  const only = (to: LayerStyle, toCopies?: LayerStyle[], overlays?: Overlay[]): TransitionLook => ({ from: {}, to, ...(toCopies?.length ? { toCopies } : {}), ...(overlays?.length ? { overlays } : {}) })
  if (edge === "in") {
    if (type === "pageturn") {
      const g = pageParams(num, q)
      return only({ clipPath: inset(0, 0, 0, g.fold) }, undefined, look.overlays)
    }
    if (type === "reveal") {
      const o = revealOffset(num, q)
      return only({ clipPath: inset(0, 0.5 - o, 0, 0.5 - o) })
    }
    return only(look.to, look.toCopies, look.overlays)
  }
  const rest = 1 - q
  switch (type) {
    case "fade":
    case "dissolve":
      return only({ opacity: round(rest) })
    case "wipeleft":
      return only({ clipPath: inset(0, q, 0, 0) })
    case "wiperight":
      return only({ clipPath: inset(0, 0, 0, q) })
    case "wipeup":
      return only({ clipPath: inset(0, 0, q, 0) })
    case "wipedown":
      return only({ clipPath: inset(q, 0, 0, 0) })
    case "circleopen":
      return only({ maskImage: `radial-gradient(circle farthest-corner at 50% 50%, transparent ${pct(q)}, #000 ${pct(q)})` })
    case "circleclose":
      return only({ maskImage: `radial-gradient(circle farthest-corner at 50% 50%, #000 ${pct(rest)}, transparent ${pct(rest)})` })
    case "radial":
      return only({ maskImage: `conic-gradient(from 0deg at 50% 50%, transparent ${round(q * 360)}deg, #000 ${round(q * 360)}deg)` })
    case "zoomin":
      return only({ ...look.from, opacity: round(1 - Math.max(0, 2 * q - 1)) })
    case "pixelize":
    case "hblur":
      return only({ ...look.from, opacity: round(rest) })
    case "heart": {
      // The clip with a growing heart-shaped hole: the heart excluded from a full mask.
      const s = heartScale(num, q, aspect)
      return only({ maskImage: `${heartImage()}, linear-gradient(#000, #000)`, maskSize: `${pct((1.5 * s) / aspect)} ${pct(1.5 * s)}, 100% 100%`, maskPosition: "50% 50%, 0 0", maskRepeat: "no-repeat", maskComposite: "exclude" })
    }
    case "glitchreveal": {
      // Strips that have swapped show nothing; the rest (swapping ones too) still show the clip.
      const gone = Array.from({ length: GLITCH_STRIPS }, (_, k) => q >= stripSwap(num, k) + STRIP_GLITCH)
      return only({ maskImage: stripMask(gone.map((g) => !g)) })
    }
    case "pageturn":
      // The paper's back folding over; no shadow, there's nothing under it to shade.
      return only(look.from, undefined, look.overlays?.slice(0, 1))
    default:
      // Slides, the exchange, the collage, the reveal, the glitch and the whips: the outgoing picture's own motion.
      return only(look.from, look.fromCopies, look.overlays)
  }
}

const kebab = (key: string) => key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

/** A layer's style as CSS declarations (mask-image, -size, -position and -repeat with their -webkit- twins). */
export function cssText(s: LayerStyle): string {
  return Object.entries(s)
    .filter(([, v]) => v !== undefined)
    .flatMap(([k, v]) => (k.startsWith("mask") ? [`-webkit-${kebab(k)}:${v}`, `${kebab(k)}:${v}`] : [`${kebab(k)}:${v}`]))
    .join(";")
}

/**
 * CSS keyframes for a looping sample of a transition (the dialog's tiles):
 * the outgoing picture held for the first quarter, the transition over the
 * middle half, the incoming one held for the last quarter. Names are
 * `<prefix>-<type>-from`, `-to` and `-tint`.
 */
export function transitionKeyframes(type: TransitionType, prefix: string): string {
  // The app's own transitions move more within the transition: twice the steps.
  const steps = isCustomTransition(type) ? 24 : 12
  const parts = lookParts(type)
  const frames = { from: [] as string[], to: [] as string[], tint: [] as string[] }
  const copies = { from: parts.fromCopies.map(() => [] as string[]), to: parts.toCopies.map(() => [] as string[]), overlays: parts.overlays.map(() => [] as string[]) }
  const rest: LayerStyle = { opacity: 1, transform: "none", clipPath: "none", filter: "none" }
  for (let k = 0; k <= steps; k++) {
    const p = k / steps
    const at = k === 0 ? "0%,25%" : k === steps ? "75%,100%" : `${25 + 50 * p}%`
    const look = transitionLook(type, p)
    // A layer with nothing set still needs its resting values at every step, so the keyframes don't fall back between them.
    frames.from.push(`${at}{${cssText({ ...rest, ...look.from })}}`)
    frames.to.push(`${at}{${cssText({ ...rest, ...look.to })}}`)
    frames.tint.push(`${at}{opacity:${look.tint?.opacity ?? 0};background:${look.tint?.color ?? "transparent"}}`)
    look.fromCopies?.forEach((s, i) => copies.from[i].push(`${at}{${cssText({ ...rest, ...s })}}`))
    look.toCopies?.forEach((s, i) => copies.to[i].push(`${at}{${cssText({ ...rest, ...s })}}`))
    look.overlays?.forEach((o, i) => copies.overlays[i].push(`${at}{${overlayCss(o)}}`))
  }
  const block = (name: string, list: string[]) => `@keyframes ${prefix}-${type}-${name}{${list.join("")}}`
  return [
    block("from", frames.from), block("to", frames.to), block("tint", frames.tint),
    ...copies.from.map((l, i) => block(`from-c${i}`, l)), ...copies.to.map((l, i) => block(`to-c${i}`, l)), ...copies.overlays.map((l, i) => block(`ov${i}`, l)),
  ].join("\n")
}

/** An overlay's box and look as CSS declarations, on a canvas-sized parent. */
export const overlayCss = (o: Overlay) => `left:${pct(o.x)};top:${pct(o.y)};width:${pct(o.w)};height:${pct(o.h)};background:${o.background};opacity:${o.opacity ?? 1}`

/** How many copies of each picture and overlays a transition's look draws (the same all through it), and whether the outgoing picture is on top. */
export function lookParts(type: TransitionType): { fromCopies: LayerStyle[]; toCopies: LayerStyle[]; overlays: Overlay[]; fromOnTop: boolean } {
  const look = transitionLook(type, 0.5)
  return { fromCopies: look.fromCopies ?? [], toCopies: look.toCopies ?? [], overlays: look.overlays ?? [], fromOnTop: look.fromOnTop === true }
}

/**
 * The Transition dialog's loop of a cut: `lead` seconds of the outgoing clip
 * before the transition starts and `tail` of the incoming one after it ends
 * (up to `extra` each, as much as the clips have outside the transition), the
 * transition of `duration` (0: a hard cut) in between. Times are from the
 * loop's start; `cut` is where the cut falls and `total` its length.
 */
export type LoopPlan = { lead: number; tail: number; cut: number; total: number; duration: number }

export function loopPlan(outLength: number, inLength: number, duration: number, extra = 2): LoopPlan {
  const half = Math.max(0, duration) / 2
  const lead = Math.max(0, Math.min(extra, outLength - half))
  const tail = Math.max(0, Math.min(extra, inLength - half))
  return { lead, tail, cut: lead + half, total: lead + 2 * half + tail, duration: 2 * half }
}

/** What the loop shows at `t`: whether the outgoing (`from`) and incoming (`to`) pictures are up, and how far through the transition it is (null outside it). */
export function loopFrame(plan: LoopPlan, t: number): { from: boolean; to: boolean; progress: number | null } {
  const half = plan.duration / 2
  if (plan.duration <= 0) return { from: t < plan.cut, to: t >= plan.cut, progress: null }
  const start = plan.cut - half
  const inside = t >= start && t < plan.cut + half
  return { from: t < plan.cut + half, to: t >= start, progress: inside ? Math.min(1, Math.max(0, (t - start) / plan.duration)) : null }
}

/**
 * What the loop plays for sound at `t`: whether each clip's video runs (the
 * outgoing one until its cut's overlap ends, the incoming one from where it
 * starts, a J-cut's lead or an L-cut's tail included) and its volume, as the
 * editor's preview and the export mix it (cutGains: a transition's
 * equal-power crossfade, or the J- or L-cut's timing).
 */
export function loopSound(plan: LoopPlan, t: number, audio: CutAudio | null): { from: { plays: boolean; gain: number }; to: { plays: boolean; gain: number } } {
  const half = plan.duration / 2
  const start = plan.cut - Math.max(half, audio?.mode === "j" ? audio.duration : 0)
  const end = plan.cut + Math.max(half, audio?.mode === "l" ? audio.duration : 0)
  const inside = t >= start && t < end
  const tw = half > 0 && t >= plan.cut - half && t < plan.cut + half
  const g = inside
    ? cutGains(
        { from: 0, to: 1, cut: plan.cut, start, end, audio, transition: tw ? { from: 0, to: 1, cut: plan.cut, duration: plan.duration, type: "fade", progress: (t - (plan.cut - half)) / plan.duration } : null },
        t
      )
    : t < start ? { out: 1, in: 0 } : { out: 0, in: 1 }
  return { from: { plays: t < end, gain: g.out }, to: { plays: t >= start, gain: g.in } }
}
