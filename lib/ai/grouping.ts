import { colorDistance, hamming, type Fingerprint } from "@/lib/ai/fingerprint"
import type { Similarity } from "@/lib/ai/settings-schema"

// Groups takes of the same moment: photos within the time window whose
// fingerprints are close. Matches chain (A~B and B~C → one group). Starting
// values; tune against real bursts.

export const THRESHOLDS: Record<Similarity, { hash: number; color: number }> = {
  strict: { hash: 6, color: 12 },
  similar: { hash: 12, color: 20 },
  loose: { hash: 18, color: 30 },
}

export type GroupInput = { name: string; takenAt: number; fp: Fingerprint }

export function isSimilar(a: Fingerprint, b: Fingerprint, level: Similarity): boolean {
  const t = THRESHOLDS[level]
  return hamming(a.hash, b.hash) <= t.hash && colorDistance(a.colors, b.colors) <= t.color
}

/** Consecutive chunks of at most `max`; a trailing chunk of 1 joins the previous chunk. */
export function splitGroup<T>(items: T[], max: number): T[][] {
  if (items.length <= max) return [items]
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += max) chunks.push(items.slice(i, i + max))
  if (chunks.length > 1 && chunks[chunks.length - 1].length === 1) {
    const last = chunks.pop()!
    chunks[chunks.length - 1].push(...last)
  }
  return chunks
}

export function groupPhotos(
  photos: GroupInput[],
  opts: { windowSeconds: number; similarity: Similarity; maxGroupSize: number }
): GroupInput[][] {
  const sorted = [...photos].sort((a, b) => a.takenAt - b.takenAt || a.name.localeCompare(b.name))
  const parent = sorted.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const windowMs = opts.windowSeconds * 1000

  for (let i = 1; i < sorted.length; i++) {
    for (let j = i - 1; j >= 0 && sorted[i].takenAt - sorted[j].takenAt <= windowMs; j--) {
      if (isSimilar(sorted[i].fp, sorted[j].fp, opts.similarity)) parent[find(i)] = find(j)
    }
  }

  const byRoot = new Map<number, GroupInput[]>()
  sorted.forEach((photo, i) => {
    const r = find(i)
    byRoot.set(r, [...(byRoot.get(r) ?? []), photo])
  })

  return [...byRoot.values()]
    .filter((g) => g.length >= 2)
    .sort((a, b) => a[0].takenAt - b[0].takenAt)
    .flatMap((g) => splitGroup(g, opts.maxGroupSize))
}
