/**
 * An imported file. `kind` is absent for videos (older projects have no kind).
 * For an image, `duration` is its default clip length. `source` is the Inbox
 * path it was copied from ("<folder>/<name>"), so a second import reuses it.
 */
export type Asset = { file: string; duration: number; hasAudio: boolean; kind?: "image" | "video"; source?: string }
/** `start` (seconds on the timeline) is set on overlay tracks only; the base track lays its clips end to end. */
export type Clip = { id: string; asset: string; in: number; out: number; start?: number }
/**
 * A layer. Track 0 is the base: magnetic, clips end to end, an edit ripples.
 * Higher tracks are overlays: clips sit at their own `start`, gaps allowed, no
 * overlaps; a higher track draws over a lower one. `muted` silences a track.
 */
export type Track = { id: string; muted?: boolean; clips: Clip[] }
export type Project = {
  version: 2
  name: string
  width: number
  height: number
  fps: number
  assets: Record<string, Asset>
  tracks: Track[]
}

/** The part of a project that undo/redo covers; assets, name and settings are server-owned and never undone. */
export type Edit = { tracks: Track[] }

export const MIN_CLIP = 0.2
/** Default and longest length of an image clip, in seconds. */
export const DEFAULT_IMAGE = 5
export const MAX_IMAGE = 600
/** The base track plus up to three overlay layers. */
export const MAX_TRACKS = 4
/** Most clips a project may hold, over all tracks. */
export const MAX_CLIPS = 5000
/** Overlay clips closer than this count as touching, not overlapping (float rounding). */
const EPS = 1e-6

export function assetKind(a: Asset): "image" | "video" {
  return a.kind === "image" ? "image" : "video"
}

/** Every asset copied from this Inbox path ("<folder>/<name>"), oldest first; a deleted copy can leave more than one. */
export function findAssetsBySource(p: Project, source: string): { id: string; asset: Asset }[] {
  if (!source) return []
  return Object.entries(p.assets).filter(([, asset]) => asset.source === source).map(([id, asset]) => ({ id, asset }))
}

export function newProject(name: string): Project {
  return { version: 2, name, width: 1920, height: 1080, fps: 30, assets: {}, tracks: [{ id: "t1", clips: [] }] }
}

export function clipLength(c: Clip): number {
  return c.out - c.in
}

/** Start times of clips laid end to end (the base track). */
export function clipStarts(clips: Clip[]): number[] {
  const starts: number[] = []
  let t = 0
  for (const c of clips) {
    starts.push(t)
    t += clipLength(c)
  }
  return starts
}

/** Every clip on every track, base track first. */
export function allClips(p: Project): Clip[] {
  return p.tracks.flatMap((t) => t.clips)
}

/** Each clip's start on the timeline: end to end on the base track, `start` on an overlay. */
export function trackStarts(track: Track, isBase: boolean): number[] {
  return isBase ? clipStarts(track.clips) : track.clips.map((c) => c.start ?? 0)
}

/** Where the track's last clip ends. */
export function trackEnd(track: Track, isBase: boolean): number {
  const starts = trackStarts(track, isBase)
  return track.clips.reduce((end, c, i) => Math.max(end, starts[i] + clipLength(c)), 0)
}

/** The timeline's length: the latest clip end over all tracks. */
export function totalLength(p: Project): number {
  return p.tracks.reduce((end, t, i) => Math.max(end, trackEnd(t, i === 0)), 0)
}

/** The clip playing at `timelineTime` on the base track (clips end to end) and the time inside its source file; null before 0 or at/after the end. */
export function clipAt(clips: Clip[], timelineTime: number): { index: number; sourceTime: number } | null {
  if (!(timelineTime >= 0)) return null
  const starts = clipStarts(clips)
  for (let i = 0; i < clips.length; i++) {
    if (timelineTime < starts[i] + clipLength(clips[i])) return { index: i, sourceTime: clips[i].in + (timelineTime - starts[i]) }
  }
  return null
}

/** The clip on `track` at `timelineTime`: its index, start and the time inside its source; null in a gap or past the end. */
export function trackClipAt(track: Track, isBase: boolean, timelineTime: number): { index: number; start: number; sourceTime: number } | null {
  if (!(timelineTime >= 0)) return null
  const starts = trackStarts(track, isBase)
  for (let i = 0; i < track.clips.length; i++) {
    const c = track.clips[i]
    if (timelineTime >= starts[i] && timelineTime < starts[i] + clipLength(c)) return { index: i, start: starts[i], sourceTime: c.in + (timelineTime - starts[i]) }
  }
  return null
}

