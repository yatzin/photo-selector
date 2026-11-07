import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_IMAGE, MIN_CLIP, newProject } from "./project"

vi.mock("./ffmpeg-server", () => ({ probeMedia: vi.fn(async () => ({ duration: 12.5, hasAudio: true })) }))

import { probeMedia } from "./ffmpeg-server"
import { assetPath, createProject, deleteProject, importAsset, listProjects, readProject, renameProject, reusableAsset, writeProject } from "./projects-server"

const tmp = path.join(os.tmpdir(), `ps-video-${process.pid}-${Date.now()}`)
const projects = path.join(tmp, "projects")
const inbox = path.join(tmp, "inbox")

process.env.PHOTOS_VIDEO_PROJECTS_DIR = projects
process.env.PHOTOS_VIDEO_INBOX_DIR = inbox
process.env.PHOTOS_CACHE_DIR = path.join(tmp, "cache")

afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

beforeEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(path.join(inbox, "mike", "sub"), { recursive: true })
  await fs.writeFile(path.join(inbox, "mike", "clip.mp4"), "video bytes")
  await fs.writeFile(path.join(inbox, "mike", "sub", "deep.mp4"), "deep bytes")
  await fs.writeFile(path.join(inbox, "mike", "notes.txt"), "text")
  await fs.writeFile(path.join(inbox, "mike", "photo.HEIC"), "image bytes")
})

const exists = (...p: string[]) => fs.access(path.join(...p)).then(() => true, () => false)
const user = path.join(projects, "mike")

describe("createProject", () => {
  it("makes assets, output, config/export.json and project.json", async () => {
    const r = await createProject("mike", "My Trip")
    expect(r).toEqual({ folder: "My Trip" })
    const dir = path.join(user, "My Trip")
    expect(await exists(dir, "assets")).toBe(true)
    expect(await exists(dir, "output")).toBe(true)
    expect(JSON.parse(await fs.readFile(path.join(dir, "config", "export.json"), "utf8"))).toEqual({ width: 1920, height: 1080, fps: 30 })
    expect((await readProject("mike", "My Trip"))?.name).toBe("My Trip")
  })

  it("rejects a second project that cleans to the same folder", async () => {
    await createProject("mike", "My Trip")
    expect(await createProject("mike", "My Trip")).toHaveProperty("error")
    expect(await createProject("mike", "My Trip.")).toHaveProperty("error")
    expect(await createProject("mike", "My/Trip")).toEqual({ folder: "MyTrip" })
  })

  it("keeps hostile names inside the user folder", async () => {
    for (const name of ["../x", "a/b", "trip. ", ".."]) {
      expect(await createProject("mike", name)).not.toHaveProperty("error")
    }
    expect((await fs.readdir(user)).sort()).toEqual(["Untitled", "ab", "trip", "x"])
    expect(await exists(projects, "x")).toBe(false)
    expect(await exists(tmp, "x")).toBe(false)
  })

  it("rejects a user folder that steps outside the root", async () => {
    expect(await createProject("..", "evil")).toHaveProperty("error")
    expect(await createProject("a/b", "evil")).toHaveProperty("error")
    expect(await createProject("", "evil")).toHaveProperty("error")
  })
})

describe("readProject / writeProject", () => {
  it("returns null for missing, corrupt or traversing folders", async () => {
    expect(await readProject("mike", "nope")).toBeNull()
    await createProject("mike", "Bad")
    await fs.writeFile(path.join(user, "Bad", "project.json"), "{ not json")
    expect(await readProject("mike", "Bad")).toBeNull()
    await fs.writeFile(path.join(user, "Bad", "project.json"), JSON.stringify({ version: 2 }))
    expect(await readProject("mike", "Bad")).toBeNull()
    expect(await readProject("mike", "../Bad")).toBeNull()
  })

  it("reads a version 1 file as version 3 and writes version 3 back", async () => {
    await createProject("mike", "Old v1")
    const file = path.join(user, "Old v1", "project.json")
    const clips = [{ id: "c1", asset: "a", in: 0, out: 5 }]
    await fs.writeFile(file, JSON.stringify({ version: 1, name: "Old v1", width: 1920, height: 1080, fps: 30, assets: { a: { file: "a.mp4", duration: 10, hasAudio: true } }, clips }))
    const p = await readProject("mike", "Old v1")
    expect(p?.version).toBe(3)
    expect(p?.tracks).toEqual([{ id: "t1", clips: [{ ...clips[0], start: 0 }] }])
    await writeProject("mike", "Old v1", p!)
    const saved = JSON.parse(await fs.readFile(file, "utf8"))
    expect(saved.version).toBe(3)
    expect(saved).not.toHaveProperty("clips")
    expect(saved.tracks).toEqual([{ id: "t1", clips: [{ ...clips[0], start: 0 }] }])
  })

  it("survives 20 concurrent writes with a parseable file and no .tmp", async () => {
    await createProject("mike", "Busy")
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeProject("mike", "Busy", newProject(`Busy ${i}`))))
    const p = await readProject("mike", "Busy")
    expect(p?.name).toMatch(/^Busy \d+$/)
    const files = await fs.readdir(path.join(user, "Busy"))
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([])
  })
})

