import type { Project } from "./project"

export type SaveState = "saved" | "saving" | "error"

/**
 * Saves the latest project `delay` ms after the last change, one save at a
 * time. `flush` saves any pending change now and resolves true only when the
 * latest project is stored; a failed save is retried by the next flush.
 * The project as loaded counts as saved.
 */
export function createSaveQueue(save: (p: Project) => Promise<boolean>, initial: Project, onState: (s: SaveState) => void, delay = 800) {
  let latest = initial
  let attempted = initial
  let confirmed = initial
  let inflight = 0
  let chain: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | null = null

  function start() {
    if (timer) clearTimeout(timer)
    timer = null
    if (latest === attempted) return
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
        if (latest === toSave) onState("saved")
      } else {
        onState("error")
      }
    })
  }

  return {
    update(p: Project) {
      latest = p
      if (timer) clearTimeout(timer)
      timer = null
      if (p !== attempted) timer = setTimeout(start, delay)
    },
    async flush(): Promise<boolean> {
      // The last attempt at this project failed: let start() try it again.
      if (inflight === 0 && latest !== confirmed) attempted = confirmed
      start()
      await chain
      return latest === confirmed
    },
    /** True while a change is waiting, being saved, or failed to save. */
    isDirty(): boolean {
      return timer !== null || inflight > 0 || latest !== confirmed
    },
    /** Saves a pending change without waiting (the editor is closing). */
    close() {
      start()
    },
  }
}
