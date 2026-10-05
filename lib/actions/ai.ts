"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { aiReady } from "@/lib/ai/config"
import { isScanKind, scanFolderSegments } from "@/lib/ai/review"
import { markShots, moveShots, trashShots, undoTrashShots } from "@/lib/ai/shot-review-server"
import { abortRun, clearQueue, createRun, queueUnscanned, requeueRun } from "@/lib/ai/runner-server"
import { listScanFolders } from "@/lib/library-server"
import { dismissGroup, resolveGroup, resolveGroups, undoGroup, trashGroup } from "@/lib/ai/review-server"
import { folderLocked } from "@/lib/ai/lock-server"
import { SCAN_LOCK_MESSAGE } from "@/lib/ai/lock"
import { syncRunClosed } from "@/lib/ai/close-run-server"

async function requireUser() {
  const session = await auth()
  if (!session) redirect("/login")
  return session
}

function refresh() {
  revalidatePath("/ai", "layout")
  revalidatePath("/library", "layout")
}

const ACTIVE = ["QUEUED", "GROUPING", "ANALYZING"] as const

const runOfGroup = async (groupId: string) => (await prisma.aiGroup.findUnique({ where: { id: groupId }, select: { runId: true } }))?.runId ?? null

/**
 * After a review action: `closed` is true when that was the last thing to
 * handle in the scan, which is then closed (see close-run-server.ts) so the
 * page can head back to the scan list.
 */
async function withClosed<T extends object>(runId: string | null, result: T): Promise<T & { closed: boolean }> {
  const closed = !("error" in result) && !!runId && (await syncRunClosed(runId))
  return { ...result, closed }
}

/** Review actions change files in the group's folder, so they wait while that folder is being scanned. */
async function groupLocked(groupId: string): Promise<boolean> {
  const group = await prisma.aiGroup.findUnique({ where: { id: groupId }, select: { root: true, folder: true } })
  const segs = group ? scanFolderSegments(group.folder) : null
  return !!group && !!segs && (await folderLocked(group.root, segs))
}

export async function startRunAction(input: { root: string; folder: string; fresh: boolean; kind?: string }): Promise<{ error: string } | { runId: string }> {
  const session = await requireUser()
  const parsed = z.object({ root: z.string(), folder: z.string().max(1024), fresh: z.boolean(), kind: z.string().refine(isScanKind).optional() }).safeParse(input)
  if (!parsed.success) return { error: "Invalid request." }
  if (!(await aiReady())) return { error: "AI is not set up. Ask an admin to configure Settings → AI." }
  const { kind, ...rest } = parsed.data
  const result = await createRun({ ...rest, kind: isScanKind(kind) ? kind : "similar", userId: session.user.id })
  refresh()
  return result
}

/** Queues a separate scan for every folder in the picker that has never been scanned. */
export async function queueUnscannedAction(kind: string = "similar"): Promise<{ error: string } | { queued: number }> {
  const session = await requireUser()
  if (!isScanKind(kind)) return { error: "Invalid request." }
  if (!(await aiReady())) return { error: "AI is not set up. Ask an admin to configure Settings → AI." }
  const result = await queueUnscanned(await listScanFolders(), session.user.id, kind)
  refresh()
  return result
}

export async function clearQueueAction(kind: string = "similar"): Promise<{ removed: number }> {
  await requireUser()
  const result = await clearQueue(isScanKind(kind) ? kind : "similar")
  refresh()
  return result
}

export async function cancelRunAction(runId: string) {
  await requireUser()
  await prisma.aiRun.updateMany({ where: { id: runId, status: { in: [...ACTIVE] } }, data: { status: "CANCELLED", finishedAt: new Date() } })
  abortRun(runId)
  refresh()
  return { ok: true }
}

export async function retryRunAction(runId: string) {
  await requireUser()
  const result = await requeueRun(runId)
  refresh()
  return result
}

