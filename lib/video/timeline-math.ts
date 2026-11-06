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

/** The clip playing at `timelineTime`, or null past the end. */
export function clipIdAt(clips: Clip[], timelineTime: number): string | null {
  const starts = clipStarts(clips)
  for (let i = 0; i < clips.length; i++) {
    if (timelineTime >= starts[i] && timelineTime < starts[i] + clipLength(clips[i])) return clips[i].id
  }
  return null
}
