import { describe, expect, it } from "vitest"
import { adjoins, type Clip, type Project } from "./project"
import { setTransition, zoomCutRange } from "./transitions"
import { expandZoomCuts } from "./zoom-cut"
import { zoomAway, zoomAwayExpr, zoomedTransform, zoomScaleExpr } from "./zoom-fullscreen"

// Two clips of one 20 s video, end to end: 0-4 and 4-8, cut from the middle of the file so there is footage either side.
const clip = (id: string, start: number, over: Partial<Clip> = {}): Clip => ({ id, asset: "v", in: 5 + start, out: 9 + start, start, ...over })
const project = (clips: Clip[]): Project => ({
  version: 3, name: "t", width: 1920, height: 1080, fps: 30,
  assets: { v: { file: "v.mp4", duration: 20, hasAudio: true } },
  tracks: [{ id: "t1", clips }],
})
const nested = { scale: 0.5, x: 0.25, y: -0.25, cropTop: 0, cropBottom: 0 }

describe("zoom cuts", () => {
  it("run end to end: no footage is borrowed and nothing is trimmed or moved", () => {
    const p = project([clip("a", 0), clip("b", 4, { transform: nested })])
    const q = setTransition(p, "b", { type: "zoomfromfull", duration: 1 })
    expect(q.tracks[0].clips.map((c) => [c.id, c.in, c.out, c.start])).toEqual(p.tracks[0].clips.map((c) => [c.id, c.in, c.out, c.start]))
    expect(q.tracks[0].clips[1].transition).toEqual({ type: "zoomfromfull", duration: 1 })
  })

  it("is limited by the one clip it plays in, not by spare footage", () => {
    // Clips cut from the very start of the file have no footage before them for a transition to borrow; a zoom cut needs none.
    const bare = project([{ ...clip("a", 0), in: 0, out: 4 }, { ...clip("b", 4), in: 0, out: 4, transform: nested }])
    expect(zoomCutRange(bare, "b", "zoomfromfull")).toMatchObject({ reason: "ok", max: 4 })
    expect(zoomCutRange(bare, "b", "zoomtofull")).toMatchObject({ reason: "ok", max: 4 })
  })

  it("turns into a hard cut and a zoom inside one clip for the preview and the export", () => {
    const from = expandZoomCuts(setTransition(project([clip("a", 0), clip("b", 4, { transform: nested })]), "b", { type: "zoomfromfull", duration: 1.5 }))
    expect(from.tracks[0].clips[1].transition).toBeUndefined()
    expect(from.tracks[0].clips[1].zoomIn).toEqual({ duration: 1.5 })
    expect(from.tracks[0].clips[0].zoomOut).toBeUndefined()
    const to = expandZoomCuts(setTransition(project([clip("a", 0, { transform: nested }), clip("b", 4)]), "b", { type: "zoomtofull", duration: 2 }))
    expect(to.tracks[0].clips[0].zoomOut).toEqual({ duration: 2 })
    expect(to.tracks[0].clips[1].zoomIn).toBeUndefined()
    // The clips still adjoin, with no overlap.
    expect(adjoins(to.tracks[0].clips[0], to.tracks[0].clips[1])).toBe(true)
    const plain = project([clip("a", 0), clip("b", 4)])
    expect(expandZoomCuts(plain)).toBe(plain)
  })
})

// -0 + 0 is +0: a move of nothing can come out as -0, which toMatchObject tells apart from 0.
const norm = (o: object) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? v + 0 : v]))

describe("the zoom inside a clip", () => {
  it("starts at full screen and settles (zoomIn), leaves for full screen at the end (zoomOut), and is 0 elsewhere", () => {
    const c = { zoomIn: { duration: 2 }, zoomOut: { duration: 1 } }
    expect(zoomAway(c, 10, 0)).toBe(1)
    expect(zoomAway(c, 10, 1)).toBeCloseTo(0.5, 6)
    expect(zoomAway(c, 10, 2)).toBe(0)
    expect(zoomAway(c, 10, 5)).toBe(0)
    expect(zoomAway(c, 10, 9.5)).toBeCloseTo(0.5, 6)
    expect(zoomAway(c, 10, 10)).toBe(1)
  })

  it("moves the size at a steady rate and the centre straight to the middle", () => {
    expect(zoomedTransform(nested, 0)).toBe(nested)
    expect(norm(zoomedTransform(nested, 1))).toMatchObject({ scale: 1, x: 0, y: 0 })
    const half = zoomedTransform(nested, 0.5)
    expect(half.scale).toBeCloseTo(Math.sqrt(0.5), 6)
    expect(half.x).toBeCloseTo(0.125, 6)
  })

  it("writes the same thing for ffmpeg", () => {
    expect(zoomAwayExpr({}, 10, "t", String)).toBe("0")
    expect(zoomAwayExpr({ zoomIn: { duration: 2 } }, 10, "t-3", String)).toContain("lt(t-3,2)")
    expect(zoomAwayExpr({ zoomOut: { duration: 2 } }, 10, "t", String)).toContain("gt(t,8)")
    expect(zoomScaleExpr("0.5", "A")).toBe("pow(0.5,1-(A))")
  })
})
