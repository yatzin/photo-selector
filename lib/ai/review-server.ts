import "server-only"
import fs from "fs/promises"
import path from "path"
import { prisma } from "@/lib/prisma"
import { rootPath } from "@/lib/library-server"
import { fileVersion, isRootKey, type RootKey } from "@/lib/media"
import { moveToDropoff, restoreBatch, trashFiles } from "@/lib/file-ops-server"
import { classifyPhotos, planResolution, scanFolderSegments } from "@/lib/ai/review"

export async function currentVersions(root: RootKey, folder: string, names: string[]): Promise<Map<string, string>> {
  const segs = scanFolderSegments(folder)
  const map = new Map<string, string>()
  if (!segs) return map
  const dir = path.join(rootPath(root), ...segs)
  await Promise.all(
    names.map(async (name) => {
      try {
        map.set(name, fileVersion(await fs.stat(path.join(dir, name))))
      } catch {
        // gone
      }
    })
  )
  return map
}

export type ResolveResult = { error: string } | { moved: number; kept: number; trashed: number; missing: number }

/** Keeps the photos named in `keep` (moved to Dropoff from Mobile Upload) and trashes the rest. */
export function resolveGroup(groupId: string, keep: string[], userId: string): Promise<ResolveResult> {
  return settleGroup(groupId, userId, (valid) => planResolution(valid, keep))
}

/** Trashes every photo in the group ("Delete all"). Undo restores them like any other resolution. */
export function trashGroup(groupId: string, userId: string): Promise<ResolveResult> {
  return settleGroup(groupId, userId, (valid) => (valid.length ? { keep: [], trash: valid } : { error: "None of these photos are still here." }))
}

async function settleGroup(
  groupId: string,
  userId: string,
  planFor: (valid: string[]) => { keep: string[]; trash: string[] } | { error: string }
): Promise<ResolveResult> {
  const group = await prisma.aiGroup.findUnique({ where: { id: groupId }, include: { photos: true } })
  if (!group || !isRootKey(group.root)) return { error: "That group no longer exists." }
  if (group.status !== "ANALYZED") return { error: "That group has already been handled." }
  const segs = scanFolderSegments(group.folder)
  if (!segs) return { error: "Invalid folder." }

  const current = await currentVersions(group.root, group.folder, group.photos.map((p) => p.name))
  const { valid, missing } = classifyPhotos(group.photos, current)
  const plan = planFor(valid)
  if ("error" in plan) return plan

  // Claim the group first so a double click or a second user can't act twice.
  const claimed = await prisma.aiGroup.updateMany({ where: { id: groupId, status: "ANALYZED" }, data: { status: "RESOLVED", resolvedById: userId, resolvedAt: new Date() } })
  if (claimed.count === 0) return { error: "That group has already been handled." }

  let moved = 0
  let trashBatchId: string | null = null
  let trashedNames: string[] = []
  try {
    if (group.root === "upload" && plan.keep.length) moved = (await moveToDropoff(segs, plan.keep)).ok.length
    if (plan.trash.length) {
      const t = await trashFiles(group.root, segs, plan.trash)
      trashBatchId = t.batchId
      trashedNames = t.ok
    }
  } catch (error) {
    await prisma.aiGroup.update({ where: { id: groupId }, data: { status: "ANALYZED", resolvedById: null, resolvedAt: null } })
    return { error: error instanceof Error ? error.message : String(error) }
  }

  const keepSet = new Set(plan.keep)
  const trashSet = new Set(trashedNames)
  await prisma.$transaction([
    ...group.photos.map((p) =>
      prisma.aiGroupPhoto.update({
        where: { id: p.id },
        data: { decision: keepSet.has(p.name) ? "KEEP" : trashSet.has(p.name) ? "TRASH" : null },
      })
    ),
    prisma.aiGroup.update({ where: { id: groupId }, data: { trashBatchId } }),
  ])
  return { moved, kept: plan.keep.length, trashed: trashedNames.length, missing: missing.length }
}

export async function dismissGroup(groupId: string, userId: string): Promise<{ error: string } | { ok: true }> {
  const r = await prisma.aiGroup.updateMany({
    where: { id: groupId, status: { in: ["ANALYZED", "FAILED"] } },
    data: { status: "DISMISSED", resolvedById: userId, resolvedAt: new Date() },
  })
  return r.count ? { ok: true } : { error: "That group has already been handled." }
}

export async function undoGroup(groupId: string): Promise<{ error: string } | { restored: number }> {
  const group = await prisma.aiGroup.findUnique({ where: { id: groupId } })
  if (!group || !isRootKey(group.root)) return { error: "That group no longer exists." }
  if (group.status !== "RESOLVED" && group.status !== "DISMISSED") return { error: "Nothing to undo." }
  let restored = 0
  if (group.trashBatchId) restored = (await restoreBatch(group.root, group.trashBatchId)).ok.length
  await prisma.$transaction([
    prisma.aiGroupPhoto.updateMany({ where: { groupId }, data: { decision: null } }),
    prisma.aiGroup.update({ where: { id: groupId }, data: { status: "ANALYZED", trashBatchId: null, resolvedById: null, resolvedAt: null } }),
  ])
  return { restored }
}
