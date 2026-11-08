import { describe, expect, it } from "vitest"
import {
  addClip, allClips, assetKind, AUDIO_TRACK, cutAudioLimits, mergeClientProject, moveClip, newProject, parseProject, removeAsset, removeClip, setClipMuted, setTransform, splitClip,
  totalLength, transitionLimits, trimClip, type Project,
} from "./project"
import { setClipTiming } from "./clip-timing"
import { cutsOf, setCutAudio, setTransition } from "./transitions"
import { IDENTITY } from "./transform"

/** A video on the base, two audio files, nothing on the audio layer yet. */
function sample(): Project {
  return {
    ...newProject("demo"),
    assets: {
      v: { file: "v.mp4", duration: 10, hasAudio: true },
      m: { file: "song.mp3", duration: 8, hasAudio: true, kind: "audio" },
      w: { file: "tone.wav", duration: 4, hasAudio: true, kind: "audio" },
    },
    tracks: [{ id: "t1", clips: [{ id: "c1", asset: "v", in: 0, out: 5, start: 0 }] }],
  }
}

const audio = (p: Project) => p.audioTrack?.clips ?? []

describe("audio assets", () => {
  it("are their own kind", () => {
    expect(assetKind({ file: "a.mp3", duration: 1, hasAudio: true, kind: "audio" })).toBe("audio")
    expect(assetKind({ file: "a.mp4", duration: 1, hasAudio: true })).toBe("video")
  })

  it("parse, and old projects (no audio layer) come back as they were", () => {
    const p = sample()
    const parsed = parseProject(JSON.parse(JSON.stringify(p)))!
    expect(parsed.assets.m.kind).toBe("audio")
    expect(parsed.audioTrack).toBeUndefined()
    expect(Object.keys(parsed)).toEqual(["version", "name", "width", "height", "fps", "assets", "tracks"])
  })
})

describe("the audio layer", () => {
  it("takes an audio asset dropped on any layer, at the time asked for", () => {
    const p = addClip(sample(), "m", 0, { start: 2 }, "a1")
    expect(p.tracks[0].clips.map((c) => c.id)).toEqual(["c1"])
    expect(audio(p)).toEqual([{ id: "a1", asset: "m", in: 0, out: 8, start: 2 }])
    expect(allClips(p).map((c) => c.id)).toEqual(["c1", "a1"])
    expect(totalLength(p)).toBe(10)
  })

  it("refuses a video, image or text clip", () => {
    const p = sample()
    expect(addClip(p, "v", AUDIO_TRACK, { start: 0 }, "x")).toBe(p)
    const q = addClip(p, "m", AUDIO_TRACK, { start: 0 }, "a1")
    expect(moveClip(q, "c1", AUDIO_TRACK, { start: 0 })).toBe(q)
  })

  it("keeps an audio clip on it when it's moved to another layer (moves it in time only)", () => {
    const p = addClip(sample(), "m", AUDIO_TRACK, { start: 0 }, "a1")
    const moved = moveClip(p, "a1", 1, { start: 3 })
    expect(moved.tracks.length).toBe(1)
    expect(audio(moved)).toEqual([{ id: "a1", asset: "m", in: 0, out: 8, start: 3 }])
  })

  it("follows the other layers' overlap rule: a clip slides clear", () => {
    let p = addClip(sample(), "m", AUDIO_TRACK, { start: 0 }, "a1")
    p = addClip(p, "w", AUDIO_TRACK, { start: 2 }, "a2")
    expect(audio(p).map((c) => [c.id, c.start])).toEqual([["a1", 0], ["a2", 8]])
  })

  it("splits, trims, mutes and removes audio clips", () => {
    let p = addClip(sample(), "m", AUDIO_TRACK, { start: 1 }, "a1")
    p = splitClip(p, "a1", 4, "a2")
    expect(audio(p).map((c) => [c.id, c.in, c.out, c.start])).toEqual([["a1", 0, 3, 1], ["a2", 3, 8, 4]])
    p = trimClip(p, "a2", "out", 6)
    expect(audio(p)[1].out).toBe(6)
    p = trimClip(p, "a2", "out", 20)
    expect(audio(p)[1].out).toBe(8)
    p = setClipMuted(p, "a1", true)
    expect(audio(p)[0].muted).toBe(true)
    p = removeClip(removeClip(p, "a1"), "a2")
    expect(p.audioTrack).toBeUndefined()
  })

  it("has no transform", () => {
    const p = addClip(sample(), "m", AUDIO_TRACK, { start: 0 }, "a1")
    expect(setTransform(p, "a1", { ...IDENTITY, x: 0.2 })).toBe(p)
  })

  it("offers audio transitions (no picture ones, no audio overlap) between adjoining audio clips", () => {
    let p = addClip(sample(), "w", AUDIO_TRACK, { start: 0 }, "a1")
    p = addClip(p, "w", AUDIO_TRACK, { start: 4 }, "a2")
    expect(transitionLimits(p, "a2").reason).toBe("no-footage")
    expect(cutAudioLimits(p, "a2").j.reason).toBe("not-adjoining")
    expect(cutsOf(p, "a2")).toEqual({ before: "a2", after: null })
    expect(setTransition(p, "a2", { type: "fade", duration: 1 })).toBe(p)
    expect(setCutAudio(p, "a2", { mode: "j", duration: 1 })).toBe(p)
    expect(audio(setTransition(p, "a2", { type: "audio-equalpower", duration: 1 }))[1].transition).toEqual({ type: "audio-equalpower", duration: 1 })
  })

  it("goes with its asset", () => {
    const p = addClip(sample(), "m", AUDIO_TRACK, { start: 0 }, "a1")
    const { project, removedClips } = removeAsset(p, "m")
    expect(removedClips).toBe(1)
    expect(project.audioTrack).toBeUndefined()
  })
})

