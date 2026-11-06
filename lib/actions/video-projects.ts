"use server"

import fs from "fs/promises"
import path from "path"
import { z } from "zod"
import { redirect } from "next/navigation"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { rootPath } from "@/lib/library-server"
import { isPlainName, isSkippedDir, mediaKind, safeSegments, tempFolderName } from "@/lib/media"
import { exportRunning, exportStatus, startExport, type ExportStatus } from "@/lib/video/export-jobs-server"
import { mergeClientProject, type Asset } from "@/lib/video/project"
import { withLock } from "@/lib/video/project-lock-server"
import { createProject, deleteProject, importAsset, readProject, renameProject, writeProject } from "@/lib/video/projects-server"

// Server actions for video projects. The user's folder always comes from the
// session, never from the client; failures come back as { error }.

const plainName = z.string().refine(isPlainName)
const MAX_CLIPS = 5000
const MAX_PROJECT_JSON = 2_000_000
const projectName = z.string().trim().min(1).max(200)
const EXPORT_RUNNING = "This project is exporting. Try again when the export has finished."

async function requireUserFolder(): Promise<{ userFolder: string }> {
  const session = await auth()
  if (!session) redirect("/login")
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true } })
  if (!user) redirect("/login")
  return { userFolder: tempFolderName(user.name, user.email) }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function createProjectAction(name: string): Promise<{ folder: string } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const parsed = projectName.safeParse(name)
  if (!parsed.success) return { error: "Invalid project name." }
  try {
    return await createProject(userFolder, parsed.data)
  } catch (error) {
    return { error: errorText(error) }
  }
}

export async function renameProjectAction(folder: string, name: string): Promise<{ folder: string } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const f = plainName.safeParse(folder)
  const n = projectName.safeParse(name)
  if (!f.success || !n.success) return { error: "Invalid request." }
  if (exportRunning(userFolder, f.data)) return { error: EXPORT_RUNNING }
  try {
    return await withLock(`${userFolder}/${f.data}`, () => renameProject(userFolder, f.data, n.data))
  } catch (error) {
    return { error: errorText(error) }
  }
}

export async function deleteProjectAction(folder: string): Promise<{ ok: true } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const f = plainName.safeParse(folder)
  if (!f.success) return { error: "Invalid request." }
  if (exportRunning(userFolder, f.data)) return { error: EXPORT_RUNNING }
  try {
    await withLock(`${userFolder}/${f.data}`, () => deleteProject(userFolder, f.data))
    return { ok: true }
  } catch (error) {
    return { error: errorText(error) }
  }
}

export async function saveProjectAction(folder: string, project: unknown): Promise<{ ok: true } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const f = plainName.safeParse(folder)
  if (!f.success) return { error: "Invalid request." }
  const tooLarge =
    typeof project === "object" && project !== null && Array.isArray((project as { clips?: unknown }).clips) && (project as { clips: unknown[] }).clips.length > MAX_CLIPS
  if (tooLarge || JSON.stringify(project ?? null).length > MAX_PROJECT_JSON) return { error: "Project is too large." }
  try {
    return await withLock(`${userFolder}/${f.data}`, async () => {
      // Saving must not resurrect a deleted project; assets are server-owned.
      const stored = await readProject(userFolder, f.data)
      if (!stored) return { error: "Project not found." }
      const merged = mergeClientProject(project, stored)
      if (!merged) return { error: "Invalid project." }
      await writeProject(userFolder, f.data, merged)
      return { ok: true as const }
    })
  } catch (error) {
    return { error: errorText(error) }
  }
}

export async function importAssetAction(
  folder: string,
  inboxFolder: string[],
  fileName: string
): Promise<{ id: string; asset: Asset } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const f = plainName.safeParse(folder)
  const file = plainName.safeParse(fileName)
  const inbox = z.array(z.string()).max(64).safeParse(inboxFolder)
  const segments = inbox.success ? safeSegments(inbox.data) : null
  if (!f.success || !file.success || !segments) return { error: "Invalid request." }
  try {
    return await withLock(`${userFolder}/${f.data}`, async () => {
      const imported = await importAsset(userFolder, f.data, segments, file.data)
      if ("error" in imported) return imported
      const project = await readProject(userFolder, f.data)
      if (!project) return { error: "Project not found." }
      await writeProject(userFolder, f.data, { ...project, assets: { ...project.assets, [imported.id]: imported.asset } })
      return imported
    })
  } catch (error) {
    return { error: errorText(error) }
  }
}

/** Video files in each user's Inbox folder; the current user's own folder comes first. */
export async function listInboxAction(): Promise<{ folder: string; files: { name: string; size: number }[] }[]> {
  const { userFolder } = await requireUserFolder()
  const root = rootPath("video-inbox")
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: { folder: string; files: { name: string; size: number }[] }[] = []
  for (const e of entries) {
    if (!e.isDirectory() || isSkippedDir(e.name)) continue
    const files: { name: string; size: number }[] = []
    try {
      for (const f of await fs.readdir(path.join(root, e.name), { withFileTypes: true })) {
        if (!f.isFile() || mediaKind(f.name) !== "video") continue
        const st = await fs.stat(path.join(root, e.name, f.name))
        files.push({ name: f.name, size: st.size })
      }
    } catch {
      continue
    }
    files.sort((a, b) => a.name.localeCompare(b.name))
    out.push({ folder: e.name, files })
  }
  out.sort((a, b) => Number(b.folder === userFolder) - Number(a.folder === userFolder) || a.folder.localeCompare(b.folder))
  return out
}

export async function startExportAction(folder: string): Promise<{ jobId: string } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const f = plainName.safeParse(folder)
  if (!f.success) return { error: "Invalid request." }
  try {
    return await startExport(userFolder, f.data)
  } catch (error) {
    return { error: errorText(error) }
  }
}

export async function exportStatusAction(jobId: string): Promise<ExportStatus> {
  const { userFolder } = await requireUserFolder()
  return exportStatus(userFolder, String(jobId))
}
