import { normalizeClipAudio, sameClipAudio, type ClipAudio } from "./audio-levels"
import { isValidKey, type KeyOptions } from "./chroma"
import { isValidRetime, type Retime } from "./retime"
import { fitAnims, normalizeText, sameText, splitAnims, type ClipText } from "./text"
import { cropLeftOf, cropRightOf, isIdentity, isValidTransform, normalizeTransform, rotationOf, type Transform } from "./transform"
import {
  isAnyTransitionType, isAudioTransitionType, isCutAudioMode, isEdgeType, isTransitionType, MAX_CUT_AUDIO, MAX_EDGE, MAX_TRANSITION, MIN_CUT_AUDIO, MIN_EDGE, MIN_TRANSITION,
  type AnyTransitionType, type CutAudio, type Edge, type EdgeTransition, type Transition,
} from "./transition-types"

/**
 * An imported file. `kind` is absent for videos (older projects have no kind).
 * For an image, `duration` is its default clip length. An audio file
 * ("audio") has sound and no picture; its clips live on the audio layer only.
 * `source` is the Personal Storage path it was copied from ("<folder>/<name>"), so a
 * second import reuses it, or the original name of a file uploaded with Import.
 * `loopByDefault` (a video, e.g. an imported GIF) makes its new clips loop.
 * `retime` marks a generated copy of part of another video at another speed
 * or reversed (lib/video/retime): hidden from Project media, the original stays.
 * `title` is a human title (e.g. a stock result's), shown instead of the file name.
 */
export type Asset = { file: string; duration: number; hasAudio: boolean; kind?: "image" | "video" | "audio"; source?: string; loopByDefault?: true; title?: string; retime?: Retime }
/** The name to show for an asset: its human title (a stock result's) when it has one, else its file name. */
export const assetLabel = (a: Asset): string => (a.title !== undefined && a.title.trim() !== "" ? a.title : a.file)
/**
 * `start` is where the clip begins on the timeline (seconds), on every track.
 * `transform` moves, scales and crops the picture on the canvas
 * (lib/video/transform); absent means as fit. `muted` silences the clip's
 * sound in the preview and the export (absent when it isn't). A text clip
 * (lib/video/text) has `text` and no media: its `asset` is "", and it times
 * like an image (in 0, out its length, up to MAX_IMAGE); it has no sound.
 * `transition` blends the clip before it on its track into this one, centred
 * on the cut (see transitionLimits); only while that clip adjoins this one.
 * `cutAudio`, at the same cut, lets the sound lead (a J-cut) or trail (an
 * L-cut) the picture cut (see cutAudioLimits); independent of `transition`.
 * Audio clips link the same way with an audio transition type (no cutAudio).
 * `edgeIn` and `edgeOut` bring the clip in from nothing at its start and take
 * it out to nothing at its end, inside its own span (see fixEdges); only at
 * an edge no clip adjoins, and never on a text clip (its animations do that).
 * `audio` sets the overall level and the effects of the clip's sound
 * (lib/video/audio-levels); only on a clip with sound (hasSound), absent at
 * 0 dB with no effects. A muted clip stays silent whatever it says.
 */
export type Clip = {
  id: string; asset: string; in: number; out: number; start: number; transform?: Transform; muted?: boolean; text?: ClipText; transition?: Transition; cutAudio?: CutAudio
  edgeIn?: EdgeTransition; edgeOut?: EdgeTransition; audio?: ClipAudio
  /** A video clip that repeats its source for its whole length: in is 0 and out may pass the source duration (up to MAX_TIMELINE). */
  loop?: true
  /** An image or video clip's transparent background (the colour keyed out; `contiguous` only matters for an image); the file itself is unchanged. */
  key?: KeyOptions
}
/**
 * A layer. Track 0 is the base, the lowest layer; higher tracks draw over
 * lower ones. On every track clips sit at their own `start`, sorted by it,
 * with gaps allowed and no overlaps (nothing ripples). Mute is per clip
 * (Clip.muted); an older file's track mute is read onto its clips.
 * `magnetic` (the timeline's Snap box, base track only) keeps the base's clips
 * end to end from 0: every edit there inserts, ripples or closes the gap.
 */
export type Track = { id: string; magnetic?: boolean; clips: Clip[] }
/**
 * `audioTrack` is the audio layer ("layer 0", drawn below layer 1): audio
 * clips only, and audio clips only there. It times like an overlay layer
 * (own starts, gaps, no overlaps, no Snap), links adjoining clips only with
 * audio transitions (no audio overlaps), has no picture, and isn't counted
 * in MAX_TRACKS. Absent while it
 * has no clips, so a project without audio is stored as it always was.
 *
 * Version 3: every clip has a `start`. Version 2 laid the base track end to
 * end (no starts there) and version 1 had one flat `clips` list; parseProject
 * reads both as version 3 with the same layout.
 */
export type Project = {
  version: 3
  name: string
  width: number
  height: number
  fps: number
  /** Set once someone picks the orientation or resolution themselves: a new project's first picture then leaves them alone. */
  formatChosen?: true
  assets: Record<string, Asset>
  tracks: Track[]
  audioTrack?: Track
}

/** The part of a project that undo/redo covers; assets, name and settings are server-owned and never undone. */
export type Edit = { tracks: Track[]; audioTrack?: Track }

/** The audio layer's index wherever a track index is asked for (it isn't in `tracks`). */
export const AUDIO_TRACK = -1
const AUDIO_TRACK_ID = "audio"

export const MIN_CLIP = 0.2
/** Default and longest length of an image clip, in seconds. */
export const DEFAULT_IMAGE = 5
export const MAX_IMAGE = 600
/** The base track plus up to three overlay layers. */
export const MAX_TRACKS = 4
/** Most clips a project may hold, over all tracks. */
export const MAX_CLIPS = 5000
/** No clip may end later than this on the timeline (6 hours), on any track. */
export const MAX_TIMELINE = 21600
/** Most copies of its source a looping clip may have (so a tiny source can't make a huge expansion). */
export const MAX_LOOP_COPIES = 500
/** Longest a looping clip of this asset may be: MAX_LOOP_COPIES of its source, and never past MAX_TIMELINE. */
export function maxLoopLength(a: Asset): number {
  return Math.min(MAX_TIMELINE, a.duration * MAX_LOOP_COPIES)
}
/** Clips closer than this count as touching, not overlapping (float rounding). */
const EPS = 1e-6

export function assetKind(a: Asset): "image" | "video" | "audio" {
  return a.kind === "image" || a.kind === "audio" ? a.kind : "video"
}

/** True for a clip of an audio file (it belongs on the audio layer). */
export function isAudioClip(p: Project, c: Clip): boolean {
  const asset = c.text === undefined && Object.hasOwn(p.assets, c.asset) ? p.assets[c.asset] : undefined
  return asset !== undefined && assetKind(asset) === "audio"
}

/** The track at `index` (AUDIO_TRACK: the audio layer, empty when absent). */
export function trackAt(p: Project, index: number): Track | undefined {
  return index === AUDIO_TRACK ? (p.audioTrack ?? { id: AUDIO_TRACK_ID, clips: [] }) : p.tracks[index]
}

/** The edit part of a project: its tracks, and its audio layer when it has one. */
export function editOf(p: Project): Edit {
  return p.audioTrack ? { tracks: p.tracks, audioTrack: p.audioTrack } : { tracks: p.tracks }
}

/** True for a text clip (no media). */
export const isTextClip = (c: Clip): c is Clip & { text: ClipText } => c.text !== undefined

/** A text clip with its animations fitted to its length (lib/video/text fitAnims); the same clip when they fit, or it has no text. */
function fitted(c: Clip): Clip {
  if (!c.text) return c
  const text = fitAnims(c.text, clipLength(c))
  return text === c.text ? c : { ...c, text }
}

/** True for a clip that shows one still picture for its length: a text clip, or an image's (its in is 0 and it stretches freely). */
export function isStill(p: Project, c: Clip): boolean {
  if (isTextClip(c)) return true
  const asset = Object.hasOwn(p.assets, c.asset) ? p.assets[c.asset] : undefined
  return asset !== undefined && assetKind(asset) === "image"
}

/** True for a video clip with `loop`: it repeats its source, so it stretches like a still (in 0, out up to MAX_TIMELINE). */
export function isLooping(p: Project, c: Clip): boolean {
  if (c.loop !== true || isTextClip(c)) return false
  const asset = Object.hasOwn(p.assets, c.asset) ? p.assets[c.asset] : undefined
  return asset !== undefined && assetKind(asset) === "video"
}

/** Every asset copied from this Personal Storage path ("<folder>/<name>"), oldest first; a deleted copy can leave more than one. */
export function findAssetsBySource(p: Project, source: string): { id: string; asset: Asset }[] {
  if (!source) return []
  return Object.entries(p.assets).filter(([, asset]) => asset.source === source).map(([id, asset]) => ({ id, asset }))
}

export function newProject(name: string): Project {
  return { version: 3, name, width: 1920, height: 1080, fps: 30, assets: {}, tracks: [{ id: "t1", clips: [] }] }
}

export function clipLength(c: Clip): number {
  return c.out - c.in
}

/** Where a clip ends on the timeline. */
export function clipEnd(c: Clip): number {
  return c.start + clipLength(c)
}

/** Clips laid end to end from 0, in order (how version 1 and 2 files laid out the base track); any `start` they have is replaced. */
export function endToEnd(clips: Omit<Clip, "start">[]): Clip[] {
  let t = 0
  return clips.map((c) => {
    const clip = { ...c, start: t }
    t += clipLength(clip)
    return clip
  })
}

