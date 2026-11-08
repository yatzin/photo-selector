import { describe, expect, it } from "vitest"
import { setClipTiming, LINKED } from "./clip-timing"
import { commit, createHistory, redo, undo } from "./history"
import { brokenLinks, mergeClientProject, moveClip, newProject, parseProject, removeClip, setBaseMagnetic, splitClip, trimClip, type Edit, type Project } from "./project"
import {
  cutAudioLimits, cutGains, entrySourceTime, isLinked, laneClipAt, laneElementAt, linkedChain, overlapAt, setCutAudio, setTransition, unlinkClip, unlinkCut,
} from "./transitions"

/**
 * Layer 1: three 4 s cuts of a 20 s video with sound, end to end from 0
 * (sources 2-6, 8-12, 14-18: two seconds of handle on each side), a silent
 * video's clip after a gap, an image right after it and a clip of the video
 * right after that.
 */
function sample(): Project {
  return {
    ...newProject("t"),
    assets: {
      v: { file: "v.mp4", duration: 20, hasAudio: true },
      s: { file: "s.mp4", duration: 20, hasAudio: false },
      i: { file: "i.jpg", duration: 5, hasAudio: false, kind: "image" },
    },
    tracks: [{
      id: "t1",
      clips: [
        { id: "a", asset: "v", in: 2, out: 6, start: 0 },
        { id: "b", asset: "v", in: 8, out: 12, start: 4 },
        { id: "c", asset: "v", in: 14, out: 18, start: 8 },
        { id: "s", asset: "s", in: 2, out: 6, start: 20 },
        { id: "i", asset: "i", in: 0, out: 4, start: 24 },
        { id: "e", asset: "v", in: 1, out: 5, start: 28 },
      ],
    }],
  }
}

