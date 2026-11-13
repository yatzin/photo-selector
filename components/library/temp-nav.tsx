"use client"

import { createContext, useContext, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, Loader2, Pencil, Trash2 } from "lucide-react"
import { listTempFolderAction } from "@/lib/actions/video-projects"
import { moveTempFilesAction } from "@/lib/actions/temp"
import { libraryHref } from "@/lib/format"
import { parseTempMediaDrag, TEMP_MEDIA_DRAG, TEMP_MOVED_EVENT } from "@/lib/temp-drag"
import { cn } from "@/lib/utils"
import { useMenuState, type MenuItem } from "@/components/video/popup-menu"
import { DeleteTempDialog, NewFolderDialog, RenameDialog } from "@/components/video/temp-dialogs"

// The left navigation of a user's Personal Storage: their whole folder tree,
// the same folders the video editor's Personal Storage list shows, but each is
// a link to its page. A folder's subfolders load when it is first opened; the
// folders on the way to the page you are on start open, and the page's own
// folder is highlighted.
//
// Folders are made, renamed and deleted here: from the small toolbar on top
// (acting on the folder whose page is open) or from the right-click menu of
// any folder in the tree (a user's own folder, the first level, can only get
// new folders). Dragging photos from the page onto a folder moves them there;
// hovering a closed folder while dragging opens it.

type Dialog =
  | { kind: "new"; parent: string[] }
  | { kind: "rename"; parent: string[]; name: string }
  | { kind: "delete"; parent: string[]; name: string; count: number }

type Ctx = {
  current: string[]
  isOpen: (path: string[]) => boolean
  setOpen: (path: string[], open: boolean) => void
  /** Changes whenever the tree's contents may have changed: open folders fetch again. */
  version: number
  counts: React.RefObject<Map<string, number>>
  ask: (d: Dialog) => void
  moved: (from: string[], to: string[], names: string[]) => Promise<void>
}
const NavContext = createContext<Ctx | null>(null)

const keyOf = (path: string[]) => path.join("/")
const onPathOf = (path: string[], current: string[]) => path.every((s, i) => current[i] === s)

type State = { status: "idle" } | { status: "error"; error: string } | { status: "ready"; folders: { name: string; mediaCount: number }[] }

