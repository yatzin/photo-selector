import "server-only"
import fs from "fs/promises"
import path from "path"
import sharp from "sharp"
import { prisma } from "@/lib/prisma"
import { rootPath } from "@/lib/library-server"
import { fileVersion, isRootKey, type RootKey } from "@/lib/media"
import { ensureVariant } from "@/lib/thumbs-server"
import { clientConfig, loadAiConfig, type AiConfig } from "@/lib/ai/config"
import { isAiReady } from "@/lib/ai/settings-schema"
import { chatWithRetry } from "@/lib/ai/client"
import { fingerprintImage } from "@/lib/ai/fingerprint"
import { groupPhotos, type GroupInput } from "@/lib/ai/grouping"
import { readCaptureTime } from "@/lib/ai/capture-time"
import { analyzeGroups } from "@/lib/ai/analysis-loop"
import { folderKey, isShotKind, minScanImages, scanFolderSegments } from "@/lib/ai/review"
import { describeChange, diffSnapshot, type Snapshot } from "@/lib/ai/snapshot"
import { coveredByMonthScan, monthScanDays } from "@/lib/ai/month-scan"
import { listImageVersions, readEntries } from "@/lib/ai/folder-images-server"
import { analyzeShotRun, listShots } from "@/lib/ai/shot-runner-server"
import type { ScanKind } from "@/lib/ai/review"
import type { AiRun } from "@/app/generated/prisma/client"

// Runs AI review scans in the background, one at a time. All state lives in
// the database, so a restart resumes: a run without groupedAt is grouped
// (again), a grouped run continues with its PENDING groups. A new scan of a
// folder takes over the earlier scans' unreviewed groups (replaceEarlierGroups).

const POLL_MS = 5_000
// Photos are numbered 1..n for the AI in this order; the same order maps its
// answer back, so it must be total (name breaks takenAt ties).
const PHOTO_ORDER = [{ takenAt: "asc" as const }, { name: "asc" as const }]

const ACTIVE = ["QUEUED", "GROUPING", "ANALYZING"] as const
const WORKING = ["GROUPING", "ANALYZING"] as const

type State = { started: boolean; ticking: Promise<void> | null; timer: NodeJS.Timeout | null; current: { runId: string; controller: AbortController } | null }
const g = globalThis as unknown as { __psAiRunner?: State }
const state: State = (g.__psAiRunner ??= { started: false, ticking: null, timer: null, current: null })

export function startAiRunner() {
  if (state.started) return
  state.started = true
  state.timer = setInterval(() => void tick(), POLL_MS)
  state.timer.unref()
  void tick()
}

export function kickRunner() {
  void tick()
}

/** Processes every waiting run, resolving when the runner is idle (tests and actions). */
export function drainRunner(): Promise<void> {
  return tick()
}

/** Queues a scan, unless that folder already has one of the same kind queued or running. */
export async function createRun(input: { root: string; folder: string; fresh: boolean; userId: string | null; kind?: ScanKind }): Promise<{ error: string } | { runId: string }> {
  const kind = input.kind ?? "similar"
  if (!isRootKey(input.root)) return { error: "Unknown library folder." }
  const segs = scanFolderSegments(input.folder)
  if (!segs) return { error: "Invalid folder." }
  try {
    if (!(await fs.stat(path.join(rootPath(input.root), ...segs))).isDirectory()) return { error: "That folder doesn't exist." }
  } catch {
    return { error: "That folder doesn't exist." }
  }
  const base = rootPath(input.root)
  // A day of a year/month/day folder is scanned with its month, never alone:
  // two open reviews would otherwise hold the same photos.
  const month = coveredByMonthScan(segs)
  if (month && monthScanDays(month, await readEntries(path.join(base, ...month)))) {
    return { error: `That day is part of a month scan. Scan ${month.join(" / ")} instead.` }
  }
  const includeDays = monthScanDays(segs, await readEntries(path.join(base, ...segs))) !== null
  const folder = folderKey(segs)
  // A second scan would replace the first one's unreviewed results.
  const busy = await prisma.aiRun.findFirst({ where: { kind, root: input.root, folder, status: { in: [...ACTIVE] } }, select: { id: true } })
  if (busy) return { error: "A scan of this folder is already running or waiting." }
  const run = await prisma.aiRun.create({ data: { kind, root: input.root, folder, fresh: input.fresh, includeDays, createdById: input.userId } })
  kickRunner()
  return { runId: run.id }
}