/** Every clip on every track, base track first, the audio layer's last. */
export function allClips(p: Project): Clip[] {
  const clips = p.tracks.flatMap((t) => t.clips)
  return p.audioTrack ? [...clips, ...p.audioTrack.clips] : clips
}

/** Each clip's start on the timeline. */
export function trackStarts(track: Track): number[] {
  return track.clips.map((c) => c.start)
}

/** Where the track's last clip ends (0 for an empty track). */
export function trackEnd(track: Track): number {
  return track.clips.reduce((end, c) => Math.max(end, clipEnd(c)), 0)
}

/** The timeline's length: the latest clip end over all tracks (the audio layer too); 0 for an empty project. */
export function totalLength(p: Project): number {
  return p.tracks.reduce((end, t) => Math.max(end, trackEnd(t)), p.audioTrack ? trackEnd(p.audioTrack) : 0)
}

/** True when `clips` (sorted by start) run back to back from 0 with no gap; true for none. */
export function isContiguousFromZero(clips: Clip[]): boolean {
  let t = 0
  for (const c of clips) {
    if (Math.abs(c.start - t) > EPS) return false
    t = clipEnd(c)
  }
  return true
}

/** The clip on `track` at `timelineTime`: its index, start and the time inside its source; null in a gap or past the end. */
export function trackClipAt(track: Track, timelineTime: number): { index: number; start: number; sourceTime: number } | null {
  if (!(timelineTime >= 0)) return null
  for (let i = 0; i < track.clips.length; i++) {
    const c = track.clips[i]
    if (timelineTime >= c.start && timelineTime < clipEnd(c)) return { index: i, start: c.start, sourceTime: c.in + (timelineTime - c.start) }
  }
  return null
}

export type ActiveClip = { track: number; index: number; start: number; sourceTime: number; clip: Clip }

/** The clip playing on each track at `timelineTime` (null where nothing plays), and the topmost of them (the one you see). */
export function clipsAt(p: Project, timelineTime: number): { tracks: (ActiveClip | null)[]; top: ActiveClip | null } {
  const tracks = p.tracks.map((t, track) => {
    const at = trackClipAt(t, timelineTime)
    return at && { track, ...at, clip: t.clips[at.index] }
  })
  let top: ActiveClip | null = null
  for (const hit of tracks) if (hit) top = hit
  return { tracks, top }
}

/**
 * The first start at or after `desired` (and at least 0) where a clip of
 * `length` fits between `clips` (one track's) without overlapping: it
 * slides past the neighbour it would overlap, and on past the next one if
 * there's no room. `ignore` is a clip id to leave out (the one being moved).
 * A start that would end the clip past MAX_TIMELINE comes back to fit (the
 * slide can still push it past; place refuses that).
 */
export function resolveStart(clips: Clip[], length: number, desired: number, ignore?: string): number {
  let t = Math.max(0, Math.min(Number.isFinite(desired) ? desired : 0, MAX_TIMELINE - length))
  const others = clips.filter((c) => c.id !== ignore).sort((a, b) => a.start - b.start)
  for (const c of others) {
    if (c.start < t + length - EPS && t < clipEnd(c) - EPS) t = clipEnd(c)
  }
  return t
}

/** True when [start, start + length) overlaps no clip in `clips` but `ignore` (touching is fine). */
function isFree(clips: Clip[], start: number, length: number, ignore?: string): boolean {
  return clips.every((c) => c.id === ignore || !(c.start < start + length - EPS && start < clipEnd(c) - EPS))
}

/**
 * The lowest track index where [start, start + length) is free (`ignore`: a
 * clip id to leave out, the one being moved); else a new track's index
 * (p.tracks.length) when fewer than `max` tracks exist; else null.
 */
export function freeTrackFor(p: Project, start: number, length: number, options: { max?: number; ignore?: string } = {}): number | null {
  const { max = MAX_TRACKS, ignore } = options
  const free = p.tracks.findIndex((t) => isFree(t.clips, start, length, ignore))
  if (free >= 0) return free
  return p.tracks.length < max ? p.tracks.length : null
}

const sortByStart = (clips: Clip[]) => [...clips].sort((a, b) => a.start - b.start)

/** Where clip `id` is: its track (AUDIO_TRACK for the audio layer), index and the clip. */
function find(p: Project, id: string): { track: number; index: number; clip: Clip } | null {
  for (let track = 0; track < p.tracks.length; track++) {
    const index = p.tracks[track].clips.findIndex((c) => c.id === id)
    if (index >= 0) return { track, index, clip: p.tracks[track].clips[index] }
  }
  const index = p.audioTrack ? p.audioTrack.clips.findIndex((c) => c.id === id) : -1
  return index >= 0 ? { track: AUDIO_TRACK, index, clip: p.audioTrack!.clips[index] } : null
}

const hasClip = (p: Project, id: string) => find(p, id) !== null

/** `p` with track `index`'s clips replaced; the audio layer (AUDIO_TRACK) goes when it's left with none. */
export function withTrack(p: Project, index: number, clips: Clip[]): Project {
  if (index === AUDIO_TRACK) {
    if (clips.length > 0) return { ...p, audioTrack: { id: p.audioTrack?.id ?? AUDIO_TRACK_ID, clips } }
    if (!p.audioTrack) return p
    const rest = { ...p }
    delete rest.audioTrack
    return rest
  }
  return { ...p, tracks: p.tracks.map((t, i) => (i === index ? { ...t, clips } : t)) }
}

/** Two clips closer than this (s) at a cut adjoin: a transition can join them. */
export const ADJOIN_EPS = 0.001

/** True when `b` starts where `a` ends (within ADJOIN_EPS). */
export const adjoins = (a: Clip | undefined, b: Clip | undefined) => a !== undefined && b !== undefined && Math.abs(clipEnd(a) - b.start) <= ADJOIN_EPS

/**
 * Spare footage (s) past a clip's out point: unlimited for a still, what the source has left for a video (0 when its
 * asset is gone). For a looping clip, what the source has left after its last copy (expandLoops): d - (L mod d), 0
 * when L is a whole number of copies.
 */
export function tailHandle(p: Project, c: Clip): number {
  if (isStill(p, c)) return Infinity
  const asset = Object.hasOwn(p.assets, c.asset) ? p.assets[c.asset] : undefined
  if (!asset) return 0
  if (isLooping(p, c)) {
    const d = asset.duration
    const length = Math.min(c.out - c.in, maxLoopLength(asset))
    if (!(d > 0) || !Number.isFinite(length)) return 0
    // The last copy's length, counted as expandLoops counts copies.
    const last = length - (Math.max(1, Math.ceil(length / d - EPS)) - 1) * d
    return Math.max(0, d - last)
  }
  return Math.max(0, asset.duration - c.out)
}

/** Spare footage (s) before a clip's in point: unlimited for a still, its in point for a video. */
export const headHandle = (p: Project, c: Clip) => (isStill(p, c) ? Infinity : isLooping(p, c) ? 0 : Math.max(0, c.in))

/** "loop": the clip or the one before it loops (a looping clip takes no transition or audio overlap on either side). */
export type TransitionLimits = { max: number; reason: "ok" | "not-adjoining" | "no-footage" | "loop" }

/**
 * How far the overlap at the cut into `clips[i]` (from the clip before it)
 * reaches before the cut (`lead`, into the outgoing clip) and after it
 * (`trail`, into the incoming one): half its transition, or its J-cut (lead)
 * or L-cut (trail), the longer; 0 where nothing links the two.
 */
export function cutReach(clips: Clip[], i: number): { lead: number; trail: number } {
  const c = clips[i]
  if (!c || !linksBefore(c) || !adjoins(clips[i - 1], c)) return { lead: 0, trail: 0 }
  const half = c.transition ? c.transition.duration / 2 : 0
  const a = c.cutAudio
  return { lead: Math.max(half, a?.mode === "j" ? a.duration : 0), trail: Math.max(half, a?.mode === "l" ? a.duration : 0) }
}

/**
 * How long a transition into clip `clipId` from the clip before it may be
 * with the footage the clips have now (transitionPlan in lib/video/transitions
 * trims them to make room for a longer one). The transition is centred on the
 * cut, so the outgoing clip plays half of it past its out point and the
 * incoming one half before its in point, from the footage beyond them (a
 * still has any amount): the most is twice the smaller of those two handles.
 * Each half also has to fit in its clip beside what the clip's other cut
 * takes of it (cutReach), so two cuts' windows never meet, and the whole is
 * at most MAX_TRANSITION, floored to the millisecond. `max` is 0 with
 * "not-adjoining" when nothing adjoins it (or the clip is gone), and
 * "no-footage" when that leaves less than MIN_TRANSITION, and "loop" when
 * either clip loops (its expanded copies have no footage past their ends, so
 * a looping clip takes no transition on either side). The audio layer's
 * clips have the same limits (their transitions are audio ones).
 */
export function transitionLimits(p: Project, clipId: string): TransitionLimits {
  // The audio layer's clips link with audio transitions, under the same limits.
  const at = find(p, clipId)
  const clips = at ? trackAt(p, at.track)!.clips : []
  const prev = at ? clips[at.index - 1] : undefined
  if (!at || !adjoins(prev, at.clip)) return { max: 0, reason: "not-adjoining" }
  if (isLooping(p, prev!) || isLooping(p, at.clip)) return { max: 0, reason: "loop" }
  const roomOut = clipLength(prev!) - cutReach(clips, at.index - 1).trail
  const roomIn = clipLength(at.clip) - cutReach(clips, at.index + 1).lead
  const max = Math.floor(Math.min(MAX_TRANSITION, 2 * tailHandle(p, prev!), 2 * headHandle(p, at.clip), 2 * roomOut, 2 * roomIn) * 1000 + 1e-6) / 1000
  return max < MIN_TRANSITION - 1e-9 ? { max: 0, reason: "no-footage" } : { max, reason: "ok" }
}

