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
