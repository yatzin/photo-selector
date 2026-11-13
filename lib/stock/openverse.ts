import { isOpenLicence } from "./licence"
import type { StockClient, StockDownload, StockKind, StockPage, StockQuery, StockRef, StockResult } from "./types"

const UUID = /^[0-9a-f-]{36}$/i
const NO_GIFS = "Openverse GIFs aren't supported"
const DEFAULT_BASE = "https://api.openverse.org/v1"
const PAGE_SIZE = 20
const TIMEOUT_MS = 15_000

type Cfg = { baseUrl?: string; clientId?: string | null; clientSecret?: string | null }
type Media = "images" | "audio"
type Raw = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

function extOf(r: Raw, fallback: string): string {
  const ft = str(r.filetype)?.toLowerCase().replace(/^\./, "")
  if (ft && /^[a-z0-9]{1,5}$/.test(ft)) return ft
  const url = str(r.url)
  const m = url ? /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url) : null
  return m ? m[1].toLowerCase() : fallback
}

export function createOpenverse(cfg: Cfg): StockClient {
  const base = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "")
  let token: { value: string; expires: number } | null = null

  async function getToken(): Promise<string | null> {
    if (!cfg.clientId || !cfg.clientSecret) return null
    if (token && token.expires > Date.now()) return token.value
    const res = await fetch(`${base}/auth_tokens/token/`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`Openverse authentication failed (HTTP ${res.status})`)
    const body = (await res.json()) as Raw
    const value = str(body.access_token)
    if (!value) throw new Error("Openverse authentication returned no token")
    const ttl = (num(body.expires_in) ?? 3600) * 1000
    token = { value, expires: Date.now() + Math.max(0, ttl - 60_000) }
    return value
  }

  async function get(path: string, params?: URLSearchParams): Promise<Raw> {
    const t = await getToken()
    const url = `${base}${path}${params ? `?${params}` : ""}`
    let res: Response
    try {
      res = await fetch(url, {
        headers: { accept: "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      throw new Error(`Openverse request failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!res.ok) {
      throw new Error(res.status === 429 ? "Openverse rate limit reached (HTTP 429)" : `Openverse request failed (HTTP ${res.status})`)
    }
    return (await res.json()) as Raw
  }

  async function searchMedia(media: Media, q: string, page: number) {
    const p = new URLSearchParams({ q, license: "cc0,pdm", page_size: String(PAGE_SIZE), page: String(page) })
    const body = await get(`/${media}/`, p)
    const raw = Array.isArray(body.results) ? (body.results as Raw[]) : []
    const results: StockResult[] = []
    for (const r of raw) {
      // Licence gate: anything not CC0 / PDM (including missing) is dropped.
      if (!isOpenLicence(r.license)) continue
      const id = str(r.id)
      if (!id) continue
      // No GIFs from Openverse: its thumbnail endpoint fails for them (HTTP 424) and the upstream hosts often refuse the original.
      if (media === "images" && extOf(r, "") === "gif") continue
      const url = str(r.url)
      const thumb = str(r.thumbnail) ?? url
      if (!thumb) continue
      const out: StockResult = {
        source: "openverse",
        id,
        kind: media === "audio" ? "audio" : "image",
        title: str(r.title) ?? id,
        thumbUrl: thumb,
        pageUrl: str(r.foreign_landing_url) ?? url ?? "",
      }
      if (url && media === "images") out.previewUrl = url
      if (media === "audio") {
        const ms = num(r.duration)
        if (ms !== undefined) out.duration = ms / 1000
      } else {
        const w = num(r.width)
        const h = num(r.height)
        if (w !== undefined) out.width = w
        if (h !== undefined) out.height = h
      }
      results.push(out)
    }
    const cur = num(body.page) ?? page
    const count = num(body.page_count) ?? 0
    return { results, hasNext: cur < count }
  }

  const kinds: StockKind[] = ["image", "audio"]

  return {
    source: "openverse",
    kinds,
    configured: () => true,

    async search(q: StockQuery): Promise<StockPage> {
      const parsed = q.cursor ? Number.parseInt(q.cursor, 10) : 1
      const page = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1
      const jobs: Promise<{ results: StockResult[]; hasNext: boolean }>[] = []
      if (q.kind === "image") jobs.push(searchMedia("images", q.query, page))
      else if (q.kind === "audio") jobs.push(searchMedia("audio", q.query, page))
      else if (q.kind === "all") jobs.push(searchMedia("images", q.query, page), searchMedia("audio", q.query, page))
      if (jobs.length === 0) return { results: [], next: null }
      const settled = await Promise.allSettled(jobs)
      const parts = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []))
      if (parts.length === 0) {
        const first = settled.find((s): s is PromiseRejectedResult => s.status === "rejected")
        throw first?.reason instanceof Error ? first.reason : new Error("Openverse request failed")
      }
      return {
        results: parts.flatMap((p) => p.results),
        next: parts.some((p) => p.hasNext) ? String(page + 1) : null,
      }
    },

    async resolve(ref: StockRef): Promise<StockDownload> {
      if (ref.kind === "gif") throw new Error(NO_GIFS)
      const media: Media = ref.kind === "audio" ? "audio" : "images"
      if (!UUID.test(ref.id)) throw new Error("Invalid Openverse id")
      const r = await get(`/${media}/${ref.id}/`)
      if (!isOpenLicence(r.license)) throw new Error("Not CC0 / public domain")
      const id = str(r.id)
      if (!id || !UUID.test(id)) throw new Error("Invalid Openverse id")
      const url = str(r.url)
      if (!url) throw new Error("Openverse item has no download URL")
      const ext = extOf(r, media === "audio" ? "mp3" : "jpg")
      if (ext === "gif") throw new Error(NO_GIFS)
      const title = str(r.title)?.replace(/\s+/g, " ").slice(0, 120).trim()
      return { url, fileName: `${id}.${ext}`, gif: false, ...(title ? { title } : {}) }
    },
  }
}