/** Why an audio overlap can't be had at a cut, or "ok". */
export type CutAudioReason = "ok" | "not-adjoining" | "no-audio" | "no-footage" | "loop"
export type CutAudioLimits = Record<CutAudio["mode"], { max: number; reason: CutAudioReason }>

/** True for a clip whose sound a cut can lead or trail: a video whose file has sound (a muted one counts; it stays silent). */
export function hasSound(p: Project, c: Clip): boolean {
  if (isStill(p, c)) return false
  const asset = Object.hasOwn(p.assets, c.asset) ? p.assets[c.asset] : undefined
  return asset !== undefined && asset.hasAudio
}

/**
 * True when the Edit length dialog shows the clip's source window (strip and In/Out): a clip with sound (hasSound),
 * but not a looping one, whose length runs past its source and so has no window in it (it gets the length field only,
 * as a still does).
 */
export function showsSourceWindow(p: Project, c: Clip): boolean {
  return hasSound(p, c) && !isLooping(p, c)
}

/**
 * How long an audio overlap at the cut into `clipId` from the clip before it
 * may be, for each mode. A J-cut plays the incoming clip's sound from before
 * its in point, so it needs a video with sound and footage there: at most its
 * in point. An L-cut plays the outgoing clip's sound past its out point: a
 * video with sound and footage after it. Either is at most MAX_CUT_AUDIO and
 * has to fit in the clip it overlaps (the outgoing one for J, the incoming
 * one for L) beside what that clip's other cut takes of it (cutReach), so two
 * cuts' overlaps never meet and a J never reaches before 0; floored to the
 * millisecond. `max` is 0 with the reason when it can't be had ("not-adjoining"
 * on the audio layer, whose clips never link). These are
 * the limits with the footage the clips have now: cutAudioPlan (in
 * lib/video/transitions) trims the clips to make room for a longer one.
 */
export function cutAudioLimits(p: Project, clipId: string): CutAudioLimits {
  const found = find(p, clipId)
  const at = found && found.track !== AUDIO_TRACK ? found : null
  const clips = at ? p.tracks[at.track].clips : []
  const prev = at ? clips[at.index - 1] : undefined
  if (!at || !prev || !adjoins(prev, at.clip)) return { j: { max: 0, reason: "not-adjoining" }, l: { max: 0, reason: "not-adjoining" } }
  if (isLooping(p, prev) || isLooping(p, at.clip)) return { j: { max: 0, reason: "loop" }, l: { max: 0, reason: "loop" } }
  const limit = (sound: boolean, handle: number, room: number): { max: number; reason: CutAudioReason } => {
    if (!sound) return { max: 0, reason: "no-audio" }
    const max = Math.floor(Math.min(MAX_CUT_AUDIO, handle, room) * 1000 + 1e-6) / 1000
    return max < MIN_CUT_AUDIO - 1e-9 ? { max: 0, reason: "no-footage" } : { max, reason: "ok" }
  }
  return {
    j: limit(hasSound(p, at.clip), headHandle(p, at.clip), clipLength(prev) - cutReach(clips, at.index - 1).trail),
    l: limit(hasSound(p, prev), tailHandle(p, prev), clipLength(at.clip) - cutReach(clips, at.index + 1).lead),
  }
}

/** True when a clip has something at its cut from the clip before it (a transition or an audio overlap) that links the two. */
export const linksBefore = (c: Clip) => c.transition !== undefined || c.cutAudio !== undefined

/** Whether a transition of `type` suits the clip: an audio type for an audio clip, a picture type for any other. */
export const transitionFits = (p: Project, c: Clip, type: unknown): type is AnyTransitionType => (isAudioClip(p, c) ? isAudioTransitionType(type) : isTransitionType(type))

/** A clip's in and out edge transitions fitted to `length`, as a text's animations are (lib/video/text fitAnims): together they fit in it, shrunk in proportion to the millisecond, neither below MIN_EDGE. */
function fitEdgePair(a: number, b: number, length: number): [number, number] {
  if (a + b <= length + 1e-9) return [a, b]
  const floorMs = (s: number) => Math.floor(s * 1000 + 1e-6) / 1000
  if (a > 0 && b > 0) {
    const k = length / (a + b)
    let da = Math.max(MIN_EDGE, floorMs(a * k))
    let db = Math.max(MIN_EDGE, floorMs(b * k))
    if (da + db > length + 1e-9) {
      if (da > db) da = floorMs(length - db)
      else db = floorMs(length - da)
    }
    return [da, db]
  }
  return [a > 0 ? Math.max(MIN_EDGE, floorMs(length)) : 0, b > 0 ? Math.max(MIN_EDGE, floorMs(length)) : 0]
}

/** The clip with its edge transitions fitted to its length (fitEdgePair); the same clip when they fit. */
export function fitEdges(c: Clip): Clip {
  if (!c.edgeIn && !c.edgeOut) return c
  const [a, b] = fitEdgePair(c.edgeIn?.duration ?? 0, c.edgeOut?.duration ?? 0, clipLength(c))
  if (a === (c.edgeIn?.duration ?? 0) && b === (c.edgeOut?.duration ?? 0)) return c
  const next: Clip = { ...c }
  if (c.edgeIn) next.edgeIn = { ...c.edgeIn, duration: a }
  if (c.edgeOut) next.edgeOut = { ...c.edgeOut, duration: b }
  return next
}

/** The clip without its edge transition at `edge`. */
export function withoutEdge(c: Clip, edge: Edge): Clip {
  const key = edge === "in" ? "edgeIn" : "edgeOut"
  if (!c[key]) return c
  const next: Clip = { ...c }
  delete next[key]
  return next
}

/**
 * Every edge transition checked after an edit: one at an edge a clip now
 * adjoins goes (the edge isn't free any more), and the rest are fitted to
 * their clip's length (fitEdges). The same project when nothing changes.
 */
export function fixEdges(p: Project): Project {
  const has = (t: Track) => t.clips.some((c) => c.edgeIn || c.edgeOut)
  if (!p.tracks.some(has) && !(p.audioTrack && has(p.audioTrack))) return p
  const fix = (t: Track): Track => {
    let touched = false
    const clips = t.clips.map((c, i) => {
      if (!c.edgeIn && !c.edgeOut) return c
      let next = c
      if (next.edgeIn && adjoins(t.clips[i - 1], c)) next = withoutEdge(next, "in")
      if (next.edgeOut && adjoins(c, t.clips[i + 1])) next = withoutEdge(next, "out")
      next = fitEdges(next)
      if (next !== c) touched = true
      return next
    })
    return touched ? { ...t, clips } : t
  }
  const tracks = p.tracks.map(fix)
  const audio = p.audioTrack ? fix(p.audioTrack) : undefined
  if (tracks.every((t, i) => t === p.tracks[i]) && audio === p.audioTrack) return p
  return { ...p, tracks, ...(audio ? { audioTrack: audio } : {}) }
}

/** The clip adjoining `c`'s start on `clips` (sorted by start), if any. */
function adjoiningBefore(clips: Clip[], index: number): Clip | undefined {
  const prev = clips[index - 1]
  return adjoins(prev, clips[index]) ? prev : undefined
}

/**
 * Every transition and audio overlap checked after an edit of `prev` (none: a
 * freshly read project): one whose clip no longer has a clip adjoining it
 * goes, and so does one whose adjoining clip changed (a delete or an insert
 * between them). `alias` maps a split's new piece to the clip it came from,
 * which it stands in for. The rest are shortened to transitionLimits (an
 * overlap to cutAudioLimits for its mode), and dropped when that's below
 * MIN_TRANSITION (MIN_CUT_AUDIO). The same project when nothing changes.
 */
export function fixTransitions(p: Project, prev?: Project, alias: Record<string, string> = {}): Project {
  // Edge transitions are checked too (fixEdges): an edge a clip now adjoins isn't free.
  return fixEdges(fixLinks(p, prev, alias))
}

/** fixTransitions' check of the transitions and audio overlaps, on every layer (the audio layer's too). */
function fixLinks(p: Project, prev: Project | undefined, alias: Record<string, string>): Project {
  const layers = (q: Project) => (q.audioTrack ? [...q.tracks, q.audioTrack] : q.tracks)
  if (!layers(p).some((t) => t.clips.some(linksBefore))) return p
  const before = new Map<string, string | null>()
  if (prev) {
    for (const t of layers(prev)) t.clips.forEach((c, i) => before.set(c.id, adjoiningBefore(t.clips, i)?.id ?? null))
  }
  let changed = false
  const fixed = layers(p).map((t) => {
    let touched = false
    const clips = t.clips.map((c, i) => {
      if (!linksBefore(c)) return c
      const pred = adjoiningBefore(t.clips, i)
      const was = before.get(c.id)
      const samePred = !prev || was === undefined || (pred !== undefined && (alias[pred.id] ?? pred.id) === was)
      let next = c
      if (c.transition) {
        const limit = pred && samePred ? transitionLimits(p, c.id).max : 0
        if (!(limit >= MIN_TRANSITION && c.transition.duration <= limit)) {
          const { transition, ...rest } = next
          next = limit >= MIN_TRANSITION ? { ...rest, transition: { ...transition!, duration: limit } } : rest
        }
      }
      if (c.cutAudio) {
        const limit = pred && samePred ? cutAudioLimits(p, c.id)[c.cutAudio.mode].max : 0
        if (!(limit >= MIN_CUT_AUDIO && c.cutAudio.duration <= limit)) {
          const { cutAudio, ...rest } = next
          next = limit >= MIN_CUT_AUDIO ? { ...rest, cutAudio: { ...cutAudio!, duration: limit } } : rest
        }
      }
      if (next !== c) touched = true
      return next
    })
    if (!touched) return t
    changed = true
    return { ...t, clips }
  })
  if (!changed) return p
  const tracks = fixed.slice(0, p.tracks.length)
  return p.audioTrack ? { ...p, tracks, audioTrack: fixed[p.tracks.length] } : { ...p, tracks }
}

