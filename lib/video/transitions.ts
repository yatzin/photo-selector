import {
  addTrack, adjoins, AUDIO_TRACK, baseInsertion, clipEnd, clipLength, cutReach, endToEnd, fixEdges, fixTransitions, hasSound, headHandle, isAudioClip, isLooping, isMagnetic, isStill, isTextClip, linksBefore, MAX_TIMELINE, MIN_CLIP,
  resolveStart, tailHandle, trackAt, trackClipAt, transitionFits, withTrack, zoomCutLimits,
  type Clip, type Project, type Track,
} from "./project"
import {
  CUT_AUDIO_FADE, isCutAudioMode, isEdgeType, isZoomFullTransition, MAX_CUT_AUDIO, MAX_EDGE, MAX_TRANSITION, MIN_CUT_AUDIO, MIN_EDGE, MIN_TRANSITION,
  type AnyTransitionType, type AudioTransitionType, type CutAudio, type Edge, type EdgeTransition, type Transition, type TransitionType,
} from "./transition-types"

export { cutAudioLimits, transitionLimits, zoomCutLimits } from "./project"

// Transitions between adjoining clips on one track (the model is Clip.transition
// in project.ts: stored on the later clip, centred on the cut). This holds the
// catalogue the dialog shows and the edits the timeline makes with them.

export type TransitionGroup = "Fade" | "Wipe" | "Slide" | "Shape" | "Effect" | "Zoom" | "Creative" | "Glitch and whip"

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
  collage: { name: "Collage", group: "Creative" },
  exchange: { name: "Exchange", group: "Creative" },
  pageturn: { name: "Page turn", group: "Creative" },
  reveal: { name: "Reveal", group: "Creative" },
  heart: { name: "Heart", group: "Creative" },
  glitch: { name: "Glitch", group: "Glitch and whip" },
  glitchreveal: { name: "Glitch reveal", group: "Glitch and whip" },
  "whip-left": { name: "Whip left", group: "Glitch and whip" },
  "whip-right": { name: "Whip right", group: "Glitch and whip" },
  "whip-up": { name: "Whip up", group: "Glitch and whip" },
  "whip-down": { name: "Whip down", group: "Glitch and whip" },
  zoomfromfull: { name: "Zoom from full screen", group: "Zoom" },
  zoomtofull: { name: "Zoom to full screen", group: "Zoom" },
}

export const TRANSITION_GROUPS: TransitionGroup[] = ["Fade", "Wipe", "Slide", "Shape", "Effect", "Zoom", "Creative", "Glitch and whip"]

/** The audio layer's transitions, as the dialog groups them. */
export type AudioTransitionGroup = "Crossfade curves" | "Creative"

export const AUDIO_TRANSITION_INFO: Record<AudioTransitionType, { name: string; group: AudioTransitionGroup }> = {
  "audio-linear": { name: "Linear", group: "Crossfade curves" },
  "audio-equalpower": { name: "Equal power", group: "Crossfade curves" },
  "audio-scurve": { name: "S-curve", group: "Crossfade curves" },
  "audio-log": { name: "Logarithmic", group: "Crossfade curves" },
  "audio-exp": { name: "Exponential", group: "Crossfade curves" },
  "audio-dip": { name: "Dip to silence", group: "Crossfade curves" },
  "audio-lowpass": { name: "Low-pass sweep", group: "Creative" },
  "audio-tapestop": { name: "Tape stop", group: "Creative" },
  "audio-echo": { name: "Echo out", group: "Creative" },
  "audio-telephone": { name: "Telephone swap", group: "Creative" },
}

export const AUDIO_TRANSITION_GROUPS: AudioTransitionGroup[] = ["Crossfade curves", "Creative"]

/** The audio transition a new cut between audio clips gets. */
export const DEFAULT_AUDIO_TRANSITION: AudioTransitionType = "audio-equalpower"

/** A transition's name, picture or audio. */
export const transitionName = (t: AnyTransitionType) => (t in TRANSITION_INFO ? TRANSITION_INFO[t as TransitionType].name : AUDIO_TRANSITION_INFO[t as AudioTransitionType].name)

