"use server"

import { z } from "zod"
import { redirect } from "next/navigation"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { listDirectory } from "@/lib/library-server"
import { isPlainName, safeSegments, tempFolderName } from "@/lib/media"
import { exportRunning, exportStatus, startExport, type ExportStatus } from "@/lib/video/export-jobs-server"
import { MAX_CLIPS, MAX_TRACKS, mergeClientProject, type Asset, type Project } from "@/lib/video/project"
import { withLock } from "@/lib/video/project-lock-server"
import { createProject, deleteAsset, deleteProject, formatForFirstPicture, importAsset, readProject, renameProject, reusableAsset, setProjectFormat, writeProject } from "@/lib/video/projects-server"
import { previewRetime, retimeAsset } from "@/lib/video/retime-server"
import { createTemplate, saveTemplateSlots, startFromTemplate } from "@/lib/video/template-server"
import { ORIENTATIONS, RESOLUTIONS, type Orientation, type ResolutionId } from "@/lib/video/format"

// Server actions for video projects. The user's folder always comes from the
// session, never from the client; failures come back as { error }.

const plainName = z.string().refine(isPlainName)
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

/** Clips in a client-sent project, over every track (a version 1 project has a flat `clips` list), before it's parsed. */
function clipCount(project: unknown): number {
  if (typeof project !== "object" || project === null) return 0
  const { clips, tracks } = project as { clips?: unknown; tracks?: unknown }
  let n = Array.isArray(clips) ? clips.length : 0
  if (Array.isArray(tracks)) {
    for (const t of tracks.slice(0, MAX_TRACKS + 1)) {
      const trackClips = typeof t === "object" && t !== null ? (t as { clips?: unknown }).clips : undefined
      if (Array.isArray(trackClips)) n += trackClips.length
    }
  }
  return n
}

export async function saveProjectAction(folder: string, project: unknown): Promise<{ ok: true } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const f = plainName.safeParse(folder)
  if (!f.success) return { error: "Invalid request." }
  if (clipCount(project) > MAX_CLIPS || JSON.stringify(project ?? null).length > MAX_PROJECT_JSON) return { error: "Project is too large." }
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
): Promise<{ id: string; asset: Asset; reused?: true; format?: { width: number; height: number } } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const f = plainName.safeParse(folder)
  const file = plainName.safeParse(fileName)
  const inbox = z.array(z.string()).max(64).safeParse(inboxFolder)
  const segments = inbox.success ? safeSegments(inbox.data) : null
  if (!f.success || !file.success || !segments) return { error: "Invalid request." }
  try {
    return await withLock(`${userFolder}/${f.data}`, async () => {
      const project = await readProject(userFolder, f.data)
      if (!project) return { error: "Project not found." }
      // The same file again: use the copy that's already in the project.
      const existing = await reusableAsset(userFolder, f.data, project, [...segments, file.data].join("/"))
      if (existing) return { ...existing, reused: true as const }
      const imported = await importAsset(userFolder, f.data, segments, file.data)
      if ("error" in imported) return imported
      // A new project takes its orientation and resolution from its first picture or video.
      const format = await formatForFirstPicture(userFolder, f.data, project, imported.asset)
      await writeProject(userFolder, f.data, { ...project, ...format, assets: { ...project.assets, [imported.id]: imported.asset } })
      return format ? { ...imported, format } : imported
    })
  } catch (error) {
    return { error: errorText(error) }
  }
}

/**
 * Deletes a media item from the project: the asset, every clip on every track
 * that uses it (the stored project is the source of truth; the client sends
 * only ids) and its file in assets/ (best effort). Refused while the project
 * is exporting. The editor, on { ok }, applies removeAsset(project, assetId)
 * (lib/video/project) to its own copy and resets the undo history, so a save
 * or an undo can't bring back clips of an asset that's gone (the server would
 * refuse that save). The next export renders afresh because its clips changed.
 */
export async function deleteAssetAction(folder: string, assetId: string): Promise<{ ok: true; removedClips: number } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const f = plainName.safeParse(folder)
  const id = plainName.safeParse(assetId)
  if (!f.success || !id.success) return { error: "Invalid request." }
  try {
    return await withLock(`${userFolder}/${f.data}`, async () => {
      if (exportRunning(userFolder, f.data)) return { error: EXPORT_RUNNING }
      return deleteAsset(userFolder, f.data, id.data)
    })
  } catch (error) {
    return { error: errorText(error) }
  }
}

