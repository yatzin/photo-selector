import { describe, expect, it } from "vitest"
import { TRANSITION_GUIDES } from "./transition-info"
import { TRANSITION_TYPES } from "./transition-types"

describe("transition guidance", () => {
  const keys = ["none", ...TRANSITION_TYPES] as const

  it("has what it does, best for and avoid when for every transition and for a hard cut", () => {
    expect(Object.keys(TRANSITION_GUIDES).sort()).toEqual([...keys].sort())
    for (const k of keys) {
      const g = TRANSITION_GUIDES[k]
      for (const text of [g.does, g.bestFor, g.avoid]) expect(text.trim().length).toBeGreaterThan(20)
    }
  })

  it("never repeats a text word for word", () => {
    const texts = keys.flatMap((k) => [TRANSITION_GUIDES[k].does, TRANSITION_GUIDES[k].bestFor, TRANSITION_GUIDES[k].avoid])
    expect(new Set(texts).size).toBe(texts.length)
  })
})
