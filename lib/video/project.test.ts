import { describe, expect, it } from "vitest"
import {
  addClip, addTrack, allClips, assetKind, baseInsertion, clipsAt, DEFAULT_IMAGE, endToEnd, findAssetsBySource, freeTrackFor, isContiguousFromZero, leftTrimDraft, MAX_CLIPS, MAX_IMAGE, MAX_TIMELINE,
  MAX_TRACKS, mergeClientProject, MIN_CLIP, moveClip, newProject, packBase, parseProject, removeAsset, removeClip, removeTrack, resolveStart, setBaseMagnetic, setClipMuted, setTransform,
  splitClip, totalLength, trackClipAt, trackEnd, trackStarts, trimClip, type Clip, type Edit, type Project,
} from "./project"
import { commit, createHistory, undo } from "./history"
import { IDENTITY, type Transform } from "./transform"

function sample(): Project {
  return {
    ...newProject("demo"),
    assets: { a: { file: "a.mp4", duration: 10, hasAudio: true } },
    tracks: [{
      id: "t1",
      clips: [
        { id: "c1", asset: "a", in: 0, out: 3, start: 0 },
        { id: "c2", asset: "a", in: 2, out: 4, start: 3 },
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
    expect(p.version).toBe(3)
    expect(p.tracks).toEqual([{ id: "t1", clips: [] }])
  })
})

describe("trackStarts, trackEnd and totalLength", () => {
  it("reads each clip's start and the latest end", () => {
    const p = sample()
    expect(trackStarts(p.tracks[0])).toEqual([0, 3])
    expect(trackEnd(p.tracks[0])).toBe(5)
    expect(totalLength(p)).toBe(5)
  })

  it("counts a gap before or between base clips", () => {
    const p = { ...sample(), tracks: [{ id: "t1", clips: [{ ...base(sample())[0], start: 2 }, { ...base(sample())[1], start: 9 }] }] }
    expect(totalLength(p)).toBe(11)
    expect(trackEnd({ id: "x", clips: [] })).toBe(0)
  })
})

describe("endToEnd and isContiguousFromZero", () => {
  it("lays clips end to end from 0, replacing any start", () => {
    expect(endToEnd([{ id: "a", asset: "a", in: 1, out: 3 }, { id: "b", asset: "a", in: 0, out: 1.5, start: 9 } as Clip]).map((c) => c.start)).toEqual([0, 2])
  })

  it("is true for clips back to back from 0 (or none), false with a gap", () => {
    expect(isContiguousFromZero(base(sample()))).toBe(true)
    expect(isContiguousFromZero([])).toBe(true)
    expect(isContiguousFromZero([{ ...base(sample())[0], start: 0.5 }])).toBe(false)
    expect(isContiguousFromZero([base(sample())[0], { ...base(sample())[1], start: 3.5 }])).toBe(false)
  })
})

describe("addClip", () => {
  it("places the clip at its start with the full asset length, sliding past overlaps; nothing ripples", () => {
    const p = addClip(sample(), "a", 0, { start: 1 }, "n")
    expect(base(p).map((c) => [c.id, c.start])).toEqual([["c1", 0], ["c2", 3], ["n", 5]])
    expect(base(p)[2]).toEqual({ id: "n", asset: "a", in: 0, out: 10, start: 5 })
  })

  it("leaves a gap on the base track when placed past the end", () => {
    const p = addClip(sample(), "a", 0, { start: 8 }, "n")
    expect(base(p).map((c) => [c.id, c.start])).toEqual([["c1", 0], ["c2", 3], ["n", 8]])
    expect(totalLength(p)).toBe(18)
  })

  it("fits in a gap before the first base clip", () => {
    const src = { ...sample(), assets: { ...sample().assets, s: { file: "s.mp4", duration: 1, hasAudio: false } } }
    const gapped = { ...src, tracks: [{ id: "t1", clips: base(src).map((c) => ({ ...c, start: c.start + 2 })) }] }
    expect(base(addClip(gapped, "s", 0, { start: 0.5 }, "n"))[0]).toMatchObject({ id: "n", start: 0.5 })
  })

  it("does nothing for an asset shorter than MIN_CLIP", () => {
    const p = { ...sample(), assets: { ...sample().assets, z: { file: "z.mp4", duration: MIN_CLIP / 2, hasAudio: false } } }
    expect(addClip(p, "z", 0, { start: 0 }, "n")).toBe(p)
  })
})

describe("trimClip", () => {
  it("clamps in to out - MIN_CLIP, moving the start with it", () => {
    const p = trimClip(sample(), "c1", "in", 5)
    expect(base(p)[0].in).toBeCloseTo(3 - MIN_CLIP)
    expect(base(p)[0].start).toBeCloseTo(3 - MIN_CLIP)
    expect(base(p)[1].start).toBe(3)
  })

  it("clamps out to the asset duration, and to the next clip", () => {
    expect(base(trimClip(sample(), "c2", "out", 99))[1].out).toBe(10)
    expect(base(trimClip(sample(), "c1", "out", 99))[0].out).toBe(3)
  })

  it("clamps negative seconds to 0, and stops at the previous clip", () => {
    expect(base(trimClip(sample(), "c1", "in", -4))[0]).toMatchObject({ in: 0, start: 0 })
    expect(base(trimClip(sample(), "c2", "in", -4))[1]).toMatchObject({ in: 2, start: 3 })
  })

  it("un-trims the left edge into a gap before it, nothing else moving", () => {
    const p = { ...sample(), tracks: [{ id: "t1", clips: [base(sample())[0], { ...base(sample())[1], start: 4 }] }] }
    const q = trimClip(p, "c2", "in", 0)
    expect(base(q)[1]).toMatchObject({ in: 1, out: 4, start: 3 })
    expect(base(q)[0]).toBe(base(p)[0])
  })

  it("shortening a base clip leaves a gap instead of rippling", () => {
    expect(base(trimClip(sample(), "c1", "out", 1))[1].start).toBe(3)
  })

  it("clamps out to in + MIN_CLIP", () => {
    expect(base(trimClip(sample(), "c2", "out", 0))[1].out).toBeCloseTo(2 + MIN_CLIP)
  })
})

describe("splitClip", () => {
  it("splits at the timeline time, the second part starting there", () => {
    const p = splitClip(sample(), "c1", 1, "s")
    expect(base(p).map((c) => [c.id, c.in, c.out, c.start])).toEqual([["c1", 0, 1, 0], ["s", 1, 3, 1], ["c2", 2, 4, 3]])
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
      tracks: [{ id: "t1", clips: [{ id: "c1", asset: "s", in: 0, out: 0.1, start: 0 }] }],
    }
    for (const edge of ["in", "out"] as const) {
      for (const s of [-1, 0, 0.05, 0.1, 5]) expect(trimClip(p, "c1", edge, s)).toBe(p)
    }
  })

  it("still allows a trim to exactly MIN_CLIP despite float rounding", () => {
    const p: Project = { ...newProject("f"), assets: { a: { file: "a.mp4", duration: 10, hasAudio: true } }, tracks: [{ id: "t1", clips: [{ id: "c1", asset: "a", in: 0.7, out: 5, start: 0 }] }] }
    expect(base(trimClip(p, "c1", "out", 0))[0].out).toBeCloseTo(0.7 + MIN_CLIP)
  })
})

