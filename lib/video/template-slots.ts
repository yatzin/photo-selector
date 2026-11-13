import { allClips, assetKind, AUDIO_TRACK, isTextClip, type Asset, type Clip, type Project } from "./project"
import { MAX_SLOT_LABEL, MAX_SLOTS, type TemplateSlot } from "./template"

// What a template's setup screen and fill panel need from a project.

/** What a slot holds: a picture or video, a sound, or text. */
export type SlotKind = "visual" | "audio" | "text"

export function slotKindOf(p: Project, c: Clip): SlotKind {
  if (isTextClip(c)) return "text"
  const asset = p.assets[c.asset]
  return asset && assetKind(asset) === "audio" ? "audio" : "visual"
}

/** Whether `asset` can be put in a slot of `kind`: a picture or video slot takes an image or a video, a sound slot a sound, a text slot nothing. */
export function acceptsAsset(kind: SlotKind, asset: Asset): boolean {
  if (kind === "text") return false
  return (kind === "audio") === (assetKind(asset) === "audio")
}

export type SlotCandidate = {
  clip: Clip
  /** Its layer (AUDIO_TRACK for the audio layer). */
  track: number
  kind: SlotKind
  /** What it is, for the row: "Video", "Image", "Sound" or "Text". */
  what: string
  /** Replaceable unless it's a sound or a text. */
  defaultReplaceable: boolean
  defaultLabel: string
}

/** Every clip that could be a slot, picture layers bottom to top by time, then the audio layer: with the choices a template starts from. */
export function slotCandidates(p: Project): SlotCandidate[] {
  const rows: { clip: Clip; track: number }[] = [
    ...p.tracks.flatMap((t, track) => t.clips.map((clip) => ({ clip, track }))),
    ...(p.audioTrack?.clips ?? []).map((clip) => ({ clip, track: AUDIO_TRACK })),
  ]
  const counts: Record<string, number> = {}
  return rows
    .filter((r) => r.clip.asset === "" || p.assets[r.clip.asset] !== undefined)
    .map(({ clip, track }) => {
      const kind = slotKindOf(p, clip)
      const asset = isTextClip(clip) ? undefined : p.assets[clip.asset]
      const what = kind === "text" ? "Text" : kind === "audio" ? "Sound" : asset && assetKind(asset) === "image" ? "Image" : "Video"
      counts[what] = (counts[what] ?? 0) + 1
      return { clip, track, kind, what, defaultReplaceable: kind === "visual", defaultLabel: `${what === "Image" ? "Photo" : what} ${counts[what]}` }
    })
}

/**
 * The slots for `marks` (clip id to label): each remembers what the clip holds
 * now (its media, or its text), so a filled slot is one that no longer holds
 * that. Clips that don't exist are skipped; at most MAX_SLOTS.
 */
export function buildSlots(p: Project, marks: Record<string, string>): Record<string, TemplateSlot> {
  const clips = new Map(allClips(p).map((c) => [c.id, c]))
  const out: Record<string, TemplateSlot> = {}
  for (const [id, label] of Object.entries(marks)) {
    const clip = clips.get(id)
    if (!clip || Object.keys(out).length >= MAX_SLOTS) continue
    const name = label.replace(/\s+/g, " ").trim().slice(0, MAX_SLOT_LABEL) || "Slot"
    out[id] = isTextClip(clip) ? { label: name, text: clip.text.content } : { label: name, asset: clip.asset }
  }
  return out
}
