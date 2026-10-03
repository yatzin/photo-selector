import { describe, expect, it } from "vitest"
import { dragSelection, edgeScrollSpeed, indexAt } from "./drag-select"

// 3 columns of 100px tiles with 10px gaps; rows are 110px apart.
const grid = { columns: 3, tileSize: 100, rowHeight: 110, gap: 10 }

describe("indexAt", () => {
  it("finds the tile under a point, row by row", () => {
    expect(indexAt(5, 5, grid, 10)).toBe(0)
    expect(indexAt(225, 5, grid, 10)).toBe(2)
    expect(indexAt(115, 120, grid, 10)).toBe(4)
  })
  it("counts a gap as the tile before it", () => {
    expect(indexAt(105, 5, grid, 10)).toBe(0)
    expect(indexAt(5, 105, grid, 10)).toBe(0)
  })
  it("clamps points outside the grid to the nearest tile", () => {
    expect(indexAt(-50, -50, grid, 10)).toBe(0)
    expect(indexAt(999, 5, grid, 10)).toBe(2)
    expect(indexAt(5, 9999, grid, 10)).toBe(9)
    expect(indexAt(225, 335, grid, 10)).toBe(9) // past the last photo in a short last row
  })
})

describe("dragSelection", () => {
  const names = ["a", "b", "c", "d", "e"]
  it("adds the range between the start and the current tile to what was selected", () => {
    expect([...dragSelection(new Set(["e"]), names, 1, 3, "add")].sort()).toEqual(["b", "c", "d", "e"])
  })
  it("works dragging backwards", () => {
    expect([...dragSelection(new Set(), names, 3, 1, "add")].sort()).toEqual(["b", "c", "d"])
  })
  it("removes the range when the drag started on a selected photo", () => {
    expect([...dragSelection(new Set(names), names, 1, 2, "remove")].sort()).toEqual(["a", "d", "e"])
  })
  it("shrinking the drag gives back what was there before", () => {
    const base = new Set(["a"])
    dragSelection(base, names, 0, 4, "add")
    expect([...dragSelection(base, names, 0, 1, "add")].sort()).toEqual(["a", "b"])
  })
})

describe("edgeScrollSpeed", () => {
  it("is zero away from the edges", () => {
    expect(edgeScrollSpeed(400, 0, 800)).toBe(0)
  })
  it("scrolls down near the bottom and up near the top, faster closer to the edge", () => {
    const near = edgeScrollSpeed(770, 0, 800)
    const nearer = edgeScrollSpeed(795, 0, 800)
    expect(near).toBeGreaterThan(0)
    expect(nearer).toBeGreaterThan(near)
    expect(edgeScrollSpeed(10, 0, 800)).toBeLessThan(0)
  })
  it("keeps going at full speed past the edge", () => {
    expect(edgeScrollSpeed(900, 0, 800)).toBe(edgeScrollSpeed(800, 0, 800))
  })
})
