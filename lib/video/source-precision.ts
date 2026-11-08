import type { SourceSelection } from "./source-window"

// The Edit length dialog's precision controls and its preview column: typed
// source times (plain seconds or m:ss.mmm), steps by key or button, typed and
// "at the playhead" In and Out kept inside the file and at least the minimum
// length apart, and the maths for playing exactly [in, out) of the selection
// on a loop. Plain maths, safe on the client.

/** Seconds from "62.35", ".5" or "1:02.350" (m:ss with optional decimals); null for anything else. */
export function parseTime(text: string): number | null {
  const t = text.trim()
  const plain = /^(\d+(?:\.\d*)?|\.\d+)$/.exec(t)
  if (plain) return Number(plain[1])
  const clock = /^(\d+):([0-5]?\d(?:\.\d*)?)$/.exec(t)
  if (!clock) return null
  return Number(clock[1]) * 60 + Number(clock[2])
}

/** Whole milliseconds: 1.0300001575 -> 1.03. */
export const roundMs = (t: number) => Math.round(t * 1000) / 1000

/** A field's seconds with 3 decimals: "1.030". */
export const formatSeconds = (t: number) => roundMs(t).toFixed(3)

/** The preview's readout, m:ss.hh: 2.4 -> "0:02.40". */
export function formatClock(seconds: number): string {
  const hundredths = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 100 + 1e-6)
  const m = Math.floor(hundredths / 6000)
  const s = Math.floor((hundredths % 6000) / 100)
  return `${m}:${String(s).padStart(2, "0")}.${String(hundredths % 100).padStart(2, "0")}`
}

export type StepKeys = { shift?: boolean; alt?: boolean }

/** A step: 0.01 s, 0.1 s with Shift, 0.001 s with Alt. */
export const stepSize = ({ shift, alt }: StepKeys) => (alt ? 0.001 : shift ? 0.1 : 0.01)

/** `t` moved one step in direction `dir` (1 or -1), on whole milliseconds. */
export const stepTime = (t: number, dir: 1 | -1, keys: StepKeys) => roundMs(t + dir * stepSize(keys))

export type EdgeResult = { ok: true; selection: SourceSelection; message?: undefined } |{ ok: false; selection: SourceSelection; message: string }

/**
 * A typed In or Out: the new selection when it's inside the file (0 to
 * `duration`) and leaves at least `minLength` (the whole file when shorter);
 * otherwise a message and the selection with the value clamped to the limit
 * (what the field takes when you leave it).
 */
export function typedEdge(sel: SourceSelection, side: "in" | "out", value: number, duration: number, minLength: number): EdgeResult {
  const min = Math.min(minLength, duration)
  if (side === "in") {
    const max = Math.max(0, sel.out - min)
    if (value < 0) return { ok: false, selection: { in: 0, out: sel.out }, message: "In can't be before 0." }
    if (value > max + 1e-9) return { ok: false, selection: { in: max, out: sel.out }, message: `In must be at least ${min} s before Out (${formatSeconds(max)} at the latest).` }
    return { ok: true, selection: { in: value, out: sel.out } }
  }
  const least = sel.in + min
  if (value > duration + 1e-9) return { ok: false, selection: { in: sel.in, out: duration }, message: `Out can't be past the end of the file (${formatSeconds(duration)}).` }
  if (value < least - 1e-9) return { ok: false, selection: { in: sel.in, out: Math.min(duration, least) }, message: `Out must be at least ${min} s after In (${formatSeconds(least)} at the earliest).` }
  return { ok: true, selection: { in: sel.in, out: value } }
}

/** In or Out set at source time `t` (the preview's playhead), to the millisecond, kept inside the file and the minimum length. */
export function playheadEdge(sel: SourceSelection, side: "in" | "out", t: number, duration: number, minLength: number): SourceSelection {
  return typedEdge(sel, side, roundMs(t), duration, minLength).selection
}

/** How near out (s) counts as the end of a loop, so a frame-late check still wraps before playing past it. */
const END = 0.02
/** How far before in (s) a time counts as outside the selection (a seek that landed early). */
const BEFORE = 0.05

/** Seconds into the selection of source time `t`, 0 to its length. */
export const selectionOffset = (t: number, sel: SourceSelection) => Math.min(sel.out - sel.in, Math.max(0, t - sel.in))

/** The source time for `offset` seconds into the selection, kept a little short of out so it doesn't wrap at once. */
export const seekInSelection = (sel: SourceSelection, offset: number) => sel.in + Math.min(Math.max(0, sel.out - sel.in - 0.03), Math.max(0, offset))

/** What the preview does at source time `t`: carry on, go back to in (at the end with loop on, or before in), or stop at the end. */
export function loopTick(t: number, sel: SourceSelection, loop: boolean): "play" | "restart" | "stop" {
  if (t < sel.in - BEFORE) return "restart"
  if (t >= sel.out - END) return loop ? "restart" : "stop"
  return "play"
}

/** Where playback goes when the selection changes: it carries on where it is when the new selection still holds that time, else starts again at in. */
export const keepPlaying = (t: number, sel: SourceSelection) => (t >= sel.in && t < sel.out - END ? t : sel.in)
