import { pickVideoFile } from "./rendition"
import type { StockClient, StockDownload, StockKind, StockPage, StockQuery, StockRef, StockResult } from "./types"

const DEFAULT_BASE = "https://pixabay.com"
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
const isGifUrl = (url: string | undefined) => !!url && extOf(url, "") === "gif"

type VFile = { width: number; height: number; url: string }
function videoFiles(hit: Raw): VFile[] {
  const v = (hit.videos ?? {}) as Raw
  const out: VFile[] = []
  for (const k of ["large", "medium", "small", "tiny"]) {
    const f = v[k] as Raw | undefined
    const url = str(f?.url)
    const width = num(f?.width)
    const height = num(f?.height)
    if (url && width !== undefined && height !== undefined) out.push({ url, width, height })
  }
  return out
}

export function createPixabay(cfg: Cfg): StockClient {
  const base = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "")
  const key = cfg.key && cfg.key.trim() ? cfg.key.trim() : null

  async function get(path: string, params: URLSearchParams): Promise<Raw> {
    if (!key) throw new Error("Pixabay is not configured")
    params.set("key", key)
    let res: Response
    try {
      res = await fetch(`${base}${path}?${params}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      // Never echo the error text verbatim: some runtimes include the URL (and key).
      const msg = e instanceof Error ? e.message.split(key).join("***") : String(e)
      throw new Error(`Pixabay request failed: ${msg}`)
    }
    if (!res.ok) {
      throw new Error(res.status === 429 ? "Pixabay rate limit reached (HTTP 429)" : `Pixabay request failed (HTTP ${res.status})`)
    }
    return (await res.json()) as Raw
  }

  async function searchImages(kind: "image" | "gif" | "all", q: string, page: number): Promise<Part> {
    const body = await get("/api/", new URLSearchParams({ q, page: String(page), per_page: String(PAGE_SIZE) }))
    const hits = Array.isArray(body.hits) ? (body.hits as Raw[]) : []
    const results: StockResult[] = []
    for (const h of hits) {
      const id = typeof h.id === "number" ? String(h.id) : undefined
      if (!id || !NUMERIC_ID.test(id)) continue
      const gif = isGifUrl(str(h.largeImageURL)) || isGifUrl(str(h.webformatURL))
      if (kind === "image" && gif) continue
      if (kind === "gif" && !gif) continue
      const thumb = str(h.previewURL) ?? str(h.webformatURL)
      if (!thumb) continue
      const out: StockResult = {
        source: "pixabay",
        id,
        kind: gif ? "gif" : "image",
        title: str(h.tags) ?? id,
        thumbUrl: thumb,
        pageUrl: str(h.pageURL) ?? "",
      }
      const prev = str(h.webformatURL)
      if (prev) out.previewUrl = prev
      const w = num(h.imageWidth)
      const ht = num(h.imageHeight)
      if (w !== undefined) out.width = w
      if (ht !== undefined) out.height = ht
      results.push(out)
    }
    const total = num(body.totalHits) ?? 0
    return { results, hasNext: page * PAGE_SIZE < total }
  }

  async function searchVideos(q: string, page: number): Promise<Part> {
    const body = await get("/api/videos/", new URLSearchParams({ q, page: String(page), per_page: String(PAGE_SIZE) }))
    const hits = Array.isArray(body.hits) ? (body.hits as Raw[]) : []
    const results: StockResult[] = []
    for (const h of hits) {
      const id = typeof h.id === "number" ? String(h.id) : undefined
      if (!id || !NUMERIC_ID.test(id)) continue
      const vids = (h.videos ?? {}) as Raw
      const thumb = ["tiny", "small", "medium", "large"]
        .map((k) => str(((vids[k] ?? {}) as Raw).thumbnail))
        .find((t) => t)
      if (!thumb) continue
      const out: StockResult = {
        source: "pixabay",
        id,
        kind: "video",
        title: str(h.tags) ?? id,
        thumbUrl: thumb,
        pageUrl: str(h.pageURL) ?? "",
      }
      const d = num(h.duration)
      if (d !== undefined) out.duration = d
      results.push(out)
    }
    const total = num(body.totalHits) ?? 0
    return { results, hasNext: page * PAGE_SIZE < total }
  }

  const kinds: StockKind[] = ["image", "gif", "video"]

  return {
    source: "pixabay",
    kinds,
    configured: () => key !== null,

    async search(q: StockQuery): Promise<StockPage> {
      const parsed = q.cursor ? Number.parseInt(q.cursor, 10) : 1
      const page = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1
      const jobs: Promise<Part>[] = []
      if (q.kind === "image" || q.kind === "gif") jobs.push(searchImages(q.kind, q.query, page))
      else if (q.kind === "video") jobs.push(searchVideos(q.query, page))
      else if (q.kind === "all") jobs.push(searchImages("all", q.query, page), searchVideos(q.query, page))
      if (jobs.length === 0) return { results: [], next: null }
      const settled = await Promise.allSettled(jobs)
      const parts = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []))
      if (parts.length === 0) {
        const first = settled.find((s): s is PromiseRejectedResult => s.status === "rejected")
        throw first?.reason instanceof Error ? first.reason : new Error("Pixabay request failed")
      }
      return {
        results: parts.flatMap((p) => p.results),
        next: parts.some((p) => p.hasNext) ? String(page + 1) : null,
      }
    },

    async resolve(ref: StockRef): Promise<StockDownload> {
      if (!NUMERIC_ID.test(ref.id)) throw new Error("Invalid Pixabay id")
      if (ref.kind !== "image" && ref.kind !== "gif" && ref.kind !== "video") {
        throw new Error("Pixabay does not provide this kind of media")
      }
      const isVideo = ref.kind === "video"
      const body = await get(isVideo ? "/api/videos/" : "/api/", new URLSearchParams({ id: ref.id }))
      const hits = Array.isArray(body.hits) ? (body.hits as Raw[]) : []
      const hit = hits.find((h) => String(h.id) === ref.id)
      if (!hit) throw new Error("Pixabay item not found")
      if (isVideo) {
        const file = pickVideoFile(videoFiles(hit))
        if (!file) throw new Error("Pixabay video has no downloadable file")
        return { url: file.url, fileName: `pixabay-${ref.id}.${extOf(file.url, "mp4")}`, gif: false }
      }
      const url = str(hit.largeImageURL) ?? str(hit.webformatURL)
      if (!url) throw new Error("Pixabay item has no download URL")
      const ext = extOf(url, "jpg")
      return { url, fileName: `pixabay-${ref.id}.${ext}`, gif: ext === "gif" }
    },
  }
}
