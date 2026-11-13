"use client"

import { createContext, useCallback, useContext, useEffect, useEffectEvent, useMemo, useRef, useState, useTransition } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Check, ChevronDown, FolderOutput, Grid3x3, ImageOff, Inbox, LayoutGrid, List, Loader2, Play, RotateCcw, RotateCw, Square, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatBytes, formatClock, mediaUrl, preview } from "@/lib/format"
import { useStoredState } from "@/lib/hooks/use-stored-state"
import { TEMP_MEDIA_DRAG, TEMP_MOVED_EVENT } from "@/lib/temp-drag"
import { DRAG_BADGE_EVENT } from "@/lib/drag-ghost"
import { deleteAction, moveToDropoffAction, rotateAction, undoDeleteAction, videoDurationsAction } from "@/lib/actions/media"
import type { FileEntry } from "@/lib/library-server"
import type { QualityFlags } from "@/lib/ai/flags-server"
import type { TempNoteView } from "@/lib/temp-notes-server"
import { gridLayout } from "@/lib/grid-layout"
import { buildRows, itemAt, rowOfItem, rowTops, type GridRow } from "@/lib/month-groups"
import { Lightbox } from "./lightbox"
import { PhotoImage } from "./photo-image"
import { useDragSelect } from "./use-drag-select"
import { PhotoMenu, type PhotoMenuAction } from "./photo-menu"
import { RenameDialog } from "@/components/video/temp-dialogs"
import { TempDialog } from "./temp-dialog"

// The sorting grid. A click (or tap) toggles a photo in or out of the
// selection, so picking many is just clicking each one. Shift-click adds the
// whole range from the last clicked photo, Ctrl/⌘+A selects all. Dragging
// across photos selects the range (on touch: press and hold, then drag; see
// use-drag-select.ts). Double-click
// (double-tap) or Enter opens the viewer; the two clicks cancel out, so the
// selection is unchanged.
//
// Keys: arrows move the focus, Space toggles it, Shift+arrows add a range,
// Del deletes, M moves to Sort Dropoff, R / Shift+R rotate, Esc clears.
// Right-click (or the toolbar) also moves or copies to Personal Storage.
//
// Sorted by date, photos are grouped under month headers; the circle on a
// header selects or deselects that whole month, and the chevron collapses it
// (view only; nothing is saved). Sorted by name, it's one grid.
//
// Large folders: only the rows on screen (plus a few either side) exist in
// the page, so 10,000 photos cost about as much as 100. Selection, sorting
// and keys work on the full list, not on what is drawn.

const SIZES = { s: 128, m: 192, l: 288 } as const
const GAP = 8
// Personal Storage: room under each tile for the start of its note (two
// lines of text-xs), cut at NOTE_CHARS characters.
const CAPTION_H = 36
const NOTE_CHARS = 60
// Height of a month header row ("July 2026  ○  42 photos").
const HEADER_H = 48
// Rows kept rendered above and below the visible ones.
const OVERSCAN_ROWS = 3
// A tile asks for its thumbnail only after this long on screen.
const THUMB_DELAY_MS = 150
/** The view: small, medium or large thumbnails, or a list with each file's details. */
type SizeKey = keyof typeof SIZES | "list"
const VIEWS: { key: SizeKey; label: string; Icon: typeof Square }[] = [
  { key: "s", label: "Small thumbnails", Icon: Grid3x3 },
  { key: "m", label: "Medium thumbnails", Icon: LayoutGrid },
  { key: "l", label: "Large thumbnails", Icon: Square },
  { key: "list", label: "List with details", Icon: List },
]
/** A list row's height (the room under it is the grid's gap). */
const LIST_ROW_H = 48
const ORDERS = ["newest", "oldest", "name"] as const
type Order = (typeof ORDERS)[number]

type Props = {
  root: string
  rootDir?: string
  folder: string[]
  files: FileEntry[]
  flags?: QualityFlags
  /** Personal Storage: the notes left with these files, by name. */
  notes?: Record<string, TempNoteView>
  canMove: boolean
  canEdit: boolean
}

type ActionResult = { ok: string[]; failed: { name: string; error: string }[] } | { error: string }

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))
}