describe("Edit length on an audio clip", () => {
  it("is bounded by the source's length", () => {
    const p = addClip(sample(), "m", AUDIO_TRACK, { start: 0 }, "a1")
    const short = setClipTiming(p, "a1", { start: 1, length: 3 }, "push", () => "n")
    expect(short.ok && audio(short.project)[0]).toEqual({ id: "a1", asset: "m", in: 0, out: 3, start: 1 })
    const long = setClipTiming(p, "a1", { start: 0, length: 9 }, "push", () => "n")
    expect(long.ok).toBe(false)
    expect(!long.ok && long.error).toMatch(/audio/)
  })
})

describe("parseProject and mergeClientProject with the audio layer", () => {
  const withAudio = () => addClip(sample(), "m", AUDIO_TRACK, { start: 2 }, "a1")

  it("round-trips it", () => {
    const p = withAudio()
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  it("refuses an audio clip on a video layer and a video clip on the audio layer", () => {
    const p = withAudio()
    const onVideo = { ...p, tracks: [{ id: "t1", clips: [...p.tracks[0].clips, { id: "x", asset: "m", in: 0, out: 1, start: 6 }] }] }
    expect(parseProject(onVideo)).toBeNull()
    const onAudio = { ...p, audioTrack: { id: "audio", clips: [{ id: "x", asset: "v", in: 0, out: 1, start: 0 }] } }
    expect(parseProject(onAudio)).toBeNull()
    const text = { ...p, audioTrack: { id: "audio", clips: [{ id: "x", asset: "", in: 0, out: 1, start: 0, text: { content: "Hi", color: "#ffffff", orientation: "horizontal" } }] } }
    expect(parseProject(text)).toBeNull()
  })

  it("drops a forged transition, audio overlap or transform there", () => {
    const p = withAudio()
    const forged = { ...p, audioTrack: { id: "audio", clips: [{ ...audio(p)[0], transition: { type: "fade", duration: 1 }, cutAudio: { mode: "j", duration: 1 }, transform: { ...IDENTITY, x: 0.3 } }] } }
    expect(parseProject(forged)!.audioTrack!.clips[0]).toEqual(audio(p)[0])
  })

  it("refuses overlapping clips and a duplicate id across layers", () => {
    const p = withAudio()
    expect(parseProject({ ...p, audioTrack: { id: "audio", clips: [audio(p)[0], { ...audio(p)[0], id: "a2", start: 3 }] } })).toBeNull()
    expect(parseProject({ ...p, audioTrack: { id: "audio", clips: [{ ...audio(p)[0], id: "c1" }] } })).toBeNull()
  })

  it("takes the client's audio layer and keeps the server's assets", () => {
    const stored = sample()
    const client = withAudio()
    expect(mergeClientProject(client, stored)!.audioTrack).toEqual(client.audioTrack)
    const unknown = { ...client, audioTrack: { id: "audio", clips: [{ ...audio(client)[0], asset: "nope" }] } }
    expect(mergeClientProject(unknown, stored)).toBeNull()
  })

  it("reads a client's layer mute on the audio layer as nothing", () => {
    const client = withAudio()
    const merged = mergeClientProject({ ...client, audioTrack: { ...client.audioTrack, muted: true } }, sample())!
    expect(merged.audioTrack!.clips[0].muted).toBeUndefined()
  })
})
