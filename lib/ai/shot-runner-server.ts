import "server-only"
import fs from "fs/promises"
import path from "path"
import sharp from "sharp"
import { prisma } from "@/lib/prisma"
import { rootPath } from "@/lib/library-server"
import { fileVersion, type RootKey } from "@/lib/media"
import { ensureVariant } from "@/lib/thumbs-server"
import { clientConfig, type AiConfig } from "@/lib/ai/config"
import { chatWithRetry } from "@/lib/ai/client"
import { photoInfo } from "@/lib/ai/camera-exif"
import { readCaptureTime } from "@/lib/ai/capture-time"
import { listImageVersions } from "@/lib/ai/folder-images-server"
import { analyzeShots, type ShotOutcome } from "@/lib/ai/shot-loop"
import { SHOT_PROMPTS, SHOTS_PER_REQUEST } from "@/lib/ai/shot-prompt"
import type { ShotKind } from "@/lib/ai/review"
import type { AiRun } from "@/app/generated/prisma/client"

// Find Screenshots and Quality Checks, run by runner-server.ts. The first
// phase lists the folder and saves the candidates (AiShot rows): for Find
// Screenshots the images without camera details, for Quality Checks every
// image. The second asks the AI about them a few at a time. Unlike Find Similar,
// nothing depends on the folder staying the same, so these scans don't lock
// it: each image is checked when its turn comes, and one that's gone is
// simply dropped.

const SHOT_ORDER = [{ takenAt: "asc" as const }, { name: "asc" as const }]
const INSERT_CHUNK = 500

/** Phase 1: the candidates. Returns early (saving nothing) once the run is stopped. */
export async function listShots(run: AiRun, root: RootKey, segs: string[], isStopped: () => Promise<boolean>): Promise<void> {
  const kind = run.kind as ShotKind
  const dir = path.join(rootPath(root), ...segs)
  const listing = await listImageVersions(dir, run.includeDays)
  await replaceEarlierShots(run, root, listing)

  // Images already answered (and not changed since) are skipped unless starting fresh.
  const settled = new Set<string>()
  if (!run.fresh) {
    const done = await prisma.aiShot.findMany({
      where: { root, folder: run.folder, status: { in: ["FLAGGED", "CLEAR", "KEPT"] }, run: { kind } },
      select: { name: true, version: true },
    })
    for (const s of done) settled.add(`${s.name}\0${s.version}`)
  }

  let checked = 0
  const candidates: { name: string; version: string; takenAt: Date }[] = []
  for (const [name, version] of listing) {
    if (settled.has(`${name}\0${version}`)) continue
    checked++
    try {
      const file = path.join(dir, name)
      const st = await fs.stat(file)
      if (kind === "quality") {
        candidates.push({ name, version, takenAt: new Date(await readCaptureTime(file, st.mtimeMs)) })
      } else {
        const info = await photoInfo(file, st.mtimeMs)
        if (!info.camera) candidates.push({ name, version, takenAt: new Date(info.takenAt) })
      }
    } catch {
      // removed meanwhile
    }
    if (checked % 50 === 0 && (await isStopped())) return
  }
  if (await isStopped()) return

  for (let i = 0; i < candidates.length; i += INSERT_CHUNK) {
    await prisma.aiShot.createMany({
      data: candidates.slice(i, i + INSERT_CHUNK).map((c) => ({ runId: run.id, root, folder: run.folder, ...c })),
    })
  }
  await prisma.aiRun.update({
    where: { id: run.id },
    data: { status: "ANALYZING", groupedAt: new Date(), photoCount: checked, groupCount: candidates.length, analyzedCount: 0, failedCount: 0 },
  })
}

/**
 * Removes the unanswered candidates this run takes over — its own (when
 * listing again after a restart) and every earlier pending or failed one —
 * plus earlier flagged images still waiting for the user, when starting fresh or
 * when the image has changed. Earlier scans get their counts updated, and are
 * removed when nothing is left in them.
 */