/** Video lengths found so far, by durationKey. */
const DurationsContext = createContext<Record<string, number>>({})
const durationKey = (root: string, folder: string[], item: FileEntry) => `${root}/${folder.join("/")}/${item.name}@${item.version}`
/** How many videos are measured per request. */
const DURATION_BATCH = 24

/** A video's length in the corner of its thumbnail (nothing for a photo, or until it is measured). `compact` is for the list view's small thumbnail. */
function DurationBadge({ root, folder, item, compact = false }: { root: string; folder: string[]; item: FileEntry; compact?: boolean }) {
  const seconds = useContext(DurationsContext)[durationKey(root, folder, item)]
  if (item.kind !== "video" || seconds === undefined) return null
  return (
    <span
      className={cn(
        "pointer-events-none absolute rounded bg-black/65 font-medium tabular-nums text-white",
        compact ? "bottom-0 right-0 rounded-br-none rounded-tr-none px-0.5 text-[9px] leading-3" : "bottom-1.5 right-1.5 px-1.5 text-[11px] leading-5"
      )}
    >
      {formatClock(seconds)}
    </span>
  )
}

function Tile({
  root, folder, item, flagged, note, tempNote, selected, focused, onClick, onDoubleClick, onToggle, onContextMenu, onDragStart, caption = false,
}: {
  root: string
  folder: string[]
  item: FileEntry
  /** Quality Checks flagged it as a bad photo; `note` says why. */
  flagged: boolean
  note?: string | null
  /** The note left with it in Personal Storage. */
  tempNote?: string
  selected: boolean
  focused: boolean
  onClick: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onToggle: () => void
  onContextMenu: (e: React.MouseEvent) => void
  /** Personal Storage: the photo can be dragged onto a folder in the side navigation. */
  onDragStart?: (e: React.DragEvent) => void
  /** Show the start of `tempNote` under the tile (Personal Storage). */
  caption?: boolean
}) {
  const tile = (
    <div
      data-name={item.name}
      className={cn(
        "group relative aspect-square cursor-pointer select-none overflow-hidden rounded-md bg-muted",
        selected && "ring-[3px] ring-primary ring-offset-2 ring-offset-background",
        focused && !selected && "ring-2 ring-ring/60"
      )}
      // touch-action: no double-tap zoom, so a double-tap reaches onDoubleClick.
      // No iOS long-press menu: a long press starts a drag selection.
      style={{ touchAction: "manipulation", WebkitTouchCallout: "none" }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      draggable={onDragStart !== undefined}
      onDragStart={onDragStart}
      title={flagged ? `${item.name} — bad photo${note ? `: ${note}` : ""}` : tempNote ? `${item.name} — ${tempNote}` : item.name}
    >
      <PhotoImage
        src={mediaUrl(root, folder, item.name, "thumb", item.version)}
        alt={item.name}
        delayMs={THUMB_DELAY_MS}
        fallbackLabel={item.name}
        className={cn("transition-transform duration-150", selected && "scale-[0.94]")}
      />
      {item.kind === "video" && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-[28%] min-h-10 w-[28%] min-w-10 items-center justify-center rounded-full bg-black/55 text-white shadow-lg ring-1 ring-white/30 backdrop-blur-[2px]">
            <Play className="h-1/2 w-1/2 translate-x-[6%] fill-current" />
          </span>
        </span>
      )}
      <DurationBadge root={root} folder={folder} item={item} />
      {flagged && (
        <>
          <span aria-hidden className="pointer-events-none absolute inset-0 rounded-md border-[3px] border-red-600" />
          <span
            role="img"
            aria-label="Bad photo"
            className="pointer-events-none absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-white shadow"
          >
            <ImageOff className="h-3.5 w-3.5" strokeWidth={2.5} />
          </span>
        </>
      )}
      <button
        type="button"
        aria-label={selected ? `Deselect ${item.name}` : `Select ${item.name}`}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className={cn(
          "absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 transition-opacity",
          selected
            ? "border-primary bg-primary text-primary-foreground opacity-100"
            : "border-white/90 bg-black/25 text-transparent opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
        )}
      >
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
      </button>
    </div>
  )
  if (!caption) return tile
  return (
    <div className="min-w-0">
      {tile}
      <p
        className="mt-1 line-clamp-2 break-words text-xs leading-4 text-muted-foreground"
        style={{ height: CAPTION_H - 4 }}
        title={tempNote}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        {tempNote ? preview(tempNote, NOTE_CHARS) : null}
      </p>
    </div>
  )
}

