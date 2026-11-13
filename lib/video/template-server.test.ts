import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { newProject, type Asset, type Clip, type Project } from "./project"

vi.mock("server-only", () => ({}))
vi.mock("./ffmpeg-server", () => ({ probeMedia: vi.fn(async () => ({ duration: 5, hasAudio: false })), probePictureSize: vi.fn(async () => ({ width: 1920, height: 1080 })) }))

import { createProject, listProjects, readProject, writeProject } from "./projects-server"
import { createTemplate, saveTemplateSlots, startFromTemplate } from "./template-server"

const tmp = path.join(os.tmpdir(), `ps-template-${process.pid}-${Date.now()}`)
process.env.PHOTOS_VIDEO_PROJECTS_DIR = path.join(tmp, "projects")
process.env.PHOTOS_TEMP_DIR = path.join(tmp, "inbox")
process.env.PHOTOS_CACHE_DIR = path.join(tmp, "cache")
afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

const assets: Record<string, Asset> = { v: { file: "v.mp4", duration: 10, hasAudio: false }, s: { file: "s.mp3", duration: 8, hasAudio: true, kind: "audio" } }
const clip = (id: string, start: number, len: number, asset: string): Clip => ({ id, asset, in: 0, out: len, start })
const dir = (...p: string[]) => path.join(tmp, "projects", "mike", ...p)
const exists = (...p: string[]) => fs.access(dir(...p)).then(() => true, () => false)

beforeEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
  await createProject("mike", "Trip")
  await fs.writeFile(dir("Trip", "assets", "v.mp4"), "video bytes")
  await fs.writeFile(dir("Trip", "assets", "s.mp3"), "sound bytes")
  await fs.writeFile(dir("Trip", "output", "old.mp4"), "an export")
  const p: Project = { ...newProject("Trip"), assets, tracks: [{ id: "t1", clips: [clip("a", 0, 5, "v")] }], audioTrack: { id: "audio", clips: [clip("m", 0, 5, "s")] } }
  await writeProject("mike", "Trip", p)
})

describe("createTemplate", () => {
  it("makes placeholders for the replaceable clips, keeps only the media the fixed clips use, and leaves the project and exports behind", async () => {
    const r = await createTemplate("mike", "Trip", { name: "Trip reel", description: " A reel ", slots: { a: "Main video" } })
    expect(r).toEqual({ folder: "Trip reel" })
    const t = await readProject("mike", "Trip reel")
    expect(t?.name).toBe("Trip reel")
    const slot = t!.template!.slots.a
    expect(t?.template).toMatchObject({ master: true, description: "A reel" })
    expect(slot.label).toBe("Main video")
    // The clip now shows an image placeholder titled with the label, the same length and place.
    const clip = t!.tracks[0].clips[0]
    expect(clip.asset).toBe(slot.asset)
    expect(t!.assets[clip.asset]).toMatchObject({ kind: "image", title: "Replace: Main video", placeholder: { label: "Main video" } })
    expect(clip).toMatchObject({ in: 0, out: 5, start: 0 })
    expect(await exists("Trip reel", "assets", t!.assets[clip.asset].file)).toBe(true)
    // The replaced video is not in the template at all; the fixed sound is.
    expect(Object.values(t!.assets).some((x) => x.file === "v.mp4")).toBe(false)
    expect(await exists("Trip reel", "assets", "v.mp4")).toBe(false)
    expect(await exists("Trip reel", "assets", "s.mp3")).toBe(true)
    expect(t!.audioTrack?.clips[0].asset).toBe("s")
    expect(await exists("Trip reel", "output", "old.mp4")).toBe(false)
    // The project itself is unchanged.
    const original = await readProject("mike", "Trip")
    expect(original?.template).toBeUndefined()
    expect(original?.tracks[0].clips[0].asset).toBe("v")
    expect(await exists("Trip", "assets", "v.mp4")).toBe(true)
    const list = await listProjects("mike")
    expect(list.find((p) => p.folder === "Trip reel")?.template).toEqual({ slots: 1, description: "A reel" })
  })

  it("a replaceable sound becomes a silent placeholder as long as the clip, and unused Project media is left out", async () => {
    const p = (await readProject("mike", "Trip"))!
    await writeProject("mike", "Trip", { ...p, assets: { ...p.assets, extra: { file: "extra.mp4", duration: 3, hasAudio: false } } })
    await fs.writeFile(dir("Trip", "assets", "extra.mp4"), "unused")
    await createTemplate("mike", "Trip", { name: "T2", slots: { m: "Music", a: "Video" } })
    const t = (await readProject("mike", "T2"))!
    const m = t.audioTrack!.clips[0]
    expect(t.assets[m.asset]).toMatchObject({ kind: "audio", title: "Replace: Music", placeholder: { label: "Music" } })
    expect(m).toMatchObject({ in: 0, out: 5 })
    expect(await exists("T2", "assets", t.assets[m.asset].file)).toBe(true)
    // Every original file is gone, the unused one too: only the two placeholders are left.
    for (const name of ["v.mp4", "s.mp3", "extra.mp4"]) expect(await exists("T2", "assets", name)).toBe(false)
    expect(Object.values(t.assets).every((x) => x.placeholder !== undefined)).toBe(true)
  })

  it("needs a slot and a free name", async () => {
    expect(await createTemplate("mike", "Trip", { name: "T", slots: { zzz: "x" } })).toEqual({ error: "Mark at least one clip as replaceable." })
    expect(await createTemplate("mike", "Trip", { name: "Trip", slots: { a: "x" } })).toHaveProperty("error")
    expect(await createTemplate("mike", "Trip", { name: "", slots: { a: "x" } })).toEqual({ error: "Invalid request." })
    expect(await createTemplate("mike", "../x", { name: "T", slots: { a: "x" } })).toEqual({ error: "Invalid request." })
  })
})

