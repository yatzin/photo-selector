import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { pruneEmptyFolders } from "./empty-folders"

const tmp = path.join(os.tmpdir(), `ps-empty-${process.pid}-${Date.now()}`)
const put = async (rel: string) => {
  await fs.mkdir(path.dirname(path.join(tmp, rel)), { recursive: true })
  await fs.writeFile(path.join(tmp, rel), "x")
}
const dir = (rel: string) => fs.mkdir(path.join(tmp, rel), { recursive: true })
const has = (rel: string) => fs.stat(path.join(tmp, rel)).then(() => true, () => false)

beforeEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(tmp, { recursive: true })
})
afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

describe("pruneEmptyFolders", () => {
  it("removes subfolders that are empty or hold only system clutter", async () => {
    await dir("empty")
    await put("clutter/Thumbs.db")
    await put("clutter/desktop.ini")
    await put("clutter/.DS_Store")
    await put("clutter/._IMG_1.jpg")
    await put("indexed/@eaDir/IMG_1.jpg/SYNOPHOTO_THUMB_M.jpg")
    expect((await pruneEmptyFolders(tmp)).sort()).toEqual(["clutter", "empty", "indexed"])
    expect(await has("empty")).toBe(false)
    expect(await has("clutter")).toBe(false)
    expect(await has("indexed")).toBe(false)
  })

  it("keeps folders with photos, other files or subfolders", async () => {
    await put("photos/IMG_1.jpg")
    await put("notes/notes.txt")
    await dir("parent/child")
    await put("mixed/Thumbs.db")
    await put("mixed/IMG_2.heic")
    expect(await pruneEmptyFolders(tmp)).toEqual([])
    for (const d of ["photos/IMG_1.jpg", "notes/notes.txt", "parent/child", "mixed/Thumbs.db", "mixed/IMG_2.heic"]) expect(await has(d)).toBe(true)
  })

  it("never treats a NAS recycle bin as clutter", async () => {
    await put("old/#recycle/deleted.jpg")
    expect(await pruneEmptyFolders(tmp)).toEqual([])
    expect(await has("old/#recycle/deleted.jpg")).toBe(true)
  })

  it("leaves the app's trash, hidden folders and folders it's told to skip", async () => {
    await dir(".photo-selector-trash")
    await dir("@eaDir")
    await dir("busy")
    expect(await pruneEmptyFolders(tmp, (name) => name === "busy")).toEqual([])
    for (const d of [".photo-selector-trash", "@eaDir", "busy"]) expect(await has(d)).toBe(true)
  })

  it("only looks one level down", async () => {
    await dir("a/b")
    expect(await pruneEmptyFolders(tmp)).toEqual([])
    expect(await pruneEmptyFolders(path.join(tmp, "a"))).toEqual(["b"])
    expect(await pruneEmptyFolders(tmp)).toEqual(["a"])
  })
})
