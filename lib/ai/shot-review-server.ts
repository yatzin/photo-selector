import "server-only"
import { prisma } from "@/lib/prisma"
import { isRootKey, type RootKey } from "@/lib/media"
import { moveToDropoff, restoreBatch, trashFiles } from "@/lib/file-ops-server"
import { currentVersions } from "@/lib/ai/review-server"
import { isShotKind, scanFolderSegments } from "@/lib/ai/review"
import { folderLocked } from "@/lib/ai/lock-server"
import { SCAN_LOCK_MESSAGE } from "@/lib/ai/lock"

// Acting on Find Screenshots and Quality Checks results: delete, move to Sort
// Dropoff (screenshots only), or mark as a mistake ("not a screenshot", "not
// a bad photo"). Only images still exactly as scanned are touched.

export type ShotActionResult = { error: string } | { ids: string[]; failed: { name: string; error: string }[]; batchId?: string }

type Loaded = { kind: string; root: RootKey; segs: string[]; shots: { id: string; name: string }[]; missing: string[] }

async function load(runId: string, ids: string[]): Promise<Loaded | { error: string }> {
  const run = await prisma.aiRun.findUnique({ where: { id: runId }, select: { root: true, folder: true, kind: true } })
  const segs = run ? scanFolderSegments(run.folder) : null
  if (!run || !isShotKind(run.kind) || !isRootKey(run.root) || !segs) return { error: "That scan no longer exists." }
  if (await folderLocked(run.root, segs)) return { error: SCAN_LOCK_MESSAGE }
  const rows = await prisma.aiShot.findMany({ where: { runId, id: { in: ids }, status: { in: ["FLAGGED", "KEPT"] } }, select: { id: true, name: true, version: true } })
  const versions = await currentVersions(run.root, run.folder, rows.map((r) => r.name))
  const shots = rows.filter((r) => versions.get(r.name) === r.version)
  const missing = rows.filter((r) => versions.get(r.name) !== r.version).map((r) => r.id)
  // Gone or changed since the scan: drop them from the results.
  if (missing.length) await prisma.aiShot.updateMany({ where: { id: { in: missing } }, data: { status: "REMOVED" } })
  return { kind: run.kind, root: run.root, segs, shots, missing }
}

async function settle(loaded: Loaded, okNames: string[]): Promise<string[]> {
  const ok = new Set(okNames)
  const ids = loaded.shots.filter((s) => ok.has(s.name)).map((s) => s.id)
  if (ids.length) await prisma.aiShot.updateMany({ where: { id: { in: ids } }, data: { status: "REMOVED" } })
  return ids
}

export async function trashShots(runId: string, ids: string[]): Promise<ShotActionResult> {
  const loaded = await load(runId, ids)
  if ("error" in loaded) return loaded
  if (!loaded.shots.length) return { error: "None of these images are still here." }
  const result = await trashFiles(loaded.root, loaded.segs, loaded.shots.map((s) => s.name))
  return { ids: await settle(loaded, result.ok), failed: result.failed, batchId: result.batchId }
}

export async function moveShots(runId: string, ids: string[]): Promise<ShotActionResult> {
  const loaded = await load(runId, ids)
  if ("error" in loaded) return loaded
  if (loaded.kind !== "screenshots") return { error: "Only screenshots can be moved to Sort Dropoff." }
  if (loaded.root !== "upload") return { error: "Only images in Mobile Upload can be moved to Sort Dropoff." }
  if (!loaded.shots.length) return { error: "None of these images are still here." }
  const result = await moveToDropoff(loaded.segs, loaded.shots.map((s) => s.name))
  return { ids: await settle(loaded, result.ok), failed: result.failed }
}

/** The AI got it wrong (KEPT), or was right after all (back to FLAGGED). */
export async function markShots(runId: string, ids: string[], status: "KEPT" | "FLAGGED"): Promise<ShotActionResult> {
  const loaded = await load(runId, ids)
  if ("error" in loaded) return loaded
  const keep = loaded.shots.map((s) => s.id)
  await prisma.aiShot.updateMany({ where: { id: { in: keep } }, data: { status } })
  return { ids: keep, failed: [] }
}

/** Undo for a delete: puts the files back and lists them again (a restore changes the version). */
export async function undoTrashShots(runId: string, batchId: string, ids: string[]): Promise<{ error: string } | { restored: number }> {
  const run = await prisma.aiRun.findUnique({ where: { id: runId }, select: { root: true, folder: true } })
  const segs = run ? scanFolderSegments(run.folder) : null
  if (!run || !isRootKey(run.root) || !segs) return { error: "That scan no longer exists." }
  if (await folderLocked(run.root, segs)) return { error: SCAN_LOCK_MESSAGE }
  const result = await restoreBatch(run.root, batchId)
  const rows = await prisma.aiShot.findMany({ where: { runId, id: { in: ids }, status: "REMOVED" }, select: { id: true, name: true } })
  const versions = await currentVersions(run.root, run.folder, rows.map((r) => r.name))
  await prisma.$transaction(
    rows.filter((r) => versions.has(r.name)).map((r) => prisma.aiShot.update({ where: { id: r.id }, data: { status: "FLAGGED", version: versions.get(r.name)! } }))
  )
  return { restored: result.ok.length }
}
