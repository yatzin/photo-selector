import "server-only"
import { randomBytes } from "crypto"
import { createWriteStream } from "fs"
import fs from "fs/promises"
import path from "path"
import { Readable, Transform } from "stream"
import { pipeline } from "stream/promises"
import sharp from "sharp"
import { probeStreams } from "./ffmpeg-server"
import { importCategory, importRejection, isUploadId, kindFromProbe, MAX_IMPORT_CHUNK_BYTES, sanitizeImportName } from "./import"
import { DEFAULT_IMAGE, type Asset } from "./project"
import { newAssetId, placeInAssets, projectDir } from "./projects-server"

// Files uploaded with Import, straight into a project's assets/ (never
// through the Inbox). The browser sends a file in pieces (lib/video/import
// IMPORT_CHUNK_BYTES), one request each, so no request is held open long and
// nothing big sits in memory: each piece streams onto the end of a hidden
// part file in the project's folder (".import-<id><ext>", the same volume as
// assets/). When the last piece is in, finishUpload (called under the
// project's lock) has ffmpeg read it, decides what it is from that alone, and
// renames it into assets/ under the next free name. Part files left by an
// upload that never finished are removed a day later.

const PART_PREFIX = ".import-"
const STALE_MS = 24 * 60 * 60 * 1000

export type UploadError = { error: string; status: number }

const fail = (error: string, status: number): UploadError => ({ error, status })

/** The part file of upload `id` for a file called `name` (already sanitised), or null when the project or id isn't valid. */
function partPath(userFolder: string, folder: string, id: string, name: string): string | null {
  const dir = projectDir(userFolder, folder)
  const ext = path.extname(name).toLowerCase()
  if (!dir || !isUploadId(id) || !importCategory(name)) return null
  return path.join(dir, `${PART_PREFIX}${id}${ext}`)
}

/** Removes part files older than a day (best effort). */
async function sweepStale(dir: string): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const n of names) {
    if (!n.startsWith(PART_PREFIX)) continue
    const file = path.join(dir, n)
    try {
      const st = await fs.lstat(file)
      if (st.isFile() && now - st.mtimeMs > STALE_MS) await fs.rm(file, { force: true })
    } catch {
      // Gone already.
    }
  }
}

/**
 * Starts an upload of a file called `rawName` (sanitised here), `size` bytes
 * long: checks the name and size (lib/video/import importRejection) and
 * creates its empty part file. Its id and the stored name, or an error with
 * the HTTP status to answer.
 */
export async function startUpload(userFolder: string, folder: string, rawName: string, size: number): Promise<{ id: string; name: string } | UploadError> {
  const name = sanitizeImportName(rawName)
  const rejected = importRejection(name, size)
  if (rejected) return fail(rejected, size > 0 && importCategory(name) ? 413 : 415)
  const dir = projectDir(userFolder, folder)
  if (!dir) return fail("Invalid project.", 400)
  try {
    if (!(await fs.stat(path.join(dir, "assets"))).isDirectory()) return fail("Project not found.", 404)
  } catch {
    return fail("Project not found.", 404)
  }
  await sweepStale(dir)
  const id = randomBytes(8).toString("hex")
  await fs.writeFile(partPath(userFolder, folder, id, name)!, new Uint8Array(0), { flag: "wx" })
  return { id, name }
}

/** Counts the bytes going through and fails past `limit`. */
function byteLimit(limit: number, counter: { bytes: number }): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      counter.bytes += chunk.length
      if (counter.bytes > limit) done(new Error("TOO_MUCH"))
      else done(null, chunk)
    },
  })
}

/**
 * Appends one piece (`body`, streamed) at byte `offset` of upload `id`: the
 * part file must be exactly `offset` long (a retried piece after a failed one
 * starts where the file ends) and the piece may not take it past `size` or
 * be over MAX_IMPORT_CHUNK_BYTES. A failed piece is cut off again, so the
 * same piece can be sent again. The bytes received so far, or an error.
 */
