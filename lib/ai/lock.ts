import { folderKey } from "@/lib/ai/review"

// A folder an AI scan is reading must not change under it: grouping lists
// and fingerprints its files, and analysis numbers them in a fixed order.
// Scans read one folder only, so only that exact folder is locked.

export const SCAN_LOCK_MESSAGE = "An AI scan is running on this folder. Wait for it to finish, or cancel it on the AI tab."

export function isFolderLocked(active: { root: string; folder: string }[], root: string, segments: string[]): boolean {
  const key = folderKey(segments)
  return active.some((r) => r.root === root && r.folder === key)
}
