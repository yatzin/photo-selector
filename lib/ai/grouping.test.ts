import { describe, expect, it } from "vitest"
import { groupPhotos, isSimilar, splitGroup, type GroupInput } from "./grouping"

const fp = (hash: bigint, shade = 100) => ({ hash, colors: Array(48).fill(shade) })
const p = (name: string, sec: number, hash: bigint, shade = 100): GroupInput => ({ name, takenAt: sec * 1000, fp: fp(hash, shade) })
const opts = { windowSeconds: 60, similarity: "similar" as const, maxGroupSize: 12 }
const names = (groups: GroupInput[][]) => groups.map((g) => g.map((x) => x.name))

const A = 0b1010_1010n
const A2 = A ^ 0b111n // 3 bits away
const FAR = ~A & ((1n << 64n) - 1n) // 64 bits away

describe("isSimilar", () => {
  it("needs both shape and colour to be close", () => {
    expect(isSimilar(fp(A), fp(A2), "similar")).toBe(true)
    expect(isSimilar(fp(A), fp(FAR), "similar")).toBe(false)
    expect(isSimilar(fp(A, 100), fp(A, 160), "similar")).toBe(false)
  })

  it("strict is stricter than loose", () => {
    const tenAway = A ^ 0b11_1111_1111n
    expect(isSimilar(fp(A), fp(tenAway), "strict")).toBe(false)
    expect(isSimilar(fp(A), fp(tenAway), "loose")).toBe(true)
  })
})

describe("groupPhotos", () => {
  it("groups similar shots taken close together", () => {
    expect(names(groupPhotos([p("1", 0, A), p("2", 5, A2), p("3", 10, A)], opts))).toEqual([["1", "2", "3"]])
  })

  it("drops singletons and different scenes", () => {
    expect(names(groupPhotos([p("1", 0, A), p("2", 5, FAR)], opts))).toEqual([])
  })

  it("never groups across the time window", () => {
    expect(names(groupPhotos([p("1", 0, A), p("2", 61, A)], opts))).toEqual([])
    expect(names(groupPhotos([p("1", 0, A), p("2", 60, A)], opts))).toEqual([["1", "2"]])
  })

  it("chains A~B~C even when A and C are outside the window", () => {
    expect(names(groupPhotos([p("1", 0, A), p("2", 50, A), p("3", 100, A)], opts))).toEqual([["1", "2", "3"]])
  })

  it("sorts by time regardless of input order and orders groups by first photo", () => {
    const out = groupPhotos([p("d", 500, FAR), p("b", 10, A), p("c", 490, FAR), p("a", 0, A)], opts)
    expect(names(out)).toEqual([["a", "b"], ["c", "d"]])
  })

  it("splits a 40-shot burst into chunks no larger than the max, with no chunk of 1", () => {
    const burst = Array.from({ length: 40 }, (_, i) => p(`b${i}`, i, A))
    const out = groupPhotos(burst, { ...opts, maxGroupSize: 12 })
    expect(out.map((g) => g.length)).toEqual([12, 12, 12, 4])
    const out13 = groupPhotos(burst.slice(0, 13), { ...opts, maxGroupSize: 12 })
    expect(out13.every((g) => g.length >= 2 && g.length <= 13)).toBe(true)
    expect(out13.flat()).toHaveLength(13)
  })
})

describe("splitGroup", () => {
  it("merges a trailing single into the previous chunk", () => {
    expect(splitGroup([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4, 5]])
    expect(splitGroup([1, 2, 3], 5)).toEqual([[1, 2, 3]])
    expect(splitGroup([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
  })
})