describe("addClip duplicate id", () => {
  it("is a no-op when the id is already used", () => {
    const p = sample()
    expect(addClip(p, "a", 0, { start: 0 }, "c1")).toBe(p)
  })
})

describe("moveClip", () => {
  it("moves a base clip past the end, leaving a gap where it was", () => {
    const p = moveClip(sample(), "c1", 0, { start: 6 })
    expect(base(p).map((c) => [c.id, c.start])).toEqual([["c2", 3], ["c1", 6]])
  })

  it("slides clear of a clip it would overlap, and stays put without a start", () => {
    expect(base(moveClip(sample(), "c1", 0, { start: 4 })).map((c) => [c.id, c.start])).toEqual([["c2", 3], ["c1", 5]])
    const p = sample()
    expect(base(moveClip(p, "c2", 0, {}))).toEqual(base(p))
  })
})

describe("removeClip", () => {
  it("drops the clip and leaves a gap on the base track", () => {
    expect(base(removeClip(sample(), "c1"))).toEqual([{ id: "c2", asset: "a", in: 2, out: 4, start: 3 }])
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
    moveClip(p, "c1", 0, { start: 9 })
    moveClip(p, "c1", 1, { start: 9 })
    removeClip(p, "c1")
    removeClip(p, "o1")
    removeAsset(p, "a")
    addClip(p, "a", 0, { start: 0 }, "n")
    addClip(p, "a", 1, { start: 1 }, "n")
    addTrack(p)
    removeTrack(p, "t2")
    setClipMuted(p, "o1", true)
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

  it("rejects an unknown version, or version 2 or 3 without tracks", () => {
    expect(parseProject({ ...sample(), version: 4 })).toBeNull()
    expect(parseProject({ version: 2 })).toBeNull()
    expect(parseProject({ version: 3 })).toBeNull()
  })

  it("rejects non-objects", () => {
    expect(parseProject(null)).toBeNull()
    expect(parseProject("x")).toBeNull()
  })

  it("rejects clips referencing an unknown asset", () => {
    const p = sample()
    base(p).push({ id: "c3", asset: "missing", in: 0, out: 1, start: 5 })
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
      base(p)[0] = { id: "c1", asset: "a", in: i, out: o, start: 0 }
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

  it("migrates flat clips to one base track, end to end from 0, and returns version 3", () => {
    const p = parseProject(v1())
    expect(p?.version).toBe(3)
    expect(p?.tracks).toEqual([{ id: "t1", clips: [{ ...v1().clips[0], start: 0 }, { ...v1().clips[1], start: 3 }] }])
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
      { id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 3, start: 0 }, { id: "c2", asset: "a", in: 2, out: 4, start: 3 }] },
      { id: "t2", clips: [{ id: "o1", asset: "a", in: 4, out: 6, start: 1 }, { id: "o2", asset: "i", in: 0, out: 2, start: 5 }] },
    ],
  }
}
const overlay = (p: Project, i = 1) => p.tracks[i].clips

describe("parseProject: tracks", () => {
  it("round-trips tracks, overlay starts and clip mute", () => {
    const p = layered()
    p.tracks[1].clips[0].muted = true
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  it("drops muted: false on a track and on a clip", () => {
    const p = layered()
    const parsed = parseProject({ ...p, tracks: [{ ...p.tracks[0], muted: false, clips: [{ ...base(p)[0], muted: false }, base(p)[1]] }, p.tracks[1]] })
    expect(parsed?.tracks[0]).toEqual({ id: "t1", clips: base(p) })
  })

  it("reads an older track mute as a mute on every clip of that track", () => {
    const p = layered()
    const parsed = parseProject({ ...p, tracks: [p.tracks[0], { ...p.tracks[1], muted: true }] })
    expect(parsed?.tracks[1]).toEqual({ id: "t2", clips: overlay(p).map((c) => ({ ...c, muted: true })) })
    expect(parsed?.tracks[0]).toEqual(p.tracks[0])
  })

  it("rejects a clip muted that isn't a boolean", () => {
    const p = layered()
    expect(parseProject({ ...p, tracks: [p.tracks[0], { id: "t2", clips: [{ ...overlay(p)[0], muted: 1 }] }] })).toBeNull()
  })

  it("sorts every track by start and keeps gaps on the base", () => {
    const p = layered()
    const gapped = [{ ...base(p)[1], start: 8 }, { ...base(p)[0], start: 2 }]
    const parsed = parseProject({ ...p, tracks: [{ id: "t1", clips: gapped }, { id: "t2", clips: [...overlay(p)].reverse() }] })
    expect(parsed && overlay(parsed).map((c) => c.id)).toEqual(["o1", "o2"])
    expect(parsed && base(parsed).map((c) => [c.id, c.start])).toEqual([["c1", 2], ["c2", 8]])
  })

  it("requires a finite, non-negative start on every clip, base track included", () => {
    for (const start of [undefined, -1, Infinity, NaN, "1"]) {
      const p = layered()
      const bad = { ...p, tracks: [p.tracks[0], { id: "t2", clips: [{ ...overlay(p)[0], start }] }] }
      expect(parseProject(bad)).toBeNull()
      const badBase = { ...p, tracks: [{ id: "t1", clips: [{ ...base(p)[0], start }] }, p.tracks[1]] }
      expect(parseProject(badBase)).toBeNull()
    }
  })

  it("rejects overlapping clips on any track, accepts touching ones", () => {
    const p = layered()
    const at = (s: number) => ({ ...p, tracks: [p.tracks[0], { id: "t2", clips: [overlay(p)[0], { ...overlay(p)[1], start: s }] }] })
    expect(parseProject(at(2.9))).toBeNull()
    expect(parseProject(at(3))).not.toBeNull()
    const onBase = (s: number) => ({ ...p, tracks: [{ id: "t1", clips: [base(p)[0], { ...base(p)[1], start: s }] }, p.tracks[1]] })
    expect(parseProject(onBase(2.5))).toBeNull()
    expect(parseProject(onBase(3))).not.toBeNull()
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

describe("parseProject: version 2 files", () => {
  // A version 2 file: the base track end to end with no starts, overlays with starts.
  const v2 = () => ({
    version: 2, name: "v2", width: 1920, height: 1080, fps: 30,
    assets: layered().assets,
    tracks: [
      { id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 3 }, { id: "c2", asset: "a", in: 2, out: 4 }, { id: "c3", asset: "i", in: 0, out: 1.5 }] },
      { id: "t2", muted: true, clips: [{ id: "o1", asset: "a", in: 4, out: 6, start: 1 }] },
    ],
  })

  it("lays the base end to end from 0 (the layout it had), keeps overlay starts, and returns version 3", () => {
    const p = parseProject(v2())
    expect(p?.version).toBe(3)
    expect(p && base(p).map((c) => [c.id, c.start])).toEqual([["c1", 0], ["c2", 3], ["c3", 5]])
    expect(p && overlay(p)).toEqual([{ id: "o1", asset: "a", in: 4, out: 6, start: 1, muted: true }])
    expect(p?.tracks[1]).not.toHaveProperty("muted")
  })

  it("keeps the same timeline: length and the clip at every time", () => {
    const p = parseProject(v2())!
    expect(totalLength(p)).toBe(6.5)
    for (const t of [0, 1.5, 2.99, 3, 4.9, 5, 6.4, 6.5]) {
      const old = [[0, 3, "c1", 0], [3, 5, "c2", 2], [5, 6.5, "c3", 0]].find(([s, e]) => t >= (s as number) && t < (e as number))
      const hit = clipsAt(p, t).tracks[0]
      expect(hit && [hit.clip.id, hit.sourceTime]).toEqual(old ? [old[2], (old[3] as number) + t - (old[0] as number)] : null)
    }
  })

  it("ignores a start on a version 2 base clip, as version 2 did", () => {
    const raw = v2()
    raw.tracks[0].clips[1] = { ...raw.tracks[0].clips[1], start: 40 } as (typeof raw.tracks)[0]["clips"][number]
    expect(parseProject(raw) && base(parseProject(raw)!)[1].start).toBe(3)
  })

  it("parses back to the same project once written as version 3", () => {
    const p = parseProject(v2())!
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
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
      tracks: one([{ id: "c1", asset: "a1", in: 0, out: 5, start: 0 }]),
    }
    const merged = mergeClientProject(client, stored)
    expect(merged?.assets).toEqual(stored.assets)
    expect(merged && base(merged)).toHaveLength(1)
  })

  it("rejects a clip whose asset isn't stored", () => {
    const client = {
      ...stored,
      assets: { a2: { file: "x.mp4", duration: 5, hasAudio: false } },
      tracks: one([{ id: "c1", asset: "a2", in: 0, out: 5, start: 0 }]),
    }
    expect(mergeClientProject(client, stored)).toBeNull()
  })

  it("keeps the stored name and settings (a stale tab can't revert a rename)", () => {
    const client = { ...stored, name: "Stale", width: 1280, height: 720, fps: 25, tracks: one([{ id: "c1", asset: "a1", in: 0, out: 5, start: 0 }]) }
    const merged = mergeClientProject(client, stored)
    expect(merged && [merged.name, merged.width, merged.height, merged.fps]).toEqual(["P", 1920, 1080, 30])
    expect(merged && base(merged)).toHaveLength(1)
  })

  it("rejects a clip beyond the stored asset's duration", () => {
    const client = { ...stored, tracks: one([{ id: "c1", asset: "a1", in: 0, out: 50, start: 0 }]) }
    expect(mergeClientProject(client, stored)).toBeNull()
  })

  it("takes the client's tracks, clip mute included", () => {
    const client = { ...stored, tracks: [{ id: "t1", clips: [] }, { id: "t9", clips: [{ id: "o", asset: "a1", in: 1, out: 2, start: 3, muted: true }] }] }
    expect(mergeClientProject(client, stored)?.tracks).toEqual(client.tracks)
  })

  it("strips a client's track mute instead of muting the track's clips", () => {
    const client = { ...stored, tracks: [{ id: "t1", clips: [] }, { id: "t9", muted: true, clips: [{ id: "o", asset: "a1", in: 1, out: 2, start: 3 }] }] }
    expect(mergeClientProject(client, stored)?.tracks[1]).toEqual({ id: "t9", clips: [{ id: "o", asset: "a1", in: 1, out: 2, start: 3 }] })
  })

  it("accepts a version 1 or 2 client and returns version 3", () => {
    const client = { ...stored, version: 1, tracks: undefined, clips: [{ id: "c1", asset: "a1", in: 0, out: 5 }] }
    const merged = mergeClientProject(client, stored)
    expect(merged?.version).toBe(3)
    expect(merged && base(merged)).toEqual([{ id: "c1", asset: "a1", in: 0, out: 5, start: 0 }])
    const v2 = { ...stored, version: 2, tracks: one([{ id: "c1", asset: "a1", in: 0, out: 5 }, { id: "c2", asset: "a1", in: 1, out: 2 }]) }
    expect(mergeClientProject(v2, stored)?.tracks[0].clips.map((c) => c.start)).toEqual([0, 5])
  })

  it("takes base clips with gaps, and rejects a base clip without a start, overlapping or past MAX_TIMELINE", () => {
    const merged = mergeClientProject({ ...stored, tracks: one([{ id: "c1", asset: "a1", in: 0, out: 5, start: 2 }, { id: "c2", asset: "a1", in: 0, out: 1, start: 9 }]) }, stored)
    expect(merged && base(merged).map((c) => c.start)).toEqual([2, 9])
    expect(mergeClientProject({ ...stored, tracks: one([{ id: "c1", asset: "a1", in: 0, out: 5 }]) }, stored)).toBeNull()
    expect(mergeClientProject({ ...stored, tracks: one([{ id: "c1", asset: "a1", in: 0, out: 5, start: 0 }, { id: "c2", asset: "a1", in: 0, out: 1, start: 4 }]) }, stored)).toBeNull()
    expect(mergeClientProject({ ...stored, tracks: one([{ id: "c1", asset: "a1", in: 0, out: 5, start: MAX_TIMELINE - 4 }]) }, stored)).toBeNull()
    expect(mergeClientProject({ ...stored, tracks: one([{ id: "c1", asset: "a1", in: 0, out: 5, start: MAX_TIMELINE - 5 }]) }, stored)).not.toBeNull()
  })

  it(`rejects more than ${MAX_CLIPS} clips in total, overlaps, too many tracks and bad starts`, () => {
    const clip = (id: string, start: number) => ({ id, asset: "a1", in: 0, out: 1, start })
    const half = MAX_CLIPS / 2
    const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => clip(`${prefix}${i}`, i))
    expect(mergeClientProject({ ...stored, tracks: [{ id: "t1", clips: many(half, "b") }, { id: "t2", clips: many(half, "o") }] }, stored)).not.toBeNull()
    expect(mergeClientProject({ ...stored, tracks: [{ id: "t1", clips: many(half, "b") }, { id: "t2", clips: many(half + 1, "o") }] }, stored)).toBeNull()
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
        { id: "c1", asset: "a", in: 0, out: 3, start: 0 },
        { id: "p", asset: "i", in: 0, out: 4, start: 3 },
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
    expect(base(addClip(p, "i", 0, { start: 0 }, "n")).find((c) => c.id === "n")).toEqual({ id: "n", asset: "i", in: 0, out: DEFAULT_IMAGE, start: 7 })
  })

  it("trims the out edge to the new length, with in staying 0", () => {
    expect(base(trimClip(withImage(), "p", "out", 7))[1]).toMatchObject({ in: 0, out: 7 })
    // An image has no source length to run out of.
    expect(base(trimClip(withImage(), "p", "out", 300))[1]).toMatchObject({ in: 0, out: 300 })
  })

  it("trims the in edge by shortening or lengthening the clip (moving its start), with in staying 0", () => {
    expect(base(trimClip(withImage(), "p", "in", 1.5))[1]).toMatchObject({ in: 0, out: 2.5, start: 4.5 })
    // Against the previous clip it can't grow left.
    expect(base(trimClip(withImage(), "p", "in", -2))[1]).toMatchObject({ in: 0, out: 4, start: 3 })
    const gap = { ...withImage(), tracks: [{ id: "t1", clips: [base(withImage())[0], { ...base(withImage())[1], start: 5 }] }] }
    expect(base(trimClip(gap, "p", "in", -1))[1]).toMatchObject({ in: 0, out: 5, start: 4 })
  })

  it("clamps image lengths to MIN_CLIP..MAX_IMAGE", () => {
    // The image alone, far enough along to grow left to MAX_IMAGE.
    const lone = { ...withImage(), tracks: [{ id: "t1", clips: [{ ...base(withImage())[1], start: 700 }] }] }
    const len = (edge: "in" | "out", s: number) => base(trimClip(lone, "p", edge, s))[0].out
    expect(len("out", 0)).toBe(MIN_CLIP)
    expect(len("out", MAX_IMAGE + 50)).toBe(MAX_IMAGE)
    expect(len("in", 10)).toBe(MIN_CLIP)
    expect(len("in", -MAX_IMAGE)).toBe(MAX_IMAGE)
    expect(len("out", Infinity)).toBe(MAX_IMAGE)
    expect(len("out", -Infinity)).toBe(MIN_CLIP)
    expect(len("in", Infinity)).toBe(MIN_CLIP)
    expect(len("in", -Infinity)).toBe(MAX_IMAGE)
    for (const edge of ["in", "out"] as const) expect(base(trimClip(lone, "p", edge, 3))[0].in).toBe(0)
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

  it("trackClipAt gives the time inside an image clip", () => {
    expect(trackClipAt(withImage().tracks[0], 4.5)).toEqual({ index: 1, start: 3, sourceTime: 1.5 })
    expect(trackClipAt(withImage().tracks[0], 7)).toBeNull()
  })
})

describe("parseProject with images", () => {
  it("round-trips kind and source", () => {
    const p = withImage()
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  it("accepts an image clip longer than the asset's duration, up to MAX_IMAGE", () => {
    const p = withImage()
    base(p)[1] = { id: "p", asset: "i", in: 0, out: MAX_IMAGE, start: 3 }
    expect(parseProject(p)).not.toBeNull()
  })

  it("rejects image clips that don't start at 0 or are out of range", () => {
    for (const [i, o] of [[1, 3], [0, MIN_CLIP / 2], [0, MAX_IMAGE + 1], [0, 0]]) {
      const p = withImage()
      base(p)[1] = { id: "p", asset: "i", in: i, out: o, start: 3 }
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
    const client = { ...stored, assets: { ...stored.assets, x: { file: "x.jpg", duration: 5, hasAudio: false, kind: "image" } }, tracks: [{ id: "t1", clips: [{ id: "p", asset: "i", in: 0, out: 60, start: 0 }] }] }
    const merged = mergeClientProject(client, stored)
    expect(merged?.assets).toEqual(stored.assets)
    expect(merged && base(merged)).toEqual([{ id: "p", asset: "i", in: 0, out: 60, start: 0 }])
    // A client can't stretch a video past its length by calling it an image.
    const spoof = { ...stored, assets: { ...stored.assets, a: { ...stored.assets.a, kind: "image" } }, tracks: [{ id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 60, start: 0 }] }] }
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

  it("reads every track's starts", () => {
    const p = layered()
    expect(trackStarts(p.tracks[0])).toEqual([0, 3])
    expect(trackStarts(p.tracks[1])).toEqual([1, 5])
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

  it("is null on the base track in a gap", () => {
    const p = layered()
    p.tracks[0].clips[1] = { ...p.tracks[0].clips[1], start: 4 }
    expect(clipsAt(p, 3.5).tracks[0]).toBeNull()
    expect(clipsAt(p, 4.5).tracks[0]).toMatchObject({ index: 1, sourceTime: 2.5 })
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
    expect(addClip(p, "a", 0, { start: 0 }, "o1")).toBe(p)
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

  it("moves an overlay clip onto the base at a start, sliding clear of base clips", () => {
    const p = moveClip(layered(), "o1", 0, { start: 7 })
    expect(base(p).map((c) => c.id)).toEqual(["c1", "c2", "o1"])
    expect(base(p)[2]).toEqual({ id: "o1", asset: "a", in: 4, out: 6, start: 7 })
    expect(overlay(p).map((c) => c.id)).toEqual(["o2"])
    expect(base(moveClip(layered(), "o1", 0, { start: 4 }))[2].start).toBe(5)
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
    expect(moveClip(p, "zz", 0, { start: 0 })).toBe(p)
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

  it("setClipMuted toggles one clip's mute and leaves the rest alone", () => {
    const src = layered()
    const p = setClipMuted(src, "o1", true)
    expect(overlay(p)[0].muted).toBe(true)
    expect(overlay(p)[1]).toBe(overlay(src)[1])
    expect(p.tracks[0]).toBe(src.tracks[0])
    expect(setClipMuted(p, "o1", false).tracks[1].clips[0]).toEqual(overlay(src)[0])
    expect(setClipMuted(p, "o1", false).tracks[1].clips[0]).not.toHaveProperty("muted")
    expect(setClipMuted(p, "o1", true)).toBe(p)
    expect(setClipMuted(src, "o1", false)).toBe(src)
    expect(setClipMuted(p, "nope", true)).toBe(p)
  })

  it("keeps a clip's mute through split (both halves), moves across tracks and trims, and undo takes it back", () => {
    const p = setClipMuted(layered(), "c1", true)
    const clip = (q: Project, id: string) => allClips(q).find((c) => c.id === id)
    const s = splitClip(p, "c1", 1, "n")
    expect([clip(s, "c1")?.muted, clip(s, "n")?.muted]).toEqual([true, true])
    expect(clip(splitClip(layered(), "c1", 1, "n"), "n")).not.toHaveProperty("muted")
    expect(clip(moveClip(p, "c1", 1, { start: 8 }), "c1")?.muted).toBe(true)
    expect(clip(moveClip(p, "c1", 2, { start: 0 }), "c1")?.muted).toBe(true)
    expect(clip(trimClip(p, "c1", "out", 2), "c1")?.muted).toBe(true)
    const h = commit(createHistory<Edit>({ tracks: layered().tracks }), { tracks: p.tracks })
    expect(clip({ ...p, ...undo(h).present }, "c1")).not.toHaveProperty("muted")
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

  it("parseProject rejects a version 2 base track longer than 6 hours, and a version 3 base clip ending past it", () => {
    const p = long()
    const clips = [{ id: "b1", asset: "h", in: 0, out: 4 * 3600 }, { id: "b2", asset: "h", in: 0, out: 2 * 3600 + 1 }]
    expect(parseProject({ ...p, version: 2, tracks: [{ id: "t1", clips }] })).toBeNull()
    expect(parseProject({ ...p, version: 2, tracks: [{ id: "t1", clips: [clips[0], { ...clips[1], out: 2 * 3600 }] }] })).not.toBeNull()
    expect(parseProject({ ...p, tracks: [{ id: "t1", clips: [{ ...clips[0], start: 2 * 3600 + 1 }] }] })).toBeNull()
    expect(parseProject({ ...p, tracks: [{ id: "t1", clips: [{ ...clips[0], start: 2 * 3600 }] }] })).not.toBeNull()
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

  it("addClip refuses a base clip that can't fit before the limit", () => {
    const p = { ...long(), tracks: [{ id: "t1", clips: [{ id: "b1", asset: "h", in: 0, out: 4 * 3600, start: 0 }] }] }
    expect(addClip(p, "h", 0, {}, "n")).toBe(p)
    expect(base(addClip(p, "a", 0, {}, "n"))).toHaveLength(2)
  })

  it("trimClip stops an edge at the limit", () => {
    const p = { ...long(), tracks: [{ id: "t1", clips: [{ id: "b1", asset: "h", in: 0, out: 3 * 3600, start: 0 }, { id: "b2", asset: "h", in: 3600, out: 4 * 3600, start: 3 * 3600 }] }] }
    expect(base(trimClip(p, "b1", "out", 4 * 3600))[0].out).toBe(3 * 3600)
    expect(base(trimClip(p, "b2", "in", 0))[1].in).toBe(3600)
    const q = { ...long(), tracks: [p.tracks[0], { id: "t2", clips: [{ id: "o", asset: "h", in: 0, out: 10, start: MAX_TIMELINE - 20 }] }] }
    expect(overlay(trimClip(q, "o", "out", 100))[0].out).toBe(20)
  })
})

describe("clip transforms", () => {
  const half: Transform = { x: 0.25, y: -0.1, scale: 0.5, cropTop: 0.1, cropBottom: 0.2 }
  const withTransform = (p: Project, id: string, t = half): Project =>
    ({ ...p, tracks: p.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === id ? { ...c, transform: t } : c)) })) })
  const clip = (p: Project, id: string) => allClips(p).find((c) => c.id === id)

  it("carries a rotation and flips through setTransform, split, move and a save round trip; zero and false are left out", () => {
    const turned: Transform = { ...half, rotation: -30, flipH: true }
    const q = setTransform(layered(), "o1", { ...turned, flipV: false })
    expect(clip(q, "o1")?.transform).toEqual(turned)
    expect(setTransform(q, "o1", turned)).toBe(q)
    expect(clip(setTransform(q, "o1", { ...turned, rotation: 0 }), "o1")?.transform).toEqual({ ...half, flipH: true })
    expect(clip(setTransform(q, "o1", { ...IDENTITY, rotation: 0, flipH: false }), "o1")?.transform).toBeUndefined()
    const s = splitClip(q, "o1", 2, "m")
    expect(clip(s, "m")?.transform).toEqual(turned)
    expect(clip(moveClip(q, "o1", 0, { start: 20 }), "o1")?.transform).toEqual(turned)
    expect(parseProject(JSON.parse(JSON.stringify(q)))).toEqual(q)
    const raw = JSON.parse(JSON.stringify(q))
    raw.tracks[1].clips[0].transform = { ...turned, rotation: 0, flipH: false, flipV: false }
    expect("rotation" in (clip(parseProject(raw)!, "o1")?.transform ?? {})).toBe(false)
    for (const bad of [{ rotation: 200 }, { rotation: "5" }, { flipH: "yes" }]) {
      raw.tracks[1].clips[0].transform = { ...half, ...bad }
      expect(parseProject(raw)).toBeNull()
    }
  })

  it("setTransform sets one clip's transform and nothing else", () => {
    const p = layered()
    const q = setTransform(p, "o1", half)
    expect(clip(q, "o1")?.transform).toEqual(half)
    expect(clip(q, "c1")?.transform).toBeUndefined()
    expect(q.tracks[0]).toBe(p.tracks[0])
    expect(clip(p, "o1")?.transform).toBeUndefined()
  })

  it("setTransform with the identity removes the field", () => {
    const q = setTransform(withTransform(layered(), "c1"), "c1", IDENTITY)
    expect(clip(q, "c1")).toEqual({ id: "c1", asset: "a", in: 0, out: 3, start: 0 })
    expect("transform" in (clip(q, "c1") ?? {})).toBe(false)
  })

  it("setTransform clamps, and returns the same project for an unknown clip or no change", () => {
    const p = layered()
    expect(clip(setTransform(p, "c1", { ...half, scale: 99 }), "c1")?.transform?.scale).toBe(5)
    expect(setTransform(p, "nope", half)).toBe(p)
    expect(setTransform(p, "c1", IDENTITY)).toBe(p)
    const q = withTransform(p, "c1")
    expect(setTransform(q, "c1", { ...half })).toBe(q)
  })

  it("splitClip gives both halves the transform", () => {
    const p = withTransform(withTransform(layered(), "c1"), "o1")
    const s = splitClip(p, "c1", 1, "n")
    expect(clip(s, "c1")?.transform).toEqual(half)
    expect(clip(s, "n")?.transform).toEqual(half)
    const o = splitClip(p, "o1", 2, "m")
    expect(clip(o, "m")?.transform).toEqual(half)
  })

  it("moveClip keeps it within and across tracks, trimClip keeps it", () => {
    const p = withTransform(layered(), "c1")
    expect(clip(moveClip(p, "c1", 1, { start: 8 }), "c1")?.transform).toEqual(half)
    expect(clip(moveClip(p, "c1", 0, { start: 9 }), "c1")?.transform).toEqual(half)
    expect(clip(moveClip(withTransform(layered(), "o1"), "o1", 0, { start: 9 }), "o1")?.transform).toEqual(half)
    expect(clip(trimClip(p, "c1", "out", 2), "c1")?.transform).toEqual(half)
  })

  it("parseProject round-trips a valid transform and drops an identity one", () => {
    const p = withTransform(withTransform(layered(), "o2"), "c2", IDENTITY)
    const parsed = parseProject(JSON.parse(JSON.stringify(p)))
    expect(clip(parsed!, "o2")?.transform).toEqual(half)
    expect(clip(parsed!, "c2")).toEqual({ id: "c2", asset: "a", in: 2, out: 4, start: 3 })
  })

  it("parseProject keeps a left and right crop, leaves out zero ones, and rejects bad ones", () => {
    const sides = { ...half, cropLeft: 0.2, cropRight: 0.3 }
    const parsed = parseProject(JSON.parse(JSON.stringify(withTransform(layered(), "o1", sides))))
    expect(clip(parsed!, "o1")?.transform).toEqual(sides)
    const zero = parseProject(JSON.parse(JSON.stringify(withTransform(layered(), "o1", { ...half, cropLeft: 0, cropRight: 0 }))))
    expect(clip(zero!, "o1")?.transform).toEqual(half)
    for (const bad of [{ ...half, cropLeft: -0.1 }, { ...half, cropRight: 0.95 }, { ...half, cropLeft: 0.5, cropRight: 0.5 }, { ...half, cropLeft: "0.1" }]) {
      expect(parseProject(JSON.parse(JSON.stringify(withTransform(layered(), "o1", bad as typeof half))))).toBeNull()
    }
  })

  it("setTransform keeps a left and right crop, and splitClip and moveClip carry it", () => {
    const sides = { ...half, cropLeft: 0.2, cropRight: 0.1 }
    const p = setTransform(layered(), "c1", sides)
    expect(clip(p, "c1")?.transform).toEqual(sides)
    expect(clip(splitClip(p, "c1", 1, "n"), "n")?.transform).toEqual(sides)
    expect(clip(moveClip(p, "c1", 1, { start: 8 }), "c1")?.transform).toEqual(sides)
    expect(setTransform(p, "c1", { ...sides })).toBe(p)
    expect(clip(setTransform(p, "c1", { ...sides, cropLeft: 0 }), "c1")?.transform).toEqual({ ...half, cropRight: 0.1 })
  })

  it("parseProject copies only the transform's own fields", () => {
    const parsed = parseProject(JSON.parse(JSON.stringify(withTransform(layered(), "c1", { ...half, extra: 1 } as typeof half))))
    expect(clip(parsed!, "c1")?.transform).toEqual(half)
  })

  it("parseProject and mergeClientProject reject an invalid transform instead of clamping it", () => {
    for (const bad of [{ ...half, scale: 6 }, { ...half, x: -3 }, { ...half, cropTop: 0.5, cropBottom: 0.5 }, { ...half, y: null }, "big", { ...half, cropBottom: -0.1 }]) {
      const p = JSON.parse(JSON.stringify(withTransform(layered(), "o1", bad as typeof half)))
      expect(parseProject(p)).toBeNull()
      expect(mergeClientProject(p, layered())).toBeNull()
    }
    const nan = withTransform(layered(), "o1", { ...half, x: NaN })
    expect(parseProject(nan)).toBeNull()
  })

  it("mergeClientProject keeps the client's transforms", () => {
    const merged = mergeClientProject(JSON.parse(JSON.stringify(withTransform(layered(), "c1"))), layered())
    expect(clip(merged!, "c1")?.transform).toEqual(half)
  })
})

describe("freeTrackFor", () => {
  it("gives the lowest track where the span is free, gaps on the base included", () => {
    const p = layered() // base 0-5; overlay 1-3 and 5-7
    expect(freeTrackFor(p, 5, 1)).toBe(0)
    expect(freeTrackFor(p, 3, 2)).toBe(1)
    expect(freeTrackFor(p, 4, 0.5)).toBe(1)
  })

  it("gives a new track's index when no track is free and there's room, else null", () => {
    const p = layered()
    expect(freeTrackFor(p, 2, 2)).toBe(2)
    expect(freeTrackFor(p, 2, 2, { max: 2 })).toBeNull()
    const full = addTrack(addTrack(p))
    expect(freeTrackFor(full, 2, 2)).toBe(2)
    const busy = { ...full, tracks: full.tracks.map((t, i) => (i < 2 ? t : { ...t, clips: [{ id: `x${i}`, asset: "a", in: 0, out: 9, start: 0 }] })) }
    expect(freeTrackFor(busy, 2, 2)).toBeNull()
  })

  it("leaves out a clip by id (the one being moved)", () => {
    expect(freeTrackFor(layered(), 0, 3, { ignore: "c1" })).toBe(0)
  })
})

describe("removeAsset", () => {
  it("removes the asset and every clip using it on every track, leaving gaps", () => {
    const src = layered()
    const { project, removedClips } = removeAsset(src, "a")
    expect(removedClips).toBe(3)
    expect(project.assets).toEqual({ i: src.assets.i })
    expect(base(project)).toEqual([])
    expect(overlay(project)).toEqual([{ id: "o2", asset: "i", in: 0, out: 2, start: 5 }])
    expect(project.tracks.map((t) => t.id)).toEqual(["t1", "t2"])
  })

  it("leaves other assets and tracks without its clips untouched", () => {
    const src = layered()
    const { project, removedClips } = removeAsset(src, "i")
    expect(removedClips).toBe(1)
    expect(project.assets.a).toBe(src.assets.a)
    expect(project.tracks[0]).toBe(src.tracks[0])
  })

  it("removes an unused asset with no clips, and is a no-op for an unknown id", () => {
    const src = { ...layered(), assets: { ...layered().assets, z: { file: "z.mp4", duration: 3, hasAudio: true } } }
    const r = removeAsset(src, "z")
    expect(r.removedClips).toBe(0)
    expect(Object.keys(r.project.assets)).toEqual(["a", "i"])
    const same = removeAsset(src, "nope")
    expect(same.project).toBe(src)
    expect(same.removedClips).toBe(0)
    expect(removeAsset(src, "__proto__").project).toBe(src)
  })
})

describe("magnetic base track (Snap)", () => {
  /** A base track with gaps: m1 [1, 3), m2 [5, 8) and an image m3 [10, 12); one overlay clip o1. */
  function gapped(): Project {
    return {
      ...newProject("snap"),
      assets: {
        a: { file: "a.mp4", duration: 10, hasAudio: true },
        i: { file: "i.jpg", duration: DEFAULT_IMAGE, hasAudio: false, kind: "image" },
      },
      tracks: [
        { id: "t1", clips: [{ id: "m1", asset: "a", in: 0, out: 2, start: 1 }, { id: "m2", asset: "a", in: 4, out: 7, start: 5 }, { id: "m3", asset: "i", in: 0, out: 2, start: 10 }] },
        { id: "t2", clips: [{ id: "o1", asset: "a", in: 0, out: 2, start: 4 }] },
      ],
    }
  }
  /** The same, snapped: m1 [0, 2), m2 [2, 5), m3 [5, 7). */
  const packed = () => setBaseMagnetic(gapped(), true)
  const order = (p: Project) => base(p).map((c) => c.id)
  const starts = (p: Project) => base(p).map((c) => c.start)

  it("packs the base end to end in start order when switched on, as one edit with the flag", () => {
    const src = gapped()
    const swapped = { ...src, tracks: [{ ...src.tracks[0], clips: [...src.tracks[0].clips].reverse() }, src.tracks[1]] }
    const p = setBaseMagnetic(swapped, true)
    expect(p.tracks[0].magnetic).toBe(true)
    expect(order(p)).toEqual(["m1", "m2", "m3"])
    expect(starts(p)).toEqual([0, 2, 5])
    expect(p.tracks[1]).toBe(src.tracks[1])
    const h = commit(createHistory<Edit>({ tracks: src.tracks }), { tracks: setBaseMagnetic(src, true).tracks })
    expect(h.past).toHaveLength(1)
    expect(undo(h).present.tracks).toBe(src.tracks)
  })

  it("is the same project when nothing changes, and switching off keeps every position", () => {
    const src = gapped()
    expect(setBaseMagnetic(src, false)).toBe(src)
    const p = packed()
    expect(setBaseMagnetic(p, true)).toBe(p)
    const off = setBaseMagnetic(p, false)
    expect(off.tracks[0]).toEqual({ id: "t1", clips: base(p) })
    // Free again: a gap can open.
    expect(starts(moveClip(off, "m3", 0, { start: 9 }))).toEqual([0, 2, 9])
  })

  it("packBase lays the base end to end in start order, keeping transforms", () => {
    const src = gapped()
    src.tracks[0].clips[1] = { ...src.tracks[0].clips[1], transform: { ...IDENTITY, x: 0.1 } }
    const p = packBase(src)
    expect(starts(p)).toEqual([0, 2, 5])
    expect(base(p)[1].transform).toEqual({ ...IDENTITY, x: 0.1 })
    expect(p.tracks[0].magnetic).toBeUndefined()
  })

  it("baseInsertion counts the clips whose midpoint is before the time", () => {
    const clips = base(packed())
    expect(baseInsertion(clips, 0.9)).toEqual({ index: 0, start: 0 })
    expect(baseInsertion(clips, 1.1)).toEqual({ index: 1, start: 2 })
    expect(baseInsertion(clips, 3.6)).toEqual({ index: 2, start: 5 })
    expect(baseInsertion(clips, 99)).toEqual({ index: 3, start: 7 })
    // Leaving m2 out: the boundary is the end of the clip before (its own slot stays where it was).
    expect(baseInsertion(clips, 3, "m2")).toEqual({ index: 1, start: 2 })
    expect(baseInsertion(clips, NaN)).toEqual({ index: 0, start: 0 })
  })

  it("inserts a dropped clip at the midpoint index and pushes the rest along", () => {
    const p = addClip(packed(), "a", 0, { start: 3 }, "n")
    expect(order(p)).toEqual(["m1", "n", "m2", "m3"])
    expect(starts(p)).toEqual([0, 2, 12, 15])
    expect(order(addClip(packed(), "i", 0, { start: 0.5 }, "n"))).toEqual(["n", "m1", "m2", "m3"])
    expect(starts(addClip(packed(), "i", 0, { start: 50 }, "n"))).toEqual([0, 2, 5, 7])
    expect(addClip(packed(), "a", 0, { start: 50 }, "n").tracks[0].magnetic).toBe(true)
  })

  it("reorders within the base by the same rule", () => {
    const p = moveClip(packed(), "m3", 0, { start: 0.5 })
    expect(order(p)).toEqual(["m3", "m1", "m2"])
    expect(starts(p)).toEqual([0, 2, 4])
    const q = moveClip(packed(), "m1", 0, { start: 6.5 })
    expect(order(q)).toEqual(["m2", "m3", "m1"])
    expect(starts(q)).toEqual([0, 3, 5])
    // Its own slot: nothing moves.
    expect(base(moveClip(packed(), "m2", 0, { start: 2 }))).toEqual(base(packed()))
  })

  it("closes the gap behind a clip moved out of the base", () => {
    const p = moveClip(packed(), "m1", 1, { start: 0 })
    expect(order(p)).toEqual(["m2", "m3"])
    expect(starts(p)).toEqual([0, 3])
    expect(overlay(p).map((c) => [c.id, c.start])).toEqual([["m1", 0], ["o1", 4]])
  })

  it("inserts and packs a clip moved into the base from a layer", () => {
    const p = moveClip(packed(), "o1", 0, { start: 4 })
    expect(order(p)).toEqual(["m1", "m2", "o1", "m3"])
    expect(starts(p)).toEqual([0, 2, 5, 7])
    expect(overlay(p)).toEqual([])
  })

  it("ripples the following clips when either edge is trimmed, the start staying put", () => {
    const out = trimClip(packed(), "m1", "out", 1)
    expect(starts(out)).toEqual([0, 1, 4])
    const longer = trimClip(packed(), "m2", "out", 10)
    expect(base(longer)[1].out).toBe(10)
    expect(starts(longer)).toEqual([0, 2, 8])
    const left = trimClip(packed(), "m2", "in", 6)
    expect(base(left)[1]).toMatchObject({ in: 6, out: 7, start: 2 })
    expect(starts(left)).toEqual([0, 2, 3])
    const back = trimClip(packed(), "m2", "in", 0)
    expect(base(back)[1]).toMatchObject({ in: 0, out: 7, start: 2 })
    expect(starts(back)).toEqual([0, 2, 9])
  })

  it("stretches an image past its old neighbour, rippling, and from the left keeps its start", () => {
    const p = moveClip(packed(), "m3", 0, { start: 0 })
    expect(order(p)).toEqual(["m3", "m1", "m2"])
    const right = trimClip(p, "m3", "out", 6)
    expect(base(right)[0]).toMatchObject({ in: 0, out: 6, start: 0 })
    expect(starts(right)).toEqual([0, 6, 8])
    const left = trimClip(p, "m3", "in", -3)
    expect(base(left)[0]).toMatchObject({ in: 0, out: 5, start: 0 })
    expect(starts(left)).toEqual([0, 5, 7])
  })

  it("keeps the base within MAX_TIMELINE when a trim or insert would push it past", () => {
    const src = packed()
    src.assets.l = { file: "l.mp4", duration: MAX_TIMELINE, hasAudio: true }
    expect(addClip(src, "l", 0, { start: 99 }, "long")).toBe(src)
    const big = { ...src, tracks: [{ ...src.tracks[0], clips: [...base(src), { id: "long", asset: "l", in: 0, out: MAX_TIMELINE - 8, start: 7 }] }, src.tracks[1]] }
    const t = trimClip(big, "m3", "out", MAX_IMAGE)
    expect(trackEnd(t.tracks[0])).toBeCloseTo(MAX_TIMELINE, 6)
    expect(base(t)[2].out).toBeCloseTo(3, 6)
  })

  it("keeps the base packed through split, delete and removing media", () => {
    const s = splitClip(packed(), "m2", 3, "half")
    expect(order(s)).toEqual(["m1", "m2", "half", "m3"])
    expect(starts(s)).toEqual([0, 2, 3, 5])
    const r = removeClip(packed(), "m2")
    expect(starts(r)).toEqual([0, 2])
    expect(r.tracks[0].magnetic).toBe(true)
    const a = removeAsset(packed(), "a").project
    expect(order(a)).toEqual(["m3"])
    expect(starts(a)).toEqual([0])
  })

  it("leaves overlay tracks free, and keeps the flag through a clip mute", () => {
    const p = addClip(packed(), "i", 1, { start: 20 }, "n")
    expect(overlay(p).map((c) => c.start)).toEqual([4, 20])
    expect(setBaseMagnetic({ ...gapped(), tracks: [] }, true).tracks).toEqual([])
    const id = base(packed())[0].id
    const muted = setClipMuted(packed(), id, true)
    expect(muted.tracks[0].magnetic).toBe(true)
    expect(setClipMuted(muted, id, false).tracks[0]).toEqual({ id: "t1", magnetic: true, clips: base(packed()) })
  })

  it("is the free layout everywhere when the flag is off", () => {
    expect(starts(moveClip(gapped(), "m3", 0, { start: 20 }))).toEqual([1, 5, 20])
    expect(starts(removeClip(gapped(), "m2"))).toEqual([1, 10])
  })

  it("parses the flag on the base only, repacking a snapped base rather than refusing gaps", () => {
    const json = JSON.parse(JSON.stringify(gapped()))
    json.tracks[0].magnetic = true
    const p = parseProject(json)!
    expect(p.tracks[0].magnetic).toBe(true)
    expect(starts(p)).toEqual([0, 2, 5])
    // Overlapping base clips under the flag pack too.
    json.tracks[0].clips[1].start = 1.5
    expect(starts(parseProject(json)!)).toEqual([0, 2, 5])
    expect(parseProject({ ...json, tracks: [{ ...json.tracks[0], magnetic: "yes" }, json.tracks[1]] })).toBeNull()
    expect(parseProject({ ...json, tracks: [json.tracks[0], { ...json.tracks[1], magnetic: 1 }] })).toBeNull()
    const overlayFlag = parseProject({ ...json, tracks: [json.tracks[0], { ...json.tracks[1], magnetic: true }] })!
    expect(overlayFlag.tracks[1]).toEqual(gapped().tracks[1])
    const off = parseProject({ ...json, tracks: [{ ...json.tracks[0], magnetic: false, clips: gapped().tracks[0].clips }, json.tracks[1]] })!
    expect(off.tracks[0]).toEqual(gapped().tracks[0])
    expect(parseProject(JSON.parse(JSON.stringify(packed())))).toEqual(packed())
  })

  it("refuses a snapped base that packs past MAX_TIMELINE", () => {
    const json = JSON.parse(JSON.stringify(gapped()))
    json.assets.l = { file: "l.mp4", duration: MAX_TIMELINE, hasAudio: true }
    // Free, it fits where it is.
    json.tracks[0].clips.push({ id: "long", asset: "l", in: 0, out: MAX_TIMELINE - 13, start: 13 })
    expect(parseProject(json)).not.toBeNull()
    // Snapped, it would end past the limit.
    json.tracks[0].clips[3].out = MAX_TIMELINE - 1
    json.tracks[0].clips[3].start = 0.5
    json.tracks[0].magnetic = true
    expect(parseProject(json)).toBeNull()
  })

  it("merges a client's snapped base, repacked", () => {
    const client = JSON.parse(JSON.stringify(gapped()))
    client.tracks[0].magnetic = true
    const merged = mergeClientProject(client, gapped())!
    expect(merged.tracks[0].magnetic).toBe(true)
    expect(starts(merged)).toEqual([0, 2, 5])
  })
})

describe("leftTrimDraft (a snapped base's left edge, packed on release)", () => {
  /** Snapped base: m1 [0, 2) in 0-2, m2 [2, 5) in 4-7, an image m3 [5, 7); an overlay clip o1. */
  function snapped(): Project {
    return {
      ...newProject("snap"),
      assets: { a: { file: "a.mp4", duration: 10, hasAudio: true }, i: { file: "i.jpg", duration: DEFAULT_IMAGE, hasAudio: false, kind: "image" } },
      tracks: [
        {
          id: "t1",
          magnetic: true,
          clips: [{ id: "m1", asset: "a", in: 0, out: 2, start: 0 }, { id: "m2", asset: "a", in: 4, out: 7, start: 2 }, { id: "m3", asset: "i", in: 0, out: 2, start: 5 }],
        },
        { id: "t2", clips: [{ id: "o1", asset: "a", in: 0, out: 2, start: 4 }] },
      ],
    }
  }
  const spans = (p: Project) => base(p).map((c) => [c.id, c.start, c.in, c.out])

  it("crops from the left: the draft opens a gap with the right edge and the clips after it in place; the commit packs", () => {
    const p = snapped()
    const { draft, seconds } = leftTrimDraft(p, "m2", 5)
    expect(spans(draft)).toEqual([["m1", 0, 0, 2], ["m2", 3, 5, 7], ["m3", 5, 0, 2]])
    expect(draft.tracks[1]).toBe(p.tracks[1])
    expect(seconds).toBe(5)
    const done = trimClip(p, "m2", "in", seconds)
    expect(spans(done)).toEqual([["m1", 0, 0, 2], ["m2", 2, 5, 7], ["m3", 4, 0, 2]])
    // The same as committing the pointer's time straight away (today's result).
    expect(done).toEqual(trimClip(p, "m2", "in", 5))
  })

  it("expands to the left over the previous clip in the draft; the commit ripples the rest", () => {
    const p = snapped()
    const { draft, seconds } = leftTrimDraft(p, "m2", 3)
    expect(spans(draft)).toEqual([["m1", 0, 0, 2], ["m2", 1, 3, 7], ["m3", 5, 0, 2]])
    expect(seconds).toBe(3)
    expect(spans(trimClip(p, "m2", "in", seconds))).toEqual([["m1", 0, 0, 2], ["m2", 2, 3, 7], ["m3", 6, 0, 2]])
    // Time 0 stops the draft (here before the source's start), and the commit stops with it.
    const far = leftTrimDraft(p, "m2", -3)
    expect(spans(far.draft)[1]).toEqual(["m2", 0, 2, 7])
    expect(far.seconds).toBe(2)
    expect(spans(trimClip(p, "m2", "in", far.seconds))).toEqual([["m1", 0, 0, 2], ["m2", 2, 2, 7], ["m3", 7, 0, 2]])
    // The source's start stops it too.
    const moved = { ...p, tracks: [{ ...p.tracks[0], clips: base(p).map((c) => (c.id === "m2" ? { ...c, in: 1, out: 4 } : c)) }, p.tracks[1]] }
    expect(spans(leftTrimDraft(moved, "m2", -3).draft)[1]).toEqual(["m2", 1, 0, 4])
  })

  it("keeps the first clip at 0: it can crop but not reach before 0, and the commit matches the draft", () => {
    const p = snapped()
    const grow = { ...p, tracks: [{ ...p.tracks[0], clips: [{ ...base(p)[0], in: 1, out: 3 }, ...base(p).slice(1)] }, p.tracks[1]] }
    const back = leftTrimDraft(grow, "m1", 0)
    expect(back.draft).toEqual(grow)
    expect(back.seconds).toBe(1)
    expect(trimClip(grow, "m1", "in", back.seconds)).toEqual(grow)
    const crop = leftTrimDraft(grow, "m1", 2)
    expect(spans(crop.draft)[0]).toEqual(["m1", 1, 2, 3])
    expect(spans(trimClip(grow, "m1", "in", crop.seconds))).toEqual([["m1", 0, 2, 3], ["m2", 1, 4, 7], ["m3", 4, 0, 2]])
  })

  it("leaves MIN_CLIP, and moves an image's left edge by its length", () => {
    const p = snapped()
    expect(spans(leftTrimDraft(p, "m2", 99).draft)[1]).toEqual(["m2", 5 - MIN_CLIP, 7 - MIN_CLIP, 7])
    const img = leftTrimDraft(p, "m3", 1.5)
    expect(spans(img.draft)[2]).toEqual(["m3", 6.5, 0, 0.5])
    expect(spans(trimClip(p, "m3", "in", img.seconds))[2]).toEqual(["m3", 5, 0, 0.5])
    const longer = leftTrimDraft(p, "m3", -1)
    expect(spans(longer.draft)[2]).toEqual(["m3", 4, 0, 3])
    expect(spans(trimClip(p, "m3", "in", longer.seconds))[2]).toEqual(["m3", 5, 0, 3])
  })

  it("is trimClip off a snapped base", () => {
    const p = setBaseMagnetic(snapped(), false)
    expect(leftTrimDraft(p, "m2", 5).draft).toEqual(trimClip(p, "m2", "in", 5))
    expect(leftTrimDraft(snapped(), "o1", 1).draft).toEqual(trimClip(snapped(), "o1", "in", 1))
  })
})
