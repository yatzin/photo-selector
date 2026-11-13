import type { StockClient, StockDownload, StockKind, StockPage, StockQuery, StockRef, StockResult } from "./types"

// Freesound (https://freesound.org/docs/api/): audio only. Search is limited to
// CC0 with the API's own licence filter, and every result is checked again
// against its `license` field. Searching and the preview files need only an API
// key; the original files need OAuth2, so the high-quality mp3 preview is what
// gets imported.

const DEFAULT_BASE = "https://freesound.org"
const PAGE_SIZE = 20
const TIMEOUT_MS = 15_000
const NUMERIC_ID = /^\d{1,12}$/
const FIELDS = "id,name,duration,previews,url,license"
const CC0_FILTER = 'license:"Creative Commons 0"'
const CC0_URL = /publicdomain\/zero/i

type Cfg = { baseUrl?: string; key: string | null }
type Raw = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

/** True only for the CC0 licence URL Freesound reports. Anything else, including missing, is false. */
const isCc0 = (licence: unknown): boolean => typeof licence === "string" && CC0_URL.test(licence)

/** The best preview Freesound serves without a sign-in: high-quality mp3, then the low-quality one. */
function previewOf(hit: Raw): string | undefined {
  const p = (hit.previews ?? {}) as Raw
  return str(p["preview-hq-mp3"]) ?? str(p["preview-lq-mp3"])
}

export function createFreesound(cfg: Cfg): StockClient {
  const base = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "")
  const key = cfg.key && cfg.key.trim() ? cfg.key.trim() : null

  async function get(path: string, params: URLSearchParams): Promise<Raw> {
    if (!key) throw new Error("Freesound is not configured")
    let res: Response
    try {
      // The key goes in a header so it never appears in a URL.
      res = await fetch(`${base}${path}?${params}`, {
        headers: { accept: "application/json", authorization: `Token ${key}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message.split(key).join("***") : String(e)
      throw new Error(`Freesound request failed: ${msg}`)
    }
    if (!res.ok) {
      throw new Error(res.status === 429 ? "Freesound rate limit reached (HTTP 429)" : `Freesound request failed (HTTP ${res.status})`)
    }
    return (await res.json()) as Raw
  }

  const kinds: StockKind[] = ["audio"]

  return {
    source: "freesound",
    kinds,
    configured: () => key !== null,

    async search(q: StockQuery): Promise<StockPage> {
      // Freesound has only audio: a search for any other single type has nothing to return.
      if (q.kind !== "audio" && q.kind !== "all") return { results: [], next: null }
      const parsed = q.cursor ? Number.parseInt(q.cursor, 10) : 1
      const page = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1
      const body = await get(
        "/apiv2/search/text/",
        new URLSearchParams({ query: q.query, filter: CC0_FILTER, fields: FIELDS, page: String(page), page_size: String(PAGE_SIZE) }),
      )
      const raw = Array.isArray(body.results) ? (body.results as Raw[]) : []
      const results: StockResult[] = []
      for (const h of raw) {
        if (!isCc0(h.license)) continue
        const id = typeof h.id === "number" ? String(h.id) : undefined
        if (!id || !NUMERIC_ID.test(id)) continue
        if (!previewOf(h)) continue
        const out: StockResult = {
          source: "freesound",
          id,
          kind: "audio",
          title: str(h.name) ?? `Freesound ${id}`,
          thumbUrl: "",
          pageUrl: str(h.url) ?? "",
        }
        const d = num(h.duration)
        if (d !== undefined) out.duration = d
        results.push(out)
      }
      return { results, next: str(body.next) ? String(page + 1) : null }
    },

    async resolve(ref: StockRef): Promise<StockDownload> {
      if (!NUMERIC_ID.test(ref.id)) throw new Error("Invalid Freesound id")
      if (ref.kind !== "audio") throw new Error("Freesound provides audio only")
      const hit = await get(`/apiv2/sounds/${ref.id}/`, new URLSearchParams({ fields: FIELDS }))
      if (!isCc0(hit.license)) throw new Error("Not CC0 / public domain")
      const url = previewOf(hit)
      if (!url) throw new Error("Freesound item has no download URL")
      const title = str(hit.name)?.replace(/\s+/g, " ").slice(0, 120).trim()
      const pageUrl = str(hit.url)
      return { url, fileName: `freesound-${ref.id}.mp3`, gif: false, ...(title ? { title } : {}), ...(pageUrl ? { pageUrl } : {}) }
    },
  }
}
