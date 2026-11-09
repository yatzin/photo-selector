import { describe, expect, it } from "vitest"
import { setClipTiming } from "./clip-timing"
import { exportFingerprint } from "./export-state"
import { commit, createHistory, redo, undo } from "./history"
import {
  addClip, AUDIO_TRACK, editOf, mergeClientProject, moveClip, newProject, parseProject, removeClip, splitClip, trimClip, type Clip, type Edit, type Project,
} from "./project"
import { EDGE_AUDIO_TYPES, EDGE_PICTURE_TYPES, MAX_EDGE } from "./transition-types"
import { edgeAt, edgeLimits, isLinked, linkedChain, setEdgeTransition, setTransition } from "./transitions"

/** Layer 1: an image a (0-5) and a video b (8-12, source 2-6) with a gap between; a text t on layer 2; a sound clip on the audio layer. */
function sample(): Project {
  return {
    ...newProject("e"),
    assets: {
      i: { file: "i.jpg", duration: 5, hasAudio: false, kind: "image" },
      v: { file: "v.mp4", duration: 20, hasAudio: true },
      m: { file: "m.wav", duration: 30, hasAudio: true, kind: "audio" },
    },
    tracks: [
      { id: "t1", clips: [{ id: "a", asset: "i", in: 0, out: 5, start: 0 }, { id: "b", asset: "v", in: 2, out: 6, start: 8 }] },
      { id: "t2", clips: [{ id: "t", asset: "", in: 0, out: 3, start: 1, text: { content: "Hi", color: "#ffffff", orientation: "horizontal" } }] },
    ],
    audioTrack: { id: "audio", clips: [{ id: "s", asset: "m", in: 0, out: 6, start: 0 }] },
  }
}

const all = (p: Project) => [...p.tracks.flatMap((t) => t.clips), ...(p.audioTrack?.clips ?? [])]
const clip = (p: Project, id: string) => all(p).find((c) => c.id === id) as Clip
const fadeIn = (duration = 1) => ({ type: "fade" as const, duration })

describe("edgeLimits", () => {
  it("is up to 10 s and what the clip leaves beside its other edge", () => {
    expect(edgeLimits(sample(), "a", "in")).toEqual({ max: 5, reason: "ok" })
    const p = setEdgeTransition(sample(), "a", "out", fadeIn(2))
    expect(edgeLimits(p, "a", "in")).toEqual({ max: 3, reason: "ok" })
    const long: Project = { ...sample(), tracks: [{ id: "t1", clips: [{ id: "x", asset: "v", in: 0, out: 20, start: 0 }] }] }
    expect(edgeLimits(long, "x", "out").max).toBe(MAX_EDGE)
  })

  it("is 0 at an edge a clip adjoins, on a text clip, or for an unknown clip", () => {
    const p = { ...sample(), tracks: [{ id: "t1", clips: [{ id: "a", asset: "i", in: 0, out: 5, start: 0 }, { id: "b", asset: "v", in: 2, out: 6, start: 5 }] }, sample().tracks[1]] }
    expect(edgeLimits(p, "a", "out").reason).toBe("adjoining")
    expect(edgeLimits(p, "b", "in").reason).toBe("adjoining")
    expect(edgeLimits(p, "a", "in").reason).toBe("ok")
    expect(edgeLimits(sample(), "t", "in").reason).toBe("text")
    expect(edgeLimits(sample(), "nope", "in").reason).toBe("not-found")
  })
})