export type ActiveClip = { track: number; index: number; start: number; sourceTime: number; clip: Clip }

/** The clip playing on each track at `timelineTime` (null where nothing plays), and the topmost of them (the one you see). */
export function clipsAt(p: Project, timelineTime: number): { tracks: (ActiveClip | null)[]; top: ActiveClip | null } {
  const tracks = p.tracks.map((t, track) => {
    const at = trackClipAt(t, track === 0, timelineTime)
    return at && { track, ...at, clip: t.clips[at.index] }
  })
  let top: ActiveClip | null = null
  for (const hit of tracks) if (hit) top = hit
  return { tracks, top }
}

/**
 * The first start at or after `desired` (and at least 0) where a clip of
 * `length` fits between `clips` (an overlay track) without overlapping: it
 * slides past the neighbour it would overlap, and on past the next one if
 * there's no room. `ignore` is a clip id to leave out (the one being moved).
 */
export function resolveStart(clips: Clip[], length: number, desired: number, ignore?: string): number {
  let t = Math.max(0, Number.isFinite(desired) ? desired : 0)
  const others = clips.filter((c) => c.id !== ignore).sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
  for (const c of others) {
    const s = c.start ?? 0
    const e = s + clipLength(c)
    if (s < t + length - EPS && t < e - EPS) t = e
  }
  return t
}

const sortByStart = (clips: Clip[]) => [...clips].sort((a, b) => (a.start ?? 0) - (b.start ?? 0))

function find(p: Project, id: string): { track: number; index: number; clip: Clip } | null {
  for (let track = 0; track < p.tracks.length; track++) {
    const index = p.tracks[track].clips.findIndex((c) => c.id === id)
    if (index >= 0) return { track, index, clip: p.tracks[track].clips[index] }
  }
  return null
}

const hasClip = (p: Project, id: string) => find(p, id) !== null

function withTrack(p: Project, index: number, clips: Clip[]): Project {
  return { ...p, tracks: p.tracks.map((t, i) => (i === index ? { ...t, clips } : t)) }
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

export function setTrackMuted(p: Project, id: string, muted: boolean): Project {
  const index = p.tracks.findIndex((t) => t.id === id)
  if (index < 0 || Boolean(p.tracks[index].muted) === muted) return p
  return {
    ...p,
    tracks: p.tracks.map((t, i) => (i !== index ? t : muted ? { ...t, muted: true } : { id: t.id, clips: t.clips })),
  }
}

/** Puts `clip` on track `trackIndex` (one past the top adds a layer): at `at.index` on the base, at `at.start` (slid clear of overlaps) on an overlay. */
function place(p: Project, clip: Clip, trackIndex: number, at: { index?: number; start?: number }): Project {
  if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex > p.tracks.length) return p
  let q = p
  if (trackIndex === p.tracks.length) {
    q = addTrack(p)
    if (q === p) return p
  }
  const bare: Clip = { id: clip.id, asset: clip.asset, in: clip.in, out: clip.out }
  const clips = q.tracks[trackIndex].clips
  if (trackIndex === 0) {
    const next = [...clips]
    next.splice(Math.max(0, Math.min(at.index ?? clips.length, clips.length)), 0, bare)
    return withTrack(q, 0, next)
  }
  const start = resolveStart(clips, clipLength(clip), at.start ?? 0, clip.id)
  return withTrack(q, trackIndex, sortByStart([...clips.filter((c) => c.id !== clip.id), { ...bare, start }]))
}

/**
 * A new clip of the whole asset (an image: DEFAULT_IMAGE long). On the base
 * track it goes in at `at.index` and the rest ripple; on an overlay it goes at
 * `at.start`, sliding past any clip it would overlap. A track index one past
 * the top adds a layer for it (up to MAX_TRACKS).
 */
export function addClip(p: Project, assetId: string, trackIndex: number, at: { index?: number; start?: number }, id: string): Project {
  const asset = p.assets[assetId]
  if (!asset || asset.duration < MIN_CLIP || hasClip(p, id)) return p
  return place(p, { id, asset: assetId, in: 0, out: assetKind(asset) === "image" ? DEFAULT_IMAGE : asset.duration }, trackIndex, at)
}

/** Moves a clip within its track or to another one (in and out stay); see addClip for where it lands. */
export function moveClip(p: Project, id: string, toTrack: number, at: { index?: number; start?: number }): Project {
  const from = find(p, id)
  if (!from || !Number.isInteger(toTrack) || toTrack < 0 || toTrack > p.tracks.length) return p
  const without = withTrack(p, from.track, p.tracks[from.track].clips.filter((c) => c.id !== id))
  const moved = place(without, from.clip, toTrack, at)
  return moved === without ? p : moved
}

