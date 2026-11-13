import type { Transform } from "./transform"

// What a zoom cut (the transitions "Zoom from full screen" and "Zoom to full
// screen", lib/video/transition-types) does inside a clip. There is no overlap
// between the two clips: they run end to end, and the zoom is the first
// `duration` seconds of the incoming clip (zoomIn: it starts filling the screen
// and settles into its own size and place) or the last `duration` seconds of
// the outgoing one (zoomOut: it leaves its place and grows to fill the screen).
// "Fills the screen" is the whole picture fit inside the canvas, centred.
// Neither field is ever stored: lib/video/zoom-cut's expandZoomCuts derives
// them from the cut's transition for the preview and the export, which both
// work from one number, `away`: 0 is the clip's own place, 1 is full screen.
//   scale  = own ** (1 - away)      (a steady rate: own at 0, 1 at 1)
//   centre = own centre * (1 - away) (straight to the canvas centre)
// No Node APIs here, so the browser and the server share it.

/** A zoom's length, in seconds, inside its clip. */
export type ZoomSpan = { duration: number }

type Zoomed = { zoomIn?: ZoomSpan; zoomOut?: ZoomSpan }

/** A smooth start and stop: 0 to 1 over `u` 0 to 1. */
export const smooth = (u: number): number => {
  const x = Math.min(1, Math.max(0, u))
  return x * x * (3 - 2 * x)
}

/** How far from its own place the clip is `local` seconds into its `length`: 1 (full screen) at its very start with a zoomIn and its very end with a zoomOut, 0 outside them. */
export function zoomAway(c: Zoomed, length: number, local: number): number {
  const a = c.zoomIn
  if (a && local < a.duration) return 1 - smooth(local / a.duration)
  const b = c.zoomOut
  if (b && local > length - b.duration) return smooth((local - (length - b.duration)) / b.duration)
  return 0
}

/** `t` moved `away` (0 to 1) of the way to full screen. Not clamped to the usual scale limits. */
export function zoomedTransform(t: Transform, away: number): Transform {
  if (!(away > 0)) return t
  return { ...t, scale: t.scale ** (1 - away), x: t.x * (1 - away), y: t.y * (1 - away) }
}

const smoothExpr = (u: string) => `(min(1,max(0,${u}))*min(1,max(0,${u}))*(3-2*min(1,max(0,${u}))))`

/**
 * `away` as an ffmpeg expression of `local` (an expression for seconds into
 * the clip); `n` writes a number. The two zooms never overlap, so their
 * expressions are added. "0" with no zoom.
 */
export function zoomAwayExpr(c: Zoomed, length: number, local: string, n: (v: number) => string): string {
  const parts: string[] = []
  if (c.zoomIn) parts.push(`if(lt(${local},${n(c.zoomIn.duration)}),1-${smoothExpr(`(${local})/${n(c.zoomIn.duration)}`)},0)`)
  if (c.zoomOut) parts.push(`if(gt(${local},${n(length - c.zoomOut.duration)}),${smoothExpr(`((${local})-${n(length - c.zoomOut.duration)})/${n(c.zoomOut.duration)}`)},0)`)
  return parts.length === 0 ? "0" : parts.join("+")
}

/** The picture's scale as an ffmpeg expression: `own` (its own scale, as text) to the power 1 - away. */
export const zoomScaleExpr = (own: string, away: string): string => `pow(${own},1-(${away}))`
