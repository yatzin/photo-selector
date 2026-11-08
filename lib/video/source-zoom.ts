// Zoom for the Edit length dialog's source strip: the strip shows a viewport
// of the file ([start, start + span) seconds) rather than always the whole of
// it. Zoom runs from 1x (the whole file) up to 32x or a one-second view,
// whichever comes first, in steps of ZOOM_STEP, and its focus is the clip's
// selection: zooming in centres the selection (its start at the left when it
// is wider than the view); zooming out keeps the selection's centre where it
// is on screen. Every view stays inside the file. Pure maths for the zoom,
// panning, mapping pixels and seconds in a view, and the tick marks.

import type { SourceSelection } from "./source-window"

/** The part of the file the strip shows: `span` seconds from `start`. */
export type Viewport = { start: number; span: number }

export const ZOOM_STEP = 2
const MAX_FACTOR = 32
const MIN_SPAN = 1

const tidy = (n: number) => Math.round(n * 1e9) / 1e9

export const fullViewport = (duration: number): Viewport => ({ start: 0, span: Math.max(0, duration) })

/** The deepest zoom for a file `duration` seconds long: 32x, or a one-second view when that comes first (1x for a file under a second). */
export const maxZoom = (duration: number) => Math.max(1, Math.min(MAX_FACTOR, duration / MIN_SPAN))

/** How far a view is zoomed: the file's length over the view's. */
export const zoomOf = (v: Viewport, duration: number) => (v.span > 0 ? duration / v.span : 1)

/** The zoom one step in (`dir` 1) or out (-1) from `zoom`, within 1x and maxZoom. */
export function nextZoom(zoom: number, dir: 1 | -1, duration: number): number {
  const z = dir > 0 ? zoom * ZOOM_STEP : zoom / ZOOM_STEP
  return tidy(Math.min(maxZoom(duration), Math.max(1, z)))
}

/** `v` kept inside the file (0..duration) and within the zoom limits. */
export function clampViewport(v: Viewport, duration: number): Viewport {
  const d = Math.max(0, duration)
  const span = Math.min(d, Math.max(d / maxZoom(d), v.span))
  return { start: tidy(Math.min(d - span, Math.max(0, v.start))), span: tidy(span) }
}

/**
 * The view after zooming by `factor` (2: twice as close) with the selection
 * as focus: zooming in centres the selection, or puts its start at the left
 * when it's wider than the new view; zooming out keeps the selection's centre
 * at the same place on screen (the middle when it was off screen).
 */
export function zoomViewport(v: Viewport, factor: number, focus: SourceSelection, duration: number): Viewport {
  const zoom = Math.min(maxZoom(duration), Math.max(1, zoomOf(v, duration) * factor))
  const span = duration / zoom
  const centre = (focus.in + focus.out) / 2
  const len = focus.out - focus.in
  let start: number
  if (factor >= 1) start = len > span ? focus.in : centre - span / 2
  else {
    const at = v.span > 0 ? (centre - v.start) / v.span : 0.5
    start = centre - (at >= 0 && at <= 1 ? at : 0.5) * span
  }
  return clampViewport({ start, span }, duration)
}

/** The view moved `deltaSeconds` along the file, kept inside it. */
export const panViewport = (v: Viewport, deltaSeconds: number, duration: number): Viewport => clampViewport({ start: v.start + deltaSeconds, span: v.span }, duration)

/** Px from the strip's left edge of source time `t` in view `v` (negative or past `width` when outside it). */
export const viewTimeToX = (t: number, v: Viewport, width: number) => (v.span > 0 ? ((t - v.start) / v.span) * width : 0)

/** Source time at `x` px in view `v`, clamped to the file (not the view: a drag may run past the strip's edges). */
export function viewXToTime(x: number, v: Viewport, width: number, duration: number): number {
  if (!(width > 0) || !(v.span > 0)) return v.start
  return Math.min(duration, Math.max(0, v.start + (x / width) * v.span))
}

const STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

/**
 * The tick marks inside view `v` on a strip `widthPx` wide: multiples of the
 * smallest round step at least `minGapPx` apart, leaving out any too close to
 * the view's edges (where its start and end are labelled). At 1x the same as
 * sourceTicks.
 */
export function viewTicks(v: Viewport, widthPx: number, minGapPx = 70): number[] {
  if (!(v.span > 0) || !(widthPx > 0)) return []
  const pxPerSec = widthPx / v.span
  const step = STEPS.find((s) => s * pxPerSec >= minGapPx) ?? Math.ceil(minGapPx / pxPerSec / 3600) * 3600
  const end = v.start + v.span
  const edge = (minGapPx * 0.75) / pxPerSec
  const ticks: number[] = []
  for (let i = Math.floor(v.start / step + 1e-9) + 1; ; i++) {
    const t = Math.round(i * step * 1000) / 1000
    if (end - t < edge) break
    if (t - v.start >= edge) ticks.push(t)
  }
  return ticks
}
