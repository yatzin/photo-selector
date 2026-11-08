import { describe, expect, it } from "vitest"
import { setClipTiming } from "./clip-timing"
import { exportFingerprint } from "./export-state"
import { allClips, mergeClientProject, moveClip, newProject, parseProject, setClipAudio, setClipMuted, splitClip, type Project } from "./project"

/** A video with sound (0-4 s), a silent video and an image on the base; a text on layer 2; a song on the audio layer. */
function project(): Project {
  return {
    ...newProject("Levels"),
    assets: {
      v: { file: "v.mp4", duration: 10, hasAudio: true },
      s: { file: "silent.mp4", duration: 10, hasAudio: false },
      i: { file: "still.png", duration: 5, hasAudio: false, kind: "image" },
      m: { file: "song.mp3", duration: 30, hasAudio: true, kind: "audio" },
    },
    tracks: [
      {
        id: "t1",
        clips: [
          { id: "c1", asset: "v", in: 0, out: 4, start: 0 },
          { id: "c2", asset: "s", in: 0, out: 2, start: 4 },
          { id: "c3", asset: "i", in: 0, out: 2, start: 6 },
        ],
      },
      { id: "t2", clips: [{ id: "x1", asset: "", in: 0, out: 2, start: 0, text: { content: "Hi", color: "#ffffff", orientation: "horizontal" } }] },
    ],
    audioTrack: { id: "audio", clips: [{ id: "a1", asset: "m", in: 3, out: 7, start: 1 }] },
  }
}
const clip = (p: Project, id: string) => allClips(p).find((c) => c.id === id)!
const LEVELS = { gainDb: 3, fx: [{ type: "telephone" as const, amount: 0.3 }, { type: "room" as const }] }

describe("setClipAudio", () => {
  it("sets levels on a video with sound and on an audio clip, and removes them", () => {
    let p = setClipAudio(project(), "c1", LEVELS)
    expect(clip(p, "c1").audio).toEqual(LEVELS)
    p = setClipAudio(p, "a1", { gainDb: -6 })
    expect(clip(p, "a1").audio).toEqual({ gainDb: -6 })
    const cleared = setClipAudio(p, "c1", undefined)
    expect("audio" in clip(cleared, "c1")).toBe(false)
    expect("audio" in clip(setClipAudio(p, "a1", { gainDb: 0, fx: [] }), "a1")).toBe(false)
  })

  it("refuses clips without sound, invalid levels and no-op changes (the same project)", () => {
    const p = project()
    for (const id of ["c2", "c3", "x1", "nope"]) expect(setClipAudio(p, id, LEVELS)).toBe(p)
    expect(setClipAudio(p, "c1", { gainDb: 30 })).toBe(p)
    expect(setClipAudio(p, "c1", { fx: [{ type: "echo" }, { type: "echo" }] })).toBe(p)
    expect(setClipAudio(p, "c1", undefined)).toBe(p)
    const q = setClipAudio(p, "c1", LEVELS)
    expect(setClipAudio(q, "c1", { ...LEVELS })).toBe(q)
  })

  it("keeps a muted clip's levels (it stays silent)", () => {
    const p = setClipAudio(setClipMuted(project(), "c1", true), "c1", LEVELS)
    expect(clip(p, "c1")).toMatchObject({ muted: true, audio: LEVELS })
  })
})

describe("audio levels through edits", () => {
  it("survive a split on both halves", () => {
    const p = splitClip(setClipAudio(project(), "c1", LEVELS), "c1", 2, "c1b")
    expect(clip(p, "c1").audio).toEqual(LEVELS)
    expect(clip(p, "c1b").audio).toEqual(LEVELS)
    const q = splitClip(setClipAudio(project(), "a1", LEVELS), "a1", 3, "a1b")
    expect(clip(q, "a1b").audio).toEqual(LEVELS)
  })

  it("survive a move to another layer and Edit length", () => {
    const p = setClipAudio(project(), "c1", LEVELS)
    expect(clip(moveClip(p, "c1", 1, { start: 5 }), "c1").audio).toEqual(LEVELS)
    const r = setClipTiming(p, "c1", { start: 0, length: 3 }, "push", () => "n")
    expect(r.ok && clip(r.project, "c1").audio).toEqual(LEVELS)
  })
})

describe("parsing audio levels", () => {
  it("reads valid levels and round-trips them", () => {
    const p = setClipAudio(setClipAudio(project(), "c1", LEVELS), "a1", { fx: [{ type: "radio" }] })
    const back = parseProject(JSON.parse(JSON.stringify(p)))!
    expect(clip(back, "c1").audio).toEqual(LEVELS)
    expect(clip(back, "a1").audio).toEqual({ fx: [{ type: "radio" }] })
  })

  it("refuses malformed levels and drops them from clips without sound", () => {
    const raw = JSON.parse(JSON.stringify(project()))
    raw.tracks[0].clips[0].audio = { gainDb: 99 }
    expect(parseProject(raw)).toBeNull()
    raw.tracks[0].clips[0].audio = { fx: [1, 2, 3, 4, 5].map(() => ({ type: "echo" })) }
    expect(parseProject(raw)).toBeNull()
    raw.tracks[0].clips[0].audio = { gainDb: 0 }
    expect("audio" in clip(parseProject(raw)!, "c1")).toBe(false)
    const silent = JSON.parse(JSON.stringify(project()))
    silent.tracks[0].clips[1].audio = LEVELS
    silent.tracks[0].clips[2].audio = LEVELS
    silent.tracks[1].clips[0].audio = LEVELS
    const parsed = parseProject(silent)!
    for (const id of ["c2", "c3", "x1"]) expect("audio" in clip(parsed, id)).toBe(false)
  })

  it("takes a client's levels through the merge, and refuses bad ones", () => {
    const stored = project()
    const client = JSON.parse(JSON.stringify(setClipAudio(stored, "c1", LEVELS)))
    expect(clip(mergeClientProject(client, stored)!, "c1").audio).toEqual(LEVELS)
    client.audioTrack.clips[0].audio = { fx: [{ type: "robot", amount: 2 }] }
    expect(mergeClientProject(client, stored)).toBeNull()
  })
})

describe("exportFingerprint with audio levels", () => {
  it("changes with the levels and stays the same without them", () => {
    const p = project()
    const base = exportFingerprint(p)
    expect(exportFingerprint(setClipAudio(p, "c1", { gainDb: 3 }))).not.toBe(base)
    expect(exportFingerprint(setClipAudio(p, "c1", { fx: [{ type: "echo", amount: 0.2 }] }))).not.toBe(exportFingerprint(setClipAudio(p, "c1", { fx: [{ type: "echo", amount: 0.3 }] })))
    expect(exportFingerprint(setClipAudio(setClipAudio(p, "c1", { gainDb: 3 }), "c1", undefined))).toBe(base)
  })
})