async function replaceEarlierShots(run: AiRun, root: RootKey, listing: Map<string, string>) {
  const open = await prisma.aiShot.findMany({
    where: { root, folder: run.folder, status: { in: ["PENDING", "FAILED", "FLAGGED"] }, run: { kind: run.kind } },
    select: { id: true, runId: true, name: true, version: true, status: true },
  })
  const replaced = open.filter((s) => s.runId === run.id || run.fresh || s.status !== "FLAGGED" || listing.get(s.name) !== s.version)
  if (!replaced.length) return
  await prisma.aiShot.deleteMany({ where: { id: { in: replaced.map((s) => s.id) } } })

  for (const runId of new Set(replaced.map((s) => s.runId))) {
    if (runId === run.id) continue
    const [total, analyzed, failed] = await Promise.all([
      prisma.aiShot.count({ where: { runId } }),
      prisma.aiShot.count({ where: { runId, status: { in: ["FLAGGED", "CLEAR", "KEPT", "REMOVED"] } } }),
      prisma.aiShot.count({ where: { runId, status: "FAILED" } }),
    ])
    if (total === 0) await prisma.aiRun.deleteMany({ where: { id: runId } })
    else await prisma.aiRun.updateMany({ where: { id: runId }, data: { groupCount: total, analyzedCount: analyzed, failedCount: failed } })
  }
}

/** Phase 2: asks the AI about every pending candidate. */
export async function analyzeShotRun(
  run: AiRun,
  root: RootKey,
  segs: string[],
  config: AiConfig,
  signal: AbortSignal,
  isStopped: () => Promise<boolean>
): Promise<ShotOutcome> {
  const dir = path.join(rootPath(root), ...segs)
  const pending = await prisma.aiShot.findMany({ where: { runId: run.id, status: "PENDING" }, orderBy: SHOT_ORDER, select: { id: true, name: true, version: true } })
  const byId = new Map(pending.map((s) => [s.id, s]))
  const cfg = clientConfig(config)
  const kind = run.kind as ShotKind

  return analyzeShots(pending.map((s) => s.id), {
    batchSize: SHOTS_PER_REQUEST,
    prompt: SHOT_PROMPTS[kind],
    instructions: kind === "quality" ? config.qualityInstructions : config.screenshotInstructions,
    isCancelled: isStopped,
    callAi: (messages) => chatWithRetry(cfg, messages, { signal }),
    prepareImage: async (id) => {
      const shot = byId.get(id)!
      const file = path.join(dir, shot.name)
      const now = await fs.stat(file).then(fileVersion, () => null)
      if (now === null) return null
      // Edited (e.g. rotated) since listing: judge it as it is now.
      if (now !== shot.version) await prisma.aiShot.update({ where: { id }, data: { version: now } })
      const preview = await ensureVariant(root, [...segs, shot.name].join("/"), file, "preview", "scan").catch(() => ({ failed: true as const }))
      if ("failed" in preview) throw new Error(`${shot.name} can't be read.`)
      const jpeg = await sharp(preview.path)
        .resize({ width: config.imageMaxPx, height: config.imageMaxPx, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
      return `data:image/jpeg;base64,${jpeg.toString("base64")}`
    },
    onResults: async (results) => {
      await prisma.$transaction([
        ...results.map((r) =>
          prisma.aiShot.update({ where: { id: r.id }, data: { status: r.flagged ? "FLAGGED" : "CLEAR", note: r.note || null, error: null } })
        ),
        prisma.aiRun.update({ where: { id: run.id }, data: { analyzedCount: { increment: results.length } } }),
      ])
    },
    onFailed: async (ids, error) => {
      await prisma.$transaction([
        prisma.aiShot.updateMany({ where: { id: { in: ids } }, data: { status: "FAILED", error } }),
        prisma.aiRun.update({ where: { id: run.id }, data: { failedCount: { increment: ids.length } } }),
      ])
    },
    onGone: async (ids) => {
      await prisma.$transaction([
        prisma.aiShot.updateMany({ where: { id: { in: ids } }, data: { status: "REMOVED" } }),
        prisma.aiRun.update({ where: { id: run.id }, data: { analyzedCount: { increment: ids.length } } }),
      ])
    },
  })
}