/** A transition's name at a free edge: an audio tape stop starts the sound at an in edge, a fade is a fade. */
export function edgeTransitionName(t: AnyTransitionType, edge: Edge): string {
  if (t === "audio-tapestop") return edge === "in" ? "Tape start" : "Tape stop"
  if (t === "audio-echo") return "Echo tail"
  if (t === "audio-lowpass") return edge === "in" ? "Low-pass sweep in" : "Low-pass sweep out"
  if (t in AUDIO_TRANSITION_INFO) return `Fade ${edge}, ${transitionName(t).toLowerCase()}`
  return transitionName(t)
}

/** Where clip `id` is: its track (AUDIO_TRACK for the audio layer), index and the clip. */
function locate(p: Project, id: string): { track: number; index: number; clip: Clip } | null {
  for (let track = 0; track < p.tracks.length; track++) {
    const index = p.tracks[track].clips.findIndex((c) => c.id === id)
    if (index >= 0) return { track, index, clip: p.tracks[track].clips[index] }
  }
  const index = p.audioTrack ? p.audioTrack.clips.findIndex((c) => c.id === id) : -1
  return index >= 0 ? { track: AUDIO_TRACK, index, clip: p.audioTrack!.clips[index] } : null
}

const withClips = withTrack

/**
 * The two cuts of a clip: `before`, the id of the clip whose transition joins
 * this one to the clip before it (this clip's own id), when one adjoins it;
 * `after`, the next clip's id, when it adjoins. Null where nothing adjoins.
 */
export function cutsOf(p: Project, clipId: string): { before: string | null; after: string | null } {
  const at = locate(p, clipId)
  if (!at) return { before: null, after: null }
  const clips = trackAt(p, at.track)!.clips
  const next = clips[at.index + 1]
  return { before: adjoins(clips[at.index - 1], at.clip) ? at.clip.id : null, after: adjoins(at.clip, next) ? next.id : null }
}

/**
 * Automatic trimming. A cut's overlap needs footage beyond the two clips (the
 * outgoing clip's past its out point, the incoming clip's before its in
 * point; a still has any amount): half a transition each side, a J-cut's
 * length before the incoming clip, an L-cut's after the outgoing one. Where a
 * clip is short of it by `s`, the plan trims `s` off that end (the outgoing
 * clip's out moves earlier, the incoming clip's in later), so the trimmed
 * footage becomes the missing handle. The incoming clip keeps starting where
 * the outgoing one now ends (the cut moves earlier by the outgoing trim) and
 * every later clip on that layer moves earlier by both trims (a ripple; on a
 * snapped base, the same as packing it again); other layers stay put. What
 * limits the length is the clips themselves: after its trim, each clip has to
 * hold the overlap's reach into it beside its other cut's (cutReach) and stay
 * MIN_CLIP long. Trims are never given back (a shorter overlap keeps them).
 */

/** What a cut's overlap would be: half its transition, its J-cut and its L-cut (0: none). */
type CutShape = { half: number; j: number; l: number }

type CutContext = {
  track: number; index: number; clips: Clip[]; prev: Clip; clip: Clip
  /** Spare footage past the outgoing clip's out and before the incoming clip's in (a still: Infinity; a missing file: 0, and no trim makes more). */
  tail: number; head: number; trimOut: boolean; trimIn: boolean
  /** Either clip loops: a looping clip takes no transition or audio overlap on either side (reason "loop"). */
  loop: boolean
  /** The clips' lengths, and how much their other cuts take of them. */
  outLength: number; inLength: number; otherOut: number; otherIn: number
}

function cutContext(p: Project, clipId: string): CutContext | null {
  const at = locate(p, clipId)
  if (!at) return null
  const clips = trackAt(p, at.track)!.clips
  const prev = clips[at.index - 1]
  if (!prev || !adjoins(prev, at.clip)) return null
  const has = (c: Clip) => isStill(p, c) || Object.hasOwn(p.assets, c.asset)
  return {
    track: at.track, index: at.index, clips, prev, clip: at.clip,
    tail: tailHandle(p, prev), head: headHandle(p, at.clip), trimOut: has(prev), trimIn: has(at.clip),
    loop: isLooping(p, prev) || isLooping(p, at.clip),
    outLength: clipLength(prev), inLength: clipLength(at.clip), otherOut: cutReach(clips, at.index - 1).trail, otherIn: cutReach(clips, at.index + 1).lead,
  }
}

