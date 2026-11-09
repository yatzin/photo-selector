import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const tmp = path.join(os.tmpdir(), `ps-inbox-${process.pid}-${Date.now()}`)
process.env.PHOTOS_VIDEO_INBOX_DIR = path.join(tmp, "inbox")
process.env.PHOTOS_CACHE_DIR = path.join(tmp, "cache")

import { cleanExpiredInbox } from "./inbox-cleanup-server"

const inbox = path.join(tmp, "inbox")
const exists = (...p: string[]) => fs.access(path.join(...p)).then(() => true, () => false)
afterAll(() => fs.rm(tmp, { recursive: true, force: true }))
beforeEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(path.join(inbox, "mike", "trip"), { recursive: true })
  await fs.writeFile(path.join(inbox, "mike", "new.mp4"), "x")
  await fs.writeFile(path.join(inbox, "mike", "trip", "old.mp4"), "x")
})

describe("cleanExpiredInbox", () => {
  it("keeps files that just arrived, deletes them after six months, and drops emptied folders", async () => {
    expect(await cleanExpiredInbox(Date.now())).toBe(0)
    expect(await exists(inbox, "mike", "trip", "old.mp4")).toBe(true)
    expect(await cleanExpiredInbox(Date.now() + 200 * 86_400_000)).toBe(2)
    expect(await exists(inbox, "mike", "trip")).toBe(false)
    // The user's own folder stays.
    expect(await exists(inbox, "mike")).toBe(true)
  })

  it("does nothing without an inbox", async () => {
    await fs.rm(tmp, { recursive: true, force: true })
    expect(await cleanExpiredInbox()).toBe(0)
  })
})
