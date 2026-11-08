import "server-only"
import { createHash, randomBytes } from "crypto"
import fs from "fs/promises"
import path from "path"
import { cacheDir } from "@/lib/library-server"
import { isPlainName } from "@/lib/media"
import type { ClipAudio } from "./audio-levels"
import { previewKey, previewWindow, type PreviewRequest } from "./audio-preview"
import { clipSoundChain, runExport } from "./ffmpeg-server"
import { assetKind } from "./project"
import { assetPath, readProject } from "./projects-server"

// Rendered previews for the Audio levels dialog (Generate preview): the first
// PREVIEW_CAP seconds of a clip's source window through the export's own
// chain (clipSoundChain), as AAC in an .m4a. Cached under the cache folder in
// audio-previews/<user>/<project>/<hash>.m4a, the hash covering the asset,
// the window, the gain and the effects, so a file never changes; previews
// older than an hour or past the newest 50 are removed on each request. At
// most MAX_RENDERS run at once over all users, MAX_QUEUE more wait (beyond
// that: busy); identical renders share one ffmpeg, which is killed only when
// every request waiting on it has gone.

export const PREVIEW_TIMEOUT = 60_000 // ms
export const MAX_RENDERS = 2
export const MAX_QUEUE = 6
export const KEEP_MS = 60 * 60 * 1000
export const KEEP_COUNT = 50

export type PreviewErrorCode = "not-found" | "busy" | "timeout" | "failed" | "cancelled"

/** A preview that couldn't be made; the message is safe to show. */
export class PreviewError extends Error {
  constructor(readonly code: PreviewErrorCode, message: string) {
    super(message)
  }
}

/** Runs ffmpeg with `args` writing `outFile` (removed on failure); rejects when it fails or `signal` aborts. */
export type PreviewRunner = (args: string[], outFile: string, seconds: number, signal: AbortSignal) => Promise<void>

const defaultRunner: PreviewRunner = (args, outFile, seconds, signal) => runExport(args, outFile, seconds, () => {}, PREVIEW_TIMEOUT + 5000, signal)

export const previewRoot = () => path.join(cacheDir(), "audio-previews")

const ID = /^[0-9a-f]{32}$/

/** The cached preview file `id` of a user's project, or null for a name that isn't one. */
export function previewFile(userFolder: string, folder: string, id: string): string | null {
  if (!isPlainName(userFolder) || !isPlainName(folder) || !ID.test(id)) return null
  return path.join(previewRoot(), userFolder, folder, `${id}.m4a`)
}

/** The cache file's name (32 hex characters) for a preview of the asset, window and levels. */
export const previewId = (assetId: string, win: { in: number; out: number }, audio: ClipAudio | undefined) =>
  createHash("sha256").update(previewKey(assetId, win, audio)).digest("hex").slice(0, 32)

/** ffmpeg's arguments: seek to the window's start, run the clip's sound chain over its length, AAC into `outFile`. */
export function previewArgs(file: string, win: { in: number; out: number }, audio: ClipAudio | undefined, outFile: string): string[] {
  const length = win.out - win.in
  const chain = clipSoundChain(0, length, audio).replace(/,$/, "")
  return ["-hide_banner", "-nostdin", "-v", "error", "-ss", String(win.in), "-i", file, "-vn", "-af", chain, "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-f", "mp4", "-y", outFile]
}

