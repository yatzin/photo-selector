"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { ChevronDown, ChevronRight, Copy, Folder, FolderPlus, Loader2, Music, Pencil, Play, Plus, Trash2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatBytes, mediaUrl } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useStoredValue } from "@/lib/hooks/use-stored-state"

import { formatTimecode } from "@/lib/video/time"
import { allClips, assetKind, assetLabel, type Project } from "@/lib/video/project"
import { listTempFolderAction, type TempListing } from "@/lib/actions/video-projects"
import { Thumb } from "./thumb"
import { Callout } from "./ui/callout"
import { EllipsisButton, useMenuState, type MenuItem } from "./popup-menu"
import { ResizeHandle } from "./resize-handle"
import { DeleteTempDialog, NewFolderDialog, RenameDialog, TempPreviewDialog, type DeleteTarget, type TempFile } from "./temp-dialogs"
import { useTempUpload } from "./use-temp-upload"
import { CancelButton, DialogFooter, EditorDialog, PrimaryButton, useEditorDialog } from "./ui/editor-dialog"
import { isStockKey, parseStockDrag } from "@/lib/stock/drag"
import type { StockRef } from "@/lib/stock/types"
import { ASSET_DRAG_TYPE, INBOX_DRAG_TYPE, STOCK_DRAG_TYPE } from "./timeline"
import { StockPanel } from "./stock-panel"

// Left panel: the project's own media (already imported) above Personal
// Storage (folders closed until opened), with a draggable bar between them that
// sets how much room Project media gets. Personal Storage files are dragged onto
// the timeline or the player, or onto Project media (that copies them into it). Files dragged from the computer onto Project media
// upload into it, as the editor bar's Import button does (onImportFiles). A
// sound file shows a music note instead of a thumbnail. A Project media item
// is deleted from its right-click menu (or Delete on the focused row), after a
// warning that says how many timeline clips go with it.

/** A folder of Personal Storage as the list shows it: its name and how many media files it holds, all levels down. */
export type TempFolder = { name: string; mediaCount: number }

/** What a Personal Storage row can ask its folder to do with a file. */
type FileActions = {
  onPreview: () => void
  onRename: () => void
  onDelete: () => void
  /** Copies the file into Project media (what dragging it there does). */
  onCopy: () => void
}

/** One photo or video in a Personal Storage folder: draggable onto the timeline, the player or Project media, with an ellipsis menu and the same menu on right-click. */
function TempFileRow({ segments, file, importing, actions }: { segments: string[]; file: TempFile; importing: string | null; actions: FileActions }) {
  const folder = segments.join("/")
  const key = `${folder}/${file.name}`
  const menu = useMenuState(
    () => [
      { label: "Preview", icon: Play, onSelect: actions.onPreview },
      { label: "Copy to Project media", icon: Copy, onSelect: actions.onCopy },
      "separator",
      { label: "Rename…", icon: Pencil, onSelect: actions.onRename },
      { label: "Delete…", icon: Trash2, onSelect: actions.onDelete, danger: true },
    ],
    `${file.name} actions`
  )
  return (
    <li
      draggable
      title="Double-click to preview"
      onDragStart={(e) => {
        e.dataTransfer.setData(INBOX_DRAG_TYPE, JSON.stringify({ folder, name: file.name }))
        e.dataTransfer.effectAllowed = "copy"
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return
        actions.onPreview()
      }}
      onContextMenu={menu.onContextMenu}
      className="group/row flex cursor-grab items-center gap-2 rounded-md p-1 hover:bg-muted/60 active:cursor-grabbing"
    >
      <Thumb src={mediaUrl("temp", segments, file.name, "thumb", String(file.size))} className="h-9 w-14 shrink-0 rounded bg-muted object-cover" />
      <span className="min-w-0 flex-1">
        <span className="block truncate" title={file.name}>{file.name}</span>
        <span className="block text-[11px] text-muted-foreground">{formatBytes(file.size)}</span>
      </span>
      {importing === key && <Loader2 className="mr-1 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Importing" role="status" />}
      <EllipsisButton label={`${file.name} actions`} onOpen={menu.openFrom} className={HOVER_ONLY} />
      {menu.menu}
    </li>
  )
}

