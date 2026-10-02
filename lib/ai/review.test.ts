import { describe, expect, it } from "vitest"
import { classifyPhotos, folderKey, planResolution, scanFolderSegments } from "./review"

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
