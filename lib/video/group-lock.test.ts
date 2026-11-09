import { describe, expect, it } from "vitest"
import { beginMove, chainIds, chainKey, createLockState, isUnlocked, lock, reconcile, remainingMs, requestUnlock, UNLOCK_WINDOW_MS } from "./group-lock"

const A = chainKey(["b", "a"])
const B = chainKey(["c", "d"])

describe("group lock", () => {
  it("keys a chain by its sorted clip ids", () => {
    expect(chainKey(["b", "a", "c"])).toBe(chainKey(["c", "b", "a"]))
    expect(chainKey(["a", "b"])).not.toBe(chainKey(["a", "b", "c"]))
    expect(chainIds(chainKey(["b", "a"]))).toEqual(["a", "b"])
  })

  it("is locked by default", () => {
    const s = createLockState()
    expect(isUnlocked(s, A, 0)).toBe(false)
    expect(remainingMs(s, A, 0)).toBeNull()
  })

  it("a window of 5 minutes by default", () => {
    expect(UNLOCK_WINDOW_MS).toBe(5 * 60 * 1000)
    expect(createLockState().windowMs).toBe(UNLOCK_WINDOW_MS)
  })

  it("a pending unlock does not start the clock", () => {
    const s = requestUnlock(createLockState(), A, 1000)
    expect(isUnlocked(s, A, 1000 + 60_000)).toBe(true)
    expect(remainingMs(s, A, 1000 + 60_000)).toBeNull()
  })

  it("a pending unlock that is never used lapses after the window", () => {
    const s = requestUnlock(createLockState(), A, 1000)
    expect(isUnlocked(s, A, 1000 + UNLOCK_WINDOW_MS - 1)).toBe(true)
    expect(isUnlocked(s, A, 1000 + UNLOCK_WINDOW_MS)).toBe(false)
  })

  it("the first move starts the clock, later moves don't restart it", () => {
    let s = requestUnlock(createLockState(), A, 0)
    s = beginMove(s, A, 10_000)
    expect(remainingMs(s, A, 10_000)).toBe(UNLOCK_WINDOW_MS)
    s = beginMove(s, A, 70_000)
    s = beginMove(s, A, 130_000)
    expect(isUnlocked(s, A, 130_000)).toBe(true)
    expect(remainingMs(s, A, 130_000)).toBe(UNLOCK_WINDOW_MS - 120_000)
  })

  it("a move on a locked chain changes nothing", () => {
    const s = createLockState()
    expect(beginMove(s, A, 0)).toBe(s)
    expect(isUnlocked(beginMove(s, A, 0), A, 0)).toBe(false)
  })

  it("locks at exactly the deadline", () => {
    const s = beginMove(requestUnlock(createLockState(), A, 0), A, 5000)
    expect(isUnlocked(s, A, 5000 + UNLOCK_WINDOW_MS - 1)).toBe(true)
    expect(remainingMs(s, A, 5000 + UNLOCK_WINDOW_MS - 1)).toBe(1)
    expect(isUnlocked(s, A, 5000 + UNLOCK_WINDOW_MS)).toBe(false)
    expect(remainingMs(s, A, 5000 + UNLOCK_WINDOW_MS)).toBeNull()
    // A move after the deadline doesn't open a new window.
    expect(isUnlocked(beginMove(s, A, 5000 + UNLOCK_WINDOW_MS + 1), A, 5000 + UNLOCK_WINDOW_MS + 1)).toBe(false)
  })

  it("lock (the transition dialog) stops the clock and locks", () => {
    let s = beginMove(requestUnlock(createLockState(), A, 0), A, 0)
    s = lock(s, A)
    expect(isUnlocked(s, A, 1)).toBe(false)
    expect(remainingMs(s, A, 1)).toBeNull()
  })

  it("reconcile drops chains whose membership changed", () => {
    let s = beginMove(requestUnlock(createLockState(), A, 0), A, 0)
    s = reconcile(s, [chainKey(["a", "b", "x"])])
    expect(isUnlocked(s, A, 1)).toBe(false)
  })

  it("reconcile keeps chains that still match", () => {
    const s = beginMove(requestUnlock(createLockState(), A, 0), A, 0)
    expect(reconcile(s, [A, B])).toBe(s)
    expect(isUnlocked(reconcile(s, [A]), A, 1)).toBe(true)
  })

  it("chains are independent", () => {
    let s = requestUnlock(createLockState(), A, 0)
    expect(isUnlocked(s, B, 0)).toBe(false)
    s = beginMove(requestUnlock(s, B, 0), B, 100)
    s = lock(s, A)
    expect(isUnlocked(s, A, 200)).toBe(false)
    expect(remainingMs(s, B, 200)).toBe(UNLOCK_WINDOW_MS - 100)
  })

  it("takes a shorter window (the browser test's hook)", () => {
    const s = beginMove(requestUnlock(createLockState(2000), A, 0), A, 0)
    expect(isUnlocked(s, A, 1999)).toBe(true)
    expect(isUnlocked(s, A, 2000)).toBe(false)
  })
})