/** Seconds up to the next millisecond (0 for nothing or less). */
const ceilMs = (s: number) => (s > 1e-9 ? Math.ceil(s * 1000 - 1e-6) / 1000 : 0)
const clean = (s: number) => Math.round(s * 1e6) / 1e6

/** The trims a cut's shape needs: off the outgoing clip's end and the incoming clip's start. */
function trimsFor(x: CutContext, s: CutShape): { out: number; in: number } {
  return { out: ceilMs(Math.max(s.half, s.l) - x.tail), in: ceilMs(Math.max(s.half, s.j) - x.head) }
}

/** Whether the outgoing (`"out"`) or incoming clip can take the shape, trimmed as it needs. */
function fits(x: CutContext, s: CutShape, side: "out" | "in"): boolean {
  const t = trimsFor(x, s)
  if (side === "out") return (t.out === 0 || x.trimOut) && x.outLength - t.out >= Math.max(MIN_CLIP, Math.max(s.half, s.j) + x.otherOut) - 1e-9
  return (t.in === 0 || x.trimIn) && x.inLength - t.in >= Math.max(MIN_CLIP, Math.max(s.half, s.l) + x.otherIn) - 1e-9
}

/**
 * How long a cut's overlap may be, `shape(d)` giving its shape at length d
 * (from `min` to `cap`): the longest whole millisecond both clips can take,
 * and which one stops it ("cap" when neither does). 0 when even `min` won't fit.
 */
function longest(x: CutContext, shape: (d: number) => CutShape, min: number, cap: number): { max: number; limit: CutRange["limit"] } {
  const most = (side: "out" | "in") => {
    let lo = Math.round(min * 1000)
    let hi = Math.round(cap * 1000)
    if (!fits(x, shape(lo / 1000), side)) return 0
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (fits(x, shape(mid / 1000), side)) lo = mid
      else hi = mid - 1
    }
    return lo / 1000
  }
  const out = most("out")
  const inn = most("in")
  const max = Math.min(out, inn)
  return { max, limit: max >= cap - 1e-9 ? "cap" : out <= inn ? "outgoing" : "incoming" }
}

/**
 * How long a transition or audio overlap at a cut may be once trimming is
 * allowed: `max` (0 when it can't be had, with the reason), which clip stops
 * it ("cap": MAX_TRANSITION or MAX_CUT_AUDIO does) and the two clips' lengths.
 */
export type CutRange = {
  max: number
  /** "loop": either clip loops (a looping clip takes no transition or audio overlap on either side). */
  reason: "ok" | "not-adjoining" | "no-audio" | "too-short" | "loop"
  limit: "cap" | "outgoing" | "incoming" | null
  lengths: { outgoing: number; incoming: number }
}

/** The trims a plan makes: off the outgoing clip's end, the incoming clip's start, and how far later clips on the layer move back (their sum). */
export type CutTrims = { outgoing: number; incoming: number; ripple: number }

/** An edit at a cut with the trims it takes (CutTrims), or why it can't be had. */
export type CutPlan = { ok: true; project: Project; duration: number; trims: CutTrims } | { ok: false; reason: Exclude<CutRange["reason"], "ok"> }

// A zoom cut has no overlap, so its half is 0.
const shapeOf = (c: Clip): CutShape => ({ half: c.transition && !isZoomFullTransition(c.transition.type) ? c.transition.duration / 2 : 0, j: c.cutAudio?.mode === "j" ? c.cutAudio.duration : 0, l: c.cutAudio?.mode === "l" ? c.cutAudio.duration : 0 })

const noRange = (reason: CutRange["reason"], x: CutContext | null): CutRange => ({ max: 0, reason, limit: null, lengths: { outgoing: x?.outLength ?? 0, incoming: x?.inLength ?? 0 } })

/** How long the transition into `clipId` may be (with its audio overlap as it is), trimming the clips as it needs. */
export function transitionRange(p: Project, clipId: string): CutRange {
  const x = cutContext(p, clipId)
  if (!x) return noRange("not-adjoining", null)
  if (x.loop) return noRange("loop", x)
  const base = shapeOf(x.clip)
  const { max, limit } = longest(x, (d) => ({ ...base, half: d / 2 }), MIN_TRANSITION, MAX_TRANSITION)
  return max < MIN_TRANSITION - 1e-9 ? noRange("too-short", x) : { max, reason: "ok", limit, lengths: { outgoing: x.outLength, incoming: x.inLength } }
}