describe("startFromTemplate", () => {
  it("copies a template into an ordinary project: its replaceable clips show their placeholders and nothing marks it as a template", async () => {
    await createTemplate("mike", "Trip", { name: "Tpl", slots: { a: "Main", m: "Music" } })
    const r = await startFromTemplate("mike", "Tpl", "My trip")
    expect(r).toEqual({ folder: "My trip" })
    const p = await readProject("mike", "My trip")
    expect(p?.name).toBe("My trip")
    expect(p?.template).toBeUndefined()
    // The slots hold placeholders (with their files), not the template's original media.
    const first = p!.tracks[0].clips[0]
    expect(p!.assets[first.asset].placeholder?.label).toBe("Main")
    expect(await exists("My trip", "assets", p!.assets[first.asset].file)).toBe(true)
    expect(await exists("My trip", "assets", "v.mp4")).toBe(false)
    expect((await listProjects("mike")).find((x) => x.folder === "My trip")?.template).toBeUndefined()
  })

  it("only from a template, with a name that is free", async () => {
    expect(await startFromTemplate("mike", "Trip", "X")).toEqual({ error: "That isn't a template." })
    await createTemplate("mike", "Trip", { name: "Tpl", slots: { a: "Main" } })
    expect(await startFromTemplate("mike", "Tpl", "Trip")).toHaveProperty("error")
    expect(await startFromTemplate("mike", "Tpl", "  ")).toEqual({ error: "Enter a name first." })
  })
})

describe("saveTemplateSlots and finishTemplateFill", () => {
  it("changes a template's slots: a newly replaceable clip gets a placeholder and its media goes, a relabelled one is redrawn", async () => {
    await createTemplate("mike", "Trip", { name: "Tpl", slots: { a: "Main" } })
    const before = (await readProject("mike", "Tpl"))!
    const r = await saveTemplateSlots("mike", "Tpl", { description: "New", slots: { a: "Hero", m: "Song", zzz: "gone" } })
    if ("error" in r) throw new Error(r.error)
    const t = r.project
    expect(t.template).toMatchObject({ master: true, description: "New" })
    expect(t.template!.slots.a.label).toBe("Hero")
    expect(t.template!.slots.m.label).toBe("Song")
    expect(t.assets[t.tracks[0].clips[0].asset].placeholder?.label).toBe("Hero")
    expect(t.assets[t.audioTrack!.clips[0].asset].placeholder?.label).toBe("Song")
    expect(await exists("Tpl", "assets", "s.mp3")).toBe(false)
    // The old placeholder file for "Main" is gone; the stored project is what was returned.
    expect(await exists("Tpl", "assets", before.assets[before.tracks[0].clips[0].asset].file)).toBe(false)
    expect((await readProject("mike", "Tpl"))?.template?.slots.a.label).toBe("Hero")
    expect(await saveTemplateSlots("mike", "Trip", { slots: { a: "x" } })).toEqual({ error: "That isn't a template." })
    expect(await saveTemplateSlots("mike", "Tpl", { slots: { zzz: "x" } })).toEqual({ error: "Mark at least one clip as replaceable." })
  })
})
