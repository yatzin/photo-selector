"use server"

import fs from "fs/promises"
import path from "path"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { rootPath } from "@/lib/library-server"
import { isRootKey } from "@/lib/media"
import { aiReady } from "@/lib/ai/config"
import { folderKey, scanFolderSegments } from "@/lib/ai/review"
import { abortRun, kickRunner } from "@/lib/ai/runner-server"
import { dismissGroup, resolveGroup, undoGroup } from "@/lib/ai/review-server"

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

export async function startRunAction(input: { root: string; folder: string; fresh: boolean }): Promise<{ error: string } | { runId: string }> {
  const session = await requireUser()
  const parsed = z.object({ root: z.string(), folder: z.string().max(1024), fresh: z.boolean() }).safeParse(input)
  if (!parsed.success || !isRootKey(parsed.data.root)) return { error: "Invalid request." }
  const segs = scanFolderSegments(parsed.data.folder)
  if (!segs) return { error: "Invalid folder." }
  if (!(await aiReady())) return { error: "AI is not set up. Ask an admin to configure Settings → AI." }
  try {
    if (!(await fs.stat(path.join(rootPath(parsed.data.root), ...segs))).isDirectory()) return { error: "That folder doesn't exist." }
  } catch {
    return { error: "That folder doesn't exist." }
  }
  const run = await prisma.aiRun.create({
    data: { root: parsed.data.root, folder: folderKey(segs), fresh: parsed.data.fresh, createdById: session.user.id },
  })
  kickRunner()
  refresh()
  return { runId: run.id }
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
  const run = await prisma.aiRun.findUnique({ where: { id: runId } })
  if (!run || (ACTIVE as readonly string[]).includes(run.status)) return { error: "That scan is still running." }
  await prisma.$transaction([
    prisma.aiGroup.updateMany({ where: { runId, status: "FAILED" }, data: { status: "PENDING", error: null } }),
    prisma.aiRun.update({ where: { id: runId }, data: { status: "QUEUED", error: null, finishedAt: null } }),
  ])
  kickRunner()
  refresh()
  return { ok: true }
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
  const result = await resolveGroup(parsed.data.groupId, parsed.data.keep, session.user.id)
  refresh()
  return result
}

export async function dismissGroupAction(groupId: string) {
  const session = await requireUser()
  const result = await dismissGroup(groupId, session.user.id)
  refresh()
  return result
}

export async function undoGroupAction(groupId: string) {
  await requireUser()
  const result = await undoGroup(groupId)
  refresh()
  return result
}
