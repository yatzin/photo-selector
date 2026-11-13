import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { moveToDropoff, moveWithin, sendToTemp } from "./file-ops-server"
import { rootPath } from "./library-server"

const tmp = path.join(os.tmpdir(), `ps-fileops-${process.pid}-${Date.now()}`)
const upload = path.join(tmp, "upload")
const dropoff = path.join(tmp, "dropoff")
const temp = path.join(tmp, "UserTempStorage")

process.env.PHOTOS_UPLOAD_DIR = upload
process.env.PHOTOS_DROPOFF_DIR = dropoff
process.env.PHOTOS_TEMP_DIR = temp
process.env.PHOTOS_CACHE_DIR = path.join(tmp, "cache")

afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

beforeEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(path.join(upload, "trip", "18"), { recursive: true })
  await fs.mkdir(dropoff, { recursive: true })
  await fs.writeFile(path.join(upload, "trip", "IMG_1.jpg"), "new photo")
  await fs.writeFile(path.join(upload, "trip", "18", "IMG_2.jpg"), "day photo")
})

const read = (...p: string[]) => fs.readFile(path.join(...p), "utf8")
const exists = (...p: string[]) => fs.access(path.join(...p)).then(() => true, () => false)

describe("rootPath('temp')", () => {
  it("defaults to UserTempStorage beside the cache", () => {
    delete process.env.PHOTOS_TEMP_DIR
    try {
      expect(rootPath("temp")).toBe(path.join(tmp, "UserTempStorage"))
    } finally {
      process.env.PHOTOS_TEMP_DIR = temp
    }
  })
})

describe("sendToTemp", () => {
  it("copies into the user's folder, creating it, and leaves the source", async () => {
    const r = await sendToTemp("upload", ["trip"], ["IMG_1.jpg"], "Jessi", "copy")
    expect(r).toEqual({ ok: ["IMG_1.jpg"], failed: [] })
    expect(await read(temp, "Jessi", "IMG_1.jpg")).toBe("new photo")
    expect(await exists(upload, "trip", "IMG_1.jpg")).toBe(true)
  })

  it("moves, flattening a day folder of a month scan", async () => {
    const r = await sendToTemp("upload", ["trip"], ["18/IMG_2.jpg"], "Jessi", "move")
    expect(r.ok).toEqual(["18/IMG_2.jpg"])
    expect(await read(temp, "Jessi", "IMG_2.jpg")).toBe("day photo")
    expect(await exists(upload, "trip", "18", "IMG_2.jpg")).toBe(false)
  })

  it("replaces a file of the same name already there", async () => {
    await fs.mkdir(path.join(temp, "Jessi"), { recursive: true })
    await fs.writeFile(path.join(temp, "Jessi", "IMG_1.jpg"), "old photo")
    await sendToTemp("upload", ["trip"], ["IMG_1.jpg"], "Jessi", "move")
    expect(await read(temp, "Jessi", "IMG_1.jpg")).toBe("new photo")
    expect((await fs.readdir(path.join(temp, "Jessi"))).sort()).toEqual(["IMG_1.jpg"])
  })

  it("moves between users' folders", async () => {
    await sendToTemp("upload", ["trip"], ["IMG_1.jpg"], "Jessi", "move")
    const r = await sendToTemp("temp", ["Jessi"], ["IMG_1.jpg"], "Mike", "move")
    expect(r.ok).toEqual(["IMG_1.jpg"])
    expect(await read(temp, "Mike", "IMG_1.jpg")).toBe("new photo")
    expect(await exists(temp, "Jessi", "IMG_1.jpg")).toBe(false)
  })

  it("never deletes a file sent onto itself", async () => {
    await sendToTemp("upload", ["trip"], ["IMG_1.jpg"], "Jessi", "copy")
    const r = await sendToTemp("temp", ["Jessi"], ["IMG_1.jpg"], "Jessi", "move")
    expect(r.ok).toEqual([])
    expect(await read(temp, "Jessi", "IMG_1.jpg")).toBe("new photo")
  })

  it("refuses a destination outside Personal Storage", async () => {
    const r = await sendToTemp("upload", ["trip"], ["IMG_1.jpg"], "..", "copy")
    expect(r.ok).toEqual([])
    expect(await exists(upload, "trip", "IMG_1.jpg")).toBe(true)
  })
})

describe("moveToDropoff from Personal Storage", () => {
  it("moves into the top of Sort Dropoff", async () => {
    await sendToTemp("upload", ["trip"], ["IMG_1.jpg"], "Jessi", "move")
    const r = await moveToDropoff("temp", ["Jessi"], ["IMG_1.jpg"])
    expect(r.ok).toEqual(["IMG_1.jpg"])
    expect(await read(dropoff, "IMG_1.jpg")).toBe("new photo")
    expect(await exists(temp, "Jessi", "IMG_1.jpg")).toBe(false)
  })
})

describe("moveWithin", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(temp, "Mike", "Trips"), { recursive: true })
    await fs.writeFile(path.join(temp, "Mike", "a.jpg"), "a")
    await fs.writeFile(path.join(temp, "Mike", "b.jpg"), "b")
    await fs.writeFile(path.join(temp, "Mike", "Trips", "a.jpg"), "other a")
  })

  it("moves files into another folder, numbering one whose name is taken there", async () => {
    const r = await moveWithin("temp", ["Mike"], ["a.jpg", "b.jpg"], ["Mike", "Trips"])
    expect(r.failed).toEqual([])
    expect(r.ok.sort()).toEqual(["a.jpg", "b.jpg"])
    expect(await exists(temp, "Mike", "a.jpg")).toBe(false)
    expect(await read(temp, "Mike", "Trips", "a.jpg")).toBe("other a")
    expect(await read(temp, "Mike", "Trips", "b.jpg")).toBe("b")
    expect((await fs.readdir(path.join(temp, "Mike", "Trips"))).length).toBe(3)
  })

  it("refuses the folder a file is already in, and a folder that doesn't exist", async () => {
    const same = await moveWithin("temp", ["Mike"], ["a.jpg"], ["Mike"])
    expect(same.ok).toEqual([])
    expect(same.failed[0].error).toMatch(/already/)
    const gone = await moveWithin("temp", ["Mike"], ["a.jpg"], ["Mike", "Nope"])
    expect(gone.ok).toEqual([])
    expect(await exists(temp, "Mike", "a.jpg")).toBe(true)
  })

  it("never reaches outside the root", async () => {
    const r = await moveWithin("temp", ["Mike"], ["a.jpg"], ["..", "upload"])
    expect(r.ok).toEqual([])
    expect(await exists(temp, "Mike", "a.jpg")).toBe(true)
  })
})
