import {
  adjoins, baseInsertion, clipEnd, endToEnd, isMagnetic, MAX_TIMELINE, resolveStart, trackClipAt, transitionLimits, type Clip, type Project, type Track,
} from "./project"
import { isTransitionType, MIN_TRANSITION, type Transition, type TransitionType } from "./transition-types"

export { transitionLimits } from "./project"

// Transitions between adjoining clips on one track (the model is Clip.transition
// in project.ts: stored on the later clip, centred on the cut). This holds the
// catalogue the dialog shows and the edits the timeline makes with them.

export type TransitionGroup = "Fade" | "Wipe" | "Slide" | "Shape" | "Effect"

export const TRANSITION_INFO: Record<TransitionType, { name: string; group: TransitionGroup }> = {
  fade: { name: "Crossfade", group: "Fade" },
  fadeblack: { name: "Fade through black", group: "Fade" },
  fadewhite: { name: "Fade through white", group: "Fade" },
  wipeleft: { name: "Wipe left", group: "Wipe" },
  wiperight: { name: "Wipe right", group: "Wipe" },
  wipeup: { name: "Wipe up", group: "Wipe" },
  wipedown: { name: "Wipe down", group: "Wipe" },
  slideleft: { name: "Slide left", group: "Slide" },
  slideright: { name: "Slide right", group: "Slide" },
  slideup: { name: "Slide up", group: "Slide" },
  slidedown: { name: "Slide down", group: "Slide" },
  circleopen: { name: "Circle open", group: "Shape" },
  circleclose: { name: "Circle close", group: "Shape" },
  radial: { name: "Radial", group: "Shape" },
  pixelize: { name: "Pixelate", group: "Effect" },
  dissolve: { name: "Dissolve", group: "Effect" },
  zoomin: { name: "Zoom in", group: "Effect" },
  hblur: { name: "Blur", group: "Effect" },
}

export const TRANSITION_GROUPS: TransitionGroup[] = ["Fade", "Wipe", "Slide", "Shape", "Effect"]

export const transitionName = (t: TransitionType) => TRANSITION_INFO[t].name

function locate(p: Project, id: string): { track: number; index: number; clip: Clip } | null {
  for (let track = 0; track < p.tracks.length; track++) {
    const index = p.tracks[track].clips.findIndex((c) => c.id === id)
    if (index >= 0) return { track, index, clip: p.tracks[track].clips[index] }
  }
  return null
}

const withClips = (p: Project, track: number, clips: Clip[]): Project => ({ ...p, tracks: p.tracks.map((t, i) => (i === track ? { ...t, clips } : t)) })

/**
 * The two cuts of a clip: `before`, the id of the clip whose transition joins
 * this one to the clip before it (this clip's own id), when one adjoins it;
 * `after`, the next clip's id, when it adjoins. Null where nothing adjoins.
 */
export function cutsOf(p: Project, clipId: string): { before: string | null; after: string | null } {
  const at = locate(p, clipId)
  if (!at) return { before: null, after: null }
  const clips = p.tracks[at.track].clips
  const next = clips[at.index + 1]
  return { before: adjoins(clips[at.index - 1], at.clip) ? at.clip.id : null, after: adjoins(at.clip, next) ? next.id : null }
}

/**
 * Sets (or with null, removes) the transition into `clipId` from the clip
 * before it. The duration is clamped to MIN_TRANSITION and transitionLimits'
 * most; the same project when no clip adjoins it, the footage has no room,
 * the type is unknown or nothing changes.
 */
export function setTransition(p: Project, clipId: string, spec: Transition | null): Project {
  const at = locate(p, clipId)
  if (!at) return p
  const old = at.clip.transition
  if (spec === null) {
    if (!old) return p
    const rest: Clip = { ...at.clip }
    delete rest.transition
    return withClips(p, at.track, p.tracks[at.track].clips.map((c) => (c.id === clipId ? rest : c)))
  }
  const { max } = transitionLimits(p, clipId)
  if (!isTransitionType(spec.type) || !Number.isFinite(spec.duration) || max < MIN_TRANSITION) return p
  const duration = Math.round(Math.max(MIN_TRANSITION, Math.min(max, spec.duration)) * 1000) / 1000
  if (old && old.type === spec.type && old.duration === duration) return p
  const transition: Transition = { type: spec.type, duration }
  return withClips(p, at.track, p.tracks[at.track].clips.map((c) => (c.id === clipId ? { ...c, transition } : c)))
}

