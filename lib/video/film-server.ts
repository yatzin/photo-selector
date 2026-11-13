import "server-only"
import { spawn } from "child_process"
import { randomBytes } from "crypto"
import fs from "fs/promises"
import path from "path"
import { FILM_WIDTH, filmDirName, filmFrameName, filmInterval } from "./film"
import { assetKind } from "./project"
import { assetPath, readProject } from "./projects-server"

// The filmstrip snapshots of a project's video assets (see lib/video/film):
// made with one ffmpeg pass on the first request, kept beside the asset and
// reused after (an asset's file never changes). One pass per asset at a time,
// and one pass at once over all of them (decoding a long video is heavy).

const ffmpeg = () => process.env.FFMPEG_PATH || "ffmpeg"
const TIMEOUT = 15 * 60_000 // ms
/** Over this length only keyframes are decoded: far quicker, and a snapshot every half second or more doesn't need more. */
const KEYFRAMES_ONLY_OVER = 180 // s
const META = "done.json"

export type FilmInfo = { interval: number; count: number }

function takeSnapshots(media: string, dir: string, interval: number, duration: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-nostdin", "-v", "error",
      ...(duration > KEYFRAMES_ONLY_OVER ? ["-skip_frame", "nokey"] : []),
      "-i", media, "-an", "-sn",
      "-vf", `fps=${(1 / interval).toFixed(6)},scale=${FILM_WIDTH}:-2`,
      "-q:v", "6", "-start_number", "0", "-f", "image2", path.join(dir, "%05d.jpg"),
    ]
    const child = spawn(ffmpeg(), args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] })
    let lastErr = ""
    let settled = false
    const done = (error: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        child.kill("SIGKILL")
        reject(error)
      } else resolve()
    }
    const timer = setTimeout(() => done(new Error("Making the snapshots timed out.")), TIMEOUT)
    child.stderr.on("data", (chunk: Buffer) => {
      const last = chunk.toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()
      if (last) lastErr = last
    })
    child.on("error", (error) => done(error))
    child.on("close", (code) => done(code === 0 ? null : new Error(lastErr || `ffmpeg exited with code ${code}.`)))
  })
}

let running = false
const waiting: (() => void)[] = []
const inFlight = new Map<string, Promise<FilmInfo>>()

async function withSlot<T>(run: () => Promise<T>): Promise<T> {
  if (running) await new Promise<void>((r) => waiting.push(r))
  running = true
  try {
    return await run()
  } finally {
    running = false
    waiting.shift()?.()
  }
}

async function readInfo(dir: string): Promise<FilmInfo | null> {
  try {
    const v: unknown = JSON.parse(await fs.readFile(path.join(dir, META), "utf8"))
    const { interval, count } = v as FilmInfo
    return Number.isFinite(interval) && interval > 0 && Number.isInteger(count) && count > 0 ? { interval, count } : null
  } catch {
    return null
  }
}

/** The snapshot folder beside an asset file. */
const filmDirFor = (media: string): string => path.join(path.dirname(media), filmDirName(path.basename(media)))

/** The snapshots for `media`, made (once, even when asked for many times at once) when they aren't there yet. */
function ensureFilm(media: string, duration: number): Promise<FilmInfo> {
  const dir = filmDirFor(media)
  const pending = inFlight.get(dir)
  if (pending) return pending
  const job = (async () => {
    const kept = await readInfo(dir)
    if (kept) return kept
    const interval = filmInterval(duration)
    // Made in a folder of its own and moved into place, so a reader never sees half of it.
    const tmp = `${dir}.${randomBytes(6).toString("hex")}.tmp`
    await fs.mkdir(tmp)
    try {
      await withSlot(() => takeSnapshots(media, tmp, interval, duration))
      const count = (await fs.readdir(tmp)).filter((n) => n.endsWith(".jpg")).length
      if (count === 0) throw new Error("No snapshots were made.")
      const info = { interval, count }
      await fs.writeFile(path.join(tmp, META), JSON.stringify(info))
      await fs.rm(dir, { recursive: true, force: true })
      await fs.rename(tmp, dir)
      return info
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })().finally(() => inFlight.delete(dir))
  inFlight.set(dir, job)
  return job
}

/** The stored project's video asset (its file and length), or null when the project or asset isn't there, isn't a video, or its file is gone. */
async function videoAsset(userFolder: string, folder: string, assetId: string): Promise<{ media: string; duration: number } | null> {
  const p = await readProject(userFolder, folder)
  const asset = p && Object.hasOwn(p.assets, assetId) ? p.assets[assetId] : undefined
  if (!asset || assetKind(asset) !== "video" || !(asset.duration > 0)) return null
  const media = assetPath(userFolder, folder, asset.file)
  if (!media) return null
  try {
    if (!(await fs.lstat(media)).isFile()) return null
  } catch {
    return null
  }
  return { media, duration: asset.duration }
}

/** How a video's snapshots are spaced and how many there are; null when it has none to make. Throws when ffmpeg can't read it. */
export async function assetFilmInfo(userFolder: string, folder: string, assetId: string): Promise<FilmInfo | null> {
  const v = await videoAsset(userFolder, folder, assetId)
  return v ? ensureFilm(v.media, v.duration) : null
}

/** One snapshot's JPEG bytes (making them all first when needed); null when there is no such snapshot. */
export async function assetFilmFrame(userFolder: string, folder: string, assetId: string, index: number): Promise<Uint8Array | null> {
  const v = await videoAsset(userFolder, folder, assetId)
  if (!v) return null
  const info = await ensureFilm(v.media, v.duration)
  if (!Number.isInteger(index) || index < 0 || index >= info.count) return null
  try {
    return new Uint8Array(await fs.readFile(path.join(filmDirFor(v.media), filmFrameName(index))))
  } catch {
    return null
  }
}
