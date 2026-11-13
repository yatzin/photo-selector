import { allClips, assetKind, clipLength, isTextClip, MAX_IMAGE, type Asset, type Clip, type Project } from "./project"
import { slotKindOf } from "./template-slots"

// A template holds placeholders where its replaceable clips were: an image or a
// silent sound carrying the slot's label, in the clip's place, so a project made
// from the template shows what needs replacing and the original media is not in
// the template at all. Only the media its fixed clips use is kept.

/** The assets the clips outside `slotIds` use: the media a template keeps. */
export function fixedAssetIds(p: Project, slotIds: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const c of allClips(p)) if (!slotIds.has(c.id) && !isTextClip(c)) out.add(c.asset)
  return out
}

/** A placeholder asset entry: an image (a picture or video slot) or a silent sound, titled so Project media and the timeline say what it is. */
export function placeholderAsset(kind: "visual" | "audio", file: string, label: string, seconds: number): Asset {
  return kind === "audio"
    ? { file, duration: seconds, hasAudio: true, kind: "audio", title: `Replace: ${label}`, placeholder: { label } }
    : { file, duration: seconds, hasAudio: false, kind: "image", title: `Replace: ${label}`, placeholder: { label } }
}

/** How long a placeholder for `c` is: an image as long as the clip (at most MAX_IMAGE), a sound as long as the clip. */
export const placeholderLength = (kind: "visual" | "audio", c: Clip): number => (kind === "audio" ? clipLength(c) : Math.min(clipLength(c), MAX_IMAGE))

/**
 * `p` with each slot clip showing its placeholder: `made` maps a slot's clip id
 * to the placeholder asset (id and entry) for a picture, video or sound slot;
 * a text slot's text becomes its label. A clip keeps its place, start,
 * picture placement, effects and transitions; a video or sound becomes an
 * image or silent sound of the same length (a loop is dropped). Assets are cut
 * down to what the other (fixed) clips use plus the placeholders.
 */
export function withPlaceholders(p: Project, labels: Record<string, string>, made: Record<string, { id: string; asset: Asset }>): Project {
  const slotIds = new Set(Object.keys(labels))
  const keep = fixedAssetIds(p, slotIds)
  const assets: Record<string, Asset> = {}
  for (const id of keep) if (Object.hasOwn(p.assets, id)) assets[id] = p.assets[id]
  for (const m of Object.values(made)) assets[m.id] = m.asset
  // A slot that already holds its placeholder keeps it.
  for (const c of allClips(p)) {
    if (slotIds.has(c.id) && !isTextClip(c) && !made[c.id] && Object.hasOwn(p.assets, c.asset)) assets[c.asset] = p.assets[c.asset]
  }
  const swap = (c: Clip): Clip => {
    if (!slotIds.has(c.id)) return c
    if (isTextClip(c)) return { ...c, text: { ...c.text, content: labels[c.id] } }
    const m = made[c.id]
    if (!m) return c
    const kind = assetKind(m.asset) === "audio" ? "audio" : "visual"
    const { loop: _loop, ...rest } = c
    void _loop
    return { ...rest, asset: m.id, in: 0, out: Math.min(placeholderLength(kind, c), m.asset.duration) }
  }
  return {
    ...p,
    assets,
    tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map(swap) })),
    ...(p.audioTrack ? { audioTrack: { ...p.audioTrack, clips: p.audioTrack.clips.map(swap) } } : {}),
  }
}

/** Which slot clips need a placeholder made: the picture, video and sound ones (a text slot just takes its label), unless the clip already holds a placeholder with this label. */
export function slotsNeedingPlaceholders(p: Project, labels: Record<string, string>): { id: string; kind: "visual" | "audio"; label: string }[] {
  const clips = new Map(allClips(p).map((c) => [c.id, c]))
  const out: { id: string; kind: "visual" | "audio"; label: string }[] = []
  for (const [id, label] of Object.entries(labels)) {
    const clip = clips.get(id)
    if (!clip || isTextClip(clip)) continue
    const current = p.assets[clip.asset]
    if (current?.placeholder?.label === label) continue
    const kind = slotKindOf(p, clip)
    if (kind === "text") continue
    out.push({ id, kind, label })
  }
  return out
}
