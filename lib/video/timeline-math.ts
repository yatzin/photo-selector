import { clipLength, clipStarts, type Clip } from "./project"

// Pixel and time arithmetic for the timeline UI, kept pure so it can be tested.

export const pxToTime = (px: number, zoom: number): number => px / zoom
export const timeToPx = (t: number, zoom: number): number => t * zoom

/** Index a clip dropped (or dragged) at `timelineTime` lands at: the number of clips whose midpoint is before it. */
export function dropIndex(clips: Clip[], timelineTime: number): number {
  const starts = clipStarts(clips)
  let index = 0
  for (let i = 0; i < clips.length; i++) {
    if (starts[i] + clipLength(clips[i]) / 2 < timelineTime) index = i + 1
  }
  return index
}

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

/** The clip playing at `timelineTime` on the base track, or null past the end. */
export function clipIdAt(clips: Clip[], timelineTime: number): string | null {
  const starts = clipStarts(clips)
  for (let i = 0; i < clips.length; i++) {
    if (timelineTime >= starts[i] && timelineTime < starts[i] + clipLength(clips[i])) return clips[i].id
  }
  return null
}
