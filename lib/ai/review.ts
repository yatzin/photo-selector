import { safeSegments } from "@/lib/media"

// Pure rules for acting on a reviewed group.

/** Folder string as stored on a run ("a/b", "" = root) → safe segments, or null. */
export function scanFolderSegments(folder: string): string[] | null {
  if (folder === "") return []
  return safeSegments(folder.split("/"))
}

export function folderKey(segments: string[]): string {
  return segments.join("/")
}

/** A photo is safe to act on only if it still exists with the version seen at scan time. */
export function classifyPhotos(stored: { name: string; version: string }[], current: Map<string, string>): { valid: string[]; missing: string[] } {
  const valid: string[] = []
  const missing: string[] = []
  for (const p of stored) (current.get(p.name) === p.version ? valid : missing).push(p.name)
  return { valid, missing }
}

export function planResolution(valid: string[], keep: string[]): { keep: string[]; trash: string[] } | { error: string } {
  const keepSet = new Set(keep)
  const kept = valid.filter((n) => keepSet.has(n))
  if (kept.length === 0) return { error: "Keep at least one photo." }
  return { keep: kept, trash: valid.filter((n) => !keepSet.has(n)) }
}
