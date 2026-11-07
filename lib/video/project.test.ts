import { describe, expect, it } from "vitest"
import {
  addClip, assetKind, clipAt, clipStarts, DEFAULT_IMAGE, findAssetsBySource, MAX_IMAGE, mergeClientProject, MIN_CLIP, moveClip, newProject, parseProject, removeClip,
  splitClip, totalLength, trimClip, type Project,
} from "./project"

function sample(): Project {
  return {
    ...newProject("demo"),
    assets: { a: { file: "a.mp4", duration: 10, hasAudio: true } },
    clips: [
      { id: "c1", asset: "a", in: 0, out: 3 },
      { id: "c2", asset: "a", in: 2, out: 4 },
    ],
  }
}

describe("newProject", () => {
  it("defaults to 1920x1080 at 30fps", () => {
    const p = newProject("x")
    expect([p.width, p.height, p.fps]).toEqual([1920, 1080, 30])
    expect(p.version).toBe(1)
    expect(p.clips).toEqual([])
  })
})

describe("clipStarts and totalLength", () => {
  it("lays clips end to end", () => {
    const p = sample()
    expect(clipStarts(p.clips)).toEqual([0, 3])
    expect(totalLength(p.clips)).toBe(5)
  })
})

describe("addClip", () => {
  it("inserts at the index with the full asset length", () => {
    const p = addClip(sample(), "a", 1, "n")
    expect(p.clips.map((c) => c.id)).toEqual(["c1", "n", "c2"])
    expect(p.clips[1]).toEqual({ id: "n", asset: "a", in: 0, out: 10 })
  })

  it("does nothing for an asset shorter than MIN_CLIP", () => {
    const p = { ...sample(), assets: { ...sample().assets, z: { file: "z.mp4", duration: MIN_CLIP / 2, hasAudio: false } } }
    expect(addClip(p, "z", 0, "n")).toBe(p)
  })
})

describe("trimClip", () => {
  it("clamps in to out - MIN_CLIP", () => {
    const p = trimClip(sample(), "c1", "in", 5)
    expect(p.clips[0].in).toBeCloseTo(3 - MIN_CLIP)
  })

  it("clamps out to the asset duration", () => {
    expect(trimClip(sample(), "c1", "out", 99).clips[0].out).toBe(10)
  })

  it("clamps negative seconds to 0", () => {
    expect(trimClip(sample(), "c2", "in", -4).clips[1].in).toBe(0)
  })

  it("clamps out to in + MIN_CLIP", () => {
    expect(trimClip(sample(), "c2", "out", 0).clips[1].out).toBeCloseTo(2 + MIN_CLIP)
  })
})

describe("splitClip", () => {
  it("splits at the timeline time", () => {
    const p = splitClip(sample(), "c1", 1, "s")
    expect(p.clips.map((c) => [c.id, c.in, c.out])).toEqual([["c1", 0, 1], ["s", 1, 3], ["c2", 2, 4]])
  })

  it("uses the clip's offset on the timeline", () => {
    const p = splitClip(sample(), "c2", 4, "s")
    expect(p.clips[1]).toMatchObject({ id: "c2", in: 2, out: 3 })
    expect(p.clips[2]).toMatchObject({ id: "s", in: 3, out: 4 })
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
      expect(p.clips).toHaveLength(3)
      for (const c of p.clips) expect(c.out - c.in).toBeGreaterThanOrEqual(MIN_CLIP - 1e-9)
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
        const c = trimClip(sample(), "c1", edge, s).clips[0]
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
      clips: [{ id: "c1", asset: "s", in: 0, out: 0.1 }],
    }
    for (const edge of ["in", "out"] as const) {
      for (const s of [-1, 0, 0.05, 0.1, 5]) expect(trimClip(p, "c1", edge, s)).toBe(p)
    }
  })

  it("still allows a trim to exactly MIN_CLIP despite float rounding", () => {
    const p: Project = { ...newProject("f"), assets: { a: { file: "a.mp4", duration: 10, hasAudio: true } }, clips: [{ id: "c1", asset: "a", in: 0.7, out: 5 }] }
    expect(trimClip(p, "c1", "out", 0).clips[0].out).toBeCloseTo(0.7 + MIN_CLIP)
  })
})

