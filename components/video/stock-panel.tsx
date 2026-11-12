"use client"

import { useEffect, useRef, useState } from "react"
import { ImageIcon, Loader2, Music, Search, Video } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Project } from "@/lib/video/project"
import type { StockKind, StockResult, StockSource } from "@/lib/stock/types"
import { buildSearchUrl, dragPayload, errorNotes, formatDuration, hasMore, mergeResults, safePageUrl, SOURCE_NAMES, type Cursors } from "@/lib/stock/panel-state"
import { STOCK_DRAG_TYPE } from "./timeline"

// The Stock tab of the left panel: search free stock media (Openverse, Pixabay,
// Pexels), filter by type and source, and drag a result onto the timeline or
// player. Results, query and filters live in this component's state; the tab bar
// keeps the panel mounted (hidden) when another tab is shown, so they survive.

const KINDS: { value: StockKind | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "image", label: "Image" },
  { value: "gif", label: "GIF" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
]
const SOURCES: { value: StockSource | "all"; label: string }[] = [
  { value: "all", label: "All sources" },
  ...(["openverse", "pixabay", "pexels"] as const).map((s) => ({ value: s, label: SOURCE_NAMES[s] })),
]

type SearchResponse = {
  results: StockResult[]
  cursors: Cursors
  errors: Partial<Record<StockSource, string>>
  unconfigured: StockSource[]
}

type Searched = { q: string; kind: StockKind | "all"; source: StockSource | "all" }

const SELECT = "h-6 min-w-0 flex-1 rounded-md border bg-background px-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"

/** The icon and name for a result's media type (a GIF counts as an image). */
const TYPE_ICON = { audio: { Icon: Music, name: "Audio" }, video: { Icon: Video, name: "Video" }, image: { Icon: ImageIcon, name: "Image" }, gif: { Icon: ImageIcon, name: "GIF" } } as const

function Card({ r }: { r: StockResult }) {
  const { Icon: TypeIcon, name: typeName } = TYPE_ICON[r.kind]
  const pageUrl = safePageUrl(r.pageUrl)
  const duration = r.kind === "video" || r.kind === "audio" ? formatDuration(r.duration) : ""
  return (
    <li
      draggable
      title={r.title}
      onDragStart={(e) => {
        e.dataTransfer.setData(STOCK_DRAG_TYPE, dragPayload(r))
        e.dataTransfer.effectAllowed = "copy"
      }}
      className="group relative aspect-video cursor-grab overflow-hidden rounded-md bg-muted active:cursor-grabbing"
    >
      {r.kind === "audio" || !r.thumbUrl ? (
        // The title fills the card (a sound has no picture), starting just below the source badge; the length sits over its bottom corner.
        <span className="block h-full w-full overflow-hidden bg-teal-500/20 px-2 pb-1 pt-6 text-teal-900 dark:bg-teal-400/20 dark:text-teal-50">
          <span className="line-clamp-4 break-words text-[11px] font-medium leading-tight">{r.title}</span>
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={r.thumbUrl} alt={r.title} loading="lazy" referrerPolicy="no-referrer" draggable={false} className="h-full w-full object-cover" />
      )}
      {pageUrl ? (
        <a
          href={pageUrl}
          target="_blank"
          rel="noopener noreferrer"
          draggable={false}
          title={`Open on ${SOURCE_NAMES[r.source]}`}
          className="absolute left-1 top-1 rounded bg-neutral-900/75 px-1 text-[10px] leading-4 text-white outline-none hover:bg-neutral-900 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {SOURCE_NAMES[r.source]}
        </a>
      ) : (
        <span className="absolute left-1 top-1 rounded bg-neutral-900/75 px-1 text-[10px] leading-4 text-white">{SOURCE_NAMES[r.source]}</span>
      )}
      <span title={typeName} className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded bg-neutral-900/75 text-white">
        <TypeIcon aria-hidden className="h-3 w-3" />
        <span className="sr-only">{typeName}</span>
      </span>
      {duration && <span className="absolute bottom-1 right-1 rounded bg-neutral-900/75 px-1 text-[10px] leading-4 tabular-nums text-white">{duration}</span>}
    </li>
  )
}

