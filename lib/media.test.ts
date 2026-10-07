import path from "path"
import { describe, expect, it } from "vitest"
import { fileVersion, isPlainName, isPlainPath, isRootKey, isScanRoot, isSkippedDir, mediaKind, numberedName, resolveInside, safeSegments, tempFolderName, trashBatchId, trashBatchTime } from "./media"

describe("mediaKind", () => {
  it("recognises photos and videos regardless of case", () => {
    expect(mediaKind("IMG_0001.JPG")).toBe("image")
    expect(mediaKind("IMG_0002.heic")).toBe("image")
    expect(mediaKind("clip.MOV")).toBe("video")
  })

  it("ignores everything else", () => {
    expect(mediaKind("notes.txt")).toBeNull()
    expect(mediaKind("Thumbs.db")).toBeNull()
    expect(mediaKind("jpg")).toBeNull()
  })
})

describe("isSkippedDir", () => {
  it("skips hidden and NAS housekeeping folders", () => {
    expect(isSkippedDir(".thumbnails")).toBe(true)
    expect(isSkippedDir("@eaDir")).toBe(true)
    expect(isSkippedDir("#recycle")).toBe(true)
    expect(isSkippedDir("jessi")).toBe(false)
  })
})

describe("isRootKey", () => {
  it("accepts only the configured roots", () => {
    expect(isRootKey("upload")).toBe(true)
    expect(isRootKey("dropoff")).toBe(true)
    expect(isRootKey("temp")).toBe(true)
    expect(isRootKey("etc")).toBe(false)
  })

  it("keeps User Temp Storage out of AI scans", () => {
    expect(isScanRoot("upload")).toBe(true)
    expect(isScanRoot("dropoff")).toBe(true)
    expect(isScanRoot("temp")).toBe(false)
  })
})

describe("tempFolderName", () => {
  it("uses the user's name", () => {
    expect(tempFolderName("Jessi", "j@example.com")).toBe("Jessi")
    expect(tempFolderName("  Mary  Ann ", "m@example.com")).toBe("Mary Ann")
  })

  it("drops characters folders can't hold, and ones that would hide the folder", () => {
    expect(tempFolderName("a/b\\c:d*?", "x@example.com")).toBe("abcd")
    expect(tempFolderName("../..", "x@example.com")).toBe("x")
    expect(tempFolderName(".hidden", "x@example.com")).toBe("hidden")
    expect(tempFolderName("@eaDir", "x@example.com")).toBe("eaDir")
    expect(tempFolderName("Bob.", "x@example.com")).toBe("Bob")
  })

  it("falls back to the email, then a fixed name", () => {
    expect(tempFolderName("???", "mike@example.com")).toBe("mike")
    expect(tempFolderName("", "@example.com")).toBe("user")
  })
})

describe("isPlainPath", () => {
  it("accepts names and names in subfolders", () => {
    expect(isPlainPath("IMG_1.jpg")).toBe(true)
    expect(isPlainPath("18/IMG_1.jpg")).toBe(true)
  })

  it("refuses anything that climbs out or isn't normalised", () => {
    expect(isPlainPath("../IMG_1.jpg")).toBe(false)
    expect(isPlainPath("/IMG_1.jpg")).toBe(false)
    expect(isPlainPath("18\\IMG_1.jpg")).toBe(false)
    expect(isPlainPath("")).toBe(false)
  })
})

describe("safeSegments", () => {
  it("splits nested segments and drops empty parts", () => {
    expect(safeSegments(["jessi", "2026/10", ""])).toEqual(["jessi", "2026", "10"])
  })

  it("refuses anything that climbs out", () => {
    expect(safeSegments([".."])).toBeNull()
    expect(safeSegments(["jessi", "..", "..", "etc"])).toBeNull()
    expect(safeSegments(["a\\..\\b"])).toBeNull()
    expect(safeSegments(["C:", "Windows"])).toBeNull()
    expect(safeSegments(["bad\0name"])).toBeNull()
  })
})

describe("resolveInside", () => {
  const root = path.resolve("/photos/upload")

  it("resolves paths under the root", () => {
    expect(resolveInside(root, [])).toBe(root)
    expect(resolveInside(root, ["jessi", "IMG_1.jpg"])).toBe(path.join(root, "jessi", "IMG_1.jpg"))
  })

  it("rejects paths that escape the root", () => {
    expect(resolveInside(root, ["..", "dropoff"])).toBeNull()
  })

  it("does not treat a sibling with the same prefix as inside", () => {
    expect(resolveInside(root, ["..", "upload-other"])).toBeNull()
  })
})

describe("numberedName", () => {
  it("adds a counter before the extension", () => {
    expect(numberedName("IMG_1.jpg", 0)).toBe("IMG_1.jpg")
    expect(numberedName("IMG_1.jpg", 2)).toBe("IMG_1 (2).jpg")
    expect(numberedName("README", 1)).toBe("README (1)")
  })
})

describe("fileVersion", () => {
  it("changes when any of size, mtime or ctime changes", () => {
    const base = { size: 100, mtimeMs: 1_700_000_000_000.5, ctimeMs: 1_700_000_000_000 }
    const v = fileVersion(base)
    expect(fileVersion({ ...base })).toBe(v)
    expect(fileVersion({ ...base, size: 101 })).not.toBe(v)
    expect(fileVersion({ ...base, mtimeMs: base.mtimeMs + 1000 })).not.toBe(v)
    expect(fileVersion({ ...base, ctimeMs: base.ctimeMs + 1000 })).not.toBe(v)
  })
})

describe("trash batches", () => {
  it("round-trips the delete time through the folder name", () => {
    const id = trashBatchId(1_759_400_000_000, "a1b2c3d4e5")
    expect(id).toBe("1759400000000-a1b2c3d4")
    expect(trashBatchTime(id)).toBe(1_759_400_000_000)
  })

  it("ignores folders it didn't create", () => {
    expect(trashBatchTime("holiday")).toBeNull()
    expect(trashBatchTime("../1759400000000-x")).toBeNull()
  })
})

describe("isPlainName", () => {
  it("accepts one file name and nothing else", () => {
    expect(isPlainName("IMG 1.jpg")).toBe(true)
    expect(isPlainName("a/b.jpg")).toBe(false)
    expect(isPlainName("..")).toBe(false)
    expect(isPlainName("")).toBe(false)
  })
})
