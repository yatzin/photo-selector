// Remembers an async result for a short time, so a page that refreshes every
// few seconds doesn't redo slow work (walking folders on a network share).
// Concurrent callers share one load; a failed load isn't remembered.

export function createTtlCache(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { at: number; value: Promise<unknown> }>()
  return {
    get<T>(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key)
      if (hit && now() - hit.at < ttlMs) return hit.value as Promise<T>
      const value = load()
      entries.set(key, { at: now(), value })
      value.catch(() => entries.delete(key))
      return value
    },
    /** Forgets everything, so the next get loads fresh (after the data changed). */
    clear() {
      entries.clear()
    },
  }
}