/**
 * The clips whose transition or audio overlap `next` (an edit of `prev`)
 * would part: both clips of the cut are still there, but no longer side by
 * side on one track.
 */
export function brokenLinks(prev: Project, next: Project): string[] {
  const where = new Map<string, { track: number; index: number }>()
  next.tracks.forEach((t, track) => t.clips.forEach((c, index) => where.set(c.id, { track, index })))
  next.audioTrack?.clips.forEach((c, index) => where.set(c.id, { track: AUDIO_TRACK, index }))
  const broken: string[] = []
  for (const t of prev.audioTrack ? [...prev.tracks, prev.audioTrack] : prev.tracks) {
    t.clips.forEach((c, i) => {
      const pred = linksBefore(c) ? adjoiningBefore(t.clips, i) : undefined
      const b = where.get(c.id)
      if (!pred || !b || !where.has(pred.id)) return
      const clips = trackAt(next, b.track)!.clips
      if (adjoiningBefore(clips, b.index)?.id !== pred.id) broken.push(c.id)
    })
  }
  return broken
}

/** True when the base track snaps its clips together (Track.magnetic; it means nothing on another track). */
export function isMagnetic(p: Project): boolean {
  return p.tracks[0]?.magnetic === true
}

/**
 * Where a clip dropped at `time` goes on a snapped base: `index`, how many of
 * `clips` (but `ignore`) have their midpoint before `time`, and `start`, where
 * the clip before that slot ends now (0 for the first slot).
 */
export function baseInsertion(clips: Clip[], time: number, ignore?: string): { index: number; start: number } {
  const others = sortByStart(clips.filter((c) => c.id !== ignore))
  const index = others.filter((c) => c.start + clipLength(c) / 2 < time).length
  return { index, start: index === 0 ? 0 : clipEnd(others[index - 1]) }
}

/** The base track's clips laid end to end from 0 in start order; the same project when they already are. */
export function packBase(p: Project): Project {
  const track = p.tracks[0]
  if (!track) return p
  const clips = sortByStart(track.clips)
  if (isContiguousFromZero(clips) && clips.every((c, i) => c === track.clips[i])) return p
  return withTrack(p, 0, endToEnd(clips))
}

/**
 * `next` (an edit of `p`) with a snapped base packed again, its transitions
 * checked against `p` (fixTransitions); `p` when the pack would end past MAX_TIMELINE.
 */
function settle(p: Project, next: Project, alias?: Record<string, string>): Project {
  if (next === p) return next
  if (!isMagnetic(next)) return fixTransitions(next, p, alias)
  const packed = packBase(next)
  return trackEnd(packed.tracks[0]) > MAX_TIMELINE + EPS ? p : fixTransitions(packed, p, alias)
}

/** Snap on: the base packs end to end in its current order (one edit with the flag). Off: only the flag goes; clips stay put. */
export function setBaseMagnetic(p: Project, on: boolean): Project {
  const track = p.tracks[0]
  if (!track || isMagnetic(p) === on) return p
  if (!on) return { ...p, tracks: [{ id: track.id, clips: track.clips }, ...p.tracks.slice(1)] }
  return packBase({ ...p, tracks: [{ ...track, magnetic: true }, ...p.tracks.slice(1)] })
}

/** `clip` inserted into a snapped base at the slot `time` picks (baseInsertion), the base packed; `p` when it would end past MAX_TIMELINE. */
function insertBase(p: Project, clip: Clip, time: number): Project {
  const others = sortByStart(p.tracks[0].clips.filter((c) => c.id !== clip.id))
  others.splice(baseInsertion(others, time).index, 0, clip)
  const next = withTrack(p, 0, endToEnd(others))
  return trackEnd(next.tracks[0]) > MAX_TIMELINE + EPS ? p : next
}

/** A new track id: the lowest "t<n>" not in use. */
function freeTrackId(p: Project): string {
  for (let n = 1; ; n++) if (!p.tracks.some((t) => t.id === `t${n}`)) return `t${n}`
}

/** An empty overlay layer on top; the same project at MAX_TRACKS. */
export function addTrack(p: Project): Project {
  if (p.tracks.length >= MAX_TRACKS) return p
  return { ...p, tracks: [...p.tracks, { id: freeTrackId(p), clips: [] }] }
}

/** Removes an empty overlay track; never the base track or one with clips. */
export function removeTrack(p: Project, id: string): Project {
  const index = p.tracks.findIndex((t) => t.id === id)
  if (index <= 0 || p.tracks[index].clips.length > 0) return p
  return { ...p, tracks: p.tracks.filter((t) => t.id !== id) }
}

const assetKindOf = (p: Project, c: Clip) => (Object.hasOwn(p.assets, c.asset) ? assetKind(p.assets[c.asset]) : "audio")

/**
 * Sets (or with undefined, removes) an image or video clip's transparent background:
 * the picked colour and how it is keyed (lib/video/chroma). The file is never
 * changed; the preview and the export draw the clip with the background
 * cleared (an image by flood fill, a video by a plain colour key). The same project for any other clip, an invalid setting or no change.
 */
export function setClipKey(p: Project, clipId: string, key: KeyOptions | undefined): Project {
  const at = find(p, clipId)
  if (!at || isTextClip(at.clip) || assetKindOf(p, at.clip) === "audio" || (key !== undefined && !isValidKey(key))) return p
  if (key === undefined ? at.clip.key === undefined : JSON.stringify(at.clip.key) === JSON.stringify(key)) return p
  const clip: Clip = { ...at.clip }
  if (key === undefined) delete clip.key
  else clip.key = { key: [...key.key] as KeyOptions["key"], tolerance: key.tolerance, contiguous: key.contiguous }
  return withTrack(p, at.track, trackAt(p, at.track)!.clips.map((c) => (c.id === clipId ? clip : c)))
}

/** Mutes or unmutes one clip's sound (preview and export); unmuted stores no field. The same project when nothing changes. */
export function setClipMuted(p: Project, clipId: string, muted: boolean): Project {
  const at = find(p, clipId)
  if (!at || isTextClip(at.clip) || Boolean(at.clip.muted) === muted) return p
  const clip: Clip = { ...at.clip, muted: true }
  if (!muted) delete clip.muted
  return withTrack(p, at.track, trackAt(p, at.track)!.clips.map((c) => (c.id === clipId ? clip : c)))
}

/**
 * Sets a clip's audio levels (lib/video/audio-levels: gain and effects);
 * undefined, or 0 dB with no effects, removes the field. The same project when
 * the clip has no sound (hasSound), the levels don't validate or nothing
 * changes.
 */
export function setClipAudio(p: Project, clipId: string, audio: ClipAudio | undefined): Project {
  const at = find(p, clipId)
  const next = audio === undefined ? undefined : normalizeClipAudio(audio)
  if (!at || next === null || !hasSound(p, at.clip) || sameClipAudio(at.clip.audio, next)) return p
  const clip: Clip = { ...at.clip }
  if (next) clip.audio = next
  else delete clip.audio
  return withTrack(p, at.track, trackAt(p, at.track)!.clips.map((c) => (c.id === clipId ? clip : c)))
}

/**
 * Puts `clip` on track `trackIndex` (one past the top adds a layer; AUDIO_TRACK
 * the audio layer) at `start`, slid clear of overlaps; the same project when
 * it can't, or when an audio clip would leave the audio layer or another clip
 * go onto it.
 */
function place(p: Project, clip: Clip, trackIndex: number, start: number): Project {
  const audio = trackIndex === AUDIO_TRACK
  if (isAudioClip(p, clip) !== audio) return p
  if (!audio && (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex > p.tracks.length)) return p
  let q = p
  if (!audio && trackIndex === p.tracks.length) {
    q = addTrack(p)
    if (q === p) return p
  }
  const clips = trackAt(q, trackIndex)!.clips
  const at = resolveStart(clips, clipLength(clip), start, clip.id)
  if (at + clipLength(clip) > MAX_TIMELINE + EPS) return p
  // Every setting goes with the clip (a spread, so a field added later is never dropped on a move).
  const placed: Clip = { ...clip, start: at }
  return withTrack(q, trackIndex, sortByStart([...clips.filter((c) => c.id !== clip.id), placed]))
}

const loopsByDefault = (asset: Asset) => asset.loopByDefault === true && assetKind(asset) === "video"

/** How long a new clip of `asset` is (what addClip gives it): DEFAULT_IMAGE for an image or a looping-by-default video (a GIF), else the file's length. */
export function newClipLength(asset: Asset): number {
  return assetKind(asset) === "image" || loopsByDefault(asset) ? DEFAULT_IMAGE : asset.duration
}

/**
 * A new clip of the whole asset (an image: DEFAULT_IMAGE long) on any track
 * at `at.start` (0 when absent), sliding past any clip it would overlap. A
 * track index one past the top adds a layer for it (up to MAX_TRACKS). On a
 * snapped base it's inserted at the slot `at.start` picks (baseInsertion).
 * An audio file's clip goes on the audio layer whatever track is asked for;
 * nothing else goes there (the same project).
 */
