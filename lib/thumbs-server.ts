import "server-only"
import { createHash, randomBytes } from "crypto"
import { execFile } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import sharp from "sharp"
import { cacheDir } from "@/lib/library-server"
import { fileVersion, mediaKind } from "@/lib/media"
import { createTaskQueue, type Priority } from "@/lib/task-queue"

// Thumbnails and previews, made from the photo on the NAS's own disk and
// cached under PHOTOS_CACHE_DIR as WebP. The cache key includes the file's
// version (size, mtime, ctime), so an edited or replaced photo gets a fresh
// image and the stale one is swept up by the background worker.

export type Variant = "thumb" | "preview"

export const VARIANTS: Record<Variant, { px: number; quality: number }> = {
  thumb: { px: 400, quality: 72 },
  preview: { px: 2048, quality: 82 },
}

const HEIF_EXTENSIONS = new Set([".heic", ".heif"])

// libvips already uses several threads per image; a few images at a time is
// enough to keep the NAS busy without starving the web server.
const g = globalThis as unknown as { __psThumbQueue?: ReturnType<typeof createTaskQueue> }
export const thumbQueue = (g.__psThumbQueue ??= createTaskQueue(Math.max(1, Math.min(3, os.cpus().length - 1))))

export function cacheRoot(): string {
  return cacheDir()
}

export function cacheKey(rootKey: string, relPath: string, st: { size: number; mtimeMs: number; ctimeMs: number }): string {
  return createHash("sha1").update(`${rootKey}\0${relPath.split(path.sep).join("/")}\0${fileVersion(st)}`).digest("hex")
}

export function cachePath(key: string, variant: Variant): string {
  return path.join(cacheRoot(), variant, key.slice(0, 2), `${key}.webp`)
}

/** Written when a file can't be decoded, so the worker doesn't retry it forever. */
function failPath(key: string): string {
  return path.join(cacheRoot(), "failed", key.slice(0, 2), key)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function run(cmd: string, args: string[], opts: { encoding: "buffer"; maxBuffer?: number } = { encoding: "buffer" }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout as Buffer)
    })
  })
}

const ffmpeg = () => process.env.FFMPEG_PATH || "ffmpeg"

/** One frame as JPEG bytes. ffmpeg applies the video's rotation itself. */
async function videoFrame(file: string): Promise<Buffer> {
  for (const seek of ["1", "0"]) {
    try {
      const out = await run(ffmpeg(), [
        "-v", "error", "-ss", seek, "-i", file, "-frames:v", "1",
        "-vf", "scale='min(2048,iw)':-2", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "3", "-",
      ])
      if (out.length > 0) return out
    } catch {
      // A clip shorter than a second has no frame at 1s; try the first one.
    }
  }
  throw new Error("ffmpeg could not read a frame")
}

/**
 * HEIC from iPhones uses HEVC, which sharp's bundled libvips can't decode.
 * heif-convert (libheif, installed in the container) handles it; ffmpeg 7+
 * is a fallback for local development.
 */
async function decodeHeif(file: string): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `ps-${randomBytes(6).toString("hex")}.jpg`)
  try {
    await run("heif-convert", ["-q", "92", file, tmp])
    return await fs.readFile(tmp)
  } catch {
    return await run(ffmpeg(), ["-v", "error", "-i", file, "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "2", "-"])
  } finally {
    await fs.rm(tmp, { force: true })
  }
}

async function toWebp(input: string | Buffer, variant: Variant, out: string): Promise<void> {
  const { px, quality } = VARIANTS[variant]
  await fs.mkdir(path.dirname(out), { recursive: true })
  const tmp = `${out}.${randomBytes(4).toString("hex")}.tmp`
  try {
    // failOn "none": a phone photo with a truncated tail still has a picture.
    await sharp(input, { failOn: "none", limitInputPixels: false })
      .rotate() // apply EXIF orientation, then drop it
      .resize({ width: px, height: px, fit: "inside", withoutEnlargement: true })
      .webp({ quality, effort: 2 })
      .toFile(tmp)
    await fs.rename(tmp, out)
  } finally {
    await fs.rm(tmp, { force: true })
  }
}

async function render(file: string, variant: Variant, out: string): Promise<void> {
  if (mediaKind(file) === "video") return toWebp(await videoFrame(file), variant, out)
  try {
    await toWebp(file, variant, out)
  } catch (error) {
    if (!HEIF_EXTENSIONS.has(path.extname(file).toLowerCase())) throw error
    await toWebp(await decodeHeif(file), variant, out)
  }
}

export type VariantResult = { path: string } | { failed: true }

/**
 * The cached variant for a media file, made now if missing. `relPath` is the
 * file's path inside its library root (used only for the cache key).
 */
export async function ensureVariant(
  rootKey: string,
  relPath: string,
  file: string,
  variant: Variant,
  priority: Priority = "high"
): Promise<VariantResult> {
  const st = await fs.stat(file)
  const key = cacheKey(rootKey, relPath, st)
  const out = cachePath(key, variant)
  if (await exists(out)) return { path: out }
  if (await exists(failPath(key))) return { failed: true }

  return thumbQueue.run(`${key}:${variant}`, async () => {
    if (await exists(out)) return { path: out }
    try {
      await render(file, variant, out)
      return { path: out }
    } catch (error) {
      console.warn(`[thumbs] could not render ${relPath}:`, error instanceof Error ? error.message : error)
      await fs.mkdir(path.dirname(failPath(key)), { recursive: true })
      await fs.writeFile(failPath(key), String(error instanceof Error ? error.message : error))
      return { failed: true }
    }
  }, priority)
}

/** Whether every variant for this version of the file is already cached (or known to fail). */
export async function isCached(key: string, variants: Variant[]): Promise<boolean> {
  if (await exists(failPath(key))) return true
  for (const v of variants) if (!(await exists(cachePath(key, v)))) return false
  return true
}

/**
 * After a file is moved, carry its cached images over to the new path's key
 * instead of rendering them again.
 */
export async function moveCached(fromKey: string, toKey: string): Promise<void> {
  for (const v of Object.keys(VARIANTS) as Variant[]) {
    const to = cachePath(toKey, v)
    try {
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.rename(cachePath(fromKey, v), to)
    } catch {
      // Not cached yet; it will be made when needed.
    }
  }
}

/**
 * Removes cached images whose key isn't in `keep` and that are older than
 * `minAgeMs` (so a thumbnail made during the scan isn't swept by it).
 */
export async function sweepCache(keep: Set<string>, minAgeMs: number): Promise<number> {
  let removed = 0
  const cutoff = Date.now() - minAgeMs
  for (const dir of [...(Object.keys(VARIANTS) as Variant[]), "failed"]) {
    const base = path.join(cacheRoot(), dir)
    let buckets: string[]
    try {
      buckets = await fs.readdir(base)
    } catch {
      continue
    }
    for (const bucket of buckets) {
      let names: string[]
      try {
        names = await fs.readdir(path.join(base, bucket))
      } catch {
        continue
      }
      for (const name of names) {
        const key = name.replace(/\.webp$/, "")
        if (keep.has(key)) continue
        const p = path.join(base, bucket, name)
        try {
          const st = await fs.stat(p)
          if (st.mtimeMs < cutoff) {
            await fs.rm(p, { force: true })
            removed++
          }
        } catch {
          // already gone
        }
      }
    }
  }
  return removed
}