/**
 * "Scan all": queues a separate scan for every folder in `folders` (the
 * picker's list) that has enough photos and no scan on record yet.
 */
export async function queueUnscanned(
  folders: { root: string; folder: string; imageCount: number }[],
  userId: string | null,
  kind: ScanKind = "similar"
): Promise<{ queued: number }> {
  const known = new Set((await prisma.aiRun.findMany({ where: { kind }, select: { root: true, folder: true } })).map((r) => `${r.root}|${r.folder}`))
  let queued = 0
  for (const f of folders) {
    if (f.imageCount < minScanImages(kind) || known.has(`${f.root}|${f.folder}`)) continue
    const r = await createRun({ root: f.root, folder: f.folder, fresh: false, userId, kind })
    if ("runId" in r) queued++
  }
  return { queued }
}

/**
 * Takes every waiting scan out of the queue. A new scan that never started is
 * deleted; one put back in the queue by Retry keeps its results and returns
 * to Cancelled. Running and finished scans stay.
 */
export async function clearQueue(kind: ScanKind = "similar"): Promise<{ removed: number }> {
  const [fresh, retried] = await prisma.$transaction([
    prisma.aiRun.deleteMany({ where: { kind, status: "QUEUED", startedAt: null } }),
    prisma.aiRun.updateMany({ where: { kind, status: "QUEUED" }, data: { status: "CANCELLED", finishedAt: new Date() } }),
  ])
  return { removed: fresh.count + retried.count }
}

/** Retry failed groups / resume a cancelled run. */
export async function requeueRun(runId: string): Promise<{ error: string } | { ok: true }> {
  const run = await prisma.aiRun.findUnique({ where: { id: runId } })
  if (!run) return { error: "That scan no longer exists." }
  if ((ACTIVE as readonly string[]).includes(run.status)) return { error: "That scan is still running." }
  const newer = await prisma.aiRun.findFirst({ where: { kind: run.kind, root: run.root, folder: run.folder, status: { in: [...ACTIVE] } }, select: { id: true } })
  if (newer) return { error: "Another scan of this folder is running or waiting. Try again when it's done." }
  await prisma.$transaction([
    prisma.aiGroup.updateMany({ where: { runId, status: "FAILED" }, data: { status: "PENDING", error: null } }),
    prisma.aiShot.updateMany({ where: { runId, status: "FAILED" }, data: { status: "PENDING", error: null } }),
    prisma.aiRun.update({ where: { id: runId }, data: { status: "QUEUED", error: null, finishedAt: null } }),
  ])
  kickRunner()
  return { ok: true }
}

export function abortRun(runId: string) {
  if (state.current?.runId === runId) state.current.controller.abort()
}

function tick(): Promise<void> {
  if (state.ticking) return state.ticking
  state.ticking = (async () => {
    try {
      for (;;) {
        const run =
          (await prisma.aiRun.findFirst({ where: { status: { in: [...WORKING] } }, orderBy: { createdAt: "asc" } })) ??
          (await prisma.aiRun.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } }))
        if (!run) return
        await processRun(run)
      }
    } catch (error) {
      console.error("[ai] runner error:", error)
    }
  })().finally(() => {
    state.ticking = null
  })
  return state.ticking
}

/** True once the run is no longer ours to work on: cancelled, or re-queued by a retry. */
async function stopped(runId: string): Promise<boolean> {
  const status = (await prisma.aiRun.findUnique({ where: { id: runId }, select: { status: true } }))?.status
  return !status || !(WORKING as readonly string[]).includes(status)
}