export function addClip(p: Project, assetId: string, trackIndex: number, at: { start?: number }, id: string): Project {
  const asset = Object.hasOwn(p.assets, assetId) ? p.assets[assetId] : undefined
  if (!asset || asset.duration < MIN_CLIP || hasClip(p, id)) return p
  const loop = loopsByDefault(asset)
  const clip: Clip = { id, asset: assetId, in: 0, out: newClipLength(asset), start: 0, ...(loop ? { loop: true as const } : {}) }
  // A clip that now adjoins one with an edge transition there takes it away (fixEdges).
  if (assetKind(asset) === "audio") return fixEdges(place(p, clip, AUDIO_TRACK, at.start ?? 0))
  // Going in between two clips there parts them: a transition between them goes.
  if (trackIndex === 0 && isMagnetic(p)) return fixTransitions(insertBase(p, clip, at.start ?? 0), p)
  return fixEdges(place(p, clip, trackIndex, at.start ?? 0))
}

/** What dropping media on a clip does: in front of it, behind it, or in its place. */
export type DropMode = "before" | "after" | "replace"
/** The clip media was dropped on, and where on it. */
export type DropOn = { clip: string; mode: DropMode }

/** Where on a clip the pointer is (0 its left edge, 1 its right) to what a drop there does: the left 40% inserts before it, the right 40% after it, the middle 20% replaces it. */
export function dropZone(fraction: number): DropMode {
  return fraction < 0.4 ? "before" : fraction > 0.6 ? "after" : "replace"
}

/**
 * Media dropped on a clip (`on`): put in front of it (the left 40%), behind it
 * (the right 40%) or in its place (the middle 20%). In front or behind, the
 * clip and every clip after it on the layer move later just far enough to make
 * room (on a snapped base the base packs); replacing takes the clip out and
 * puts the new one at its start, as long as the clip was (a still takes its
 * length; a video or sound up to its own length). Sounds go only on the audio
 * layer's clips, and nothing else there. The same project when the clip is
 * gone, the kinds don't fit, the id is taken or it wouldn't fit before MAX_TIMELINE.
 */
export function placeOnClip(p: Project, assetId: string, on: DropOn, id: string): Project {
  const asset = Object.hasOwn(p.assets, assetId) ? p.assets[assetId] : undefined
  const at = find(p, on.clip)
  if (!asset || asset.duration < MIN_CLIP || hasClip(p, id) || !at) return p
  const target = at.clip
  const loop = loopsByDefault(asset)
  const natural = newClipLength(asset)
  const length = on.mode !== "replace" ? natural : assetKind(asset) === "image" ? Math.min(clipLength(target), MAX_IMAGE) : loop ? Math.min(clipLength(target), maxLoopLength(asset)) : Math.min(asset.duration, clipLength(target))
  if (length < MIN_CLIP - EPS) return p
  const clip: Clip = { id, asset: assetId, in: 0, out: length, start: 0, ...(loop ? { loop: true as const } : {}) }
  return insertOnClip(p, clip, on, p)
}

/**
 * A clip already on the timeline (`id`) moved onto another clip: in front of
 * it, behind it or in its place, as placeOnClip does for new media. It keeps
 * its own length and settings (a replaced clip is taken out). The same project
 * when it can't be done (the clips are the same, the kinds don't fit, no room).
 */
export function moveOnClip(p: Project, id: string, on: DropOn): Project {
  const from = find(p, id)
  if (!from || on.clip === id) return p
  const without = removeClip(p, id)
  if (without === p) return p
  const placed = insertOnClip(without, from.clip, on, p)
  return placed === without ? p : placed
}

/** `clip` (not in `p`) put in front of, behind or in place of the clip `on` names; `p` when it can't be. `prev` is the project before the whole edit, for its transitions. */
function insertOnClip(p: Project, clip: Clip, on: DropOn, prev: Project): Project {
  const at = find(p, on.clip)
  if (!at) return p
  // Sounds go only on the audio layer's clips, and nothing else there.
  if (isAudioClip(p, clip) !== (at.track === AUDIO_TRACK)) return p
  const target = at.clip
  const magneticBase = at.track === 0 && isMagnetic(p)
  const clips = trackAt(p, at.track)!.clips

  if (on.mode === "replace") {
    const without = withTrack(p, at.track, clips.filter((c) => c.id !== target.id))
    const next = magneticBase ? insertBase(without, clip, target.start) : place(without, clip, at.track, target.start)
    return next === without ? p : fixTransitions(next, prev)
  }
  const start = on.mode === "before" ? target.start : clipEnd(target)
  return insertAtTime(p, clip, at.track, start, prev)
}

/**
 * `clip` (not in `p`) put on layer `trackIndex` at `start`, the clips from
 * there on moving later just far enough to make room (a snapped base inserts at
 * its slot and packs; one past the top layer is a new layer). `p` when it
 * wouldn't fit before MAX_TIMELINE. `prev` is the project before the whole
 * edit, for its transitions.
 */
function insertAtTime(p: Project, clip: Clip, trackIndex: number, start: number, prev: Project): Project {
  if (trackIndex === 0 && isMagnetic(p)) {
    const next = insertBase(p, clip, start)
    return next === p ? p : fixTransitions(next, prev)
  }
  const length = clipLength(clip)
  const clips = trackIndex < p.tracks.length || trackIndex === AUDIO_TRACK ? trackAt(p, trackIndex)!.clips : []
  // The clips from `start` on move later as far as it takes to clear the new one.
  let cursor = start + length
  let end = cursor
  const moved = sortByStart(clips).map((c) => {
    if (c.start < start - EPS || c.start >= cursor - EPS) {
      if (c.start >= start - EPS) cursor = Math.max(cursor, clipEnd(c))
      end = Math.max(end, clipEnd(c))
      return c
    }
    const shifted = { ...c, start: cursor }
    cursor = clipEnd(shifted)
    end = Math.max(end, cursor)
    return shifted
  })
  if (end > MAX_TIMELINE + EPS) return p
  const next = place(clips.length ? withTrack(p, trackIndex, moved) : p, clip, trackIndex, start)
  return next === p ? p : fixTransitions(next, prev)
}

/** addClip, or, when the drop was on a clip (`at.on`), placeOnClip (addClip when that can't be done). */
export function placeDropped(p: Project, assetId: string, trackIndex: number, at: { start?: number; on?: DropOn }, id: string): Project {
  if (at.on) {
    const placed = placeOnClip(p, assetId, at.on, id)
    if (placed !== p) return placed
  }
  return addClip(p, assetId, trackIndex, at, id)
}

/**
 * A new text clip (DEFAULT_IMAGE long, `text` as given, the canvas centre) on
 * any track at `at.start`, placed as addClip places an image: slid clear of
 * overlaps, a new layer one past the top, inserted at its slot on a snapped
 * base. The same project when the text isn't valid or the id is taken.
 */
export function addTextClip(p: Project, text: ClipText, trackIndex: number, at: { start?: number }, id: string): Project {
  const t = normalizeText(text)
  if (!t || hasClip(p, id)) return p
  const clip: Clip = { id, asset: "", in: 0, out: DEFAULT_IMAGE, start: 0, text: fitAnims(t, DEFAULT_IMAGE) }
  if (trackIndex === 0 && isMagnetic(p)) return fixTransitions(insertBase(p, clip, at.start ?? 0), p)
  return fixEdges(place(p, clip, trackIndex, at.start ?? 0))
}

/**
 * Sets a text clip's text (content, colour, orientation, font, animations,
 * the animations fitted to the clip's length); the same project when it isn't
 * a text clip, the text isn't valid or nothing changes.
 */
export function setClipText(p: Project, clipId: string, text: ClipText): Project {
  const at = find(p, clipId)
  const n = normalizeText(text)
  const t = n && at && fitAnims(n, clipLength(at.clip))
  if (!at || !t || !isTextClip(at.clip) || sameText(at.clip.text, t)) return p
  return withTrack(p, at.track, trackAt(p, at.track)!.clips.map((c) => (c.id === clipId ? { ...c, text: t } : c)))
}

/**
 * Moves a clip along its track or to another one (in and out stay) to
 * `at.start` (where it is when absent); see addClip for where it lands. A
 * clip leaving a snapped base closes its gap there. An audio clip stays on
 * the audio layer (it moves in time only); no other clip goes there.
 */
export function moveClip(p: Project, id: string, toTrack: number, at: { start?: number }): Project {
  const from = find(p, id)
  if (!from) return p
  if (from.track === AUDIO_TRACK) toTrack = AUDIO_TRACK
  else if (!Number.isInteger(toTrack) || toTrack < 0 || toTrack > p.tracks.length) return p
  const without = withTrack(p, from.track, trackAt(p, from.track)!.clips.filter((c) => c.id !== id))
  const desired = at.start ?? from.clip.start
  const moved = toTrack === 0 && isMagnetic(p) ? insertBase(without, from.clip, desired) : place(without, from.clip, toTrack, desired)
  return moved === without ? p : settle(p, moved)
}

/** The free room around a clip: where the previous clip ends (or 0) and the next one starts. */
function room(clips: Clip[], index: number): { prevEnd: number; nextStart: number } {
  const prev = clips[index - 1]
  const next = clips[index + 1]
  return { prevEnd: prev ? clipEnd(prev) : 0, nextStart: next ? next.start : Infinity }
}

/**
 * Turns a video clip's loop on or off. On: the clip keeps its length and its
 * in becomes 0. Off: out is clamped to the source's duration. No-op (the same
 * project) for an image, audio, text or missing clip, or when nothing changes.
 */
export function setClipLoop(p: Project, clipId: string, loop: boolean): Project {
  const at = find(p, clipId)
  if (!at || isTextClip(at.clip)) return p
  const asset = Object.hasOwn(p.assets, at.clip.asset) ? p.assets[at.clip.asset] : undefined
  if (!asset || assetKind(asset) !== "video" || (at.clip.loop === true) === loop) return p
  const { loop: _drop, ...rest } = at.clip
  void _drop
  const next: Clip = loop ? { ...rest, in: 0, out: Math.min(at.clip.out - at.clip.in, maxLoopLength(asset)), loop: true } : { ...rest, out: Math.min(at.clip.out, asset.duration) }
  const clips = trackAt(p, at.track)!.clips
  return settle(p, withTrack(p, at.track, clips.map((c) => (c.id === clipId ? next : c))))
}

