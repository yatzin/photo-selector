import { safeSegments } from "@/lib/media"

// Pure rules for acting on a reviewed group.

/** Find Similar compares photos; Find Screenshots and Quality Checks look at each one on its own. */
export const SCAN_KINDS = ["similar", "screenshots", "quality"] as const
export type ScanKind = (typeof SCAN_KINDS)[number]
export const isScanKind = (v: unknown): v is ScanKind => (SCAN_KINDS as readonly unknown[]).includes(v)

/** Scans that judge images one by one (AiShot rows) rather than in groups. */
export type ShotKind = Exclude<ScanKind, "similar">
export const isShotKind = (v: unknown): v is ShotKind => isScanKind(v) && v !== "similar"

/** Fewest photos a folder needs for a scan: two to compare, or one to check. */
export const minScanImages = (kind: ScanKind) => (isShotKind(kind) ? 1 : MIN_SCAN_IMAGES)

/** A folder needs at least this many photos to have anything to compare. */
export const MIN_SCAN_IMAGES = 2

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

/** Which slice of `total` items page `requested` (1-based, from the URL) shows; out-of-range pages snap to the nearest real one. */
export function pageWindow(total: number, requested: string | undefined, size: number): { page: number; pages: number; skip: number; take: number } {
  const pages = Math.max(1, Math.ceil(total / size))
  const n = Number.parseInt(requested ?? "", 10)
  const page = Number.isFinite(n) ? Math.min(Math.max(n, 1), pages) : 1
  return { page, pages, skip: (page - 1) * size, take: size }
}

/** "Accept all selections": which groups on a page to settle, and with which picks. */
export function acceptAllPlan(groups: { id: string; present: string[]; keep: string[] }[]): { items: { groupId: string; keep: string[] }[]; skipped: number } {
  const items: { groupId: string; keep: string[] }[] = []
  for (const g of groups) {
    const here = new Set(g.present)
    const keep = g.keep.filter((n) => here.has(n))
    if (g.present.length >= 2 && keep.length > 0) items.push({ groupId: g.id, keep })
  }
  return { items, skipped: groups.length - items.length }
}
