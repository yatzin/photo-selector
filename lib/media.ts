import path from "path"

// Pure helpers for the photo library: which files count as media, which folders
// to skip, and keeping user-supplied paths inside a library root. Nothing here
// touches the disk, so it can be tested directly.

export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".heic", ".heif", ".tif", ".tiff", ".dng"])
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".avi", ".wmv", ".mkv", ".flv", ".3gp", ".webm"])

export type MediaKind = "image" | "video"

export function mediaKind(fileName: string): MediaKind | null {
  const ext = path.extname(fileName).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return "image"
  if (VIDEO_EXTENSIONS.has(ext)) return "video"
  return null
}

/**
 * NAS housekeeping folders (recycle bins, index caches like @eaDir) and hidden
 * folders hold copies or metadata, never photos to sort.
 */
export function isSkippedDir(name: string): boolean {
  return name.startsWith(".") || name.startsWith("@") || name.startsWith("#")
}

/**
 * The library roots, chosen by the short key used in URLs. Mapped from the
 * NAS in docker-compose.yml; locally they can point at the UNC share.
 */
export const ROOT_KEYS = ["upload", "dropoff", "temp"] as const
export type RootKey = (typeof ROOT_KEYS)[number]

export const ROOT_LABELS: Record<RootKey, string> = {
  upload: "Mobile Upload",
  dropoff: "Sort Dropoff",
  temp: "User Temp Storage",
}

export function isRootKey(value: string): value is RootKey {
  return (ROOT_KEYS as readonly string[]).includes(value)
}

/** The roots AI scans can read. User Temp Storage is a staging area, not part of the library to sort. */
export const SCAN_ROOT_KEYS = ["upload", "dropoff"] as const satisfies readonly RootKey[]

export function isScanRoot(value: string): value is (typeof SCAN_ROOT_KEYS)[number] {
  return (SCAN_ROOT_KEYS as readonly string[]).includes(value)
}

/**
 * A user's folder inside User Temp Storage, named after them. Characters no
 * file system accepts are dropped, as is a leading ".", "@" or "#" (folders
 * starting with those are skipped in listings); the email's local part, then
 * "user", stand in when nothing is left.
 */
export function tempFolderName(name: string, email: string): string {
  const clean = (s: string) =>
    s
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[.@#\s]+/, "")
      .replace(/[.\s]+$/, "")
      .slice(0, 80)
  return clean(name) || clean(email.split("@")[0] ?? "") || "user"
}

/**
 * Splits a relative path from a URL into clean segments, or null when any part
 * would step outside the root ("..", absolute paths, drive letters, NUL).
 */
export function safeSegments(segments: string[]): string[] | null {
  const out: string[] = []
  for (const raw of segments) {
    for (const part of raw.split(/[\\/]/)) {
      if (part === "" || part === ".") continue
      if (part === ".." || part.includes("\0") || /^[a-zA-Z]:$/.test(part)) return null
      out.push(part)
    }
  }
  return out
}

/** Absolute path of `segments` under `root`, or null if it would escape it. */
export function resolveInside(root: string, segments: string[]): string | null {
  const clean = safeSegments(segments)
  if (!clean) return null
  const base = path.resolve(root)
  const full = path.resolve(base, ...clean)
  if (full !== base && !full.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) return null
  return full
}

/** "IMG_1.jpg" → "IMG_1 (2).jpg", for when a name is already taken. */
export function numberedName(name: string, n: number): string {
  if (n <= 0) return name
  const ext = path.extname(name)
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`
}

/**
 * Changes whenever the file's content may have: a byte count, the last write,
 * or the inode change time (a lossless rotate keeps size and mtime but bumps
 * ctime). Used in thumbnail cache keys and as a cache-busting URL token.
 */
export function fileVersion(st: { size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}-${Math.floor(st.ctimeMs).toString(36)}`
}

/**
 * Deleted files go here first, inside the same library root so the move is
 * an instant rename. Starts with "." so listings and scans skip it.
 */
export const TRASH_DIR = ".photo-selector-trash"
export const TRASH_RETENTION_DAYS = 30

/** Batch folder names start with the delete time, so age needs no metadata. */
export function trashBatchId(now: number, random: string): string {
  return `${now}-${random.replace(/[^a-z0-9]/gi, "").slice(0, 8)}`
}

export function trashBatchTime(batchId: string): number | null {
  const m = /^(\d{13})-[a-z0-9]{1,8}$/i.exec(batchId)
  return m ? Number(m[1]) : null
}

/** A single file or folder name, as sent by the browser for an action. */
export function isPlainName(name: string): boolean {
  const segs = safeSegments([name])
  return segs !== null && segs.length === 1 && segs[0] === name
}

/** A file name, or one inside a subfolder ("18/IMG_1.jpg", from a month scan), with nothing to step outside the folder. */
export function isPlainPath(name: string): boolean {
  const segs = safeSegments([name])
  return segs !== null && segs.length > 0 && segs.length <= 8 && segs.join("/") === name
}
