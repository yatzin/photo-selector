import { describe, expect, it } from "vitest"
import { acceptAllPlan, classifyPhotos, folderKey, pageWindow, planResolution, scanFolderSegments, staleGroups } from "./review"

describe("scanFolderSegments", () => {
  it("accepts the root and nested folders with odd characters", () => {
    expect(scanFolderSegments("")).toEqual([])
    expect(scanFolderSegments("jessi/Trip 2026")).toEqual(["jessi", "Trip 2026"])
    expect(scanFolderSegments("50% off/#1")).toEqual(["50% off", "#1"])
  })

  it("rejects anything that climbs out", () => {
    expect(scanFolderSegments("../etc")).toBeNull()
    expect(scanFolderSegments("jessi/../../x")).toBeNull()
  })

  it("round-trips through folderKey", () => {
    expect(folderKey(scanFolderSegments("a/b c")!)).toBe("a/b c")
  })
})

describe("classifyPhotos", () => {
  it("keeps only photos whose version is unchanged", () => {
    const stored = [{ name: "a.jpg", version: "1" }, { name: "b.jpg", version: "1" }, { name: "c.jpg", version: "1" }]
    const current = new Map([["a.jpg", "1"], ["b.jpg", "2"]]) // b rotated, c gone
    expect(classifyPhotos(stored, current)).toEqual({ valid: ["a.jpg"], missing: ["b.jpg", "c.jpg"] })
  })
})

describe("planResolution", () => {
  it("splits valid photos into keep and trash", () => {
    expect(planResolution(["a", "b", "c"], ["b"])).toEqual({ keep: ["b"], trash: ["a", "c"] })
  })

  it("ignores keeps that are no longer valid and needs at least one keeper", () => {
    expect(planResolution(["a", "b"], ["z"])).toEqual({ error: "Keep at least one photo." })
    expect(planResolution(["a", "b"], ["a", "z"])).toEqual({ keep: ["a"], trash: ["b"] })
  })
})

describe("pageWindow", () => {
  it("returns the requested page's offset", () => {
    expect(pageWindow(95, "3", 20)).toEqual({ page: 3, pages: 5, skip: 40, take: 20 })
  })
  it("starts at page 1 for a missing or invalid page", () => {
    expect(pageWindow(95, undefined, 20)).toEqual({ page: 1, pages: 5, skip: 0, take: 20 })
    expect(pageWindow(95, "abc", 20).page).toBe(1)
    expect(pageWindow(95, "0", 20).page).toBe(1)
    expect(pageWindow(95, "-2", 20).page).toBe(1)
  })
  it("moves back to the last page when the requested one no longer exists", () => {
    // Resolving the last groups on the last page shrinks the total.
    expect(pageWindow(40, "3", 20)).toEqual({ page: 2, pages: 2, skip: 20, take: 20 })
  })
  it("has one empty page when there is nothing", () => {
    expect(pageWindow(0, "4", 20)).toEqual({ page: 1, pages: 1, skip: 0, take: 20 })
  })
})

describe("acceptAllPlan", () => {
  it("acts on every group with a pick, keeping only photos still there", () => {
    expect(
      acceptAllPlan([
        { id: "g1", present: ["a", "b", "c"], keep: ["b"] },
        { id: "g2", present: ["d", "e"], keep: ["e", "gone"] },
      ])
    ).toEqual({ items: [{ groupId: "g1", keep: ["b"] }, { groupId: "g2", keep: ["e"] }], skipped: 0 })
  })
  it("skips groups with nothing picked or fewer than two photos left", () => {
    expect(
      acceptAllPlan([
        { id: "none", present: ["a", "b"], keep: [] },
        { id: "single", present: ["c"], keep: ["c"] },
        { id: "ok", present: ["d", "e"], keep: ["d"] },
      ])
    ).toEqual({ items: [{ groupId: "ok", keep: ["d"] }], skipped: 2 })
  })
})


describe("staleGroups", () => {
  it("picks groups with fewer than two photos still as scanned", () => {
    const current = new Map([["a.jpg", "v1"], ["b.jpg", "v1"], ["c.jpg", "v2"]])
    const groups = [
      { id: "both-here", photos: [{ name: "a.jpg", version: "v1" }, { name: "b.jpg", version: "v1" }, { name: "gone.jpg", version: "v1" }] },
      { id: "one-left", photos: [{ name: "a.jpg", version: "v1" }, { name: "gone.jpg", version: "v1" }] },
      { id: "changed", photos: [{ name: "b.jpg", version: "v1" }, { name: "c.jpg", version: "v1" }] },
      { id: "none-left", photos: [{ name: "x.jpg", version: "v1" }, { name: "y.jpg", version: "v1" }] },
    ]
    expect(staleGroups(groups, current)).toEqual(["one-left", "changed", "none-left"])
  })
})