/** Sets the project's orientation and/or resolution. Not while it exports (the size is part of what an export is made from). */
export async function setFormatAction(folder: string, change: { orientation?: string; resolution?: string }): Promise<{ width: number; height: number } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const f = plainName.safeParse(folder)
  const orientation = ORIENTATIONS.find((o) => o.id === change?.orientation)?.id as Orientation | undefined
  const resolution = RESOLUTIONS.find((r) => r.id === change?.resolution)?.id as ResolutionId | undefined
  if (!f.success || (!orientation && !resolution) || (change?.orientation !== undefined && !orientation) || (change?.resolution !== undefined && !resolution)) return { error: "Invalid request." }
  if (exportRunning(userFolder, f.data)) return { error: EXPORT_RUNNING }
  try {
    return await withLock(`${userFolder}/${f.data}`, () => setProjectFormat(userFolder, f.data, { orientation, resolution }))
  } catch (error) {
    return { error: errorText(error) }
  }
}

export type TempListing = {
  folders: { name: string; mediaCount: number }[]
  files: { name: string; size: number; kind: "image" | "video" }[]
}

/**
 * One level of Personal Storage for the editor's left panel, loaded when a
 * folder is opened. At the top level the current user's own folder comes first.
 */
export async function listTempFolderAction(segments: string[]): Promise<TempListing | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const parsed = z.array(z.string()).max(16).safeParse(segments)
  const safe = parsed.success ? safeSegments(parsed.data) : null
  if (!safe) return { error: "Invalid folder." }
  const listing = await listDirectory("temp", safe)
  if (!listing) return { error: "That folder no longer exists." }
  const own = (name: string) => Number(safe.length === 0 && name === userFolder)
  return {
    folders: listing.folders.sort((a, b) => own(b.name) - own(a.name) || a.name.localeCompare(b.name, undefined, { numeric: true })),
    files: listing.files.map((f) => ({ name: f.name, size: f.size, kind: f.kind })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
  }
}

export async function startExportAction(folder: string): Promise<{ jobId: string; reused?: true; output?: string } | { error: string }> {
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

/**
 * Speed / Reverse: a copy of the part of video `assetId` a clip shows (trim
 * `options.in` to `options.out`) at `options.speed`, reversed or not, as a new
 * hidden asset the clip can point at; speed 1 forwards gives the original back.
 * The editor adds the asset to its project and calls retimeClip with the trim
 * in the reply.
 */
export async function retimeAssetAction(
  folder: string,
  assetId: string,
  options: { in: number; out: number; speed: number; reverse: boolean }
): Promise<{ id: string; asset: Asset; in: number; out: number } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const f = plainName.safeParse(folder)
  const a = z.string().min(1).max(100).safeParse(assetId)
  if (!f.success || !a.success) return { error: "Invalid request." }
  try {
    return await retimeAsset(userFolder, f.data, a.data, options)
  } catch (error) {
    return { error: errorText(error) }
  }
}

/** A short sample (about 6 s from the middle) of what Speed / Reverse would make, to listen to first; nothing is stored. */
export async function previewRetimeAction(
  folder: string,
  assetId: string,
  options: { in: number; out: number; speed: number; reverse: boolean }
): Promise<{ dataUrl: string; audioOnly: boolean; seconds: number } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const f = plainName.safeParse(folder)
  const a = z.string().min(1).max(100).safeParse(assetId)
  if (!f.success || !a.success) return { error: "Invalid request." }
  try {
    return await previewRetime(userFolder, f.data, a.data, options)
  } catch (error) {
    return { error: errorText(error) }
  }
}

/** Saves project `folder` as a template: a copy with the marked clips (`input.slots`: clip id to label) as slots. The project is unchanged. */
export async function createTemplateAction(
  folder: string,
  input: { name: string; description?: string; slots: Record<string, string> }
): Promise<{ folder: string } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const f = plainName.safeParse(folder)
  if (!f.success) return { error: "Invalid request." }
  try {
    return await createTemplate(userFolder, f.data, input)
  } catch (error) {
    return { error: errorText(error) }
  }
}

/** Starts a new project named `name` from template `templateFolder`. */
export async function startFromTemplateAction(templateFolder: string, name: string): Promise<{ folder: string } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const f = plainName.safeParse(templateFolder)
  if (!f.success) return { error: "Invalid request." }
  try {
    return await startFromTemplate(userFolder, f.data, name)
  } catch (error) {
    return { error: errorText(error) }
  }
}

/** Changes which clips of template `folder` are slots, their labels and its description. Replies with the whole template project as stored (placeholders made, replaced media gone): the editor reloads it. */
export async function saveTemplateSlotsAction(
  folder: string,
  input: { description?: string; slots: Record<string, string> }
): Promise<{ project: Project } | { error: string }> {
  const { userFolder } = await requireUserFolder()
  const f = plainName.safeParse(folder)
  if (!f.success) return { error: "Invalid request." }
  try {
    return await saveTemplateSlots(userFolder, f.data, input)
  } catch (error) {
    return { error: errorText(error) }
  }
}
