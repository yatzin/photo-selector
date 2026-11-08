import {
  adjoins, baseInsertion, clipEnd, cutAudioLimits, endToEnd, isMagnetic, linksBefore, MAX_TIMELINE, resolveStart, trackClipAt, transitionLimits, type Clip, type Project, type Track,
} from "./project"
import { CUT_AUDIO_FADE, isCutAudioMode, isTransitionType, MIN_CUT_AUDIO, MIN_TRANSITION, type CutAudio, type Transition, type TransitionType } from "./transition-types"

export { cutAudioLimits, transitionLimits } from "./project"

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

/**
 * Sets (or with null, removes) the audio overlap at the cut into `clipId`
 * from the clip before it: a J-cut or an L-cut, its duration clamped to
 * MIN_CUT_AUDIO and cutAudioLimits' most for its mode. Independent of the
 * cut's transition. The same project when no clip adjoins it, the mode can't
 * be had there (no sound, no footage), the mode is unknown or nothing changes.
 */
export function setCutAudio(p: Project, clipId: string, spec: CutAudio | null): Project {
  const at = locate(p, clipId)
  if (!at) return p
  const old = at.clip.cutAudio
  if (spec === null) {
    if (!old) return p
    const rest: Clip = { ...at.clip }
    delete rest.cutAudio
    return withClips(p, at.track, p.tracks[at.track].clips.map((c) => (c.id === clipId ? rest : c)))
  }
  if (!isCutAudioMode(spec.mode) || !Number.isFinite(spec.duration)) return p
  const { max } = cutAudioLimits(p, clipId)[spec.mode]
  if (max < MIN_CUT_AUDIO) return p
  const duration = Math.round(Math.max(MIN_CUT_AUDIO, Math.min(max, spec.duration)) * 1000) / 1000
  if (old && old.mode === spec.mode && old.duration === duration) return p
  const cutAudio: CutAudio = { mode: spec.mode, duration }
  return withClips(p, at.track, p.tracks[at.track].clips.map((c) => (c.id === clipId ? { ...c, cutAudio } : c)))
}

/** The clips joined to `clipId` by transitions or audio overlaps, in order along their track (the clip alone when it has none). Empty for an unknown id. */
export function linkedChain(p: Project, clipId: string): string[] {
  const at = locate(p, clipId)
  if (!at) return []
  const clips = p.tracks[at.track].clips
  let first = at.index
  while (first > 0 && linksBefore(clips[first]) && adjoins(clips[first - 1], clips[first])) first--
  let last = at.index
  while (last < clips.length - 1 && linksBefore(clips[last + 1]) && adjoins(clips[last], clips[last + 1])) last++
  return clips.slice(first, last + 1).map((c) => c.id)
}

/** True when a transition or audio overlap joins the clip to the clip before or after it. */
export const isLinked = (p: Project, clipId: string) => linkedChain(p, clipId).length > 1

/** Takes away a cut's transition and audio overlap (`clipId` holds them). */
export const unlinkCut = (p: Project, clipId: string) => setCutAudio(setTransition(p, clipId, null), clipId, null)

/** Takes away the clip's transitions and audio overlaps on both sides (its own, and the next clip's when it comes from this one). */
export function unlinkClip(p: Project, clipId: string): Project {
  const { before, after } = cutsOf(p, clipId)
  let q = p
  if (before) q = unlinkCut(q, before)
  if (after) q = unlinkCut(q, after)
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

/**
 * Where the two clips of a cut both play (the preview's lane runs both
 * videos): the transition's window, widened to take in an audio overlap (a
 * J-cut's lead before the cut, an L-cut's tail after it). `transition` is the
 * picture's blend when it is running at `t` (transitionAt), `audio` the cut's
 * overlap, if any. Outside the transition's window the pictures don't blend:
 * the outgoing one shows before the cut and the incoming one after.
 */
export type OverlapWindow = { from: number; to: number; cut: number; start: number; end: number; transition: TransitionWindow | null; audio: CutAudio | null }

/** How far a cut's overlap reaches before (`lead`) and after (`trail`) it: half its transition, or its J (lead) or L (trail), the longer. */
function reach(c: Clip): { lead: number; trail: number } {
  const half = c.transition ? c.transition.duration / 2 : 0
  const a = c.cutAudio
  return { lead: Math.max(half, a?.mode === "j" ? a.duration : 0), trail: Math.max(half, a?.mode === "l" ? a.duration : 0) }
}

/** The overlap running on `track` at timeline time `t` ([start, end)), or null. */
export function overlapAt(track: Track, t: number): OverlapWindow | null {
  for (let i = 1; i < track.clips.length; i++) {
    const c = track.clips[i]
    if (!linksBefore(c) || !adjoins(track.clips[i - 1], c)) continue
    const { lead, trail } = reach(c)
    const start = c.start - lead
    if (t >= start && t < c.start + trail) {
      return { from: i - 1, to: i, cut: c.start, start, end: c.start + trail, transition: transitionAt(track, t), audio: c.cutAudio ?? null }
    }
    if (start > t) break
  }
  return null
}

/**
 * The clip whose video a track's lane plays as its own at `t`: laneClipAt,
 * except that the incoming clip takes over from the start of its cut's
 * overlap (overlapAt), a J-cut's lead included, while the outgoing one plays
 * on as the lane's tail.
 */
export function laneElementAt(track: Track, t: number): { index: number; start: number; sourceTime: number } | null {
  const w = overlapAt(track, t)
  if (w) {
    const c = track.clips[w.to]
    return { index: w.to, start: c.start, sourceTime: c.in + (t - c.start) }
  }
  return trackClipAt(track, t)
}

/** The source time a clip's video should be waiting at before it plays: its in point, less its overlap's lead (half its transition, or its J-cut) when it has one. */
export function entrySourceTime(track: Track, clip: Clip): number {
  const i = track.clips.indexOf(clip)
  return linksBefore(clip) && i > 0 && adjoins(track.clips[i - 1], clip) ? clip.in - reach(clip).lead : clip.in
}

/**
 * The volumes (0 to 1) of a cut's two clips at `t` inside its overlap: with
 * an audio overlap, the outgoing sound runs to the cut (an L-cut: on for its
 * length, fading out linearly over its last CUT_AUDIO_FADE) and the incoming
 * one from the cut (a J-cut: from its length before, fading in over its first
 * CUT_AUDIO_FADE), each at full volume otherwise (no ducking); with only a
 * transition, an equal-power crossfade over it.
 */
export function cutGains(w: OverlapWindow, t: number): { out: number; in: number } {
  const a = w.audio
  if (!a) {
    const g = ((w.transition?.progress ?? (t < w.cut ? 0 : 1)) * Math.PI) / 2
    return { out: Math.cos(g), in: Math.sin(g) }
  }
  const fade = Math.min(CUT_AUDIO_FADE, a.duration)
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  if (a.mode === "j") return { out: t < w.cut ? 1 : 0, in: t < w.cut - a.duration ? 0 : clamp((t - (w.cut - a.duration)) / fade) }
  return { out: t >= w.cut + a.duration ? 0 : clamp((w.cut + a.duration - t) / fade), in: t >= w.cut ? 1 : 0 }
}
