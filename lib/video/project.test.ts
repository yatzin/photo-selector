import { describe, expect, it } from "vitest"
import {
  addClip, addTrack, allClips, assetKind, clipAt, clipsAt, clipStarts, DEFAULT_IMAGE, findAssetsBySource, MAX_CLIPS, MAX_IMAGE, MAX_TIMELINE, MAX_TRACKS, mergeClientProject, MIN_CLIP,
  moveClip, newProject, parseProject, removeClip, removeTrack, resolveStart, setTrackMuted, splitClip, totalLength, trackStarts, trimClip, type Clip, type Project,
} from "./project"

function sample(): Project {
  return {
    ...newProject("demo"),
    assets: { a: { file: "a.mp4", duration: 10, hasAudio: true } },
    tracks: [{
      id: "t1",
      clips: [
        { id: "c1", asset: "a", in: 0, out: 3 },
        { id: "c2", asset: "a", in: 2, out: 4 },
      ],
    }],
  }
}

/** The base track's clips. */
const base = (p: Project) => p.tracks[0].clips

describe("newProject", () => {
  it("defaults to 1920x1080 at 30fps with one empty base track", () => {
    const p = newProject("x")
    expect([p.width, p.height, p.fps]).toEqual([1920, 1080, 30])
    expect(p.version).toBe(2)
    expect(p.tracks).toEqual([{ id: "t1", clips: [] }])
  })
})

describe("clipStarts and totalLength", () => {
  it("lays clips end to end", () => {
    const p = sample()
    expect(clipStarts(base(p))).toEqual([0, 3])
    expect(totalLength(p)).toBe(5)
  })
})

describe("addClip", () => {
  it("inserts at the index with the full asset length", () => {
    const p = addClip(sample(), "a", 0, { index: 1 }, "n")
    expect(base(p).map((c) => c.id)).toEqual(["c1", "n", "c2"])
    expect(base(p)[1]).toEqual({ id: "n", asset: "a", in: 0, out: 10 })
  })

  it("does nothing for an asset shorter than MIN_CLIP", () => {
    const p = { ...sample(), assets: { ...sample().assets, z: { file: "z.mp4", duration: MIN_CLIP / 2, hasAudio: false } } }
    expect(addClip(p, "z", 0, { index: 0 }, "n")).toBe(p)
  })
})

describe("trimClip", () => {
  it("clamps in to out - MIN_CLIP", () => {
    const p = trimClip(sample(), "c1", "in", 5)
    expect(base(p)[0].in).toBeCloseTo(3 - MIN_CLIP)
  })

  it("clamps out to the asset duration", () => {
    expect(base(trimClip(sample(), "c1", "out", 99))[0].out).toBe(10)
  })

  it("clamps negative seconds to 0", () => {
    expect(base(trimClip(sample(), "c2", "in", -4))[1].in).toBe(0)
  })

  it("clamps out to in + MIN_CLIP", () => {
    expect(base(trimClip(sample(), "c2", "out", 0))[1].out).toBeCloseTo(2 + MIN_CLIP)
  })
})

describe("splitClip", () => {
  it("splits at the timeline time", () => {
    const p = splitClip(sample(), "c1", 1, "s")
    expect(base(p).map((c) => [c.id, c.in, c.out])).toEqual([["c1", 0, 1], ["s", 1, 3], ["c2", 2, 4]])
  })

  it("uses the clip's offset on the timeline", () => {
    const p = splitClip(sample(), "c2", 4, "s")
    expect(base(p)[1]).toMatchObject({ id: "c2", in: 2, out: 3 })
    expect(base(p)[2]).toMatchObject({ id: "s", in: 3, out: 4 })
  })

  it("does nothing within MIN_CLIP of an edge", () => {
    const p = sample()
    expect(splitClip(p, "c1", 0.1, "s")).toBe(p)
    expect(splitClip(p, "c1", 2.9, "s")).toBe(p)
  })
})

describe("splitClip boundaries and bad input", () => {
  it("does nothing at exactly the clip edges", () => {
    const p = sample()
    expect(splitClip(p, "c1", 0, "s")).toBe(p)
    expect(splitClip(p, "c1", 3, "s")).toBe(p)
  })

  it("splits at exactly MIN_CLIP from each edge", () => {
    for (const t of [MIN_CLIP, 3 - MIN_CLIP]) {
      const p = splitClip(sample(), "c1", t, "s")
      expect(base(p)).toHaveLength(3)
      for (const c of base(p)) expect(c.out - c.in).toBeGreaterThanOrEqual(MIN_CLIP - 1e-9)
    }
  })

  it("is a no-op for non-finite times", () => {
    const p = sample()
    for (const t of [NaN, Infinity, -Infinity]) expect(splitClip(p, "c1", t, "s")).toBe(p)
  })

  it("is a no-op when newId is already used", () => {
    const p = sample()
    expect(splitClip(p, "c1", 1, "c2")).toBe(p)
  })
})

