import "server-only"
import { randomBytes } from "crypto"
import { constants } from "fs"
import fs from "fs/promises"
import path from "path"
import { rootPath } from "@/lib/library-server"
import { isPlainName, mediaKind, numberedName, projectFolderName, resolveInside } from "@/lib/media"
import { probeMedia } from "./ffmpeg-server"
import { peaksFileName } from "./peaks"
import { allClips, DEFAULT_IMAGE, findAssetsBySource, MIN_CLIP, newProject, parseProject, removeAsset, totalLength, type Asset, type Project } from "./project"
import { withLock } from "./project-lock-server"
import { isExpired } from "./retention"

// Video projects live at <video-projects>/<user>/<project>/ with assets/,
// output/, config/export.json and project.json. Every user-supplied name goes
// through isPlainName/resolveInside, and project names are cleaned into folder
// names, so nothing can step outside the user's folder.

const MAX_NAME_ATTEMPTS = 1000

function userDir(userFolder: string): string | null {
  if (!isPlainName(userFolder)) return null
  return resolveInside(rootPath("video-projects"), [userFolder])
}

/** The project's folder (inside the user's), or null for a name that isn't plain. */
export function projectDir(userFolder: string, folder: string): string | null {
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

/** Bytes of every file under `dir`, all levels down. */
async function dirSize(dir: string): Promise<number> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  const sizes = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return dirSize(full)
      if (!e.isFile()) return 0
      return fs.stat(full).then((st) => st.size, () => 0)
    })
  )
  return sizes.reduce((a, b) => a + b, 0)
}

export type ProjectSummary = { folder: string; name: string; clips: number; modified: number; duration: number; bytes: number }

export async function listProjects(userFolder: string): Promise<ProjectSummary[]> {
  const dir = userDir(userFolder)
  if (!dir) return []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: ProjectSummary[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = await readProject(userFolder, e.name)
    if (!p) continue
    try {
      const st = await fs.stat(path.join(dir, e.name, "project.json"))
      out.push({ folder: e.name, name: p.name, clips: allClips(p).length, modified: st.mtimeMs, duration: totalLength(p), bytes: await dirSize(path.join(dir, e.name)) })
    } catch {
      continue
    }
  }
  return out
}

/**
 * Deletes every project whose project.json hasn't changed for the retention
 * period (lib/video/retention), across all users; returns how many went.
 * Folders without a project.json are left alone; it takes the project's lock
 * and checks the file again before removing, so a save in between keeps it.
 */
export async function cleanExpiredProjects(now = Date.now()): Promise<number> {
  const root = rootPath("video-projects")
  let users
  try {
    users = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let removed = 0
  for (const u of users) {
    if (!u.isDirectory() || !isPlainName(u.name)) continue
    const dir = path.join(root, u.name)
    let projects
    try {
      projects = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of projects) {
      if (!e.isDirectory() || !isPlainName(e.name)) continue
      const file = path.join(dir, e.name, "project.json")
      try {
        if (!isExpired((await fs.stat(file)).mtimeMs, now)) continue
        await withLock(`${u.name}/${e.name}`, async () => {
          // Saved again while waiting for the lock: keep it.
          if (!isExpired((await fs.stat(file)).mtimeMs, now)) return
          await fs.rm(path.join(dir, e.name), { recursive: true, force: true })
          removed++
        })
      } catch {
        continue
      }
    }
  }
  return removed
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
 * Puts a file into `assets` as `fileName`, or the first free numbered name
 * ("clip (1).mp4", lib/media numberedName) when that's taken, never replacing
 * a file: `put(target)` writes it there and must fail with EEXIST when the
 * target exists. The name it got and its path, or `{ error }`.
 */
export async function placeInAssets(assets: string, fileName: string, put: (target: string) => Promise<void>): Promise<{ file: string; dest: string } | { error: string }> {
  try {
    for (let n = 0; n < MAX_NAME_ATTEMPTS; n++) {
      const file = numberedName(fileName, n)
      const target = path.join(assets, file)
      try {
        await put(target)
        return { file, dest: target }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          await fs.rm(target, { force: true })
          throw error
        }
      }
    }
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "The file no longer exists." : errorText(error) }
  }
  return { error: "Too many files with that name." }
}

/** A new asset id. It doubles as the media URL's cache key, so it must not repeat. */
export const newAssetId = () => `a${randomBytes(8).toString("hex")}`

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

  const placed = await placeInAssets(assets, fileName, (target) => fs.copyFile(src, target, constants.COPYFILE_EXCL))
  if ("error" in placed) return placed
  const { file, dest } = placed
  const source = [...inboxFolder, fileName].join("/")
  const id = newAssetId()

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

/**
 * Takes a media item out of the stored project (call it under the project
 * lock): the asset entry, every clip on every track that uses it, and its file
 * in assets/ (with its waveform peaks cache) when no other asset names that file. Removing the file is best
 * effort and only for a regular file (not a link) inside assets/; a failure
 * there still returns ok. An id the project doesn't have changes nothing.
 */
export async function deleteAsset(userFolder: string, folder: string, assetId: string): Promise<{ ok: true; removedClips: number } | { error: string }> {
  const p = await readProject(userFolder, folder)
  if (!p) return { error: "Project not found." }
  if (!Object.hasOwn(p.assets, assetId)) return { ok: true, removedClips: 0 }
  const { file } = p.assets[assetId]
  const { project, removedClips } = removeAsset(p, assetId)
  await writeProject(userFolder, folder, project)
  if (!Object.values(project.assets).some((a) => a.file === file)) {
    const target = assetPath(userFolder, folder, file)
    try {
      if (target && (await fs.lstat(target)).isFile()) await fs.rm(target, { force: true })
    } catch {
      // Already gone, or the OS won't let go of it yet: the project no longer points at it either way.
    }
    const peaks = assetPath(userFolder, folder, peaksFileName(file))
    try {
      if (peaks && (await fs.lstat(peaks)).isFile()) await fs.rm(peaks, { force: true })
    } catch {
      // Never made (no waveform was shown), or already gone.
    }
  }
  return { ok: true, removedClips }
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
