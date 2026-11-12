export type StockSource = "openverse" | "pixabay" | "pexels"
export type StockKind = "image" | "gif" | "video" | "audio"

export type StockRef = { source: StockSource; id: string; kind: StockKind }

export type StockResult = StockRef & {
  title: string
  thumbUrl: string
  previewUrl?: string
  /** Seconds (audio / video). */
  duration?: number
  width?: number
  height?: number
  pageUrl: string
}

export type StockPage = { results: StockResult[]; next: string | null }

export type StockDownload = { url: string; fileName: string; gif: boolean; title?: string }

export type StockQuery = { query: string; kind: StockKind | "all"; cursor: string | null }

export type StockClient = {
  source: StockSource
  kinds: StockKind[]
  configured(): boolean
  search(q: StockQuery): Promise<StockPage>
  resolve(ref: StockRef): Promise<StockDownload>
}
