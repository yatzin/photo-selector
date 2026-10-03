import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, describe, expect, it } from "vitest"
import { listScanFolders, rootStatus } from "./library-server"

const tmp = path.join(os.tmpdir(), `ps-libsrv-${process.pid}-${Date.now()}`)

afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

describe("rootStatus", () => {
  it("counts a folder as readable only if it can actually be listed", async () => {
    // A file passes a plain read-permission check but can't be listed — the
    // same shape as a NAS share whose ACL lets the app "read" but not open it.
    await fs.mkdir(tmp, { recursive: true })
    const notADir = path.join(tmp, "file.txt")
    await fs.writeFile(notADir, "x")
    process.env.PHOTOS_UPLOAD_DIR = notADir
    expect((await rootStatus("upload")).readable).toBe(false)

    process.env.PHOTOS_UPLOAD_DIR = tmp
    expect((await rootStatus("upload")).readable).toBe(true)
  })
})

describe("listScanFolders", () => {
  it("offers a year/month folder of day folders as one entry and hides its days", async () => {
    const up = path.join(tmp, "scan-up")
    const write = async (rel: string) => {
      await fs.mkdir(path.dirname(path.join(up, rel)), { recursive: true })
      await fs.writeFile(path.join(up, rel), "x")
    }
    await write("2025/10/10/a.jpg")
    await write("2025/10/10/b.jpg")
    await write("2025/10/11/c.jpg")
    await write("2025/10/misc/d.jpg")
    await write("2025/11/e.jpg") // a month with photos of its own: scanned as a plain folder
    await write("2025/11/03/f.jpg")
    await fs.mkdir(path.join(tmp, "scan-drop"), { recursive: true })
    process.env.PHOTOS_UPLOAD_DIR = up
    process.env.PHOTOS_DROPOFF_DIR = path.join(tmp, "scan-drop")

    const upload = (await listScanFolders()).filter((f) => f.root === "upload")
    const byFolder = Object.fromEntries(upload.map((f) => [f.folder, f]))
    expect(byFolder["2025/10"]).toMatchObject({ imageCount: 3, includeDays: true })
    expect(byFolder["2025/10/10"]).toBeUndefined()
    expect(byFolder["2025/10/11"]).toBeUndefined()
    expect(byFolder["2025/10/misc"]).toMatchObject({ imageCount: 1 })
    expect(byFolder["2025/11"]).toMatchObject({ imageCount: 1, includeDays: false })
    expect(byFolder["2025/11/03"]).toMatchObject({ imageCount: 1 })
  })
})

