// The scene viewer's own zoom (a view of the canvas, not the clip's scale):
// 1 is the canvas fit inside the viewer, up to MAX_VIEW_ZOOM times that. Pure
// maths for the preview: the range, the steps, the wheel, and where to scroll
// so the point under the pointer stays put.

export const MIN_VIEW_ZOOM = 0.25
export const MAX_VIEW_ZOOM = 8

const PRESETS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8]
/** Zoom per wheel pixel (as an exponent), so equal scrolls give equal ratios. */
const WHEEL_RATE = 0.0015

export function clampViewZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(MAX_VIEW_ZOOM, Math.max(MIN_VIEW_ZOOM, zoom))
}

/** The next preset above (dir 1) or below (dir -1) `zoom`. */
export function stepViewZoom(zoom: number, dir: 1 | -1): number {
  const eps = 1e-6
  if (dir > 0) return PRESETS.find((p) => p > zoom + eps) ?? MAX_VIEW_ZOOM
  return [...PRESETS].reverse().find((p) => p < zoom - eps) ?? MIN_VIEW_ZOOM
}

/** The zoom after a wheel turn of `deltaY` px (negative, scrolling up, zooms in). */
export function wheelViewZoom(zoom: number, deltaY: number): number {
  return clampViewZoom(zoom * Math.exp(-deltaY * WHEEL_RATE))
}

/** A typed percent (100 = fit) as a zoom, clamped; null when it isn't a number. */
export function parseViewZoom(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*%?\s*$/.exec(text)
  return m ? clampViewZoom(Number(m[1]) / 100) : null
}

/**
 * `fitW`, `fitH`: the canvas on screen at zoom 1; `viewW`, `viewH`: the
 * scroller's visible size; `pad`: the gap kept round the canvas inside the
 * scrolled content. The content is as big as the canvas plus the gap, and at
 * least the view; the canvas sits centred in it.
 */
export type ZoomSize = { fitW: number; fitH: number; viewW: number; viewH: number; pad: number }

const axis = (fit: number, view: number, pad: number, zoom: number) => {
  const canvas = fit * zoom
  const content = Math.max(canvas + 2 * pad, view)
  return { canvas, content, offset: (content - canvas) / 2 }
}

/**
 * The scroll offsets after zooming from `oldZoom` to `newZoom` with `pointer`
 * (px from the scroller's top left) as the fixed point: the canvas point under
 * it stays under it. Clamped to what can scroll, so a canvas smaller than the
 * view stays centred (offset 0).
 */
export function zoomAt(scroll: { x: number; y: number }, size: ZoomSize, pointer: { x: number; y: number }, oldZoom: number, newZoom: number): { x: number; y: number } {
  const one = (s: number, p: number, fit: number, view: number) => {
    const a = axis(fit, view, size.pad, oldZoom)
    const b = axis(fit, view, size.pad, newZoom)
    const u = a.canvas > 0 ? (s + p - a.offset) / a.canvas : 0.5
    const next = b.offset + u * b.canvas - p
    return Math.min(Math.max(0, b.content - view), Math.max(0, next))
  }
  return { x: one(scroll.x, pointer.x, size.fitW, size.viewW), y: one(scroll.y, pointer.y, size.fitH, size.viewH) }
}