export async function removeRunAction(runId: string) {
  await requireUser()
  await prisma.aiRun.updateMany({ where: { id: runId, status: { in: [...ACTIVE] } }, data: { status: "CANCELLED" } })
  abortRun(runId)
  await prisma.aiRun.deleteMany({ where: { id: runId } })
  refresh()
  return { ok: true }
}

export async function resolveGroupAction(groupId: string, keep: string[]) {
  const session = await requireUser()
  const parsed = z.object({ groupId: z.string().min(1), keep: z.array(z.string()).max(50) }).safeParse({ groupId, keep })
  if (!parsed.success) return { error: "Invalid request." }
  if (await groupLocked(parsed.data.groupId)) return { error: SCAN_LOCK_MESSAGE }
  const result = await withClosed(await runOfGroup(parsed.data.groupId), await resolveGroup(parsed.data.groupId, parsed.data.keep, session.user.id))
  refresh()
  return result
}

/** "Accept all selections" on a review page: settles each group with its picks, in turn. */
export async function resolveGroupsAction(items: { groupId: string; keep: string[] }[]) {
  const session = await requireUser()
  const parsed = z.array(z.object({ groupId: z.string().min(1), keep: z.array(z.string()).max(50) })).max(100).safeParse(items)
  if (!parsed.success) return { error: "Invalid request." }
  const open: typeof parsed.data = []
  for (const item of parsed.data) if (!(await groupLocked(item.groupId))) open.push(item)
  const result = await resolveGroups(open, session.user.id)
  const closed = parsed.data.length > 0 && (await withClosed(await runOfGroup(parsed.data[0].groupId), result)).closed
  refresh()
  return { ...result, failed: result.failed + (parsed.data.length - open.length), closed }
}

export async function trashGroupAction(groupId: string) {
  const session = await requireUser()
  if (await groupLocked(groupId)) return { error: SCAN_LOCK_MESSAGE }
  const result = await withClosed(await runOfGroup(groupId), await trashGroup(groupId, session.user.id))
  refresh()
  return result
}

export async function dismissGroupAction(groupId: string) {
  const session = await requireUser()
  if (await groupLocked(groupId)) return { error: SCAN_LOCK_MESSAGE }
  const result = await withClosed(await runOfGroup(groupId), await dismissGroup(groupId, session.user.id))
  refresh()
  return result
}

export async function undoGroupAction(groupId: string) {
  await requireUser()
  if (await groupLocked(groupId)) return { error: SCAN_LOCK_MESSAGE }
  const result = await undoGroup(groupId)
  const runId = await runOfGroup(groupId)
  if (!("error" in result) && runId) await syncRunClosed(runId)
  refresh()
  return result
}

const shotIds = z.object({ runId: z.string().min(1), ids: z.array(z.string().min(1)).min(1).max(2000) })

/** Find Screenshots / Quality Checks results: delete, move to Sort Dropoff, or mark as not flagged (and back). */
export async function shotAction(input: { runId: string; ids: string[]; action: "delete" | "move" | "keep" | "unkeep" }) {
  await requireUser()
  const parsed = shotIds.extend({ action: z.enum(["delete", "move", "keep", "unkeep"]) }).safeParse(input)
  if (!parsed.success) return { error: "Invalid request." }
  const { runId, ids, action } = parsed.data
  const result =
    action === "delete" ? await trashShots(runId, ids)
    : action === "move" ? await moveShots(runId, ids)
    : await markShots(runId, ids, action === "keep" ? "KEPT" : "FLAGGED")
  const closed = await withClosed(runId, result)
  refresh()
  return closed
}

export async function undoShotDeleteAction(input: { runId: string; batchId: string; ids: string[] }) {
  await requireUser()
  const parsed = shotIds.extend({ batchId: z.string().min(1) }).safeParse(input)
  if (!parsed.success) return { error: "Invalid request." }
  const result = await undoTrashShots(parsed.data.runId, parsed.data.batchId, parsed.data.ids)
  if (!("error" in result)) await syncRunClosed(parsed.data.runId)
  refresh()
  return result
}
