import { describe, expect, it } from "vitest"
import { describeChange, diffSnapshot } from "./snapshot"

const snap = { "a.jpg": "1", "b.jpg": "1", "c.jpg": "1" }

describe("diffSnapshot", () => {
  it("finds removed, changed and added images", () => {
    const current = new Map([["a.jpg", "1"], ["b.jpg", "2"], ["d.jpg", "1"]])
    expect(diffSnapshot(snap, current)).toEqual({ removed: ["c.jpg"], changed: ["b.jpg"], added: ["d.jpg"] })
  })

  it("is empty when nothing changed", () => {
    expect(diffSnapshot(snap, new Map(Object.entries(snap)))).toEqual({ removed: [], changed: [], added: [] })
  })
})

describe("describeChange", () => {
  it("stops for removed or changed images and names them", () => {
    const msg = describeChange({ removed: ["c.jpg"], changed: ["b.jpg"], added: [] })
    expect(msg).toMatch(/changed outside the app/i)
    expect(msg).toContain("c.jpg")
    expect(msg).toContain("b.jpg")
  })

  it("ignores images that only arrived during the scan", () => {
    expect(describeChange({ removed: [], changed: [], added: ["new.jpg"] })).toBeNull()
  })

  it("summarises long lists", () => {
    const removed = Array.from({ length: 10 }, (_, i) => `r${i}.jpg`)
    const msg = describeChange({ removed, changed: [], added: [] })!
    expect(msg).toContain("10 removed")
    expect(msg).toContain("and 7 more")
  })
})
