import { describe, expect, it } from "vitest"
import { commit, createHistory, undo } from "./history"
import { clipLength, newProject, packBase, parseProject, setBaseMagnetic, type Clip, type Edit, type Project } from "./project"
import { applyCut, cutAudioPlan, cutAudioRange, cutTrims, setCutAudio, setTransition, transitionPlan, transitionRange } from "./transitions"

/**
 * Layer 1: two 3 s cuts of a 10 s video with no footage to spare at the cut
 * (a ends at the source's end, b starts at its start), a third clip right
 * after b and an image after a gap. Layer 2: a clip that must not move.
 */
function tight(): Project {
  return {
    ...newProject("t"),
    assets: { v: { file: "v.mp4", duration: 10, hasAudio: true }, w: { file: "w.mp4", duration: 10, hasAudio: true }, i: { file: "i.jpg", duration: 5, hasAudio: false, kind: "image" } },
    tracks: [
      {
        id: "t1",
        clips: [
          { id: "a", asset: "v", in: 7, out: 10, start: 0 },
          { id: "b", asset: "w", in: 0, out: 3, start: 3 },
          { id: "c", asset: "v", in: 2, out: 5, start: 6 },
          { id: "d", asset: "i", in: 0, out: 2, start: 12 },
        ],
      },
      { id: "t2", clips: [{ id: "o", asset: "v", in: 0, out: 2, start: 7 }] },
    ],
  }
}

