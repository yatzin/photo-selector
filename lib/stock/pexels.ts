import { pickVideoFile } from "./rendition"
import type { StockClient, StockDownload, StockKind, StockPage, StockQuery, StockRef, StockResult } from "./types"

const DEFAULT_BASE = "https://api.pexels.com"
const PAGE_SIZE = 20
const TIMEOUT_MS = 15_000
const NUMERIC_ID = /^\d{1,12}$/
const EXT = /^[a-z0-9]{1,5}$/

type Cfg = { baseUrl?: string; key: string | null }
type Raw = Record<string, unknown>
type Part = { results: StockResult[]; hasNext: boolean }

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

function extOf(url: string | undefined, fallback: string): string {
  const m = url ? /\.([a-z0-9]{1,5})(?:[?#]|$)/i.exec(url) : null
  const ext = m ? m[1].toLowerCase() : fallback
  return EXT.test(ext) ? ext : fallback
}

export function createPexels(cfg: Cfg): StockClient {
  const base = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "")
  const key = cfg.key && cfg.key.trim() ? cfg.key.trim() : null

  async function get(path: string, params?: URLSearchParams): Promise<Raw> {
    if (!key) throw new Error("Pexels is not configured")
    let res: Response
    try {
      res = await fetch(`${base}${path}${params ? `?${params}` : ""}`, {
        headers: { accept: "application/json", authorization: key },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message.split(key).join("***") : String(e)
      throw new Error(`Pexels request failed: ${msg}`)
    }
    if (!res.ok) {
      throw new Error(res.status === 429 ? "Pexels rate limit reached (HTTP 429)" : `Pexels request failed (HTTP ${res.status})`)
    }
    return (await res.json()) as Raw
  }

  const params = (q: string, page: number) =>
    new URLSearchParams({ query: q, page: String(page), per_page: String(PAGE_SIZE) })

  async function searchPhotos(q: string, page: number): Promise<Part> {
    const body = await get("/v1/search", params(q, page))
    const items = Array.isArray(body.photos) ? (body.photos as Raw[]) : []
    const results: StockResult[] = []
    for (const p of items) {
      const id = typeof p.id === "number" ? String(p.id) : undefined
      if (!id || !NUMERIC_ID.test(id)) continue
      const src = (p.src ?? {}) as Raw
      const thumb = str(src.medium) ?? str(src.small) ?? str(src.large)
      if (!thumb) continue
      const out: StockResult = {
        source: "pexels",
        id,
        kind: "image",
        title: str(p.alt) ?? id,
        thumbUrl: thumb,
        pageUrl: str(p.url) ?? "",
      }
      const prev = str(src.large)
      if (prev) out.previewUrl = prev
      const w = num(p.width)
      const h = num(p.height)
      if (w !== undefined) out.width = w
      if (h !== undefined) out.height = h
      results.push(out)
    }
    return { results, hasNext: !!str(body.next_page) }
  }

  async function searchVideos(q: string, page: number): Promise<Part> {
    const body = await get("/v1/videos/search", params(q, page))
    const items = Array.isArray(body.videos) ? (body.videos as Raw[]) : []
    const results: StockResult[] = []
    for (const v of items) {
      const id = typeof v.id === "number" ? String(v.id) : undefined
      if (!id || !NUMERIC_ID.test(id)) continue
      const thumb = str(v.image)
      if (!thumb) continue
      const out: StockResult = {
        source: "pexels",
        id,
        kind: "video",
        title: str(v.alt) ?? `Pexels video ${id}`,
        thumbUrl: thumb,
        pageUrl: str(v.url) ?? "",
      }
      const d = num(v.duration)
      if (d !== undefined) out.duration = d
      const w = num(v.width)
      const h = num(v.height)
      if (w !== undefined) out.width = w
      if (h !== undefined) out.height = h
      results.push(out)
    }
    return { results, hasNext: !!str(body.next_page) }
  }

  const kinds: StockKind[] = ["image", "video"]

  return {
    source: "pexels",
    kinds,
    configured: () => key !== null,

    async search(q: StockQuery): Promise<StockPage> {
      const parsed = q.cursor ? Number.parseInt(q.cursor, 10) : 1
      const page = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1
      const jobs: Promise<Part>[] = []
      if (q.kind === "image") jobs.push(searchPhotos(q.query, page))
      else if (q.kind === "video") jobs.push(searchVideos(q.query, page))
      else if (q.kind === "all") jobs.push(searchPhotos(q.query, page), searchVideos(q.query, page))
      if (jobs.length === 0) return { results: [], next: null }
      const settled = await Promise.allSettled(jobs)
      const parts = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []))
      if (parts.length === 0) {
        const first = settled.find((s): s is PromiseRejectedResult => s.status === "rejected")
        throw first?.reason instanceof Error ? first.reason : new Error("Pexels request failed")
      }
      return {
        results: parts.flatMap((p) => p.results),
        next: parts.some((p) => p.hasNext) ? String(page + 1) : null,
      }
    },

    async resolve(ref: StockRef): Promise<StockDownload> {
      if (!NUMERIC_ID.test(ref.id)) throw new Error("Invalid Pexels id")
      if (ref.kind !== "image" && ref.kind !== "video") throw new Error("Pexels does not provide this kind of media")
      if (ref.kind === "video") {
        const v = await get(`/v1/videos/videos/${ref.id}`)
        if (String(v.id) !== ref.id) throw new Error("Pexels item not found")
        const files = (Array.isArray(v.video_files) ? (v.video_files as Raw[]) : []).flatMap((f) => {
          const url = str(f.link)
          const width = num(f.width)
          const height = num(f.height)
          return url && width !== undefined && height !== undefined ? [{ url, width, height }] : []
        })
        const file = pickVideoFile(files)
        if (!file) throw new Error("Pexels video has no downloadable file")
        const pageUrl = str(v.url)
        return { url: file.url, fileName: `pexels-${ref.id}.${extOf(file.url, "mp4")}`, gif: false, ...(pageUrl ? { pageUrl } : {}) }
      }
      const p = await get(`/v1/photos/${ref.id}`)
      if (String(p.id) !== ref.id) throw new Error("Pexels item not found")
      const src = (p.src ?? {}) as Raw
      const url = str(src.large2x) ?? str(src.large)
      if (!url) throw new Error("Pexels item has no download URL")
      const pageUrl = str(p.url)
      return { url, fileName: `pexels-${ref.id}.${extOf(url, "jpeg")}`, gif: false, ...(pageUrl ? { pageUrl } : {}) }
    },
  }
}
