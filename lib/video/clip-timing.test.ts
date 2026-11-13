import { describe, expect, it } from "vitest"
import { setClipTiming, type TimingResult } from "./clip-timing"
import { MAX_IMAGE, MAX_TIMELINE, MIN_CLIP, newProject, type Clip, type Project } from "./project"

/** Layer 1: image p at 2-6, video v (source 0-10) at 8-12 (in 1), image q at 14-16. Layer 2: image o at 0-20. */
function sample(): Project {
  return {
    ...newProject("demo"),
    assets: {
      i: { file: "i.jpg", duration: 5, hasAudio: false, kind: "image" },
      a: { file: "a.mp4", duration: 10, hasAudio: true },
    },
    tracks: [
      {
        id: "t1",
        clips: [
          { id: "p", asset: "i", in: 0, out: 4, start: 2 },
          { id: "v", asset: "a", in: 1, out: 5, start: 8 },
          { id: "q", asset: "i", in: 0, out: 2, start: 14 },
        ],
      },
      { id: "t2", clips: [{ id: "o", asset: "i", in: 0, out: 20, start: 0 }] },
    ],
  }
}

let n = 0
const ids = () => `n${++n}`

function ok(r: TimingResult): Project {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`)
  return r.project
}

const spans = (p: Project, track = 0) => p.tracks[track].clips.map((c) => [c.id, c.start, c.in, c.out])

describe("setClipTiming: push", () => {
  it("makes an image longer, keeping its start; a clip it now reaches is pushed by the overlap and the gaps after it stay", () => {
    const p = ok(setClipTiming(sample(), "p", { start: 2, length: 7 }, "push", ids))
    // p ends at 9; v moves from 8 to 9, q keeps its 2 s gap after v.
    expect(spans(p)).toEqual([["p", 2, 0, 7], ["v", 9, 1, 5], ["q", 15, 0, 2]])
  })

  it("makes an image longer into a gap without moving anything", () => {
    const p = ok(setClipTiming(sample(), "p", { start: 2, length: 6 }, "push", ids))
    expect(spans(p)).toEqual([["p", 2, 0, 6], ["v", 8, 1, 5], ["q", 14, 0, 2]])
  })

  it("makes an image shorter without pulling the later clips back", () => {
    const p = ok(setClipTiming(sample(), "p", { start: 2, length: 1 }, "push", ids))
    expect(spans(p)).toEqual([["p", 2, 0, 1], ["v", 8, 1, 5], ["q", 14, 0, 2]])
  })

  it("moves the start forward keeping the length, pushing what it then covers", () => {
    const p = ok(setClipTiming(sample(), "p", { start: 6, length: 4 }, "push", ids))
    expect(spans(p)).toEqual([["p", 6, 0, 4], ["v", 10, 1, 5], ["q", 16, 0, 2]])
  })

  it("moves the start back into free room", () => {
    const p = ok(setClipTiming(sample(), "p", { start: 0, length: 4 }, "push", ids))
    expect(spans(p)).toEqual([["p", 0, 0, 4], ["v", 8, 1, 5], ["q", 14, 0, 2]])
  })

  it("refuses a start that lands on an earlier clip (push only moves later media)", () => {
    const r = setClipTiming(sample(), "v", { start: 5, length: 4 }, "push", ids)
    expect(r.ok).toBe(false)
  })

  it("refuses a push that would end past MAX_TIMELINE", () => {
    const p = sample()
    p.tracks[0].clips[2] = { ...p.tracks[0].clips[2], start: MAX_TIMELINE - 2 }
    expect(setClipTiming(p, "p", { start: 2, length: 7 }, "push", ids).ok).toBe(false)
  })
})

describe("setClipTiming: overwrite", () => {
  it("trims the tail of the clip before when the start moves back over it", () => {
    const p = ok(setClipTiming(sample(), "q", { start: 11, length: 2 }, "overwrite", ids))
    // v ran 8-12 (source 1-5); now 8-11 (source 1-4).
    expect(spans(p)).toEqual([["p", 2, 0, 4], ["v", 8, 1, 4], ["q", 11, 0, 2]])
  })

  it("trims the head of a later clip by its source so playback stays continuous", () => {
    const p = ok(setClipTiming(sample(), "p", { start: 2, length: 7 }, "overwrite", ids))
    expect(spans(p)).toEqual([["p", 2, 0, 7], ["v", 9, 2, 5], ["q", 14, 0, 2]])
  })

  it("splits a long video clip the new range sits inside, keeping both outer pieces", () => {
    const p = ok(setClipTiming(sample(), "q", { start: 9, length: 2 }, "overwrite", () => "piece"))
    expect(spans(p)).toEqual([["p", 2, 0, 4], ["v", 8, 1, 2], ["q", 9, 0, 2], ["piece", 11, 4, 5]])
  })

  it("splits an image clip into two image pieces, both starting at source 0, keeping transform and mute", () => {
    const base = sample()
    base.tracks[0].clips[0] = { ...base.tracks[0].clips[0], out: 6, transform: { x: 0.1, y: 0, scale: 1, cropTop: 0, cropBottom: 0 }, muted: true }
    const p = ok(setClipTiming(base, "v", { start: 4, length: 1 }, "overwrite", () => "piece"))
    const [left, , right] = p.tracks[0].clips
    expect([left.id, left.start, left.in, left.out]).toEqual(["p", 2, 0, 2])
    expect([right.id, right.start, right.in, right.out]).toEqual(["piece", 5, 0, 3])
    expect(right.transform).toEqual(left.transform)
    expect(right.muted).toBe(true)
  })

  it("removes a clip the new range fully covers", () => {
    const p = ok(setClipTiming(sample(), "p", { start: 2, length: 11 }, "overwrite", ids))
    expect(spans(p)).toEqual([["p", 2, 0, 11], ["q", 14, 0, 2]])
  })

  it("drops a leftover piece shorter than MIN_CLIP", () => {
    const p = ok(setClipTiming(sample(), "p", { start: 2, length: 9.9 }, "overwrite", ids))
    expect(spans(p)).toEqual([["p", 2, 0, 9.9], ["q", 14, 0, 2]])
  })
})

describe("setClipTiming: snapped layer 1", () => {
  const snapped = () => {
    const p = sample()
    p.tracks[0] = { ...p.tracks[0], magnetic: true, clips: [{ id: "p", asset: "i", in: 0, out: 4, start: 0 }, { id: "v", asset: "a", in: 1, out: 5, start: 4 }, { id: "q", asset: "i", in: 0, out: 2, start: 8 }] }
    return p
  }

  it("ripples a length change through the clips after it, whatever the mode", () => {
    for (const mode of ["push", "overwrite"] as const) {
      const p = ok(setClipTiming(snapped(), "p", { start: 0, length: 6 }, mode, ids))
      expect(spans(p)).toEqual([["p", 0, 0, 6], ["v", 6, 1, 5], ["q", 10, 0, 2]])
      expect(p.tracks[0].magnetic).toBe(true)
    }
    const shorter = ok(setClipTiming(snapped(), "q", { start: 8, length: 1 }, "push", ids))
    expect(spans(shorter).at(-1)).toEqual(["q", 8, 0, 1])
  })

  it("refuses a different start (the position comes from packing)", () => {
    expect(setClipTiming(snapped(), "v", { start: 5, length: 4 }, "push", ids).ok).toBe(false)
  })
})

describe("setClipTiming: input checks", () => {
  it("refuses bad numbers, an unknown clip and lengths out of range", () => {
    const p = sample()
    for (const t of [
      { start: -1, length: 2 },
      { start: NaN, length: 2 },
      { start: 2, length: Infinity },
      { start: 2, length: MIN_CLIP - 0.01 },
      { start: 2, length: MAX_IMAGE + 1 },
      { start: MAX_TIMELINE - 1, length: 2 },
    ]) expect(setClipTiming(p, "p", t, "push", ids).ok).toBe(false)
    expect(setClipTiming(p, "nope", { start: 2, length: 2 }, "push", ids).ok).toBe(false)
    // A video can't run past its source.
    expect(setClipTiming(p, "v", { start: 8, length: 9.5 }, "overwrite", ids).ok).toBe(false)
  })

  it("gives back the same project when nothing changes", () => {
    const p = sample()
    expect(ok(setClipTiming(p, "p", { start: 2, length: 4 }, "push", ids))).toBe(p)
  })
})

describe("setClipTiming: what stays", () => {
  it("never touches other layers, keeps ids and the clip's own fields, and doesn't change its input", () => {
    const p = sample()
    const before = JSON.stringify(p)
    for (const mode of ["push", "overwrite"] as const) {
      const next = ok(setClipTiming(p, "p", { start: 3, length: 8 }, mode, ids))
      expect(next.tracks[1]).toBe(p.tracks[1])
      expect(next.assets).toBe(p.assets)
      const keep: Clip = next.tracks[0].clips.find((c) => c.id === "p")!
      expect(keep).toEqual({ id: "p", asset: "i", in: 0, out: 8, start: 3 })
      for (const c of next.tracks[0].clips) expect(["p", "v", "q"]).toContain(c.id)
    }
    expect(JSON.stringify(p)).toBe(before)
  })
})

describe("setClipTiming: text clips", () => {
  const text = { content: "Hi", color: "#ffffff", orientation: "horizontal" as const }
  const withText = (): Project => {
    const p = sample()
    return { ...p, tracks: [{ ...p.tracks[0], clips: [{ id: "x", asset: "", in: 0, out: 1, start: 0, text }, ...p.tracks[0].clips] }, p.tracks[1]] }
  }

  it("sets a text clip's length like an image's (no source limit) and pushes what it reaches", () => {
    const p = ok(setClipTiming(withText(), "x", { start: 0, length: 3 }, "push", ids))
    expect(spans(p)).toEqual([["x", 0, 0, 3], ["p", 3, 0, 4], ["v", 9, 1, 5], ["q", 15, 0, 2]])
    expect(p.tracks[0].clips[0].text).toEqual(text)
    expect(setClipTiming(withText(), "x", { start: 0, length: MAX_IMAGE + 1 }, "push", ids).ok).toBe(false)
  })

  it("cuts a text clip it overwrites like an image, splitting one with the text on both pieces", () => {
    const p = withText()
    const long = ok(setClipTiming(p, "x", { start: 0, length: 1.5 }, "push", ids))
    const wide = { ...long, tracks: [{ ...long.tracks[0], clips: [{ ...long.tracks[0].clips[0], out: 2 }] }, long.tracks[1]] }
    // Image o on layer 2 is unrelated; overwrite the middle of x with p moved onto it.
    const r = ok(setClipTiming({ ...wide, tracks: [{ ...wide.tracks[0], clips: [...wide.tracks[0].clips, { id: "p", asset: "i", in: 0, out: 1, start: 4 }] }, wide.tracks[1]] }, "p", { start: 0.5, length: 1 }, "overwrite", () => "n"))
    expect(spans(r)).toEqual([["x", 0, 0, 0.5], ["p", 0.5, 0, 1], ["n", 1.5, 0, 0.5]])
    expect(r.tracks[0].clips[2].text).toEqual(text)
  })
})

describe("setClipTiming: source in-point", () => {
  it("slides a video's source window: in and out move together, start and length stay", () => {
    const p = ok(setClipTiming(sample(), "v", { start: 8, length: 4, in: 3 }, "push", ids))
    expect(spans(p)).toEqual([["p", 2, 0, 4], ["v", 8, 3, 7], ["q", 14, 0, 2]])
  })

  it("crops the source's start and end without moving the clip on the timeline", () => {
    const p = ok(setClipTiming(sample(), "v", { start: 8, length: 2.5, in: 2 }, "push", ids))
    expect(spans(p)).toEqual([["p", 2, 0, 4], ["v", 8, 2, 4.5], ["q", 14, 0, 2]])
  })

  it("is the same project when the in-point and timing are unchanged", () => {
    const p = sample()
    expect(ok(setClipTiming(p, "v", { start: 8, length: 4, in: 1 }, "push", ids))).toBe(p)
  })

  it("refuses an in-point before 0, not a number, or a window past the source's end", () => {
    const p = sample()
    for (const t of [
      { start: 8, length: 4, in: -0.1 },
      { start: 8, length: 4, in: NaN },
      { start: 8, length: 4, in: 6.5 },
      { start: 8, length: MIN_CLIP - 0.01, in: 2 },
    ]) expect(setClipTiming(p, "v", t, "push", ids).ok).toBe(false)
    // Exactly to the end is fine.
    expect(ok(setClipTiming(p, "v", { start: 8, length: 4, in: 6 }, "push", ids)).tracks[0].clips[1]).toMatchObject({ in: 6, out: 10 })
  })

  it("pushes or overwrites what a longer window reaches", () => {
    const pushed = ok(setClipTiming(sample(), "v", { start: 8, length: 7, in: 0 }, "push", ids))
    expect(spans(pushed)).toEqual([["p", 2, 0, 4], ["v", 8, 0, 7], ["q", 15, 0, 2]])
    const cut = ok(setClipTiming(sample(), "v", { start: 8, length: 7, in: 0 }, "overwrite", ids))
    expect(spans(cut)).toEqual([["p", 2, 0, 4], ["v", 8, 0, 7], ["q", 15, 0, 1]])
  })

  it("ripples the clips after it on a snapped layer 1", () => {
    const p = sample()
    p.tracks[0] = { ...p.tracks[0], magnetic: true, clips: [{ id: "p", asset: "i", in: 0, out: 4, start: 0 }, { id: "v", asset: "a", in: 1, out: 5, start: 4 }, { id: "q", asset: "i", in: 0, out: 2, start: 8 }] }
    const r = ok(setClipTiming(p, "v", { start: 4, length: 6, in: 0 }, "overwrite", ids))
    expect(spans(r)).toEqual([["p", 0, 0, 4], ["v", 4, 0, 6], ["q", 10, 0, 2]])
  })

  it("sets an audio clip's window on the audio layer and leaves the other layers alone", () => {
    const base = sample()
    const p: Project = {
      ...base,
      assets: { ...base.assets, s: { file: "s.wav", duration: 6, hasAudio: true, kind: "audio" } },
      audioTrack: { id: "audio", clips: [{ id: "s1", asset: "s", in: 0, out: 6, start: 1 }] },
    }
    const r = ok(setClipTiming(p, "s1", { start: 1, length: 2, in: 3.5 }, "push", ids))
    expect(r.audioTrack!.clips).toEqual([{ id: "s1", asset: "s", in: 3.5, out: 5.5, start: 1 }])
    expect(r.tracks).toBe(p.tracks)
    expect(setClipTiming(p, "s1", { start: 1, length: 3, in: 3.5 }, "push", ids).ok).toBe(false)
  })

  it("ignores an in-point on an image (it has no source window)", () => {
    const p = ok(setClipTiming(sample(), "p", { start: 2, length: 3, in: 2 }, "push", ids))
    expect(p.tracks[0].clips[0]).toEqual({ id: "p", asset: "i", in: 0, out: 3, start: 2 })
  })
})

describe("setClipTiming on a looping clip", () => {
  const p: Project = {
    ...newProject("l"),
    assets: { a: { file: "a.mp4", duration: 0.1, hasAudio: false } },
    tracks: [{ id: "t1", clips: [{ id: "c", asset: "a", in: 0, out: 3, start: 0, loop: true }] }],
  }
  it("refuses a length beyond 500 repeats of the source", () => {
    expect(setClipTiming(p, "c", { start: 0, length: 51 }, "push", () => "n").ok).toBe(false)
    expect(setClipTiming(p, "c", { start: 0, length: 50 }, "push", () => "n").ok).toBe(true)
  })
})
