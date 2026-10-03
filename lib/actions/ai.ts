"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { aiReady } from "@/lib/ai/config"
import { scanFolderSegments } from "@/lib/ai/review"
import { abortRun, createRun, requeueRun } from "@/lib/ai/runner-server"
import { dismissGroup, resolveGroup, undoGroup } from "@/lib/ai/review-server"
import { folderLocked } from "@/lib/ai/lock-server"
import { SCAN_LOCK_MESSAGE } from "@/lib/ai/lock"

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

/** Review actions change files in the group's folder, so they wait while that folder is being scanned. */
async function groupLocked(groupId: string): Promise<boolean> {
  const group = await prisma.aiGroup.findUnique({ where: { id: groupId }, select: { root: true, folder: true } })
  const segs = group ? scanFolderSegments(group.folder) : null
  return !!group && !!segs && (await folderLocked(group.root, segs))
}

export async function startRunAction(input: { root: string; folder: string; fresh: boolean }): Promise<{ error: string } | { runId: string }> {
  const session = await requireUser()
  const parsed = z.object({ root: z.string(), folder: z.string().max(1024), fresh: z.boolean() }).safeParse(input)
  if (!parsed.success) return { error: "Invalid request." }
  if (!(await aiReady())) return { error: "AI is not set up. Ask an admin to configure Settings → AI." }
  const result = await createRun({ ...parsed.data, userId: session.user.id })
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
  const result = await resolveGroup(parsed.data.groupId, parsed.data.keep, session.user.id)
  refresh()
  return result
}

export async function dismissGroupAction(groupId: string) {
  const session = await requireUser()
  if (await groupLocked(groupId)) return { error: SCAN_LOCK_MESSAGE }
  const result = await dismissGroup(groupId, session.user.id)
  refresh()
  return result
}

export async function undoGroupAction(groupId: string) {
  await requireUser()
  if (await groupLocked(groupId)) return { error: SCAN_LOCK_MESSAGE }
  const result = await undoGroup(groupId)
  refresh()
  return result
}
