import { describe, expect, it } from "vitest"
import { isFolderLocked } from "./lock"

const active = [{ root: "upload", folder: "jessi" }, { root: "dropoff", folder: "" }]

describe("isFolderLocked", () => {
  it("locks exactly the folder an active scan is reading", () => {
    expect(isFolderLocked(active, "upload", ["jessi"])).toBe(true)
    expect(isFolderLocked(active, "dropoff", [])).toBe(true)
  })

  it("leaves other folders, roots and subfolders alone", () => {
    expect(isFolderLocked(active, "upload", ["mike"])).toBe(false)
    expect(isFolderLocked(active, "upload", [])).toBe(false)
    expect(isFolderLocked(active, "upload", ["jessi", "Trip 2026"])).toBe(false)
    expect(isFolderLocked(active, "dropoff", ["jessi"])).toBe(false)
  })

  it("is unlocked with no active scans", () => {
    expect(isFolderLocked([], "upload", ["jessi"])).toBe(false)
  })
})
