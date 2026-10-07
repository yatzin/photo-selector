import "server-only"
import { randomBytes } from "crypto"
import { constants } from "fs"
import fs from "fs/promises"
import path from "path"
import sharp from "sharp"
import { rootPath } from "@/lib/library-server"
import { isJpeg, orientationEdit, readOrientation, rotateOrientation, type RotateDirection } from "@/lib/exif-orientation"
import { mediaKind, numberedName, resolveInside, TRASH_DIR, TRASH_RETENTION_DAYS, trashBatchId, trashBatchTime, type RootKey } from "@/lib/media"
import { cacheKey, moveCached } from "@/lib/thumbs-server"

// Moves, deletes (to trash) and rotations. Photos are irreplaceable, so every
// operation either completes or leaves the original where it was: nothing is
// overwritten, and a cross-folder move deletes the source only after the copy
// is verified.

const MAX_NAME_ATTEMPTS = 1000

function relOf(rootKey: RootKey, file: string): string {
  return path.relative(rootPath(rootKey), file).split(path.sep).join("/")
}

/**
 * Puts `src` at `dir/name` without ever replacing an existing file, adding
 * " (n)" to the name when taken. Returns the final path.
 *
 * A hard link + unlink is an atomic "rename unless the target exists". Two
 * separately mounted folders count as different devices even on the same
 * disk (EXDEV), so then it copies, checks the copy, restores the timestamps,
 * and only then removes the source.
 */
export async function moveNoClobber(src: string, dir: string, name: string): Promise<string> {
  const st = await fs.stat(src)
  await fs.mkdir(dir, { recursive: true })

  for (let n = 0; n < MAX_NAME_ATTEMPTS; n++) {
    const dest = path.join(dir, numberedName(name, n))
    try {
      await fs.link(src, dest)
      await fs.unlink(src)
      return dest
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "EEXIST") continue
      if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") throw error
    }

    // No hard links here: copy without overwriting, verify, then remove.
    try {
      await fs.copyFile(src, dest, constants.COPYFILE_EXCL)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue
      throw error
    }
    try {
      const copied = await fs.stat(dest)
      if (copied.size !== st.size) throw new Error(`Copy of ${name} is incomplete (${copied.size} of ${st.size} bytes).`)
      await fs.utimes(dest, st.atime, st.mtime)
    } catch (error) {
      await fs.rm(dest, { force: true })
      throw error
    }
    await fs.unlink(src)
    return dest
  }
  throw new Error(`Too many files named like ${name} in the destination.`)
}

export type ActionResult = { ok: string[]; failed: { name: string; error: string }[] }

function message(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === "ENOENT") return "The file no longer exists."
  if (code === "EACCES" || code === "EPERM") return "Permission denied. Check the container's PUID/PGID."
  if (code === "ENOSPC") return "The disk is full."
  return error instanceof Error ? error.message : String(error)
}

async function eachFile(
  rootKey: RootKey,
  folder: string[],
  names: string[],
  fn: (file: string, name: string) => Promise<void>
): Promise<ActionResult> {
  const result: ActionResult = { ok: [], failed: [] }
  for (const name of names) {
    const file = resolveInside(rootPath(rootKey), [...folder, name])
    if (!file || !mediaKind(name)) {
      result.failed.push({ name, error: "Not a photo or video in this folder." })
      continue
    }
    try {
      await fn(file, name)
      result.ok.push(name)
    } catch (error) {
      result.failed.push({ name, error: message(error) })
    }
  }
  return result
}

/** Moves files from a Mobile Upload (or User Temp Storage) folder into the top of Sort Dropoff. */
export async function moveToDropoff(rootKey: "upload" | "temp", folder: string[], names: string[]): Promise<ActionResult> {
  const dropoff = rootPath("dropoff")
  return eachFile(rootKey, folder, names, async (file, name) => {
    const before = await fs.stat(file)
    const fromKey = cacheKey(rootKey, relOf(rootKey, file), before)
    // Straight into Dropoff, even from a day folder of a month scan ("18/IMG_1.jpg").
    const dest = await moveNoClobber(file, dropoff, path.basename(name))
    await moveCached(fromKey, cacheKey("dropoff", relOf("dropoff", dest), await fs.stat(dest)))
  })
}

/**
 * Copies `src` to `dir/name`, replacing a file already there. The copy is
 * written beside the target, checked, then renamed over it, so the old file
 * stays intact until the new one is complete. With `move`, the source is
 * removed once the copy is in place.
 */
