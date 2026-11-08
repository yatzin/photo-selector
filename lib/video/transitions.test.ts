import { describe, expect, it } from "vitest"
import { setClipTiming, LINKED } from "./clip-timing"
import { commit, createHistory, redo, undo } from "./history"
import {
  addClip, brokenLinks, mergeClientProject, moveClip, newProject, parseProject, removeClip, setBaseMagnetic, splitClip, trimClip, type Clip, type Edit, type Project,
} from "./project"
import { MAX_TRANSITION, TRANSITION_TYPES } from "./transition-types"
import {
  cutsOf, entrySourceTime, isLinked, laneClipAt, linkedChain, moveGroup, setTransition, TRANSITION_GROUPS, TRANSITION_INFO, transitionAt, transitionLimits, unlinkClip,
} from "./transitions"

/**
 * Layer 1: three 4 s cuts of a 20 s video, end to end from 0 (sources 2-6,
 * 8-12, 14-18: two seconds of handle on each side), then a gap and an image.
 */
function sample(): Project {
  return {
    ...newProject("t"),
    assets: { v: { file: "v.mp4", duration: 20, hasAudio: true }, i: { file: "i.jpg", duration: 5, hasAudio: false, kind: "image" } },
    tracks: [{
      id: "t1",
      clips: [
        { id: "a", asset: "v", in: 2, out: 6, start: 0 },
        { id: "b", asset: "v", in: 8, out: 12, start: 4 },
        { id: "c", asset: "v", in: 14, out: 18, start: 8 },
        { id: "d", asset: "i", in: 0, out: 5, start: 15 },
      ],
    }],
  }
}

