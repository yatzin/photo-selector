import "server-only"
import fs from "fs/promises"
import path from "path"
import { moveNoClobber } from "@/lib/file-ops-server"
import { rootPath } from "@/lib/library-server"
import { isSkippedDir, mediaKind, resolveInside, safeSegments, TRASH_DIR, trashBatchTime } from "@/lib/media"
import { trashExpiry, type TrashBatch, type TrashFile } from "@/lib/temp-trash"

// The Personal Storage trash: what delete moved into
// <Personal Storage>/.photo-selector-trash/<batch id>/<original path> (see
// trashFiles in lib/file-ops-server and trashTempFolder). Lists it, puts files
// back where they were, or moves one into another folder. The background
// worker removes a batch once it is RETENTION days old (purgeTrash).

const trashRoot = () => path.join(rootPath("temp"), TRASH_DIR)

async function walk(dir: string, base: string, out: TrashFile[]): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      await walk(full, base, out)
    } else if (e.isFile()) {
      const kind = mediaKind(e.name)
      if (!kind) continue
      try {
        const st = await fs.stat(full)
        out.push({ name: e.name, folder: path.relative(base, dir).split(path.sep).filter(Boolean), size: st.size, kind })
      } catch {
        // gone meanwhile
      }
    }
  }
}

/** Every batch in the trash, newest delete first, with the photos and videos in it. */
export async function listTempTrash(): Promise<TrashBatch[]> {
  let ids: string[]
  try {
    ids = await fs.readdir(trashRoot())
  } catch {
    return []
  }
  const batches: TrashBatch[] = []
  for (const id of ids) {
    const deletedAt = trashBatchTime(id)
    if (deletedAt === null) continue
    const files: TrashFile[] = []
    const dir = path.join(trashRoot(), id)
    await walk(dir, dir, files)
    if (files.length === 0) continue
    files.sort((a, b) => a.folder.join("/").localeCompare(b.folder.join("/")) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    batches.push({ id, deletedAt, expiresAt: trashExpiry(deletedAt), files })
  }
  return batches.sort((a, b) => b.deletedAt - a.deletedAt)
}

/** Removes empty folders below `dir`, then `dir` itself when nothing is left. */
async function pruneEmpty(dir: string): Promise<boolean> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  let empty = true
  for (const e of entries) {
    if (e.isDirectory() && (await pruneEmpty(path.join(dir, e.name)))) continue
    empty = false
  }
  if (empty) await fs.rmdir(dir).catch(() => (empty = false))
  return empty
}

function message(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === "ENOENT") return "It is no longer in the trash."
  if (code === "EACCES" || code === "EPERM") return "Permission denied. Check the container's PUID/PGID."
  return error instanceof Error ? error.message : String(error)
}

/** The file `folder/name` inside batch `id`, when the id and path are valid. */
function trashFile(id: string, folder: string[], name: string): string | null {
  if (trashBatchTime(id) === null) return null
  return resolveInside(path.join(trashRoot(), id), [...folder, name])
}

export type TrashRef = { folder: string[]; name: string }

/**
 * Puts files of batch `id` (all of them when `refs` is null) back in the folder
 * they were deleted from (made again if it is gone), renaming a file whose name
 * has been taken. Returns how many went back and what failed.
 */
export async function restoreTrash(id: string, refs: TrashRef[] | null): Promise<{ restored: number; failed: { name: string; error: string }[] }> {
  const result = { restored: 0, failed: [] as { name: string; error: string }[] }
  let items = refs
  if (!items) {
    const files: TrashFile[] = []
    const dir = path.join(trashRoot(), id)
    if (trashBatchTime(id) !== null) await walk(dir, dir, files)
    items = files.map((f) => ({ folder: f.folder, name: f.name }))
  }
  for (const ref of items) {
    const src = trashFile(id, ref.folder, ref.name)
    const dest = resolveInside(rootPath("temp"), ref.folder)
    if (!src || !dest) {
      result.failed.push({ name: ref.name, error: "Invalid file." })
      continue
    }
    try {
      await moveNoClobber(src, dest, ref.name)
      result.restored++
    } catch (error) {
      result.failed.push({ name: ref.name, error: message(error) })
    }
  }
  if (trashBatchTime(id) !== null) await pruneEmpty(path.join(trashRoot(), id))
  return result
}

/** Moves one file out of the trash into the Personal Storage folder `destination` (a user's folder or below it), renaming it if the name is taken there. */
export async function moveFromTrash(id: string, ref: TrashRef, destination: string[]): Promise<{ name: string } | { error: string }> {
  const src = trashFile(id, ref.folder, ref.name)
  const clean = safeSegments(destination)
  const dest = clean && clean.length > 0 ? resolveInside(rootPath("temp"), clean) : null
  if (!src || !dest || clean!.some(isSkippedDir)) return { error: "Invalid request." }
  try {
    if (!(await fs.stat(dest)).isDirectory()) return { error: "That folder no longer exists." }
    const placed = await moveNoClobber(src, dest, ref.name)
    await pruneEmpty(path.join(trashRoot(), id))
    return { name: path.basename(placed) }
  } catch (error) {
    return { error: message(error) }
  }
}

/** Every folder in Personal Storage below a user's own folder level, as paths ("Mike", "Mike/Trips"), for choosing where to move a file. */
export async function listTempFolderPaths(limit = 2000): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string, rel: string[]): Promise<void> {
    if (out.length >= limit) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      if (!e.isDirectory() || isSkippedDir(e.name)) continue
      const next = [...rel, e.name]
      out.push(next.join("/"))
      await visit(path.join(dir, e.name), next)
    }
  }
  await visit(rootPath("temp"), [])
  return out
}
