import { describe, expect, it } from "vitest"
import { clockStalled, HAVE_FUTURE_DATA, resyncTo, RESYNC_COOLDOWN, SEEK_LEAD, STALL_MS } from "./follow"

describe("clockStalled", () => {
  it("is stalled without data to play on", () => {
    expect(clockStalled(HAVE_FUTURE_DATA - 1, 0)).toBe(true)
  })
  it("is stalled when the time hasn't moved for STALL_MS", () => {
    expect(clockStalled(HAVE_FUTURE_DATA, STALL_MS - 1)).toBe(false)
    expect(clockStalled(HAVE_FUTURE_DATA, STALL_MS)).toBe(true)
  })
})

describe("resyncTo", () => {
  const base = { current: 10, expected: 10, limit: 20, now: 5000, lastResync: -Infinity }
  it("leaves a lane within the drift alone", () => {
    expect(resyncTo({ ...base, current: 10.29 })).toBeNull()
  })
  it("seeks a drifted lane a little ahead of the clock, to cover the seek", () => {
    expect(resyncTo({ ...base, current: 11 })).toBeCloseTo(10 + SEEK_LEAD)
    expect(resyncTo({ ...base, current: 9 })).toBeCloseTo(10 + SEEK_LEAD)
  })
  it("waits RESYNC_COOLDOWN after the last corrective seek", () => {
    expect(resyncTo({ ...base, current: 12, lastResync: base.now - RESYNC_COOLDOWN + 1 })).toBeNull()
    expect(resyncTo({ ...base, current: 12, lastResync: base.now - RESYNC_COOLDOWN })).toBeCloseTo(10 + SEEK_LEAD)
  })
  it("doesn't seek at or past the limit, and never past it", () => {
    expect(resyncTo({ ...base, current: 5, expected: 20 })).toBeNull()
    expect(resyncTo({ ...base, current: 5, expected: 19.95 })).toBe(20)
  })
})
