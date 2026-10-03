import "server-only"
import fs from "fs/promises"
import { constants } from "fs"
import path from "path"
import { createTtlCache } from "@/lib/ttl-cache"
import { fileVersion, isSkippedDir, mediaKind, resolveInside, ROOT_KEYS, type MediaKind, type RootKey } from "@/lib/media"

// Reads the photo library from the mounted folders. In the container these are
// /photos/upload and /photos/dropoff (see docker-compose.yml); for local
// development PHOTOS_UPLOAD_DIR / PHOTOS_DROPOFF_DIR can point at the share.

const DEFAULT_ROOTS: Record<RootKey, string> = {
  upload: "/photos/upload",
  dropoff: "/photos/dropoff",
}

const ENV_NAMES: Record<RootKey, string> = {
  upload: "PHOTOS_UPLOAD_DIR",
  dropoff: "PHOTOS_DROPOFF_DIR",
}

export function rootPath(key: RootKey): string {
  return path.resolve(process.env[ENV_NAMES[key]] || DEFAULT_ROOTS[key])
}

export type RootStatus = {
  key: RootKey
  path: string
  envName: string
  readable: boolean
  writable: boolean
}

async function canList(p: string): Promise<boolean> {
  try {
    await (await fs.opendir(p)).close()
    return true
  } catch {
    return false
  }
}

async function canAccess(p: string, mode: number): Promise<boolean> {
  try {
    await fs.access(p, mode)
    return true
  } catch {
    return false
  }
}

export async function rootStatus(key: RootKey): Promise<RootStatus> {
  const p = rootPath(key)
  // "Readable" means the folder can actually be listed. A permission check
  // alone isn't enough: NAS shares controlled by ACLs (UGOS, Synology) can pass
  // access() for a user who is then refused when opening the folder.
  const [readable, writable] = await Promise.all([canList(p), canAccess(p, constants.W_OK)])
  return { key, path: p, envName: ENV_NAMES[key], readable, writable }
}

export function allRootStatuses(): Promise<RootStatus[]> {
  return Promise.all(ROOT_KEYS.map(rootStatus))
}

export type FolderEntry = { name: string; mediaCount: number }
/** `modified` is epoch ms; `version` changes whenever the file does (cache busting). */
export type FileEntry = { name: string; kind: MediaKind; size: number; modified: number; version: string }
export type DirectoryListing = { folders: FolderEntry[]; files: FileEntry[] }

/** Media files under `dir`, all levels down. Names only — no per-file stat. */
async function countMedia(dir: string): Promise<number> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let count = 0
  const subdirs: Promise<number>[] = []
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!isSkippedDir(e.name)) subdirs.push(countMedia(path.join(dir, e.name)))
    } else if (e.isFile() && mediaKind(e.name)) {
      count++
    }
  }
  for (const n of await Promise.all(subdirs)) count += n
  return count
}

/**
 * One level of a library folder: its subfolders (with how many media files
 * each holds, all levels down) and its own media files, newest first.
 * Returns null when the path escapes the root or is not a folder.
 */
export async function listDirectory(key: RootKey, segments: string[]): Promise<DirectoryListing | null> {
  const dir = resolveInside(rootPath(key), segments)
  if (!dir) return null

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }

  const folderNames = entries.filter((e) => e.isDirectory() && !isSkippedDir(e.name)).map((e) => e.name)
  const mediaNames = entries.filter((e) => e.isFile() && mediaKind(e.name)).map((e) => e.name)

  const [folders, files] = await Promise.all([
    Promise.all(folderNames.map(async (name) => ({ name, mediaCount: await countMedia(path.join(dir, name)) }))),
    Promise.all(
      mediaNames.map(async (name): Promise<FileEntry | null> => {
        try {
          const st = await fs.stat(path.join(dir, name))
          return { name, kind: mediaKind(name)!, size: st.size, modified: st.mtimeMs, version: fileVersion(st) }
        } catch {
          return null // removed between readdir and stat
        }
      })
    ),
  ])

  return {
    folders: folders.sort((a, b) => a.name.localeCompare(b.name)),
    files: files.filter((f): f is FileEntry => f !== null).sort((a, b) => b.modified - a.modified),
  }
}

/**
 * Where thumbnails and previews are cached. Deliberately not a generic name
 * like DATA_DIR: other apps set those machine-wide, and a stray one would put
 * the cache inside someone else's data folder.
 */
export function cacheDir(): string {
  return path.resolve(process.env.PHOTOS_CACHE_DIR || "/data/cache")
}

export type ScanFolder = { root: RootKey; folder: string; imageCount: number }

const scanFolderCache = createTtlCache(30_000)

/** Cached briefly: the AI page refreshes every few seconds while a scan runs. */
export function listScanFolders(): Promise<ScanFolder[]> {
  return scanFolderCache.get("all", walkScanFolders)
}

/** Every folder in both roots (depth ≤ 6) with the number of images directly inside, for the AI scan picker. */
async function walkScanFolders(): Promise<ScanFolder[]> {
  const out: ScanFolder[] = []
  async function walk(root: RootKey, segments: string[], depth: number) {
    let entries
    try {
      entries = await fs.readdir(path.join(rootPath(root), ...segments), { withFileTypes: true })
    } catch {
      return
    }
    const imageCount = entries.filter((e) => e.isFile() && mediaKind(e.name) === "image").length
    out.push({ root, folder: segments.join("/"), imageCount })
    if (depth >= 6) return
    for (const e of entries) if (e.isDirectory() && !isSkippedDir(e.name)) await walk(root, [...segments, e.name], depth + 1)
  }
  for (const root of ROOT_KEYS) await walk(root, [], 0)
  return out
}
