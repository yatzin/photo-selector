import { describe, expect, it } from "vitest"
import { normalizeTemplate, pruneTemplate } from "./template"

describe("normalizeTemplate", () => {
  it("keeps a good template and tidies labels and the description", () => {
    const t = normalizeTemplate({ master: true, description: "  A  trip\nreel ", slots: { c1: { label: "  Main   video ", asset: "a1" }, c2: { label: "Title", text: "Hello" } } })
    expect(t).toEqual({ master: true, description: "A trip reel", slots: { c1: { label: "Main video", asset: "a1" }, c2: { label: "Title", text: "Hello" } } })
  })

  it("gives a blank label a default and drops an empty description", () => {
    expect(normalizeTemplate({ slots: { c1: { label: "   " } }, description: " " })).toEqual({ slots: { c1: { label: "Slot" } } })
  })

  it("rejects bad shapes", () => {
    for (const bad of [null, [], "x", { slots: [] }, { slots: null }, { slots: { c: "x" } }, { slots: { c: { label: 3 } } }, { master: false, slots: {} }, { slots: {}, description: 3 }, { slots: { c: { label: "a", asset: 4 } } }, { slots: { "": { label: "a" } } }]) {
      expect(normalizeTemplate(bad)).toBeNull()
    }
  })

  it("limits the number of slots and the label length", () => {
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`c${i}`, { label: "x" }]))
    expect(normalizeTemplate({ slots: many })).toBeNull()
    expect(normalizeTemplate({ slots: { c: { label: "x".repeat(200) } } })?.slots.c.label.length).toBe(60)
  })
})

describe("pruneTemplate", () => {
  it("drops slots whose clip is gone; a project made from a template with none left is no longer one, a template stays", () => {
    const t = { slots: { a: { label: "A" }, b: { label: "B" } } }
    expect(pruneTemplate(t, (id) => id === "a")).toEqual({ slots: { a: { label: "A" } } })
    expect(pruneTemplate(t, () => false)).toBeUndefined()
    expect(pruneTemplate({ ...t, master: true }, () => false)).toEqual({ master: true, slots: {} })
  })
})
