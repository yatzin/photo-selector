// A small job queue with two lanes. Thumbnails someone is waiting for (the
// grid on screen) jump ahead of the background worker's backlog, and the same
// job asked for twice runs once.

export type Priority = "high" | "low"

type Job = { key: string; run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }

export type TaskQueue = {
  run<T>(key: string, fn: () => Promise<T>, priority?: Priority): Promise<T>
  readonly pending: number
  readonly active: number
}

export function createTaskQueue(concurrency: number): TaskQueue {
  const lanes: Record<Priority, Job[]> = { high: [], low: [] }
  const inFlight = new Map<string, { promise: Promise<unknown>; job: Job | null; priority: Priority }>()
  let active = 0

  function next() {
    while (active < concurrency) {
      const job = lanes.high.shift() ?? lanes.low.shift()
      if (!job) return
      const entry = inFlight.get(job.key)
      if (entry) entry.job = null // started; no longer movable between lanes
      active++
      job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          active--
          inFlight.delete(job.key)
          next()
        })
    }
  }

  return {
    run<T>(key: string, fn: () => Promise<T>, priority: Priority = "high"): Promise<T> {
      const existing = inFlight.get(key)
      if (existing) {
        // Someone is now waiting on a queued background job: move it up.
        if (priority === "high" && existing.priority === "low" && existing.job) {
          const i = lanes.low.indexOf(existing.job)
          if (i >= 0) {
            lanes.low.splice(i, 1)
            lanes.high.push(existing.job)
            existing.priority = "high"
          }
        }
        return existing.promise as Promise<T>
      }
      let job!: Job
      const promise = new Promise<unknown>((resolve, reject) => {
        job = { key, run: fn, resolve, reject }
      })
      inFlight.set(key, { promise, job, priority })
      lanes[priority].push(job)
      next()
      return promise as Promise<T>
    },
    get pending() {
      return lanes.high.length + lanes.low.length
    },
    get active() {
      return active
    },
  }
}
