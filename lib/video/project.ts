export type Asset = { file: string; duration: number; hasAudio: boolean }
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

export function addClip(p: Project, assetId: string, at: number, id: string): Project {
  const asset = p.assets[assetId]
  if (!asset || p.clips.some((c) => c.id === id)) return p
  const index = Math.max(0, Math.min(at, p.clips.length))
  const clips = [...p.clips]
  clips.splice(index, 0, { id, asset: assetId, in: 0, out: asset.duration })
  return { ...p, clips }
}

export function trimClip(p: Project, id: string, edge: "in" | "out", seconds: number): Project {
  const clip = p.clips.find((c) => c.id === id)
  const asset = clip && p.assets[clip.asset]
  if (!clip || !asset || Number.isNaN(seconds)) return p
  const next = { ...clip }
  if (edge === "in") {
    next.in = Math.max(0, Math.min(seconds, clip.out - MIN_CLIP))
  } else {
    next.out = Math.min(asset.duration, Math.max(seconds, clip.in + MIN_CLIP))
  }
  return { ...p, clips: p.clips.map((c) => (c.id === id ? next : c)) }
}

export function splitClip(p: Project, id: string, timelineTime: number, newId: string): Project {
  const index = p.clips.findIndex((c) => c.id === id)
  if (index < 0 || !Number.isFinite(timelineTime) || p.clips.some((c) => c.id === newId)) return p
  const clip = p.clips[index]
  const local = timelineTime - clipStarts(p.clips)[index]
  if (local < MIN_CLIP || clipLength(clip) - local < MIN_CLIP) return p
  const cut = clip.in + local
  const clips = [...p.clips]
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

export function parseProject(json: unknown): Project | null {
  if (!isRecord(json) || json.version !== 1) return null
  const { name, width, height, fps, assets, clips } = json
  if (typeof name !== "string" || !isNum(width) || !isNum(height) || !isNum(fps)) return null
  if (!isRecord(assets) || !Array.isArray(clips)) return null

  const parsedAssets: Record<string, Asset> = {}
  for (const [key, a] of Object.entries(assets)) {
    if (key === "__proto__") return null
    if (!isRecord(a) || typeof a.file !== "string" || !isNum(a.duration) || typeof a.hasAudio !== "boolean") return null
    parsedAssets[key] = { file: a.file, duration: a.duration, hasAudio: a.hasAudio }
  }

  const parsedClips: Clip[] = []
  const ids = new Set<string>()
  for (const c of clips) {
    if (!isRecord(c) || typeof c.id !== "string" || typeof c.asset !== "string" || !isNum(c.in) || !isNum(c.out)) return null
    if (!Object.hasOwn(parsedAssets, c.asset)) return null
    if (ids.has(c.id) || c.in < 0 || c.out <= c.in || c.out > parsedAssets[c.asset].duration) return null
    ids.add(c.id)
    parsedClips.push({ id: c.id, asset: c.asset, in: c.in, out: c.out })
  }

  return { version: 1, name, width, height, fps, assets: parsedAssets, clips: parsedClips }
}

/**
 * A client-sent project laid over the stored one: assets are server-owned, so
 * the client's are ignored. Null when it doesn't validate or a clip points at
 * an asset the stored project doesn't have.
 */
export function mergeClientProject(client: unknown, stored: Project): Project | null {
  const parsed = parseProject(client)
  if (!parsed) return null
  if (!parsed.clips.every((c) => Object.hasOwn(stored.assets, c.asset))) return null
  return parseProject({ ...parsed, assets: stored.assets })
}