describe("trimClip invariants", () => {
  it("keeps out - in >= MIN_CLIP for extreme inputs", () => {
    for (const edge of ["in", "out"] as const) {
      for (const s of [0, -5, 99, Infinity, -Infinity]) {
        const c = base(trimClip(sample(), "c1", edge, s))[0]
        expect(c.out - c.in).toBeGreaterThanOrEqual(MIN_CLIP - 1e-9)
        expect(c.in).toBeGreaterThanOrEqual(0)
        expect(c.out).toBeLessThanOrEqual(10)
      }
    }
  })

  it("ignores NaN", () => {
    const p = sample()
    expect(trimClip(p, "c1", "in", NaN)).toBe(p)
    expect(trimClip(p, "c1", "out", NaN)).toBe(p)
  })

  it("leaves the project unchanged when the asset is shorter than MIN_CLIP", () => {
    const p: Project = {
      ...newProject("short"),
      assets: { s: { file: "s.mp4", duration: 0.1, hasAudio: false } },
      tracks: [{ id: "t1", clips: [{ id: "c1", asset: "s", in: 0, out: 0.1 }] }],
    }
    for (const edge of ["in", "out"] as const) {
      for (const s of [-1, 0, 0.05, 0.1, 5]) expect(trimClip(p, "c1", edge, s)).toBe(p)
    }
  })

  it("still allows a trim to exactly MIN_CLIP despite float rounding", () => {
    const p: Project = { ...newProject("f"), assets: { a: { file: "a.mp4", duration: 10, hasAudio: true } }, tracks: [{ id: "t1", clips: [{ id: "c1", asset: "a", in: 0.7, out: 5 }] }] }
    expect(base(trimClip(p, "c1", "out", 0))[0].out).toBeCloseTo(0.7 + MIN_CLIP)
  })
})

describe("addClip duplicate id", () => {
  it("is a no-op when the id is already used", () => {
    const p = sample()
    expect(addClip(p, "a", 0, { index: 0 }, "c1")).toBe(p)
  })
})

describe("moveClip", () => {
  it("moves a clip to the end", () => {
    expect(base(moveClip(sample(), "c1", 0, { index: 1 })).map((c) => c.id)).toEqual(["c2", "c1"])
  })
})

describe("removeClip", () => {
  it("drops the clip", () => {
    expect(base(removeClip(sample(), "c1")).map((c) => c.id)).toEqual(["c2"])
  })
})

describe("purity", () => {
  it("does not mutate its input", () => {
    const p = layered()
    const copy = JSON.parse(JSON.stringify(p))
    trimClip(p, "c1", "out", 1)
    trimClip(p, "o1", "in", 1.5)
    splitClip(p, "c1", 1, "s")
    splitClip(p, "o1", 2, "s")
    moveClip(p, "c1", 0, { index: 1 })
    moveClip(p, "c1", 1, { start: 9 })
    removeClip(p, "c1")
    removeClip(p, "o1")
    addClip(p, "a", 0, { index: 0 }, "n")
    addClip(p, "a", 1, { start: 1 }, "n")
    addTrack(p)
    removeTrack(p, "t2")
    setTrackMuted(p, "t2", true)
    expect(p).toEqual(copy)
  })
})

describe("parseProject", () => {
  it("round-trips a valid project", () => {
    const p = sample()
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  it("rejects a size or frame rate that isn't a sane whole number", () => {
    const bad = [{ width: "1920" }, { height: 1080.5 }, { width: 0 }, { height: -1 }, { width: 7681 }, { fps: 0 }, { fps: 121 }, { fps: 29.97 }, { fps: Infinity }, { fps: "30" }]
    for (const patch of bad) expect(parseProject({ ...sample(), ...patch })).toBeNull()
    expect(parseProject({ ...sample(), width: 7680, height: 4320, fps: 120 })).not.toBeNull()
  })

  it("rejects an unknown version, or version 2 without tracks", () => {
    expect(parseProject({ ...sample(), version: 3 })).toBeNull()
    expect(parseProject({ version: 2 })).toBeNull()
  })

  it("rejects non-objects", () => {
    expect(parseProject(null)).toBeNull()
    expect(parseProject("x")).toBeNull()
  })

  it("rejects clips referencing an unknown asset", () => {
    const p = sample()
    base(p).push({ id: "c3", asset: "missing", in: 0, out: 1 })
    expect(parseProject(p)).toBeNull()
  })

  it("rejects malformed clips", () => {
    const p = { ...sample(), tracks: [{ id: "t1", clips: [{ id: "c1", asset: "a", in: "0", out: 3 }] }] }
    expect(parseProject(p)).toBeNull()
  })

  it("rejects duplicate clip ids", () => {
    const p = sample()
    base(p)[1].id = "c1"
    expect(parseProject(p)).toBeNull()
  })

  it("rejects out-of-range clips", () => {
    for (const [i, o] of [[-1, 3], [3, 3], [4, 3], [0, 11]]) {
      const p = sample()
      base(p)[0] = { id: "c1", asset: "a", in: i, out: o }
      expect(parseProject(p)).toBeNull()
    }
  })

  it("caps the name at 200 characters", () => {
    expect(parseProject({ ...sample(), name: "x".repeat(200) })).not.toBeNull()
    expect(parseProject({ ...sample(), name: "x".repeat(201) })).toBeNull()
  })

  it("rejects a __proto__ asset key", () => {
    const text = JSON.stringify(sample()).replace('"assets":{', '"assets":{"__proto__":{"file":"x.mp4","duration":1,"hasAudio":false},')
    expect(parseProject(JSON.parse(text))).toBeNull()
  })
})

describe("parseProject: version 1 files", () => {
  const v1 = () => ({
    version: 1, name: "old", width: 1920, height: 1080, fps: 30,
    assets: { a: { file: "a.mp4", duration: 10, hasAudio: true } },
    clips: [{ id: "c1", asset: "a", in: 0, out: 3 }, { id: "c2", asset: "a", in: 2, out: 4 }],
  })

  it("migrates flat clips to one base track and returns version 2", () => {
    const p = parseProject(v1())
    expect(p?.version).toBe(2)
    expect(p?.tracks).toEqual([{ id: "t1", clips: v1().clips }])
    expect(p).not.toHaveProperty("clips")
    expect(p && totalLength(p)).toBe(5)
  })

  it("still validates version 1 clips", () => {
    expect(parseProject({ ...v1(), clips: [{ id: "c1", asset: "a", in: 0, out: 11 }] })).toBeNull()
    expect(parseProject({ ...v1(), clips: "x" })).toBeNull()
  })
})

/** A base video track and an overlay track holding a video at 1-3 s and an image at 5-7 s. */
function layered(): Project {
  return {
    ...newProject("layers"),
    assets: {
      a: { file: "a.mp4", duration: 10, hasAudio: true },
      i: { file: "i.jpg", duration: DEFAULT_IMAGE, hasAudio: false, kind: "image" },
    },
    tracks: [
      { id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 3 }, { id: "c2", asset: "a", in: 2, out: 4 }] },
      { id: "t2", clips: [{ id: "o1", asset: "a", in: 4, out: 6, start: 1 }, { id: "o2", asset: "i", in: 0, out: 2, start: 5 }] },
    ],
  }
}
const overlay = (p: Project, i = 1) => p.tracks[i].clips