/**
 * Drags an edge to source time `seconds` (for an image, the edge moves by
 * `seconds - in`). The left edge moves `start` with `in` so the picture stays
 * where it was; neither edge passes a neighbour, 0 or MAX_TIMELINE, and
 * nothing else on the track moves. An image stretches freely up to its
 * neighbour (and MAX_IMAGE). On a snapped base the clips after it ripple
 * instead (the start stays, either edge), up to MAX_TIMELINE for the last one.
 */
export function trimClip(p: Project, id: string, edge: "in" | "out", seconds: number): Project {
  const at = find(p, id)
  const asset = at && (isTextClip(at.clip) ? undefined : p.assets[at.clip.asset])
  if (!at || (!asset && !isTextClip(at.clip)) || Number.isNaN(seconds)) return p
  const { clip, track, index } = at
  const clips = trackAt(p, track)!.clips
  // A text's animations shrink with it (fitAnims).
  const replace = (next: Clip) => settle(p, withTrack(p, track, clips.map((c) => (c.id === id ? fitted(next) : c))))
  // A text clip trims like an image.
  const looping = isLooping(p, clip)
  const image = !asset || assetKind(asset) === "image" || looping
  const cap = looping ? maxLoopLength(asset!) : MAX_IMAGE
  const start = clip.start
  const room0 = room(clips, index)
  const magnetic = track === 0 && isMagnetic(p)
  // The latest this clip may end: its neighbour, or on a snapped base where the clips after it would end at MAX_TIMELINE.
  const limit = magnetic ? MAX_TIMELINE - (trackEnd(p.tracks[0]) - clipEnd(clip)) : Math.min(room0.nextStart, MAX_TIMELINE)
  // On a snapped base the left edge may reach back by that same growth; the start stays and the rest ripples.
  const prevEnd = magnetic ? start - (limit - clipEnd(clip)) : room0.prevEnd
  const maxLength = limit - start
  if (edge === "in" && image) {
    // The right end stays; the length is clamped (to the previous clip or 0 too) and the start follows.
    const end = clipEnd(clip)
    const length = Math.max(MIN_CLIP, Math.min(cap, end - prevEnd, clipLength(clip) - (seconds - clip.in)))
    return replace({ ...clip, in: 0, out: length, start: magnetic ? start : end - length })
  }
  if (edge === "in") {
    // How far the left edge moves: at most to the previous clip (or 0), and leaving at least MIN_CLIP.
    const lo = Math.max(prevEnd - start, -clip.in)
    const hi = clipLength(clip) - MIN_CLIP
    // Only possible when the clip is already shorter than MIN_CLIP (the epsilon absorbs float rounding).
    if (hi < -1e-9) return p
    const delta = Math.max(lo, Math.min(seconds - clip.in, hi))
    return replace({ ...clip, in: clip.in + delta, start: magnetic ? start : start + delta })
  }
  if (image || !asset) return replace({ ...clip, in: 0, out: Math.max(MIN_CLIP, Math.min(cap, maxLength, seconds)) })
  const out = Math.min(asset.duration, clip.in + maxLength, Math.max(seconds, clip.in + MIN_CLIP))
  // Only possible when the asset itself is shorter than MIN_CLIP (the epsilon absorbs float rounding).
  if (out - clip.in < MIN_CLIP - 1e-9) return p
  return replace({ ...clip, out })
}

/**
 * A snapped base clip's left edge being dragged to source time `seconds`
 * (see trimClip), as it shows while the pointer is down: `draft` has the edge
 * where the pointer is, the start moving with it and nothing else on the track
 * moving (no packing, no ripple; it may reach over the previous clip, not past
 * 0, the source's start, MIN_CLIP or MAX_IMAGE). `seconds` is what to commit
 * on release with trimClip, which then packs the base as usual: the same edge
 * move, clamped as the draft was. Off a snapped base it's trimClip itself.
 */
export function leftTrimDraft(p: Project, id: string, seconds: number): { draft: Project; seconds: number } {
  const at = find(p, id)
  const still = at !== null && isStill(p, at.clip)
  if (!at || (!still && !p.assets[at.clip.asset]) || at.track !== 0 || !isMagnetic(p) || Number.isNaN(seconds)) return { draft: trimClip(p, id, "in", seconds), seconds }
  const { clip } = at
  // The most the committed trim may grow the clip: the base's end stays inside MAX_TIMELINE.
  const growth = MAX_TIMELINE - trackEnd(p.tracks[0])
  const length = clipLength(clip)
  const lo = -Math.min(clip.start, growth, still ? MAX_IMAGE - length : clip.in)
  const hi = length - MIN_CLIP
  if (hi < -1e-9) return { draft: p, seconds: clip.in }
  const delta = Math.max(lo, Math.min(seconds - clip.in, hi))
  const next: Clip = still ? { ...clip, out: length - delta, start: clip.start + delta } : { ...clip, in: clip.in + delta, start: clip.start + delta }
  return { draft: withTrack(p, 0, p.tracks[0].clips.map((c) => (c.id === id ? fitted(next) : c))), seconds: clip.in + delta }
}

/**
 * Writes every looping clip out as plain clips: a clip of length L on a source of duration D becomes ceil(L/D)
 * copies on its track (copy n starts at start + n*D, in 0, out min(D, L - n*D), id `${id}~${n}`; copy 0 keeps the id),
 * none with `loop`. Mirrors splitClip: the in side (edgeIn, and the links to the clip before: transition, cutAudio)
 * stays on copy 0, edgeOut goes to the last copy (each capped to that copy's length), everything else (transform, muted,
 * audio) is on every copy.
 * The same project when no clip loops past its source. Pure; for the preview and the export, never stored.
 */
export function expandLoops(p: Project): Project {
  const copies = (c: Clip): Clip[] | null => {
    if (!isLooping(p, c)) return null
    const d = p.assets[c.asset].duration
    const length = Math.min(c.out - c.in, maxLoopLength(p.assets[c.asset]))
    if (!(d > 0) || !(length > d + EPS)) return null
    const count = Math.ceil(length / d - EPS)
    const { loop: _loop, ...base } = c
    void _loop
    return Array.from({ length: count }, (_, n) => {
      const copy: Clip = { ...base, id: n === 0 ? c.id : `${c.id}~${n}`, start: c.start + n * d, in: 0, out: n === count - 1 ? Math.min(d, length - n * d) : d }
      if (n > 0) { delete copy.edgeIn; delete copy.transition; delete copy.cutAudio }
      if (n < count - 1) delete copy.edgeOut
      // An edge effect sized to the whole loop is capped to the copy it lands on (a copy has no more footage).
      const own = copy.out - copy.in
      if (copy.edgeIn && copy.edgeIn.duration > own) copy.edgeIn = { ...copy.edgeIn, duration: own }
      if (copy.edgeOut && copy.edgeOut.duration > own) copy.edgeOut = { ...copy.edgeOut, duration: own }
      return copy
    })
  }
  let changed = false
  const tracks = p.tracks.map((t) => {
    if (!t.clips.some((c) => copies(c))) return t
    changed = true
    return { ...t, clips: t.clips.flatMap((c) => copies(c) ?? [c]) }
  })
  return changed ? { ...p, tracks } : p
}

/** The editor's clip id for a clip of the expanded project (copy `c~2` of a loop is clip `c`); ids are hex, so `~` never occurs in a real one. */
export const loopSourceId = (id: string): string => id.split("~")[0]

/** Cuts a clip in two at `timelineTime`; the second part gets `newId` and starts there. */
export function splitClip(p: Project, id: string, timelineTime: number, newId: string): Project {
  const at = find(p, id)
  if (!at || !Number.isFinite(timelineTime) || hasClip(p, newId)) return p
  const { clip, track, index } = at
  const clips = trackAt(p, track)!.clips
  const local = timelineTime - clip.start
  if (local < MIN_CLIP || clipLength(clip) - local < MIN_CLIP) return p
  const next = [...clips]
  // Both halves keep the picture where it was, the mute, the audio levels and the text; the first half keeps a text's in animation, the second its out one.
  // So with edge transitions: the first keeps the in edge, the second the out edge (each fitted to its piece by settle).
  const texts = clip.text ? splitAnims(clip.text, local, clipLength(clip) - local) : null
  const second = {
    start: timelineTime, ...(clip.transform ? { transform: clip.transform } : {}), ...(clip.muted ? { muted: true } : {}), ...(texts ? { text: texts[1] } : {}),
    ...(clip.edgeOut ? { edgeOut: clip.edgeOut } : {}), ...(clip.audio ? { audio: clip.audio } : {}), ...(clip.key ? { key: clip.key } : {}),
  }
  const first = withoutEdge(clip, "out")
  if (isStill(p, clip)) {
    next.splice(index, 1, { ...first, in: 0, out: local, ...(texts ? { text: texts[0] } : {}) }, { id: newId, asset: clip.asset, in: 0, out: clipLength(clip) - local, ...second })
  } else {
    const cut = clip.in + local
    next.splice(index, 1, { ...first, out: cut }, { id: newId, asset: clip.asset, in: cut, out: clip.out, ...second })
  }
  // The second piece takes over the clip's place before the next clip, and with it that clip's transition.
  return settle(p, withTrack(p, track, next), { [newId]: id })
}

