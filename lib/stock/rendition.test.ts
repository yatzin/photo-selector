import { describe, expect, it } from "vitest"
import { pickVideoFile } from "./rendition"

const f = (width: number, height: number) => ({ width, height, url: `https://x/${width}x${height}.mp4` })
const url = (w: number, h: number) => ({ url: `https://x/${w}x${h}.mp4` })

describe("pickVideoFile", () => {
  it("picks 1080p over 4K and 720p", () => {
    expect(pickVideoFile([f(3840, 2160), f(1920, 1080), f(1280, 720)])).toEqual(url(1920, 1080))
  })
  it("picks the closest below 1080 when no 1080 exists", () => {
    expect(pickVideoFile([f(3840, 2160), f(1280, 720), f(640, 360)])).toEqual(url(1280, 720))
  })
  it("picks the smallest when everything is above 1080", () => {
    expect(pickVideoFile([f(3840, 2160), f(2560, 1440)])).toEqual(url(2560, 1440))
  })
  it("returns null for an empty list", () => {
    expect(pickVideoFile([])).toBeNull()
  })
  it("measures a portrait file by its width: 1080x1920 is the 1080p one", () => {
    expect(pickVideoFile([f(1080, 1920), f(720, 1280), f(540, 960)])).toEqual(url(1080, 1920))
    expect(pickVideoFile([f(2160, 3840), f(1080, 1920), f(720, 1280)])).toEqual(url(1080, 1920))
  })
  it("picks the smallest portrait file when every one is above 1080", () => {
    expect(pickVideoFile([f(2160, 3840), f(1440, 2560)])).toEqual(url(1440, 2560))
  })
  it("compares landscape and portrait files by their shorter side", () => {
    expect(pickVideoFile([f(1280, 720), f(1080, 1920), f(3840, 2160)])).toEqual(url(1080, 1920))
    expect(pickVideoFile([f(720, 1280), f(1920, 1080)])).toEqual(url(1920, 1080))
  })
  it("takes an exact 1080 (square too)", () => {
    expect(pickVideoFile([f(1080, 1080), f(720, 720)])).toEqual(url(1080, 1080))
  })
  it("does not depend on the input order", () => {
    expect(pickVideoFile([f(640, 360), f(3840, 2160), f(1920, 1080), f(1280, 720)])).toEqual(url(1920, 1080))
    expect(pickVideoFile([f(2560, 1440), f(3840, 2160)])).toEqual(url(2560, 1440))
  })
  it("keeps the first of two files of the same resolution", () => {
    expect(pickVideoFile([{ ...f(1920, 1080), url: "first" }, { ...f(1080, 1920), url: "second" }])).toEqual({ url: "first" })
  })
  it("ignores files with a zero, negative or NaN dimension", () => {
    expect(pickVideoFile([f(0, 1080), f(1920, NaN), f(-1, 1080), f(1280, 720)])).toEqual(url(1280, 720))
    expect(pickVideoFile([f(0, 0), f(NaN, NaN)])).toBeNull()
  })
})