describe("parseProject: tracks", () => {
  it("round-trips tracks, overlay starts and mute", () => {
    const p = layered()
    p.tracks[1].muted = true
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  it("drops muted: false and a start on the base track", () => {
    const p = layered()
    const parsed = parseProject({ ...p, tracks: [{ ...p.tracks[0], muted: false, clips: [{ ...base(p)[0], start: 4 }, base(p)[1]] }, p.tracks[1]] })
    expect(parsed?.tracks[0]).toEqual({ id: "t1", clips: base(p) })
  })

  it("sorts an overlay track by start", () => {
    const p = layered()
    const parsed = parseProject({ ...p, tracks: [p.tracks[0], { id: "t2", clips: [...overlay(p)].reverse() }] })
    expect(parsed && overlay(parsed).map((c) => c.id)).toEqual(["o1", "o2"])
  })

  it("requires a finite, non-negative start on overlay clips", () => {
    for (const start of [undefined, -1, Infinity, NaN, "1"]) {
      const p = layered()
      const bad = { ...p, tracks: [p.tracks[0], { id: "t2", clips: [{ ...overlay(p)[0], start }] }] }
      expect(parseProject(bad)).toBeNull()
    }
  })

  it("rejects overlapping clips on an overlay track, accepts touching ones", () => {
    const p = layered()
    const at = (s: number) => ({ ...p, tracks: [p.tracks[0], { id: "t2", clips: [overlay(p)[0], { ...overlay(p)[1], start: s }] }] })
    expect(parseProject(at(2.9))).toBeNull()
    expect(parseProject(at(3))).not.toBeNull()
  })

  it("rejects no tracks, more than MAX_TRACKS, duplicate track ids and a bad track", () => {
    const p = layered()
    const empty = (id: string) => ({ id, clips: [] })
    expect(parseProject({ ...p, tracks: [] })).toBeNull()
    expect(parseProject({ ...p, tracks: [...p.tracks, empty("t3"), empty("t4")] })).not.toBeNull()
    expect(parseProject({ ...p, tracks: [...p.tracks, empty("t3"), empty("t4"), empty("t5")] })).toBeNull()
    expect(parseProject({ ...p, tracks: [p.tracks[0], { ...p.tracks[1], id: "t1" }] })).toBeNull()
    expect(parseProject({ ...p, tracks: [p.tracks[0], { id: 5, clips: [] }] })).toBeNull()
    expect(parseProject({ ...p, tracks: [p.tracks[0], { id: "", clips: [] }] })).toBeNull()
    expect(parseProject({ ...p, tracks: [p.tracks[0], { id: "x".repeat(65), clips: [] }] })).toBeNull()
    expect(parseProject({ ...p, tracks: [p.tracks[0], { id: "t2", clips: "x" }] })).toBeNull()
    expect(parseProject({ ...p, tracks: [p.tracks[0], { id: "t2", muted: "yes", clips: [] }] })).toBeNull()
  })

  it("rejects a clip id used on two tracks", () => {
    const p = layered()
    overlay(p)[0].id = "c1"
    expect(parseProject(p)).toBeNull()
  })
})

describe("mergeClientProject", () => {
  const stored: Project = {
    ...newProject("P"),
    assets: { a1: { file: "one.mp4", duration: 10, hasAudio: true } },
  }
  const one = (clips: unknown[]) => [{ id: "t1", clips }]

  it("ignores client-supplied assets", () => {
    const client = {
      ...stored,
      assets: { a1: { file: "../../evil.mp4", duration: 10, hasAudio: true }, a2: { file: "x.mp4", duration: 5, hasAudio: false } },
      tracks: one([{ id: "c1", asset: "a1", in: 0, out: 5 }]),
    }
    const merged = mergeClientProject(client, stored)
    expect(merged?.assets).toEqual(stored.assets)
    expect(merged && base(merged)).toHaveLength(1)
  })

  it("rejects a clip whose asset isn't stored", () => {
    const client = {
      ...stored,
      assets: { a2: { file: "x.mp4", duration: 5, hasAudio: false } },
      tracks: one([{ id: "c1", asset: "a2", in: 0, out: 5 }]),
    }
    expect(mergeClientProject(client, stored)).toBeNull()
  })

  it("keeps the stored name and settings (a stale tab can't revert a rename)", () => {
    const client = { ...stored, name: "Stale", width: 1280, height: 720, fps: 25, tracks: one([{ id: "c1", asset: "a1", in: 0, out: 5 }]) }
    const merged = mergeClientProject(client, stored)
    expect(merged && [merged.name, merged.width, merged.height, merged.fps]).toEqual(["P", 1920, 1080, 30])
    expect(merged && base(merged)).toHaveLength(1)
  })

  it("rejects a clip beyond the stored asset's duration", () => {
    const client = { ...stored, tracks: one([{ id: "c1", asset: "a1", in: 0, out: 50 }]) }
    expect(mergeClientProject(client, stored)).toBeNull()
  })

  it("takes the client's tracks, mute included", () => {
    const client = { ...stored, tracks: [{ id: "t1", clips: [] }, { id: "t9", muted: true, clips: [{ id: "o", asset: "a1", in: 1, out: 2, start: 3 }] }] }
    expect(mergeClientProject(client, stored)?.tracks).toEqual(client.tracks)
  })

  it("accepts a version 1 client and returns version 2", () => {
    const client = { ...stored, version: 1, tracks: undefined, clips: [{ id: "c1", asset: "a1", in: 0, out: 5 }] }
    const merged = mergeClientProject(client, stored)
    expect(merged?.version).toBe(2)
    expect(merged && base(merged)).toEqual([{ id: "c1", asset: "a1", in: 0, out: 5 }])
  })

  it(`rejects more than ${MAX_CLIPS} clips in total, overlaps, too many tracks and bad starts`, () => {
    const clip = (id: string, start?: number) => ({ id, asset: "a1", in: 0, out: 1, ...(start === undefined ? {} : { start }) })
    const half = MAX_CLIPS / 2
    const many = (n: number, prefix: string, overlay: boolean) => Array.from({ length: n }, (_, i) => clip(`${prefix}${i}`, overlay ? i : undefined))
    expect(mergeClientProject({ ...stored, tracks: [{ id: "t1", clips: many(half, "b", false) }, { id: "t2", clips: many(half, "o", true) }] }, stored)).not.toBeNull()
    expect(mergeClientProject({ ...stored, tracks: [{ id: "t1", clips: many(half, "b", false) }, { id: "t2", clips: many(half + 1, "o", true) }] }, stored)).toBeNull()
    expect(mergeClientProject({ ...stored, tracks: [{ id: "t1", clips: [] }, { id: "t2", clips: [clip("x", 0), clip("y", 0.5)] }] }, stored)).toBeNull()
    const five = Array.from({ length: MAX_TRACKS + 1 }, (_, i) => ({ id: `t${i}`, clips: [] }))
    expect(mergeClientProject({ ...stored, tracks: five }, stored)).toBeNull()
    expect(mergeClientProject({ ...stored, tracks: [{ id: "t1", clips: [] }, { id: "t2", clips: [clip("x", -0.5)] }] }, stored)).toBeNull()
    expect(mergeClientProject({ ...stored, tracks: [{ id: "t1", clips: [] }, { id: "t1", clips: [] }] }, stored)).toBeNull()
  })
})

function withImage(): Project {
  return {
    ...newProject("img"),
    assets: {
      a: { file: "a.mp4", duration: 10, hasAudio: true },
      i: { file: "i.jpg", duration: DEFAULT_IMAGE, hasAudio: false, kind: "image", source: "mike/i.jpg" },
    },
    tracks: [{
      id: "t1",
      clips: [
        { id: "c1", asset: "a", in: 0, out: 3 },
        { id: "p", asset: "i", in: 0, out: 4 },
      ],
    }],
  }
}

describe("assetKind", () => {
  it("is video unless the asset says image", () => {
    expect(assetKind({ file: "a.mp4", duration: 1, hasAudio: true })).toBe("video")
    expect(assetKind({ file: "a.mp4", duration: 1, hasAudio: true, kind: "video" })).toBe("video")
    expect(assetKind({ file: "i.jpg", duration: 5, hasAudio: false, kind: "image" })).toBe("image")
  })
})

describe("image clips", () => {
  it("addClip gives an image clip the default length", () => {
    const p = { ...withImage(), assets: { ...withImage().assets, i: { ...withImage().assets.i, duration: 99 } } }
    expect(base(addClip(p, "i", 0, { index: 0 }, "n"))[0]).toEqual({ id: "n", asset: "i", in: 0, out: DEFAULT_IMAGE })
  })

  it("trims the out edge to the new length, with in staying 0", () => {
    expect(base(trimClip(withImage(), "p", "out", 7))[1]).toMatchObject({ in: 0, out: 7 })
    // An image has no source length to run out of.
    expect(base(trimClip(withImage(), "p", "out", 300))[1]).toMatchObject({ in: 0, out: 300 })
  })

  it("trims the in edge by shortening or lengthening the clip, with in staying 0", () => {
    expect(base(trimClip(withImage(), "p", "in", 1.5))[1]).toMatchObject({ in: 0, out: 2.5 })
    expect(base(trimClip(withImage(), "p", "in", -2))[1]).toMatchObject({ in: 0, out: 6 })
  })

  it("clamps image lengths to MIN_CLIP..MAX_IMAGE", () => {
    const len = (edge: "in" | "out", s: number) => base(trimClip(withImage(), "p", edge, s))[1].out
    expect(len("out", 0)).toBe(MIN_CLIP)
    expect(len("out", MAX_IMAGE + 50)).toBe(MAX_IMAGE)
    expect(len("in", 10)).toBe(MIN_CLIP)
    expect(len("in", -MAX_IMAGE)).toBe(MAX_IMAGE)
    expect(len("out", Infinity)).toBe(MAX_IMAGE)
    expect(len("out", -Infinity)).toBe(MIN_CLIP)
    expect(len("in", Infinity)).toBe(MIN_CLIP)
    expect(len("in", -Infinity)).toBe(MAX_IMAGE)
    for (const edge of ["in", "out"] as const) expect(base(trimClip(withImage(), "p", edge, 3))[1].in).toBe(0)
  })

  it("ignores NaN on an image clip", () => {
    const p = withImage()
    expect(trimClip(p, "p", "in", NaN)).toBe(p)
    expect(trimClip(p, "p", "out", NaN)).toBe(p)
  })

  it("splits an image clip into two image clips that both start at 0", () => {
    const p = splitClip(withImage(), "p", 4, "s")
    expect(base(p).map((c) => [c.id, c.in, c.out])).toEqual([["c1", 0, 3], ["p", 0, 1], ["s", 0, 3]])
  })

  it("does not split an image clip within MIN_CLIP of an edge", () => {
    const p = withImage()
    expect(splitClip(p, "p", 3.1, "s")).toBe(p)
    expect(splitClip(p, "p", 6.9, "s")).toBe(p)
  })

  it("clipAt gives the time inside an image clip", () => {
    expect(clipAt(base(withImage()), 4.5)).toEqual({ index: 1, sourceTime: 1.5 })
    expect(clipAt(base(withImage()), 7)).toBeNull()
  })
})

describe("parseProject with images", () => {
  it("round-trips kind and source", () => {
    const p = withImage()
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  it("accepts an image clip longer than the asset's duration, up to MAX_IMAGE", () => {
    const p = withImage()
    base(p)[1] = { id: "p", asset: "i", in: 0, out: MAX_IMAGE }
    expect(parseProject(p)).not.toBeNull()
  })

  it("rejects image clips that don't start at 0 or are out of range", () => {
    for (const [i, o] of [[1, 3], [0, MIN_CLIP / 2], [0, MAX_IMAGE + 1], [0, 0]]) {
      const p = withImage()
      base(p)[1] = { id: "p", asset: "i", in: i, out: o }
      expect(parseProject(p)).toBeNull()
    }
  })

  it("rejects a bad kind or source", () => {
    for (const patch of [{ kind: "audio" }, { kind: 1 }, { source: 5 }, { source: "x".repeat(401) }]) {
      const p = withImage()
      expect(parseProject({ ...p, assets: { ...p.assets, i: { ...p.assets.i, ...patch } } })).toBeNull()
    }
    const p = withImage()
    expect(parseProject({ ...p, assets: { ...p.assets, i: { ...p.assets.i, source: "x".repeat(400) } } })).not.toBeNull()
  })

  it("mergeClientProject keeps stored image assets and validates against them", () => {
    const stored = withImage()
    const client = { ...stored, assets: { ...stored.assets, x: { file: "x.jpg", duration: 5, hasAudio: false, kind: "image" } }, tracks: [{ id: "t1", clips: [{ id: "p", asset: "i", in: 0, out: 60 }] }] }
    const merged = mergeClientProject(client, stored)
    expect(merged?.assets).toEqual(stored.assets)
    expect(merged && base(merged)).toEqual([{ id: "p", asset: "i", in: 0, out: 60 }])
    // A client can't stretch a video past its length by calling it an image.
    const spoof = { ...stored, assets: { ...stored.assets, a: { ...stored.assets.a, kind: "image" } }, tracks: [{ id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 60 }] }] }
    expect(mergeClientProject(spoof, stored)).toBeNull()
  })
})

describe("findAssetsBySource", () => {
  it("finds every asset imported from that Inbox file, in order", () => {
    expect(findAssetsBySource(withImage(), "mike/i.jpg")).toEqual([{ id: "i", asset: withImage().assets.i }])
    const p = withImage()
    const twice = { ...p, assets: { ...p.assets, j: { ...p.assets.i, file: "i (1).jpg" } } }
    expect(findAssetsBySource(twice, "mike/i.jpg").map((f) => f.id)).toEqual(["i", "j"])
  })

  it("is empty when no asset came from there", () => {
    expect(findAssetsBySource(withImage(), "mike/other.jpg")).toEqual([])
    expect(findAssetsBySource(withImage(), "")).toEqual([])
    expect(findAssetsBySource(newProject("x"), "mike/i.jpg")).toEqual([])
  })
})

describe("allClips, trackStarts and totalLength over tracks", () => {
  it("lists every clip, base track first", () => {
    expect(allClips(layered()).map((c) => c.id)).toEqual(["c1", "c2", "o1", "o2"])
  })

  it("lays out the base end to end and overlays by start", () => {
    const p = layered()
    expect(trackStarts(p.tracks[0], true)).toEqual([0, 3])
    expect(trackStarts(p.tracks[1], false)).toEqual([1, 5])
  })

  it("is the latest clip end over all tracks", () => {
    expect(totalLength(layered())).toBe(7)
    expect(totalLength(newProject("x"))).toBe(0)
  })
})

describe("clipsAt", () => {
  it("gives the active clip per track and the topmost one", () => {
    const r = clipsAt(layered(), 2)
    expect(r.tracks.map((h) => h && [h.clip.id, h.sourceTime])).toEqual([["c1", 2], ["o1", 5]])
    expect(r.top).toMatchObject({ track: 1, index: 0, start: 1, clip: { id: "o1" } })
  })

  it("is null on a track in a gap, and the top falls through to the base", () => {
    const r = clipsAt(layered(), 4)
    expect(r.tracks[1]).toBeNull()
    expect(r.top).toMatchObject({ track: 0, index: 1, sourceTime: 3, clip: { id: "c2" } })
  })

  it("has only overlay clips past the base end and nothing past the total", () => {
    expect(clipsAt(layered(), 6).top).toMatchObject({ track: 1, clip: { id: "o2" }, sourceTime: 1 })
    expect(clipsAt(layered(), 7).top).toBeNull()
    expect(clipsAt(layered(), -1).top).toBeNull()
  })
})

describe("resolveStart", () => {
  const clips: Clip[] = [{ id: "x", asset: "a", in: 0, out: 2, start: 2 }, { id: "y", asset: "a", in: 0, out: 1, start: 5 }] // 2-4 and 5-6
  it("keeps a start that fits", () => {
    expect(resolveStart(clips, 1, 0.5)).toBe(0.5)
    expect(resolveStart(clips, 1, 4)).toBe(4)
    expect(resolveStart(clips, 2, 9)).toBe(9)
  })
  it("slides past the neighbour it overlaps, and on past the next when there's no room", () => {
    expect(resolveStart(clips, 1, 3)).toBe(4)
    expect(resolveStart(clips, 1, 1.5)).toBe(4)
    expect(resolveStart(clips, 2, 3)).toBe(6)
  })
  it("never goes below 0 and ignores a clip by id", () => {
    expect(resolveStart(clips, 1, -3)).toBe(0)
    expect(resolveStart(clips, 2, 2, "x")).toBe(2)
  })
})

describe("addClip on overlay tracks", () => {
  it("places the clip at its start and keeps the track sorted", () => {
    const src = layered()
    src.assets.s = { file: "s.mp4", duration: 1, hasAudio: false }
    const p = addClip(src, "s", 1, { start: 3.5 }, "n")
    expect(overlay(p).map((c) => [c.id, c.start])).toEqual([["o1", 1], ["n", 3.5], ["o2", 5]])
    expect(overlay(p)[1]).toMatchObject({ in: 0, out: 1 })
  })

  it("slides past the clip it would overlap", () => {
    const p = addClip(layered(), "i", 1, { start: 2 }, "n")
    expect(overlay(p).find((c) => c.id === "n")?.start).toBe(7)
  })

  it("places at 0 without a start and never before 0", () => {
    const p = { ...layered(), tracks: [layered().tracks[0], { id: "t2", clips: [] }] }
    expect(overlay(addClip(p, "i", 1, {}, "n"))[0].start).toBe(0)
    expect(overlay(addClip(p, "i", 1, { start: -4 }, "n"))[0].start).toBe(0)
  })

  it("adds a layer when the track index is one past the top, up to MAX_TRACKS", () => {
    const p = addClip(layered(), "i", 2, { start: 2 }, "n")
    expect(p.tracks).toHaveLength(3)
    expect(p.tracks[2].clips).toEqual([{ id: "n", asset: "i", in: 0, out: DEFAULT_IMAGE, start: 2 }])
    const full = addTrack(addTrack(layered()))
    expect(addClip(full, "i", 4, { start: 0 }, "n")).toBe(full)
    const two = layered()
    expect(addClip(two, "i", 3, { start: 0 }, "n")).toBe(two)
  })

  it("is a no-op for a bad track index or an id used on another track", () => {
    const p = layered()
    expect(addClip(p, "a", 5, { start: 0 }, "n")).toBe(p)
    expect(addClip(p, "a", -1, { start: 0 }, "n")).toBe(p)
    expect(addClip(p, "a", 0, { index: 0 }, "o1")).toBe(p)
    expect(addClip(p, "a", 1, { start: 9 }, "c1")).toBe(p)
  })
})

describe("moveClip between tracks", () => {
  it("moves a base clip to an overlay track at a start, keeping in and out", () => {
    const p = moveClip(layered(), "c2", 1, { start: 3 })
    expect(base(p).map((c) => c.id)).toEqual(["c1"])
    expect(overlay(p).map((c) => c.id)).toEqual(["o1", "c2", "o2"])
    expect(overlay(p)[1]).toEqual({ id: "c2", asset: "a", in: 2, out: 4, start: 3 })
  })

  it("moves an overlay clip into the base at an index, dropping its start", () => {
    const p = moveClip(layered(), "o1", 0, { index: 1 })
    expect(base(p).map((c) => c.id)).toEqual(["c1", "o1", "c2"])
    expect(base(p)[1]).toEqual({ id: "o1", asset: "a", in: 4, out: 6 })
    expect(overlay(p).map((c) => c.id)).toEqual(["o2"])
  })

  it("moves within an overlay track, resolving overlaps without counting itself", () => {
    expect(overlay(moveClip(layered(), "o1", 1, { start: 1.5 }))[0].start).toBe(1.5)
    expect(overlay(moveClip(layered(), "o1", 1, { start: 4 })).map((c) => [c.id, c.start])).toEqual([["o2", 5], ["o1", 7]])
  })

  it("moves onto a new layer one past the top", () => {
    const p = moveClip(layered(), "c1", 2, { start: 2 })
    expect(p.tracks[2].clips).toEqual([{ id: "c1", asset: "a", in: 0, out: 3, start: 2 }])
  })

  it("is a no-op for an unknown clip or track", () => {
    const p = layered()
    expect(moveClip(p, "zz", 0, { index: 0 })).toBe(p)
    expect(moveClip(p, "c1", 7, { start: 0 })).toBe(p)
  })
})

describe("trimClip on overlay tracks", () => {
  it("moves start and in together on the left edge, so the content stays put", () => {
    const c = overlay(trimClip(layered(), "o1", "in", 4.5))[0]
    expect(c).toMatchObject({ in: 4.5, out: 6, start: 1.5 })
    const back = overlay(trimClip(layered(), "o1", "in", 3))[0]
    expect(back).toMatchObject({ in: 3, out: 6, start: 0 })
  })

  it("stops the left edge at 0, at the source start and at the previous clip", () => {
    expect(overlay(trimClip(layered(), "o1", "in", 0))[0]).toMatchObject({ in: 3, start: 0 })
    const p = { ...layered(), tracks: [layered().tracks[0], { id: "t2", clips: [{ id: "o1", asset: "a", in: 1, out: 3, start: 4 }] }] }
    expect(overlay(trimClip(p, "o1", "in", -5))[0]).toMatchObject({ in: 0, start: 3 })
    const q = moveClip(layered(), "o2", 1, { start: 3.5 }) // o1 1-3, o2 3.5-5.5
    expect(overlay(trimClip(q, "o2", "in", -2)).find((c) => c.id === "o2")).toMatchObject({ in: 0, out: 2.5, start: 3 })
  })

  it("stops the right edge at the next clip and the source end", () => {
    expect(overlay(trimClip(layered(), "o1", "out", 99))[0]).toMatchObject({ in: 4, out: 8, start: 1 })
    expect(overlay(trimClip(layered(), "o2", "out", 9999))[1]).toMatchObject({ out: MAX_IMAGE, start: 5 })
    expect(overlay(trimClip(layered(), "o1", "out", 0))[0].out).toBeCloseTo(4 + MIN_CLIP)
  })

  it("trims an overlay image's left edge by moving its start", () => {
    expect(overlay(trimClip(layered(), "o2", "in", 1))[1]).toMatchObject({ in: 0, out: 1, start: 6 })
    expect(overlay(trimClip(layered(), "o2", "in", -9))[1]).toMatchObject({ in: 0, out: 4, start: 3 })
  })

  it("does not ripple the rest of the track", () => {
    expect(overlay(trimClip(layered(), "o1", "out", 4.5))[1].start).toBe(5)
  })
})

describe("splitClip and removeClip on overlay tracks", () => {
  it("splits at the timeline time, the second part starting there", () => {
    const p = splitClip(layered(), "o1", 2, "s")
    expect(overlay(p).map((c) => [c.id, c.in, c.out, c.start])).toEqual([["o1", 4, 5, 1], ["s", 5, 6, 2], ["o2", 0, 2, 5]])
    const q = splitClip(layered(), "o2", 5.5, "s")
    expect(overlay(q).slice(1).map((c) => [c.id, c.in, c.out, c.start])).toEqual([["o2", 0, 0.5, 5], ["s", 0, 1.5, 5.5]])
  })

  it("does not split outside the clip or within MIN_CLIP of an edge", () => {
    const p = layered()
    expect(splitClip(p, "o1", 0.5, "s")).toBe(p)
    expect(splitClip(p, "o1", 1.1, "s")).toBe(p)
  })

  it("leaves a gap when an overlay clip is removed", () => {
    expect(overlay(removeClip(layered(), "o1"))).toEqual([{ id: "o2", asset: "i", in: 0, out: 2, start: 5 }])
  })
})

describe("tracks", () => {
  it("addTrack adds an empty layer on top with a free id, up to MAX_TRACKS", () => {
    const p = addTrack(layered())
    expect(p.tracks.map((t) => t.id)).toEqual(["t1", "t2", "t3"])
    expect(p.tracks[2]).toEqual({ id: "t3", clips: [] })
    const odd = addTrack({ ...layered(), tracks: [{ id: "t3", clips: [] }] })
    expect(odd.tracks.map((t) => t.id)).toEqual(["t3", "t1"])
    const full = addTrack(addTrack(layered()))
    expect(full.tracks).toHaveLength(MAX_TRACKS)
    expect(addTrack(full)).toBe(full)
  })

  it("removeTrack only removes an empty overlay track", () => {
    const p = addTrack(layered())
    expect(removeTrack(p, "t3").tracks.map((t) => t.id)).toEqual(["t1", "t2"])
    expect(removeTrack(p, "t2")).toBe(p)
    const empty = newProject("x")
    expect(removeTrack(empty, "t1")).toBe(empty)
    expect(removeTrack(p, "nope")).toBe(p)
  })

  it("setTrackMuted toggles mute and leaves the rest alone", () => {
    const src = layered()
    const p = setTrackMuted(src, "t2", true)
    expect(p.tracks[1].muted).toBe(true)
    expect(p.tracks[0]).toBe(src.tracks[0])
    expect(setTrackMuted(p, "t2", false).tracks[1]).not.toHaveProperty("muted")
    expect(setTrackMuted(p, "t2", true)).toBe(p)
    expect(setTrackMuted(p, "nope", true)).toBe(p)
  })
})

describe("the 6 hour timeline limit", () => {
  const long = (): Project => ({
    ...layered(),
    assets: { ...layered().assets, h: { file: "h.mp4", duration: 4 * 3600, hasAudio: true } },
  })

  it("parseProject rejects an overlay clip that ends past 6 hours, and mergeClientProject with it", () => {
    const p = layered()
    const forged = { ...p, tracks: [p.tracks[0], { id: "t2", clips: [{ id: "o1", asset: "a", in: 0, out: 2, start: 1e5 }] }] }
    expect(parseProject(forged)).toBeNull()
    expect(mergeClientProject(forged, p)).toBeNull()
    const edge = { ...p, tracks: [p.tracks[0], { id: "t2", clips: [{ id: "o1", asset: "a", in: 0, out: 2, start: MAX_TIMELINE - 2 }] }] }
    expect(parseProject(edge)).not.toBeNull()
  })

  it("parseProject rejects a base track longer than 6 hours", () => {
    const p = long()
    const clips = [{ id: "b1", asset: "h", in: 0, out: 4 * 3600 }, { id: "b2", asset: "h", in: 0, out: 2 * 3600 + 1 }]
    expect(parseProject({ ...p, tracks: [{ id: "t1", clips }] })).toBeNull()
    expect(parseProject({ ...p, tracks: [{ id: "t1", clips: [clips[0], { ...clips[1], out: 2 * 3600 }] }] })).not.toBeNull()
  })

  it("resolveStart keeps a clip inside the limit", () => {
    expect(resolveStart([], 10, 1e5)).toBe(MAX_TIMELINE - 10)
  })

  it("addClip and moveClip put an overlay clip no later than the limit allows, and refuse when it can't fit", () => {
    expect(overlay(addClip(layered(), "a", 1, { start: 1e5 }, "n")).find((c) => c.id === "n")?.start).toBe(MAX_TIMELINE - 10)
    expect(overlay(moveClip(layered(), "o1", 1, { start: 1e5 })).find((c) => c.id === "o1")?.start).toBe(MAX_TIMELINE - 2)
    const p = { ...layered(), tracks: [layered().tracks[0], { id: "t2", clips: [{ id: "z", asset: "a", in: 0, out: 5, start: MAX_TIMELINE - 5 }] }] }
    expect(addClip(p, "a", 1, { start: MAX_TIMELINE - 6 }, "n")).toBe(p)
  })

  it("addClip refuses a base clip that would take the base past the limit", () => {
    const p = { ...long(), tracks: [{ id: "t1", clips: [{ id: "b1", asset: "h", in: 0, out: 4 * 3600 }] }] }
    expect(addClip(p, "h", 0, {}, "n")).toBe(p)
    expect(base(addClip(p, "a", 0, {}, "n"))).toHaveLength(2)
  })

  it("trimClip stops an edge at the limit", () => {
    const p = { ...long(), tracks: [{ id: "t1", clips: [{ id: "b1", asset: "h", in: 0, out: 3 * 3600 }, { id: "b2", asset: "h", in: 3600, out: 4 * 3600 }] }] }
    expect(base(trimClip(p, "b1", "out", 4 * 3600))[0].out).toBe(3 * 3600)
    expect(base(trimClip(p, "b2", "in", 0))[1].in).toBe(3600)
    const q = { ...long(), tracks: [p.tracks[0], { id: "t2", clips: [{ id: "o", asset: "h", in: 0, out: 10, start: MAX_TIMELINE - 20 }] }] }
    expect(overlay(trimClip(q, "o", "out", 100))[0].out).toBe(20)
  })
})
