import { describe, expect, it } from "vitest"
import { exportFingerprint } from "./export-state"
import { newProject, type Project } from "./project"

function project(): Project {
  return {
    ...newProject("Holiday"),
    assets: {
      a: { file: "a.mp4", duration: 10, hasAudio: true },
      i: { file: "photo.jpg", duration: 5, hasAudio: false, kind: "image" },
    },
    tracks: [
      { id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 4 }, { id: "c2", asset: "i", in: 0, out: 3 }] },
      { id: "t2", clips: [{ id: "o1", asset: "a", in: 1, out: 2, start: 2 }] },
    ],
  }
}

/** The same object with every key in reverse order, deeply. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]))
  return value
}

describe("exportFingerprint", () => {
  it("is a SHA-256 hex string, the same for the same project", () => {
    expect(exportFingerprint(project())).toMatch(/^[0-9a-f]{64}$/)
    expect(exportFingerprint(project())).toBe(exportFingerprint(project()))
  })

  it("doesn't depend on key order", () => {
    expect(exportFingerprint(reversed(project()) as Project)).toBe(exportFingerprint(project()))
  })

  it("changes with a trim, a move, a mute toggle, a different asset file and fps", () => {
    const base = exportFingerprint(project())
    const p = project()
    const trimmed = { ...p, tracks: [{ ...p.tracks[0], clips: [{ ...p.tracks[0].clips[0], out: 3.5 }, p.tracks[0].clips[1]] }, p.tracks[1]] }
    const moved = { ...p, tracks: [p.tracks[0], { ...p.tracks[1], clips: [{ ...p.tracks[1].clips[0], start: 6 }] }] }
    const reordered = { ...p, tracks: [{ ...p.tracks[0], clips: [...p.tracks[0].clips].reverse() }, p.tracks[1]] }
    const muted = { ...p, tracks: [p.tracks[0], { ...p.tracks[1], muted: true }] }
    const otherFile = { ...p, assets: { ...p.assets, a: { ...p.assets.a, file: "b.mp4" } } }
    const fps = { ...p, fps: 25 }
    const size = { ...p, width: 1280, height: 720 }
    const layers = { ...p, tracks: [...p.tracks].reverse() }
    for (const changed of [trimmed, moved, reordered, muted, otherFile, fps, size, layers]) expect(exportFingerprint(changed)).not.toBe(base)
  })

  it("is unchanged by renaming the project or importing an unused asset", () => {
    const base = exportFingerprint(project())
    const p = project()
    expect(exportFingerprint({ ...p, name: "Renamed" })).toBe(base)
    expect(exportFingerprint({ ...p, assets: { ...p.assets, z: { file: "unused.mp4", duration: 3, hasAudio: true } } })).toBe(base)
  })

  it("treats a video asset with no kind like one with kind video", () => {
    const p = project()
    expect(exportFingerprint({ ...p, assets: { ...p.assets, a: { ...p.assets.a, kind: "video" } } })).toBe(exportFingerprint(p))
  })
})
