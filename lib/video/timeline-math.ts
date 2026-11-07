import type { Clip } from "./project"

// Pixel and time arithmetic for the timeline UI, kept pure so it can be tested.

export const pxToTime = (px: number, zoom: number): number => px / zoom
export const timeToPx = (t: number, zoom: number): number => t * zoom

/** The source time an edge moves to when its handle is dragged `deltaPx` (the caller clamps it with trimClip). */
export function trimDelta(edge: "in" | "out", clip: Clip, deltaPx: number, zoom: number): number {
  return clip[edge] + pxToTime(deltaPx, zoom)
}

/**
 * A clip's start (it is `length` long) pulled onto the nearest of `points`
 * (seconds) when its start or its end lies within `thresholdPx` of one at
 * `zoom` px/s; never below 0.
 */
export function snapStart(start: number, length: number, points: number[], thresholdPx: number, zoom: number): number {
  const limit = thresholdPx / zoom
  let best = start
  let distance = Infinity
  for (const p of points) {
    for (const candidate of [p, p - length]) {
      const d = Math.abs(candidate - start)
      if (d <= limit && d < distance) {
        best = candidate
        distance = d
      }
    }
  }
  return Math.max(0, best)
}

/**
 * Auto-pan speed (px/s, + right, - left) for a drag with the pointer at
 * `pointerX` over a scroll viewport from `viewportLeft` to `viewportRight`:
 * 0 outside the `edge` px zones at either end, rising linearly to `max` at the
 * edge and capped there past it. In a viewport narrower than both zones the
 * nearer edge wins (0 at the exact middle).
 */
export function autoPanSpeed(pointerX: number, viewportLeft: number, viewportRight: number, edge = 48, max = 900): number {
  const toLeft = pointerX - viewportLeft
  const toRight = viewportRight - pointerX
  if (toLeft < edge && toLeft < toRight) return -Math.min(max, (max * (edge - toLeft)) / edge)
  if (toRight < edge && toRight < toLeft) return Math.min(max, (max * (edge - toRight)) / edge)
  return 0
}

/**
 * The timeline's width in px: the content (`contentEnd` seconds) plus `pad`
 * px, at least the `viewport`; while a drag is running, also to `extra`
 * seconds past the dragged item's end (`dragEnd`, null with no drag), so it
 * can keep going right. It shrinks back with the content.
 */
export function timelineWidth(o: { contentEnd: number; zoom: number; viewport: number; pad: number; dragEnd: number | null; extra: number }): number {
  const drag = o.dragEnd === null ? 0 : (o.dragEnd + o.extra) * o.zoom
  return Math.max(o.viewport, o.contentEnd * o.zoom + o.pad, drag)
}

export const FULL_ROW = 80 // px per track with one or two layers
export const COMPACT_ROW = 40 // px per track from three layers, before the vertical zoom
export const MIN_ROW_ZOOM = 0.6
export const MAX_ROW_ZOOM = 2

/** The vertical zoom kept between MIN_ROW_ZOOM and MAX_ROW_ZOOM; 1 for anything not a number. */
export function clampRowZoom(z: number): number {
  return Number.isFinite(z) ? Math.min(MAX_ROW_ZOOM, Math.max(MIN_ROW_ZOOM, z)) : 1
}

/** A track row's height for `tracks` layers: full with one or two, half that from three, times the vertical `zoom`. */
export function rowHeight(tracks: number, zoom: number): number {
  return Math.round((tracks >= 3 ? COMPACT_ROW : FULL_ROW) * clampRowZoom(zoom))
}

/** The horizontal zoom's range (px per second) and its default. */
export const MIN_ZOOM = 20
export const MAX_ZOOM = 200
export const DEFAULT_ZOOM = 60

/** The horizontal zoom kept between MIN_ZOOM and MAX_ZOOM; DEFAULT_ZOOM for anything not a number. */
export function clampZoom(z: number): number {
  return Number.isFinite(z) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) : DEFAULT_ZOOM
}

/**
 * The scrollLeft that keeps the timeline time under the pointer in place when
 * the zoom goes from `zoom` to `nextZoom` (px per second). `pointerX` is the
 * pointer's distance (px) from the left of the time area in view; never below 0.
 */
export function zoomAround(zoom: number, nextZoom: number, pointerX: number, scrollLeft: number): number {
  return Math.max(0, ((scrollLeft + pointerX) * nextZoom) / zoom - pointerX)
}

const LINE_PX = 40

/** A wheel event's deltas in pixels, whatever its deltaMode (lines, or pages `pagePx` high). */
export function wheelPixels(e: { deltaX: number; deltaY: number; deltaMode: number }, pagePx: number): { x: number; y: number } {
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? pagePx : 1
  return { x: e.deltaX * unit, y: e.deltaY * unit }
}

const NOTCH = 100 // px: one mouse wheel notch
const ZOOM_STEP = 1.08 // per notch

/** How much a wheel turn of `deltaY` px zooms: about 8% in per notch up (negative), out per notch down; at most three notches at once. */
export function wheelZoomFactor(deltaY: number): number {
  const notches = Math.max(-3, Math.min(3, deltaY / NOTCH))
  return notches === 0 ? 1 : ZOOM_STEP ** -notches
}
