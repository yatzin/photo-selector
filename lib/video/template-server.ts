import "server-only"
import fs from "fs/promises"
import path from "path"
import { z } from "zod"
import { projectFolderName, resolveInside } from "@/lib/media"
import { rootPath } from "@/lib/library-server"
import { allClips, type Project } from "./project"
import { peaksFileName } from "./peaks"
import { withLock } from "./project-lock-server"
import { assetPath, projectDir, readProject, writeProject } from "./projects-server"
import { MAX_SLOTS, MAX_SLOT_LABEL, MAX_TEMPLATE_DESCRIPTION, type TemplateInfo } from "./template"
import { buildSlots } from "./template-slots"
import { planPlaceholders, renderPlaceholders } from "./template-placeholder-server"
import { slotsNeedingPlaceholders, withPlaceholders } from "./template-placeholders"

// Templates on the server. A template is a copy of a project folder whose
// project.json carries `template.master`; starting from one copies it again.
// The exports (output/) are never copied, and the source project is never
// changed. Every name comes from the session or a plain-name check.

export const templateInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(MAX_TEMPLATE_DESCRIPTION * 2).optional(),
  /** Clip id to the slot's label. */
  slots: z.record(z.string().min(1).max(100), z.string().max(MAX_SLOT_LABEL * 4)).refine((s) => Object.keys(s).length <= MAX_SLOTS),
})

type Result<T> = T | { error: string }

/** Copies project folder `from` to `to` (a new folder), leaving out the exports and staging files. */
async function copyProjectDir(from: string, to: string, keepFiles?: ReadonlySet<string>): Promise<void> {
  await fs.cp(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (src) => {
      const rel = path.relative(from, src)
      if (rel === "") return true
      const parts = rel.split(path.sep)
      // Never the exports, the cached keyed pictures or staging files; in assets/, only the files keepFiles names (a template keeps the media its fixed clips use).
      if (parts[0] === "output" || parts[0] === "keyed" || /\.(tmp|part)$/i.test(src)) return false
      if (keepFiles && parts[0] === "assets" && parts.length === 2) return keepFiles.has(parts[1])
      return true
    },
  })
  await fs.mkdir(path.join(to, "output"), { recursive: true })
}

/** The file names of a project's assets, and their waveform caches. */
function assetFiles(p: Project): Set<string> {
  const out = new Set<string>()
  for (const a of Object.values(p.assets)) {
    out.add(a.file)
    out.add(peaksFileName(a.file))
  }
  return out
}

/**
 * The template version of project for labels (clip id to the slot label): each
 * replaceable clip holds a placeholder (planned here, written by the caller
 * into the template assets folder) and the media only they used is gone from
 * the assets.
 */
async function templateVersion(userFolder: string, folder: string, project: Project, labels: Record<string, string>) {
  const needs = slotsNeedingPlaceholders(project, labels)
  const plan = await planPlaceholders(userFolder, folder, project, needs)
  const made = Object.fromEntries(plan.map((pl) => [pl.clipId, { id: pl.id, asset: pl.asset }]))
  const next = withPlaceholders(project, labels, made)
  return { plan, next }
}

/** A new project folder inside the user's folder for `name`, or an error when that name is taken. */
function newFolderFor(userFolder: string, name: string): { folder: string; dir: string } | { error: string } {
  const user = resolveInside(rootPath("video-projects"), [userFolder])
  const folder = projectFolderName(name)
  const dir = user ? resolveInside(user, [folder]) : null
  if (!user || !dir || dir === user) return { error: "Invalid name." }
  return { folder, dir }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false)
}