/** The free room around an overlay clip: where the previous clip ends and the next one starts. */
function room(clips: Clip[], index: number): { prevEnd: number; nextStart: number } {
  const prev = clips[index - 1]
  const next = clips[index + 1]
  return { prevEnd: prev ? (prev.start ?? 0) + clipLength(prev) : 0, nextStart: next ? next.start ?? 0 : Infinity }
}

/**
 * Drags an edge to source time `seconds` (for an image, the edge moves by
 * `seconds - in`). On the base track the rest ripple. On an overlay the left
 * edge moves `start` with `in` so the picture stays where it was, and neither
 * edge passes a neighbour or 0.
 */
export function trimClip(p: Project, id: string, edge: "in" | "out", seconds: number): Project {
  const at = find(p, id)
  const asset = at && p.assets[at.clip.asset]
  if (!at || !asset || Number.isNaN(seconds)) return p
  const { clip, track, index } = at
  const clips = p.tracks[track].clips
  const replace = (next: Clip) => withTrack(p, track, clips.map((c) => (c.id === id ? next : c)))
  const image = assetKind(asset) === "image"

  if (track > 0) {
    const start = clip.start ?? 0
    const { prevEnd, nextStart } = room(clips, index)
    const maxLength = nextStart - start
    if (edge === "in") {
      // How far the left edge moves: at most to the previous clip (or 0), and leaving at least MIN_CLIP.
      const lo = Math.max(prevEnd - start, image ? clipLength(clip) - MAX_IMAGE : -clip.in)
      const hi = clipLength(clip) - MIN_CLIP
      const delta = Math.max(lo, Math.min(seconds - clip.in, hi))
      if (image) return replace({ ...clip, in: 0, out: clipLength(clip) - delta, start: start + delta })
      return replace({ ...clip, in: clip.in + delta, start: start + delta })
    }
    if (image) return replace({ ...clip, in: 0, out: Math.max(MIN_CLIP, Math.min(MAX_IMAGE, maxLength, seconds)) })
    const out = Math.min(asset.duration, clip.in + maxLength, Math.max(seconds, clip.in + MIN_CLIP))
    if (out - clip.in < MIN_CLIP - 1e-9) return p
    return replace({ ...clip, out })
  }

  if (image) {
    // An image has no source to run out of: either edge just changes the length, and `in` stays 0.
    const length = edge === "out" ? seconds : clipLength(clip) - (seconds - clip.in)
    const out = Math.max(MIN_CLIP, Math.min(MAX_IMAGE, length))
    return replace({ ...clip, in: 0, out })
  }
  const next = { ...clip }
  if (edge === "in") {
    next.in = Math.max(0, Math.min(seconds, clip.out - MIN_CLIP))
  } else {
    next.out = Math.min(asset.duration, Math.max(seconds, clip.in + MIN_CLIP))
  }
  // Only possible when the asset itself is shorter than MIN_CLIP (the epsilon absorbs float rounding).
  if (clipLength(next) < MIN_CLIP - 1e-9) return p
  return replace(next)
}

/** Cuts a clip in two at `timelineTime`; the second part gets `newId` (and, on an overlay, starts there). */
export function splitClip(p: Project, id: string, timelineTime: number, newId: string): Project {
  const at = find(p, id)
  if (!at || !Number.isFinite(timelineTime) || hasClip(p, newId)) return p
  const { clip, track, index } = at
  const clips = p.tracks[track].clips
  const start = track === 0 ? clipStarts(clips)[index] : clip.start ?? 0
  const local = timelineTime - start
  if (local < MIN_CLIP || clipLength(clip) - local < MIN_CLIP) return p
  const next = [...clips]
  const asset = p.assets[clip.asset]
  const second = track === 0 ? {} : { start: timelineTime }
  if (asset && assetKind(asset) === "image") {
    next.splice(index, 1, { ...clip, in: 0, out: local }, { id: newId, asset: clip.asset, in: 0, out: clipLength(clip) - local, ...second })
  } else {
    const cut = clip.in + local
    next.splice(index, 1, { ...clip, out: cut }, { id: newId, asset: clip.asset, in: cut, out: clip.out, ...second })
  }
  return withTrack(p, track, next)
}

