import { describe, expect, it } from "vitest"
import { daysLeft, expiresAt, isExpired } from "./retention"

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime()

describe("retention", () => {
  it("expires six calendar months after the last change", () => {
    expect(new Date(expiresAt(at(2026, 1, 15))).getMonth()).toBe(6)
    expect(new Date(expiresAt(at(2026, 1, 15))).getDate()).toBe(15)
  })

  it("is expired on and after that moment, not before", () => {
    const m = at(2026, 1, 15)
    expect(isExpired(m, expiresAt(m) - 1)).toBe(false)
    expect(isExpired(m, expiresAt(m))).toBe(true)
  })

  it("counts the days left, never below zero", () => {
    const m = at(2026, 1, 15)
    expect(daysLeft(m, expiresAt(m) - 10 * 86_400_000)).toBe(10)
    expect(daysLeft(m, expiresAt(m) + 5 * 86_400_000)).toBe(0)
  })
})
