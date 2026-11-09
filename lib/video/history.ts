// Undo/redo for the editor: the last HISTORY_LIMIT states before the present
// and the ones undone after it. A commit tagged with a `group` that follows a
// commit of the same group within GROUP_WINDOW ms (a held key, quick nudges)
// replaces the present instead of adding a step, so it undoes as one.

export const HISTORY_LIMIT = 50
export const GROUP_WINDOW = 400 // ms

export type History<T> = {
  past: T[]
  present: T
  future: T[]
  /** The group and time of the last commit, while it can still be extended. */
  last?: { group: string; at: number }
}

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] }
}

/** Same object, or the same values under the same keys (compared by identity). */
function unchanged<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  const ka = Object.keys(a) as (keyof T)[]
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && Object.is(a[k], b[k]))
}

export function commit<T>(h: History<T>, next: T, group?: string, now = Date.now()): History<T> {
  if (unchanged(h.present, next)) return h
  const last = group === undefined ? undefined : { group, at: now }
  if (group !== undefined && h.last?.group === group && now - h.last.at < GROUP_WINDOW) {
    return { past: h.past, present: next, future: [], last }
  }
  const past = [...h.past, h.present]
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT)
  return { past, present: next, future: [], last }
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0
}

export function canRedo<T>(h: History<T>): boolean {
  return h.future.length > 0
}

export function undo<T>(h: History<T>): History<T> {
  if (!canUndo(h)) return h
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] }
}

export function redo<T>(h: History<T>): History<T> {
  if (!canRedo(h)) return h
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }
}
