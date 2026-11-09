// The source strip in the Edit length dialog: the whole media file drawn
// across the strip, with the clip's source window [in, out) on it. Pure maths
// for mapping pixels and seconds, dragging the window's handles or body, the
// keyboard steps and the strip's tick marks.

export type SourceSelection = { in: number; out: number }
export type SourceDragMode = "in" | "out" | "move"

/** Px from the strip's left edge of source time `t`. */
export const timeToX = (t: number, duration: number, width: number): number => (duration > 0 ? (t / duration) * width : 0)

/** Source time at `x` px from the strip's left edge, clamped to the source. */
export function xToTime(x: number, duration: number, width: number): number {
  if (!(width > 0) || !(duration > 0)) return 0
  return Math.min(duration, Math.max(0, (x / width) * duration))
}

/** The nearest of `points` within `within` seconds of `t`, or `t`. */
function snapTo(t: number, points: number[], within: number): number {
  let best = t
  let gap = within
  for (const p of points) {
    const d = Math.abs(p - t)
    if (d <= gap) {
      best = p
      gap = d
    }
  }
  return best
}

/**
 * The selection after a drag of `deltaSeconds` from `selection` (the window
 * when the drag began): "in" moves the left handle, "out" the right one,
 * "move" slides the window keeping its length. With `snapOn`, the moved edge
 * (either edge when sliding, whichever is nearer) lands on one of
 * `snapPoints` within `snapWithin` seconds. Always inside 0..sourceDuration
 * and at least `minLength` long (the whole source when it is shorter).
 */
export function dragSelection(
  mode: SourceDragMode, sourceDuration: number, selection: SourceSelection, deltaSeconds: number, minLength: number,
  snapPoints: number[], snapOn: boolean, snapWithin = 0
): SourceSelection {
  const d = Math.max(0, sourceDuration)
  const min = Math.min(minLength, d)
  const snap = (t: number) => (snapOn ? snapTo(t, snapPoints, snapWithin) : t)
  if (mode === "in") {
    const out = Math.min(d, selection.out)
    return { in: Math.min(out - min, Math.max(0, snap(selection.in + deltaSeconds))), out }
  }
  if (mode === "out") {
    const start = Math.max(0, selection.in)
    return { in: start, out: Math.max(start + min, Math.min(d, snap(selection.out + deltaSeconds))) }
  }
  const len = Math.min(d, Math.max(min, selection.out - selection.in))
  let a = selection.in + deltaSeconds
  if (snapOn) {
    let shift = 0
    let gap = snapWithin
    for (const p of snapPoints) {
      for (const s of [p - a, p - (a + len)]) {
        if (Math.abs(s) <= gap && (shift === 0 || Math.abs(s) < Math.abs(shift))) {
          shift = s
          gap = Math.abs(s)
        }
      }
    }
    a += shift
  }
  a = Math.min(d - len, Math.max(0, a))
  return { in: a, out: a + len }
}

/** The selection after a key on a handle (`mode` "in"/"out") or the window ("move"), or null for a key it doesn't use. */
export function stepSelection(
  mode: SourceDragMode, sourceDuration: number, selection: SourceSelection, key: string, shift: boolean, minLength: number
): SourceSelection | null {
  const step = shift ? 0.1 : 0.01
  // Rounded off float drift (well inside the model's 1e-9 slack), so repeated steps land on whole hundredths.
  const tidy = (t: number) => Math.round(t * 1e10) / 1e10
  const by = (delta: number) => {
    const next = dragSelection(mode, sourceDuration, selection, delta, minLength, [], false)
    return { in: tidy(next.in), out: tidy(next.out) }
  }
  if (key === "ArrowRight" || key === "ArrowUp") return by(step)
  if (key === "ArrowLeft" || key === "ArrowDown") return by(-step)
  if (key === "Home") return by(-sourceDuration)
  if (key === "End") return by(sourceDuration)
  return null
}

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

/**
 * Times for the strip's intermediate tick marks (the ends are labelled on
 * their own): multiples of the smallest round step at least `minGapPx` apart,
 * leaving out one too close to the end's label.
 */
export function sourceTicks(duration: number, widthPx: number, minGapPx = 70): number[] {
  if (!(duration > 0) || !(widthPx > 0)) return []
  const pxPerSec = widthPx / duration
  const step = STEPS.find((s) => s * pxPerSec >= minGapPx) ?? Math.ceil(minGapPx / pxPerSec / 3600) * 3600
  const ticks: number[] = []
  for (let i = 1; ; i++) {
    const t = Math.round(i * step * 1000) / 1000
    if ((duration - t) * pxPerSec < minGapPx * 0.75) break
    ticks.push(t)
  }
  return ticks
}
