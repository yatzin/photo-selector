import type { TransitionType } from "./transition-types"

// How the preview draws a transition: CSS for the outgoing picture (`from`),
// the incoming one (`to`, drawn over it) and an optional flat colour over both
// (`tint`), at progress p from 0 to 1. Each picture sits in a canvas-sized
// layer, so percentages are of the canvas. Fades, wipes, slides, the circles,
// the radial sweep and zoom follow ffmpeg's xfade (the export); pixelate and
// blur are drawn as a blur crossfade and dissolve as a plain crossfade, the
// closest cheap stand-ins a browser has (the export draws the real thing).

export type LayerStyle = {
  opacity?: number
  transform?: string
  clipPath?: string
  maskImage?: string
  filter?: string
}

export type TransitionLook = { from: LayerStyle; to: LayerStyle; tint?: { color: string; opacity: number } }

const pct = (n: number) => `${Math.round(n * 10000) / 100}%`
const round = (n: number) => Math.round(n * 1000) / 1000

/** What the two pictures look like `p` (0 to 1) of the way through a transition of `type`. */
export function transitionLook(type: TransitionType, p: number): TransitionLook {
  const q = Math.min(1, Math.max(0, p))
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

const kebab = (key: string) => key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

/** A layer's style as CSS declarations (mask-image with its -webkit- twin). */
export function cssText(s: LayerStyle): string {
  return Object.entries(s)
    .filter(([, v]) => v !== undefined)
    .flatMap(([k, v]) => (k === "maskImage" ? [`-webkit-mask-image:${v}`, `mask-image:${v}`] : [`${kebab(k)}:${v}`]))
    .join(";")
}

/**
 * CSS keyframes for a looping sample of a transition (the dialog's tiles):
 * the outgoing picture held for the first quarter, the transition over the
 * middle half, the incoming one held for the last quarter. Names are
 * `<prefix>-<type>-from`, `-to` and `-tint`.
 */
export function transitionKeyframes(type: TransitionType, prefix: string): string {
  const steps = 12
  const frames = { from: [] as string[], to: [] as string[], tint: [] as string[] }
  for (let k = 0; k <= steps; k++) {
    const p = k / steps
    const at = k === 0 ? "0%,25%" : k === steps ? "75%,100%" : `${25 + 50 * p}%`
    const look = transitionLook(type, p)
    // A layer with nothing set still needs its resting values at every step, so the keyframes don't fall back between them.
    frames.from.push(`${at}{${cssText({ opacity: 1, transform: "none", clipPath: "none", filter: "none", ...look.from })}}`)
    frames.to.push(`${at}{${cssText({ opacity: 1, transform: "none", clipPath: "none", filter: "none", ...look.to })}}`)
    frames.tint.push(`${at}{opacity:${look.tint?.opacity ?? 0};background:${look.tint?.color ?? "transparent"}}`)
  }
  const block = (name: string, list: string[]) => `@keyframes ${prefix}-${type}-${name}{${list.join("")}}`
  return [block("from", frames.from), block("to", frames.to), block("tint", frames.tint)].join("\n")
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
