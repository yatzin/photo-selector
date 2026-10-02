// A small job queue with three lanes: thumbnails someone is looking at, the
// background worker's backlog, then AI scan preparation. A job asked for
// twice runs once, and a queued job moves up when someone asks for it at a
// higher priority.

export type Priority = "high" | "low" | "scan"
const ORDER: Priority[] = ["high", "low", "scan"]

type Job = { key: string; run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }

export type TaskQueue = {
  run<T>(key: string, fn: () => Promise<T>, priority?: Priority): Promise<T>
  readonly pending: number
  readonly active: number
}

export function createTaskQueue(concurrency: number): TaskQueue {
  const lanes: Record<Priority, Job[]> = { high: [], low: [], scan: [] }
  const inFlight = new Map<string, { promise: Promise<unknown>; job: Job | null; priority: Priority }>()
  let active = 0

  function next() {
    while (active < concurrency) {
      const job = ORDER.map((p) => lanes[p]).find((l) => l.length)?.shift()
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
        if (existing.job && ORDER.indexOf(priority) < ORDER.indexOf(existing.priority)) {
          const lane = lanes[existing.priority]
          const i = lane.indexOf(existing.job)
          if (i >= 0) {
            lane.splice(i, 1)
            lanes[priority].push(existing.job)
            existing.priority = priority
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
      return ORDER.reduce((n, p) => n + lanes[p].length, 0)
    },
    get active() {
      return active
    },
  }
}
