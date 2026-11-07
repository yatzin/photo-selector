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
  const queue = createSaveQueue(save, v0, (s) => states.push(s))
  return { queue, save, saved, states }
}

describe("createSaveQueue", () => {
  it("saves 1500 ms after the last change, not before", async () => {
    const { queue, save } = setup()
    queue.update(v1)
    await vi.advanceTimersByTimeAsync(1499)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledWith(v1)
  })

  it("collapses a burst of 20 changes in 1 s into one save of the latest", async () => {
    const { queue, save } = setup()
    const versions = Array.from({ length: 20 }, (_, i) => newProject(`v${i}`))
    for (const v of versions) {
      queue.update(v)
      await vi.advanceTimersByTimeAsync(50)
    }
    await vi.advanceTimersByTimeAsync(5000)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(versions.at(-1))
  })

  it("saves every 5 s during 12 s of continuous changes, then once after they stop", async () => {
    const { queue, save } = setup()
    const at: number[] = []
    save.mockImplementation(async () => {
      at.push(Date.now() - start)
      return true
    })
    const start = Date.now()
    for (let i = 1; i <= 120; i++) {
      queue.update(newProject(`v${i}`))
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(5000)
    expect(save).toHaveBeenCalledTimes(3)
    expect(at[0]).toBe(5000)
    expect(at[1]).toBeGreaterThanOrEqual(10000)
    expect(at[1]).toBeLessThanOrEqual(10200)
    // The last change came at 11.9 s.
    expect(at[2]).toBe(11900 + 1500)
    expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ name: "v120" })
  })

  it("doesn't save a change that goes back to the saved state", async () => {
    const { queue, save } = setup()
    queue.update(v1)
    await vi.advanceTimersByTimeAsync(300)
    queue.update(v0)
    expect(queue.isDirty()).toBe(false)
    await vi.advanceTimersByTimeAsync(10000)
    expect(save).not.toHaveBeenCalled()
  })

  it("compares with `same`, so an equal copy of the saved state doesn't save", async () => {
    const save = vi.fn(async () => true)
    const queue = createSaveQueue(save, v0, () => {}, undefined, undefined, (a, b) => a.tracks === b.tracks)
    queue.update({ ...v0 })
    await vi.advanceTimersByTimeAsync(10000)
    expect(save).not.toHaveBeenCalled()
    expect(queue.isDirty()).toBe(false)
    expect(await queue.flush()).toBe(true)
    queue.update({ ...v0, tracks: [] })
    expect(queue.isDirty()).toBe(true)
  })

  it("saves the latest change after going back to a state while another one was in flight", async () => {
    let release: (ok: boolean) => void = () => {}
    const save = vi.fn((p: unknown) => (p === v1 ? new Promise<boolean>((r) => (release = r)) : Promise.resolve(true)))
    const queue = createSaveQueue(save, v0, () => {})
    queue.update(v1)
    await vi.advanceTimersByTimeAsync(1500)
    queue.update(v0)
    release(true)
    await vi.advanceTimersByTimeAsync(1500)
    expect(save.mock.calls.map((c) => c[0])).toEqual([v1, v0])
    expect(queue.isDirty()).toBe(false)
  })

  it("says saved after an undo back to a stored state that was saved while a newer change waited", async () => {
    let release: (ok: boolean) => void = () => {}
    const states: SaveState[] = []
    const save = vi.fn((p: unknown) => (p === v1 ? new Promise<boolean>((r) => (release = r)) : Promise.resolve(true)))
    const queue = createSaveQueue(save, v0, (s) => states.push(s))
    queue.update(v1)
    await vi.advanceTimersByTimeAsync(1500)
    queue.update(v2)
    release(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe("saving")
    queue.update(v1)
    expect(states.at(-1)).toBe("saved")
    await vi.advanceTimersByTimeAsync(10000)
    expect(save).toHaveBeenCalledTimes(1)
    expect(queue.isDirty()).toBe(false)
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

  it("isDirty: clean as loaded, dirty while pending or in flight, clean once stored", async () => {
    let release: (ok: boolean) => void = () => {}
    const save = vi.fn(() => new Promise<boolean>((r) => (release = r)))
    const queue = createSaveQueue(save, v0, () => {}, 800)
    expect(queue.isDirty()).toBe(false)
    queue.update(v1)
    expect(queue.isDirty()).toBe(true)
    await vi.advanceTimersByTimeAsync(800)
    expect(save).toHaveBeenCalledTimes(1)
    expect(queue.isDirty()).toBe(true)
    release(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.isDirty()).toBe(false)
  })

  it("isDirty stays true after a failed save", async () => {
    const { queue } = setup([false])
    queue.update(v1)
    await queue.flush()
    expect(queue.isDirty()).toBe(true)
  })

  it("close saves a pending change", async () => {
    const { queue, save } = setup()
    queue.update(v1)
    queue.close()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledWith(v1)
  })
})
