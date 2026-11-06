import { describe, expect, it } from "vitest"
import { addClip, mergeClientProject, clipStarts, MIN_CLIP, moveClip, newProject, parseProject, removeClip, splitClip, totalLength, trimClip, type Project } from "./project"

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

  it("rejects a clip beyond the stored asset's duration", () => {
    const client = { ...stored, clips: [{ id: "c1", asset: "a1", in: 0, out: 50 }] }
    expect(mergeClientProject(client, stored)).toBeNull()
  })
})
