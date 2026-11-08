// Which chains of linked clips (clips a transition or audio overlap joins on
// one layer) may be dragged as a group. Every chain is locked by default.
// "Move group" unlocks one (pending); its first drag starts a window of
// UNLOCK_WINDOW_MS in which it can be moved any number of times, and it locks
// again at the deadline. A pending unlock that is never used lapses after the
// same time from the click. A chain is keyed by its sorted clip ids, so a
// chain whose membership changes is a different, locked one. Times are
// wall-clock ms (Date.now) passed in, so tests need no timers and a throttled
// tab can't stretch the window. Kept in the timeline's state only: never saved.

/** ms a group stays movable from its first drag. */
export const UNLOCK_WINDOW_MS = 5 * 60 * 1000

/** An unlocked chain: when "Move group" was clicked, and the deadline once its first drag started (null until then). */
type Entry = { from: number; deadline: number | null }

export type LockState = { windowMs: number; unlocked: Readonly<Record<string, Entry>> }

/** A chain's key: its clip ids, sorted. */
export const chainKey = (ids: readonly string[]) => [...ids].sort().join("|")

/** The clip ids in a chain's key. */
export const chainIds = (key: string) => key.split("|")

/** Every chain locked; `windowMs` overrides the window (the browser test's hook). */
export const createLockState = (windowMs = UNLOCK_WINDOW_MS): LockState => ({ windowMs, unlocked: {} })

/** The pending unlock "Move group" asks for, at `now`; the clock doesn't run yet. */
export const requestUnlock = (s: LockState, key: string, now = Date.now()): LockState => ({ ...s, unlocked: { ...s.unlocked, [key]: { from: now, deadline: null } } })

/** Whether the chain may move at `now`: pending (within the window from the click), or before its deadline. */
export function isUnlocked(s: LockState, key: string, now: number): boolean {
  const e = s.unlocked[key]
  if (!e) return false
  return e.deadline === null ? now < e.from + s.windowMs : now < e.deadline
}

/** A drag of the chain starts at `now`: the first one starts the window. The same state when it's locked or already running. */
export function beginMove(s: LockState, key: string, now: number): LockState {
  const e = s.unlocked[key]
  if (!e || e.deadline !== null || !isUnlocked(s, key, now)) return s
  return { ...s, unlocked: { ...s.unlocked, [key]: { ...e, deadline: now + s.windowMs } } }
}

/** ms left in the chain's window at `now`; null when it's locked or pending (the clock not running). */
export function remainingMs(s: LockState, key: string, now: number): number | null {
  const e = s.unlocked[key]
  if (!e || e.deadline === null || !isUnlocked(s, key, now)) return null
  return e.deadline - now
}

/** Locks the chain at once (its transition dialog opened, or the user moved on). */
export function lock(s: LockState, key: string): LockState {
  if (!(key in s.unlocked)) return s
  return reconcile(s, Object.keys(s.unlocked).filter((k) => k !== key))
}

/** Keeps only the chains still in `validKeys` (an edit, undo or redo changed the others' membership). */
export function reconcile(s: LockState, validKeys: Iterable<string>): LockState {
  const valid = new Set(validKeys)
  const keys = Object.keys(s.unlocked)
  if (keys.every((k) => valid.has(k))) return s
  return { ...s, unlocked: Object.fromEntries(keys.filter((k) => valid.has(k)).map((k) => [k, s.unlocked[k]])) }
}