async function placeReplacing(src: string, dir: string, name: string, move: boolean): Promise<void> {
  const dest = path.join(dir, name)
  if (path.resolve(src) === path.resolve(dest)) throw new Error("It's already there.")
  const st = await fs.stat(src)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${name}.${randomBytes(4).toString("hex")}.tmp`)
  try {
    await fs.copyFile(src, tmp)
    const copied = await fs.stat(tmp)
    if (copied.size !== st.size) throw new Error(`Copy of ${name} is incomplete (${copied.size} of ${st.size} bytes).`)
    await fs.utimes(tmp, st.atime, st.mtime)
    await fs.rename(tmp, dest)
  } finally {
    await fs.rm(tmp, { force: true })
  }
  if (move) await fs.unlink(src)
}

/**
 * Moves or copies files into a user's folder in User Temp Storage (created if
 * needed). Unlike every other operation here this replaces a file of the same
 * name: sending a photo again updates what's there.
 */
export async function sendToTemp(rootKey: RootKey, folder: string[], names: string[], userFolder: string, mode: "move" | "copy"): Promise<ActionResult> {
  const dir = resolveInside(rootPath("temp"), [userFolder])
  if (!dir) return { ok: [], failed: names.map((name) => ({ name, error: "Invalid destination." })) }
  return eachFile(rootKey, folder, names, (file, name) => placeReplacing(file, dir, path.basename(name), mode === "move"))
}

/**
 * Moves files into a new trash batch inside the same root, keeping their
 * folder structure so Undo can put them back.
 */
export async function trashFiles(rootKey: RootKey, folder: string[], names: string[]): Promise<ActionResult & { batchId: string }> {
  const batchId = trashBatchId(Date.now(), randomBytes(6).toString("hex"))
  const batchDir = path.join(rootPath(rootKey), TRASH_DIR, batchId, ...folder)
  const result = await eachFile(rootKey, folder, names, async (file, name) => {
    // `name` may sit in a subfolder ("18/IMG_1.jpg"); keep it so Undo puts it back there.
    await moveNoClobber(file, path.join(batchDir, path.dirname(name)), path.basename(name))
  })
  return { ...result, batchId }
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walkFiles(p)))
    else if (e.isFile()) out.push(p)
  }
  return out
}

/** Puts a trash batch back where it came from (renaming if a file has taken its place). */
export async function restoreBatch(rootKey: RootKey, batchId: string): Promise<ActionResult> {
  const result: ActionResult = { ok: [], failed: [] }
  if (trashBatchTime(batchId) === null) {
    result.failed.push({ name: batchId, error: "Unknown delete." })
    return result
  }
  const root = rootPath(rootKey)
  const batchDir = path.join(root, TRASH_DIR, batchId)
  let files: string[]
  try {
    files = await walkFiles(batchDir)
  } catch {
    result.failed.push({ name: batchId, error: "Nothing left to restore." })
    return result
  }
  for (const file of files) {
    const rel = path.relative(batchDir, file)
    try {
      await moveNoClobber(file, path.join(root, path.dirname(rel)), path.basename(rel))
      result.ok.push(path.basename(rel))
    } catch (error) {
      result.failed.push({ name: path.basename(rel), error: message(error) })
    }
  }
  await fs.rm(batchDir, { recursive: true, force: true }).catch(() => {})
  return result
}

/** Removes trash batches older than the retention period. Returns how many. */
export async function purgeTrash(rootKey: RootKey, now = Date.now()): Promise<number> {
  const trash = path.join(rootPath(rootKey), TRASH_DIR)
  let batches: string[]
  try {
    batches = await fs.readdir(trash)
  } catch {
    return 0
  }
  let purged = 0
  const cutoff = now - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  for (const id of batches) {
    const t = trashBatchTime(id)
    if (t !== null && t < cutoff) {
      await fs.rm(path.join(trash, id), { recursive: true, force: true })
      purged++
    }
  }
  return purged
}

/**
 * Turns photos 90°. JPEGs change only their EXIF orientation (no
 * re-compression); PNGs are lossless anyway and are rewritten. The file keeps
 * its modified date so it stays in place in date-sorted views.
 */
export async function rotateFiles(rootKey: RootKey, folder: string[], names: string[], direction: RotateDirection): Promise<ActionResult> {
  return eachFile(rootKey, folder, names, async (file) => {
    const st = await fs.stat(file)
    const ext = path.extname(file).toLowerCase()

    if (ext === ".jpg" || ext === ".jpeg") {
      const buf = new Uint8Array(await fs.readFile(file))
      if (!isJpeg(buf)) throw new Error("The file isn't a valid JPEG.")
      const edit = orientationEdit(buf, rotateOrientation(readOrientation(buf), direction))
      if (edit.kind === "patch") {
        // Two bytes, written in place: nothing else in the file is touched.
        const handle = await fs.open(file, "r+")
        try {
          await handle.write(edit.bytes, 0, edit.bytes.length, edit.offset)
          await handle.sync()
        } finally {
          await handle.close()
        }
      } else {
        await replaceFile(file, Buffer.from(edit.buffer), st.mode)
      }
    } else if (ext === ".png") {
      const out = await sharp(file).rotate(direction === "cw" ? 90 : 270).png({ compressionLevel: 9 }).toBuffer()
      await replaceFile(file, out, st.mode)
    } else {
      throw new Error("Rotation works on JPEG and PNG photos only.")
    }
    await fs.utimes(file, st.atime, st.mtime)
  })
}

/** Writes beside the original, then swaps it in, so a failure never leaves half a photo. */
async function replaceFile(file: string, data: Buffer, mode: number): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString("hex")}.tmp`)
  try {
    await fs.writeFile(tmp, data, { mode: mode & 0o777 })
    await fs.rename(tmp, file)
  } finally {
    await fs.rm(tmp, { force: true })
  }
}