/**
 * Ends a run — but only from a status we own (`from`), so a Cancel or a Retry
 * that arrived while we were working is never overwritten.
 */
async function finish(runId: string, data: { status: "DONE" | "FAILED" | "CANCELLED"; error?: string }, from: readonly AiRun["status"][] = WORKING) {
  // A run has groups (Find Similar) or shots (Find Screenshots, Quality Checks), never both.
  const [analyzed, failed, shotsAnalyzed, shotsFailed] = await Promise.all([
    prisma.aiGroup.count({ where: { runId, status: { in: ["ANALYZED", "RESOLVED", "DISMISSED"] } } }),
    prisma.aiGroup.count({ where: { runId, status: "FAILED" } }),
    prisma.aiShot.count({ where: { runId, status: { in: ["FLAGGED", "CLEAR", "KEPT", "REMOVED"] } } }),
    prisma.aiShot.count({ where: { runId, status: "FAILED" } }),
  ])
  await prisma.aiRun.updateMany({
    where: { id: runId, status: { in: [...from] } },
    data: { status: data.status, error: data.error ?? null, analyzedCount: analyzed + shotsAnalyzed, failedCount: failed + shotsFailed, finishedAt: new Date() },
  })
}

async function processRun(run: AiRun) {
  const config = await loadAiConfig()
  const picked = [run.status]
  if (!isAiReady(config)) return finish(run.id, { status: "FAILED", error: "AI is not set up. Check Settings → AI." }, picked)
  if (!isRootKey(run.root)) return finish(run.id, { status: "FAILED", error: "Unknown library folder." }, picked)
  const segs = scanFolderSegments(run.folder)
  if (!segs) return finish(run.id, { status: "FAILED", error: "Invalid folder." }, picked)
  const dir = path.join(rootPath(run.root), ...segs)

  // Claim the run from the status we found it in; a Cancel in between wins.
  const claim = (data: { status: "GROUPING" | "ANALYZING"; startedAt?: Date; model: string | null; error: null; finishedAt?: null; snapshot?: string }) =>
    prisma.aiRun.updateMany({ where: { id: run.id, status: run.status }, data }).then((r) => r.count > 0)

  if (!run.groupedAt) {
    if (!(await claim({ status: "GROUPING", startedAt: run.startedAt ?? new Date(), model: config.model, error: null }))) return
    try {
      if (isShotKind(run.kind)) await listShots(run, run.root, segs, () => stopped(run.id))
      else await groupRun(run, run.root, segs, config)
    } catch (error) {
      return finish(run.id, { status: "FAILED", error: error instanceof Error ? error.message : String(error) })
    }
  } else if (isShotKind(run.kind)) {
    // Each image is checked against its own version when its turn comes.
    if (!(await claim({ status: "ANALYZING", model: config.model, error: null, finishedAt: null }))) return
  } else {
    // Resuming (retry, resume, restart): the folder may have changed while the
    // run sat idle and unlocked — resolved groups moved files out — so compare
    // against the folder as it is now. Each group still checks its own photos.
    let snapshotNow: string
    try {
      snapshotNow = JSON.stringify(Object.fromEntries(await listImageVersions(dir, run.includeDays)))
    } catch (error) {
      return finish(run.id, { status: "FAILED", error: error instanceof Error ? error.message : String(error) }, picked)
    }
    if (!(await claim({ status: "ANALYZING", model: config.model, error: null, finishedAt: null, snapshot: snapshotNow }))) return
  }

  if (isShotKind(run.kind)) {
    const controller = new AbortController()
    state.current = { runId: run.id, controller }
    try {
      const outcome = await analyzeShotRun(run, run.root as RootKey, segs, config, controller.signal, () => stopped(run.id))
      if (outcome.status === "failed") await finish(run.id, { status: "FAILED", error: outcome.error })
      else await finish(run.id, { status: outcome.status === "cancelled" ? "CANCELLED" : "DONE" })
    } finally {
      state.current = null
    }
    return
  }

  const pending = await prisma.aiGroup.findMany({
    where: { runId: run.id, status: "PENDING" },
    orderBy: { takenAt: "asc" },
    include: { _count: { select: { photos: true } } },
  })
  const controller = new AbortController()
  state.current = { runId: run.id, controller }
  const root = run.root as RootKey
  const cfg = clientConfig(config)
  const saved = await prisma.aiRun.findUnique({ where: { id: run.id }, select: { snapshot: true } })
  const snapshot: Snapshot | null = saved?.snapshot ? JSON.parse(saved.snapshot) : null

  try {
    const outcome = await analyzeGroups(
      pending.map((p) => ({ id: p.id, photoCount: p._count.photos })),
      {
        instructions: config.instructions,
        isCancelled: () => stopped(run.id),
        checkFolder: () => (snapshot ? folderChange(dir, snapshot, run.includeDays) : Promise.resolve(null)),
        callAi: (messages) => chatWithRetry(cfg, messages, { signal: controller.signal }),
        prepareImages: async (groupId) => {
          const photos = await prisma.aiGroupPhoto.findMany({ where: { groupId }, orderBy: PHOTO_ORDER })
          return Promise.all(
            photos.map(async (p) => {
              const file = path.join(dir, p.name)
              const now = await fs.stat(file).then(fileVersion, () => null)
              if (now !== p.version) throw new Error(`${p.name} changed since the scan (moved, edited or deleted).`)
              const preview = await ensureVariant(root, [...segs, p.name].join("/"), file, "preview", "scan").catch(() => ({ failed: true as const }))
              if ("failed" in preview) throw new Error(`${p.name} is no longer readable.`)
              const jpeg = await sharp(preview.path)
                .resize({ width: config.imageMaxPx, height: config.imageMaxPx, fit: "inside", withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer()
              return `data:image/jpeg;base64,${jpeg.toString("base64")}`
            })
          )
        },
        onAnalyzed: async (groupId, verdict) => {
          const photos = await prisma.aiGroupPhoto.findMany({ where: { groupId }, orderBy: PHOTO_ORDER })
          const best = new Set(verdict.best)
          await prisma.$transaction([
            ...verdict.ranking.map((r, i) =>
              prisma.aiGroupPhoto.update({ where: { id: photos[r.photo - 1].id }, data: { rank: i + 1, note: r.note || null, suggested: best.has(r.photo) } })
            ),
            prisma.aiGroup.update({ where: { id: groupId }, data: { status: "ANALYZED", reason: verdict.reason || null, error: null } }),
            prisma.aiRun.update({ where: { id: run.id }, data: { analyzedCount: { increment: 1 } } }),
          ])
        },
        onFailed: async (groupId, error) => {
          await prisma.$transaction([
            prisma.aiGroup.update({ where: { id: groupId }, data: { status: "FAILED", error } }),
            prisma.aiRun.update({ where: { id: run.id }, data: { failedCount: { increment: 1 } } }),
          ])
        },
      }
    )
    if (outcome.status === "failed") await finish(run.id, { status: "FAILED", error: outcome.error })
    else await finish(run.id, { status: outcome.status === "cancelled" ? "CANCELLED" : "DONE" })
  } finally {
    state.current = null
  }
}

async function folderChange(dir: string, snapshot: Snapshot, includeDays: boolean): Promise<string | null> {
  try {
    return describeChange(diffSnapshot(snapshot, await listImageVersions(dir, includeDays)))
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function groupRun(run: AiRun, root: RootKey, segs: string[], config: AiConfig) {
  const dir = path.join(rootPath(root), ...segs)
  const listing = await listImageVersions(dir, run.includeDays)
  const snapshot: Snapshot = Object.fromEntries(listing)
  await prisma.aiRun.update({ where: { id: run.id }, data: { snapshot: JSON.stringify(snapshot) } })

  await replaceEarlierGroups(run, root, listing)

  // Photos already in a group (reviewed, or analyzed and waiting) are skipped
  // unless starting fresh; a changed photo has a new version and is redone.
  const settled = new Set<string>()
  if (!run.fresh) {
    const done = await prisma.aiGroupPhoto.findMany({
      where: { group: { root, folder: run.folder, status: { in: ["RESOLVED", "DISMISSED", "ANALYZED"] } } },
      select: { name: true, version: true },
    })
    for (const p of done) settled.add(`${p.name}\0${p.version}`)
  }

  const inputs: (GroupInput & { version: string })[] = []
  for (const [name, version] of listing) {
    if (settled.has(`${name}\0${version}`)) continue
    const file = path.join(dir, name)
    try {
      const st = await fs.stat(file)
      const thumb = await ensureVariant(root, [...segs, name].join("/"), file, "thumb", "scan")
      if ("failed" in thumb) continue
      inputs.push({ name, version, takenAt: await readCaptureTime(file, st.mtimeMs), fp: await fingerprintImage(thumb.path) })
    } catch {
      // unreadable; caught as a change by the check below if it was removed
    }
    if (await stopped(run.id)) return
  }

  // Grouping takes a while on a big folder; don't save groups built from a folder that has since changed.
  const changed = await folderChange(dir, snapshot, run.includeDays)
  if (changed) throw new Error(changed)

  const groups = groupPhotos(inputs, { windowSeconds: config.groupWindowSeconds, similarity: config.similarity, maxGroupSize: config.maxGroupSize })
  for (const group of groups) {
    await prisma.aiGroup.create({
      data: {
        runId: run.id, root, folder: run.folder, takenAt: new Date(group[0].takenAt),
        photos: { create: group.map((p) => ({ name: p.name, version: listing.get(p.name)!, takenAt: new Date(p.takenAt) })) },
      },
    })
  }
  await prisma.aiRun.update({
    where: { id: run.id },
    data: { status: "ANALYZING", groupedAt: new Date(), photoCount: inputs.length, groupCount: groups.length, analyzedCount: 0, failedCount: 0 },
  })
}

/**
 * Removes the unreviewed groups this run takes over: this run's own (when
 * grouping again after a restart), every earlier pending or failed group, and
 * earlier analyzed groups too when starting fresh or when one of their photos
 * has changed. Earlier scans that lost groups get their counts updated, and
 * are removed when nothing is left in them.
 */
async function replaceEarlierGroups(run: AiRun, root: RootKey, listing: Map<string, string>) {
  const open = await prisma.aiGroup.findMany({
    where: { root, folder: run.folder, status: { in: ["PENDING", "ANALYZED", "FAILED"] } },
    select: { id: true, runId: true, status: true, photos: { select: { name: true, version: true } } },
  })
  const replaced = open.filter(
    (g) => g.runId === run.id || run.fresh || g.status !== "ANALYZED" || g.photos.some((p) => listing.get(p.name) !== p.version)
  )
  if (!replaced.length) return
  await prisma.aiGroup.deleteMany({ where: { id: { in: replaced.map((g) => g.id) } } })

  for (const runId of new Set(replaced.map((g) => g.runId))) {
    if (runId === run.id) continue
    const [total, analyzed, failed] = await Promise.all([
      prisma.aiGroup.count({ where: { runId } }),
      prisma.aiGroup.count({ where: { runId, status: { in: ["ANALYZED", "RESOLVED", "DISMISSED"] } } }),
      prisma.aiGroup.count({ where: { runId, status: "FAILED" } }),
    ])
    if (total === 0) await prisma.aiRun.deleteMany({ where: { id: runId } })
    else await prisma.aiRun.updateMany({ where: { id: runId }, data: { groupCount: total, analyzedCount: analyzed, failedCount: failed } })
  }
}
