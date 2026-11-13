import { describe, expect, it } from "vitest"
import { filmstripTiles } from "./filmstrip"

const base = { zoom: 10, tileWidth: 50, duration: 100 } // 5 s per tile

describe("filmstripTiles", () => {
  it("covers the window with tiles on a fixed source grid", () => {
    const t = filmstripTiles({ ...base, inSec: 0, outSec: 12 })
    expect(t.map((x) => x.x)).toEqual([0, 50, 100])
    expect(t.map((x) => x.at)).toEqual([2.5, 7.5, 12.5])
  })

  it("trimming the in point crops: the same moment keeps its picture and slides out of the clip", () => {
    const full = filmstripTiles({ ...base, inSec: 0, outSec: 20 })
    const cut = filmstripTiles({ ...base, inSec: 7, outSec: 20 })
    const a = full.find((x) => x.at === 7.5)!
    const b = cut.find((x) => x.at === 7.5)!
    expect(b.x).toBe(a.x - 70)
    expect(cut[0].x).toBeLessThan(0)
    expect(cut[0].width).toBe(a.width)
  })

  it("trimming the out point leaves the tiles where they were", () => {
    const full = filmstripTiles({ ...base, inSec: 3, outSec: 20 })
    const cut = filmstripTiles({ ...base, inSec: 3, outSec: 9 })
    expect(cut).toEqual(full.slice(0, cut.length))
  })

  it("a long clip gets tiles all the way along, and a view returns only the tiles in it", () => {
    const long = { zoom: 10, tileWidth: 50, duration: 100000 } // 5 s per tile
    const all = filmstripTiles({ ...long, inSec: 0, outSec: 5000 })
    expect(all.length).toBe(400) // the safety cap, without a view
    const view = filmstripTiles({ ...long, inSec: 0, outSec: 5000, view: { from: 40000, to: 40200 } })
    expect(view.map((x) => x.x)).toEqual([40000, 40050, 40100, 40150])
    expect(view[0].at).toBe(4002.5)
    expect(filmstripTiles({ ...long, inSec: 0, outSec: 5000, view: { from: 99000, to: 99500 } })).toEqual([])
  })

  it("keeps the picture inside the file and handles empty or bad windows", () => {
    expect(filmstripTiles({ ...base, inSec: 0, outSec: 100 }).at(-1)!.at).toBeLessThanOrEqual(99.95)
    expect(filmstripTiles({ ...base, inSec: 5, outSec: 5 })).toEqual([])
    expect(filmstripTiles({ ...base, zoom: 0, inSec: 0, outSec: 5 })).toEqual([])
  })
})
