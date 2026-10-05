import "server-only"
import { prisma } from "@/lib/prisma"
import { folderKey } from "@/lib/ai/review"
import type { RootKey } from "@/lib/media"

// Quality Checks verdicts shown in the library: photos the AI flagged as bad
// that are still waiting for a decision, in any scan (finished or running).

/**
 * Kept small for folders of thousands of photos: each scan id is listed once,
 * and each flagged photo maps to [index into runs, the AI's note].
 */
export type QualityFlags = { runs: string[]; photos: Record<string, [run: number, note: string | null]> }

/**
 * Flagged photos among `files` (the folder's listing), by name. Only a photo
 * still exactly as scanned counts: one edited since is a different photo. A
 * day folder's photos may come from a scan of its month, stored as "18/IMG_1.jpg".
 */
export async function qualityFlags(root: RootKey, segments: string[], files: { name: string; version: string }[]): Promise<QualityFlags> {
  const out: QualityFlags = { runs: [], photos: {} }
  if (!files.length) return out
  const folder = folderKey(segments)
  const parent = segments.length ? folderKey(segments.slice(0, -1)) : null
  const day = segments.at(-1)
  // One query per folder page, flagged rows only, on the (root, folder, status) index;
  // tiles then look themselves up in a map, so cost doesn't grow with what's on screen.
  const shots = await prisma.aiShot.findMany({
    where: { root, status: "FLAGGED", run: { kind: "quality" }, folder: { in: parent === null ? [folder] : [folder, parent] } },
    select: { runId: true, folder: true, name: true, version: true, note: true },
  })
  const versions = new Map(files.map((f) => [f.name, f.version]))
  const runIndex = new Map<string, number>()
  for (const s of shots) {
    const name = s.folder === folder && !s.name.includes("/") ? s.name : s.folder === parent && s.name.startsWith(`${day}/`) ? s.name.slice(day!.length + 1) : null
    if (!name || name.includes("/") || versions.get(name) !== s.version) continue
    let run = runIndex.get(s.runId)
    if (run === undefined) runIndex.set(s.runId, (run = out.runs.push(s.runId) - 1))
    out.photos[name] = [run, s.note]
  }
  return out
}