export function StockPanel(props: { project: Project }) {
  void props.project
  const [text, setText] = useState("")
  const [kind, setKind] = useState<StockKind | "all">("all")
  const [source, setSource] = useState<StockSource | "all">("all")
  const [searched, setSearched] = useState<Searched | null>(null)
  const [results, setResults] = useState<StockResult[]>([])
  const [cursors, setCursors] = useState<Cursors>({})
  const [errors, setErrors] = useState<Partial<Record<StockSource, string>>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const root = useRef<HTMLDivElement>(null)

  // The results scroll in the tab's panel (the parent); a new search or filter starts at the top of them.
  const scrollToTop = () => root.current?.parentElement?.scrollTo({ top: 0 })

  useEffect(() => () => abort.current?.abort(), [])

  async function run(s: Searched, next: Cursors | undefined) {
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setLoading(true)
    setFailure(null)
    try {
      const res = await fetch(buildSearchUrl({ ...s, cursors: next }), { signal: ctl.signal })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? (res.status === 401 ? "Sign in to search stock media." : "Search failed."))
      }
      const data = (await res.json()) as SearchResponse
      if (ctl.signal.aborted) return
      setResults((prev) => (next ? mergeResults(prev, data.results) : data.results))
      setCursors(data.cursors ?? {})
      setErrors(data.errors ?? {})
    } catch (e) {
      if (ctl.signal.aborted) return
      setFailure(e instanceof Error ? e.message : "Search failed.")
    } finally {
      if (abort.current === ctl) setLoading(false)
    }
  }

  function submit() {
    const q = text.trim()
    if (!q) return
    const s = { q, kind, source }
    scrollToTop()
    setSearched(s)
    setResults([])
    setCursors({})
    setErrors({})
    void run(s, undefined)
  }

  // Changing a filter re-runs the current search; with no search yet it only sets the filter.
  function changeFilter(patch: Partial<Pick<Searched, "kind" | "source">>) {
    if (patch.kind) setKind(patch.kind)
    if (patch.source) setSource(patch.source)
    if (!searched) return
    const s = { ...searched, ...patch }
    scrollToTop()
    setSearched(s)
    setResults([])
    setCursors({})
    setErrors({})
    void run(s, undefined)
  }

  const notes = errorNotes(errors)
  const more = hasMore(cursors)

  return (
    <div ref={root} className="flex flex-col gap-1.5 px-1.5 pb-1.5">
      {/* The search and filters stay put while the results scroll under them. */}
      <div className="sticky top-0 z-10 -mx-1.5 flex flex-col gap-1 border-b bg-background px-1.5 py-1">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        className="relative"
      >
        <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          aria-label="Search stock media"
          placeholder="Search stock media"
          maxLength={200}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-7 w-full rounded-md border bg-background pl-7 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
      </form>
      <div className="flex gap-1">
        <select aria-label="Type" value={kind} onChange={(e) => changeFilter({ kind: e.target.value as StockKind | "all" })} className={SELECT}>
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        <select aria-label="Source" value={source} onChange={(e) => changeFilter({ source: e.target.value as StockSource | "all" })} className={SELECT}>
          {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      </div>

      {notes.length > 0 && (
        <ul role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-900 dark:text-amber-200">
          {notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      {failure && <p role="alert" className="text-xs text-destructive">{failure}</p>}

      {!searched && <p className="text-xs text-muted-foreground">Search free photos, GIFs, video and audio, then drag a result onto the timeline.</p>}
      {searched && results.length === 0 && loading && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…</p>
      )}
      {searched && results.length === 0 && !loading && !failure && <p className="text-xs text-muted-foreground">No results for “{searched.q}”.</p>}

      {results.length > 0 && (
        <ul className={cn("grid grid-cols-2 gap-1", loading && "opacity-70")}>
          {results.map((r) => <Card key={`${r.source}:${r.id}`} r={r} />)}
        </ul>
      )}
      {results.length > 0 && more && (
        <button
          type="button"
          disabled={loading}
          onClick={() => searched && void run(searched, cursors)}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border text-xs outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Load more
        </button>
      )}
    </div>
  )
}