describe("listProjects", () => {
  it("lists projects with clip counts and skips broken ones", async () => {
    await createProject("mike", "One")
    await createProject("mike", "Two")
    await createProject("mike", "Broken")
    await fs.writeFile(path.join(user, "Broken", "project.json"), "x")
    const p = { ...newProject("Two"), assets: { a: { file: "a.mp4", duration: 10, hasAudio: false } }, tracks: [{ id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 5, start: 0 }] }] }
    await writeProject("mike", "Two", p)
    const list = await listProjects("mike")
    expect(list.map((x) => [x.folder, x.name, x.clips]).sort()).toEqual([["One", "One", 0], ["Two", "Two", 1]])
    expect(list[0].modified).toBeGreaterThan(0)
  })

  it("is empty for a user with no projects", async () => {
    expect(await listProjects("nobody")).toEqual([])
  })
})

describe("renameProject / deleteProject", () => {
  it("renames the folder and the name, and refuses a taken folder", async () => {
    await createProject("mike", "Old")
    await createProject("mike", "Taken")
    expect(await renameProject("mike", "Old", "Taken")).toHaveProperty("error")
    expect(await renameProject("mike", "Old", "New")).toEqual({ folder: "New" })
    expect(await exists(user, "Old")).toBe(false)
    expect((await readProject("mike", "New"))?.name).toBe("New")
    expect(await renameProject("mike", "New", "../Esc")).toEqual({ folder: "Esc" })
  })

  it("renames case-only (Old to old) and keeps the project", async () => {
    await createProject("mike", "Old")
    expect(await renameProject("mike", "Old", "old")).toEqual({ folder: "old" })
    expect(await fs.readdir(user)).toEqual(["old"])
    expect((await readProject("mike", "old"))?.name).toBe("old")
  })

  it("returns an error, not a throw, when the rename fails, and leaves no reserved folder", async () => {
    await createProject("mike", "Src")
    const rename = vi.spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("boom"), { code: "ENOTEMPTY" }))
    try {
      expect(await renameProject("mike", "Src", "Dst")).toEqual({ error: "boom" })
    } finally {
      rename.mockRestore()
    }
    expect((await fs.readdir(user)).sort()).toEqual(["Src"])
  })

  it("deletes a project and ignores traversal", async () => {
    await createProject("mike", "Gone")
    await deleteProject("mike", "../..")
    expect(await exists(projects)).toBe(true)
    await deleteProject("mike", "Gone")
    expect(await exists(user, "Gone")).toBe(false)
  })
})

describe("importAsset", () => {
  it("copies, leaves the Inbox original, probes, and numbers a duplicate", async () => {
    await createProject("mike", "P")
    const a = await importAsset("mike", "P", ["mike"], "clip.mp4")
    expect(a).toMatchObject({ asset: { file: "clip.mp4", duration: 12.5, hasAudio: true } })
    const b = await importAsset("mike", "P", ["mike"], "clip.mp4")
    expect(b).toMatchObject({ asset: { file: "clip (1).mp4" } })
    expect((a as { id: string }).id).not.toBe((b as { id: string }).id)
    expect((a as { id: string }).id).toMatch(/^a[0-9a-f]{16}$/)
    expect(await fs.readFile(path.join(inbox, "mike", "clip.mp4"), "utf8")).toBe("video bytes")
    expect(await fs.readFile(path.join(user, "P", "assets", "clip (1).mp4"), "utf8")).toBe("video bytes")
    const c = await importAsset("mike", "P", ["mike", "sub"], "deep.mp4")
    expect(c).toMatchObject({ asset: { file: "deep.mp4" } })
  })

  it("records the Inbox path it came from as source", async () => {
    await createProject("mike", "P")
    expect(await importAsset("mike", "P", ["mike"], "clip.mp4")).toMatchObject({ asset: { source: "mike/clip.mp4" } })
    expect(await importAsset("mike", "P", ["mike", "sub"], "deep.mp4")).toMatchObject({ asset: { source: "mike/sub/deep.mp4" } })
  })

  it("imports an image without probing it, with the default length and no audio", async () => {
    await createProject("mike", "P")
    vi.mocked(probeMedia).mockClear()
    const r = await importAsset("mike", "P", ["mike"], "photo.HEIC")
    expect(r).toMatchObject({ asset: { file: "photo.HEIC", duration: DEFAULT_IMAGE, hasAudio: false, kind: "image", source: "mike/photo.HEIC" } })
    expect(probeMedia).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(user, "P", "assets", "photo.HEIC"), "utf8")).toBe("image bytes")
    expect(await fs.readFile(path.join(inbox, "mike", "photo.HEIC"), "utf8")).toBe("image bytes")
  })

  it("refuses a clip shorter than MIN_CLIP and removes the copy", async () => {
    await createProject("mike", "P")
    vi.mocked(probeMedia).mockResolvedValueOnce({ duration: MIN_CLIP / 2, hasAudio: false })
    expect(await importAsset("mike", "P", ["mike"], "clip.mp4")).toEqual({ error: "That clip is too short to edit." })
    expect(await fs.readdir(path.join(user, "P", "assets"))).toEqual([])
  })

  it("refuses a symlink in the Inbox", async (ctx) => {
    await createProject("mike", "P")
    const outside = path.join(tmp, "secret.mp4")
    await fs.writeFile(outside, "secret")
    try {
      await fs.symlink(outside, path.join(inbox, "mike", "link.mp4"), "file")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return ctx.skip()
      throw error
    }
    expect(await importAsset("mike", "P", ["mike"], "link.mp4")).toHaveProperty("error")
    expect(await fs.readdir(path.join(user, "P", "assets"))).toEqual([])
  })

  it("rejects non-videos, paths in the name, escapes and missing files", async () => {
    await createProject("mike", "P")
    expect(await importAsset("mike", "P", ["mike"], "notes.txt")).toHaveProperty("error")
    expect(await importAsset("mike", "P", ["mike"], "sub/deep.mp4")).toHaveProperty("error")
    expect(await importAsset("mike", "P", ["mike"], "..\\clip.mp4")).toHaveProperty("error")
    expect(await importAsset("mike", "P", ["..", "projects"], "clip.mp4")).toHaveProperty("error")
    expect(await importAsset("mike", "P", ["mike"], "missing.mp4")).toHaveProperty("error")
    expect(await importAsset("mike", "../P", ["mike"], "clip.mp4")).toHaveProperty("error")
    expect(await fs.readdir(path.join(user, "P", "assets"))).toEqual([])
  })
})

