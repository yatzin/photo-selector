// How the preview keeps the lanes that follow the clock in step with it (see
// use-preview-player): when the clock's own video stalls, and when a
// following video has drifted far enough to be re-seeked.

/** HTMLMediaElement.HAVE_FUTURE_DATA: enough data to play on from here. */
export const HAVE_FUTURE_DATA = 3
/** ms the clock's video time may stand still before it counts as stalled. */
export const STALL_MS = 250
/** Seconds a following lane may drift from the clock before it is re-seeked. */
export const DRIFT = 0.3
/** ms after a corrective seek before a lane may be re-seeked again. */
export const RESYNC_COOLDOWN = 1000
/** Seconds a corrective seek goes ahead of the clock, to cover the time the seek takes. */
export const SEEK_LEAD = 0.1

/** Whether the clock's video is stalled: no data to play on, or its time hasn't moved for STALL_MS. */
export function clockStalled(readyState: number, msSinceMoved: number): boolean {
  return readyState < HAVE_FUTURE_DATA || msSinceMoved >= STALL_MS
}

/**
 * Where to re-seek a following lane's video (at `current`, the clock says
 * `expected`), or null to leave it: within DRIFT, within RESYNC_COOLDOWN ms
 * of its last corrective seek (`lastResync`, at `now`), or with `expected` at
 * or past `limit` (the clip's out point or the file's end).
 */
export function resyncTo(o: { current: number; expected: number; limit: number; now: number; lastResync: number }): number | null {
  if (o.now - o.lastResync < RESYNC_COOLDOWN) return null
  if (Math.abs(o.current - o.expected) <= DRIFT || !(o.expected < o.limit)) return null
  return Math.min(o.expected + SEEK_LEAD, o.limit)
}
