import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { newProject } from "./project"

vi.mock("./ffmpeg-server", () => ({ probeMedia: vi.fn(async () => ({ duration: 12.5, hasAudio: true })) }))

import { assetPath, createProject, deleteProject, importAsset, listProjects, readProject, renameProject, writeProject } from "./projects-server"

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
    const p = { ...newProject("Two"), assets: { a: { file: "a.mp4", duration: 10, hasAudio: false } }, clips: [{ id: "c1", asset: "a", in: 0, out: 5 }] }
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
    expect(await fs.readFile(path.join(inbox, "mike", "clip.mp4"), "utf8")).toBe("video bytes")
    expect(await fs.readFile(path.join(user, "P", "assets", "clip (1).mp4"), "utf8")).toBe("video bytes")
    const c = await importAsset("mike", "P", ["mike", "sub"], "deep.mp4")
    expect(c).toMatchObject({ asset: { file: "deep.mp4" } })
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

describe("assetPath", () => {
  it("resolves plain names inside assets and refuses the rest", () => {
    expect(assetPath("mike", "P", "clip.mp4")).toBe(path.join(user, "P", "assets", "clip.mp4"))
    expect(assetPath("mike", "P", "../project.json")).toBeNull()
    expect(assetPath("mike", "P", "a/b.mp4")).toBeNull()
    expect(assetPath("mike", "..", "clip.mp4")).toBeNull()
  })
})
