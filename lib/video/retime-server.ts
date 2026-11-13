import "server-only"
import { createHash, randomBytes } from "crypto"
import os from "os"
import { spawn } from "child_process"
import fs from "fs/promises"
import path from "path"
import { z } from "zod"
import { ffmpegPath, probeMedia } from "./ffmpeg-server"
import { assetKind, assetLabel, type Asset } from "./project"
import { withLock } from "./project-lock-server"
import { assetPath, newAssetId, projectDir, readProject, writeProject } from "./projects-server"
import { previewWindow, retimeArgs, retimeError, retimeTitle, sourceWindow } from "./retime"

// "Speed / Reverse": makes a copy of the part of a video the clip uses, played
// at another speed or backwards, and returns it as a hidden asset (marked
// `retime`) for the clip to point at. The original file is never changed, and
// the source of a retimed clip is always the original, so repeated changes never
// stack losses. Speed 1 not reversed needs no copy: the original comes back.

const TIMEOUT_MS = 15 * 60 * 1000
const FAILED = "Couldn't make that speed. The video may be damaged or too large."

export const retimeOptions = z.object({
  in: z.number().finite().min(0),
  out: z.number().finite().min(0),
  speed: z.number().finite(),
  reverse: z.boolean(),
})

export type RetimeResult = { id: string; asset: Asset; in: number; out: number } | { error: string }

function run(input: string, output: string, o: Parameters<typeof retimeArgs>[2]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), retimeArgs(input, output, o), { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] })
    let settled = false
    const done = async (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (ok && (await fs.stat(output).then((s) => s.size, () => 0)) > 0) return resolve()
      await fs.rm(output, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
      reject(new Error(FAILED))
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS)
    child.on("error", () => void done(false))
    child.on("close", (code) => void done(code === 0))
  })
}

/**
 * The retimed asset for clip trim `in` to `out` of project asset `assetId` at
 * `speed`, `reverse`d or not. The new asset's id and entry (added to the
 * stored project; an identical earlier copy is reused), and the trim to give
 * the clip on it. The ffmpeg run happens outside the project's lock.
 */
export async function retimeAsset(userFolder: string, folder: string, assetId: string, rawOptions: unknown): Promise<RetimeResult> {
  const parsed = retimeOptions.safeParse(rawOptions)
  if (!parsed.success) return { error: "Invalid request." }
  const o = parsed.data
  const dir = projectDir(userFolder, folder)
  if (!dir) return { error: "Invalid request." }
  const project = await readProject(userFolder, folder)
  if (!project) return { error: "Project not found." }
  const current = Object.hasOwn(project.assets, assetId) ? project.assets[assetId] : undefined
  if (!current || (assetKind(current) !== "video" && assetKind(current) !== "audio")) return { error: "That isn't a video or sound in this project." }

  // What the clip shows, as a window of the original media.
  const win = sourceWindow(assetId, current, o.in, o.out)
  const source = Object.hasOwn(project.assets, win.source) ? project.assets[win.source] : undefined
  if (!source || assetKind(source) !== assetKind(current)) return { error: "The original file is no longer in this project." }
  const audioOnly = assetKind(source) === "audio"
  const from = Math.max(0, win.from)
  const to = Math.min(source.duration, win.to)
  // Normal speed, forwards: back on the original.
  if (o.speed === 1 && !o.reverse) {
    if (!(to > from)) return { error: "That part of the video is not valid." }
    return { id: win.source, asset: source, in: from, out: to }
  }
  const bad = retimeError(o.speed, o.reverse, from, to)
  if (bad) return { error: bad }

  const sourceFile = assetPath(userFolder, folder, source.file)
  if (!sourceFile) return { error: "Invalid request." }
  const stat = await fs.stat(sourceFile).catch(() => null)
  if (!stat) return { error: "The original video file is missing." }
  const name = `retimed-${createHash("sha256").update(JSON.stringify([source.file, stat.size, stat.mtimeMs, from, to, o.speed, o.reverse])).digest("hex").slice(0, 24)}.${audioOnly ? "m4a" : "mp4"}`
  const dest = assetPath(userFolder, folder, name)
  if (!dest) return { error: "Invalid request." }

  if (!(await fs.stat(dest).then((s) => s.size > 0, () => false))) {
    const tmp = path.join(path.dirname(dest), `${randomBytes(6).toString("hex")}.part.${audioOnly ? "m4a" : "mp4"}`)
    try {
      await run(sourceFile, tmp, { from, to, speed: o.speed, reverse: o.reverse, hasAudio: audioOnly || source.hasAudio, audioOnly })
      await fs.rename(tmp, dest)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      return { error: error instanceof Error ? error.message : FAILED }
    }
  }
  let probed: { duration: number; hasAudio: boolean }
  try {
    probed = await probeMedia(dest)
  } catch {
    return { error: FAILED }
  }

  return withLock(`${userFolder}/${folder}`, async (): Promise<RetimeResult> => {
    const latest = await readProject(userFolder, folder)
    if (!latest) return { error: "Project not found." }
    const known = Object.entries(latest.assets).find(([, a]) => a.file === name)
    const out = Math.max(0.1, probed.duration)
    if (known) return { id: known[0], asset: known[1], in: 0, out: Math.min(out, known[1].duration) }
    const asset: Asset = {
      file: name,
      duration: probed.duration,
      hasAudio: audioOnly || probed.hasAudio,
      ...(audioOnly ? { kind: "audio" as const } : {}),
      title: retimeTitle(assetLabel(source), o.speed, o.reverse),
      retime: { source: win.source, speed: o.speed, reverse: o.reverse, from, to },
    }
    const id = newAssetId()
    await writeProject(userFolder, folder, { ...latest, assets: { ...latest.assets, [id]: asset } })
    return { id, asset, in: 0, out }
  })
}

