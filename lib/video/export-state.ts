import { createHash } from "crypto"
import { assetKind, type Project } from "./project"

// What the last export was made from. output/.export-state.json names the one
// copy kept in output/ and the fingerprint of the project it was made from, so
// an export with no changes since can hand back that copy instead of rendering.

export type ExportState = { file: string; fingerprint: string; createdAt: number }

export const EXPORT_STATE_FILE = ".export-state.json"

/** JSON with every object's keys sorted, at every depth; undefined values are left out, as JSON.stringify does. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/**
 * SHA-256 (hex) of everything that changes the exported video: size, frame
 * rate, the tracks in order (clips with ids, assets, trims and starts, mute
 * flags) and the file, kind, length and audio of each asset a clip uses. The
 * project's name and unused assets don't count.
 */
export function exportFingerprint(p: Project): string {
  const used = new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.asset)))
  const assets: Record<string, unknown> = {}
  for (const id of used) {
    const a = p.assets[id]
    assets[id] = a ? { file: a.file, kind: assetKind(a), duration: a.duration, hasAudio: a.hasAudio } : null
  }
  const tracks = p.tracks.map((t) => ({
    id: t.id,
    muted: t.muted === true,
    clips: t.clips.map((c) => ({ id: c.id, asset: c.asset, in: c.in, out: c.out, start: c.start })),
  }))
  return createHash("sha256").update(canonical({ width: p.width, height: p.height, fps: p.fps, tracks, assets })).digest("hex")
}
