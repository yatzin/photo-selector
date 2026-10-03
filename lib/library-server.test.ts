import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, describe, expect, it } from "vitest"
import { rootStatus } from "./library-server"

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
