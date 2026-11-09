import { describe, expect, it } from "vitest"
import { setClipTiming, LINKED } from "./clip-timing"
import { chainKey } from "./group-lock"
import { brokenLinks, moveClip, newProject, parseProject, splitClip, trimClip, type Clip, type Project } from "./project"
import { AUDIO_TRANSITION_TYPES, MAX_TRANSITION } from "./transition-types"
import {
  AUDIO_TRANSITION_GROUPS, AUDIO_TRANSITION_INFO, cutAudioRange, cutsOf, isLinked, laneClipAt, linkedChain, moveGroup, setTransition, transitionAt, transitionName, transitionPlan, transitionRange, unlinkClip,
} from "./transitions"

/** The audio layer: three 4 s cuts of a 30 s sound file, end to end from 2 (sources 2-6, 8-12, 14-18), then a gap and a fourth at 20. */
function sample(): Project {
  return {
    ...newProject("a"),
    assets: { m: { file: "m.wav", duration: 30, hasAudio: true, kind: "audio" }, v: { file: "v.mp4", duration: 20, hasAudio: true } },
    tracks: [{ id: "t1", clips: [{ id: "v1", asset: "v", in: 0, out: 4, start: 0 }] }],
    audioTrack: {
      id: "audio",
      clips: [
        { id: "a", asset: "m", in: 2, out: 6, start: 2 },
        { id: "b", asset: "m", in: 8, out: 12, start: 6 },
        { id: "c", asset: "m", in: 14, out: 18, start: 10 },
        { id: "d", asset: "m", in: 20, out: 24, start: 20 },
      ],
    },
  }
}

const audio = (p: Project) => p.audioTrack?.clips ?? []
const clip = (p: Project, id: string) => audio(p).find((c) => c.id === id) as Clip
const eq = (duration = 1) => ({ type: "audio-equalpower" as const, duration })

describe("catalogue", () => {
  it("names and groups every audio type", () => {
    for (const t of AUDIO_TRANSITION_TYPES) {
      expect(AUDIO_TRANSITION_INFO[t].name).toBeTruthy()
      expect(AUDIO_TRANSITION_GROUPS).toContain(AUDIO_TRANSITION_INFO[t].group)
      expect(transitionName(t)).toBe(AUDIO_TRANSITION_INFO[t].name)
    }
    expect(transitionName("fade")).toBe("Crossfade")
  })
})

describe("audio transitions between adjoining audio clips", () => {
  it("are found at the cuts, as on a picture layer", () => {
    expect(cutsOf(sample(), "b")).toEqual({ before: "b", after: "c" })
    expect(cutsOf(sample(), "d")).toEqual({ before: null, after: null })
  })

  it("take audio types only; no audio overlap there", () => {
    const p = sample()
    expect(setTransition(p, "b", { type: "fade", duration: 1 })).toBe(p)
    expect(clip(setTransition(p, "b", { type: "audio-tapestop", duration: 2 }), "b").transition).toEqual({ type: "audio-tapestop", duration: 2 })
    expect(cutAudioRange(p, "b").j.reason).toBe("not-adjoining")
  })

  it("have the same range, cap and automatic trimming with a ripple of the audio layer", () => {
    const p = sample()
    expect(transitionRange(p, "b")).toMatchObject({ max: 8, reason: "ok", limit: "outgoing" })
    const long: Project = { ...p, audioTrack: { id: "audio", clips: [{ id: "x", asset: "m", in: 0, out: 14, start: 0 }, { id: "y", asset: "m", in: 16, out: 30, start: 14 }] } }
    expect(transitionRange(long, "y").max).toBe(MAX_TRANSITION)
    // No handle before a's in: 2 s here; a 6 s crossfade into b trims b's in by 1 s and the layer ripples back.
    const tight: Project = { ...p, audioTrack: { id: "audio", clips: [{ id: "a", asset: "m", in: 0, out: 4, start: 0 }, { id: "b", asset: "m", in: 2, out: 8, start: 4 }, { id: "c", asset: "m", in: 20, out: 24, start: 12 }] } }
    const plan = transitionPlan(tight, "b", eq(6))
    expect(plan.ok && plan.trims).toEqual({ outgoing: 0, incoming: 1, ripple: 1 })
    if (!plan.ok) throw new Error("plan")
    expect(clip(plan.project, "b")).toMatchObject({ in: 3, start: 4, transition: eq(6) })
    expect(clip(plan.project, "c").start).toBe(11)
    // The picture layers stay put.
    expect(plan.project.tracks).toBe(tight.tracks)
  })

  it("link the clips into a chain that moves along the audio layer only", () => {
    const p = setTransition(setTransition(sample(), "b", eq()), "c", eq())
    expect(linkedChain(p, "a")).toEqual(["a", "b", "c"])
    expect(isLinked(p, "d")).toBe(false)
    const moved = moveGroup(p, "b", 25, 1)
    expect(audio(moved).map((c) => [c.id, c.start])).toEqual([["d", 20], ["a", 25], ["b", 29], ["c", 33]])
    expect(moved.tracks).toBe(p.tracks)
    // The group lock keys an audio chain like any other.
    expect(chainKey(linkedChain(p, "c"))).toBe(chainKey(["a", "b", "c"]))
  })

  it("part like picture links: moving a clip away drops the link, Edit length refuses to part them", () => {
    const p = setTransition(sample(), "b", eq())
    const away = moveClip(p, "b", 0, { start: 30 })
    expect(clip(away, "b").transition).toBeUndefined()
    expect(brokenLinks(p, away)).toEqual(["b"])
    const r = setClipTiming(p, "a", { start: 0, length: 3 }, "push", () => "n")
    expect(!r.ok && r.error).toBe(LINKED)
    expect(clip(unlinkClip(p, "a"), "b").transition).toBeUndefined()
  })

  it("splitting keeps the outer sides; trimming the outer edge re-clamps", () => {
    const p = setTransition(sample(), "b", eq(2))
    const split = splitClip(p, "b", 8, "b2")
    expect(clip(split, "b").transition).toEqual(eq(2))
    const q = setTransition(sample(), "c", eq(2))
    expect(clip(trimClip(q, "c", "out", 15), "c").transition).toEqual(eq(2))
  })

  it("play back like picture ones: the window is centred on the cut", () => {
    const p = setTransition(sample(), "b", eq(2))
    const track = p.audioTrack!
    expect(transitionAt(track, 5.5)).toMatchObject({ from: 0, to: 1, cut: 6, progress: 0.25 })
    expect(laneClipAt(track, 5.5)).toEqual({ index: 1, start: 6, sourceTime: 7.5 })
  })

  it("parse keeps audio types on the audio layer and drops picture ones there (and audio ones elsewhere)", () => {
    const p = setTransition(sample(), "b", eq())
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    const forged = { ...sample(), tracks: [{ id: "t1", clips: [{ id: "v1", asset: "v", in: 0, out: 4, start: 0 }, { id: "v2", asset: "v", in: 6, out: 8, start: 4, transition: eq() }] }] }
    expect(parseProject(forged)!.tracks[0].clips[1].transition).toBeUndefined()
    const wrong = { ...sample(), audioTrack: { id: "audio", clips: [sample().audioTrack!.clips[0], { ...sample().audioTrack!.clips[1], transition: { type: "wipeleft", duration: 1 } }] } }
    expect(clip(parseProject(wrong)!, "b").transition).toBeUndefined()
  })
})
