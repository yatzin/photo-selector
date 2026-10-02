"use client"

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Check, FolderOutput, ImageOff, Loader2, Play, RotateCcw, RotateCw, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatBytes, mediaUrl } from "@/lib/format"
import { useStoredState } from "@/lib/hooks/use-stored-state"
import { deleteAction, moveToDropoffAction, rotateAction, undoDeleteAction } from "@/lib/actions/media"
import type { FileEntry } from "@/lib/library-server"
import { Lightbox } from "./lightbox"

// The sorting grid. A click (or tap) toggles a photo in or out of the
// selection, so picking many is just clicking each one. Shift-click adds the
// whole range from the last clicked photo, Ctrl/⌘+A selects all. Double-click
// (double-tap) or Enter opens the viewer; the two clicks cancel out, so the
// selection is unchanged.
//
// Keys: arrows move the focus, Space toggles it, Shift+arrows add a range,
// Del deletes, M moves to Sort Dropoff, R / Shift+R rotate, Esc clears.

const SIZES = { s: 128, m: 192, l: 288 } as const
type SizeKey = keyof typeof SIZES
const ORDERS = ["newest", "oldest", "name"] as const
type Order = (typeof ORDERS)[number]

type Props = { root: string; folder: string[]; files: FileEntry[]; canMove: boolean; canEdit: boolean }

type ActionResult = { ok: string[]; failed: { name: string; error: string }[] } | { error: string }

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))
}

function Tile({
  root, folder, item, size, selected, focused, onClick, onDoubleClick, onToggle,
}: {
  root: string
  folder: string[]
  item: FileEntry
  size: number
  selected: boolean
  focused: boolean
  onClick: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onToggle: () => void
}) {
  const [failed, setFailed] = useState(false)
  return (
    <div
      data-name={item.name}
      className={cn(
        "group relative aspect-square cursor-pointer select-none overflow-hidden rounded-md bg-muted",
        selected && "ring-[3px] ring-primary ring-offset-2 ring-offset-background",
        focused && !selected && "ring-2 ring-ring/60"
      )}
      // touch-action: no double-tap zoom, so a double-tap reaches onDoubleClick.
      style={{ contentVisibility: "auto", containIntrinsicSize: `${size}px ${size}px`, touchAction: "manipulation" }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={item.name}
    >
      {failed ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-muted-foreground">
          <ImageOff className="h-6 w-6" strokeWidth={1.5} />
          <span className="line-clamp-2 break-all text-center text-[11px]">{item.name}</span>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- served from our own cache, already sized
        <img
          src={mediaUrl(root, folder, item.name, "thumb", item.version)}
          alt={item.name}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className={cn("h-full w-full object-cover transition-transform duration-150", selected && "scale-[0.94]")}
        />
      )}
      {item.kind === "video" && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-[28%] min-h-10 w-[28%] min-w-10 items-center justify-center rounded-full bg-black/55 text-white shadow-lg ring-1 ring-white/30 backdrop-blur-[2px]">
            <Play className="h-1/2 w-1/2 translate-x-[6%] fill-current" />
          </span>
        </span>
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
}

export function MediaGrid({ root, folder, files, canMove, canEdit }: Props) {
  const router = useRouter()
  const [sizeKey, setSizeKey] = useStoredState<SizeKey>("ps.tileSize", "m", ["s", "m", "l"])
  const [order, setOrder] = useStoredState<Order>("ps.order", "newest", ORDERS)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [viewer, setViewer] = useState<number | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [, startTransition] = useTransition()
  const gridRef = useRef<HTMLDivElement>(null)

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

  const selectRange = useCallback((from: string | null, to: string, additive: boolean) => {
    const a = from !== null ? indexOf.get(from) : undefined
    const b = indexOf.get(to)
    if (b === undefined) return
    const start = Math.min(a ?? b, b)
    const end = Math.max(a ?? b, b)
    setSelected((prev) => {
      const next = additive ? new Set(prev) : new Set<string>()
      for (let i = start; i <= end; i++) next.add(items[i].name)
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
                const restored = report(await undoDeleteAction(root, result.batchId), "restore")
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

  const columns = () => {
    const el = gridRef.current
    if (!el) return 1
    return Math.max(1, getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length)
  }

  const scrollTo = (name: string) => {
    gridRef.current?.querySelector(`[data-name="${CSS.escape(name)}"]`)?.scrollIntoView({ block: "nearest" })
  }

  // One key handler for both the grid and the viewer, so shortcuts work the same in each.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (isTyping(e.target) || e.altKey) return
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

  const tile = SIZES[sizeKey]
  const imageNames = chosen.filter((f) => f.kind === "image").map((f) => f.name)
  const names = chosen.map((f) => f.name)

  return (
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
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="name">Name</option>
              </select>
              <div className="flex rounded-lg border border-input p-0.5" role="group" aria-label="Thumbnail size">
                {(Object.keys(SIZES) as SizeKey[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setSizeKey(k)}
                    aria-pressed={sizeKey === k}
                    className={cn(
                      "h-7 w-7 rounded-md text-xs font-medium uppercase",
                      sizeKey === k ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      <div
        ref={gridRef}
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${tile}px, 40vw), 1fr))` }}
      >
        {items.map((item) => (
          <Tile
            key={item.name}
            root={root}
            folder={folder}
            item={item}
            size={tile}
            selected={selected.has(item.name)}
            focused={focus === item.name}
            onClick={(e) => onTileClick(e, item.name)}
            onDoubleClick={() => setViewer(indexOf.get(item.name) ?? 0)}
            onToggle={() => toggle(item.name)}
          />
        ))}
      </div>

      {viewerOpen && (
        <Lightbox
          root={root}
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
        />
      )}
    </div>
  )
}
