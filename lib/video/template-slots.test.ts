import { describe, expect, it } from "vitest"
import { newProject, parseProject, mergeClientProject, replaceClipMedia, type Asset, type Clip, type Project } from "./project"
import { acceptsAsset, buildSlots, slotCandidates, slotKindOf } from "./template-slots"

const assets: Record<string, Asset> = {
  v1: { file: "v1.mp4", duration: 10, hasAudio: true },
  v2: { file: "v2.mp4", duration: 4, hasAudio: false },
  i1: { file: "i1.png", duration: 5, hasAudio: false, kind: "image" },
  i2: { file: "i2.png", duration: 5, hasAudio: false, kind: "image" },
  s1: { file: "s1.mp3", duration: 30, hasAudio: true, kind: "audio" },
  s2: { file: "s2.mp3", duration: 3, hasAudio: true, kind: "audio" },
  g: { file: "g.mp4", duration: 2, hasAudio: false, loopByDefault: true },
}
const clip = (id: string, start: number, len: number, asset: string, extra: Partial<Clip> = {}): Clip => ({ id, asset, in: 0, out: len, start, ...extra })
const text = (id: string, start: number): Clip => ({ id, asset: "", in: 0, out: 3, start, text: { content: "Hello", color: "#ffffff", orientation: "horizontal" } as never })
const proj = (): Project => ({
  ...newProject("P"),
  assets,
  tracks: [{ id: "t1", clips: [clip("a", 0, 5, "v1", { muted: true }), clip("b", 5, 3, "i1"), clip("c", 8, 4, "v1")] }, { id: "t2", clips: [text("t", 1)] }],
  audioTrack: { id: "audio", clips: [clip("m", 0, 12, "s1")] },
})
const ids = (p: Project, t = 0) => p.tracks[t].clips.map((c) => `${c.id}@${c.start}+${c.out - c.in}`)

describe("slot candidates and kinds", () => {
  it("lists every clip with defaults: visuals replaceable, sounds and text fixed, labelled by kind and count", () => {
    const rows = slotCandidates(proj())
    expect(rows.map((r) => [r.clip.id, r.kind, r.defaultReplaceable, r.defaultLabel])).toEqual([
      ["a", "visual", true, "Video 1"], ["b", "visual", true, "Photo 1"], ["c", "visual", true, "Video 2"], ["t", "text", false, "Text 1"], ["m", "audio", false, "Sound 1"],
    ])
    expect(slotKindOf(proj(), text("t", 0))).toBe("text")
  })
  it("acceptsAsset: pictures and videos fill visual slots, sounds sound slots, nothing fills text", () => {
    expect(acceptsAsset("visual", assets.i1) && acceptsAsset("visual", assets.v1) && !acceptsAsset("visual", assets.s1)).toBe(true)
    expect(acceptsAsset("audio", assets.s1) && !acceptsAsset("audio", assets.v1)).toBe(true)
    expect(acceptsAsset("text", assets.i1)).toBe(false)
  })
})

describe("buildSlots", () => {
  it("remembers the placeholder, skips unknown clips and tidies labels", () => {
    expect(buildSlots(proj(), { a: " Main  video ", t: "Title", zzz: "x" })).toEqual({ a: { label: "Main video", asset: "v1" }, t: { label: "Title", text: "Hello" } })
  })
})