describe("setEdgeTransition", () => {
  it("sets, clamps and removes, on any picture clip", () => {
    let p = setEdgeTransition(sample(), "a", "in", fadeIn(1.25))
    expect(clip(p, "a").edgeIn).toEqual({ type: "fade", duration: 1.25 })
    p = setEdgeTransition(p, "b", "out", { type: "wipeleft", duration: 99 })
    expect(clip(p, "b").edgeOut).toEqual({ type: "wipeleft", duration: 4 })
    p = setEdgeTransition(p, "b", "in", { type: "slideup", duration: 0.01 })
    // 0.1 s at least, and in + out fit the clip: the out edge already takes all 4 s.
    expect(clip(p, "b").edgeIn).toBeUndefined()
    p = setEdgeTransition(p, "a", "in", null)
    expect(clip(p, "a").edgeIn).toBeUndefined()
  })

  it("takes audio fades on audio clips only, and picture transitions on picture clips only", () => {
    const p = sample()
    expect(setEdgeTransition(p, "s", "in", fadeIn())).toBe(p)
    expect(clip(setEdgeTransition(p, "s", "in", { type: "audio-scurve", duration: 2 }), "s").edgeIn).toEqual({ type: "audio-scurve", duration: 2 })
    expect(setEdgeTransition(p, "a", "in", { type: "audio-linear", duration: 1 })).toBe(p)
    // An echo tail only at an out edge; a dip to black means nothing at a free edge.
    expect(setEdgeTransition(p, "s", "in", { type: "audio-echo", duration: 1 })).toBe(p)
    expect(clip(setEdgeTransition(p, "s", "out", { type: "audio-echo", duration: 1 }), "s").edgeOut?.type).toBe("audio-echo")
    expect(setEdgeTransition(p, "a", "in", { type: "fadeblack", duration: 1 })).toBe(p)
  })

  it("refuses a text clip, an edge a clip adjoins, and an unchanged spec", () => {
    const p = sample()
    expect(setEdgeTransition(p, "t", "in", fadeIn())).toBe(p)
    const joined = moveClip(p, "b", 0, { start: 5 })
    expect(setEdgeTransition(joined, "b", "in", fadeIn())).toBe(joined)
    const q = setEdgeTransition(p, "a", "in", fadeIn())
    expect(setEdgeTransition(q, "a", "in", fadeIn())).toBe(q)
  })

  it("offers the subsets the spec lists", () => {
    expect(EDGE_PICTURE_TYPES.in).not.toContain("fadeblack")
    expect(EDGE_PICTURE_TYPES.out).not.toContain("fadewhite")
    expect(EDGE_PICTURE_TYPES.out).toContain("zoomin")
    expect(EDGE_PICTURE_TYPES.in).not.toContain("zoomin")
    expect(EDGE_AUDIO_TYPES.in).not.toContain("audio-echo")
    expect(EDGE_AUDIO_TYPES.out).toContain("audio-echo")
  })
})

describe("edits keep, fit or drop edge transitions", () => {
  const both = () => setEdgeTransition(setEdgeTransition(sample(), "a", "in", fadeIn(2)), "a", "out", { type: "wiperight", duration: 2 })

  it("trimming shrinks them in proportion, as a text's animations", () => {
    const p = trimClip(both(), "a", "out", 2)
    expect(clip(p, "a").edgeIn?.duration).toBe(1)
    expect(clip(p, "a").edgeOut?.duration).toBe(1)
  })

  it("splitting gives the first piece the in edge and the second the out edge", () => {
    const p = splitClip(both(), "a", 2.5, "a2")
    expect(clip(p, "a").edgeIn).toEqual({ type: "fade", duration: 2 })
    expect(clip(p, "a").edgeOut).toBeUndefined()
    expect(clip(p, "a2").edgeIn).toBeUndefined()
    expect(clip(p, "a2").edgeOut).toEqual({ type: "wiperight", duration: 2 })
  })

  it("Edit length fits them too", () => {
    const r = setClipTiming(both(), "a", { start: 0, length: 1 }, "push", () => "n")
    expect(r.ok && clip(r.project, "a").edgeIn!.duration + clip(r.project, "a").edgeOut!.duration).toBeCloseTo(1)
  })

  it("a clip coming to adjoin that edge drops it; moving away keeps the other", () => {
    let p = setEdgeTransition(setEdgeTransition(sample(), "b", "in", fadeIn()), "b", "out", fadeIn())
    p = setEdgeTransition(p, "a", "out", fadeIn())
    const moved = moveClip(p, "b", 0, { start: 5 })
    expect(clip(moved, "b").edgeIn).toBeUndefined()
    expect(clip(moved, "b").edgeOut).toBeDefined()
    expect(clip(moved, "a").edgeOut).toBeUndefined()
    // A new clip dropped against an edge does the same.
    const dropped = addClip(p, "i", 0, { start: 12 }, "n")
    expect(clip(dropped, "n").start).toBe(12)
    expect(clip(dropped, "b").edgeOut).toBeUndefined()
    // Deleting a neighbour frees the edge but brings nothing back.
    expect(clip(removeClip(moved, "a"), "b").edgeIn).toBeUndefined()
  })

  it("on the audio layer too", () => {
    let p = setEdgeTransition(sample(), "s", "out", { type: "audio-tapestop", duration: 1 })
    p = addClip(p, "m", AUDIO_TRACK, { start: 6 }, "s2")
    expect(clip(p, "s2").start).toBe(6)
    expect(clip(p, "s").edgeOut).toBeUndefined()
  })

  it("undo and redo bring them back with the tracks", () => {
    let h = createHistory<Edit>(editOf(sample()))
    const meta = sample()
    h = commit(h, editOf(setEdgeTransition(sample(), "a", "in", fadeIn())))
    expect(clip({ ...meta, ...h.present }, "a").edgeIn).toBeDefined()
    h = undo(h)
    expect(clip({ ...meta, ...h.present }, "a").edgeIn).toBeUndefined()
    h = redo(h)
    expect(clip({ ...meta, ...h.present }, "a").edgeIn).toBeDefined()
  })

  it("never link a clip: no chain, no group lock", () => {
    const p = both()
    expect(linkedChain(p, "a")).toEqual(["a"])
    expect(isLinked(p, "a")).toBe(false)
  })
})