const clip = (p: Project, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
const fade = (duration = 1) => ({ type: "fade" as const, duration })

/** The sample with fades into b and c: a, b and c linked. */
function chain(): Project {
  return setTransition(setTransition(sample(), "b", fade()), "c", fade())
}

describe("catalogue", () => {
  it("names and groups every type", () => {
    for (const t of TRANSITION_TYPES) {
      expect(TRANSITION_INFO[t].name).toBeTruthy()
      expect(TRANSITION_GROUPS).toContain(TRANSITION_INFO[t].group)
    }
  })
})

describe("cutsOf", () => {
  it("finds the adjoining neighbours", () => {
    const p = sample()
    expect(cutsOf(p, "a")).toEqual({ before: null, after: "b" })
    expect(cutsOf(p, "b")).toEqual({ before: "b", after: "c" })
    // A gap after c: nothing adjoins it there.
    expect(cutsOf(p, "c")).toEqual({ before: "c", after: null })
    expect(cutsOf(p, "d")).toEqual({ before: null, after: null })
    expect(cutsOf(p, "nope")).toEqual({ before: null, after: null })
  })

  it("counts clips within a millisecond as adjoining", () => {
    const p = sample()
    p.tracks[0].clips[1] = { ...p.tracks[0].clips[1], start: 4.0009 }
    expect(cutsOf(p, "a").after).toBe("b")
    p.tracks[0].clips[1] = { ...p.tracks[0].clips[1], start: 4.002 }
    expect(cutsOf(p, "a").after).toBeNull()
  })
})

describe("transitionLimits", () => {
  it("is twice the smaller handle, each half at most its clip's length beside its other cut, and MAX_TRANSITION", () => {
    // a has 14 s after its out, b 8 s before its in; each half fits in a 4 s clip: 8 s.
    expect(transitionLimits(sample(), "b")).toEqual({ max: 8, reason: "ok" })
    // A 3 s fade into c takes 1.5 s of b: a fade into b has 2.5 s of b for its half.
    expect(transitionLimits(setTransition(sample(), "c", fade(3)), "b").max).toBe(5)
    const p = sample()
    // b's in at 8.3: 0.3 s of handle, so 0.6 s at most.
    p.tracks[0].clips[1] = { ...p.tracks[0].clips[1], in: 0.3, out: 4.3 }
    expect(transitionLimits(p, "b").max).toBeCloseTo(0.6)
    // Long clips and long handles stop at MAX_TRANSITION.
    const long: Project = { ...p, assets: { v: { file: "v.mp4", duration: 100, hasAudio: true } }, tracks: [{ id: "t1", clips: [{ id: "x", asset: "v", in: 10, out: 30, start: 0 }, { id: "y", asset: "v", in: 50, out: 70, start: 20 }] }] }
    expect(transitionLimits(long, "y").max).toBe(MAX_TRANSITION)
  })

  it("is 0 with no footage beyond the cut, or nothing adjoining", () => {
    const p = sample()
    // b trimmed to the very start of its source: no head.
    p.tracks[0].clips[1] = { ...p.tracks[0].clips[1], in: 0, out: 4 }
    expect(transitionLimits(p, "b")).toEqual({ max: 0, reason: "no-footage" })
    expect(transitionLimits(sample(), "a")).toEqual({ max: 0, reason: "not-adjoining" })
    expect(transitionLimits(sample(), "d")).toEqual({ max: 0, reason: "not-adjoining" })
  })

  it("gives stills unlimited handles", () => {
    const p: Project = {
      ...sample(),
      tracks: [{ id: "t1", clips: [{ id: "i1", asset: "i", in: 0, out: 3, start: 0 }, { id: "t", asset: "", in: 0, out: 2, start: 3, text: { content: "Hi", color: "#ffffff", orientation: "horizontal" } }] }],
    }
    expect(transitionLimits(p, "t").max).toBe(4)
  })
})

describe("setTransition", () => {
  it("sets, clamps and removes", () => {
    const p = setTransition(sample(), "b", { type: "wipeleft", duration: 9 })
    expect(clip(p, "b")?.transition).toEqual({ type: "wipeleft", duration: 8 })
    expect(clip(setTransition(sample(), "b", { type: "fade", duration: 0.01 }), "b")?.transition?.duration).toBe(0.1)
    expect(clip(setTransition(p, "b", null), "b")?.transition).toBeUndefined()
  })

  it("refuses a cut with nothing adjoining, or an unknown type", () => {
    const p = sample()
    expect(setTransition(p, "a", fade())).toBe(p)
    expect(setTransition(p, "b", { type: "spiral" as never, duration: 1 })).toBe(p)
    expect(setTransition(p, "b", { type: "fade", duration: Number.NaN })).toBe(p)
  })

  it("is the same project when nothing changes", () => {
    const p = setTransition(sample(), "b", fade())
    expect(setTransition(p, "b", fade())).toBe(p)
    expect(setTransition(sample(), "b", null)).toEqual(sample())
  })
})

describe("linkedChain, isLinked and unlinkClip", () => {
  it("follows transitions both ways", () => {
    const p = chain()
    expect(linkedChain(p, "a")).toEqual(["a", "b", "c"])
    expect(linkedChain(p, "c")).toEqual(["a", "b", "c"])
    expect(linkedChain(p, "d")).toEqual(["d"])
    expect(linkedChain(p, "zz")).toEqual([])
    expect(isLinked(p, "b")).toBe(true)
    expect(isLinked(p, "d")).toBe(false)
  })

  it("unlinks a clip on both sides", () => {
    const p = unlinkClip(chain(), "b")
    expect(clip(p, "b")?.transition).toBeUndefined()
    expect(clip(p, "c")?.transition).toBeUndefined()
    expect(linkedChain(p, "a")).toEqual(["a"])
    const q = unlinkClip(chain(), "a")
    expect(clip(q, "b")?.transition).toBeUndefined()
    expect(clip(q, "c")?.transition).toEqual(fade())
  })
})

describe("moveGroup", () => {
  it("moves the whole chain as one block, slid clear of other clips", () => {
    const p = moveGroup(chain(), "b", 20)
    expect(["a", "b", "c"].map((id) => clip(p, id)?.start)).toEqual([20, 24, 28])
    expect(clip(p, "c")?.transition).toEqual(fade())
    // Onto the image at 15-20: it slides past it.
    const q = moveGroup(chain(), "a", 14)
    expect(clip(q, "a")?.start).toBe(20)
    expect(moveGroup(chain(), "a", 0)).toEqual(chain())
  })

  it("on a snapped base, goes in at a slot and packs", () => {
    const p = setBaseMagnetic(chain(), true)
    // The image moves to the front when the block goes after it.
    const q = moveGroup(p, "a", 100)
    expect(q.tracks[0].clips.map((c) => c.id)).toEqual(["d", "a", "b", "c"])
    expect(q.tracks[0].clips.map((c) => c.start)).toEqual([0, 5, 9, 13])
    expect(linkedChain(q, "a")).toEqual(["a", "b", "c"])
  })
})

describe("edits keep or drop transitions", () => {
  it("splitting keeps the outer sides", () => {
    const p = splitClip(chain(), "b", 6, "b2")
    expect(clip(p, "b")?.transition).toEqual(fade())
    expect(clip(p, "b2")?.transition).toBeUndefined()
    expect(clip(p, "c")?.transition).toEqual(fade())
    expect(linkedChain(p, "a")).toEqual(["a", "b"])
    expect(linkedChain(p, "c")).toEqual(["b2", "c"])
  })

  it("splitting shortens a transition to twice a piece's length", () => {
    const p = splitClip(setTransition(sample(), "b", fade(4)), "b", 4.5, "b2")
    expect(clip(p, "b")?.transition?.duration).toBe(1)
  })

  it("deleting a clip takes its transitions, rippled on a snapped base too", () => {
    const p = removeClip(chain(), "b")
    expect(clip(p, "c")?.transition).toBeUndefined()
    const q = removeClip(setBaseMagnetic(chain(), true), "b")
    expect(clip(q, "c")?.start).toBe(4)
    expect(clip(q, "c")?.transition).toBeUndefined()
  })

  it("moving a linked clip away drops its links; moving another layer's clip doesn't", () => {
    const p = moveClip(chain(), "b", 0, { start: 30 })
    expect(clip(p, "b")?.transition).toBeUndefined()
    expect(clip(p, "c")?.transition).toBeUndefined()
    const layered = { ...chain(), tracks: [...chain().tracks, { id: "t2", clips: [{ id: "o", asset: "v", in: 0, out: 2, start: 0 } as Clip] }] }
    expect(moveClip(layered, "o", 1, { start: 5 }).tracks[0]).toEqual(chain().tracks[0])
  })

  it("trimming an inner edge parts the clips; an outer edge re-clamps", () => {
    expect(clip(trimClip(chain(), "a", "out", 5), "b")?.transition).toBeUndefined()
    // c's free right edge: a 3 s fade into c, then c trimmed to 1 s long: its half fits in 1 s.
    const p = setTransition(sample(), "c", fade(3))
    const q = trimClip(p, "c", "out", 15)
    expect(clip(q, "c")?.transition?.duration).toBe(2)
    // On a snapped base, c's left edge pulled back to its source's start: no handle left, so the fade goes.
    const r = trimClip(setTransition(setBaseMagnetic(sample(), true), "c", fade(3)), "c", "in", 0)
    expect(clip(r, "c")?.in).toBe(0)
    expect(clip(r, "c")?.transition).toBeUndefined()
  })

  it("a snapped base keeps adjoining clips adjoining, so a trim there keeps the link", () => {
    const p = setBaseMagnetic(chain(), true)
    const q = trimClip(p, "a", "out", 5)
    expect(clip(q, "b")?.start).toBe(3)
    expect(clip(q, "b")?.transition).toEqual(fade())
  })

  it("a drop between linked clips on a snapped base parts them", () => {
    const p = setBaseMagnetic(chain(), true)
    const q = addClip(p, "i", 0, { start: 5 }, "new")
    expect(q.tracks[0].clips.map((c) => c.id).slice(0, 3)).toEqual(["a", "new", "b"])
    expect(clip(q, "b")?.transition).toBeUndefined()
    expect(brokenLinks(p, q)).toEqual(["b"])
  })

  it("Edit length refuses to part linked clips and fits the others", () => {
    const p = chain()
    expect(setClipTiming(p, "c", { start: 9, length: 4 }, "push", () => "x")).toEqual({ ok: false, error: LINKED })
    const r = setClipTiming(setTransition(sample(), "c", fade(3)), "c", { start: 8, length: 1 }, "push", () => "x")
    expect(r.ok && clip(r.project, "c")?.transition?.duration).toBe(2)
  })

  it("undo and redo bring transitions back with the tracks", () => {
    let h = createHistory<Edit>({ tracks: sample().tracks })
    h = commit(h, { tracks: chain().tracks })
    h = undo(h)
    expect(h.present.tracks[0].clips[1].transition).toBeUndefined()
    h = redo(h)
    expect(h.present.tracks[0].clips[1].transition).toEqual(fade())
  })
})

describe("parse", () => {
  const json = (p: Project) => JSON.parse(JSON.stringify(p)) as unknown

  it("reads transitions back", () => {
    expect(parseProject(json(chain()))).toEqual(chain())
  })

  it("drops one whose clip has nothing adjoining it, and shortens an overlong one", () => {
    const p = sample()
    p.tracks[0].clips[3] = { ...p.tracks[0].clips[3], transition: fade() }
    p.tracks[0].clips[1] = { ...p.tracks[0].clips[1], transition: fade(9) }
    const q = parseProject(json(p))!
    expect(clip(q, "d")?.transition).toBeUndefined()
    expect(clip(q, "b")?.transition).toEqual(fade(8))
  })

  it("refuses an unknown type or a duration out of range", () => {
    const bad = (transition: unknown) => {
      const p = json(sample()) as { tracks: { clips: Record<string, unknown>[] }[] }
      p.tracks[0].clips[1].transition = transition
      return parseProject(p)
    }
    expect(bad({ type: "spiral", duration: 1 })).toBeNull()
    expect(bad({ type: "fade", duration: 0.05 })).toBeNull()
    expect(bad({ type: "fade", duration: 11 })).toBeNull()
    expect(bad({ type: "fade" })).toBeNull()
    expect(bad("fade")).toBeNull()
    expect(bad({ type: "fade", duration: 1 })).not.toBeNull()
  })

  it("merge keeps a client's transitions", () => {
    expect(mergeClientProject(json(chain()), sample())).toEqual(chain())
  })
})

describe("playback helpers", () => {
  const p = chain()
  const track = p.tracks[0]

  it("transitionAt finds the window centred on the cut", () => {
    expect(transitionAt(track, 3.4)).toBeNull()
    expect(transitionAt(track, 3.5)).toMatchObject({ from: 0, to: 1, cut: 4, progress: 0 })
    expect(transitionAt(track, 4)).toMatchObject({ progress: 0.5 })
    expect(transitionAt(track, 4.5)).toBeNull()
    expect(transitionAt(track, 8.25)).toMatchObject({ from: 1, to: 2, progress: 0.75 })
  })

  it("laneClipAt shows the incoming clip from the window's start", () => {
    expect(laneClipAt(track, 3.6)).toEqual({ index: 1, start: 4, sourceTime: 7.6 })
    expect(laneClipAt(track, 2)).toEqual({ index: 0, start: 0, sourceTime: 4 })
    expect(entrySourceTime(track, track.clips[1])).toBe(7.5)
    expect(entrySourceTime(track, track.clips[0])).toBe(2)
  })
})
