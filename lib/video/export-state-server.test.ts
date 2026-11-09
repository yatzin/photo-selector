import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

const tmp = path.join(os.tmpdir(), `ps-export-state-${process.pid}-${Date.now()}`)
process.env.PHOTOS_VIDEO_PROJECTS_DIR = path.join(tmp, "projects")
process.env.PHOTOS_TEMP_DIR = path.join(tmp, "inbox")
process.env.PHOTOS_CACHE_DIR = path.join(tmp, "cache")

import { EXPORT_STATE_FILE } from "./export-state"
import { cleanOutputs, readExportState, resolveDownload, reusableExport, writeExportState } from "./export-state-server"

afterAll(() => fs.rm(tmp, { recursive: true, force: true }))
afterEach(() => vi.restoreAllMocks())

let n = 0
/** A fresh output/ folder for user/project. */
async function outDir(user = "mike", folder = `P${n++}`): Promise<string> {
  const dir = path.join(tmp, "projects", user, folder, "output")
  await fs.mkdir(dir, { recursive: true })
  return dir
}

const state = (file: string, fingerprint = "f1") => ({ file, fingerprint, createdAt: 1 })

describe("readExportState / writeExportState", () => {
  it("is null with no state file or a corrupt one", async () => {
    const dir = await outDir()
    expect(await readExportState(dir)).toBeNull()
    await fs.writeFile(path.join(dir, EXPORT_STATE_FILE), "{not json")
    expect(await readExportState(dir)).toBeNull()
    await fs.writeFile(path.join(dir, EXPORT_STATE_FILE), JSON.stringify({ file: 3, fingerprint: "x", createdAt: 1 }))
    expect(await readExportState(dir)).toBeNull()
  })

  it("reads back what it wrote, leaving no temp file", async () => {
    const dir = await outDir()
    await writeExportState(dir, state("a.mp4"))
    await writeExportState(dir, state("b.mp4", "f2"))
    expect(await readExportState(dir)).toEqual(state("b.mp4", "f2"))
    expect(await fs.readdir(dir)).toEqual([EXPORT_STATE_FILE])
  })
})

describe("reusableExport", () => {
  it("is the stored file when the fingerprint matches and the file is there", async () => {
    const dir = await outDir()
    await fs.writeFile(path.join(dir, "a.mp4"), "v")
    await writeExportState(dir, state("a.mp4"))
    expect(await reusableExport(dir, "f1")).toBe("a.mp4")
    expect(await reusableExport(dir, "f2")).toBeNull()
  })

  it("is null with no state, a missing file, a folder of that name or a name that steps outside", async () => {
    const dir = await outDir()
    expect(await reusableExport(dir, "f1")).toBeNull()
    await writeExportState(dir, state("gone.mp4"))
    expect(await reusableExport(dir, "f1")).toBeNull()
    await fs.mkdir(path.join(dir, "folder.mp4"))
    await writeExportState(dir, state("folder.mp4"))
    expect(await reusableExport(dir, "f1")).toBeNull()
    await fs.writeFile(path.join(dir, "..", "outside.mp4"), "v")
    await writeExportState(dir, state("../outside.mp4"))
    expect(await reusableExport(dir, "f1")).toBeNull()
  })
})

describe("cleanOutputs", () => {
  it("keeps only the given files, leaving folders and their contents alone", async () => {
    const dir = await outDir()
    for (const f of ["old.mp4", "older (1).mp4", "x.tmp", "new.mp4", EXPORT_STATE_FILE]) await fs.writeFile(path.join(dir, f), "v")
    await fs.mkdir(path.join(dir, "sub"))
    await fs.writeFile(path.join(dir, "sub", "keep.mp4"), "v")
    await fs.writeFile(path.join(dir, "..", "project-file.txt"), "v")
    await cleanOutputs(dir, ["new.mp4", EXPORT_STATE_FILE])
    expect((await fs.readdir(dir)).sort()).toEqual([EXPORT_STATE_FILE, "new.mp4", "sub"].sort())
    expect(await fs.readdir(path.join(dir, "sub"))).toEqual(["keep.mp4"])
    expect(await fs.readFile(path.join(dir, "..", "project-file.txt"), "utf8")).toBe("v")
  })

  it("carries on past a file it can't remove, and never throws", async () => {
    const dir = await outDir()
    for (const f of ["a.mp4", "b.mp4", "new.mp4"]) await fs.writeFile(path.join(dir, f), "v")
    const rm = fs.rm
    vi.spyOn(fs, "rm").mockImplementation(async (p, o) => {
      if (String(p).endsWith("a.mp4")) throw Object.assign(new Error("busy"), { code: "EBUSY" })
      return rm(p, o)
    })
    await expect(cleanOutputs(dir, ["new.mp4"])).resolves.toBeUndefined()
    expect((await fs.readdir(dir)).sort()).toEqual(["a.mp4", "new.mp4"])
  })

  it("doesn't throw for a missing folder", async () => {
    await expect(cleanOutputs(path.join(tmp, "nope"), [])).resolves.toBeUndefined()
  })
})

describe("resolveDownload", () => {
  it("is the stored copy's path and name", async () => {
    const dir = await outDir("mike", "Trip")
    await fs.writeFile(path.join(dir, "Trip 2026.mp4"), "v")
    await writeExportState(dir, state("Trip 2026.mp4"))
    expect(await resolveDownload("mike", "Trip")).toEqual({ path: path.join(dir, "Trip 2026.mp4"), name: "Trip 2026.mp4" })
  })

  it("is null with no state file or a state naming a missing file", async () => {
    const dir = await outDir("mike", "Empty")
    expect(await resolveDownload("mike", "Empty")).toBeNull()
    await writeExportState(dir, state("gone.mp4"))
    expect(await resolveDownload("mike", "Empty")).toBeNull()
  })

  it("rejects a state file naming a path with separators or .., or a file that isn't a video", async () => {
    const dir = await outDir("mike", "Sneaky")
    await fs.mkdir(path.join(dir, "sub"))
    await fs.writeFile(path.join(dir, "sub", "v.mp4"), "v")
    await fs.writeFile(path.join(dir, "..", "project.mp4"), "v")
    await fs.writeFile(path.join(dir, "notes.txt"), "v")
    for (const file of ["sub/v.mp4", "sub\\v.mp4", "../project.mp4", "..", path.join(dir, "sub", "v.mp4"), "notes.txt", ""]) {
      await writeExportState(dir, state(file))
      expect(await resolveDownload("mike", "Sneaky")).toBeNull()
    }
  })

  it("can't reach another user's folder", async () => {
    const dir = await outDir("mike", "Private")
    await fs.writeFile(path.join(dir, "v.mp4"), "v")
    await writeExportState(dir, state("v.mp4"))
    expect(await resolveDownload("bob", "Private")).toBeNull()
    expect(await resolveDownload("bob", "../mike/Private")).toBeNull()
    expect(await resolveDownload("..", "mike")).toBeNull()
    expect(await resolveDownload("../mike", "Private")).toBeNull()
  })
})
