import { describe, expect, it } from "vitest"
import { canRedo, canUndo, commit, createHistory, GROUP_WINDOW, HISTORY_LIMIT, redo, undo } from "./history"

type S = { clips: number[] }
const s = (...clips: number[]): S => ({ clips })

describe("history", () => {
  it("starts with nothing to undo or redo", () => {
    const h = createHistory(s(1))
    expect(h.present).toEqual(s(1))
    expect(canUndo(h)).toBe(false)
    expect(canRedo(h)).toBe(false)
  })

  it("commit pushes the present, undo and redo walk back and forth", () => {
    const a = s(1)
    const b = s(1, 2)
    const c = s(1, 2, 3)
    let h = commit(commit(createHistory(a), b, undefined, 0), c, undefined, 1000)
    expect(h.past).toEqual([a, b])
    h = undo(h)
    expect(h.present).toBe(b)
    expect(canRedo(h)).toBe(true)
    h = undo(h)
    expect(h.present).toBe(a)
    expect(canUndo(h)).toBe(false)
    expect(undo(h)).toBe(h)
    h = redo(redo(h))
    expect(h.present).toBe(c)
    expect(redo(h)).toBe(h)
  })

  it("a commit after an undo drops the redo branch", () => {
    const a = s(1)
    let h = undo(commit(createHistory(a), s(2), undefined, 0))
    h = commit(h, s(3), undefined, 1000)
    expect(canRedo(h)).toBe(false)
    expect(h.past).toEqual([a])
  })

  it("ignores a commit that changes nothing", () => {
    const clips = [1, 2]
    const h = createHistory<S>({ clips })
    expect(commit(h, h.present)).toBe(h)
    expect(commit(h, { clips })).toBe(h)
    expect(commit(h, { clips: [1, 2] })).not.toBe(h)
  })

  it(`keeps the last ${HISTORY_LIMIT} steps, dropping the oldest`, () => {
    let h = createHistory(s(0))
    for (let i = 1; i <= HISTORY_LIMIT + 5; i++) h = commit(h, s(i), undefined, i * 1000)
    expect(h.past).toHaveLength(HISTORY_LIMIT)
    expect(h.past[0]).toEqual(s(5))
    for (let i = 0; i < HISTORY_LIMIT; i++) h = undo(h)
    expect(h.present).toEqual(s(5))
    expect(canUndo(h)).toBe(false)
  })

  it("coalesces commits of the same group less than the window apart", () => {
    const a = s(0)
    let h = createHistory(a)
    for (let i = 1; i <= 10; i++) h = commit(h, s(i), "nudge", i * 100)
    expect(h.past).toEqual([a])
    expect(h.present).toEqual(s(10))
    expect(undo(h).present).toBe(a)
  })

  it("starts a new entry after the window, for another group, or without a group", () => {
    let h = commit(createHistory(s(0)), s(1), "nudge", 0)
    h = commit(h, s(2), "nudge", GROUP_WINDOW)
    expect(h.past).toHaveLength(2)
    h = commit(h, s(3), "trim", GROUP_WINDOW + 10)
    expect(h.past).toHaveLength(3)
    h = commit(h, s(4), undefined, GROUP_WINDOW + 20)
    h = commit(h, s(5), undefined, GROUP_WINDOW + 30)
    expect(h.past).toHaveLength(5)
  })

  it("an undo ends a group", () => {
    let h = commit(createHistory(s(0)), s(1), "nudge", 0)
    h = commit(undo(h), s(2), "nudge", 100)
    expect(h.past).toEqual([s(0)])
    expect(h.present).toEqual(s(2))
    h = commit(redo(undo(h)), s(3), "nudge", 200)
    expect(h.past).toEqual([s(0), s(2)])
  })
})
