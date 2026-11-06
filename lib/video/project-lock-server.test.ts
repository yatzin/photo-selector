import { describe, expect, it } from "vitest"
import { withLock } from "./project-lock-server"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("withLock", () => {
  it("runs overlapping tasks for one key serially", async () => {
    const log: string[] = []
    const task = (name: string, ms: number) => async () => {
      log.push(`${name} start`)
      await sleep(ms)
      log.push(`${name} end`)
    }
    await Promise.all([withLock("k", task("a", 30)), withLock("k", task("b", 1))])
    expect(log).toEqual(["a start", "a end", "b start", "b end"])
  })

  it("releases the lock when a task throws", async () => {
    const failed = withLock("k2", async () => {
      throw new Error("boom")
    })
    await expect(failed).rejects.toThrow("boom")
    await expect(withLock("k2", async () => 42)).resolves.toBe(42)
  })

  it("doesn't block other keys", async () => {
    const log: string[] = []
    await Promise.all([
      withLock("x", async () => {
        await sleep(30)
        log.push("x")
      }),
      withLock("y", async () => {
        log.push("y")
      }),
    ])
    expect(log).toEqual(["y", "x"])
  })
})