/** How long a zoom cut into `clipId` may be, as a CutRange (it runs inside one clip, so nothing is trimmed: zoomCutLimits). */
export function zoomCutRange(p: Project, clipId: string, type: "zoomfromfull" | "zoomtofull"): CutRange {
  const x = cutContext(p, clipId)
  const limits = zoomCutLimits(p, clipId, type)
  if (limits.reason === "not-adjoining" || !x) return noRange("not-adjoining", x)
  return limits.reason === "ok"
    ? { max: limits.max, reason: "ok", limit: limits.max >= MAX_TRANSITION - 1e-9 ? "cap" : type === "zoomfromfull" ? "incoming" : "outgoing", lengths: { outgoing: x.outLength, incoming: x.inLength } }
    : noRange("too-short", x)
}

/** How long a J-cut or an L-cut at the cut into `clipId` may be (with its transition as it is), trimming the clips as it needs. */
export function cutAudioRange(p: Project, clipId: string): Record<CutAudio["mode"], CutRange> {
  const x = cutContext(p, clipId)
  // The audio layer's clips have no picture for the sound to lead or trail.
  if (!x || x.track === AUDIO_TRACK) return { j: noRange("not-adjoining", null), l: noRange("not-adjoining", null) }
  if (x.loop) return { j: noRange("loop", x), l: noRange("loop", x) }
  const half = x.clip.transition && !isZoomFullTransition(x.clip.transition.type) ? x.clip.transition.duration / 2 : 0
  const range = (mode: CutAudio["mode"]): CutRange => {
    if (!hasSound(p, mode === "j" ? x.clip : x.prev)) return noRange("no-audio", x)
    const { max, limit } = longest(x, (d) => ({ half, j: mode === "j" ? d : 0, l: mode === "l" ? d : 0 }), MIN_CUT_AUDIO, MAX_CUT_AUDIO)
    return max < MIN_CUT_AUDIO - 1e-9 ? noRange("too-short", x) : { max, reason: "ok", limit, lengths: { outgoing: x.outLength, incoming: x.inLength } }
  }
  return { j: range("j"), l: range("l") }
}

/** The cut's clips trimmed for `shape` and the layer rippled, the incoming clip changed by `set`. */
function planned(p: Project, x: CutContext, shape: CutShape, set: (c: Clip) => Clip): { project: Project; trims: CutTrims } {
  const t = trimsFor(x, shape)
  const ripple = clean(t.out + t.in)
  const cut = clean(x.prev.start + x.outLength - t.out)
  const clips = x.clips.map((c, i) => {
    if (i === x.index - 1) return t.out > 0 ? { ...c, out: clean(c.out - t.out) } : c
    if (i === x.index) return set(t.in > 0 || t.out > 0 ? { ...c, in: clean(c.in + t.in), start: cut } : c)
    return i > x.index && ripple > 0 ? { ...c, start: clean(c.start - ripple) } : c
  })
  return { project: fixTransitions(withClips(p, x.track, clips), p), trims: { outgoing: t.out, incoming: t.in, ripple } }
}

/** The transition into `clipId` set to `spec` (its duration clamped to transitionRange), with the trims it takes. */
export function transitionPlan(p: Project, clipId: string, spec: Transition): CutPlan {
  const range = transitionRange(p, clipId)
  const x = cutContext(p, clipId)
  if (range.reason !== "ok" || !x) return { ok: false, reason: range.reason === "ok" ? "not-adjoining" : range.reason }
  const duration = Math.round(Math.max(MIN_TRANSITION, Math.min(range.max, spec.duration)) * 1000) / 1000
  const transition: Transition = { type: spec.type, duration }
  return { ok: true, duration, ...planned(p, x, { ...shapeOf(x.clip), half: duration / 2 }, (c) => ({ ...c, transition })) }
}

/** The audio overlap at the cut into `clipId` set to `spec` (its duration clamped to cutAudioRange), with the trims it takes. */
export function cutAudioPlan(p: Project, clipId: string, spec: CutAudio): CutPlan {
  const range = cutAudioRange(p, clipId)[spec.mode]
  const x = cutContext(p, clipId)
  if (range.reason !== "ok" || !x) return { ok: false, reason: range.reason === "ok" ? "not-adjoining" : range.reason }
  const duration = Math.round(Math.max(MIN_CUT_AUDIO, Math.min(range.max, spec.duration)) * 1000) / 1000
  const cutAudio: CutAudio = { mode: spec.mode, duration }
  const shape = { ...shapeOf(x.clip), j: spec.mode === "j" ? duration : 0, l: spec.mode === "l" ? duration : 0 }
  return { ok: true, duration, ...planned(p, x, shape, (c) => ({ ...c, cutAudio })) }
}

