import "server-only"
import { randomBytes } from "crypto"
import fs from "fs/promises"
import path from "path"
import { moveNoClobber } from "@/lib/file-ops-server"
import { rootPath } from "@/lib/library-server"
import { resolveInside } from "@/lib/media"
import { probeStreams } from "@/lib/video/ffmpeg-server"
import { importCategory, isUploadId, kindFromProbe, sanitizeImportName, tempUploadRejection } from "@/lib/video/import"
import { appendChunk, sharpReads, type UploadError } from "@/lib/video/import-server"

// Files uploaded from the computer straight into a Personal Storage folder.
// Same pieces-at-a-time scheme as Video Editing's Import (lib/video/import-server):
// each piece streams onto a hidden part file, here in a hidden folder at the
// top of Personal Storage (same volume, skipped by listings), and the finished
// file is checked with ffmpeg and moved into the folder under the next free
// name. Pictures and videos only: that's what Personal Storage holds. Part
// files left by an upload that never finished are removed a day later.

const PARTS_DIR = ".photo-selector-uploads"
const STALE_MS = 24 * 60 * 60 * 1000

const fail = (error: string, status: number): UploadError => ({ error, status })

const partsDir = () => path.join(rootPath("temp"), PARTS_DIR)

function partPath(id: string, name: string): string | null {
  if (!isUploadId(id) || !importCategory(name)) return null
  return path.join(partsDir(), `${id}${path.extname(name).toLowerCase()}`)
}

async function sweepStale(): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(partsDir())
  } catch {
    return
  }
  for (const n of names) {
    const file = path.join(partsDir(), n)
    try {
      const st = await fs.lstat(file)
      if (st.isFile() && Date.now() - st.mtimeMs > STALE_MS) await fs.rm(file, { force: true })
    } catch {
      // Gone already.
    }
  }
}

/** The folder `parent` (below a user's own folder level: at least the user's folder), when it exists. */
async function targetDir(parent: string[]): Promise<string | null> {
  if (parent.length === 0) return null
  const dir = resolveInside(rootPath("temp"), parent)
  if (!dir) return null
  try {
    return (await fs.stat(dir)).isDirectory() ? dir : null
  } catch {
    return null
  }
}

/** Starts an upload of `rawName` (`size` bytes) into `parent`: its id and the stored name, or an error with the HTTP status. */
export async function startTempUpload(parent: string[], rawName: string, size: number): Promise<{ id: string; name: string } | UploadError> {
  const name = sanitizeImportName(rawName)
  const rejected = tempUploadRejection(name, size)
  if (rejected) return fail(rejected, size > 0 && importCategory(name) ? 413 : 415)
  if (!(await targetDir(parent))) return fail("That folder no longer exists.", 404)
  await fs.mkdir(partsDir(), { recursive: true })
  await sweepStale()
  const id = randomBytes(8).toString("hex")
  await fs.writeFile(partPath(id, name)!, new Uint8Array(0), { flag: "wx" })
  return { id, name }
}

/** One piece of upload `id` at byte `offset`; the bytes received so far, or an error. */
export async function writeTempChunk(id: string, name: string, size: number, offset: number, body: ReadableStream<Uint8Array> | null): Promise<{ received: number } | UploadError> {
  const part = partPath(id, name)
  if (!part) return fail("Invalid upload.", 400)
  try {
    const st = await fs.lstat(part)
    if (!st.isFile()) return fail("Invalid upload.", 400)
    if (st.size !== offset) return fail(`The upload is at byte ${st.size}, not ${offset}.`, 409)
  } catch {
    return fail("That upload is gone. Start it again.", 404)
  }
  return appendChunk(part, name, size, offset, body)
}

export async function cancelTempUpload(id: string, name: string): Promise<void> {
  const part = partPath(id, sanitizeImportName(name))
  if (part) await fs.rm(part, { force: true })
}

/** Checks the finished upload with ffmpeg (a picture or a video, whatever its name says) and moves it into `parent`. The stored name, or an error. */
export async function finishTempUpload(parent: string[], id: string, name: string, size: number): Promise<{ name: string } | UploadError> {
  const part = partPath(id, name)
  const dir = await targetDir(parent)
  if (!part) return fail("Invalid upload.", 400)
  try {
    const st = await fs.lstat(part)
    if (!st.isFile()) return fail("Invalid upload.", 400)
    if (st.size !== size) return fail(`${name} isn't complete yet.`, 409)
    if (!dir) {
      await fs.rm(part, { force: true })
      return fail("That folder no longer exists.", 404)
    }
    let streams = await probeStreams(part)
    if (importCategory(name) === "image" && !streams.hasVideo && (await sharpReads(part))) streams = { ...streams, hasVideo: true }
    const kind = kindFromProbe(name, streams)
    if ("error" in kind || kind.kind === "audio") {
      await fs.rm(part, { force: true })
      return fail("error" in kind ? kind.error : `${name} has no picture, so it isn't a video.`, 415)
    }
    const placed = await moveNoClobber(part, dir, name)
    return { name: path.basename(placed) }
  } catch (error) {
    await fs.rm(part, { force: true }).catch(() => {})
    return fail(error instanceof Error ? error.message : String(error), 500)
  }
}
