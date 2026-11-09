import type { Project } from "./project"

export type SaveState = "saved" | "saving" | "error"

/**
 * Saves the latest project once changes have been quiet for `delay` ms, or
 * `maxWait` ms into a long burst, one save at a time; a burst always ends in
 * one save of its latest state. A change back to what was last sent (`same`)
 * saves nothing. `flush` saves any pending change now and resolves true only
 * when the latest project is stored; a failed save is retried by the next
 * flush. The project as loaded counts as saved.
 */
export function createSaveQueue(
  save: (p: Project) => Promise<boolean>,
  initial: Project,
  onState: (s: SaveState) => void,
  delay = 1500,
  maxWait = 5000,
  same: (a: Project, b: Project) => boolean = Object.is
) {
  let latest = initial
  let attempted = initial
  let confirmed = initial
  let inflight = 0
  let chain: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | null = null
  let maxTimer: ReturnType<typeof setTimeout> | null = null

  function cancel() {
    if (timer) clearTimeout(timer)
    if (maxTimer) clearTimeout(maxTimer)
    timer = null
    maxTimer = null
  }

  function start() {
    cancel()
    if (same(latest, attempted)) return
    const toSave = latest
    attempted = toSave
    inflight++
    onState("saving")
    chain = chain.then(async () => {
      let ok = false
      try {
        ok = await save(toSave)
      } catch {
        ok = false
      }
      inflight--
      if (ok) {
        confirmed = toSave
        if (same(latest, toSave)) onState("saved")
      } else {
        onState("error")
      }
    })
  }

  return {
    update(p: Project) {
      latest = p
      if (same(p, attempted)) {
        cancel()
        // Back to what's stored with nothing in flight: a "saving" shown for the change undone is over.
        if (inflight === 0 && same(attempted, confirmed)) onState("saved")
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(start, delay)
      maxTimer ??= setTimeout(start, maxWait)
    },
    async flush(): Promise<boolean> {
      // The last attempt at this project failed: let start() try it again.
      if (inflight === 0 && !same(latest, confirmed)) attempted = confirmed
      start()
      await chain
      return same(latest, confirmed)
    },
    /** True while a change is waiting, being saved, or failed to save. */
    isDirty(): boolean {
      return timer !== null || inflight > 0 || !same(latest, confirmed)
    },
    /** Saves a pending change without waiting (the editor is closing). */
    close() {
      start()
    },
  }
}
