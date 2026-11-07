/**
 * An imported file. `kind` is absent for videos (older projects have no kind).
 * For an image, `duration` is its default clip length. `source` is the Inbox
 * path it was copied from ("<folder>/<name>"), so a second import reuses it.
 */
export type Asset = { file: string; duration: number; hasAudio: boolean; kind?: "image" | "video"; source?: string }
export type Clip = { id: string; asset: string; in: number; out: number }
export type Project = {
  version: 1
  name: string
  width: number
  height: number
  fps: number
  assets: Record<string, Asset>
  clips: Clip[]
}

export const MIN_CLIP = 0.2
/** Default and longest length of an image clip, in seconds. */
export const DEFAULT_IMAGE = 5
export const MAX_IMAGE = 600

export function assetKind(a: Asset): "image" | "video" {
  return a.kind === "image" ? "image" : "video"
}

/** Every asset copied from this Inbox path ("<folder>/<name>"), oldest first; a deleted copy can leave more than one. */
export function findAssetsBySource(p: Project, source: string): { id: string; asset: Asset }[] {
  if (!source) return []
  return Object.entries(p.assets).filter(([, asset]) => asset.source === source).map(([id, asset]) => ({ id, asset }))
}

export function newProject(name: string): Project {
  return { version: 1, name, width: 1920, height: 1080, fps: 30, assets: {}, clips: [] }
}

export function clipLength(c: Clip): number {
  return c.out - c.in
}

export function clipStarts(clips: Clip[]): number[] {
  const starts: number[] = []
  let t = 0
  for (const c of clips) {
    starts.push(t)
    t += clipLength(c)
  }
  return starts
}

export function totalLength(clips: Clip[]): number {
  return clips.reduce((sum, c) => sum + clipLength(c), 0)
}

/** The clip playing at `timelineTime` and the time inside its source file; null before 0 or at/after the end. */
export function clipAt(clips: Clip[], timelineTime: number): { index: number; sourceTime: number } | null {
  if (!(timelineTime >= 0)) return null
  const starts = clipStarts(clips)
  for (let i = 0; i < clips.length; i++) {
    if (timelineTime < starts[i] + clipLength(clips[i])) return { index: i, sourceTime: clips[i].in + (timelineTime - starts[i]) }
  }
  return null
}

export function addClip(p: Project, assetId: string, at: number, id: string): Project {
  const asset = p.assets[assetId]
  if (!asset || asset.duration < MIN_CLIP || p.clips.some((c) => c.id === id)) return p
  const index = Math.max(0, Math.min(at, p.clips.length))
  const clips = [...p.clips]
  clips.splice(index, 0, { id, asset: assetId, in: 0, out: assetKind(asset) === "image" ? DEFAULT_IMAGE : asset.duration })
  return { ...p, clips }
}

export function trimClip(p: Project, id: string, edge: "in" | "out", seconds: number): Project {
  const clip = p.clips.find((c) => c.id === id)
  const asset = clip && p.assets[clip.asset]
  if (!clip || !asset || Number.isNaN(seconds)) return p
  if (assetKind(asset) === "image") {
    // An image has no source to run out of: either edge just changes the length, and `in` stays 0.
    const length = edge === "out" ? seconds : clipLength(clip) - (seconds - clip.in)
    const out = Math.max(MIN_CLIP, Math.min(MAX_IMAGE, length))
    return { ...p, clips: p.clips.map((c) => (c.id === id ? { ...clip, in: 0, out } : c)) }
  }
  const next = { ...clip }
  if (edge === "in") {
    next.in = Math.max(0, Math.min(seconds, clip.out - MIN_CLIP))
  } else {
    next.out = Math.min(asset.duration, Math.max(seconds, clip.in + MIN_CLIP))
  }
  // Only possible when the asset itself is shorter than MIN_CLIP (the epsilon absorbs float rounding).
  if (clipLength(next) < MIN_CLIP - 1e-9) return p
  return { ...p, clips: p.clips.map((c) => (c.id === id ? next : c)) }
}

export function splitClip(p: Project, id: string, timelineTime: number, newId: string): Project {
  const index = p.clips.findIndex((c) => c.id === id)
  if (index < 0 || !Number.isFinite(timelineTime) || p.clips.some((c) => c.id === newId)) return p
  const clip = p.clips[index]
  const local = timelineTime - clipStarts(p.clips)[index]
  if (local < MIN_CLIP || clipLength(clip) - local < MIN_CLIP) return p
  const clips = [...p.clips]
  const asset = p.assets[clip.asset]
  if (asset && assetKind(asset) === "image") {
    clips.splice(index, 1, { ...clip, in: 0, out: local }, { id: newId, asset: clip.asset, in: 0, out: clipLength(clip) - local })
    return { ...p, clips }
  }
  const cut = clip.in + local
  clips.splice(index, 1, { ...clip, out: cut }, { id: newId, asset: clip.asset, in: cut, out: clip.out })
  return { ...p, clips }
}

export function moveClip(p: Project, id: string, toIndex: number): Project {
  const from = p.clips.findIndex((c) => c.id === id)
  if (from < 0) return p
  const clips = [...p.clips]
  const [clip] = clips.splice(from, 1)
  clips.splice(Math.max(0, Math.min(toIndex, clips.length)), 0, clip)
  return { ...p, clips }
}

export function removeClip(p: Project, id: string): Project {
  return { ...p, clips: p.clips.filter((c) => c.id !== id) }
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

/** A whole number from 1 to `max`; these end up inside an ffmpeg filtergraph. */
function isInt(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max
}

export function parseProject(json: unknown): Project | null {
  if (!isRecord(json) || json.version !== 1) return null
  const { name, width, height, fps, assets, clips } = json
  if (typeof name !== "string" || name.length > MAX_NAME || !isInt(width, MAX_SIZE) || !isInt(height, MAX_SIZE) || !isInt(fps, MAX_FPS)) return null
  if (!isRecord(assets) || !Array.isArray(clips)) return null

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

  const parsedClips: Clip[] = []
  const ids = new Set<string>()
  for (const c of clips) {
    if (!isRecord(c) || typeof c.id !== "string" || typeof c.asset !== "string" || !isNum(c.in) || !isNum(c.out)) return null
    if (!Object.hasOwn(parsedAssets, c.asset)) return null
    if (ids.has(c.id)) return null
    const asset = parsedAssets[c.asset]
    if (assetKind(asset) === "image") {
      // The epsilon absorbs float rounding from a split.
      if (c.in !== 0 || c.out < MIN_CLIP - 1e-9 || c.out > MAX_IMAGE) return null
    } else if (c.in < 0 || c.out <= c.in || c.out > asset.duration) return null
    ids.add(c.id)
    parsedClips.push({ id: c.id, asset: c.asset, in: c.in, out: c.out })
  }

  return { version: 1, name, width, height, fps, assets: parsedAssets, clips: parsedClips }
}

/**
 * A client-sent project laid over the stored one: assets, name and settings
 * are server-owned (a stale tab can't revert a rename), so only the client's
 * clips are taken. Null when it doesn't validate or a clip points at an asset
 * the stored project doesn't have.
 */
export function mergeClientProject(client: unknown, stored: Project): Project | null {
  const parsed = parseProject(client)
  if (!parsed) return null
  if (!parsed.clips.every((c) => Object.hasOwn(stored.assets, c.asset))) return null
  const { name, width, height, fps, assets } = stored
  return parseProject({ ...parsed, name, width, height, fps, assets })
}
