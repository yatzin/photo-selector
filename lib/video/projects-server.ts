import "server-only"
import { randomBytes } from "crypto"
import { constants } from "fs"
import fs from "fs/promises"
import path from "path"
import { rootPath } from "@/lib/library-server"
import { isPlainName, mediaKind, numberedName, projectFolderName, resolveInside } from "@/lib/media"
import { probeMedia } from "./ffmpeg-server"
import { newProject, parseProject, type Asset, type Project } from "./project"

// Video projects live at <video-projects>/<user>/<project>/ with assets/,
// output/, config/export.json and project.json. Every user-supplied name goes
// through isPlainName/resolveInside, and project names are cleaned into folder
// names, so nothing can step outside the user's folder.

const MAX_NAME_ATTEMPTS = 1000

function userDir(userFolder: string): string | null {
  if (!isPlainName(userFolder)) return null
  return resolveInside(rootPath("video-projects"), [userFolder])
}

function projectDir(userFolder: string, folder: string): string | null {
  if (!isPlainName(userFolder) || !isPlainName(folder)) return null
  return resolveInside(rootPath("video-projects"), [userFolder, folder])
}

const exists = (p: string) => fs.access(p).then(() => true, () => false)

export async function listProjects(userFolder: string): Promise<{ folder: string; name: string; clips: number; modified: number }[]> {
  const dir = userDir(userFolder)
  if (!dir) return []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: { folder: string; name: string; clips: number; modified: number }[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = await readProject(userFolder, e.name)
    if (!p) continue
    const st = await fs.stat(path.join(dir, e.name, "project.json"))
    out.push({ folder: e.name, name: p.name, clips: p.clips.length, modified: st.mtimeMs })
  }
  return out
}

export async function createProject(userFolder: string, name: string): Promise<{ folder: string } | { error: string }> {
  const user = userDir(userFolder)
  if (!user) return { error: "Invalid user folder." }
  const folder = projectFolderName(name)
  const dir = resolveInside(user, [folder])
  if (!dir || dir === user) return { error: "Invalid project name." }
  await fs.mkdir(user, { recursive: true })
  try {
    await fs.mkdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { error: "A project with that name already exists." }
    throw error
  }
  await fs.mkdir(path.join(dir, "assets"))
  await fs.mkdir(path.join(dir, "output"))
  await fs.mkdir(path.join(dir, "config"))
  await fs.writeFile(path.join(dir, "config", "export.json"), JSON.stringify({ width: 1920, height: 1080, fps: 30 }, null, 2))
  await writeProject(userFolder, folder, newProject(name))
  return { folder }
}

/** The project, or null when it's missing, unreadable or doesn't pass validation. */
export async function readProject(userFolder: string, folder: string): Promise<Project | null> {
  const dir = projectDir(userFolder, folder)
  if (!dir) return null
  try {
    return parseProject(JSON.parse(await fs.readFile(path.join(dir, "project.json"), "utf8")))
  } catch {
    return null
  }
}

/** Writes beside project.json, then renames over it, so a reader never sees half a file. */
export async function writeProject(userFolder: string, folder: string, p: Project): Promise<void> {
  const dir = projectDir(userFolder, folder)
  if (!dir) throw new Error("Invalid project.")
  const file = path.join(dir, "project.json")
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(p, null, 2))
    // Windows refuses a rename over a file that another rename is touching; retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, file)
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= 50 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error
        await new Promise((r) => setTimeout(r, 10))
      }
    }
  } finally {
    await fs.rm(tmp, { force: true })
  }
}

export async function renameProject(userFolder: string, folder: string, name: string): Promise<{ folder: string } | { error: string }> {
  const user = userDir(userFolder)
  const from = projectDir(userFolder, folder)
  if (!user || !from) return { error: "Invalid project." }
  const p = await readProject(userFolder, folder)
  if (!p) return { error: "Project not found." }
  const next = projectFolderName(name)
  const to = resolveInside(user, [next])
  if (!to || to === user) return { error: "Invalid project name." }
  if (next !== folder) {
    if (await exists(to)) return { error: "A project with that name already exists." }
    await fs.rename(from, to)
  }
  await writeProject(userFolder, next, { ...p, name })
  return { folder: next }
}

export async function deleteProject(userFolder: string, folder: string): Promise<void> {
  const dir = projectDir(userFolder, folder)
  if (!dir) return
  await fs.rm(dir, { recursive: true, force: true })
}

/** Copies a video from the Video Editing Inbox into the project's assets/ (never replacing a file) and probes it. The Inbox original stays. */
export async function importAsset(
  userFolder: string,
  folder: string,
  inboxFolder: string[],
  fileName: string
): Promise<{ id: string; asset: Asset } | { error: string }> {
  const dir = projectDir(userFolder, folder)
  if (!dir) return { error: "Invalid project." }
  if (!isPlainName(fileName) || mediaKind(fileName) !== "video") return { error: "Not a video." }
  const src = resolveInside(rootPath("video-inbox"), [...inboxFolder, fileName])
  if (!src) return { error: "Invalid Inbox folder." }
  const assets = path.join(dir, "assets")
  if (!(await exists(assets))) return { error: "Project not found." }

  let dest: string | null = null
  let file = ""
  try {
    for (let n = 0; n < MAX_NAME_ATTEMPTS && !dest; n++) {
      file = numberedName(fileName, n)
      const target = path.join(assets, file)
      try {
        await fs.copyFile(src, target, constants.COPYFILE_EXCL)
        dest = target
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
    }
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "The file no longer exists." : error instanceof Error ? error.message : String(error) }
  }
  if (!dest) return { error: "Too many files with that name." }

  try {
    const { duration, hasAudio } = await probeMedia(dest)
    return { id: `a${randomBytes(4).toString("hex")}`, asset: { file, duration, hasAudio } }
  } catch (error) {
    await fs.rm(dest, { force: true })
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function assetPath(userFolder: string, folder: string, file: string): string | null {
  const dir = projectDir(userFolder, folder)
  if (!dir || !isPlainName(file)) return null
  return resolveInside(path.join(dir, "assets"), [file])
}
