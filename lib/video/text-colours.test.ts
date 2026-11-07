import { describe, expect, it } from "vitest"
import type { Clip, Project } from "./project"
import { DARK_BACKDROP, LIGHT_BACKDROP, MAX_USED_COLOURS, previewBackdrop, usedTextColours } from "./text-colours"

const text = (id: string, start: number, color: string): Clip => ({ id, asset: "", in: 0, out: 1, start, text: { content: "a", color, orientation: "horizontal" } })
const video = (id: string, start: number): Clip => ({ id, asset: "a.mp4", in: 0, out: 1, start })
const project = (...tracks: Clip[][]): Project => ({
  version: 3, name: "p", width: 1920, height: 1080, fps: 30, assets: {},
  tracks: tracks.map((clips, i) => ({ id: `t${i}`, clips })),
})

describe("usedTextColours", () => {
  it("is empty with no text clips", () => {
    expect(usedTextColours(project([video("v", 0)]))).toEqual([])
    expect(usedTextColours(project())).toEqual([])
  })

  it("lists each colour once, ignoring case, in lower case", () => {
    expect(usedTextColours(project([text("a", 0, "#FF0000"), text("b", 2, "#ff0000"), text("c", 4, "#00Ff00")]))).toEqual(["#ff0000", "#00ff00"])
  })

  it("orders by how many clips use it, then by the earliest clip's time, across layers", () => {
    const p = project(
      [text("a", 0, "#111111"), text("b", 5, "#222222"), text("c", 9, "#222222")],
      [text("d", 3, "#333333"), text("e", 1, "#444444")],
    )
    expect(usedTextColours(p)).toEqual(["#222222", "#111111", "#444444", "#333333"])
  })

  it("leaves out the clip being edited unless another clip uses its colour", () => {
    const p = project([text("a", 0, "#111111"), text("b", 2, "#222222"), text("c", 4, "#222222")], [text("d", 1, "#333333")])
    expect(usedTextColours(p, "a")).toEqual(["#222222", "#333333"])
    expect(usedTextColours(p, "b")).toEqual(["#111111", "#333333", "#222222"])
    expect(usedTextColours(project([text("a", 0, "#111111")]), "a")).toEqual([])
  })

  it("keeps at most MAX_USED_COLOURS, the most used", () => {
    const clips = Array.from({ length: 14 }, (_, i) => text(`c${i}`, i, `#0000${(i + 16).toString(16)}`))
    clips.push(text("x", 20, "#00001d"))
    const used = usedTextColours(project(clips))
    expect(used).toHaveLength(MAX_USED_COLOURS)
    expect(used[0]).toBe("#00001d")
    expect(used).not.toContain("#00001c")
  })
})

describe("previewBackdrop", () => {
  it("puts light colours on the dark backdrop and dark ones on the light", () => {
    expect(previewBackdrop("#ffffff").background).toBe(DARK_BACKDROP)
    expect(previewBackdrop("#FFFF00").background).toBe(DARK_BACKDROP)
    expect(previewBackdrop("#000000").background).toBe(LIGHT_BACKDROP)
    expect(previewBackdrop("#000080").background).toBe(LIGHT_BACKDROP)
  })

  it("gives a mid-tone whichever backdrop has the higher contrast ratio", () => {
    const a = previewBackdrop("#808080")
    expect(a.background).toBe(DARK_BACKDROP)
    expect(a.contrast).toBeCloseTo(4.54, 1)
    const b = previewBackdrop("#666666")
    expect(b.background).toBe(LIGHT_BACKDROP)
    expect(b.contrast).toBeCloseTo(5.27, 1)
  })

  it("reports the WCAG contrast ratio", () => {
    expect(previewBackdrop("#ffffff").contrast).toBeCloseTo(17.9, 0)
    expect(previewBackdrop("#000000").contrast).toBeCloseTo(19.3, 0)
  })

  it("treats an invalid colour as white", () => {
    for (const bad of ["", "white", "#fff", "#gggggg", "#ffffffff"]) expect(previewBackdrop(bad)).toEqual(previewBackdrop("#ffffff"))
  })
})
