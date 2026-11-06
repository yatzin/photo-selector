import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { newProject } from "./project"
import { createSaveQueue, type SaveState } from "./save-queue"

const v0 = newProject("a")
const v1 = newProject("b")
const v2 = newProject("c")

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(results: boolean[] = []) {
  const saved: unknown[] = []
  const states: SaveState[] = []
  const save = vi.fn(async (p: unknown) => {
    saved.push(p)
    return results.length ? results.shift()! : true
  })
  const queue = createSaveQueue(save, v0, (s) => states.push(s), 800)
  return { queue, save, saved, states }
}

describe("createSaveQueue", () => {
  it("saves 800 ms after the last change, not before", async () => {
    const { queue, save } = setup()
    queue.update(v1)
    await vi.advanceTimersByTimeAsync(799)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledWith(v1)
  })

  it("doesn't save the project as loaded", async () => {
    const { queue, save } = setup()
    queue.update(v0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).not.toHaveBeenCalled()
  })

  it("flush saves a pending change at once and cancels the debounce", async () => {
    const { queue, save } = setup()
    queue.update(v1)
    expect(await queue.flush()).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("flush with nothing pending resolves true without saving", async () => {
    const { queue, save } = setup()
    expect(await queue.flush()).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it("flush resolves false when the save fails, and retries on the next flush", async () => {
    const { queue, save, states } = setup([false, true])
    queue.update(v1)
    expect(await queue.flush()).toBe(false)
    expect(states.at(-1)).toBe("error")
    expect(await queue.flush()).toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
    expect(states.at(-1)).toBe("saved")
  })

  it("treats a throwing save as a failure", async () => {
    const save = vi.fn(async () => {
      throw new Error("network")
    })
    const queue = createSaveQueue(save, v0, () => {}, 800)
    queue.update(v1)
    expect(await queue.flush()).toBe(false)
  })

  it("flush waits for a save already in flight and then saves the newer change", async () => {
    let release: (ok: boolean) => void = () => {}
    const save = vi.fn((p: unknown) => (p === v1 ? new Promise<boolean>((r) => (release = r)) : Promise.resolve(true)))
    const queue = createSaveQueue(save, v0, () => {}, 800)
    queue.update(v1)
    await vi.advanceTimersByTimeAsync(800)
    queue.update(v2)
    const flushed = queue.flush()
    release(true)
    expect(await flushed).toBe(true)
    expect(save.mock.calls.map((c) => c[0])).toEqual([v1, v2])
  })

  it("close saves a pending change", async () => {
    const { queue, save } = setup()
    queue.update(v1)
    queue.close()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledWith(v1)
  })
})
