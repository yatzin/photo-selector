import "server-only"
import fs from "fs/promises"
import path from "path"
import { isSkippedDir } from "@/lib/media"

// Mobile Upload fills up with folders that sorting has emptied. When a folder
// is browsed, its subfolders that are empty, or hold only files the OS or
// NAS leaves behind, are removed. Anything else — a photo, any other file, a
// subfolder, a NAS recycle bin — keeps the folder.

/** Files Windows, macOS and NAS indexers leave in folders; never the user's own. */
const CLUTTER_FILES = new Set(["thumbs.db", "desktop.ini", ".ds_store"])
const isClutterFile = (name: string) => CLUTTER_FILES.has(name.toLowerCase()) || name.startsWith("._")
/** NAS thumbnail index folders (rebuilt automatically). */
const CLUTTER_DIRS = new Set(["@eadir"])

/** Whether `dir` holds nothing but clutter (or nothing at all). */
async function onlyClutter(dir: string): Promise<boolean> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isFile() && isClutterFile(e.name)) continue
    if (e.isDirectory() && CLUTTER_DIRS.has(e.name.toLowerCase())) continue
    return false
  }
  return true
}

/**
 * Removes the subfolders of `dir` that are empty apart from clutter, and
 * returns their names. Hidden/system folders (the app's trash, `@eaDir`,
 * `#recycle`) are never touched, nor any folder `skip` names. The folder
 * itself is removed with a plain rmdir, which refuses if anything appeared
 * in it meanwhile. Failures are ignored: the folder simply stays.
 */
export async function pruneEmptyFolders(dir: string, skip: (name: string) => boolean = () => false): Promise<string[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const removed: string[] = []
  for (const e of entries) {
    if (!e.isDirectory() || isSkippedDir(e.name) || skip(e.name)) continue
    const sub = path.join(dir, e.name)
    try {
      if (!(await onlyClutter(sub))) continue
      // Re-check each entry: a photo that arrived since the check above is left,
      // and the rmdir below then fails, keeping the folder.
      for (const c of await fs.readdir(sub, { withFileTypes: true })) {
        if (c.isFile() && isClutterFile(c.name)) await fs.rm(path.join(sub, c.name), { force: true })
        else if (c.isDirectory() && CLUTTER_DIRS.has(c.name.toLowerCase())) await fs.rm(path.join(sub, c.name), { recursive: true, force: true })
      }
      await fs.rmdir(sub)
      removed.push(e.name)
    } catch {
      // In use, no permission, or something new arrived: leave it.
    }
  }
  return removed
}