const clip = (p: Project, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!
const fade = (duration = 1) => ({ type: "fade" as const, duration })

/** Two stills (an image and a text) side by side: no trims ever. */
function stills(): Project {
  return {
    ...tight(),
    tracks: [{ id: "t1", clips: [{ id: "i1", asset: "i", in: 0, out: 1.6, start: 0 }, { id: "x", asset: "", in: 0, out: 1.6, start: 1.6, text: { content: "Hi", color: "#ffffff", orientation: "horizontal" } } as Clip] }],
  }
}

describe("transitionRange", () => {
  it("is limited by the clips' lengths once trimming is allowed, not by spare footage", () => {
    // No footage at the cut: each half is trimmed off its clip, so d/2 + d/2 must fit in 3 s: 3 s.
    expect(transitionRange(tight(), "b")).toMatchObject({ max: 3, reason: "ok", limit: "outgoing" })
    // Two 1.6 s stills: each half fits in its clip, no trims: 3.2 s, limited by the second clip.
    expect(transitionRange(stills(), "x")).toMatchObject({ max: 3.2, reason: "ok", limit: "outgoing", lengths: { outgoing: 1.6, incoming: 1.6 } })
  })

  it("stops at MAX_TRANSITION, and names the side that limits it", () => {
    const p: Project = { ...tight(), tracks: [{ id: "t1", clips: [{ id: "a", asset: "v", in: 0, out: 10, start: 0 }, { id: "b", asset: "w", in: 0, out: 4, start: 10 }] }] }
    // b is 4 s with no footage before it: d/2 trimmed plus d/2 shown fits in 4 s: 4 s (a has 10 s, no footage after it either: 10 s).
    expect(transitionRange(p, "b")).toMatchObject({ max: 4, limit: "incoming" })
    const long: Project = { ...p, assets: { ...p.assets, v: { ...p.assets.v, duration: 100 }, w: { ...p.assets.w, duration: 100 } }, tracks: [{ id: "t1", clips: [{ id: "a", asset: "v", in: 0, out: 30, start: 0 }, { id: "b", asset: "w", in: 40, out: 70, start: 30 }] }] }
    expect(transitionRange(long, "b")).toMatchObject({ max: 10, limit: "cap" })
  })

  it("leaves room for the clip's other cut and keeps each clip MIN_CLIP long", () => {
    // A 2 s fade into c takes 1 s of b: the fade into b has 2 s of b, of which half trimmed and half shown: 2 s.
    const p = setTransition(tight(), "c", fade(2))
    expect(transitionRange(p, "b").max).toBe(2)
    expect(transitionRange(tight(), "a")).toMatchObject({ max: 0, reason: "not-adjoining" })
    expect(transitionRange(tight(), "d")).toMatchObject({ max: 0, reason: "not-adjoining" })
  })
})

describe("transitionPlan and setTransition", () => {
  it("trims the clips that have no footage at the cut and ripples the rest of the layer", () => {
    const plan = transitionPlan(tight(), "b", fade(2))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.trims).toEqual({ outgoing: 1, incoming: 1, ripple: 2 })
    const q = plan.project
    expect(clip(q, "a")).toMatchObject({ in: 7, out: 9, start: 0 })
    expect(clip(q, "b")).toMatchObject({ in: 1, out: 3, start: 2, transition: fade(2) })
    // Later clips on the layer move 2 s earlier; the other layer stays.
    expect(clip(q, "c").start).toBe(4)
    expect(clip(q, "d").start).toBe(10)
    expect(q.tracks[1].clips).toEqual(tight().tracks[1].clips)
    expect(setTransition(tight(), "b", fade(2))).toEqual(q)
  })

  it("trims only what's missing", () => {
    const p = tight()
    // a has 0.4 s past its out, b 0.3 s before its in.
    p.tracks[0].clips[0] = { ...p.tracks[0].clips[0], in: 6.6, out: 9.6 }
    p.tracks[0].clips[1] = { ...p.tracks[0].clips[1], in: 0.3, out: 3.3 }
    const plan = transitionPlan(p, "b", fade(1.4))
    expect(plan.ok && plan.trims).toEqual({ outgoing: 0.3, incoming: 0.4, ripple: 0.7 })
  })

  it("is the same project when applied again (idempotent), and decreasing keeps the trims", () => {
    const q = setTransition(tight(), "b", fade(2))
    expect(setTransition(q, "b", fade(2))).toBe(q)
    const r = setTransition(q, "b", fade(1))
    expect(clip(r, "a").out).toBe(9)
    expect(clip(r, "b").in).toBe(1)
    expect(clip(r, "b").transition).toEqual(fade(1))
    // Increasing trims more.
    const s = setTransition(r, "b", fade(3))
    expect(clip(s, "a").out).toBe(8.5)
    expect(clip(s, "b").in).toBe(1.5)
  })

  it("clamps to the range", () => {
    expect(clip(setTransition(tight(), "b", fade(9)), "b").transition).toEqual(fade(3))
    expect(clip(setTransition(tight(), "b", fade(0.01)), "b").transition).toEqual(fade(0.1))
  })

  it("never trims stills", () => {
    const q = setTransition(stills(), "x", fade(3.2))
    expect(q.tracks[0].clips.map((c) => [c.in, c.out, c.start])).toEqual([[0, 1.6, 0], [0, 1.6, 1.6]])
    expect(clip(q, "x").transition).toEqual(fade(3.2))
  })

  it("a chain of three: the cuts planned one after the other stay valid", () => {
    const p = setTransition(setTransition(tight(), "b", fade(2)), "c", fade(2))
    // b (2 s long after the first) gives 1 s to each cut; b has 7 s past its out and c 2 s before its in: no trims for the second.
    expect(clip(p, "b")).toMatchObject({ in: 1, out: 3, start: 2, transition: fade(2) })
    expect(clip(p, "c")).toMatchObject({ in: 2, start: 4, transition: fade(2) })
    expect(clip(p, "d").start).toBe(10)
    // b is used up: no longer fade into b fits.
    expect(transitionRange(p, "b").max).toBe(2)
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  it("on a snapped base the ripple is the same as packing again", () => {
    const p = setBaseMagnetic(tight(), true)
    const q = setTransition(p, "b", fade(2))
    expect(packBase(q)).toBe(q)
    expect(clip(q, "d").start).toBe(7)
  })

  it("undo takes the trims and the ripple back in one step", () => {
    let h = createHistory<Edit>({ tracks: tight().tracks })
    const q = applyCut(tight(), "b", { transition: fade(2), cutAudio: null })
    h = commit(h, { tracks: q.tracks })
    h = undo(h)
    expect(h.present.tracks).toEqual(tight().tracks)
  })

  it("parse still drops a transition whose clip lost its neighbour", () => {
    const q = setTransition(tight(), "b", fade(2))
    const raw = JSON.parse(JSON.stringify(q)) as Project
    raw.tracks[0].clips[0].out = 8.5
    expect(clip(parseProject(raw)!, "b").transition).toBeUndefined()
  })
})

describe("cutAudioRange and cutAudioPlan", () => {
  it("trims the incoming clip's head for a J and the outgoing clip's tail for an L", () => {
    expect(cutAudioRange(tight(), "b")).toMatchObject({ j: { max: 2.8, reason: "ok", limit: "incoming" }, l: { max: 2.8, reason: "ok", limit: "outgoing" } })
    const jp = cutAudioPlan(tight(), "b", { mode: "j", duration: 1.5 })
    expect(jp.ok && jp.trims).toEqual({ outgoing: 0, incoming: 1.5, ripple: 1.5 })
    const q = setCutAudio(tight(), "b", { mode: "j", duration: 1.5 })
    expect(clip(q, "b")).toMatchObject({ in: 1.5, out: 3, start: 3, cutAudio: { mode: "j", duration: 1.5 } })
    expect(clip(q, "c").start).toBe(4.5)
    const r = setCutAudio(tight(), "b", { mode: "l", duration: 1.5 })
    expect(clip(r, "a")).toMatchObject({ out: 8.5 })
    expect(clip(r, "b")).toMatchObject({ in: 0, start: 1.5, cutAudio: { mode: "l", duration: 1.5 } })
    expect(clip(r, "c").start).toBe(4.5)
  })

  it("still needs sound: nothing to trim for a still", () => {
    const p: Project = { ...tight(), tracks: [{ id: "t1", clips: [{ id: "a", asset: "v", in: 7, out: 10, start: 0 }, { id: "i", asset: "i", in: 0, out: 3, start: 3 }] }] }
    expect(cutAudioRange(p, "i").j).toMatchObject({ max: 0, reason: "no-audio" })
    expect(cutAudioRange(p, "i").l).toMatchObject({ max: 2.8, reason: "ok" })
  })
})

describe("applyCut and cutTrims", () => {
  it("sets the transition and the overlap in one go, and reports the trims", () => {
    const q = applyCut(tight(), "b", { transition: fade(2), cutAudio: { mode: "l", duration: 1.5 } })
    expect(clip(q, "b")).toMatchObject({ transition: fade(2), cutAudio: { mode: "l", duration: 1.5 } })
    // The L needs 1.5 s past a's out: a loses 1.5 s; b loses 1 s for the fade's half.
    expect(cutTrims(tight(), q, "b")).toEqual({ outgoing: 1.5, incoming: 1, ripple: 2.5 })
    expect(clipLength(clip(q, "a"))).toBe(1.5)
    expect(applyCut(q, "b", { transition: fade(2), cutAudio: { mode: "l", duration: 1.5 } })).toEqual(q)
  })
})