function Node({ segments, count }: { segments: string[]; count?: number }) {
  const ctx = useContext(NavContext)!
  const { current } = ctx
  const name = segments[segments.length - 1]
  const key = keyOf(segments)
  const here = key === keyOf(current)
  const open = ctx.isOpen(segments)
  const [state, setState] = useState<State>({ status: "idle" })
  const [over, setOver] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editable = segments.length >= 2

  // Open folders fetch their subfolders, and fetch again when the tree changes.
  useEffect(() => {
    if (!open) return
    let live = true
    listTempFolderAction(segments).then(
      (r) => live && setState("error" in r ? { status: "error", error: r.error } : { status: "ready", folders: r.folders }),
      () => live && setState({ status: "error", error: "Couldn't load this folder." })
    )
    return () => {
      live = false
    }
    // `segments` is a new array every render; its path is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key, ctx.version])

  useEffect(() => {
    if (count !== undefined) ctx.counts.current.set(key, count)
  })

  const menu = useMenuState(
    () => [
      { label: "New folder…", icon: FolderPlus, onSelect: () => ctx.ask({ kind: "new", parent: segments }) },
      ...(editable
        ? ([
            "separator",
            { label: "Rename…", icon: Pencil, onSelect: () => ctx.ask({ kind: "rename", parent: segments.slice(0, -1), name }) },
            { label: "Delete…", icon: Trash2, onSelect: () => ctx.ask({ kind: "delete", parent: segments.slice(0, -1), name, count: count ?? 0 }), danger: true },
          ] as MenuItem[])
        : []),
    ],
    `${name} actions`
  )

  const clearTimer = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }
  useEffect(() => clearTimer, [])

  const Icon = open ? FolderOpen : Folder
  return (
    <li>
      <div
        onContextMenu={menu.onContextMenu}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(TEMP_MEDIA_DRAG)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = "move"
          setOver(true)
          // Resting on a closed folder opens it, so a deep folder can be reached in one drag.
          if (!open && !hoverTimer.current) hoverTimer.current = setTimeout(() => ctx.setOpen(segments, true), 700)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setOver(false)
          clearTimer()
        }}
        onDrop={(e) => {
          const drag = parseTempMediaDrag(e.dataTransfer.getData(TEMP_MEDIA_DRAG))
          setOver(false)
          clearTimer()
          if (!drag) return
          e.preventDefault()
          void ctx.moved(drag.folder, segments, drag.names)
        }}
        className={cn("group flex items-center rounded-md", over ? "bg-editor-accent/20 ring-2 ring-editor-accent" : here ? "bg-muted font-medium" : "hover:bg-muted/60")}
      >
        <button
          type="button"
          aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
          aria-expanded={open}
          onClick={() => ctx.setOpen(segments, !open)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <Link
          href={libraryHref("temp", segments)}
          aria-current={here ? "page" : undefined}
          draggable={false}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pr-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon className="h-4 w-4 shrink-0 text-link" strokeWidth={1.5} />
          <span className="truncate" title={name}>{name}</span>
          {count !== undefined && <span className="ml-auto pl-2 text-[11px] text-muted-foreground tabular-nums">{count}</span>}
        </Link>
      </div>
      {menu.menu}
      {open && (
        <div className="ml-3 border-l border-border/60 pl-1">
          {state.status === "idle" && (
            <p className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>
          )}
          {state.status === "error" && <p className="px-2 py-1 text-xs text-destructive">{state.error}</p>}
          {state.status === "ready" && state.folders.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">No folders.</p>}
          {state.status === "ready" && (
            <ul>
              {state.folders.map((f) => (
                <Node key={f.name} segments={[...segments, f.name]} count={f.mediaCount} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

/** The folder tree of the user whose Personal Storage folder `current` is in (its first segment), with a toolbar for making, renaming and deleting folders. */
export function TempNav({ current }: { current: string[] }) {
  const router = useRouter()
  // Folders on the way to the current page are open unless closed here; any other is closed unless opened here.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [version, setVersion] = useState(0)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const counts = useRef(new Map<string, number>())

  const isOpen = (path: string[]) => {
    const k = keyOf(path)
    return expanded.has(k) || (onPathOf(path, current) && !collapsed.has(k))
  }
  const setOpen = (path: string[], open: boolean) => {
    const k = keyOf(path)
    const edit = (set: Set<string>, add: boolean) => {
      const next = new Set(set)
      if (add) next.add(k)
      else next.delete(k)
      return next
    }
    setExpanded((s) => edit(s, open))
    setCollapsed((s) => edit(s, !open))
  }
  const changed = () => {
    setVersion((v) => v + 1)
    router.refresh()
  }

  async function moved(from: string[], to: string[], names: string[]) {
    if (keyOf(from) === keyOf(to)) return void toast.info("They're already in that folder.")
    const r = await moveTempFilesAction(from, names, to)
    if ("error" in r) return void toast.error(r.error)
    if (r.ok.length) {
      toast.success(`Moved ${r.ok.length} to ${r.to}`)
      window.dispatchEvent(new CustomEvent(TEMP_MOVED_EVENT, { detail: { folder: from, names: r.ok } }))
    }
    if (r.failed.length) toast.error(`Couldn't move ${r.failed.length} item${r.failed.length === 1 ? "" : "s"}`, { description: r.failed.slice(0, 3).map((f) => `${f.name}: ${f.error}`).join("\n") })
    changed()
  }

  const here = current.length >= 2
  const parent = current.slice(0, -1)
  const name = current[current.length - 1]
  const tool = "flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"

  return (
    <NavContext.Provider value={{ current, isOpen, setOpen, version, counts, ask: setDialog, moved }}>
      <nav aria-label="Personal Storage folders" className="text-sm">
        <div className="mb-1.5 flex items-center gap-0.5 px-1">
          <p className="mr-auto text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Personal Storage</p>
          <button type="button" className={tool} title={`New folder in ${name}`} aria-label={`New folder in ${name}`} onClick={() => setDialog({ kind: "new", parent: current })}>
            <FolderPlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={tool}
            disabled={!here}
            title={here ? `Rename ${name}` : "A user's own folder can't be renamed"}
            aria-label={`Rename ${name}`}
            onClick={() => setDialog({ kind: "rename", parent, name })}
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={cn(tool, here && "hover:text-destructive")}
            disabled={!here}
            title={here ? `Delete ${name}` : "A user's own folder can't be deleted"}
            aria-label={`Delete ${name}`}
            onClick={() => setDialog({ kind: "delete", parent, name, count: counts.current.get(keyOf(current)) ?? 0 })}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        <ul>
          <Node key={current[0]} segments={[current[0]]} />
        </ul>
      </nav>
      {dialog?.kind === "new" && (
        <NewFolderDialog
          parent={dialog.parent}
          onClose={() => setDialog(null)}
          onDone={() => {
            setOpen(dialog.parent, true)
            changed()
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <RenameDialog
          kind="folder"
          parent={dialog.parent}
          name={dialog.name}
          onClose={() => setDialog(null)}
          onDone={(newName) => {
            const old = [...dialog.parent, dialog.name]
            // Renaming the folder you are in (or one above it) moves the page to its new address.
            if (onPathOf(old, current)) router.push(libraryHref("temp", [...dialog.parent, newName, ...current.slice(old.length)]))
            changed()
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteTempDialog
          target={{ kind: "folder", parent: dialog.parent, name: dialog.name, count: dialog.count }}
          onClose={() => setDialog(null)}
          onDone={() => {
            // The folder you are in (or one above it) is gone: the page goes to its parent.
            if (onPathOf([...dialog.parent, dialog.name], current)) router.push(libraryHref("temp", dialog.parent))
            changed()
          }}
        />
      )}
    </NavContext.Provider>
  )
}