export async function writeChunk(
  userFolder: string, folder: string, id: string, name: string, size: number, offset: number, body: ReadableStream<Uint8Array> | null
): Promise<{ received: number } | UploadError> {
  const part = partPath(userFolder, folder, id, name)
  if (!part || !Number.isSafeInteger(offset) || offset < 0 || offset > size) return fail("Invalid upload.", 400)
  try {
    const st = await fs.lstat(part)
    if (!st.isFile()) return fail("Invalid upload.", 400)
    if (st.size !== offset) return fail(`The upload is at byte ${st.size}, not ${offset}.`, 409)
  } catch {
    return fail("That upload is gone. Start it again.", 404)
  }
  if (!body) return { received: offset }
  const counter = { bytes: 0 }
  try {
    await pipeline(Readable.fromWeb(body as import("stream/web").ReadableStream<Uint8Array>), byteLimit(Math.min(MAX_IMPORT_CHUNK_BYTES, size - offset), counter), createWriteStream(part, { flags: "r+", start: offset }))
  } catch (error) {
    await fs.truncate(part, offset).catch(() => {})
    if (error instanceof Error && error.message === "TOO_MUCH") return fail(`${name} sent more than it said it would.`, 413)
    return fail("The upload was interrupted.", 400)
  }
  return { received: offset + counter.bytes }
}

/** Removes upload `id`'s part file (a cancelled upload). */
export async function cancelUpload(userFolder: string, folder: string, id: string, name: string): Promise<void> {
  const part = partPath(userFolder, folder, id, sanitizeImportName(name))
  if (part) await fs.rm(part, { force: true })
}

/** True when sharp can decode `file` as a picture (for stills ffmpeg can't read, such as some HEIC and DNG files). */
async function sharpReads(file: string): Promise<boolean> {
  try {
    const m = await sharp(file, { failOn: "none", limitInputPixels: false }).metadata()
    return (m.width ?? 0) > 0 && (m.height ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * Finishes upload `id` once all `size` bytes are in (call it under the
 * project's lock): ffmpeg reads the part file and kindFromProbe says what it
 * is (an image sharp can decode counts too), whatever the name or the browser
 * claimed; then it's renamed into assets/ as `name` or the next free numbered
 * name, never replacing a file. Its asset (`source`: the name it was uploaded
 * under) and a new id, for the caller to add to the project; the part file is
 * removed on any failure.
 */
export async function finishUpload(userFolder: string, folder: string, id: string, name: string, size: number): Promise<{ id: string; asset: Asset } | UploadError> {
  const dir = projectDir(userFolder, folder)
  const part = partPath(userFolder, folder, id, name)
  if (!dir || !part) return fail("Invalid upload.", 400)
  try {
    const st = await fs.lstat(part)
    if (!st.isFile()) return fail("Invalid upload.", 400)
    if (st.size !== size) return fail(`${name} isn't complete yet.`, 409)
    let streams = await probeStreams(part)
    if (importCategory(name) === "image" && !streams.hasVideo && (await sharpReads(part))) streams = { ...streams, hasVideo: true }
    const kind = kindFromProbe(name, streams)
    if ("error" in kind) {
      await fs.rm(part, { force: true })
      return fail(kind.error, 415)
    }
    const placed = await placeInAssets(path.join(dir, "assets"), name, async (target) => {
      // A hard link never replaces a file (EEXIST); where links aren't possible, the lock keeps the check and the rename together.
      try {
        await fs.link(part, target)
        await fs.rm(part, { force: true })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "EEXIST" || code === "ENOENT") throw error
        if (await fs.lstat(target).then(() => true, () => false)) throw Object.assign(new Error("exists"), { code: "EEXIST" })
        await fs.rename(part, target)
      }
    })
    if ("error" in placed) {
      await fs.rm(part, { force: true })
      return fail(placed.error, 500)
    }
    const asset: Asset =
      kind.kind === "image"
        ? { file: placed.file, duration: DEFAULT_IMAGE, hasAudio: false, kind: "image", source: name }
        : { file: placed.file, duration: kind.duration, hasAudio: kind.hasAudio, ...(kind.kind === "audio" ? { kind: "audio" as const } : {}), source: name }
    return { id: newAssetId(), asset }
  } catch (error) {
    await fs.rm(part, { force: true }).catch(() => {})
    return fail(error instanceof Error ? error.message : String(error), 500)
  }
}