/** Takes a clip out: the base track closes the gap, an overlay keeps it. */
export function removeClip(p: Project, id: string): Project {
  const at = find(p, id)
  if (!at) return p
  return withTrack(p, at.track, p.tracks[at.track].clips.filter((c) => c.id !== id))
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
const MAX_TRACK_ID = 64

/** A whole number from 1 to `max`; these end up inside an ffmpeg filtergraph. */
function isInt(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max
}

/**
 * A project from project.json (or a client), or null when it doesn't
 * validate. Version 1 files (one flat `clips` list) come back as version 2
 * with those clips on the base track.
 */
export function parseProject(json: unknown): Project | null {
  if (!isRecord(json) || (json.version !== 1 && json.version !== 2)) return null
  const { name, width, height, fps, assets } = json
  if (typeof name !== "string" || name.length > MAX_NAME || !isInt(width, MAX_SIZE) || !isInt(height, MAX_SIZE) || !isInt(fps, MAX_FPS)) return null
  if (!isRecord(assets)) return null
  const rawTracks: unknown = json.version === 1 ? (Array.isArray(json.clips) ? [{ id: "t1", clips: json.clips }] : null) : json.tracks
  if (!Array.isArray(rawTracks) || rawTracks.length < 1 || rawTracks.length > MAX_TRACKS) return null

  const parsedAssets: Record<string, Asset> = {}
  for (const [key, a] of Object.entries(assets)) {
    if (key === "__proto__") return null
    if (!isRecord(a) || typeof a.file !== "string" || !isNum(a.duration) || typeof a.hasAudio !== "boolean") return null
    if (a.kind !== undefined && a.kind !== "image" && a.kind !== "video") return null
    if (a.source !== undefined && (typeof a.source !== "string" || a.source.length > MAX_SOURCE)) return null
    parsedAssets[key] = { file: a.file, duration: a.duration, hasAudio: a.hasAudio }
    if (a.kind !== undefined) parsedAssets[key].kind = a.kind
    if (a.source !== undefined) parsedAssets[key].source = a.source
  }

  const ids = new Set<string>()
  const trackIds = new Set<string>()
  const tracks: Track[] = []
  for (const [t, raw] of rawTracks.entries()) {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length < 1 || raw.id.length > MAX_TRACK_ID || trackIds.has(raw.id)) return null
    if (raw.muted !== undefined && typeof raw.muted !== "boolean") return null
    if (!Array.isArray(raw.clips)) return null
    trackIds.add(raw.id)
    const isBase = t === 0
    let clips: Clip[] = []
    for (const c of raw.clips) {
      if (!isRecord(c) || typeof c.id !== "string" || typeof c.asset !== "string" || !isNum(c.in) || !isNum(c.out)) return null
      if (!Object.hasOwn(parsedAssets, c.asset)) return null
      if (ids.has(c.id)) return null
      const asset = parsedAssets[c.asset]
      if (assetKind(asset) === "image") {
        // The epsilon absorbs float rounding from a split.
        if (c.in !== 0 || c.out < MIN_CLIP - 1e-9 || c.out > MAX_IMAGE) return null
      } else if (c.in < 0 || c.out <= c.in || c.out > asset.duration) return null
      ids.add(c.id)
      const clip: Clip = { id: c.id, asset: c.asset, in: c.in, out: c.out }
      if (!isBase) {
        if (!isNum(c.start) || c.start < 0) return null
        clip.start = c.start
      }
      clips.push(clip)
    }
    if (!isBase) {
      clips = sortByStart(clips)
      for (let i = 1; i < clips.length; i++) {
        const prev = clips[i - 1]
        if ((prev.start ?? 0) + clipLength(prev) > (clips[i].start ?? 0) + EPS) return null
      }
    }
    tracks.push(raw.muted ? { id: raw.id, muted: true, clips } : { id: raw.id, clips })
  }

  return { version: 2, name, width, height, fps, assets: parsedAssets, tracks }
}

/**
 * A client-sent project laid over the stored one: assets, name and settings
 * are server-owned (a stale tab can't revert a rename), so only the client's
 * tracks are taken. Null when it doesn't validate, holds more than MAX_CLIPS
 * clips, or a clip points at an asset the stored project doesn't have.
 */
export function mergeClientProject(client: unknown, stored: Project): Project | null {
  const parsed = parseProject(client)
  if (!parsed) return null
  const clips = allClips(parsed)
  if (clips.length > MAX_CLIPS) return null
  if (!clips.every((c) => Object.hasOwn(stored.assets, c.asset))) return null
  const { name, width, height, fps, assets } = stored
  return parseProject({ ...parsed, name, width, height, fps, assets })
}