/** The clips joined to `clipId` by transitions, in order along their track (the clip alone when it has none). Empty for an unknown id. */
export function linkedChain(p: Project, clipId: string): string[] {
  const at = locate(p, clipId)
  if (!at) return []
  const clips = p.tracks[at.track].clips
  let first = at.index
  while (first > 0 && clips[first].transition && adjoins(clips[first - 1], clips[first])) first--
  let last = at.index
  while (last < clips.length - 1 && clips[last + 1].transition && adjoins(clips[last], clips[last + 1])) last++
  return clips.slice(first, last + 1).map((c) => c.id)
}

/** True when a transition joins the clip to the clip before or after it. */
export const isLinked = (p: Project, clipId: string) => linkedChain(p, clipId).length > 1

/** Takes away the clip's transitions on both sides (its own, and the next clip's when it comes from this one). */
export function unlinkClip(p: Project, clipId: string): Project {
  const { before, after } = cutsOf(p, clipId)
  let q = p
  if (before) q = setTransition(q, before, null)
  if (after) q = setTransition(q, after, null)
  return q
}

/**
 * Moves the whole chain of linked clips around `clipId` along its track as
 * one block, its first clip to `start` (slid clear of the other clips there,
 * as a moved clip is). On a snapped base the block goes in at the slot
 * `start` picks (baseInsertion) and the base packs again. The same project
 * when it can't (past MAX_TIMELINE) or nothing moves.
 */
export function moveGroup(p: Project, clipId: string, start: number): Project {
  const ids = new Set(linkedChain(p, clipId))
  const at = locate(p, clipId)
  if (!at || !Number.isFinite(start)) return p
  const clips = p.tracks[at.track].clips
  const group = clips.filter((c) => ids.has(c.id))
  const others = clips.filter((c) => !ids.has(c.id))
  const first = group[0]
  const length = clipEnd(group[group.length - 1]) - first.start
  if (at.track === 0 && isMagnetic(p)) {
    const slot = baseInsertion(others, start).index
    const packed = endToEnd([...others.slice(0, slot), ...group, ...others.slice(slot)])
    if (packed.length > 0 && clipEnd(packed[packed.length - 1]) > MAX_TIMELINE + 1e-6) return p
    return packed.every((c, i) => c.id === clips[i].id && c.start === clips[i].start) ? p : withClips(p, at.track, packed)
  }
  const to = resolveStart(others, length, start)
  if (to + length > MAX_TIMELINE + 1e-6) return p
  const delta = to - first.start
  if (Math.abs(delta) < 1e-9) return p
  const moved = group.map((c) => ({ ...c, start: c.start + delta }))
  return withClips(p, at.track, [...others, ...moved].sort((a, b) => a.start - b.start))
}

/** A transition running on a track at some time: the outgoing clip's index (`from`), the incoming one's (`to`), the cut and how far through it is (0 to 1). */
export type TransitionWindow = { from: number; to: number; cut: number; duration: number; type: TransitionType; progress: number }

/** The transition running on `track` at timeline time `t` ([cut - d/2, cut + d/2)), or null. */
export function transitionAt(track: Track, t: number): TransitionWindow | null {
  for (let i = 1; i < track.clips.length; i++) {
    const c = track.clips[i]
    if (!c.transition || !adjoins(track.clips[i - 1], c)) continue
    const d = c.transition.duration
    const from = c.start - d / 2
    if (t >= from && t < c.start + d / 2) return { from: i - 1, to: i, cut: c.start, duration: d, type: c.transition.type, progress: Math.min(1, Math.max(0, (t - from) / d)) }
    if (c.start - d / 2 > t) break
  }
  return null
}

/**
 * The clip a track shows at `t`, as trackClipAt, except that through a
 * transition the incoming clip already shows from the window's start (its
 * source time before its in point then): the outgoing one plays on under it
 * (transitionAt says which and how far).
 */
export function laneClipAt(track: Track, t: number): { index: number; start: number; sourceTime: number } | null {
  const w = transitionAt(track, t)
  if (w) {
    const c = track.clips[w.to]
    return { index: w.to, start: c.start, sourceTime: c.in + (t - c.start) }
  }
  return trackClipAt(track, t)
}

/** Where the outgoing clip of a running transition is in its source at `t` (past its out point after the cut). */
export const tailSourceTime = (track: Track, w: TransitionWindow, t: number) => {
  const c = track.clips[w.from]
  return c.in + (t - c.start)
}

/** The source time a clip's video should be waiting at before it shows: its in point, less half its transition's length when it has one. */
export function entrySourceTime(track: Track, clip: Clip): number {
  const i = track.clips.indexOf(clip)
  return clip.transition && i > 0 && adjoins(track.clips[i - 1], clip) ? clip.in - clip.transition.duration / 2 : clip.in
}