/** Removes previews (and left-over temporary files) older than `keepMs`, then all but the newest `keepCount` previews. Best effort. */
export async function prunePreviews(root = previewRoot(), now = Date.now(), keepCount = KEEP_COUNT, keepMs = KEEP_MS): Promise<void> {
  const files: { file: string; mtime: number }[] = []
  const list = (dir: string) => fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const user of await list(root)) {
    if (!user.isDirectory()) continue
    for (const project of await list(path.join(root, user.name))) {
      if (!project.isDirectory()) continue
      const dir = path.join(root, user.name, project.name)
      for (const f of await list(dir)) {
        if (!f.isFile()) continue
        const file = path.join(dir, f.name)
        const stat = await fs.stat(file).catch(() => null)
        if (!stat) continue
        if (now - stat.mtimeMs > keepMs) await fs.rm(file, { force: true }).catch(() => {})
        else if (f.name.endsWith(".m4a") && !f.name.includes(".tmp")) files.push({ file, mtime: stat.mtimeMs })
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  for (const { file } of files.slice(keepCount)) await fs.rm(file, { force: true }).catch(() => {})
}

// Renders running and waiting (over all users), and the one in flight per cache file.
let running = 0
const waiting: (() => void)[] = []
const inFlight = new Map<string, { promise: Promise<void>; controller: AbortController; waiters: number }>()

const cancelled = () => new PreviewError("cancelled", "Cancelled.")

/** Runs `run` in a render slot, waiting for one when MAX_RENDERS are busy; busy when MAX_QUEUE are already waiting. */
async function withSlot<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (running >= MAX_RENDERS) {
    if (waiting.length >= MAX_QUEUE) throw new PreviewError("busy", "Too many previews are rendering. Try again in a moment.")
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal.removeEventListener("abort", leave)
        resolve()
      }
      const leave = () => {
        const i = waiting.indexOf(go)
        if (i >= 0) waiting.splice(i, 1)
        reject(cancelled())
      }
      waiting.push(go)
      signal.addEventListener("abort", leave, { once: true })
    })
  }
  running++
  try {
    return await run()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/** Waits for the render of `key` (starting it with `make` when none is running); aborting `signal` leaves it, and the last to leave stops it. */
function shared(key: string, make: (signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
  let entry = inFlight.get(key)
  if (!entry) {
    const controller = new AbortController()
    const promise = make(controller.signal).finally(() => inFlight.delete(key))
    entry = { promise, controller, waiters: 0 }
    inFlight.set(key, entry)
  }
  const e = entry
  e.waiters++
  return new Promise<void>((resolve, reject) => {
    let done = false
    const leave = () => {
      if (done) return
      done = true
      if (--e.waiters === 0) e.controller.abort()
      reject(cancelled())
    }
    if (signal.aborted) return leave()
    signal.addEventListener("abort", leave, { once: true })
    e.promise.then(
      () => {
        if (done) return
        done = true
        e.waiters--
        signal.removeEventListener("abort", leave)
        resolve()
      },
      (error) => {
        if (done) return
        done = true
        e.waiters--
        signal.removeEventListener("abort", leave)
        reject(error)
      }
    )
  })
}

/**
 * The rendered preview for `req` of the user's stored project: its cache id
 * and length, made with ffmpeg unless it's cached. Throws a PreviewError:
 * not-found (no such project or asset, an image, a file without sound or
 * that's gone), busy, timeout (PREVIEW_TIMEOUT), failed or cancelled.
 * Tests pass their own runner and timeout.
 */
export async function renderAudioPreview(
  userFolder: string, folder: string, req: PreviewRequest, signal: AbortSignal,
  { runner = defaultRunner, timeoutMs = PREVIEW_TIMEOUT }: { runner?: PreviewRunner; timeoutMs?: number } = {}
): Promise<{ id: string; durationSec: number; cached: boolean }> {
  await prunePreviews()
  const notFound = new PreviewError("not-found", "That clip's media is gone.")
  if (!isPlainName(userFolder) || !isPlainName(folder) || !isPlainName(req.assetId)) throw notFound
  const p = await readProject(userFolder, folder)
  const asset = p && Object.hasOwn(p.assets, req.assetId) ? p.assets[req.assetId] : undefined
  if (!asset || assetKind(asset) === "image" || !asset.hasAudio) throw notFound
  const media = assetPath(userFolder, folder, asset.file)
  if (!media || !(await fs.stat(media).then((s) => s.isFile(), () => false))) throw notFound
  if (req.in >= asset.duration) throw new PreviewError("not-found", "That part of the file is past its end.")
  const win = previewWindow(req.in, Math.min(req.out, asset.duration))
  const durationSec = Math.round((win.out - win.in) * 1000) / 1000
  const id = previewId(req.assetId, win, req.audio)
  const out = previewFile(userFolder, folder, id)!
  // Cached: touched, so it counts as new for the pruning.
  if (await fs.utimes(out, new Date(), new Date()).then(() => true, () => false)) return { id, durationSec, cached: true }

  await shared(out, (stop) => withSlot(stop, async () => {
    await fs.mkdir(path.dirname(out), { recursive: true })
    const tmp = `${out}.${randomBytes(6).toString("hex")}.tmp`
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    try {
      await runner(previewArgs(media, win, req.audio, tmp), tmp, durationSec, AbortSignal.any([stop, timeout.signal]))
      await fs.rename(tmp, out)
    } catch {
      await fs.rm(tmp, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
      if (timeout.signal.aborted) throw new PreviewError("timeout", "The preview took too long to render.")
      if (stop.aborted) throw cancelled()
      throw new PreviewError("failed", "The preview couldn't be rendered.")
    } finally {
      clearTimeout(timer)
    }
  }), signal)
  return { id, durationSec, cached: false }
}
