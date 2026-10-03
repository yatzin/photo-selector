// A small job queue with three lanes: thumbnails someone is looking at, the
// background worker's backlog, then AI scan preparation. A job asked for
// twice runs once, and a queued job moves up when someone asks for it at a
// higher priority.
//
// A caller can pass an AbortSignal (a browser request that may go away). If
// every caller waiting on a job that hasn't started gives up, the job is
// dropped — scrolling past a thumbnail shouldn't keep the NAS busy making
// it. A job that has already started always finishes; it's nearly done and
// its result is cached for next time.

export type Priority = "high" | "low" | "scan"
const ORDER: Priority[] = ["high", "low", "scan"]

type Job = { key: string; run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }
type Entry = { promise: Promise<unknown>; job: Job | null; priority: Priority; waiters: number }

export type TaskQueue = {
  run<T>(key: string, fn: () => Promise<T>, priority?: Priority, signal?: AbortSignal): Promise<T>
  readonly pending: number
  readonly active: number
}

function abortError(): Error {
  const e = new Error("The request was aborted.")
  e.name = "AbortError"
  return e
}

export function createTaskQueue(concurrency: number): TaskQueue {
  const lanes: Record<Priority, Job[]> = { high: [], low: [], scan: [] }
  const inFlight = new Map<string, Entry>()
  let active = 0

  function next() {
    while (active < concurrency) {
      const job = ORDER.map((p) => lanes[p]).find((l) => l.length)?.shift()
      if (!job) return
      const entry = inFlight.get(job.key)
      if (entry) entry.job = null // started; no longer movable or droppable
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

  /** One waiter left; drop the job if nobody else wants it and it hasn't started. */
  function release(key: string, entry: Entry) {
    entry.waiters--
    if (entry.waiters > 0 || !entry.job) return
    const lane = lanes[entry.priority]
    const i = lane.indexOf(entry.job)
    if (i >= 0) lane.splice(i, 1)
    if (inFlight.get(key) === entry) inFlight.delete(key)
  }

  /** The caller's view of a shared job: rejects early if the caller's signal aborts. */
  function attach<T>(key: string, entry: Entry, signal?: AbortSignal): Promise<T> {
    entry.waiters++
    if (!signal) return entry.promise as Promise<T>
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        release(key, entry)
        reject(abortError())
      }
      signal.addEventListener("abort", onAbort, { once: true })
      entry.promise.then(
        (v) => {
          signal.removeEventListener("abort", onAbort)
          resolve(v as T)
        },
        (e) => {
          signal.removeEventListener("abort", onAbort)
          reject(e)
        }
      )
    })
  }

  return {
    run<T>(key: string, fn: () => Promise<T>, priority: Priority = "high", signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(abortError())
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
        return attach<T>(key, existing, signal)
      }
      let job!: Job
      const promise = new Promise<unknown>((resolve, reject) => {
        job = { key, run: fn, resolve, reject }
      })
      // A dropped job's promise never settles; nobody is listening by then.
      promise.catch(() => {})
      const entry: Entry = { promise, job, priority, waiters: 0 }
      inFlight.set(key, entry)
      lanes[priority].push(job)
      const mine = attach<T>(key, entry, signal)
      next()
      return mine
    },
    get pending() {
      return ORDER.reduce((n, p) => n + lanes[p].length, 0)
    },
    get active() {
      return active
    },
  }
}
