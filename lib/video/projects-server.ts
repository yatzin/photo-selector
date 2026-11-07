import "server-only"
import { randomBytes } from "crypto"
import { constants } from "fs"
import fs from "fs/promises"
import path from "path"
import { rootPath } from "@/lib/library-server"
import { isPlainName, mediaKind, numberedName, projectFolderName, resolveInside } from "@/lib/media"
import { probeMedia } from "./ffmpeg-server"
import { DEFAULT_IMAGE, findAssetsBySource, MIN_CLIP, newProject, parseProject, type Asset, type Project } from "./project"

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function sameDir(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([fs.stat(a), fs.stat(b)])
    return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev
  } catch {
    return false
  }
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
    try {
      const st = await fs.stat(path.join(dir, e.name, "project.json"))
      out.push({ folder: e.name, name: p.name, clips: p.clips.length, modified: st.mtimeMs })
    } catch {
      continue
    }
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
  try {
    await fs.mkdir(path.join(dir, "assets"))
    await fs.mkdir(path.join(dir, "output"))
    await fs.mkdir(path.join(dir, "config"))
    await fs.writeFile(path.join(dir, "config", "export.json"), JSON.stringify({ width: 1920, height: 1080, fps: 30 }, null, 2))
    await writeProject(userFolder, folder, newProject(name))
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true })
    return { error: errorText(error) }
  }
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
    try {
      await fs.mkdir(to)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { error: errorText(error) }
      // On a case-insensitive file system "Old" -> "old" finds the project itself; step through a temp name.
      const same = next.toLowerCase() === folder.toLowerCase() && (await sameDir(from, to))
      if (!same) return { error: "A project with that name already exists." }
      const tmp = `${from}.${randomBytes(4).toString("hex")}.rn`
      try {
        await fs.rename(from, tmp)
        await fs.rename(tmp, to)
      } catch (renameError) {
        await fs.rename(tmp, from).catch(() => {})
        return { error: errorText(renameError) }
      }
      await writeProject(userFolder, next, { ...p, name })
      return { folder: next }
    }
    try {
      await fs.rename(from, to)
    } catch (first) {
      // Windows won't rename a folder over an existing (here: our own, empty) one; free the name and retry.
      // If someone else takes it in between, the second rename fails and nothing is overwritten.
      await fs.rmdir(to).catch(() => {})
      try {
        await fs.rename(from, to)
      } catch {
        return { error: errorText(first) }
      }
    }
  }
  await writeProject(userFolder, next, { ...p, name })
  return { folder: next }
}

export async function deleteProject(userFolder: string, folder: string): Promise<void> {
  const dir = projectDir(userFolder, folder)
  if (!dir) return
  await fs.rm(dir, { recursive: true, force: true })
}

/**
 * Copies a video or image from the Video Editing Inbox into the project's
 * assets/ (never replacing a file); a video is probed, an image gets the
 * default length. The Inbox original stays; its path is kept as `source`.
 */
export async function importAsset(
  userFolder: string,
  folder: string,
  inboxFolder: string[],
  fileName: string
): Promise<{ id: string; asset: Asset } | { error: string }> {
  const dir = projectDir(userFolder, folder)
  if (!dir) return { error: "Invalid project." }
  const kind = mediaKind(fileName)
  if (!isPlainName(fileName) || !kind) return { error: "Not a video or image." }
  const src = resolveInside(rootPath("video-inbox"), [...inboxFolder, fileName])
  if (!src) return { error: "Invalid Inbox folder." }
  const assets = path.join(dir, "assets")
  if (!(await exists(assets))) return { error: "Project not found." }

  // A symlink in the Inbox could point anywhere; copy only a real file that really sits inside the Inbox.
  try {
    const st = await fs.lstat(src)
    if (!st.isFile() || st.isSymbolicLink()) return { error: "Not a media file." }
    const [realRoot, realParent] = await Promise.all([fs.realpath(rootPath("video-inbox")), fs.realpath(path.dirname(src))])
    if (!resolveInside(realRoot, [path.relative(realRoot, realParent)])) return { error: "Invalid Inbox folder." }
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "The file no longer exists." : errorText(error) }
  }

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
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          await fs.rm(target, { force: true })
          throw error
        }
      }
    }
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "The file no longer exists." : error instanceof Error ? error.message : String(error) }
  }
  if (!dest) return { error: "Too many files with that name." }
  const source = [...inboxFolder, fileName].join("/")
  // The id doubles as the media URL's cache key, so it must not repeat.
  const id = `a${randomBytes(8).toString("hex")}`
  if (kind === "image") return { id, asset: { file, duration: DEFAULT_IMAGE, hasAudio: false, kind: "image", source } }

  try {
    const { duration, hasAudio } = await probeMedia(dest)
    if (!(duration >= MIN_CLIP)) {
      await fs.rm(dest, { force: true })
      return { error: "That clip is too short to edit." }
    }
    return { id, asset: { file, duration, hasAudio, source } }
  } catch (error) {
    await fs.rm(dest, { force: true })
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** The first asset copied from this Inbox path whose file is still a regular file in assets/. */
export async function reusableAsset(userFolder: string, folder: string, p: Project, source: string): Promise<{ id: string; asset: Asset } | null> {
  for (const found of findAssetsBySource(p, source)) {
    const file = assetPath(userFolder, folder, found.asset.file)
    if (!file) continue
    try {
      if ((await fs.lstat(file)).isFile()) return found
    } catch {
      continue
    }
  }
  return null
}

export function outputDir(userFolder: string, folder: string): string | null {
  const dir = projectDir(userFolder, folder)
  return dir && path.join(dir, "output")
}

export function assetPath(userFolder: string, folder: string, file: string): string | null {
  const dir = projectDir(userFolder, folder)
  if (!dir || !isPlainName(file)) return null
  return resolveInside(path.join(dir, "assets"), [file])
}