/**
 * Sets (or with null, removes) the transition into `clipId` from the clip
 * before it (transitionPlan: the duration clamped to MIN_TRANSITION and
 * transitionRange's most, the clips trimmed where they lack the footage and
 * the layer rippled). The same project when no clip adjoins it, the type is
 * unknown or of the other family (lib/video/project transitionFits) or
 * nothing changes.
 */
export function setTransition(p: Project, clipId: string, spec: Transition | null): Project {
  const at = locate(p, clipId)
  if (!at) return p
  const old = at.clip.transition
  if (spec === null) {
    if (!old) return p
    const rest: Clip = { ...at.clip }
    delete rest.transition
    return withClips(p, at.track, trackAt(p, at.track)!.clips.map((c) => (c.id === clipId ? rest : c)))
  }
  // The family must suit the clip: an audio type between audio clips, a picture type between any others.
  if (!transitionFits(p, at.clip, spec.type) || !Number.isFinite(spec.duration)) return p
  // A zoom cut runs inside one clip: no footage to find, nothing trimmed or moved.
  if (isZoomFullTransition(spec.type)) {
    const limits = zoomCutLimits(p, clipId, spec.type)
    if (limits.reason !== "ok") return p
    const duration = Math.round(Math.max(MIN_TRANSITION, Math.min(limits.max, spec.duration)) * 1000) / 1000
    if (old && old.type === spec.type && old.duration === duration) return p
    return withClips(p, at.track, trackAt(p, at.track)!.clips.map((c) => (c.id === clipId ? { ...c, transition: { type: spec.type, duration } } : c)))
  }
  const plan = transitionPlan(p, clipId, spec)
  if (!plan.ok) return p
  if (old && old.type === spec.type && old.duration === plan.duration && plan.trims.ripple === 0) return p
  return plan.project
}

/**
 * Sets (or with null, removes) the audio overlap at the cut into `clipId`
 * from the clip before it: a J-cut or an L-cut (cutAudioPlan: its duration
 * clamped to MIN_CUT_AUDIO and cutAudioRange's most for its mode, the clips
 * trimmed where they lack the footage and the layer rippled). Independent of
 * the cut's transition. The same project when no clip adjoins it, the mode
 * can't be had there (no sound), the mode is unknown or nothing changes.
 */
export function setCutAudio(p: Project, clipId: string, spec: CutAudio | null): Project {
  const at = locate(p, clipId)
  if (!at) return p
  const old = at.clip.cutAudio
  if (spec === null) {
    if (!old) return p
    const rest: Clip = { ...at.clip }
    delete rest.cutAudio
    return withClips(p, at.track, trackAt(p, at.track)!.clips.map((c) => (c.id === clipId ? rest : c)))
  }
  if (!isCutAudioMode(spec.mode) || !Number.isFinite(spec.duration)) return p
  const plan = cutAudioPlan(p, clipId, spec)
  if (!plan.ok) return p
  if (old && old.mode === spec.mode && old.duration === plan.duration && plan.trims.ripple === 0) return p
  return plan.project
}

/**
 * The Transition dialog's edit of a cut, one undo step: the audio overlap
 * taken off, the transition set (or removed), then the overlap set (or not),
 * each trimming the clips as it needs.
 */
export function applyCut(p: Project, clipId: string, spec: { transition: Transition | null; cutAudio: CutAudio | null }): Project {
  return setCutAudio(setTransition(setCutAudio(p, clipId, null), clipId, spec.transition), clipId, spec.cutAudio)
}

/** What `after` (an edit of `before` at the cut into `clipId`) trimmed off the two clips, and how far the rest of the layer moved back. */
export function cutTrims(before: Project, after: Project, clipId: string): CutTrims {
  const a = cutContext(before, clipId)
  const b = cutContext(after, clipId)
  if (!a || !b) return { outgoing: 0, incoming: 0, ripple: 0 }
  const outgoing = clean(Math.max(0, a.outLength - b.outLength))
  const incoming = clean(Math.max(0, a.inLength - b.inLength))
  return { outgoing, incoming, ripple: clean(outgoing + incoming) }
}

