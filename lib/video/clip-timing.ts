import {
  brokenLinks, clipEnd, clipLength, fixTransitions, isMagnetic, isStill, isTextClip, MAX_CLIPS, MAX_IMAGE, MAX_TIMELINE, MIN_CLIP, packBase, type Clip, type Project,
} from "./project"

/** What happens to other media on the clip's layer that the new range reaches. */
export type TimingMode = "push" | "overwrite"

export type TimingResult = { ok: true; project: Project } | { ok: false; error: string }

/** Clips closer than this count as touching, not overlapping (float rounding), as in project.ts. */
const EPS = 1e-6

const fail = (error: string): TimingResult => ({ ok: false, error })

/** `clip` with `delta` seconds cut off its head (the start moves, a video's source in follows; an image just gets shorter). */
function cutHead(clip: Clip, delta: number, image: boolean): Clip {
  return image ? { ...clip, start: clip.start + delta, out: clip.out - delta } : { ...clip, start: clip.start + delta, in: clip.in + delta }
}

/**
 * Sets a clip's start and length (seconds on the timeline) as one edit of the
 * tracks, from the Edit length dialog. An image (or text) keeps in 0 and gets out =
 * length (MIN_CLIP to MAX_IMAGE); a video keeps its in and may not run past
 * its source. Only the clip's own layer changes.
 *
 * - "push": clips that started at or after the clip's old start, and end
 *   after its new start, all move right by the least that clears the new
 *   range, keeping their gaps; nothing moves left. A new range over an
 *   earlier clip is refused.
 * - "overwrite": clips the new range reaches are trimmed at its edge (a head
 *   cut moves a video's in, so playback stays continuous), split in two when
 *   it sits inside them (the right piece gets `newId()`, the transform and
 *   the mute), or removed when covered; a piece shorter than MIN_CLIP goes.
 *
 * On a snapped base the start can't change (packing sets it) and a length
 * change ripples the clips after it, whatever the mode. Refused (with a
 * message) when anything would end past MAX_TIMELINE, or (LINKED) when it
 * would part two clips joined by a transition or an audio overlap; the others
 * are fitted to their footage (fixTransitions). The same project when nothing changes.
 */
export function setClipTiming(p: Project, clipId: string, timing: { start: number; length: number }, mode: TimingMode, newId: () => string): TimingResult {
  const r = timingEdit(p, clipId, timing, mode, newId)
  if (!r.ok || r.project === p) return r
  // A transition joins two clips side by side: an edit that parts them is refused, and the rest are fitted to their footage.
  if (brokenLinks(p, r.project).length > 0) return fail(LINKED)
  return { ok: true, project: fixTransitions(r.project, p) }
}

/** setClipTiming's refusal when the change would part clips joined by a transition or an audio overlap. */
export const LINKED = "This clip is linked by a transition or audio overlap."

function timingEdit(p: Project, clipId: string, timing: { start: number; length: number }, mode: TimingMode, newId: () => string): TimingResult {
  const track = p.tracks.findIndex((t) => t.clips.some((c) => c.id === clipId))
  if (track < 0) return fail("That clip is gone.")
  const clips = p.tracks[track].clips
  const clip = clips.find((c) => c.id === clipId)!
  const asset = isTextClip(clip) ? undefined : p.assets[clip.asset]
  if (!asset && !isTextClip(clip)) return fail("That clip's media is gone.")
  // A text clip times like an image.
  const image = isStill(p, clip)
  const { start, length } = timing
  if (!Number.isFinite(start) || !Number.isFinite(length)) return fail("Enter numbers.")
  if (start < 0) return fail("Start can't be before 0.")
  if (length < MIN_CLIP - 1e-9) return fail(`Length must be at least ${MIN_CLIP} s.`)
  if (image && length > MAX_IMAGE) return fail(`An image can be at most ${MAX_IMAGE} s long.`)
  if (!image && asset && clip.in + length > asset.duration + EPS) return fail(`This video has only ${(asset.duration - clip.in).toFixed(2)} s left from its start.`)
  const end = start + length
  if (end > MAX_TIMELINE + EPS) return fail("That would end past the timeline's 6 hour limit.")
  if (Math.abs(start - clip.start) < EPS && Math.abs(length - clipLength(clip)) < EPS) return { ok: true, project: p }

  const next: Clip = image ? { ...clip, in: 0, out: length, start } : { ...clip, out: clip.in + length, start }
  const withClips = (list: Clip[]): Project => ({ ...p, tracks: p.tracks.map((t, i) => (i === track ? { ...t, clips: [...list].sort((a, b) => a.start - b.start) } : t)) })

  if (track === 0 && isMagnetic(p)) {
    if (Math.abs(start - clip.start) > EPS) return fail("On a snapped layer 1 the start follows the clips before it.")
    const packed = packBase(withClips(clips.map((c) => (c.id === clipId ? { ...next, start: clip.start } : c))))
    return clipEnd(packed.tracks[0].clips.at(-1)!) > MAX_TIMELINE + EPS ? fail("That would end past the timeline's 6 hour limit.") : { ok: true, project: packed }
  }

  const others = clips.filter((c) => c.id !== clipId)
  const overlaps = (c: Clip) => c.start < end - EPS && start < clipEnd(c) - EPS

  if (mode === "push") {
    const later = others.filter((c) => c.start >= clip.start - EPS && clipEnd(c) > start + EPS)
    if (others.some((c) => !later.includes(c) && overlaps(c))) return fail("It would cover an earlier clip. Choose Overwrite, or a later start.")
    const shift = Math.max(0, ...later.map((c) => end - c.start))
    const moved = others.map((c) => (shift > 0 && later.includes(c) ? { ...c, start: c.start + shift } : c))
    if (moved.some((c) => clipEnd(c) > MAX_TIMELINE + EPS)) return fail("Pushing the later clips would end past the timeline's 6 hour limit.")
    return { ok: true, project: withClips([...moved, next]) }
  }

  const kept: Clip[] = []
  let added = 0
  for (const c of others) {
    if (!overlaps(c)) {
      kept.push(c)
      continue
    }
    // A clip whose media is gone is cut like this one.
    const cImage = isTextClip(c) || p.assets[c.asset] ? isStill(p, c) : image
    const long = (piece: Clip) => clipLength(piece) >= MIN_CLIP - 1e-9
    // The part before the new range: the tail is cut (out moves back for both kinds).
    const left = c.start < start - EPS ? { ...c, out: c.out - (clipEnd(c) - start) } : null
    if (left && long(left)) kept.push(left)
    // The part after it: the head is cut; when the left part stays too, this one is a split piece with a new id.
    const right = clipEnd(c) > end + EPS ? cutHead(c, end - c.start, cImage) : null
    if (right && long(right)) {
      if (left && long(left)) {
        right.id = newId()
        added++
      }
      kept.push(right)
    }
  }
  if (added > 0 && p.tracks.reduce((sum, t) => sum + t.clips.length, 0) + added > MAX_CLIPS) return fail("The project has too many clips to split another.")
  return { ok: true, project: withClips([...kept, next]) }
}
