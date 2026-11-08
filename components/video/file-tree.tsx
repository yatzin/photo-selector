"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight, Folder, Loader2, Music, Plus, Trash2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { formatBytes, mediaUrl } from "@/lib/format"
import { cn } from "@/lib/utils"

import { formatTimecode } from "@/lib/video/time"
import { allClips, assetKind, type Project } from "@/lib/video/project"
import { Thumb } from "./thumb"
import { ASSET_DRAG_TYPE, INBOX_DRAG_TYPE } from "./timeline"

// Left panel: the project's own media (already imported) and the Video Editing
// Inbox, whose files are dragged onto the timeline or the player (that copies
// them into Project media). Files dragged from the computer onto Project media
// upload into it, as the editor bar's Import button does (onImportFiles). A
// sound file shows a music note instead of a thumbnail. A Project media item
// is deleted from its right-click menu (or Delete on the focused row), after a
// warning that says how many timeline clips go with it.

export type InboxFolder = { folder: string; files: { name: string; size: number; kind: "image" | "video" }[] }

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

/** True for a drag of files from the computer (not one of the app's own drags: an Inbox file, a media item, a clip). */
const isFileDrag = (dt: DataTransfer) => dt.types.includes("Files") && !dt.types.includes(ASSET_DRAG_TYPE) && !dt.types.includes(INBOX_DRAG_TYPE)

export function FileTree({
  inbox, project, thumbUrl, importing, onAdd, onDelete, onImportFiles,
}: {
  inbox: InboxFolder[]
  project: Project
  thumbUrl: (assetId: string) => string
  /** "folder/name" of the Inbox file being imported, if any. */
  importing: string | null
  /** Puts an imported asset on the end of the timeline. */
  onAdd: (assetId: string) => void
  /** Deletes a media item (and its clips) from the project; true when it's gone. */
  onDelete: (assetId: string) => Promise<boolean>
  /** Files from the computer dropped on Project media: upload them into it. */
  onImportFiles: (files: File[]) => void
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  // Files from the computer over Project media: its drop outline.
  const [fileOver, setFileOver] = useState(false)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const closeMenu = useCallback(() => setMenu(null), [])
  const assets = Object.entries(project.assets)
  // An item whose Inbox file is being imported again can't be deleted until that's done.
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
    <div className="flex h-full flex-col overflow-y-auto text-sm">
      <section
        aria-label="Project media"
        data-testid="project-media"
        className={cn("relative rounded-md pb-1", fileOver && "outline-2 -outline-offset-2 outline-dashed outline-sky-500 bg-sky-500/10 dark:outline-editor-accent dark:bg-editor-accent/10")}
        onDragOver={(e) => {
          if (!isFileDrag(e.dataTransfer)) return
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
          if (!isFileDrag(e.dataTransfer)) return
          e.preventDefault()
          onImportFiles(Array.from(e.dataTransfer.files))
        }}
      >
        <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Project media</p>
        {assets.length === 0 && <p className="px-3 pb-2 text-xs text-muted-foreground">Import files, drop them here, or drag them from the Inbox below onto the timeline.</p>}
        {fileOver && (
          <div aria-hidden className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="flex items-center gap-1.5 rounded-md bg-neutral-900/80 px-2.5 py-1 text-xs text-white shadow"><Upload className="h-3.5 w-3.5" /> Drop to import</span>
          </div>
        )}
        <ul className="px-2">
          {assets.map(([id, a]) => (
            <li
              key={id}
              draggable
              tabIndex={0}
              aria-label={`${a.file}, press Delete to remove it from the project`}
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
                <span className="block truncate" title={a.file}>{a.file}</span>
                <span className="block text-[11px] text-muted-foreground tabular-nums">
                  {assetKind(a) === "image" ? `Image · ${formatTimecode(a.duration)}` : assetKind(a) === "audio" ? `Audio · ${formatTimecode(a.duration)}` : formatTimecode(a.duration)}
                </span>
              </span>
              <Button type="button" size="icon-sm" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onAdd(id)} title="Add to timeline">
                <Plus className="h-4 w-4" />
                <span className="sr-only">Add {a.file} to timeline</span>
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-3 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Inbox</p>
      <p className="px-3 pb-1 text-xs text-muted-foreground">Drag clips onto the timeline</p>
      {inbox.length === 0 && <p className="px-3 text-xs text-muted-foreground">No videos or images in the Video Editing Inbox yet.</p>}
      {inbox.map((f) => {
        const expanded = open[f.folder] ?? true
        return (
          <div key={f.folder} className="px-2">
            <button type="button" className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-left hover:bg-muted/60" onClick={() => setOpen((o) => ({ ...o, [f.folder]: !expanded }))}>
              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <Folder className="h-4 w-4 text-link" strokeWidth={1.5} />
              <span className="truncate font-medium">{f.folder}</span>
              <span className="ml-auto text-[11px] text-muted-foreground">{f.files.length}</span>
            </button>
            {expanded && (
              <ul className="ml-5">
                {f.files.map((file) => {
                  const key = `${f.folder}/${file.name}`
                  return (
                    <li
                      key={key}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(INBOX_DRAG_TYPE, JSON.stringify({ folder: f.folder, name: file.name }))
                        e.dataTransfer.effectAllowed = "copy"
                      }}
                      className="flex cursor-grab items-center gap-2 rounded-md p-1 hover:bg-muted/60 active:cursor-grabbing"
                    >
                      <Thumb src={mediaUrl("video-inbox", [f.folder], file.name, "thumb", String(file.size))} className="h-9 w-14 shrink-0 rounded bg-muted object-cover" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate" title={file.name}>{file.name}</span>
                        <span className="block text-[11px] text-muted-foreground">{formatBytes(file.size)}</span>
                      </span>
                      {importing === key && (
                        <Loader2 className="mr-1 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Importing" role="status" />
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}

      {menu && project.assets[menu.id] && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          file={project.assets[menu.id].file}
          disabled={locked(menu.id)}
          onDelete={() => setConfirm(menu.id)}
          onClose={closeMenu}
        />
      )}
      {confirm !== null && confirmAsset && (
        <Dialog open onOpenChange={(o) => !o && !busy && setConfirm(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Delete from project</DialogTitle>
              <DialogDescription className="break-words">
                Delete {confirmAsset.file} from this project?{" "}
                {uses > 0
                  ? `It is removed from the project media and from the timeline (${uses} clip${uses === 1 ? " uses" : "s use"} it).`
                  : "It is removed from the project media. It is not on the timeline."}{" "}
                This can&apos;t be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button>
              <Button type="button" variant="destructive" onClick={() => void deleteConfirmed()} disabled={busy || locked(confirm)}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
