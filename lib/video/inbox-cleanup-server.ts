import "server-only"
import fs from "fs/promises"
import path from "path"
import { rootPath } from "@/lib/library-server"
import { isExpired } from "./retention"

// The Video Editing inbox holds raw media waiting to be used, so it is
// staging: a file that has sat there for RETENTION_MONTHS is deleted. Projects
// are never touched (they copy what they use into their own assets folder).

/** When a file arrived: the latest of its change, modify and birth times, so a copy that kept an old modified date still counts from the copy. */
const arrivedAt = (st: { mtimeMs: number; ctimeMs: number; birthtimeMs: number }) => Math.max(st.mtimeMs, st.ctimeMs, st.birthtimeMs)

/** Deletes expired files below `dir` (not following links) and the folders that empty out; true when `dir` itself ended up empty. */
async function sweep(dir: string, now: number, counter: { removed: number }): Promise<boolean> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  let empty = true
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (await sweep(full, now, counter)) {
        const gone = await fs.rmdir(full).then(() => true, () => false)
        if (!gone) empty = false
      } else {
        empty = false
      }
    } else if (e.isFile()) {
      try {
        if (isExpired(arrivedAt(await fs.stat(full)), now)) {
          await fs.rm(full, { force: true })
          counter.removed++
          continue
        }
      } catch {
        // gone or unreadable: leave it
      }
      empty = false
    } else {
      empty = false
    }
  }
  return empty
}

/**
 * Deletes every inbox file older than the retention period, for all users,
 * and the sub-folders left empty (a user's own folder stays). Returns how
 * many files went.
 */
export async function cleanExpiredInbox(now = Date.now()): Promise<number> {
  const root = rootPath("video-inbox")
  let users
  try {
    users = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  const counter = { removed: 0 }
  for (const u of users) if (u.isDirectory()) await sweep(path.join(root, u.name), now, counter)
  return counter.removed
}