describe("edgeAt", () => {
  it("finds the in window at the start and the out window at the end", () => {
    const c: Clip = { id: "x", asset: "v", in: 0, out: 4, start: 10, edgeIn: { type: "fade", duration: 1 }, edgeOut: { type: "wipeleft", duration: 2 } }
    expect(edgeAt(c, 9.9)).toBeNull()
    expect(edgeAt(c, 10.5)).toEqual({ edge: "in", type: "fade", duration: 1, progress: 0.5 })
    expect(edgeAt(c, 11.5)).toBeNull()
    expect(edgeAt(c, 13)).toEqual({ edge: "out", type: "wipeleft", duration: 2, progress: 0.5 })
    expect(edgeAt(c, 14)).toBeNull()
  })
})

describe("parse, merge and fingerprint", () => {
  it("reads edge transitions back", () => {
    const p = setEdgeTransition(setEdgeTransition(sample(), "a", "in", fadeIn()), "s", "out", { type: "audio-echo", duration: 2 })
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    expect(mergeClientProject(p, sample())).toEqual(p)
  })

  it("drops one at an adjoining edge, a wrong family, an edge type that edge can't have, and any on a text; fits the rest", () => {
    const p = sample()
    const forged = {
      ...p,
      tracks: [
        { id: "t1", clips: [{ ...p.tracks[0].clips[0], edgeOut: fadeIn(), edgeIn: { type: "audio-linear", duration: 1 } }, { ...p.tracks[0].clips[1], start: 5, edgeIn: fadeIn(), edgeOut: { type: "zoomin", duration: 3 } }] },
        { id: "t2", clips: [{ ...p.tracks[1].clips[0], edgeIn: fadeIn() }] },
      ],
      audioTrack: { id: "audio", clips: [{ ...p.audioTrack!.clips[0], edgeIn: fadeIn(), edgeOut: { type: "audio-exp", duration: 4 } }] },
    }
    const q = parseProject(forged)!
    expect(clip(q, "a").edgeIn).toBeUndefined()
    expect(clip(q, "a").edgeOut).toBeUndefined()
    expect(clip(q, "b").edgeIn).toBeUndefined()
    expect(clip(q, "b").edgeOut).toEqual({ type: "zoomin", duration: 3 })
    expect(clip(q, "t").edgeIn).toBeUndefined()
    expect(clip(q, "s").edgeIn).toBeUndefined()
    expect(clip(q, "s").edgeOut).toEqual({ type: "audio-exp", duration: 4 })
    // In and out longer than the clip are fitted to it.
    const long = { ...p, tracks: [{ id: "t1", clips: [{ ...p.tracks[0].clips[0], edgeIn: fadeIn(4), edgeOut: fadeIn(4) }] }] }
    const fit = clip(parseProject(long)!, "a")
    expect(fit.edgeIn!.duration + fit.edgeOut!.duration).toBeLessThanOrEqual(5)
  })

  it("refuses a malformed one", () => {
    const p = sample()
    const bad = (e: unknown) => ({ ...p, tracks: [{ id: "t1", clips: [{ ...p.tracks[0].clips[0], edgeIn: e }] }] })
    expect(parseProject(bad({ type: "nope", duration: 1 }))).toBeNull()
    expect(parseProject(bad({ type: "fade", duration: 0.05 }))).toBeNull()
    expect(parseProject(bad({ type: "fade", duration: 11 }))).toBeNull()
  })

  it("counts in the export fingerprint, and a project without them keeps its fingerprint", () => {
    const p = sample()
    const withEdge = setEdgeTransition(p, "a", "in", fadeIn())
    expect(exportFingerprint(withEdge)).not.toBe(exportFingerprint(p))
    expect(exportFingerprint(setEdgeTransition(withEdge, "a", "in", null))).toBe(exportFingerprint(p))
  })

  it("leaves a cut's transition and linking as they were", () => {
    const p = { ...sample(), tracks: [{ id: "t1", clips: [{ id: "a", asset: "i", in: 0, out: 5, start: 0 }, { id: "b", asset: "v", in: 2, out: 6, start: 5 }] }] }
    const q = setEdgeTransition(setTransition(p, "b", fadeIn()), "a", "in", fadeIn())
    expect(linkedChain(q, "a")).toEqual(["a", "b"])
    expect(clip(q, "a").edgeIn).toBeDefined()
  })
})