/** The clips joined to `clipId` by transitions or audio overlaps, in order along their track (the clip alone when it has none). Empty for an unknown id. */
export function linkedChain(p: Project, clipId: string): string[] {
  const at = locate(p, clipId)
  if (!at) return []
  const clips = trackAt(p, at.track)!.clips
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
 *
 * With `toTrack` (another layer; one past the top adds a layer, up to
 * MAX_TRACKS) the block lands there whole, its clips still end to end, so
 * its transitions and audio overlaps stay: slid clear of the clips there as
 * one span, or on a snapped base inserted at the slot `start` picks and
 * packed. A snapped base it leaves packs behind it. The same project for the
 * audio layer, a layer that doesn't exist, or a slot between two linked
 * clips on a snapped base. A chain on the audio layer (audio transitions)
 * moves along it whatever `toTrack` says.
 */
export function moveGroup(p: Project, clipId: string, start: number, toTrack?: number): Project {
  const ids = new Set(linkedChain(p, clipId))
  const at = locate(p, clipId)
  if (!at || !Number.isFinite(start)) return p
  const clips = trackAt(p, at.track)!.clips
  const group = clips.filter((c) => ids.has(c.id))
  const others = clips.filter((c) => !ids.has(c.id))
  const first = group[0]
  const length = clipEnd(group[group.length - 1]) - first.start
  // An audio chain stays on the audio layer (it moves in time only).
  if (toTrack !== undefined && toTrack !== at.track && at.track !== AUDIO_TRACK) return moveGroupAcross(p, at.track, group, others, start, toTrack)
  if (at.track === 0 && isMagnetic(p)) {
    const slot = baseInsertion(others, start).index
    const packed = endToEnd([...others.slice(0, slot), ...group, ...others.slice(slot)])
    if (packed.length > 0 && clipEnd(packed[packed.length - 1]) > MAX_TIMELINE + 1e-6) return p
    return packed.every((c, i) => c.id === clips[i].id && c.start === clips[i].start) ? p : fixEdges(withClips(p, at.track, packed))
  }
  const to = resolveStart(others, length, start)
  if (to + length > MAX_TIMELINE + 1e-6) return p
  const delta = to - first.start
  if (Math.abs(delta) < 1e-9) return p
  const moved = group.map((c) => ({ ...c, start: c.start + delta }))
  // Landing against a clip with an edge transition there takes it away (fixEdges).
  return fixEdges(withClips(p, at.track, [...others, ...moved].sort((a, b) => a.start - b.start)))
}

/** moveGroup onto another layer: `group` (end to end) leaves track `from`, where `others` stay. */
function moveGroupAcross(p: Project, from: number, group: Clip[], others: Clip[], start: number, toTrack: number): Project {
  if (!Number.isInteger(toTrack) || toTrack < 0 || toTrack > p.tracks.length) return p
  let q = p
  if (toTrack === p.tracks.length) {
    q = addTrack(p)
    if (q === p) return p
  }
  // The layer it leaves: a snapped base closes the gap.
  q = withClips(q, from, from === 0 && isMagnetic(p) ? endToEnd(others) : others)
  const target = q.tracks[toTrack].clips
  let landed: Clip[]
  if (toTrack === 0 && isMagnetic(q)) {
    const sorted = [...target].sort((a, b) => a.start - b.start)
    const slot = baseInsertion(sorted, start).index
    // Not in between two clips a transition or audio overlap links.
    if (slot > 0 && slot < sorted.length && linksBefore(sorted[slot]) && adjoins(sorted[slot - 1], sorted[slot])) return p
    landed = endToEnd([...sorted.slice(0, slot), ...group, ...sorted.slice(slot)])
  } else {
    const length = clipEnd(group[group.length - 1]) - group[0].start
    const to = resolveStart(target, length, start)
    const delta = to - group[0].start
    landed = [...target, ...group.map((c) => ({ ...c, start: c.start + delta }))].sort((a, b) => a.start - b.start)
  }
  if (landed.length > 0 && clipEnd(landed[landed.length - 1]) > MAX_TIMELINE + 1e-6) return p
  return fixTransitions(withClips(q, toTrack, landed), p)
}

/** A transition running on a track at some time: the outgoing clip's index (`from`), the incoming one's (`to`), the cut and how far through it is (0 to 1). */
export type TransitionWindow = { from: number; to: number; cut: number; duration: number; type: AnyTransitionType; progress: number }

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

/** Where the outgoing clip of a running transition or overlap is in its source at `t` (past its out point after the cut). */
export const tailSourceTime = (track: Track, w: { from: number }, t: number) => {
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

/**
 * How long a clip's edge transition at `edge` may be: up to MAX_EDGE and what
 * the clip's length leaves beside its other edge's transition, floored to the
 * millisecond. 0 with the reason when it can't be had: the clip is gone, a
 * clip adjoins that edge ("adjoining": a transition between the two goes
 * there instead), it's a text clip ("text": its In and Out animations do
 * this), or the clip is too short ("too-short").
 */
export type EdgeRange = { max: number; reason: "ok" | "not-found" | "adjoining" | "text" | "too-short" }

export function edgeLimits(p: Project, clipId: string, edge: Edge): EdgeRange {
  const at = locate(p, clipId)
  if (!at) return { max: 0, reason: "not-found" }
  if (isTextClip(at.clip)) return { max: 0, reason: "text" }
  const clips = trackAt(p, at.track)!.clips
  if (edge === "in" ? adjoins(clips[at.index - 1], at.clip) : adjoins(at.clip, clips[at.index + 1])) return { max: 0, reason: "adjoining" }
  const other = (edge === "in" ? at.clip.edgeOut : at.clip.edgeIn)?.duration ?? 0
  const max = Math.floor(Math.min(MAX_EDGE, clipLength(at.clip) - other) * 1000 + 1e-6) / 1000
  return max < MIN_EDGE - 1e-9 ? { max: 0, reason: "too-short" } : { max, reason: "ok" }
}

/**
 * Sets (or with null, removes) a clip's "in" or "out" transition at a free
 * edge, its duration clamped to MIN_EDGE and edgeLimits' most. It runs inside
 * the clip, so nothing is trimmed or moved, and it doesn't link the clip to
 * anything. The same project when the edge isn't free, the type isn't one
 * that edge of this clip offers (lib/video/transition-types isEdgeType: an
 * audio fade on an audio clip, a picture transition on any other), or
 * nothing changes.
 */
export function setEdgeTransition(p: Project, clipId: string, edge: Edge, spec: EdgeTransition | null): Project {
  const at = locate(p, clipId)
  if (!at) return p
  const key = edge === "in" ? "edgeIn" : "edgeOut"
  const old = at.clip[key]
  const replace = (c: Clip) => withClips(p, at.track, trackAt(p, at.track)!.clips.map((x) => (x.id === clipId ? c : x)))
  if (spec === null) {
    if (!old) return p
    const rest: Clip = { ...at.clip }
    delete rest[key]
    return replace(rest)
  }
  const range = edgeLimits(p, clipId, edge)
  if (range.reason !== "ok" || !isEdgeType(spec.type, edge, isAudioClip(p, at.clip)) || !Number.isFinite(spec.duration)) return p
  const duration = Math.round(Math.max(MIN_EDGE, Math.min(range.max, spec.duration)) * 1000) / 1000
  if (old && old.type === spec.type && old.duration === duration) return p
  return replace({ ...at.clip, [key]: { type: spec.type, duration } })
}

/** An edge transition running at timeline time `t`: which edge, its type and length, and how far through it is (0 to 1). */
export type EdgeWindow = { edge: Edge; type: AnyTransitionType; duration: number; progress: number }

/** The edge transition of `clip` running at `t` (the in one over [start, start + d), the out one over [end - d, end)), or null. */
export function edgeAt(clip: Clip, t: number): EdgeWindow | null {
  const a = clip.edgeIn
  if (a && t >= clip.start && t < clip.start + a.duration) return { edge: "in", type: a.type, duration: a.duration, progress: Math.min(1, Math.max(0, (t - clip.start) / a.duration)) }
  const b = clip.edgeOut
  const end = clipEnd(clip)
  if (b && t >= end - b.duration && t < end) return { edge: "out", type: b.type, duration: b.duration, progress: Math.min(1, Math.max(0, (t - (end - b.duration)) / b.duration)) }
  return null
}
