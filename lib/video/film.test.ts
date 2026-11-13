import { describe, expect, it } from "vitest"
import { filmDirName, filmFrameIndex, filmFrameName, filmInterval } from "./film"

describe("film", () => {
  it("spaces snapshots at least half a second apart and at most 1500 a video", () => {
    expect(filmInterval(30)).toBe(0.5)
    expect(filmInterval(1200)).toBe(0.8)
    expect(filmInterval(3 * 3600) * 1500).toBeGreaterThanOrEqual(3 * 3600 - 1e-6)
  })

  it("names the folder and the snapshots", () => {
    expect(filmDirName("a b.MOV")).toBe(".a b.MOV.film")
    expect(filmFrameName(7)).toBe("00007.jpg")
  })

  it("picks the nearest snapshot and stays inside what was taken", () => {
    expect(filmFrameIndex(0, 0.8, 1500)).toBe(0)
    expect(filmFrameIndex(10, 0.8, 1500)).toBe(13)
    expect(filmFrameIndex(5000, 0.8, 1500)).toBe(1499)
    expect(filmFrameIndex(-3, 0.8, 1500)).toBe(0)
    expect(filmFrameIndex(NaN, 0.8, 1500)).toBe(0)
    expect(filmFrameIndex(1, 0.8, 0)).toBe(0)
  })
})
