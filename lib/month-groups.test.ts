import { describe, expect, it } from "vitest"
import { buildRows, itemAt, rowOfItem, rowTops } from "./month-groups"

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime()
// Newest first: 3 in July, 4 in June.
const items = [at(2026, 7, 20), at(2026, 7, 9), at(2026, 7, 1), at(2026, 6, 30), at(2026, 6, 18), at(2026, 6, 5), at(2026, 6, 2)].map((modified) => ({ modified }))

describe("buildRows", () => {
  it("starts each month with a header followed by its photos in rows", () => {
    expect(buildRows(items, 2, true)).toEqual([
      { kind: "header", key: "2026-07", label: "July 2026", start: 0, end: 3 },
      { kind: "tiles", start: 0, end: 2 },
      { kind: "tiles", start: 2, end: 3 },
      { kind: "header", key: "2026-06", label: "June 2026", start: 3, end: 7 },
      { kind: "tiles", start: 3, end: 5 },
      { kind: "tiles", start: 5, end: 7 },
    ])
  })
  it("keeps a collapsed month's header but leaves out its photos", () => {
    expect(buildRows(items, 2, true, new Set(["2026-07"]))).toEqual([
      { kind: "header", key: "2026-07", label: "July 2026", start: 0, end: 3 },
      { kind: "header", key: "2026-06", label: "June 2026", start: 3, end: 7 },
      { kind: "tiles", start: 3, end: 5 },
      { kind: "tiles", start: 5, end: 7 },
    ])
  })
  it("is a plain grid when not grouping", () => {
    expect(buildRows(items, 3, false)).toEqual([
      { kind: "tiles", start: 0, end: 3 },
      { kind: "tiles", start: 3, end: 6 },
      { kind: "tiles", start: 6, end: 7 },
    ])
  })
  it("has no rows for no photos", () => {
    expect(buildRows([], 3, true)).toEqual([])
  })
})

describe("rowTops / itemAt / rowOfItem", () => {
  const rows = buildRows(items, 2, true)
  // Headers 40px tall, photo rows 110px (100px tiles + 10px gap).
  const size = (r: (typeof rows)[number]) => (r.kind === "header" ? 40 : 110)
  const tops = rowTops(rows, size)
  const grid = { columns: 2, tileSize: 100, gap: 10 }

  it("stacks the rows", () => {
    expect(tops).toEqual([0, 40, 150, 260, 300, 410, 520])
  })
  it("finds the photo under a point", () => {
    expect(itemAt(5, 45, rows, tops, grid)).toBe(0)
    expect(itemAt(115, 45, rows, tops, grid)).toBe(1)
    expect(itemAt(5, 160, rows, tops, grid)).toBe(2)
    expect(itemAt(115, 420, rows, tops, grid)).toBe(6)
  })
  it("snaps to the last photo of a short row", () => {
    expect(itemAt(115, 160, rows, tops, grid)).toBe(2)
  })
  it("ignores month headers", () => {
    expect(itemAt(5, 10, rows, tops, grid)).toBe(-1)
    expect(itemAt(5, 270, rows, tops, grid)).toBe(-1)
  })
  it("clamps points beyond the grid", () => {
    expect(itemAt(5, 9999, rows, tops, grid)).toBe(6)
    expect(itemAt(-20, -20, rows, tops, grid)).toBe(0)
  })
  it("knows which row holds a photo", () => {
    expect(rowOfItem(rows, 0)).toBe(1)
    expect(rowOfItem(rows, 2)).toBe(2)
    expect(rowOfItem(rows, 6)).toBe(5)
  })
})