describe("addClip duplicate id", () => {
  it("is a no-op when the id is already used", () => {
    const p = sample()
    expect(addClip(p, "a", 0, "c1")).toBe(p)
  })
})

describe("moveClip", () => {
  it("moves a clip to the end", () => {
    expect(moveClip(sample(), "c1", 1).clips.map((c) => c.id)).toEqual(["c2", "c1"])
  })
})

describe("removeClip", () => {
  it("drops the clip", () => {
    expect(removeClip(sample(), "c1").clips.map((c) => c.id)).toEqual(["c2"])
  })
})

describe("purity", () => {
  it("does not mutate its input", () => {
    const p = sample()
    const copy = JSON.parse(JSON.stringify(p))
    trimClip(p, "c1", "out", 1)
    splitClip(p, "c1", 1, "s")
    moveClip(p, "c1", 1)
    removeClip(p, "c1")
    addClip(p, "a", 0, "n")
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

  it("rejects the wrong version", () => {
    expect(parseProject({ version: 2 })).toBeNull()
  })

  it("rejects non-objects", () => {
    expect(parseProject(null)).toBeNull()
    expect(parseProject("x")).toBeNull()
  })

  it("rejects clips referencing an unknown asset", () => {
    const p = sample()
    p.clips.push({ id: "c3", asset: "missing", in: 0, out: 1 })
    expect(parseProject(p)).toBeNull()
  })

  it("rejects malformed clips", () => {
    const p = { ...sample(), clips: [{ id: "c1", asset: "a", in: "0", out: 3 }] }
    expect(parseProject(p)).toBeNull()
  })

  it("rejects duplicate clip ids", () => {
    const p = sample()
    p.clips[1].id = "c1"
    expect(parseProject(p)).toBeNull()
  })

  it("rejects out-of-range clips", () => {
    for (const [i, o] of [[-1, 3], [3, 3], [4, 3], [0, 11]]) {
      const p = sample()
      p.clips[0] = { id: "c1", asset: "a", in: i, out: o }
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

describe("mergeClientProject", () => {
  const stored: Project = {
    ...newProject("P"),
    assets: { a1: { file: "one.mp4", duration: 10, hasAudio: true } },
  }

  it("ignores client-supplied assets", () => {
    const client = {
      ...stored,
      assets: { a1: { file: "../../evil.mp4", duration: 10, hasAudio: true }, a2: { file: "x.mp4", duration: 5, hasAudio: false } },
      clips: [{ id: "c1", asset: "a1", in: 0, out: 5 }],
    }
    const merged = mergeClientProject(client, stored)
    expect(merged?.assets).toEqual(stored.assets)
    expect(merged?.clips).toHaveLength(1)
  })

  it("rejects a clip whose asset isn't stored", () => {
    const client = {
      ...stored,
      assets: { a2: { file: "x.mp4", duration: 5, hasAudio: false } },
      clips: [{ id: "c1", asset: "a2", in: 0, out: 5 }],
    }
    expect(mergeClientProject(client, stored)).toBeNull()
  })

  it("keeps the stored name and settings (a stale tab can't revert a rename)", () => {
    const client = { ...stored, name: "Stale", width: 1280, height: 720, fps: 25, clips: [{ id: "c1", asset: "a1", in: 0, out: 5 }] }
    const merged = mergeClientProject(client, stored)
    expect(merged && [merged.name, merged.width, merged.height, merged.fps]).toEqual(["P", 1920, 1080, 30])
    expect(merged?.clips).toHaveLength(1)
  })

  it("rejects a clip beyond the stored asset's duration", () => {
    const client = { ...stored, clips: [{ id: "c1", asset: "a1", in: 0, out: 50 }] }
    expect(mergeClientProject(client, stored)).toBeNull()
  })
})

function withImage(): Project {
  return {
    ...newProject("img"),
    assets: {
      a: { file: "a.mp4", duration: 10, hasAudio: true },
      i: { file: "i.jpg", duration: DEFAULT_IMAGE, hasAudio: false, kind: "image", source: "mike/i.jpg" },
    },
    clips: [
      { id: "c1", asset: "a", in: 0, out: 3 },
      { id: "p", asset: "i", in: 0, out: 4 },
    ],
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
    expect(addClip(p, "i", 0, "n").clips[0]).toEqual({ id: "n", asset: "i", in: 0, out: DEFAULT_IMAGE })
  })

  it("trims the out edge to the new length, with in staying 0", () => {
    expect(trimClip(withImage(), "p", "out", 7).clips[1]).toMatchObject({ in: 0, out: 7 })
    // An image has no source length to run out of.
    expect(trimClip(withImage(), "p", "out", 300).clips[1]).toMatchObject({ in: 0, out: 300 })
  })

  it("trims the in edge by shortening or lengthening the clip, with in staying 0", () => {
    expect(trimClip(withImage(), "p", "in", 1.5).clips[1]).toMatchObject({ in: 0, out: 2.5 })
    expect(trimClip(withImage(), "p", "in", -2).clips[1]).toMatchObject({ in: 0, out: 6 })
  })

  it("clamps image lengths to MIN_CLIP..MAX_IMAGE", () => {
    expect(trimClip(withImage(), "p", "out", 0).clips[1].out).toBe(MIN_CLIP)
    expect(trimClip(withImage(), "p", "out", MAX_IMAGE + 50).clips[1].out).toBe(MAX_IMAGE)
    expect(trimClip(withImage(), "p", "in", 10).clips[1].out).toBe(MIN_CLIP)
    expect(trimClip(withImage(), "p", "in", -MAX_IMAGE).clips[1].out).toBe(MAX_IMAGE)
    expect(trimClip(withImage(), "p", "out", Infinity).clips[1].out).toBe(MAX_IMAGE)
    expect(trimClip(withImage(), "p", "out", -Infinity).clips[1].out).toBe(MIN_CLIP)
    expect(trimClip(withImage(), "p", "in", Infinity).clips[1].out).toBe(MIN_CLIP)
    expect(trimClip(withImage(), "p", "in", -Infinity).clips[1].out).toBe(MAX_IMAGE)
    for (const edge of ["in", "out"] as const) expect(trimClip(withImage(), "p", edge, 3).clips[1].in).toBe(0)
  })

  it("ignores NaN on an image clip", () => {
    const p = withImage()
    expect(trimClip(p, "p", "in", NaN)).toBe(p)
    expect(trimClip(p, "p", "out", NaN)).toBe(p)
  })

  it("splits an image clip into two image clips that both start at 0", () => {
    const p = splitClip(withImage(), "p", 4, "s")
    expect(p.clips.map((c) => [c.id, c.in, c.out])).toEqual([["c1", 0, 3], ["p", 0, 1], ["s", 0, 3]])
  })

  it("does not split an image clip within MIN_CLIP of an edge", () => {
    const p = withImage()
    expect(splitClip(p, "p", 3.1, "s")).toBe(p)
    expect(splitClip(p, "p", 6.9, "s")).toBe(p)
  })

  it("clipAt gives the time inside an image clip", () => {
    expect(clipAt(withImage().clips, 4.5)).toEqual({ index: 1, sourceTime: 1.5 })
    expect(clipAt(withImage().clips, 7)).toBeNull()
  })
})

describe("parseProject with images", () => {
  it("round-trips kind and source", () => {
    const p = withImage()
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  it("accepts an image clip longer than the asset's duration, up to MAX_IMAGE", () => {
    const p = withImage()
    p.clips[1] = { id: "p", asset: "i", in: 0, out: MAX_IMAGE }
    expect(parseProject(p)).not.toBeNull()
  })

  it("rejects image clips that don't start at 0 or are out of range", () => {
    for (const [i, o] of [[1, 3], [0, MIN_CLIP / 2], [0, MAX_IMAGE + 1], [0, 0]]) {
      const p = withImage()
      p.clips[1] = { id: "p", asset: "i", in: i, out: o }
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
    const client = { ...stored, assets: { ...stored.assets, x: { file: "x.jpg", duration: 5, hasAudio: false, kind: "image" } }, clips: [{ id: "p", asset: "i", in: 0, out: 60 }] }
    const merged = mergeClientProject(client, stored)
    expect(merged?.assets).toEqual(stored.assets)
    expect(merged?.clips).toEqual([{ id: "p", asset: "i", in: 0, out: 60 }])
    // A client can't stretch a video past its length by calling it an image.
    const spoof = { ...stored, assets: { ...stored.assets, a: { ...stored.assets.a, kind: "image" } }, clips: [{ id: "c1", asset: "a", in: 0, out: 60 }] }
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