describe("replaceClipMedia", () => {
  it("keeps the clip's settings; a video takes its start and the slot length, or all it has when shorter, and later clips follow", () => {
    const p = proj()
    const longer = replaceClipMedia(p, "a", "v2")
    expect(longer.tracks[0].clips[0]).toMatchObject({ asset: "v2", in: 0, out: 4, muted: true })
    expect(ids(longer)).toEqual(["a@0+4", "b@5+3", "c@8+4"])
    const snapped = { ...p, tracks: [{ ...p.tracks[0], magnetic: true as const }, p.tracks[1]] }
    expect(ids(replaceClipMedia(snapped, "a", "v2"))).toEqual(["a@0+4", "b@4+3", "c@7+4"])
  })
  it("a photo takes the slot's length; a longer file is cut to the slot", () => {
    const p = proj()
    expect(ids(replaceClipMedia(p, "b", "i2"))).toContain("b@5+3")
    expect(replaceClipMedia(p, "a", "i1").tracks[0].clips[0]).toMatchObject({ asset: "i1", in: 0, out: 5 })
    expect(replaceClipMedia(p, "c", "v1").tracks[0].clips[2].out).toBe(4)
  })
  it("growing into later clips pushes them on a free layer", () => {
    const p = proj()
    p.tracks[0].clips[1] = clip("b", 5, 3, "v2") // 4 s file, 3 s clip
    const r = replaceClipMedia(p, "b", "v1")
    expect(r.tracks[0].clips[1].out).toBe(3)
  })
  it("a sound slot takes sounds only, a picture slot never a sound, text nothing", () => {
    const p = proj()
    expect(replaceClipMedia(p, "m", "s2").audioTrack?.clips[0]).toMatchObject({ asset: "s2", out: 3 })
    expect(replaceClipMedia(p, "m", "v1")).toBe(p)
    expect(replaceClipMedia(p, "a", "s1")).toBe(p)
    expect(replaceClipMedia(p, "t", "i1")).toBe(p)
    expect(replaceClipMedia(p, "a", "a-missing")).toBe(p)
  })
  it("an image replaced by a GIF loops for the slot length", () => {
    const r = replaceClipMedia(proj(), "b", "g")
    expect(r.tracks[0].clips[1]).toMatchObject({ asset: "g", loop: true, out: 3 })
  })
})

describe("template in the project file", () => {
  const base = (): Project => {
    const p = proj()
    return { ...p, template: { master: true, description: "d", slots: { a: { label: "A", asset: "v1" }, gone: { label: "G" } } } }
  }
  it("round-trips through parseProject and drops slots whose clip is gone", () => {
    const back = parseProject(JSON.parse(JSON.stringify(base())))
    expect(back?.template).toEqual({ master: true, description: "d", slots: { a: { label: "A", asset: "v1" } } })
    expect(parseProject({ ...JSON.parse(JSON.stringify(base())), template: { slots: 3 } })).toBeNull()
  })
  it("a save from the client can't change the template", () => {
    const stored = base()
    const client = { ...JSON.parse(JSON.stringify(stored)), template: { master: true, slots: { b: { label: "forged" } } } }
    expect(mergeClientProject(client, stored)?.template).toEqual({ master: true, description: "d", slots: { a: { label: "A", asset: "v1" } } })
    const plain = proj()
    expect(mergeClientProject({ ...JSON.parse(JSON.stringify(plain)), template: { master: true, slots: { a: { label: "x" } } } }, plain)?.template).toBeUndefined()
  })
})

import { fixedAssetIds, placeholderAsset, slotsNeedingPlaceholders, withPlaceholders } from "./template-placeholders"

describe("placeholders in a template", () => {
  const p = (): Project => ({ ...proj(), assets: { ...assets, ph: placeholderAsset("visual", "ph.png", "Main", 5) } })

  it("fixedAssetIds is the media the clips outside the slots use", () => {
    expect([...fixedAssetIds(proj(), new Set(["a", "m"]))].sort()).toEqual(["i1", "v1"])
  })

  it("withPlaceholders swaps slot clips for placeholders of their length, keeps their settings and drops the other media", () => {
    const made = { a: { id: "pa", asset: placeholderAsset("visual", "pa.png", "Main", 5) }, m: { id: "pm", asset: placeholderAsset("audio", "pm.m4a", "Music", 12) } }
    const r = withPlaceholders(proj(), { a: "Main", m: "Music", t: "Title" }, made)
    expect(r.tracks[0].clips[0]).toMatchObject({ id: "a", asset: "pa", in: 0, out: 5, start: 0, muted: true })
    expect(r.audioTrack?.clips[0]).toMatchObject({ asset: "pm", in: 0, out: 12 })
    expect(r.tracks[1].clips[0].text?.content).toBe("Title")
    // Only what the fixed clips use, plus the placeholders: v1 (clip c), i1 (clip b); s1 and the text have none left.
    expect(Object.keys(r.assets).sort()).toEqual(["i1", "pa", "pm", "v1"])
  })

  it("a long video slot becomes an image no longer than an image can be, and a loop is dropped", () => {
    const q = proj()
    q.tracks[0].clips[0] = clip("a", 0, 900, "v1", { loop: true })
    const r = withPlaceholders(q, { a: "Main" }, { a: { id: "pa", asset: placeholderAsset("visual", "pa.png", "Main", 5) } })
    expect(r.tracks[0].clips[0].out).toBe(5)
    expect(r.tracks[0].clips[0].loop).toBeUndefined()
  })

  it("a slot already holding a placeholder with its label needs none and keeps it", () => {
    const q = p()
    q.tracks[0].clips[0] = clip("a", 0, 5, "ph")
    expect(slotsNeedingPlaceholders(q, { a: "Main" })).toEqual([])
    expect(slotsNeedingPlaceholders(q, { a: "Renamed" })).toEqual([{ id: "a", kind: "visual", label: "Renamed" }])
    const r = withPlaceholders(q, { a: "Main" }, {})
    expect(r.assets.ph).toBeDefined()
    expect(r.tracks[0].clips[0].asset).toBe("ph")
  })

  it("text slots need no placeholder file; sounds and pictures do, with their kind", () => {
    expect(slotsNeedingPlaceholders(proj(), { t: "Title", a: "Main", m: "Music" })).toEqual([
      { id: "a", kind: "visual", label: "Main" }, { id: "m", kind: "audio", label: "Music" },
    ])
  })
})

