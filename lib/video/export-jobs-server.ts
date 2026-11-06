import "server-only"
import { randomBytes } from "crypto"
import fs from "fs/promises"
import path from "path"
import { numberedName, projectFolderName } from "@/lib/media"
import { buildExportArgs, runExport } from "./ffmpeg-server"
import { totalLength } from "./project"
import { assetPath, outputDir, readProject } from "./projects-server"

// Exports run in this server process; the job table sits on globalThis so a
// dev hot reload doesn't lose running jobs. Jobs belong to the user who
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

  let prepared: { args: string[]; tmp: string; final: (n: number) => string; total: number; dir: string }
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
    prepared = { args: buildExportArgs(project, files, tmp), tmp, final: (n) => numberedName(base, n), total: totalLength(project.clips), dir }
  } catch (error) {
    jobs.delete(jobId)
    return { error: error instanceof Error ? error.message : String(error) }
  }

  void run(job, prepared)
  return { jobId }
}

async function run(job: Job, { args, tmp, final, total, dir }: { args: string[]; tmp: string; final: (n: number) => string; total: number; dir: string }) {
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
    await fs.rm(tmp, { force: true })
    job.error = error instanceof Error ? error.message : String(error)
    job.state = "failed"
  } finally {
    job.finishedAt = Date.now()
  }
}

export function exportStatus(user: string, jobId: string): ExportStatus {
  const job = jobs.get(jobId)
  if (!job || job.user !== user) return { state: "failed", progress: 0, error: "Unknown export." }
  const { state, progress, output, error } = job
  return { state, progress, ...(output ? { output } : {}), ...(error ? { error } : {}) }
}