const sameTransform = (a: Transform | undefined, b: Transform | undefined) =>
  isIdentity(a) && isIdentity(b)
    ? true
    : a !== undefined && b !== undefined && a.x === b.x && a.y === b.y && a.scale === b.scale && a.cropTop === b.cropTop && a.cropBottom === b.cropBottom &&
      cropLeftOf(a) === cropLeftOf(b) && cropRightOf(a) === cropRightOf(b) && rotationOf(a) === rotationOf(b) && !a.flipH === !b.flipH && !a.flipV === !b.flipV

/** Sets a clip's transform (clamped into its limits); the identity removes the field. The same project when nothing changes, or for an audio clip (no picture). */
export function setTransform(p: Project, clipId: string, t: Transform): Project {
  const at = find(p, clipId)
  if (!at || at.track === AUDIO_TRACK) return p
  const next = normalizeTransform(t)
  if (sameTransform(at.clip.transform, next)) return p
  const clip: Clip = { ...at.clip, transform: next }
  if (isIdentity(next)) delete clip.transform
  return withTrack(p, at.track, p.tracks[at.track].clips.map((c) => (c.id === clipId ? clip : c)))
}

/**
 * Points a video or sound clip at another asset of the same kind (a retimed
 * copy of its media, or the original again) with the trim `inSec` to `outSec` of that asset, and
 * fits the layer to the clip's new length: a snapped base packs, on another
 * layer the clips after it move later if it grew into them. A looping clip is
 * left alone (turn Loop off first). The same project when it can't be done.
 */
export function retimeClip(p: Project, clipId: string, assetId: string, inSec: number, outSec: number): Project {
  const at = find(p, clipId)
  const asset = Object.hasOwn(p.assets, assetId) ? p.assets[assetId] : undefined
  if (!at || isTextClip(at.clip) || at.clip.loop || !asset || assetKind(asset) === "image") return p
  // A video stays a video and a sound a sound.
  if (assetKind(asset) !== assetKind(p.assets[at.clip.asset] ?? asset)) return p
  if (!(inSec >= 0) || !(outSec > inSec) || outSec > asset.duration + 1e-3 || outSec - inSec < MIN_CLIP - EPS) return p
  const clip: Clip = { ...at.clip, asset: assetId, in: inSec, out: Math.min(outSec, asset.duration) }
  let cursor = clipEnd(clip)
  let end = cursor
  const clips = sortByStart(trackAt(p, at.track)!.clips.map((c) => (c.id === clipId ? clip : c))).map((c) => {
    if (c.id === clipId) return c
    if (c.start >= at.clip.start - EPS && c.start < cursor - EPS) {
      const shifted = { ...c, start: cursor }
      cursor = clipEnd(shifted)
      end = Math.max(end, cursor)
      return shifted
    }
    if (c.start >= at.clip.start - EPS) cursor = Math.max(cursor, clipEnd(c))
    end = Math.max(end, clipEnd(c))
    return c
  })
  if (end > MAX_TIMELINE + EPS) return p
  return settle(p, withTrack(p, at.track, clips))
}

/**
 * Ripple delete: takes a clip out and moves every later clip on its layer
 * earlier by its length, closing the gap (a snapped base does that anyway).
 * Other layers stay as they are.
 */
export function rippleRemoveClip(p: Project, id: string): Project {
  const at = find(p, id)
  if (!at) return p
  if (at.track === 0 && isMagnetic(p)) return removeClip(p, id)
  const length = clipLength(at.clip)
  const end = clipEnd(at.clip)
  const clips = trackAt(p, at.track)!.clips.filter((c) => c.id !== id).map((c) => (c.start >= end - EPS ? { ...c, start: Math.max(0, c.start - length) } : c))
  return settle(p, withTrack(p, at.track, clips))
}

/**
 * A copy of `clip` (a clip copied earlier, with every setting: picture
 * placement, key, audio levels, mute, text, loop, edge transitions) pasted at
 * `start` on layer `trackIndex` (layer 1 when it's gone, a new layer one past
 * the top; a sound always on the audio layer) as clip `id`; the clips from there
 * on move later to make room, or it goes at its slot on a snapped base. With
 * `on` (the clip under the pointer) it goes in front of or behind that clip. Its transition and audio overlap with the neighbours it had
 * are left behind. The same project when its media is no longer in the
 * project, the id is taken or there's no room.
 */
export function pasteClip(p: Project, clip: Clip, trackIndex: number, start: number, id: string, on?: { clip: string; mode: "before" | "after" }): Project {
  if (hasClip(p, id) || !Number.isFinite(start)) return p
  const text = isTextClip(clip)
  if (!text && !Object.hasOwn(p.assets, clip.asset)) return p
  const audio = !text && assetKind(p.assets[clip.asset]) === "audio"
  const track = audio ? AUDIO_TRACK : Number.isInteger(trackIndex) && trackIndex >= 0 && trackIndex <= p.tracks.length ? trackIndex : 0
  const { transition: _transition, cutAudio: _cutAudio, ...rest } = clip
  void _transition
  void _cutAudio
  const copy: Clip = { ...(JSON.parse(JSON.stringify(rest)) as Clip), id, start: Math.max(0, start) }
  // On a clip: in front of it or behind it (as dropped media goes); anywhere else, at that time with later clips pushed along.
  if (on) {
    const placed = insertOnClip(p, copy, on, p)
    if (placed !== p) return placed
  }
  return insertAtTime(p, copy, track, Math.max(0, start), p)
}

/** Takes a clip out, leaving a gap (nothing ripples; on a snapped base the clips after it close the gap). */
export function removeClip(p: Project, id: string): Project {
  const at = find(p, id)
  if (!at) return p
  return settle(p, withTrack(p, at.track, trackAt(p, at.track)!.clips.filter((c) => c.id !== id)))
}

/**
 * Takes an asset out of the project: its entry in `assets` and every clip on
 * every track that uses it (each leaves a gap, closed on a snapped base). `removedClips` counts them.
 * An unknown id gives back the same project and 0. deleteAssetAction does
 * this on the server; the editor applies it locally with the action's reply.
 */
