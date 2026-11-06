const tails = new Map<string, Promise<unknown>>()

/** Runs tasks with the same key one after another (in this process); a failing task doesn't block the next. */
export function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve()
  const run = prev.then(task, task)
  const tail = run.catch(() => {})
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return run
}
