import { describe, expect, it } from "vitest"
import { previewWindow, atempoChain, isValidRetime, MAX_REVERSE_SECONDS, retimeArgs, retimedLength, retimeError, retimeFilters, retimeTitle, sourceWindow, type Retime } from "./retime"

describe("atempoChain", () => {
  it("splits a speed into factors of 0.5 to 2 that multiply back", () => {
    for (const s of [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8]) {
      const chain = atempoChain(s)
      expect(chain.every((f) => f >= 0.5 - 1e-9 && f <= 2 + 1e-9)).toBe(true)
      expect(chain.reduce((a, b) => a * b, 1)).toBeCloseTo(s, 4)
    }
    expect(atempoChain(4)).toEqual([2, 2])
    expect(atempoChain(0.25)).toEqual([0.5, 0.5])
  })
})

describe("sourceWindow", () => {
  const base: Retime = { source: "orig", speed: 2, reverse: false, from: 10, to: 20 }
  it("an original maps to itself", () => {
    expect(sourceWindow("a", {}, 1, 3)).toEqual({ source: "a", from: 1, to: 3 })
  })
  it("a faster copy covers more of the original", () => {
    expect(sourceWindow("d", { retime: base }, 1, 3)).toEqual({ source: "orig", from: 12, to: 16 })
  })
  it("a reversed copy counts back from the end of its window", () => {
    expect(sourceWindow("d", { retime: { ...base, reverse: true } }, 1, 3)).toEqual({ source: "orig", from: 14, to: 18 })
    expect(sourceWindow("d", { retime: { ...base, reverse: true } }, 0, 5)).toEqual({ source: "orig", from: 10, to: 20 })
  })
})

describe("retimeError, retimedLength, isValidRetime", () => {
  it("checks speed, window and the reverse cap", () => {
    expect(retimeError(1, false, 0, 5)).toBeNull()
    expect(retimeError(0.01, false, 0, 5)).toMatch(/Speed/)
    expect(retimeError(9, false, 0, 5)).toMatch(/Speed/)
    expect(retimeError(1, false, 5, 5)).toMatch(/not valid/)
    expect(retimeError(1, true, 0, MAX_REVERSE_SECONDS + 1)).toMatch(/Reverse/)
    expect(retimeError(1, false, 0, MAX_REVERSE_SECONDS + 100)).toBeNull()
  })
  it("a slower copy is longer", () => {
    expect(retimedLength(0, 10, 0.5)).toBe(20)
    expect(retimedLength(2, 10, 4)).toBe(2)
  })
  it("validates a stored retime", () => {
    expect(isValidRetime({ source: "a", speed: 2, reverse: false, from: 0, to: 3 })).toBe(true)
    expect(isValidRetime({ source: "", speed: 2, reverse: false, from: 0, to: 3 })).toBe(false)
    expect(isValidRetime({ source: "a", speed: 20, reverse: false, from: 0, to: 3 })).toBe(false)
    expect(isValidRetime({ source: "a", speed: 2, reverse: false, from: 3, to: 3 })).toBe(false)
    expect(isValidRetime(null)).toBe(false)
  })
})

describe("ffmpeg arguments", () => {
  it("retimeFilters: video setpts and reverse, sound atempo and areverse", () => {
    expect(retimeFilters(2, false, true)).toEqual({ video: "setpts=(PTS-STARTPTS)/2,scale=trunc(iw/2)*2:trunc(ih/2)*2", audio: "atempo=2" })
    expect(retimeFilters(0.25, true, true).audio).toBe("areverse,atempo=0.5,atempo=0.5")
    expect(retimeFilters(1, true, false)).toEqual({ video: "reverse,setpts=(PTS-STARTPTS)/1,scale=trunc(iw/2)*2:trunc(ih/2)*2", audio: null })
  })
  it("retimeArgs cuts the part, maps the streams and encodes", () => {
    const a = retimeArgs("in.mp4", "out.mp4", { from: 1.5, to: 4, speed: 2, reverse: false, hasAudio: true })
    expect(a.slice(a.indexOf("-ss"), a.indexOf("-ss") + 4)).toEqual(["-ss", "1.5", "-t", "2.5"])
    expect(a).toContain("[0:v]setpts=(PTS-STARTPTS)/2,scale=trunc(iw/2)*2:trunc(ih/2)*2[v];[0:a]atempo=2[a]")
    expect(a.at(-1)).toBe("out.mp4")
    expect(retimeArgs("in.mp4", "out.mp4", { from: 0, to: 2, speed: 1, reverse: true, hasAudio: false })).toContain("-an")
  })
  it("a sound file gets audio filters only, as an m4a-ready aac stream", () => {
    const a = retimeArgs("in.mp3", "out.m4a", { from: 0, to: 3, speed: 0.5, reverse: true, hasAudio: true, audioOnly: true })
    expect(a).toContain("[0:a]areverse,atempo=0.5[a]")
    expect(a).toContain("-vn")
    expect(a.join(" ")).not.toContain("[0:v]")
  })
  it("previewWindow takes the middle: 6 s of output, or all of a shorter clip", () => {
    expect(previewWindow(0, 20, 1)).toEqual({ from: 7, to: 13 })
    expect(previewWindow(0, 20, 2)).toEqual({ from: 4, to: 16 })
    expect(previewWindow(10, 12, 1)).toEqual({ from: 10, to: 12 })
    expect(previewWindow(0, 20, 0.5)).toEqual({ from: 8.5, to: 11.5 })
  })
  it("a preview is small and quick to make", () => {
    const a = retimeArgs("in.mp4", "out.mp4", { from: 0, to: 3, speed: 1, reverse: false, hasAudio: true, preview: true })
    expect(a.join(" ")).toContain("scale=480:-2")
    expect(a).toContain("veryfast")
  })
  it("retimeTitle", () => {
    expect(retimeTitle("Beach", 0.5, false)).toBe("Beach (0.5×)")
    expect(retimeTitle("Beach", 1, true)).toBe("Beach (reversed)")
    expect(retimeTitle("Beach", 2, true)).toBe("Beach (2×, reversed)")
    expect(retimeTitle("Beach", 1, false)).toBe("Beach")
  })
})
