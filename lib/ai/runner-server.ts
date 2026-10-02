import "server-only"
import fs from "fs/promises"
import path from "path"
import sharp from "sharp"
import { prisma } from "@/lib/prisma"
import { rootPath } from "@/lib/library-server"
import { fileVersion, isRootKey, mediaKind, type RootKey } from "@/lib/media"
import { ensureVariant } from "@/lib/thumbs-server"
import { clientConfig, loadAiConfig, type AiConfig } from "@/lib/ai/config"
import { isAiReady } from "@/lib/ai/settings-schema"
import { chatWithRetry } from "@/lib/ai/client"
import { fingerprintImage } from "@/lib/ai/fingerprint"
import { groupPhotos, type GroupInput } from "@/lib/ai/grouping"
import { readCaptureTime } from "@/lib/ai/capture-time"
import { analyzeGroups } from "@/lib/ai/analysis-loop"
import { scanFolderSegments } from "@/lib/ai/review"
import { describeChange, diffSnapshot, type Snapshot } from "@/lib/ai/snapshot"
import type { AiRun } from "@/app/generated/prisma/client"

// Runs AI review scans in the background, one at a time. All state lives in
// the database, so a restart resumes: a run without groupedAt is grouped
// (again), a grouped run continues with its PENDING groups.

const POLL_MS = 5_000
// Photos are numbered 1..n for the AI in this order; the same order maps its
// answer back, so it must be total (name breaks takenAt ties).
const PHOTO_ORDER = [{ takenAt: "asc" as const }, { name: "asc" as const }]

type State = { started: boolean; busy: boolean; timer: NodeJS.Timeout | null; current: { runId: string; controller: AbortController } | null }
const g = globalThis as unknown as { __psAiRunner?: State }
const state: State = (g.__psAiRunner ??= { started: false, busy: false, timer: null, current: null })

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

export function abortRun(runId: string) {
  if (state.current?.runId === runId) state.current.controller.abort()
}

async function tick() {
  if (state.busy) return
  state.busy = true
  try {
    for (;;) {
      const run =
        (await prisma.aiRun.findFirst({ where: { status: { in: ["GROUPING", "ANALYZING"] } }, orderBy: { createdAt: "asc" } })) ??
        (await prisma.aiRun.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } }))
      if (!run) return
      await processRun(run)
    }
  } catch (error) {
    console.error("[ai] runner error:", error)
  } finally {
    state.busy = false
  }
}

async function finish(runId: string, data: { status: "DONE" | "FAILED" | "CANCELLED"; error?: string }) {
  const [analyzed, failed] = await Promise.all([
    prisma.aiGroup.count({ where: { runId, status: { in: ["ANALYZED", "RESOLVED", "DISMISSED"] } } }),
    prisma.aiGroup.count({ where: { runId, status: "FAILED" } }),
  ])
  // Don't overwrite a cancel that arrived while we were working.
  const current = await prisma.aiRun.findUnique({ where: { id: runId }, select: { status: true } })
  const status = current?.status === "CANCELLED" ? "CANCELLED" : data.status
  await prisma.aiRun.update({
    where: { id: runId },
    data: { status, error: data.error ?? null, analyzedCount: analyzed, failedCount: failed, finishedAt: new Date() },
  })
}

async function processRun(run: AiRun) {
  const config = await loadAiConfig()
  if (!isAiReady(config)) return finish(run.id, { status: "FAILED", error: "AI is not set up. Check Settings → AI." })
  if (!isRootKey(run.root)) return finish(run.id, { status: "FAILED", error: "Unknown library folder." })
  const segs = scanFolderSegments(run.folder)
  if (!segs) return finish(run.id, { status: "FAILED", error: "Invalid folder." })

  if (!run.groupedAt) {
    await prisma.aiRun.update({ where: { id: run.id }, data: { status: "GROUPING", startedAt: run.startedAt ?? new Date(), model: config.model, error: null } })
    try {
      await groupRun(run, run.root, segs, config)
    } catch (error) {
      return finish(run.id, { status: "FAILED", error: error instanceof Error ? error.message : String(error) })
    }
  } else {
    await prisma.aiRun.update({ where: { id: run.id }, data: { status: "ANALYZING", model: config.model, error: null, finishedAt: null } })
  }

  const pending = await prisma.aiGroup.findMany({
    where: { runId: run.id, status: "PENDING" },
    orderBy: { takenAt: "asc" },
    include: { _count: { select: { photos: true } } },
  })
  const controller = new AbortController()
  state.current = { runId: run.id, controller }
  const root = run.root as RootKey
  const dir = path.join(rootPath(root), ...segs)
  const cfg = clientConfig(config)
  const saved = await prisma.aiRun.findUnique({ where: { id: run.id }, select: { snapshot: true } })
  const snapshot: Snapshot | null = saved?.snapshot ? JSON.parse(saved.snapshot) : null

  try {
    const outcome = await analyzeGroups(
      pending.map((p) => ({ id: p.id, photoCount: p._count.photos })),
      {
        customPrompt: config.customPrompt,
        isCancelled: async () => (await prisma.aiRun.findUnique({ where: { id: run.id }, select: { status: true } }))?.status === "CANCELLED",
        checkFolder: () => (snapshot ? folderChange(dir, snapshot) : Promise.resolve(null)),
        callAi: (messages) => chatWithRetry(cfg, messages, { signal: controller.signal }),
        prepareImages: async (groupId) => {
          const photos = await prisma.aiGroupPhoto.findMany({ where: { groupId }, orderBy: PHOTO_ORDER })
          return Promise.all(
            photos.map(async (p) => {
              const file = path.join(dir, p.name)
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

/** Every image directly in `dir` with its current version. */
async function listImageVersions(dir: string): Promise<Map<string, string>> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    throw new Error("The folder no longer exists.")
  }
  const out = new Map<string, string>()
  for (const e of entries) {
    if (!e.isFile() || mediaKind(e.name) !== "image") continue
    try {
      out.set(e.name, fileVersion(await fs.stat(path.join(dir, e.name))))
    } catch {
      // removed between readdir and stat
    }
  }
  return out
}

async function folderChange(dir: string, snapshot: Snapshot): Promise<string | null> {
  try {
    return describeChange(diffSnapshot(snapshot, await listImageVersions(dir)))
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function groupRun(run: AiRun, root: RootKey, segs: string[], config: AiConfig) {
  const dir = path.join(rootPath(root), ...segs)
  const listing = await listImageVersions(dir)
  const snapshot: Snapshot = Object.fromEntries(listing)
  await prisma.aiRun.update({ where: { id: run.id }, data: { snapshot: JSON.stringify(snapshot) } })

  // Earlier unfinished groups of this folder are replaced by this run.
  await prisma.aiGroup.deleteMany({ where: { root, folder: run.folder, status: { in: ["PENDING", "ANALYZED", "FAILED"] } } })

  const settled = new Set<string>()
  if (!run.fresh) {
    const done = await prisma.aiGroupPhoto.findMany({
      where: { group: { root, folder: run.folder, status: { in: ["RESOLVED", "DISMISSED"] } } },
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
    if ((await prisma.aiRun.findUnique({ where: { id: run.id }, select: { status: true } }))?.status === "CANCELLED") return
  }

  // Grouping takes a while on a big folder; don't save groups built from a folder that has since changed.
  const changed = await folderChange(dir, snapshot)
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
