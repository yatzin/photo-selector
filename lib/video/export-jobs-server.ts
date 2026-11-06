import "server-only"
import { randomBytes } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { numberedName, projectFolderName } from "@/lib/media"
import { buildExportArgs, buildExportGraph, runExport } from "./ffmpeg-server"
import { totalLength } from "./project"
import { assetPath, outputDir, readProject } from "./projects-server"

// Exports run in this server process (the table is in-process, so a second
// server instance wouldn't see these jobs); it sits on globalThis so a dev hot
// reload doesn't lose running jobs. Jobs belong to the user who
// started them, so another user's job id looks like an unknown one.

type Job = {
  user: string
  folder: string
  state: "running" | "done" | "failed"
  progress: number
  output?: string
  error?: string
  finishedAt?: number
}
export type ExportStatus = { state: "running" | "done" | "failed"; progress: number; output?: string; error?: string }

const g = globalThis as unknown as { __psExportJobs?: Map<string, Job> }
const jobs = (g.__psExportJobs ??= new Map<string, Job>())

const KEEP_FINISHED_MS = 60 * 60 * 1000
const MAX_NAME_ATTEMPTS = 1000
const exists = (p: string) => fs.access(p).then(() => true, () => false)

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`
}

/** Error text that is safe to show the user: no file system paths. */
export function sanitizeError(message: string): string {
  const text = message
    .replace(/\\\\[^\s"']+?(?=:(?:\s|$)|\s|["']|$)/g, "file") // UNC
    .replace(/[A-Za-z]:[\\/][^\s"']*?(?=:(?:\s|$)|\s|["']|$)/g, "file") // drive paths
    .replace(/(^|[\s"'(=:])(?:\.{1,2})?\/[^\s"']+?(?=:(?:\s|$)|\s|["']|$)/g, "$1file") // rooted or ./relative
    .replace(/(^|[\s"'(=:])\.{1,2}\\[^\s"']+?(?=:(?:\s|$)|\s|["']|$)/g, "$1file")
    .trim()
  return /[A-Za-z]{2}/.test(text.replace(/file/g, "")) ? text : "The export failed."
}

const safeMessage = (error: unknown) => sanitizeError(error instanceof Error ? error.message : String(error))

function prune() {
  const now = Date.now()
  for (const [id, j] of jobs) if (j.finishedAt && now - j.finishedAt > KEEP_FINISHED_MS) jobs.delete(id)
}

export async function startExport(user: string, folder: string): Promise<{ jobId: string } | { error: string }> {
  prune()
  const key = `${user}/${folder}`
  for (const j of jobs.values()) {
    if (j.state === "running" && `${j.user}/${j.folder}` === key) return { error: "An export is already running for this project." }
  }
  // Claim the project before any await so two quick clicks can't both start.
  const jobId = randomBytes(8).toString("hex")
  const job: Job = { user, folder, state: "running", progress: 0 }
  jobs.set(jobId, job)

  let prepared: Prepared
  try {
    const project = await readProject(user, folder)
    if (!project) throw new Error("Project not found.")
    if (project.clips.length === 0) throw new Error("Nothing to export")
    const dir = outputDir(user, folder)
    if (!dir) throw new Error("Invalid project.")
    const files: Record<string, string> = {}
    for (const clip of project.clips) {
      if (files[clip.asset]) continue
      const asset = project.assets[clip.asset]
      const file = asset && assetPath(user, folder, asset.file)
      if (!asset || !file || !(await exists(file))) throw new Error(`${asset?.file ?? "A clip's file"} is missing from the project's assets.`)
      files[clip.asset] = file
    }
    await fs.mkdir(dir, { recursive: true })
    const base = `${projectFolderName(project.name)} ${stamp(new Date())}.mp4`
    const tmp = path.join(dir, `${base}.${randomBytes(4).toString("hex")}.tmp`)
    // The filtergraph goes through a file: one clip adds ~400 characters, and Windows caps a command line at 32,767.
    const script = path.join(os.tmpdir(), `ps-export-${randomBytes(8).toString("hex")}.txt`)
    const args = buildExportArgs(project, files, tmp, script)
    await fs.writeFile(script, buildExportGraph(project, files).graph)
    prepared = { args, tmp, script, final: (n) => numberedName(base, n), total: totalLength(project.clips), dir }
  } catch (error) {
    jobs.delete(jobId)
    return { error: safeMessage(error) }
  }

  run(job, prepared).catch((error) => {
    job.error = safeMessage(error)
    job.state = "failed"
    job.finishedAt = Date.now()
  })
  return { jobId }
}

type Prepared = { args: string[]; tmp: string; script: string; final: (n: number) => string; total: number; dir: string }

const quietRm = (file: string) => fs.rm(file, { force: true }).catch(() => {})

async function run(job: Job, { args, tmp, script, final, total, dir }: Prepared) {
  try {
    await runExport(args, tmp, total, (f) => {
      job.progress = Math.max(job.progress, f)
    })
    // Take the first free name at the moment of finishing, so nothing is overwritten.
    for (let n = 0; n < MAX_NAME_ATTEMPTS; n++) {
      const name = final(n)
      if (await exists(path.join(dir, name))) continue
      await fs.rename(tmp, path.join(dir, name))
      job.output = name
      job.progress = 1
      job.state = "done"
      return
    }
    throw new Error("Too many files with that name.")
  } catch (error) {
    // Report first; cleanup is best effort (Windows can refuse with EBUSY/EPERM) and never blocks or throws.
    job.error = safeMessage(error)
    job.state = "failed"
    await quietRm(tmp)
  } finally {
    job.finishedAt = Date.now()
    await quietRm(script)
  }
}

export function exportStatus(user: string, jobId: string): ExportStatus {
  const job = jobs.get(jobId)
  if (!job || job.user !== user) return { state: "failed", progress: 0, error: "Unknown export." }
  const { state, progress, output, error } = job
  return { state, progress, ...(output ? { output } : {}), ...(error ? { error } : {}) }
}