const clip = (p: Project, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
const j = (duration = 1) => ({ mode: "j" as const, duration })
const l = (duration = 1) => ({ mode: "l" as const, duration })
const fade = (duration = 1) => ({ type: "fade" as const, duration })

describe("cutAudioLimits", () => {
  it("is the footage beyond the clip, at most the clip it overlaps and MAX_CUT_AUDIO", () => {
    // J into b: b's in point is 8, a is 4 s long: 4. L into b: a has 14 s past its out, b is 4 s long: 4.
    expect(cutAudioLimits(sample(), "b")).toEqual({ j: { max: 4, reason: "ok" }, l: { max: 4, reason: "ok" } })
    const long: Project = {
      ...newProject("t"),
      assets: { v: { file: "v.mp4", duration: 100, hasAudio: true } },
      tracks: [{ id: "t1", clips: [{ id: "a", asset: "v", in: 10, out: 30, start: 0 }, { id: "b", asset: "v", in: 0.5, out: 99, start: 20 }] }],
    }
    // J: b's 0.5 s before its in. L: capped at 10 s, a's 70 s handle notwithstanding.
    expect(cutAudioLimits(long, "b")).toEqual({ j: { max: 0.5, reason: "ok" }, l: { max: 10, reason: "ok" } })
  })

  it("needs a neighbour, sound and footage", () => {
    const p = sample()
    expect(cutAudioLimits(p, "a").j.reason).toBe("not-adjoining")
    expect(cutAudioLimits(p, "s").l.reason).toBe("not-adjoining")
    expect(cutAudioLimits(p, "nope").j).toEqual({ max: 0, reason: "not-adjoining" })
    // Into the image from a silent video: neither has sound.
    expect(cutAudioLimits(p, "i")).toEqual({ j: { max: 0, reason: "no-audio" }, l: { max: 0, reason: "no-audio" } })
    // Into e from the image: e's sound can lead (it has 1 s before its in), nothing can trail a still.
    expect(cutAudioLimits(p, "e")).toEqual({ j: { max: 1, reason: "ok" }, l: { max: 0, reason: "no-audio" } })
    // No footage before b's in point.
    const q = { ...p, tracks: [{ ...p.tracks[0], clips: p.tracks[0].clips.map((c) => (c.id === "b" ? { ...c, in: 0, out: 4 } : c)) }] }
    expect(cutAudioLimits(q, "b").j).toEqual({ max: 0, reason: "no-footage" })
  })

  it("counts a muted clip (it stays silent)", () => {
    const p = sample()
    const q = { ...p, tracks: [{ ...p.tracks[0], clips: p.tracks[0].clips.map((c) => (c.id === "b" ? { ...c, muted: true } : c)) }] }
    expect(cutAudioLimits(q, "b").j.reason).toBe("ok")
  })
})

describe("setCutAudio", () => {
  it("sets, clamps and removes", () => {
    const p = setCutAudio(sample(), "b", j(1.5))
    expect(clip(p, "b")?.cutAudio).toEqual(j(1.5))
    expect(clip(setCutAudio(sample(), "b", l(9)), "b")?.cutAudio).toEqual(l(4))
    expect(clip(setCutAudio(sample(), "b", j(0.01)), "b")?.cutAudio).toEqual(j(0.1))
    expect(clip(setCutAudio(p, "b", null), "b")?.cutAudio).toBeUndefined()
  })

  it("refuses a cut with nothing adjoining, no sound, no footage or an unknown mode, and is the same project when nothing changes", () => {
    const p = sample()
    expect(setCutAudio(p, "a", j())).toBe(p)
    expect(setCutAudio(p, "i", j())).toBe(p)
    expect(setCutAudio(p, "e", l())).toBe(p)
    expect(setCutAudio(p, "b", { mode: "x" as "j", duration: 1 })).toBe(p)
    expect(setCutAudio(p, "b", j(Number.NaN))).toBe(p)
    expect(setCutAudio(p, "b", null)).toBe(p)
    const q = setCutAudio(p, "b", j())
    expect(setCutAudio(q, "b", j())).toBe(q)
  })

  it("is independent of the cut's transition", () => {
    const p = setCutAudio(setTransition(sample(), "b", fade()), "b", l(1.5))
    expect(clip(p, "b")).toMatchObject({ transition: fade(), cutAudio: l(1.5) })
    expect(clip(setTransition(p, "b", null), "b")?.cutAudio).toEqual(l(1.5))
    expect(clip(setCutAudio(p, "b", null), "b")?.transition).toEqual(fade())
  })
})

describe("linking", () => {
  it("an audio overlap alone links the two clips", () => {
    const p = setCutAudio(sample(), "b", j())
    expect(linkedChain(p, "a")).toEqual(["a", "b"])
    expect(isLinked(p, "b")).toBe(true)
    expect(linkedChain(setTransition(p, "c", fade()), "a")).toEqual(["a", "b", "c"])
  })

  it("unlinking takes the transitions and the audio overlaps", () => {
    const p = setCutAudio(setTransition(setCutAudio(sample(), "b", j()), "c", fade()), "c", l())
    const q = unlinkClip(p, "b")
    expect(clip(q, "b")?.cutAudio).toBeUndefined()
    expect(clip(q, "c")?.transition).toBeUndefined()
    expect(clip(q, "c")?.cutAudio).toBeUndefined()
    const r = unlinkCut(p, "c")
    expect(clip(r, "b")?.cutAudio).toEqual(j())
    expect(clip(r, "c")).not.toHaveProperty("transition")
  })

  it("brokenLinks sees an audio overlap parted", () => {
    const p = setCutAudio(sample(), "b", j())
    expect(brokenLinks(p, moveClip(p, "b", 0, { start: 12 }))).toEqual(["b"])
  })

  it("Edit length refuses to part clips joined by an audio overlap", () => {
    expect(setClipTiming(setCutAudio(sample(), "c", l()), "c", { start: 9, length: 4 }, "push", () => "x")).toEqual({ ok: false, error: LINKED })
  })
})

describe("edits keep, clamp or drop audio overlaps", () => {
  it("splitting keeps the outer sides", () => {
    const p = splitClip(setCutAudio(setCutAudio(sample(), "b", j()), "c", l()), "b", 6, "b2")
    expect(clip(p, "b")?.cutAudio).toEqual(j())
    expect(clip(p, "b2")?.cutAudio).toBeUndefined()
    expect(clip(p, "c")?.cutAudio).toEqual(l())
    expect(linkedChain(p, "c")).toEqual(["b2", "c"])
  })

  it("splitting shortens an overlap to a piece's length", () => {
    // A 2 s J into c reaches back over half of b; split b 1 s before its end and the piece left is 1 s long.
    const p = splitClip(setCutAudio(sample(), "c", j(2)), "b", 7, "b2")
    expect(clip(p, "c")?.cutAudio).toEqual(j(1))
  })

  it("deleting a clip takes its overlaps, rippled on a snapped base too", () => {
    const p = setCutAudio(sample(), "c", l())
    expect(clip(removeClip(p, "b"), "c")?.cutAudio).toBeUndefined()
    expect(clip(removeClip(setBaseMagnetic(p, true), "b"), "c")?.cutAudio).toBeUndefined()
  })

  it("trimming clamps or drops it", () => {
    // L into c (2 s), then c trimmed to 1.5 s long: at most 1.5 s now.
    const p = trimClip(setCutAudio(sample(), "c", l(2)), "c", "out", 15.5)
    expect(clip(p, "c")?.cutAudio).toEqual(l(1.5))
    // J into c on a snapped base, c's left edge pulled back to its source's start: no footage before it, so it goes.
    const q = trimClip(setCutAudio(setBaseMagnetic(sample(), true), "c", j()), "c", "in", 0)
    expect(clip(q, "c")?.in).toBe(0)
    expect(clip(q, "c")?.cutAudio).toBeUndefined()
    // An inner edge parts the clips.
    expect(clip(trimClip(setCutAudio(sample(), "b", j()), "a", "out", 5), "b")?.cutAudio).toBeUndefined()
  })

  it("undo and redo bring them back with the tracks", () => {
    let h = createHistory<Edit>({ tracks: sample().tracks })
    h = commit(h, { tracks: setCutAudio(sample(), "b", j()).tracks })
    h = undo(h)
    expect(h.present.tracks[0].clips[1].cutAudio).toBeUndefined()
    h = redo(h)
    expect(h.present.tracks[0].clips[1].cutAudio).toEqual(j())
  })
})

describe("parse", () => {
  const json = (p: Project) => JSON.parse(JSON.stringify(p)) as unknown

  it("reads audio overlaps back, and merge keeps a client's", () => {
    const p = setCutAudio(setTransition(sample(), "b", fade()), "b", j())
    expect(parseProject(json(p))).toEqual(p)
    expect(mergeClientProject(json(p), sample())).toEqual(p)
  })

  it("drops one with nothing adjoining and shortens an overlong one", () => {
    const p = sample()
    const raw = { ...p, tracks: [{ ...p.tracks[0], clips: p.tracks[0].clips.map((c) => (c.id === "a" ? { ...c, cutAudio: j() } : c.id === "b" ? { ...c, cutAudio: l(7) } : c)) }] }
    const q = parseProject(json(raw))!
    expect(clip(q, "a")?.cutAudio).toBeUndefined()
    expect(clip(q, "b")?.cutAudio).toEqual(l(4))
  })

  it("refuses an unknown mode or a duration out of range", () => {
    const p = sample()
    const withAudio = (cutAudio: unknown) => ({ ...p, tracks: [{ ...p.tracks[0], clips: p.tracks[0].clips.map((c) => (c.id === "b" ? { ...c, cutAudio } : c)) }] })
    expect(parseProject(json(withAudio({ mode: "x", duration: 1 }) as Project))).toBeNull()
    expect(parseProject(json(withAudio({ mode: "j", duration: 0 }) as Project))).toBeNull()
    expect(parseProject(json(withAudio({ mode: "l", duration: 11 }) as Project))).toBeNull()
    expect(parseProject(json(withAudio("j") as Project))).toBeNull()
  })
})

describe("playback helpers", () => {
  it("overlapAt widens the cut's window by a J's lead or an L's tail", () => {
    const p = setCutAudio(sample(), "b", j(1.5))
    const track = p.tracks[0]
    expect(overlapAt(track, 2.4)).toBeNull()
    expect(overlapAt(track, 2.5)).toMatchObject({ from: 0, to: 1, cut: 4, start: 2.5, end: 4, transition: null, audio: j(1.5) })
    expect(overlapAt(track, 4)).toBeNull()
    const q = setCutAudio(setTransition(sample(), "b", fade(2)), "b", l(1.5))
    // The fade runs 3-5, the L to 5.5.
    expect(overlapAt(q.tracks[0], 3)).toMatchObject({ start: 3, end: 5.5, transition: { progress: 0 } })
    expect(overlapAt(q.tracks[0], 5.2)).toMatchObject({ transition: null, audio: l(1.5) })
  })

  it("laneElementAt plays the incoming clip from a J's lead; laneClipAt still shows the outgoing picture", () => {
    const track = setCutAudio(sample(), "b", j(1.5)).tracks[0]
    expect(laneElementAt(track, 3)).toEqual({ index: 1, start: 4, sourceTime: 7 })
    expect(laneClipAt(track, 3)).toEqual({ index: 0, start: 0, sourceTime: 5 })
    expect(entrySourceTime(track, track.clips[1])).toBe(6.5)
    // A J longer than half the transition leads it.
    const both = setCutAudio(setTransition(sample(), "b", fade(1)), "b", j(1.5)).tracks[0]
    expect(entrySourceTime(both, both.clips[1])).toBe(6.5)
  })

  it("cutGains: J brings the incoming sound in early with a short fade, L keeps the outgoing on, a transition alone crossfades", () => {
    const jp = setCutAudio(sample(), "b", j(1)).tracks[0]
    const at = (track: typeof jp, t: number) => cutGains(overlapAt(track, t)!, t)
    expect(at(jp, 3)).toEqual({ out: 1, in: 0 })
    expect(at(jp, 3.075).in).toBeCloseTo(0.5)
    expect(at(jp, 3.5)).toEqual({ out: 1, in: 1 })
    const lp = setCutAudio(sample(), "b", l(1)).tracks[0]
    expect(at(lp, 4)).toEqual({ out: 1, in: 1 })
    expect(at(lp, 4.925).out).toBeCloseTo(0.5)
    // J with a 2 s fade on the same cut: the incoming sound waits for the J, the outgoing stops at the cut.
    const both = setCutAudio(setTransition(sample(), "b", fade(2)), "b", j(0.5)).tracks[0]
    expect(at(both, 3.2)).toEqual({ out: 1, in: 0 })
    expect(at(both, 4.5)).toEqual({ out: 0, in: 1 })
    const tp = setTransition(sample(), "b", fade(2)).tracks[0]
    expect(at(tp, 4).out).toBeCloseTo(Math.SQRT1_2)
    expect(at(tp, 4).in).toBeCloseTo(Math.SQRT1_2)
  })
})