/** Saves project `folder` as a template named `name`: a copy with the marked clips as slots. The project itself is unchanged. */
export async function createTemplate(userFolder: string, folder: string, rawInput: unknown): Promise<Result<{ folder: string }>> {
  const input = templateInput.safeParse(rawInput)
  if (!input.success) return { error: "Invalid request." }
  const src = projectDir(userFolder, folder)
  if (!src) return { error: "Invalid request." }
  return withLock(`${userFolder}/${folder}`, async () => {
    const project = await readProject(userFolder, folder)
    if (!project) return { error: "Project not found." }
    const checked = buildSlots(project, input.data.slots)
    const labels = Object.fromEntries(Object.entries(checked).map(([id, slot]) => [id, slot.label]))
    if (Object.keys(labels).length === 0) return { error: "Mark at least one clip as replaceable." }
    const target = newFolderFor(userFolder, input.data.name)
    if ("error" in target) return target
    if (await exists(target.dir)) return { error: "A project or template with that name already exists." }
    try {
      const { plan, next } = await templateVersion(userFolder, folder, project, labels)
      // Only the media the fixed clips use is copied; the placeholders are written fresh.
      await copyProjectDir(src, target.dir, assetFiles(next))
      await renderPlaceholders(path.join(target.dir, "assets"), plan)
      const template: TemplateInfo = { master: true, ...(input.data.description?.trim() ? { description: input.data.description.trim() } : {}), slots: buildSlots(next, labels) }
      await writeProject(userFolder, target.folder, { ...next, name: input.data.name.trim(), template })
      return { folder: target.folder }
    } catch {
      await fs.rm(target.dir, { recursive: true, force: true }).catch(() => {})
      return { error: "Couldn't save the template." }
    }
  })
}

/** Starts a new project named `name` from template `templateFolder`: a copy that is an ordinary project, its replaceable clips showing their placeholders. */
export async function startFromTemplate(userFolder: string, templateFolder: string, rawName: unknown): Promise<Result<{ folder: string }>> {
  const name = z.string().trim().min(1).max(200).safeParse(rawName)
  if (!name.success) return { error: "Enter a name first." }
  const src = projectDir(userFolder, templateFolder)
  if (!src) return { error: "Invalid request." }
  const template = await readProject(userFolder, templateFolder)
  if (!template?.template?.master) return { error: "That isn't a template." }
  const target = newFolderFor(userFolder, name.data)
  if ("error" in target) return target
  if (await exists(target.dir)) return { error: "A project or template with that name already exists." }
  try {
    await copyProjectDir(src, target.dir)
    // An ordinary project: the placeholders (media marked `placeholder`, labelled) are all that is left of the template.
    const { template: _template, ...rest } = template
    void _template
    const made: Project = { ...rest, name: name.data }
    await writeProject(userFolder, target.folder, made)
    return { folder: target.folder }
  } catch {
    await fs.rm(target.dir, { recursive: true, force: true }).catch(() => {})
    return { error: "Couldn't start the project." }
  }
}

/**
 * Changes which clips of template `folder` are slots, their labels and the
 * description. A clip newly made replaceable (or relabelled) gets a placeholder
 * and its media leaves the template; a slot made fixed keeps what it shows now
 * (a placeholder stays a placeholder: fill it first to give it real media).
 * Replies with the whole template project as stored: the editor reloads it.
 */
export async function saveTemplateSlots(userFolder: string, folder: string, rawInput: unknown): Promise<Result<{ project: Project }>> {
  const input = z.object({ description: z.string().max(MAX_TEMPLATE_DESCRIPTION * 2).optional(), slots: templateInput.shape.slots }).safeParse(rawInput)
  if (!input.success) return { error: "Invalid request." }
  const dir = projectDir(userFolder, folder)
  if (!dir) return { error: "Invalid request." }
  return withLock(`${userFolder}/${folder}`, async () => {
    const project = await readProject(userFolder, folder)
    if (!project?.template?.master) return { error: "That isn't a template." }
    const ids = new Set(allClips(project).map((c) => c.id))
    const marks = Object.fromEntries(Object.entries(input.data.slots).filter(([id]) => ids.has(id)))
    const checked = buildSlots(project, marks)
    const labels = Object.fromEntries(Object.entries(checked).map(([id, slot]) => [id, slot.label]))
    if (Object.keys(labels).length === 0) return { error: "Mark at least one clip as replaceable." }
    try {
      const { plan, next } = await templateVersion(userFolder, folder, project, labels)
      await renderPlaceholders(path.join(dir, "assets"), plan)
      const template: TemplateInfo = { master: true, ...(input.data.description?.trim() ? { description: input.data.description.trim() } : {}), slots: buildSlots(next, labels) }
      const saved: Project = { ...next, template }
      await writeProject(userFolder, folder, saved)
      // The media that left the template goes from its folder too.
      const keep = assetFiles(saved)
      for (const a of Object.values(project.assets)) {
        for (const name of [a.file, peaksFileName(a.file)]) {
          if (keep.has(name)) continue
          const file = assetPath(userFolder, folder, name)
          if (file) await fs.rm(file, { force: true }).catch(() => {})
        }
      }
      return { project: saved }
    } catch {
      return { error: "Couldn't save the slots." }
    }
  })
}
