import "server-only"
import fs from "fs/promises"
import path from "path"
import { z } from "zod"
import { loadStockConfig } from "@/lib/stock/config"
import { downloadToFile } from "@/lib/stock/download"
import { convertGifToMp4, GIF_TOO_LARGE, gifTooLarge } from "@/lib/stock/gif"
import { createFreesound } from "@/lib/stock/freesound"
import { createOpenverse } from "@/lib/stock/openverse"
import { safePageUrl } from "@/lib/stock/panel-state"
import { createPexels } from "@/lib/stock/pexels"
import { createPixabay } from "@/lib/stock/pixabay"
import type { StockClient, StockRef, StockSource } from "@/lib/stock/types"
import { probePictureSize } from "./ffmpeg-server"
import { importCategory, sanitizeImportName } from "./import"
import { finishDownload, stagingPath } from "./import-server"
import type { Asset } from "./project"
import { withLock } from "./project-lock-server"
import { assetPath, formatForFirstPicture, readProject, reusableAsset, writeProject } from "./projects-server"

// Imports a stock search result into a project. The browser sends only
// { source, id, kind }; the provider's API (StockClient.resolve) says which
// file to fetch, so no URL ever comes from the browser. The file is
// downloaded (lib/stock/download: https only, public addresses only, 1 GB,
// 10 minutes) to a fresh staging file in the project's folder, a GIF is
// turned into an mp4 that loops by default, and finishDownload probes it and
// places it in assets/ like an upload. Its `source` is stockSourceKey(ref),
// so the same result imported again reuses the first asset.
//
// Locking: the download runs OUTSIDE the project's lock, so a long download
// doesn't hold up the editor's saves; the check for an existing asset, the
// placing and the project write happen under the lock, and the check is
// repeated there after the download. Imports of the same result into the same
// project at the same time share one download (`inFlight`, this process).

/** The asset `source` of a stock result: "stock:<source>:<id>". */
export const stockSourceKey = (ref: StockRef): string => `stock:${ref.source}:${ref.id}`

const refSchema = z
  .object({
    source: z.enum(["openverse", "pixabay", "pexels", "freesound"]),
    // Every provider's ids are digits or a UUID; this also keeps the key plain.
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    kind: z.enum(["image", "gif", "video", "audio"]),
  })
  .strict()