const KIND_LABEL = { image: "Photo", video: "Video" } as const

/** The list view's row for one photo or video: select circle, small thumbnail, name (and its note), type, size and date. Behaves as a Tile does. */
function ListRow({
  root, folder, item, flagged, note, tempNote, selected, focused, onClick, onDoubleClick, onToggle, onContextMenu, onDragStart,
}: React.ComponentProps<typeof Tile>) {
  return (
    <div
      data-name={item.name}
      draggable={onDragStart !== undefined}
      onDragStart={onDragStart}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={flagged ? `${item.name} — bad photo${note ? `: ${note}` : ""}` : tempNote ? `${item.name} — ${tempNote}` : item.name}
      style={{ height: LIST_ROW_H, touchAction: "manipulation", WebkitTouchCallout: "none" }}
      className={cn(
        "group flex cursor-pointer select-none items-center gap-3 rounded-md border px-2 transition-colors",
        selected ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted/60",
        flagged && "border-red-600",
        focused && !selected && "ring-2 ring-ring/60"
      )}
    >
      <button
        type="button"
        aria-label={selected ? `Deselect ${item.name}` : `Select ${item.name}`}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50 text-transparent group-hover:border-primary"
        )}
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </button>
      <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded bg-muted">
        <PhotoImage src={mediaUrl(root, folder, item.name, "thumb", item.version)} alt="" delayMs={THUMB_DELAY_MS} fallbackLabel="" />
        {item.kind === "video" && <Play className="pointer-events-none absolute inset-0 m-auto h-4 w-4 fill-white text-white drop-shadow" />}
        <DurationBadge root={root} folder={folder} item={item} compact />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{item.name}</div>
        {tempNote && <div className="truncate text-xs text-muted-foreground">{preview(tempNote, NOTE_CHARS)}</div>}
      </div>
      {flagged && <ImageOff className="h-4 w-4 shrink-0 text-red-600" aria-label="Bad photo" />}
      <span className="hidden w-14 shrink-0 text-xs text-muted-foreground sm:block">{KIND_LABEL[item.kind]}</span>
      <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">{formatBytes(item.size)}</span>
      <span className="hidden w-36 shrink-0 text-right text-xs text-muted-foreground tabular-nums md:block">
        {new Date(item.modified).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
      </span>
    </div>
  )
}

