import { describe, expect, it } from "vitest"
import { gridLayout } from "./grid-layout"

describe("gridLayout", () => {
  it("fits as many columns as the minimum tile size allows and stretches tiles to fill the row", () => {
    const l = gridLayout({ width: 1000, minTile: 192, gap: 8, count: 100 })
    expect(l.columns).toBe(5) // 5*192 + 4*8 = 992 <= 1000; 6 would need 1192
    expect(l.tileSize).toBeCloseTo((1000 - 4 * 8) / 5)
    expect(l.rowHeight).toBeCloseTo(l.tileSize + 8)
    expect(l.rows).toBe(20)
  })

  it("rounds a partial last row up", () => {
    expect(gridLayout({ width: 1000, minTile: 192, gap: 8, count: 101 }).rows).toBe(21)
  })

  it("always has at least one column, even on a phone narrower than a tile", () => {
    const l = gridLayout({ width: 150, minTile: 192, gap: 8, count: 3 })
    expect(l.columns).toBe(1)
    expect(l.tileSize).toBe(150)
    expect(l.rows).toBe(3)
  })

  it("is empty before the width is known or with no photos", () => {
    expect(gridLayout({ width: 0, minTile: 192, gap: 8, count: 10 }).rows).toBe(0)
    expect(gridLayout({ width: 800, minTile: 192, gap: 8, count: 0 }).rows).toBe(0)
  })

  it("maps photo index to row", () => {
    const l = gridLayout({ width: 1000, minTile: 192, gap: 8, count: 100 })
    expect(l.rowOf(0)).toBe(0)
    expect(l.rowOf(4)).toBe(0)
    expect(l.rowOf(5)).toBe(1)
    expect(l.rowOf(99)).toBe(19)
  })
})