/** A browser-sent stock reference, or null when it isn't exactly { source, id, kind } with known values. */
export function parseStockRef(raw: unknown): StockRef | null {
  const parsed = refSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export type StockImportResult = { id: string; asset: Asset; reused?: true; format?: { width: number; height: number } } | { error: string }

/** Seams for tests. The server action never passes any, so production always uses the real client, downloader and converter. */
export type StockImportDeps = {
  client?: (source: StockSource) => Promise<StockClient>
  download?: (url: string, dest: string) => Promise<unknown>
  convertGif?: (input: string, output: string) => Promise<void>
}

/** The provider's client, built from the admin's stock settings. */
async function clientFor(source: StockSource): Promise<StockClient> {
  const cfg = await loadStockConfig()
  if (source === "openverse") return createOpenverse({ clientId: cfg.openverseClientId, clientSecret: cfg.openverseClientSecret })
  if (source === "pixabay") return createPixabay({ key: cfg.pixabayKey })
  if (source === "freesound") return createFreesound({ key: cfg.freesoundKey })
  return createPexels({ key: cfg.pexelsKey })
}

const FETCH_FAILED = "The stock file couldn't be fetched."

/**
 * An error's message for the browser: the downloader's and providers'
 * messages are fixed short strings; anything that looks like it carries a
 * URL, a query string or a server path (a drive letter, a backslash, or
 * /a/b/) is replaced by `fallback`.
 */
function safeError(error: unknown, fallback = FETCH_FAILED): string {
  const text = error instanceof Error ? error.message.trim() : ""
  if (!text || text.length > 200 || /[a-z][\w+.-]*:\/\/|[?&][\w-]+=|www\.|\b[a-z]:[\\/]|\\|\/[^\s/]+\//i.test(text)) return fallback
  return text
}

const inFlight = new Map<string, Promise<StockImportResult>>()

/**
 * Imports stock result `rawRef` into project `folder` of `userFolder` (both
 * already trusted: the folder from the session, the project name checked by
 * the caller). The new asset and its id (and the project's new format when
 * it's the first picture), the asset already made from this result with
 * `reused: true`, or `{ error }`.
 */
export async function importStock(userFolder: string, folder: string, rawRef: unknown, deps: StockImportDeps = {}): Promise<StockImportResult> {
  const ref = parseStockRef(rawRef)
  if (!ref) return { error: "Invalid request." }
  const key = stockSourceKey(ref)
  const lockKey = `${userFolder}/${folder}`

  let early: StockImportResult | null
  try {
    early = await withLock(lockKey, async (): Promise<StockImportResult | null> => {
      const project = await readProject(userFolder, folder)
      if (!project) return { error: "Project not found." }
      const existing = await reusableAsset(userFolder, folder, project, key)
      return existing ? { ...existing, reused: true as const } : null
    })
  } catch (error) {
    return { error: safeError(error, "Couldn't read the project.") }
  }
  if (early) return early

  const flightKey = `${lockKey}\n${key}`
  const running = inFlight.get(flightKey)
  if (running) {
    const shared = await running
    return "error" in shared ? shared : { id: shared.id, asset: shared.asset, reused: true }
  }
  const job = fetchAndAdd(userFolder, folder, ref, key, deps)
  inFlight.set(flightKey, job)
  try {
    return await job
  } finally {
    inFlight.delete(flightKey)
  }
}

async function fetchAndAdd(userFolder: string, folder: string, ref: StockRef, key: string, deps: StockImportDeps): Promise<StockImportResult> {
  const download = deps.download ?? ((url: string, dest: string) => downloadToFile(url, dest))
  const convert = deps.convertGif ?? convertGifToMp4
  const staged: string[] = []
  try {
    const client = await (deps.client ?? clientFor)(ref.source)
    const file = await client.resolve(ref)
    const name = sanitizeImportName(file.fileName)
    if (!importCategory(name)) return { error: "That stock file isn't a type Import can take." }
    const part = stagingPath(userFolder, folder, name)
    if (!part) return { error: "Project not found." }
    staged.push(part)
    await download(file.url, part)

    let ready = part
    let readyName = name
    if (file.gif) {
      // A tiny GIF can declare a huge canvas; refuse before ffmpeg decodes any of it.
      if (gifTooLarge(await probePictureSize(part).catch(() => null))) return { error: GIF_TOO_LARGE }
      readyName = `${name.slice(0, name.length - path.extname(name).length)}.mp4`
      const mp4 = stagingPath(userFolder, folder, readyName)
      if (!mp4) return { error: "Project not found." }
      staged.push(mp4)
      await convert(part, mp4)
      ready = mp4
    }

    return await withLock(`${userFolder}/${folder}`, async (): Promise<StockImportResult> => {
      const project = await readProject(userFolder, folder)
      if (!project) return { error: "Project not found." }
      // Imported meanwhile (another tab, or before this process's in-flight entry): keep the first.
      const existing = await reusableAsset(userFolder, folder, project, key)
      if (existing) return { ...existing, reused: true as const }
      const done = await finishDownload(userFolder, folder, ready, readyName)
      if ("error" in done) return { error: done.error }
      const asset: Asset = { ...done.asset, source: key, ...(file.title ? { title: file.title } : {}), ...(safePageUrl(file.pageUrl) ? { link: safePageUrl(file.pageUrl)! } : {}), ...(file.gif && done.asset.kind === undefined ? { loopByDefault: true as const } : {}) }
      const format = await formatForFirstPicture(userFolder, folder, project, asset)
      try {
        await writeProject(userFolder, folder, { ...project, ...format, assets: { ...project.assets, [done.id]: asset } })
      } catch (error) {
        // The project doesn't name the file, so don't leave it in assets/.
        const placed = assetPath(userFolder, folder, asset.file)
        if (placed) await fs.rm(placed, { force: true }).catch(() => {})
        throw error
      }
      return format ? { id: done.id, asset, format } : { id: done.id, asset }
    })
  } catch (error) {
    return { error: safeError(error) }
  } finally {
    for (const f of staged) await fs.rm(f, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
  }
}