export type PreviewResult = { dataUrl: string; audioOnly: boolean; seconds: number } | { error: string }

/**
 * A short sample to listen to (and watch) before committing: about six
 * seconds from the middle of the part of the original the clip shows, at
 * `speed`, `reverse`d or not, small and quick to make, as a data URL. Nothing is
 * stored in the project.
 */
export async function previewRetime(userFolder: string, folder: string, assetId: string, rawOptions: unknown): Promise<PreviewResult> {
  const parsed = retimeOptions.safeParse(rawOptions)
  if (!parsed.success) return { error: "Invalid request." }
  const o = parsed.data
  const project = await readProject(userFolder, folder)
  if (!project) return { error: "Project not found." }
  const current = Object.hasOwn(project.assets, assetId) ? project.assets[assetId] : undefined
  if (!current || (assetKind(current) !== "video" && assetKind(current) !== "audio")) return { error: "That isn't a video or sound in this project." }
  const win = sourceWindow(assetId, current, o.in, o.out)
  const source = Object.hasOwn(project.assets, win.source) ? project.assets[win.source] : undefined
  if (!source || assetKind(source) !== assetKind(current)) return { error: "The original file is no longer in this project." }
  const audioOnly = assetKind(source) === "audio"
  const from = Math.max(0, win.from)
  const to = Math.min(source.duration, win.to)
  const bad = retimeError(o.speed, o.reverse, from, to)
  if (bad) return { error: bad }
  const sourceFile = assetPath(userFolder, folder, source.file)
  if (!sourceFile) return { error: "Invalid request." }
  const part = previewWindow(from, to, o.speed)
  const tmp = path.join(os.tmpdir(), `ps-retime-preview-${randomBytes(8).toString("hex")}.${audioOnly ? "m4a" : "mp4"}`)
  try {
    await run(sourceFile, tmp, { from: part.from, to: part.to, speed: o.speed, reverse: o.reverse, hasAudio: audioOnly || source.hasAudio, audioOnly, preview: true })
    const bytes = await fs.readFile(tmp)
    return { dataUrl: `data:${audioOnly ? "audio/mp4" : "video/mp4"};base64,${bytes.toString("base64")}`, audioOnly, seconds: (part.to - part.from) / o.speed }
  } catch (error) {
    return { error: error instanceof Error ? error.message : FAILED }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}
