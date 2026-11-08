import { describe, expect, it } from "vitest"
import { AUDIO_EDGE_GUIDES, AUDIO_TRANSITION_GUIDES, TRANSITION_GUIDES } from "./transition-info"
import { AUDIO_TRANSITION_TYPES, EDGE_AUDIO_TYPES, EDGE_PICTURE_TYPES, TRANSITION_TYPES } from "./transition-types"

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

describe("audio transition guidance", () => {
  it("has all three texts for every audio transition and every audio edge fade, none repeated", () => {
    expect(Object.keys(AUDIO_TRANSITION_GUIDES).sort()).toEqual([...AUDIO_TRANSITION_TYPES].sort())
    const edgeTypes = [...new Set([...EDGE_AUDIO_TYPES.in, ...EDGE_AUDIO_TYPES.out])]
    expect(Object.keys(AUDIO_EDGE_GUIDES).sort()).toEqual(edgeTypes.sort())
    const guides = [...Object.values(AUDIO_TRANSITION_GUIDES), ...Object.values(AUDIO_EDGE_GUIDES), ...Object.values(TRANSITION_GUIDES)]
    const texts = guides.flatMap((g) => [g.does, g.bestFor, g.avoid])
    for (const t of texts) expect(t.trim().length).toBeGreaterThan(20)
    expect(new Set(texts).size).toBe(texts.length)
  })

  it("gives every picture type a free edge offers its guidance", () => {
    for (const t of [...EDGE_PICTURE_TYPES.in, ...EDGE_PICTURE_TYPES.out]) expect(TRANSITION_GUIDES[t].does.length).toBeGreaterThan(20)
  })
})
