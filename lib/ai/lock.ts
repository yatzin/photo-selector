import { folderKey } from "@/lib/ai/review"

// A folder an AI scan is reading must not change under it: grouping lists
// and fingerprints its files, and analysis numbers them in a fixed order.
// Only running scans count (lock-server.ts); queued ones don't lock yet.
// A scan reads one folder, so that folder is locked — plus, for a month scan
// (see month-scan.ts), the day folders directly inside it.

export const SCAN_LOCK_MESSAGE = "An AI scan is running on this folder. Wait for it to finish, or cancel it on the AI tab."

export type ActiveScan = { root: string; folder: string; includeDays?: boolean }

export function isFolderLocked(active: ActiveScan[], root: string, segments: string[]): boolean {
  const key = folderKey(segments)
  const parent = folderKey(segments.slice(0, -1))
  return active.some((r) => r.root === root && (r.folder === key || (!!r.includeDays && segments.length > 0 && r.folder === parent)))
}
