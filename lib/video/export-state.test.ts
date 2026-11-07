import { describe, expect, it } from "vitest"
import { exportFingerprint } from "./export-state"
import { newProject, removeAsset, type Project } from "./project"
import type { ClipText } from "./text"

function project(): Project {
  return {
    ...newProject("Holiday"),
    assets: {
      a: { file: "a.mp4", duration: 10, hasAudio: true },
      i: { file: "photo.jpg", duration: 5, hasAudio: false, kind: "image" },
    },
    tracks: [
      { id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 4, start: 0 }, { id: "c2", asset: "i", in: 0, out: 3, start: 4 }] },
      { id: "t2", clips: [{ id: "o1", asset: "a", in: 1, out: 2, start: 2 }] },
    ],
  }
}

const IDENTITY_LIKE = { x: 0, y: 0, scale: 1, cropTop: 0, cropBottom: 0 }

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
    const muted = { ...p, tracks: [p.tracks[0], { ...p.tracks[1], clips: p.tracks[1].clips.map((c) => ({ ...c, muted: true })) }] }
    const otherFile = { ...p, assets: { ...p.assets, a: { ...p.assets.a, file: "b.mp4" } } }
    const fps = { ...p, fps: 25 }
    const size = { ...p, width: 1280, height: 720 }
    const layers = { ...p, tracks: [...p.tracks].reverse() }
    const gap = { ...p, tracks: [{ ...p.tracks[0], clips: [p.tracks[0].clips[0], { ...p.tracks[0].clips[1], start: 5 }] }, p.tracks[1]] }
    for (const changed of [trimmed, moved, reordered, muted, otherFile, fps, size, layers, gap]) expect(exportFingerprint(changed)).not.toBe(base)
  })

  it("is unchanged by renaming the project or importing an unused asset", () => {
    const base = exportFingerprint(project())
    const p = project()
    expect(exportFingerprint({ ...p, name: "Renamed" })).toBe(base)
    expect(exportFingerprint({ ...p, assets: { ...p.assets, z: { file: "unused.mp4", duration: 3, hasAudio: true } } })).toBe(base)
  })

  it("changes with a clip's transform, and treats an identity transform like none", () => {
    const p = project()
    const withT = (t: object) => ({ ...p, tracks: [{ ...p.tracks[0], clips: [{ ...p.tracks[0].clips[0], transform: t }, p.tracks[0].clips[1]] }, p.tracks[1]] }) as Project
    const half = { x: 0, y: 0, scale: 0.5, cropTop: 0, cropBottom: 0 }
    expect(exportFingerprint(withT(half))).not.toBe(exportFingerprint(p))
    expect(exportFingerprint(withT({ ...half, scale: 0.6 }))).not.toBe(exportFingerprint(withT(half)))
    expect(exportFingerprint(withT({ ...half, cropBottom: 0.1 }))).not.toBe(exportFingerprint(withT(half)))
    expect(exportFingerprint(withT({ x: 0, y: 0, scale: 1, cropTop: 0, cropBottom: 0 }))).toBe(exportFingerprint(p))
    expect(exportFingerprint(withT({ ...half, cropLeft: 0.1 }))).not.toBe(exportFingerprint(withT(half)))
    expect(exportFingerprint(withT({ ...half, cropRight: 0.1 }))).not.toBe(exportFingerprint(withT({ ...half, cropLeft: 0.1 })))
    expect(exportFingerprint(withT({ ...half, cropLeft: 0, cropRight: 0 }))).toBe(exportFingerprint(withT(half)))
    expect(exportFingerprint(withT({ ...IDENTITY_LIKE, cropLeft: 0 }))).toBe(exportFingerprint(p))
  })

  it("changes with a rotation or a flip, and treats zero and false like none", () => {
    const p = project()
    const withT = (t: object) => ({ ...p, tracks: [{ ...p.tracks[0], clips: [{ ...p.tracks[0].clips[0], transform: t }, p.tracks[0].clips[1]] }, p.tracks[1]] }) as Project
    const half = { x: 0, y: 0, scale: 0.5, cropTop: 0, cropBottom: 0 }
    const prints = [half, { ...half, rotation: 30 }, { ...half, rotation: -30 }, { ...half, flipH: true }, { ...half, flipV: true }].map((t) => exportFingerprint(withT(t)))
    expect(new Set(prints).size).toBe(prints.length)
    expect(exportFingerprint(withT({ ...half, rotation: 0, flipH: false, flipV: false }))).toBe(exportFingerprint(withT(half)))
    expect(exportFingerprint(withT({ ...IDENTITY_LIKE, rotation: 0, flipH: false }))).toBe(exportFingerprint(p))
    expect(exportFingerprint(withT({ ...IDENTITY_LIKE, flipV: true }))).not.toBe(exportFingerprint(p))
  })

  it("changes when a used asset is removed from the project (its clips go too), not for an unused one", () => {
    const p = project()
    expect(exportFingerprint(removeAsset(p, "a").project)).not.toBe(exportFingerprint(p))
    const unused = { ...p, assets: { ...p.assets, z: { file: "unused.mp4", duration: 3, hasAudio: true } } }
    expect(exportFingerprint(removeAsset(unused, "z").project)).toBe(exportFingerprint(p))
  })

  it("treats a video asset with no kind like one with kind video", () => {
    const p = project()
    expect(exportFingerprint({ ...p, assets: { ...p.assets, a: { ...p.assets.a, kind: "video" } } })).toBe(exportFingerprint(p))
  })

  it("changes with a text clip's content, colour and orientation, and ignores its empty asset", () => {
    const text = { content: "Hi", color: "#ffffff", orientation: "horizontal" as const }
    const withText = (t: ClipText = text): Project => {
      const p = project()
      return { ...p, tracks: [p.tracks[0], { ...p.tracks[1], clips: [...p.tracks[1].clips, { id: "x", asset: "", in: 0, out: 2, start: 5, text: t }] }] }
    }
    const base = exportFingerprint(withText())
    expect(base).not.toBe(exportFingerprint(project()))
    expect(exportFingerprint(withText())).toBe(base)
    for (const t of [{ ...text, content: "Ho" }, { ...text, color: "#ff0000" }, { ...text, orientation: "vertical" as const }]) expect(exportFingerprint(withText(t))).not.toBe(base)
    // The font counts; a text with none (Mono) keeps the fingerprint it had before fonts.
    const anton = exportFingerprint(withText({ ...text, font: "anton" }))
    expect(anton).not.toBe(base)
    expect(exportFingerprint(withText({ ...text, font: "pacifico" }))).not.toBe(anton)
    expect(exportFingerprint(withText({ ...text, font: undefined }))).toBe(base)
  })
})