describe("reusableAsset", () => {
  it("returns the asset already imported from that Inbox file while its copy exists", async () => {
    await createProject("mike", "P")
    const a = await importAsset("mike", "P", ["mike"], "clip.mp4")
    if ("error" in a) throw new Error(a.error)
    const p = { ...newProject("P"), assets: { [a.id]: a.asset } }
    expect(await reusableAsset("mike", "P", p, "mike/clip.mp4")).toEqual({ id: a.id, asset: a.asset })
    expect(await reusableAsset("mike", "P", p, "mike/other.mp4")).toBeNull()
    await fs.rm(path.join(user, "P", "assets", "clip.mp4"))
    expect(await reusableAsset("mike", "P", p, "mike/clip.mp4")).toBeNull()
  })

  it("after a deleted copy imports fresh once, then reuses the new copy", async () => {
    await createProject("mike", "P")
    const a = await importAsset("mike", "P", ["mike"], "clip.mp4")
    if ("error" in a) throw new Error(a.error)
    let p = { ...newProject("P"), assets: { [a.id]: a.asset } }
    await fs.rm(path.join(user, "P", "assets", a.asset.file))
    expect(await reusableAsset("mike", "P", p, "mike/clip.mp4")).toBeNull()
    const b = await importAsset("mike", "P", ["mike"], "clip.mp4")
    if ("error" in b) throw new Error(b.error)
    p = { ...p, assets: { ...p.assets, [b.id]: b.asset } }
    // The fresh copy may take the freed name, so either record can point at it; it must resolve to the live file.
    expect(await reusableAsset("mike", "P", p, "mike/clip.mp4")).toMatchObject({ asset: { file: b.asset.file } })
    expect(await fs.readdir(path.join(user, "P", "assets"))).toEqual([b.asset.file])
  })

  it("skips a record whose copy is gone and reuses a later one that still exists", async () => {
    await createProject("mike", "P")
    const a = await importAsset("mike", "P", ["mike"], "clip.mp4")
    const b = await importAsset("mike", "P", ["mike"], "clip.mp4")
    if ("error" in a || "error" in b) throw new Error("import failed")
    const p = { ...newProject("P"), assets: { [a.id]: a.asset, [b.id]: b.asset } }
    await fs.rm(path.join(user, "P", "assets", a.asset.file))
    expect(await reusableAsset("mike", "P", p, "mike/clip.mp4")).toEqual({ id: b.id, asset: b.asset })
  })

  it("ignores a directory standing where the copy was", async () => {
    await createProject("mike", "P")
    const a = await importAsset("mike", "P", ["mike"], "clip.mp4")
    if ("error" in a) throw new Error(a.error)
    const p = { ...newProject("P"), assets: { [a.id]: a.asset } }
    await fs.rm(path.join(user, "P", "assets", a.asset.file))
    await fs.mkdir(path.join(user, "P", "assets", a.asset.file))
    expect(await reusableAsset("mike", "P", p, "mike/clip.mp4")).toBeNull()
  })
})

describe("assetPath", () => {
  it("resolves plain names inside assets and refuses the rest", () => {
    expect(assetPath("mike", "P", "clip.mp4")).toBe(path.join(user, "P", "assets", "clip.mp4"))
    expect(assetPath("mike", "P", "../project.json")).toBeNull()
    expect(assetPath("mike", "P", "a/b.mp4")).toBeNull()
    expect(assetPath("mike", "..", "clip.mp4")).toBeNull()
  })
})