/** Shown before the grid has measured its width (server render, first paint). */
function SkeletonGrid({ tile }: { tile: number }) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${tile}px, 40vw), 1fr))` }} aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => <div key={i} className="shimmer aspect-square rounded-md bg-muted" />)}
    </div>
  )
}

const NO_FLAGS: QualityFlags = { runs: [], photos: {} }

export function MediaGrid({ root, rootDir, folder, files, flags = NO_FLAGS, notes, canMove, canEdit }: Props) {
  const router = useRouter()
  const [sizeKey, setSizeKey] = useStoredState<SizeKey>("ps.tileSize", "m", ["s", "m", "l", "list"])
  const [order, setOrder] = useStoredState<Order>("ps.order", "newest", ORDERS)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [viewer, setViewer] = useState<number | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  // Names waiting in the "Send to Personal Storage" dialog.
  const [temp, setTemp] = useState<string[] | null>(null)
  const [, startTransition] = useTransition()
  // Video lengths for the thumbnail badges: asked for in small batches once the folder shows, and remembered by the server.
  const [durations, setDurations] = useState<Record<string, number>>({})
  const asked = useRef(new Set<string>())
  useEffect(() => {
    const want = files.filter((f) => f.kind === "video" && !asked.current.has(durationKey(root, folder, f)))
    if (want.length === 0) return
    let live = true
    const waiting = new Set(want.map((f) => durationKey(root, folder, f)))
    for (const k of waiting) asked.current.add(k)
    void (async () => {
      for (let i = 0; i < want.length && live; i += DURATION_BATCH) {
        const batch = want.slice(i, i + DURATION_BATCH)
        const found = await videoDurationsAction({ root, folder, names: batch.map((f) => f.name) }).catch(() => ({}) as Record<string, number>)
        if (!live) return
        const add: Record<string, number> = {}
        for (const f of batch) {
          waiting.delete(durationKey(root, folder, f))
          if (found[f.name] !== undefined) add[durationKey(root, folder, f)] = found[f.name]
        }
        if (Object.keys(add).length > 0) setDurations((d) => ({ ...d, ...add }))
      }
    })()
    return () => {
      live = false
      // Anything not answered yet is asked for again next time.
      for (const k of waiting) asked.current.delete(k)
    }
    // `folder` is a new array every render; its path is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, root, folder.join("/")])
  // Measured on the client: the grid's width, the scrolling <main>, and how
  // far below the top of the scroll area the grid starts (folders, toolbar).
  const [frame, setFrame] = useState<{ width: number; scrollEl: HTMLElement | null; offset: number }>({ width: 0, scrollEl: null, offset: 0 })
  const gridEl = useRef<HTMLDivElement | null>(null)
  const measureRef = useCallback((el: HTMLDivElement | null) => {
    gridEl.current = el
    if (!el) return
    const scrollEl = el.closest("main") as HTMLElement | null
    const measure = () => {
      const offset = scrollEl ? el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop : 0
      setFrame((f) => (f.width === el.clientWidth && f.offset === offset && f.scrollEl === scrollEl ? f : { width: el.clientWidth, scrollEl, offset }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (scrollEl) ro.observe(scrollEl)
    return () => ro.disconnect()
  }, [])

  // Fresh data from the server (after an action or a new upload): anything
  // hidden optimistically is either gone for real or back (Undo).
  const [prevFiles, setPrevFiles] = useState(files)
  if (prevFiles !== files) {
    setPrevFiles(files)
    setHidden(new Set())
  }

  const items = useMemo(() => {
    const visible = files.filter((f) => !hidden.has(f.name))
    if (order === "oldest") return [...visible].sort((a, b) => a.modified - b.modified)
    if (order === "name") return [...visible].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    return [...visible].sort((a, b) => b.modified - a.modified)
  }, [files, hidden, order])

  const indexOf = useMemo(() => new Map(items.map((f, i) => [f.name, i])), [items])
  const chosen = useMemo(() => items.filter((f) => selected.has(f.name)), [items, selected])
  const chosenBytes = chosen.reduce((sum, f) => sum + f.size, 0)

  // Filled in once the rows are built (below); ranges skip photos in collapsed months.
  const hiddenIdx = useRef<Set<number>>(new Set())
  const selectRange = useCallback((from: string | null, to: string, additive: boolean) => {
    const a = from !== null ? indexOf.get(from) : undefined
    const b = indexOf.get(to)
    if (b === undefined) return
    const start = Math.min(a ?? b, b)
    const end = Math.max(a ?? b, b)
    setSelected((prev) => {
      const next = additive ? new Set(prev) : new Set<string>()
      for (let i = start; i <= end; i++) if (!hiddenIdx.current.has(i)) next.add(items[i].name)
      return next
    })
  }, [indexOf, items])

  const toggle = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
    setAnchor(name)
    setFocus(name)
  }, [])

  const hide = (names: string[]) => {
    setHidden((prev) => new Set([...prev, ...names]))
    setSelected((prev) => {
      const next = new Set(prev)
      for (const n of names) next.delete(n)
      return next
    })
  }

  const refresh = () => startTransition(() => router.refresh())

  function report(result: ActionResult, verb: string): string[] {
    if ("error" in result) {
      toast.error(result.error)
      return []
    }
    if (result.failed.length) {
      const first = result.failed[0]
      toast.error(`Couldn't ${verb} ${result.failed.length} item${result.failed.length === 1 ? "" : "s"}`, {
        description: `${first.name}: ${first.error}`,
      })
    }
    return result.ok
  }

  async function run(kind: "move" | "delete" | "rotate-cw" | "rotate-ccw", names: string[]) {
    if (!names.length || busy) return
    const target = { root, folder, names }
    setBusy(true)
    try {
      if (kind === "move") {
        const ok = report(await moveToDropoffAction(target), "move")
        hide(ok)
        if (ok.length) toast.success(`Moved ${ok.length} to Sort Dropoff`)
      } else if (kind === "delete") {
        const result = await deleteAction(target)
        const ok = report(result, "delete")
        hide(ok)
        if (ok.length && "batchId" in result) {
          toast.success(`Deleted ${ok.length} item${ok.length === 1 ? "" : "s"}`, {
            duration: 10_000,
            action: {
              label: "Undo",
              onClick: async () => {
                const restored = report(await undoDeleteAction(root, result.batchId, folder), "restore")
                if (restored.length) toast.success(`Restored ${restored.length}`)
                refresh()
              },
            },
          })
        }
      } else {
        const ok = report(await rotateAction({ ...target, direction: kind === "rotate-cw" ? "cw" : "ccw" }), "rotate")
        if (ok.length > 1) toast.success(`Rotated ${ok.length}`)
      }
    } catch {
      toast.error("Something went wrong. Check that the NAS is reachable.")
    } finally {
      setBusy(false)
      refresh()
    }
  }

  // After a move/delete in the viewer, stay at the same position (the next
  // photo slides in); close when nothing is left.
  const viewerIndex = viewer === null ? null : Math.min(viewer, items.length - 1)
  const viewerOpen = viewerIndex !== null && viewerIndex >= 0

  const listView = sizeKey === "list"
  const tile = SIZES[listView ? "m" : sizeKey]
  // Phones get at least two columns, like the old 40vw rule. The list is one column of rows.
  const gridded = gridLayout({ width: frame.width, minTile: Math.min(tile, frame.width * 0.42 || tile), gap: GAP, count: items.length, caption: notes ? CAPTION_H : 0 })
  const layout = listView
    ? { ...gridded, columns: 1, tileSize: frame.width, rowHeight: LIST_ROW_H + GAP, rows: items.length, rowOf: (i: number) => i }
    : gridded

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const rows = useMemo(
    () => (frame.width ? buildRows(items, layout.columns, order !== "name", collapsed) : []),
    [items, layout.columns, order, frame.width, collapsed]
  )
  // Indices of photos inside collapsed months: ranges (drag, Shift-click) skip them.
  const hiddenNow = useMemo(() => {
    const out = new Set<number>()
    for (const r of rows) if (r.kind === "header" && collapsed.has(r.key)) for (let i = r.start; i < r.end; i++) out.add(i)
    return out
  }, [rows, collapsed])
  useEffect(() => {
    hiddenIdx.current = hiddenNow
  }, [hiddenNow])
  const rowSize = useCallback((r: GridRow) => (r.kind === "header" ? HEADER_H : layout.rowHeight), [layout.rowHeight])
  const tops = useMemo(() => rowTops(rows, rowSize), [rows, rowSize])

  // eslint-disable-next-line react-hooks/incompatible-library -- not memoized by the compiler; re-rendering it is the intended use
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => frame.scrollEl,
    estimateSize: (i) => rowSize(rows[i]),
    overscan: OVERSCAN_ROWS,
    scrollMargin: frame.offset,
  })
  // Rows change when the window, tile size, sort order or photos change.
  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, rows, rowSize])

  const toggleMonth = (row: Extract<GridRow, { kind: "header" }>) => {
    const monthNames = items.slice(row.start, row.end).map((f) => f.name)
    setSelected((prev) => {
      const next = new Set(prev)
      const all = monthNames.every((n) => next.has(n))
      for (const n of monthNames) {
        if (all) next.delete(n)
        else next.add(n)
      }
      return next
    })
  }

  const columns = () => layout.columns

  const itemNames = useMemo(() => items.map((f) => f.name), [items])

  // Right-click menu (mouse only: on touch a long press starts drag-select).
  const lastPointer = useRef<string>("mouse")
  // Quality Checks: the scan that flagged a photo as bad, if any.
  const flagRun = (name: string) => {
    const f = flags.photos[name]
    return f ? flags.runs[f[0]] : undefined
  }
  const [menu, setMenu] = useState<{ x: number; y: number; names: string[]; flagged?: string } | null>(null)
  const openMenu = (e: React.MouseEvent, name: string) => {
    e.preventDefault()
    if (lastPointer.current !== "mouse") return
    setMenu({ x: e.clientX, y: e.clientY, names: selected.has(name) ? chosen.map((f) => f.name) : [name], flagged: flagRun(name) })
  }
  const closeMenu = useCallback(() => setMenu(null), [])
  // Personal Storage, below a user's own folder: a photo or video can be renamed from its menu.
  const [renaming, setRenaming] = useState<string | null>(null)
  const menuImages = menu ? menu.names.filter((n) => items[indexOf.get(n) ?? -1]?.kind === "image") : []
  const onMenu = (action: PhotoMenuAction) => {
    if (!menu) return
    if (action === "bad-photos") {
      if (menu.flagged) router.push(`/ai/runs/${menu.flagged}?tab=found`)
      return
    }
    if (action === "temp") {
      setTemp(menu.names)
      return
    }
    if (action === "rename") {
      setRenaming(menu.names[0])
      return
    }
    void run(action, action.startsWith("rotate") ? menuImages : menu.names)
  }
  // Personal Storage, below a user's own folder: the selected photos can be dragged onto a folder in the side navigation to move them there.
  const canDragToFolder = root === "temp" && folder.length > 0 && canEdit
  // Dragging a selected photo takes the whole selection; any other photo goes alone.
  const dragTile = (e: React.DragEvent, name: string) => {
    const names = selected.has(name) ? chosen.map((f) => f.name) : [name]
    e.dataTransfer.setData(TEMP_MEDIA_DRAG, JSON.stringify({ folder, names }))
    e.dataTransfer.effectAllowed = "move"
    window.dispatchEvent(new CustomEvent(DRAG_BADGE_EVENT, { detail: names.length }))
  }
  const onMoved = useEffectEvent((e: Event) => {
    const d = (e as CustomEvent<{ folder: string[]; names: string[] }>).detail
    if (d.folder.join("/") === folder.join("/")) hide(d.names)
  })
  useEffect(() => {
    const h = (e: Event) => onMoved(e)
    window.addEventListener(TEMP_MOVED_EVENT, h)
    return () => window.removeEventListener(TEMP_MOVED_EVENT, h)
  }, [])
  const dragSelect = useDragSelect({
    leaveMouse: canDragToFolder,
    grid: () => gridEl.current,
    scrollEl: frame.scrollEl,
    hit: (x, y) => itemAt(x, y, rows, tops, { columns: layout.columns, tileSize: layout.tileSize, gap: GAP }),
    names: itemNames,
    hidden: (i) => hiddenNow.has(i),
    selected,
    apply: (next, current, start) => {
      setSelected(next)
      setFocus(current)
      setAnchor(start)
    },
  })

  const scrollTo = (name: string) => {
    const index = indexOf.get(name)
    const row = index === undefined ? -1 : rowOfItem(rows, index)
    if (row >= 0) virtualizer.scrollToIndex(row, { align: "auto" })
  }

  // One key handler for both the grid and the viewer, so shortcuts work the same in each.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    // The dialog has the keyboard: Esc closes it, not the viewer.
    if (temp || isTyping(e.target) || e.altKey) return
    const mod = e.ctrlKey || e.metaKey
    const key = e.key

    if (viewerOpen) {
      const current = items[viewerIndex]
      if (key === "Escape") setViewer(null)
      else if (key === "ArrowRight" && viewerIndex < items.length - 1) setViewer(viewerIndex + 1)
      else if (key === "ArrowLeft" && viewerIndex > 0) setViewer(viewerIndex - 1)
      else if ((key === "Delete" || key === "Backspace") && canEdit) void run("delete", [current.name])
      else if (key.toLowerCase() === "m" && !mod && canMove) void run("move", [current.name])
      else if (key.toLowerCase() === "r" && !mod && canEdit && current.kind === "image") void run(e.shiftKey ? "rotate-ccw" : "rotate-cw", [current.name])
      else return
      e.preventDefault()
      return
    }

    if (mod && key.toLowerCase() === "a") {
      setSelected(new Set(items.map((f) => f.name)))
    } else if (key === "Escape") {
      setSelected(new Set())
    } else if (key.startsWith("Arrow") && items.length) {
      const cur = focus !== null ? indexOf.get(focus) ?? -1 : -1
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(), ArrowDown: columns() }[key] ?? 0
      const nextIndex = cur < 0 ? 0 : Math.min(items.length - 1, Math.max(0, cur + step))
      const name = items[nextIndex].name
      setFocus(name)
      if (e.shiftKey) selectRange(anchor ?? focus ?? name, name, true)
      scrollTo(name)
    } else if (key === " ") {
      if (focus === null) return
      toggle(focus)
    } else if (key === "Enter") {
      const name = focus ?? chosen[0]?.name
      if (name === undefined) return
      setViewer(indexOf.get(name) ?? 0)
    } else if ((key === "Delete" || key === "Backspace") && canEdit) {
      void run("delete", chosen.map((f) => f.name))
    } else if (key.toLowerCase() === "m" && !mod && canMove) {
      void run("move", chosen.map((f) => f.name))
    } else if (key.toLowerCase() === "r" && !mod && canEdit) {
      void run(e.shiftKey ? "rotate-ccw" : "rotate-cw", chosen.filter((f) => f.kind === "image").map((f) => f.name))
    } else {
      return
    }
    e.preventDefault()
  })

  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey(e)
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  function onTileClick(e: React.MouseEvent, name: string) {
    if (e.shiftKey && anchor !== null) {
      setFocus(name)
      selectRange(anchor, name, true)
    } else {
      toggle(name)
    }
  }

  if (files.length === 0) return null

  const imageNames = chosen.filter((f) => f.kind === "image").map((f) => f.name)
  const names = chosen.map((f) => f.name)

  return (
    <DurationsContext.Provider value={durations}>
    <div className="space-y-3">
      <div className="sticky -top-6 z-10 -mx-6 flex flex-wrap items-center gap-2 border-b border-border/60 bg-background/95 px-6 py-2 backdrop-blur-sm">
        {chosen.length > 0 ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} aria-label="Clear selection">
              <X className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium tabular-nums">
              {chosen.length.toLocaleString()} selected
              <span className="ml-1 font-normal text-muted-foreground">&middot; {formatBytes(chosenBytes)}</span>
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              {canEdit && (
                <>
                  <Button variant="outline" size="sm" disabled={busy || !imageNames.length} onClick={() => run("rotate-ccw", imageNames)} title="Rotate left (Shift+R)">
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy || !imageNames.length} onClick={() => run("rotate-cw", imageNames)} title="Rotate right (R)">
                    <RotateCw className="h-4 w-4" />
                  </Button>
                </>
              )}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setTemp(names)} title="Move or copy to Personal Storage">
                <Inbox className="h-4 w-4" />
                <span className="hidden lg:inline">Personal Storage</span>
              </Button>
              {canMove && (
                <Button size="sm" disabled={busy} onClick={() => run("move", names)} title="Move to Sort Dropoff (M)">
                  <FolderOutput className="h-4 w-4" />
                  <span className="hidden sm:inline">Move to Dropoff</span>
                </Button>
              )}
              {canEdit && (
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => run("delete", names)} title="Delete (Del)">
                  <Trash2 className="h-4 w-4" />
                  <span className="hidden sm:inline">Delete</span>
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <span className="text-sm text-muted-foreground">
              {items.length.toLocaleString()} item{items.length === 1 ? "" : "s"}
              <span className="hidden md:inline"> &middot; click to select or unselect, double-click to open</span>
            </span>
            <div className="ml-auto flex items-center gap-2">
              <select
                value={order}
                onChange={(e) => setOrder(e.target.value as Order)}
                aria-label="Sort order"
                className="h-8 rounded-lg border border-input bg-background text-foreground px-2 text-sm"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="name">Name</option>
              </select>
              <div className="flex rounded-lg border border-input p-0.5" role="group" aria-label="View">
                {VIEWS.map(({ key, label, Icon }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSizeKey(key)}
                    aria-pressed={sizeKey === key}
                    aria-label={label}
                    title={label}
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-md",
                      sizeKey === key ? "bg-primary/10 text-link" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      <div
        ref={measureRef}
        className="relative w-full"
        style={{ height: rows.length ? virtualizer.getTotalSize() : undefined }}
        onPointerDown={(e) => {
          lastPointer.current = e.pointerType
          dragSelect.onPointerDown(e)
        }}
        onClickCapture={dragSelect.onClickCapture}
      >
        {frame.width === 0 ? (
          <SkeletonGrid tile={tile} />
        ) : (
          virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index]
            const y = `translateY(${v.start - virtualizer.options.scrollMargin}px)`
            if (row.kind === "header") {
              const monthItems = items.slice(row.start, row.end)
              const picked = monthItems.filter((f) => selected.has(f.name)).length
              const all = picked === monthItems.length
              return (
                <div key={v.key} className="absolute left-0 top-0 flex w-full items-end gap-2 pb-2" style={{ transform: y, height: HEADER_H }}>
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(row.key)}
                    aria-expanded={!collapsed.has(row.key)}
                    aria-label={collapsed.has(row.key) ? `Show ${row.label}` : `Hide ${row.label}`}
                    title={collapsed.has(row.key) ? "Show this month" : "Hide this month"}
                    className="-ml-1 mb-0.5 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <ChevronDown className={cn("h-4 w-4 transition-transform", collapsed.has(row.key) && "-rotate-90")} />
                  </button>
                  <h2 className="text-base font-semibold">{row.label}</h2>
                  <button
                    type="button"
                    onClick={() => toggleMonth(row)}
                    aria-label={all ? `Deselect all of ${row.label}` : `Select all of ${row.label}`}
                    aria-pressed={all ? true : picked ? "mixed" : false}
                    title={all ? "Deselect this month" : "Select this month"}
                    className={cn(
                      "mb-0.5 flex h-6 w-6 items-center justify-center rounded-full border-2 transition-colors",
                      all ? "border-primary bg-primary text-primary-foreground" : picked ? "border-primary text-link" : "border-muted-foreground/50 text-transparent hover:border-primary"
                    )}
                  >
                    {all ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : picked ? <span className="h-0.5 w-2.5 rounded bg-current" /> : <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                  </button>
                  <span className="mb-0.5 text-sm text-muted-foreground tabular-nums">
                    {monthItems.length.toLocaleString()} item{monthItems.length === 1 ? "" : "s"}
                    {picked > 0 && !all && ` · ${picked.toLocaleString()} selected`}
                  </span>
                </div>
              )
            }
            return (
            <div
              key={v.key}
              className="absolute left-0 top-0 grid w-full"
              style={{
                transform: y,
                gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
                gap: GAP,
              }}
            >
              {items.slice(row.start, row.end).map((item) => {
                const Item = listView ? ListRow : Tile
                return (
                <Item
                  key={item.name}
                  root={root}
                  folder={folder}
                  item={item}
                  note={flags.photos[item.name]?.[1]}
                  tempNote={notes?.[item.name]?.note}
                  caption={!!notes}
                  flagged={item.name in flags.photos}
                  selected={selected.has(item.name)}
                  focused={focus === item.name}
                  onClick={(e) => onTileClick(e, item.name)}
                  onDoubleClick={() => setViewer(indexOf.get(item.name) ?? 0)}
                  onToggle={() => toggle(item.name)}
                  onContextMenu={(e) => openMenu(e, item.name)}
                  onDragStart={canDragToFolder ? (e) => dragTile(e, item.name) : undefined}
                />
                )
              })}
            </div>
            )
          })
        )}
      </div>

      {menu && (
        <PhotoMenu
          x={menu.x}
          y={menu.y}
          count={menu.names.length}
          canRotate={menuImages.length > 0}
          showMove={root !== "dropoff"}
          canMove={canMove && !busy}
          canEdit={canEdit && !busy}
          canTemp={!busy}
          canRename={root === "temp" && folder.length > 0 && canEdit}
          showBadPhotos={!!menu.flagged}
          onAction={onMenu}
          onClose={closeMenu}
        />
      )}
      {viewerOpen && (
        <Lightbox
          root={root}
          rootDir={rootDir}
          folder={folder}
          items={items}
          index={viewerIndex}
          canMove={canMove}
          canEdit={canEdit}
          busy={busy}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
          onMove={(name) => run("move", [name])}
          onDelete={(name) => run("delete", [name])}
          onRotate={(name, dir) => run(dir === "cw" ? "rotate-cw" : "rotate-ccw", [name])}
          notes={notes}
          onTemp={(name) => setTemp([name])}
        />
      )}
      {renaming !== null && <RenameDialog kind="file" parent={folder} name={renaming} onClose={() => setRenaming(null)} onDone={() => refresh()} />}
      {temp && (
        <TempDialog
          target={{ root, folder, names: temp }}
          canMove={canEdit}
          onDone={(ok, moved) => {
            if (moved) hide(ok)
            refresh()
          }}
          onClose={() => setTemp(null)}
        />
      )}
    </div>
    </DurationsContext.Provider>
  )
}
