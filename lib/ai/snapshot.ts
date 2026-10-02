// The folder as a scan first saw it: every image's name and version. Checked
// again before each AI request, because the in-app lock can't stop Explorer,
// other SMB clients or a phone backup from touching the folder.

export type Snapshot = Record<string, string>
export type SnapshotDiff = { removed: string[]; changed: string[]; added: string[] }

export function diffSnapshot(snapshot: Snapshot, current: Map<string, string>): SnapshotDiff {
  const removed: string[] = []
  const changed: string[] = []
  for (const [name, version] of Object.entries(snapshot)) {
    const now = current.get(name)
    if (now === undefined) removed.push(name)
    else if (now !== version) changed.push(name)
  }
  const added = [...current.keys()].filter((name) => !(name in snapshot))
  return { removed, changed, added }
}

function list(names: string[]): string {
  const shown = names.slice(0, 3).join(", ")
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown
}

/**
 * Why the scan must stop, or null when it can carry on. Photos removed or
 * edited break the grouping and the photo numbering; photos that merely
 * arrived (phone backups) aren't part of this scan and are left alone.
 */
export function describeChange(diff: SnapshotDiff): string | null {
  if (diff.removed.length === 0 && diff.changed.length === 0) return null
  const parts: string[] = []
  if (diff.removed.length) parts.push(`${diff.removed.length} removed (${list(diff.removed)})`)
  if (diff.changed.length) parts.push(`${diff.changed.length} changed (${list(diff.changed)})`)
  return `The folder changed outside the app while scanning: ${parts.join("; ")}. Run the scan again.`
}