export function removeAsset(p: Project, assetId: string): { project: Project; removedClips: number } {
  if (!Object.hasOwn(p.assets, assetId)) return { project: p, removedClips: 0 }
  let removedClips = 0
  const tracks = p.tracks.map((t) => {
    const clips = t.clips.filter((c) => isTextClip(c) || c.asset !== assetId)
    removedClips += t.clips.length - clips.length
    return clips.length === t.clips.length ? t : { ...t, clips }
  })
  const assets = { ...p.assets }
  delete assets[assetId]
  let next: Project = { ...p, assets, tracks }
  if (p.audioTrack) {
    const kept = p.audioTrack.clips.filter((c) => c.asset !== assetId)
    removedClips += p.audioTrack.clips.length - kept.length
    next = withTrack(next, AUDIO_TRACK, kept)
  }
  return { project: settle(p, next), removedClips }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

const MAX_SIZE = 7680
const MAX_FPS = 120
const MAX_NAME = 200
const MAX_SOURCE = 400
const MAX_TITLE = 120
const MAX_TRACK_ID = 64

/** A whole number from 1 to `max`; these end up inside an ffmpeg filtergraph. */
function isInt(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max
}

/**
 * A project from project.json (or a client), or null when it doesn't
 * validate; always version 3. Version 1 files (one flat `clips` list) and
 * version 2 base tracks (no starts) get their base clips laid end to end from
 * 0, the layout they had; version 2 overlay starts are kept. In version 3
 * every clip needs a finite start >= 0. Each track comes back sorted by start,
 * and clips overlapping on a track, or ending past MAX_TIMELINE, are refused.
 * `magnetic` must be a boolean; it's kept on the base only, whose clips are
 * then packed end to end (gaps and overlaps there aren't refused). A clip's
 * `muted` must be a boolean (kept only when true); an older file's track
 * `muted: true` is read as `muted: true` on every clip of that track. A text
 * clip has asset "" and a valid `text` (lib/video/text), times like an image
 * and is never muted. A `transition` needs a known type and a duration from
 * MIN_TRANSITION to MAX_TRANSITION, and a `cutAudio` a mode ("j" or "l") and
 * a duration from MIN_CUT_AUDIO to MAX_CUT_AUDIO; one with no clip adjoining
 * it is dropped and one longer than its footage allows is shortened
 * (fixTransitions). A transition of the other family (a picture type on the
 * audio layer, an audio one elsewhere) and any audio overlap on the audio
 * layer are dropped. `edgeIn` and `edgeOut` need a known type and a duration
 * from MIN_EDGE to MAX_EDGE; one the clip can't have at that edge
 * (isEdgeType, or any on a text clip) is dropped, as is one at an edge a clip
 * adjoins, and the two are fitted to the clip's length (fixEdges). `audio`
 * must validate (normalizeClipAudio); it's kept only on a clip with sound.
 */
export function parseProject(json: unknown): Project | null {
  if (!isRecord(json) || (json.version !== 1 && json.version !== 2 && json.version !== 3)) return null
  const { name, width, height, fps, assets } = json
  if (typeof name !== "string" || name.length > MAX_NAME || !isInt(width, MAX_SIZE) || !isInt(height, MAX_SIZE) || !isInt(fps, MAX_FPS)) return null
  if (!isRecord(assets)) return null
  if (json.formatChosen !== undefined && json.formatChosen !== true) return null
  const rawTracks: unknown = json.version === 1 ? (Array.isArray(json.clips) ? [{ id: "t1", clips: json.clips }] : null) : json.tracks
  if (!Array.isArray(rawTracks) || rawTracks.length < 1 || rawTracks.length > MAX_TRACKS) return null

  const parsedAssets: Record<string, Asset> = {}
  for (const [key, a] of Object.entries(assets)) {
    if (key === "__proto__") return null
    if (!isRecord(a) || typeof a.file !== "string" || !isNum(a.duration) || typeof a.hasAudio !== "boolean") return null
    if (a.kind !== undefined && a.kind !== "image" && a.kind !== "video" && a.kind !== "audio") return null
    if (a.loopByDefault !== undefined && typeof a.loopByDefault !== "boolean") return null
    if (a.source !== undefined && (typeof a.source !== "string" || a.source.length > MAX_SOURCE)) return null
    parsedAssets[key] = { file: a.file, duration: a.duration, hasAudio: a.hasAudio }
    if (a.kind !== undefined) parsedAssets[key].kind = a.kind
    if (a.source !== undefined) parsedAssets[key].source = a.source
    if (a.loopByDefault === true) parsedAssets[key].loopByDefault = true
    if (a.retime !== undefined) {
      if (!isValidRetime(a.retime)) return null
      const { source, speed, reverse, from, to } = a.retime
      parsedAssets[key].retime = { source, speed, reverse, from, to }
    }
    // A title is cosmetic: anything unusable is dropped rather than rejecting the project.
    const title = typeof a.title === "string" ? a.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE).trim() : ""
    if (title) parsedAssets[key].title = title
  }

  // The audio layer is read after the other tracks, with the same rules and its own (audioOnly).
  const rawAudio: unknown = json.audioTrack
  if (rawAudio !== undefined && !isRecord(rawAudio)) return null
  const ids = new Set<string>()
  const trackIds = new Set<string>()
  const tracks: Track[] = []
  for (const [t, raw] of (rawAudio === undefined ? rawTracks : [...rawTracks, rawAudio]).entries()) {
    const audioOnly = t === rawTracks.length
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length < 1 || raw.id.length > MAX_TRACK_ID || trackIds.has(raw.id)) return null
    if (raw.muted !== undefined && typeof raw.muted !== "boolean") return null
    if (raw.magnetic !== undefined && typeof raw.magnetic !== "boolean") return null
    if (!Array.isArray(raw.clips)) return null
    trackIds.add(raw.id)
    // Before version 3 the base track had no starts: its clips ran end to end.
    const endToEndBase = t === 0 && json.version !== 3
    let clips: Clip[] = []
    let baseEnd = 0
    for (const c of raw.clips) {
      if (!isRecord(c) || typeof c.id !== "string" || typeof c.asset !== "string" || !isNum(c.in) || !isNum(c.out)) return null
      // A text clip names no asset ("") and carries a valid text; any other clip names one of the project's assets.
      let text: ClipText | null = null
      if (c.text !== undefined) {
        text = normalizeText(c.text)
        if (!text || c.asset !== "") return null
      } else if (!Object.hasOwn(parsedAssets, c.asset)) return null
      if (ids.has(c.id)) return null
      if (c.muted !== undefined && typeof c.muted !== "boolean") return null
      const asset = text ? null : parsedAssets[c.asset]
      // Audio clips live on the audio layer, and only they do.
      if (audioOnly !== (asset !== null && assetKind(asset) === "audio")) return null
      // A text clip times like an image.
      if (c.loop !== undefined && (typeof c.loop !== "boolean" || (c.loop && (!asset || assetKind(asset) !== "video")))) return null
      if (c.loop === true) {
        if (c.in !== 0 || c.out < MIN_CLIP - 1e-9 || c.out > maxLoopLength(asset!)) return null
      } else if (!asset || assetKind(asset) === "image") {
        // The epsilon absorbs float rounding from a split.
        if (c.in !== 0 || c.out < MIN_CLIP - 1e-9 || c.out > MAX_IMAGE) return null
      } else if (c.in < 0 || c.out <= c.in || c.out > asset.duration) return null
      ids.add(c.id)
      let start: number
      if (endToEndBase) {
        start = baseEnd
        baseEnd += c.out - c.in
      } else {
        if (!isNum(c.start) || c.start < 0) return null
        start = c.start
      }
      const clip: Clip = { id: c.id, asset: c.asset, in: c.in, out: c.out, start }
      if (c.loop === true) clip.loop = true
      if (c.key !== undefined) {
        // Only a picture (an image or a video) is keyed.
        if (!isValidKey(c.key) || !asset || assetKind(asset) === "audio") return null
        clip.key = { key: [...c.key.key] as KeyOptions["key"], tolerance: c.key.tolerance, contiguous: c.key.contiguous }
      }
      // An audio clip has no picture to transform: the field is dropped.
      if (c.transform !== undefined && !audioOnly) {
        if (!isValidTransform(c.transform)) return null
        // Only the transform's own fields; a zero left or right crop or rotation and a false flip are left out.
        if (!isIdentity(c.transform)) {
          const { x, y, scale, cropTop, cropBottom, cropLeft, cropRight, rotation, flipH, flipV } = c.transform
          clip.transform = {
            x, y, scale, cropTop, cropBottom,
            ...(cropLeft ? { cropLeft } : {}), ...(cropRight ? { cropRight } : {}), ...(rotation ? { rotation } : {}),
            ...(flipH ? { flipH } : {}), ...(flipV ? { flipV } : {}),
          }
        }
      }
      // Animations longer than the clip are fitted to it.
      if (text) clip.text = fitAnims(text, clip.out - clip.in)
      // A text clip has no sound to mute.
      else if (c.muted === true || raw.muted === true) clip.muted = true
      if (c.transition !== undefined) {
        const tr = c.transition
        if (!isRecord(tr) || !isAnyTransitionType(tr.type) || !isNum(tr.duration) || tr.duration < MIN_TRANSITION - 1e-9 || tr.duration > MAX_TRANSITION + 1e-9) return null
        // An audio type on the audio layer, a picture one anywhere else; the other family is dropped.
        if (audioOnly ? isAudioTransitionType(tr.type) : isTransitionType(tr.type)) clip.transition = { type: tr.type, duration: tr.duration }
      }
      if (c.cutAudio !== undefined && !audioOnly) {
        const ca = c.cutAudio
        if (!isRecord(ca) || !isCutAudioMode(ca.mode) || !isNum(ca.duration) || ca.duration < MIN_CUT_AUDIO - 1e-9 || ca.duration > MAX_CUT_AUDIO + 1e-9) return null
        clip.cutAudio = { mode: ca.mode, duration: ca.duration }
      }
      for (const [key, edge] of [["edgeIn", "in"], ["edgeOut", "out"]] as const) {
        const e = c[key]
        if (e === undefined) continue
        if (!isRecord(e) || !isAnyTransitionType(e.type) || !isNum(e.duration) || e.duration < MIN_EDGE - 1e-9 || e.duration > MAX_EDGE + 1e-9) return null
        // A type that edge of this clip can't have (a picture one on an audio clip, or any on a text, whose animations do this) is dropped.
        if (!text && isEdgeType(e.type, edge, audioOnly)) clip[key] = { type: e.type, duration: e.duration }
      }
      if (c.audio !== undefined) {
        const audio = normalizeClipAudio(c.audio)
        if (audio === null) return null
        // Only a clip with sound keeps its levels (an image's, a text's or a silent video's are dropped).
        if (audio && asset && asset.hasAudio && assetKind(asset) !== "image") clip.audio = audio
      }
      // Nothing may end past MAX_TIMELINE (a forged start would make a huge timeline and export).
      if (clipEnd(clip) > MAX_TIMELINE + EPS) return null
      clips.push(clip)
    }
    clips = sortByStart(clips)
    // A snapped base is packed again (a stray gap or overlap can't stay); the flag counts on the base only.
    const magnetic = t === 0 && raw.magnetic === true
    if (magnetic) {
      clips = endToEnd(clips)
      if (clips.length > 0 && clipEnd(clips[clips.length - 1]) > MAX_TIMELINE + EPS) return null
    }
    for (let i = 1; i < clips.length; i++) {
      if (clipEnd(clips[i - 1]) > clips[i].start + EPS) return null
    }
    tracks.push({ id: raw.id, ...(magnetic ? { magnetic: true } : {}), clips })
  }

  // Kept only while it has clips, so a project without audio stays as it was.
  const audioTrack = rawAudio === undefined ? undefined : tracks.pop()
  // A transition or audio overlap with no clip adjoining it goes, and one longer than its footage allows is shortened (fixTransitions).
  return fixTransitions({ version: 3, name, width, height, fps, ...(json.formatChosen === true ? { formatChosen: true as const } : {}), assets: parsedAssets, tracks, ...(audioTrack && audioTrack.clips.length > 0 ? { audioTrack } : {}) })
}

/**
 * A client-sent project laid over the stored one: assets, name and settings
 * are server-owned (a stale tab can't revert a rename), so only the client's
 * tracks are taken. Null when it doesn't validate, holds more than MAX_CLIPS
 * clips, or a clip points at an asset the stored project doesn't have. A
 * track `muted` (the old layer mute, gone from the editor) is stripped, so a
 * client can't mute a whole track; clips carry their own mute.
 */
export function mergeClientProject(client: unknown, stored: Project): Project | null {
  const tracks = isRecord(client) && Array.isArray(client.tracks) ? client.tracks.map((t) => (isRecord(t) ? { ...t, muted: undefined } : t)) : undefined
  const audio = isRecord(client) && isRecord(client.audioTrack) ? { audioTrack: { ...client.audioTrack, muted: undefined } } : {}
  const parsed = parseProject(tracks ? { ...(client as Record<string, unknown>), tracks, ...audio } : client)

  if (!parsed) return null
  const clips = allClips(parsed)
  if (clips.length > MAX_CLIPS) return null
  // A text clip uses no asset.
  if (!clips.every((c) => isTextClip(c) || Object.hasOwn(stored.assets, c.asset))) return null
  const { name, width, height, fps, assets, formatChosen } = stored
  return parseProject({ ...parsed, name, width, height, fps, formatChosen, assets })
}
