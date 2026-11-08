import { createHash } from "crypto"
import { allClips, assetKind, isTextClip, type Project, type Track } from "./project"
import { isIdentity, type Transform } from "./transform"

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
 * rate, the tracks in order (clips with ids, assets, trims, starts and
 * transforms, an identity one counting as none and a zero left or right crop
 * as an absent one, as are a zero rotation and a false flip, each clip's mute, a text clip's text, its animations too, a transition and an audio overlap; the audio layer's clips too, when there are any) and the file, kind, length and audio of each
 * asset a clip uses. The project's name and unused assets don't count, so
 * deleting an asset no clip used keeps the kept export.
 */
const transformKey = (t: Transform | undefined) =>
  !t || isIdentity(t)
    ? undefined
    : { ...t, cropLeft: t.cropLeft || undefined, cropRight: t.cropRight || undefined, rotation: t.rotation || undefined, flipH: t.flipH || undefined, flipV: t.flipV || undefined }

export function exportFingerprint(p: Project): string {
  const used = new Set(allClips(p).filter((c) => !isTextClip(c)).map((c) => c.asset))
  const assets: Record<string, unknown> = {}
  for (const id of used) {
    const a = p.assets[id]
    assets[id] = a ? { file: a.file, kind: assetKind(a), duration: a.duration, hasAudio: a.hasAudio } : null
  }
  const trackKey = (t: Track) => ({
    id: t.id,
    clips: t.clips.map((c) => ({
      id: c.id, asset: c.asset, in: c.in, out: c.out, start: c.start, transform: transformKey(c.transform), muted: c.muted === true, text: c.text, transition: c.transition, cutAudio: c.cutAudio,
    })),
  })
  const tracks = p.tracks.map(trackKey)
  // The audio layer counts only when there is one, so a project without audio keeps its fingerprint.
  const audio = p.audioTrack ? { audioTrack: trackKey(p.audioTrack) } : {}
  return createHash("sha256").update(canonical({ width: p.width, height: p.height, fps: p.fps, tracks, ...audio, assets })).digest("hex")
}