/** Shown on row hover or focus (always on touch screens). */
const HOVER_ONLY = "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"

/**
 * One Personal Storage folder, collapsed until opened. Its contents (files and
 * subfolders) are fetched the first time it opens, so a big storage costs
 * nothing until someone looks inside, and again after a change. A file is
 * dragged onto the timeline, the player or Project media as
 * { folder: "user/sub", name }; double-click opens a preview that plays it.
 * Everything else is in an ellipsis menu on each row, also opened by
 * right-click: on a folder New folder, Upload media, Rename and Delete (not
 * for a user's own folder, the first level); on a file Preview, Copy to
 * Project media, Rename and Delete. Each change asks in a dialog first.
 */
function TempFolderNode({ segments, count, importing, onCopy, onChanged }: { segments: string[]; count: number; importing: string | null; onCopy: (folder: string, name: string) => void; onChanged?: () => void }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<{ status: "idle" } | { status: "loading" } | { status: "error"; error: string } | { status: "ready"; listing: TempListing }>({ status: "idle" })
  const [dialog, setDialog] = useState<
    { kind: "new" } | { kind: "rename-folder" } | { kind: "rename-file"; file: TempFile } | { kind: "preview"; file: TempFile } | { kind: "delete"; target: DeleteTarget } | null
  >(null)
  const folder = segments.join("/")
  const name = segments[segments.length - 1]
  // A user's own folder (the first level) is never renamed or deleted from here.
  const editable = segments.length >= 2

  function load() {
    setState((s) => (s.status === "ready" ? s : { status: "loading" }))
    listTempFolderAction(segments).then(
      (r) => setState("error" in r ? { status: "error", error: r.error } : { status: "ready", listing: r }),
      () => setState({ status: "error", error: "Couldn't load this folder." })
    )
  }

  /** Opens the folder (loading it the first time, or again after a failure). */
  function reveal() {
    setOpen(true)
    if (state.status === "idle" || state.status === "error") load()
  }

  const upload = useTempUpload(segments, load)

  const menu = useMenuState(
    () => [
      { label: "New folder…", icon: FolderPlus, onSelect: () => setDialog({ kind: "new" }) },
      { label: "Upload media…", icon: Upload, onSelect: () => { reveal(); upload.pick() } },
      ...(editable
        ? ([
            "separator",
            { label: "Rename…", icon: Pencil, onSelect: () => setDialog({ kind: "rename-folder" }) },
            { label: "Delete…", icon: Trash2, onSelect: () => setDialog({ kind: "delete", target: { kind: "folder", parent: segments.slice(0, -1), name, count } }), danger: true },
          ] as MenuItem[])
        : []),
    ],
    `${name} actions`
  )

  return (
    <div className="px-2" onContextMenu={menu.onContextMenu}>
      <div className="group/row flex items-center rounded-md hover:bg-muted/60">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => (open ? setOpen(false) : reveal())}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
          <Folder className="h-4 w-4 shrink-0 text-link" strokeWidth={1.5} />
          <span className="truncate font-medium" title={name}>{name}</span>
          <span className="ml-auto pl-2 text-[11px] text-muted-foreground">{count}</span>
        </button>
        <EllipsisButton label={`${name} actions`} onOpen={menu.openFrom} className={HOVER_ONLY} />
      </div>
      {menu.menu}
      {upload.element}
      {open && (
        <div className="ml-3">
          {state.status === "loading" && (
            <p className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>
          )}
          {state.status === "error" && <p className="px-2 py-1 text-xs text-destructive">{state.error}</p>}
          {state.status === "ready" && (
            <>
              {state.listing.folders.length === 0 && state.listing.files.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">Empty. Right-click to add a folder or upload media.</p>}
              {state.listing.folders.map((f) => (
                <TempFolderNode key={f.name} segments={[...segments, f.name]} count={f.mediaCount} importing={importing} onCopy={onCopy} onChanged={load} />
              ))}
              <ul className="ml-2">
                {state.listing.files.map((file) => (
                  <TempFileRow
                    key={file.name}
                    segments={segments}
                    file={file}
                    importing={importing}
                    actions={{
                      onPreview: () => setDialog({ kind: "preview", file }),
                      onRename: () => setDialog({ kind: "rename-file", file }),
                      onDelete: () => setDialog({ kind: "delete", target: { kind: "file", parent: segments, file } }),
                      onCopy: () => onCopy(folder, file.name),
                    }}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {dialog?.kind === "new" && (
        <NewFolderDialog
          parent={segments}
          onClose={() => setDialog(null)}
          onDone={() => {
            setOpen(true)
            load()
          }}
        />
      )}
      {dialog?.kind === "rename-folder" && <RenameDialog kind="folder" parent={segments.slice(0, -1)} name={name} onClose={() => setDialog(null)} onDone={() => onChanged?.()} />}
      {dialog?.kind === "rename-file" && <RenameDialog kind="file" parent={segments} name={dialog.file.name} onClose={() => setDialog(null)} onDone={load} />}
      {dialog?.kind === "preview" && <TempPreviewDialog parent={segments} file={dialog.file} onClose={() => setDialog(null)} />}
      {dialog?.kind === "delete" && (
        <DeleteTempDialog
          target={dialog.target}
          onClose={() => setDialog(null)}
          onDone={() => {
            // A deleted folder is gone from its parent's list; a deleted file from this one.
            if (dialog.target.kind === "folder") onChanged?.()
            else load()
          }}
        />
      )}
    </div>
  )
}

/** The right-click menu of a Project media row: one item, Delete. Closes on Esc, a press outside, scroll or resize. */
function RowMenu({ x, y, file, disabled, onDelete, onClose }: { x: number; y: number; file: string; disabled: boolean; onDelete: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: Event) => {
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return
      if (e.type === "pointerdown" && ref.current?.contains(e.target as Node)) return
      onClose()
    }
    window.addEventListener("pointerdown", close, true)
    window.addEventListener("keydown", close, true)
    window.addEventListener("resize", close)
    window.addEventListener("scroll", close, true)
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
    return () => {
      window.removeEventListener("pointerdown", close, true)
      window.removeEventListener("keydown", close, true)
      window.removeEventListener("resize", close)
      window.removeEventListener("scroll", close, true)
    }
  }, [onClose])

  // Keep the menu on screen near the pointer.
  const W = 220
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${file} actions`}
      className="fixed z-50 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left: Math.min(x, window.innerWidth - W - 8), top: Math.min(y, window.innerHeight - 48), width: W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        title={disabled ? "Wait for the import to finish" : undefined}
        onClick={() => {
          onClose()
          onDelete()
        }}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-destructive outline-none hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-40"
      >
        <Trash2 className="h-4 w-4" /> Delete from project…
      </button>
    </div>
  )
}

/** The room Project media and Personal Storage each keep when the bar between them is dragged. */
const MIN_MEDIA = 72
const MIN_STORAGE = 120

/** True for a drag of a Personal Storage file. */
const isTempDrag = (dt: DataTransfer) => dt.types.includes(INBOX_DRAG_TYPE)

/** True for a drag of a Stock tab result. */
const isStockDrag = (dt: DataTransfer) => dt.types.includes(STOCK_DRAG_TYPE)

/** True for a drag of files from the computer (not one of the app's own drags: a Personal Storage file, a stock result, a media item, a clip). */
const isFileDrag = (dt: DataTransfer) => dt.types.includes("Files") && !dt.types.includes(ASSET_DRAG_TYPE) && !dt.types.includes(INBOX_DRAG_TYPE) && !dt.types.includes(STOCK_DRAG_TYPE)

type LowerTab = "storage" | "stock"
const LOWER_TABS: { id: LowerTab; label: string }[] = [
  { id: "storage", label: "Personal Storage" },
  { id: "stock", label: "Stock" },
]
const TAB_KEY = "ps.video.mediaTab"
const TAB_EVENT = "ps-media-tab"

/** The lower half's tab, remembered for the browser session (sessionStorage, which may be unavailable: the tab still switches). */
function useLowerTab(): [LowerTab, (t: LowerTab) => void] {
  const [local, setLocal] = useState<LowerTab | null>(null)
  const stored = useSyncExternalStore(
    (cb) => {
      window.addEventListener(TAB_EVENT, cb)
      return () => window.removeEventListener(TAB_EVENT, cb)
    },
    () => {
      try {
        return window.sessionStorage.getItem(TAB_KEY)
      } catch {
        return null
      }
    },
    () => null
  )
  const tab: LowerTab = local ?? (stored === "stock" ? "stock" : "storage")
  const set = useCallback((t: LowerTab) => {
    setLocal(t)
    try {
      window.sessionStorage.setItem(TAB_KEY, t)
    } catch {
      // not remembered; the tab still switches
    }
    window.dispatchEvent(new Event(TAB_EVENT))
  }, [])
  return [tab, set]
}

export function FileTree({
  temp, project, thumbUrl, importing, onAdd, onDelete, onImportFiles, onCopyTemp, onImportStock,
}: {
  /** The top-level folders of Personal Storage, one per user; their contents load when opened. */
  temp: TempFolder[]
  project: Project
  thumbUrl: (assetId: string) => string
  /** "folder/name" of the Personal Storage file being imported, or the stockKey of a stock result downloading, if any. */
  importing: string | null
  /** Puts an imported asset on the end of the timeline. */
  onAdd: (assetId: string) => void
  /** Deletes a media item (and its clips) from the project; true when it's gone. */
  onDelete: (assetId: string) => Promise<boolean>
  /** Files from the computer dropped on Project media: upload them into it. */
  onImportFiles: (files: File[]) => void
  /** A Personal Storage file (folder path, name) to copy into Project media: dropped on it, or chosen from a menu. */
  onCopyTemp: (folder: string, name: string) => void
  /** A Stock tab result dropped on Project media: download it into it, not placed. */
  onImportStock: (ref: StockRef) => void
}) {
  const [lowerTab, setLowerTab] = useLowerTab()
  const tabRefs = useRef<Partial<Record<LowerTab, HTMLButtonElement | null>>>({})
  /** Left/Right move to the neighbouring tab (wrapping), Home/End to the first/last; the tab is activated and focused. */
  function onTabKey(e: React.KeyboardEvent, id: LowerTab) {
    const i = LOWER_TABS.findIndex((t) => t.id === id)
    const last = LOWER_TABS.length - 1
    const to = e.key === "ArrowRight" ? (i + 1) % LOWER_TABS.length : e.key === "ArrowLeft" ? (i + last) % LOWER_TABS.length : e.key === "Home" ? 0 : e.key === "End" ? last : -1
    if (to < 0) return
    e.preventDefault()
    const next = LOWER_TABS[to].id
    setLowerTab(next)
    tabRefs.current[next]?.focus()
  }
  // Files from the computer over Project media: its drop outline.
  const [fileOver, setFileOver] = useState(false)
  // Project media's height: none stored (the default) fits its items, up to half the panel.
  const [storedHeight, setStoredHeight] = useStoredValue("ps.video.mediaHeight")
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const parsedHeight = storedHeight ? Number(storedHeight) : NaN
  const mediaHeight = dragHeight ?? (parsedHeight >= MIN_MEDIA ? parsedHeight : null)
  const box = useRef<HTMLDivElement>(null)
  const mediaBox = useRef<HTMLElement>(null)
  const [sizes, setSizes] = useState({ media: 0, box: 0 })
  useEffect(() => {
    const outer = box.current
    const inner = mediaBox.current
    if (!outer || !inner) return
    const ro = new ResizeObserver(() => setSizes({ media: Math.round(inner.offsetHeight), box: outer.clientHeight }))
    ro.observe(outer)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])
  const maxMedia = Math.max(MIN_MEDIA, sizes.box - 8 - MIN_STORAGE)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const closeMenu = useCallback(() => setMenu(null), [])
  // A retimed copy (Speed / Reverse) belongs to its clip, not to the media list.
  const assets = Object.entries(project.assets).filter(([, a]) => a.retime === undefined)
  // An item whose Personal Storage file is being imported again can't be deleted until that's done.
  const locked = (id: string) => importing !== null && project.assets[id]?.source === importing
  const confirmAsset = confirm === null ? undefined : project.assets[confirm]
  // Counted from the live timeline each render, so the warning stays right while the dialog is open.
  const uses = confirm === null ? 0 : allClips(project).filter((c) => c.asset === confirm).length

  async function deleteConfirmed() {
    if (confirm === null || busy) return
    setBusy(true)
    try {
      await onDelete(confirm)
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  return (
    <div ref={box} className="flex h-full flex-col text-sm">
      <section
        ref={mediaBox}
        aria-label="Project media"
        data-testid="project-media"
        style={mediaHeight === null ? undefined : { height: mediaHeight }}
        className={cn("relative shrink-0 overflow-y-auto rounded-md pb-1", mediaHeight === null && "max-h-[50%]", fileOver && "outline-2 -outline-offset-2 outline-dashed outline-sky-500 bg-sky-500/10 dark:outline-editor-accent dark:bg-editor-accent/10")}
        onDragOver={(e) => {
          if (!isFileDrag(e.dataTransfer) && !isTempDrag(e.dataTransfer) && !isStockDrag(e.dataTransfer)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = "copy"
          setFileOver(true)
        }}
        onDragLeave={(e) => {
          if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
          setFileOver(false)
        }}
        onDrop={(e) => {
          setFileOver(false)
          if (isTempDrag(e.dataTransfer)) {
            e.preventDefault()
            try {
              const { folder, name } = JSON.parse(e.dataTransfer.getData(INBOX_DRAG_TYPE)) as { folder?: unknown; name?: unknown }
              if (typeof folder === "string" && typeof name === "string") onCopyTemp(folder, name)
            } catch {
              // Not one of ours.
            }
            return
          }
          if (isStockDrag(e.dataTransfer)) {
            e.preventDefault()
            const r = parseStockDrag(e.dataTransfer.getData(STOCK_DRAG_TYPE))
            if (r) onImportStock({ source: r.source, id: r.id, kind: r.kind })
            return
          }
          if (!isFileDrag(e.dataTransfer)) return
          e.preventDefault()
          onImportFiles(Array.from(e.dataTransfer.files))
        }}
      >
        <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Project media</p>
        {assets.length === 0 && <p className="px-3 pb-2 text-xs text-muted-foreground">Import files, drop them here, or drag them from Personal Storage below.</p>}
        {fileOver && (
          <div aria-hidden className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="flex items-center gap-1.5 rounded-md bg-neutral-900/80 px-2.5 py-1 text-xs text-white shadow"><Upload className="h-3.5 w-3.5" /> Drop to import</span>
          </div>
        )}
        {isStockKey(importing) && (
          <p className="flex items-center gap-1.5 px-3 pb-1 text-xs text-muted-foreground" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Downloading…</p>
        )}
        <ul className="px-2">
          {assets.map(([id, a]) => (
            <li
              key={id}
              draggable
              tabIndex={0}
              aria-label={`${assetLabel(a)}, press Delete to remove it from the project`}
              onDragStart={(e) => {
                e.dataTransfer.setData(ASSET_DRAG_TYPE, id)
                e.dataTransfer.effectAllowed = "copy"
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                // The keyboard's menu key has no pointer position: open by the row.
                const r = e.currentTarget.getBoundingClientRect()
                const keyboard = e.clientX === 0 && e.clientY === 0
                setMenu({ id, x: keyboard ? r.left + 16 : e.clientX, y: keyboard ? r.bottom : e.clientY })
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget || (e.key !== "Delete" && e.key !== "Backspace")) return
                // Handled here: the editor's Delete (remove the selected clip) skips a prevented key.
                e.preventDefault()
                if (!locked(id)) setConfirm(id)
              }}
              className="group flex cursor-grab items-center gap-2 rounded-md p-1 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
            >
              {assetKind(a) === "audio" ? (
                <span aria-hidden className="flex h-9 w-14 shrink-0 items-center justify-center rounded bg-teal-500/20 text-teal-700 dark:bg-teal-400/20 dark:text-teal-200">
                  <Music className="h-4 w-4" />
                </span>
              ) : (
                <Thumb src={thumbUrl(id)} className="h-9 w-14 shrink-0 rounded bg-muted object-cover" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate" title={assetLabel(a)}>{assetLabel(a)}</span>
                <span className="block text-[11px] text-muted-foreground tabular-nums">
                  {assetKind(a) === "image" ? `Image · ${formatTimecode(a.duration)}` : assetKind(a) === "audio" ? `Audio · ${formatTimecode(a.duration)}` : formatTimecode(a.duration)}
                </span>
              </span>
              <Button type="button" size="icon-sm" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onAdd(id)} title="Add to timeline">
                <Plus className="h-4 w-4" />
                <span className="sr-only">Add {assetLabel(a)} to timeline</span>
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <ResizeHandle
        label="Resize Project media"
        value={Math.min(maxMedia, Math.max(MIN_MEDIA, sizes.media))}
        min={MIN_MEDIA}
        max={maxMedia}
        onResize={(px, done) => {
          if (!done) return setDragHeight(px)
          setStoredHeight(String(px))
          setDragHeight(null)
        }}
        onReset={() => {
          setStoredHeight("")
          setDragHeight(null)
        }}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <div role="tablist" aria-label="Media sources" className="flex shrink-0 gap-0.5 border-b px-2 pt-1">
          {LOWER_TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el
              }}
              type="button"
              role="tab"
              id={`media-tab-${t.id}`}
              aria-selected={lowerTab === t.id}
              aria-controls={`media-panel-${t.id}`}
              tabIndex={lowerTab === t.id ? 0 : -1}
              onClick={() => setLowerTab(t.id)}
              onKeyDown={(e) => onTabKey(e, t.id)}
              className={cn(
                "-mb-px rounded-t-md border-b-2 px-2.5 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                lowerTab === t.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id="media-panel-storage"
          aria-labelledby="media-tab-storage"
          hidden={lowerTab !== "storage"}
          className="min-h-0 flex-1 overflow-y-auto pb-2"
        >
          <p className="mt-2 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Personal Storage</p>
          <p className="px-3 pb-1 text-xs text-muted-foreground">Drag media to Project media or the timeline. Right-click for more.</p>
          {temp.length === 0 && <p className="px-3 text-xs text-muted-foreground">Nothing in Personal Storage yet.</p>}
          {temp.map((f) => (
            <TempFolderNode key={f.name} segments={[f.name]} count={f.mediaCount} importing={importing} onCopy={onCopyTemp} />
          ))}
        </div>
        {/* Kept mounted (hidden) while another tab shows, so a search isn't lost. */}
        <div
          role="tabpanel"
          id="media-panel-stock"
          aria-labelledby="media-tab-stock"
          hidden={lowerTab !== "stock"}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <StockPanel project={project} />
        </div>
      </div>

      {menu && project.assets[menu.id] && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          file={assetLabel(project.assets[menu.id])}
          disabled={locked(menu.id)}
          onDelete={() => setConfirm(menu.id)}
          onClose={closeMenu}
        />
      )}
      {confirm !== null && confirmAsset && (
        <DeleteAssetDialog file={assetLabel(confirmAsset)} uses={uses} busy={busy} locked={locked(confirm)} onConfirm={() => void deleteConfirmed()} onClose={() => setConfirm(null)} />
      )}
    </div>
  )
}

/** "Delete from project": what the item's deletion takes with it, on the editor's dialog shell. */
function DeleteAssetDialog({ file, uses, busy, locked, onConfirm, onClose }: { file: string; uses: number; busy: boolean; locked: boolean; onConfirm: () => void; onClose: () => void }) {
  const state = useEditorDialog(onClose)
  return (
    <EditorDialog
      state={state}
      icon={Trash2}
      title="Delete from project"
      subtitle={file}
      size="sm"
      dismissible={!busy}
      onSubmit={() => !busy && !locked && onConfirm()}
      footer={
        <DialogFooter>
          <CancelButton state={state} disabled={busy} initialFocus />
          <PrimaryButton
            busy={busy}
            disabledReason={locked ? "It's being imported again: wait for that to finish." : null}
            className="bg-destructive text-white hover:bg-destructive/90 dark:text-neutral-950"
          >
            {busy ? <Loader2 className="motion-safe:animate-spin" /> : <Trash2 />}
            Delete file
          </PrimaryButton>
        </DialogFooter>
      }
    >
      <Callout tone="danger" title="This can't be undone">
        <p className="break-words">
          {uses > 0
            ? `${file} is removed from the project media and from the timeline (${uses} clip${uses === 1 ? " uses" : "s use"} it).`
            : `${file} is removed from the project media. It is not on the timeline.`}
        </p>
      </Callout>
    </EditorDialog>
  )
}
