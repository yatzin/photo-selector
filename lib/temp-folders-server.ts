import "server-only"
import { randomBytes } from "crypto"
import fs from "fs/promises"
import path from "path"
import { rootPath } from "@/lib/library-server"
import { mediaKind, resolveInside, subfolderName, TRASH_DIR, trashBatchId } from "@/lib/media"

// Subfolders inside a user's folder in Personal Storage. A user's own folder
// (the first level) is made by sending files to them and is never created or
// deleted here. A deleted folder goes to the root's trash with what's in it,
// like deleted files, so it can still be recovered.

export const MAX_TEMP_DEPTH = 12

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code

/** Makes `name` inside the folder `parent` (a path below Personal Storage, at least the user's folder). Returns the cleaned name. */
export async function createTempFolder(parent: string[], name: string): Promise<{ name: string } | { error: string }> {
  const clean = subfolderName(name)
  if (!clean) return { error: "Enter a folder name." }
  if (parent.length === 0) return { error: "Open a user's folder first." }
  if (parent.length >= MAX_TEMP_DEPTH) return { error: `Folders can go ${MAX_TEMP_DEPTH} levels deep.` }
  const dir = resolveInside(rootPath("temp"), [...parent, clean])
  if (!dir) return { error: "Invalid folder." }
  try {
    const st = await fs.stat(path.dirname(dir))
    if (!st.isDirectory()) return { error: "That folder no longer exists." }
    await fs.mkdir(dir)
  } catch (error) {
    if (errorCode(error) === "EEXIST") return { error: `There is already a folder named “${clean}” here.` }
    if (errorCode(error) === "ENOENT") return { error: "That folder no longer exists." }
    return { error: error instanceof Error ? error.message : String(error) }
  }
  return { name: clean }
}

/** Moves the subfolder `name` of `parent`, and everything in it, to the trash. Not a user's own folder, not a link. */
export async function trashTempFolder(parent: string[], name: string): Promise<{ ok: true } | { error: string }> {
  if (parent.length === 0) return { error: "A user's own folder can't be deleted here." }
  const dir = resolveInside(rootPath("temp"), [...parent, name])
  if (!dir || path.basename(dir) !== name) return { error: "Invalid folder." }
  try {
    const st = await fs.lstat(dir)
    if (!st.isDirectory()) return { error: "That isn't a folder." }
    const batchDir = path.join(rootPath("temp"), TRASH_DIR, trashBatchId(Date.now(), randomBytes(6).toString("hex")), ...parent)
    await fs.mkdir(batchDir, { recursive: true })
    await fs.rename(dir, path.join(batchDir, name))
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { error: "That folder no longer exists." }
    return { error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true }
}

/** Renames inside `dir` without ever replacing a file or folder already there. */
async function renameNoClobber(from: string, to: string): Promise<{ ok: true } | { error: string }> {
  if (path.resolve(from) === path.resolve(to)) return { ok: true }
  try {
    await fs.lstat(to)
    return { error: `“${path.basename(to)}” already exists here.` }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return { error: error instanceof Error ? error.message : String(error) }
  }
  try {
    await fs.rename(from, to)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { error: "It no longer exists." }
    return { error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true }
}

/** Renames the subfolder `name` of `parent` (not a user's own folder). The new name, cleaned. */
export async function renameTempFolder(parent: string[], name: string, newName: string): Promise<{ name: string } | { error: string }> {
  const clean = subfolderName(newName)
  if (!clean) return { error: "Enter a folder name." }
  if (parent.length === 0) return { error: "A user's own folder can't be renamed here." }
  const from = resolveInside(rootPath("temp"), [...parent, name])
  const to = resolveInside(rootPath("temp"), [...parent, clean])
  if (!from || !to || path.basename(from) !== name) return { error: "Invalid folder." }
  try {
    if (!(await fs.lstat(from)).isDirectory()) return { error: "That isn't a folder." }
  } catch {
    return { error: "That folder no longer exists." }
  }
  const r = await renameNoClobber(from, to)
  return "error" in r ? r : { name: clean }
}

/** Renames the photo or video `name` in `parent`. The extension stays; `newStem` is what comes before it. The new file name. */
export async function renameTempFile(parent: string[], name: string, newStem: string): Promise<{ name: string } | { error: string }> {
  if (parent.length === 0) return { error: "Open a user's folder first." }
  const ext = path.extname(name)
  if (!mediaKind(name)) return { error: "Not a photo or video." }
  const stem = newStem.replace(/[<>:"/\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().replace(/^[.\s]+/, "").replace(/[.\s]+$/, "")
  if (!stem) return { error: "Enter a name." }
  const next = `${stem.slice(0, 180)}${ext}`
  const from = resolveInside(rootPath("temp"), [...parent, name])
  const to = resolveInside(rootPath("temp"), [...parent, next])
  if (!from || !to || path.basename(from) !== name) return { error: "Invalid file." }
  try {
    const st = await fs.lstat(from)
    if (!st.isFile()) return { error: "That isn't a file." }
  } catch {
    return { error: "That file no longer exists." }
  }
  const r = await renameNoClobber(from, to)
  return "error" in r ? r : { name: next }
}
