import "server-only"
import { spawn } from "child_process"
import { randomBytes } from "crypto"
import fs from "fs/promises"
import path from "path"
import { assetKind } from "./project"
import { createPeakBinner, decodePeaks, encodePeaks, PEAKS_RATE, peaksFileName } from "./peaks"
import { assetPath, readProject } from "./projects-server"

// The waveform peaks of a project's video assets: decoded with ffmpeg on the
// first request, cached beside the asset as `.<file>.peaks` and reused after
// (an asset's file never changes). One decode per file at a time, and at most
// MAX_DECODES at once over all of them.

const ffmpeg = () => process.env.FFMPEG_PATH || "ffmpeg"
const PCM_RATE = 8000
const DECODE_TIMEOUT = 120_000 // ms; a long file's sound decodes well inside this
const MAX_DECODES = 2

/** The peaks (PEAKS_RATE a second, 0..255) of a media file's sound, streamed from ffmpeg (mono s16le at 8 kHz) without buffering the PCM. */
export function decodeAudioPeaks(file: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(PCM_RATE), "-f", "s16le", "-"]
    const child = spawn(ffmpeg(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    const binner = createPeakBinner(PCM_RATE / PEAKS_RATE)
    let lastErr = ""
    let settled = false
    const done = (error: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        child.kill("SIGKILL")
        reject(error)
      } else resolve(binner.finish())
    }
    const timer = setTimeout(() => done(new Error("Reading the sound timed out.")), DECODE_TIMEOUT)
    child.stdout.on("data", (chunk: Buffer) => binner.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => {
      const last = chunk.toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()
      if (last) lastErr = last
    })
    child.on("error", (error) => done(error))
    child.on("close", (code) => done(code === 0 ? null : new Error(lastErr || `ffmpeg exited with code ${code}.`)))
  })
}

// Decodes waiting for a free slot, and the one running per cache file.
let running = 0
const waiting: (() => void)[] = []
const inFlight = new Map<string, Promise<Uint8Array>>()

async function withDecodeSlot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= MAX_DECODES) await new Promise<void>((r) => waiting.push(r))
  running++
  try {
    return await run()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/** Writes beside the target, then renames over it, so a reader never sees half a file. */
async function writeAtomic(file: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  try {
    await fs.writeFile(tmp, bytes)
    await fs.rename(tmp, file)
  } finally {
    await fs.rm(tmp, { force: true })
  }
}

/** The cache file's bytes for `media`, made (once, even when asked for many times at once) when it isn't there yet. */
function cachedPeaks(media: string): Promise<Uint8Array> {
  const cache = path.join(path.dirname(media), peaksFileName(path.basename(media)))
  const pending = inFlight.get(cache)
  if (pending) return pending
  const job = (async () => {
    try {
      const bytes = new Uint8Array(await fs.readFile(cache))
      if (decodePeaks(bytes)) return bytes
    } catch {
      // Not made yet.
    }
    const bytes = encodePeaks(await withDecodeSlot(() => decodeAudioPeaks(media)), PEAKS_RATE)
    // Caching is best effort: the peaks are good either way.
    await writeAtomic(cache, bytes).catch(() => {})
    return bytes
  })().finally(() => inFlight.delete(cache))
  inFlight.set(cache, job)
  return job
}

/**
 * The peaks file's bytes (see lib/video/peaks) for an asset of the stored
 * project: null when the project or asset isn't there, isn't a video with
 * sound, or its file is gone. Throws when ffmpeg can't read it.
 */
export async function assetPeaks(userFolder: string, folder: string, assetId: string): Promise<Uint8Array | null> {
  const p = await readProject(userFolder, folder)
  const asset = p && Object.hasOwn(p.assets, assetId) ? p.assets[assetId] : undefined
  if (!asset || assetKind(asset) !== "video" || !asset.hasAudio) return null
  const media = assetPath(userFolder, folder, asset.file)
  if (!media) return null
  try {
    if (!(await fs.lstat(media)).isFile()) return null
  } catch {
    return null
  }
  return cachedPeaks(media)
}
