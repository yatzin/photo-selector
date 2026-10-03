import { describe, expect, it } from "vitest"
import { formatBytes, libraryHref, mediaUrl } from "./format"

describe("formatBytes", () => {
  it("picks a readable unit", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(4 * 1024 * 1024)).toBe("4.0 MB")
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB")
  })
})

describe("libraryHref", () => {
  it("encodes each folder name", () => {
    expect(libraryHref("upload", [])).toBe("/library/upload")
    expect(libraryHref("upload", ["jessi", "Trip 2026", "50%"])).toBe("/library/upload/jessi/Trip%202026/50%25")
  })
})

describe("mediaUrl", () => {
  it("encodes the path and carries the variant and version", () => {
    expect(mediaUrl("upload", ["jessi", "Trip 2026"], "IMG #1.jpg", "thumb", "a-b-c")).toBe(
      "/api/media/upload/jessi/Trip%202026/IMG%20%231.jpg?v=thumb&k=a-b-c"
    )
  })
  it("keeps a month scan's day folder as its own path segment", () => {
    expect(mediaUrl("upload", ["2025", "10"], "18/IMG_1.jpg", "thumb", "k")).toBe("/api/media/upload/2025/10/18/IMG_1.jpg?v=thumb&k=k")
  })
})