import { isTemplateSlot, moveOnClip, placeDropped, slotLabelOf } from "./project"

describe("dropping on a template's slot always replaces it", () => {
  // Slots are the clips that show a placeholder: no template state is stored on the project.
  const withSlots = (): Project => {
    const p = proj()
    p.assets = { ...p.assets, ph: placeholderAsset("visual", "ph.png", "Main", 5), phs: placeholderAsset("audio", "phs.m4a", "Song", 12) }
    p.tracks[0].clips[0] = clip("a", 0, 5, "ph", { muted: true, transform: { x: 0.2, y: 0, scale: 0.5, cropTop: 0, cropBottom: 0 } })
    p.audioTrack = { id: "audio", clips: [clip("m", 0, 12, "phs")] }
    return p
  }

  it("a clip showing a placeholder is a slot, with the label on it; once replaced it is an ordinary clip", () => {
    const p = withSlots()
    expect(isTemplateSlot(p, "a")).toBe(true)
    expect(isTemplateSlot(p, "m")).toBe(true)
    expect(isTemplateSlot(p, "b")).toBe(false)
    expect(isTemplateSlot(p, "zzz")).toBe(false)
    expect(slotLabelOf(p, p.tracks[0].clips[0])).toBe("Main")
    expect(slotLabelOf(p, p.tracks[0].clips[1])).toBeUndefined()
    const filled = placeDropped(p, "v2", 0, { start: 0, on: { clip: "a", mode: "replace" } }, "x")
    expect(isTemplateSlot(filled, "a")).toBe(false)
    expect(slotLabelOf(filled, filled.tracks[0].clips[0])).toBeUndefined()
    expect(p.template).toBeUndefined()
  })

  it("media dropped on the left, middle or right of the slot goes in it, keeping its place and settings", () => {
    for (const mode of ["before", "replace", "after"] as const) {
      const r = placeDropped(withSlots(), "v2", 0, { start: 0, on: { clip: "a", mode } }, "x")
      expect(r.tracks[0].clips.map((c) => c.id)).toEqual(["a", "b", "c"])
      expect(r.tracks[0].clips[0]).toMatchObject({ id: "a", asset: "v2", muted: true, start: 0, out: 4 })
      expect(r.tracks[0].clips[0].transform?.scale).toBe(0.5)
    }
  })

  it("a sound on a picture slot, or a picture on a sound slot, does nothing (it is not added elsewhere)", () => {
    const p = withSlots()
    expect(placeDropped(p, "s2", 0, { start: 0, on: { clip: "a", mode: "before" } }, "x")).toBe(p)
    expect(placeDropped(p, "v2", -1, { start: 0, on: { clip: "m", mode: "after" } }, "x")).toBe(p)
  })

  it("a clip moved onto a slot gives it its media and trim and is used up; a plain clip still moves the old way", () => {
    const p = withSlots()
    p.tracks[0].clips[2] = clip("c", 8, 4, "v1", { in: 2, out: 6 })
    p.tracks[0].clips[2] = { ...p.tracks[0].clips[2], in: 2, out: 6 }
    const r = moveOnClip({ ...p, assets: { ...p.assets, v3: assets.v1 } }, "c", { clip: "a", mode: "after" })
    expect(r.tracks[0].clips.map((c) => c.id)).toEqual(["a", "b"])
    expect(r.tracks[0].clips[0]).toMatchObject({ asset: "v1", in: 2, out: 6, muted: true })
    const plain = proj()
    expect(moveOnClip(plain, "c", { clip: "a", mode: "after" }).tracks[0].clips.map((c) => c.id)).toContain("c")
  })
})
