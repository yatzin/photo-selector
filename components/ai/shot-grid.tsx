"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Check, FolderOutput, ImageOff, Loader2, Maximize2, ScanEye, ShieldCheck, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { mediaUrl } from "@/lib/format"
import { shotAction, undoShotDeleteAction } from "@/lib/actions/ai"
import { SCAN_LOCK_MESSAGE } from "@/lib/ai/lock"
import type { ShotKind } from "@/lib/ai/review"
import { SHOT_TEXT } from "@/lib/ai/shot-text"
import type { FileEntry } from "@/lib/library-server"
import { Lightbox } from "@/components/library/lightbox"
import { PhotoImage } from "@/components/library/photo-image"
import { PhotoMenu } from "@/components/library/photo-menu"
import { TempDialog } from "@/components/library/temp-dialog"

// Find Screenshots and Quality Checks results. Click (tap) images to select
// them, then delete them, move them to Sort Dropoff (screenshots), or say the
// AI got them wrong. The magnifier opens one full size. Right-click moves or
// copies to User Temp Storage.

export type ShotItem = { id: string; name: string; note: string | null; error: string | null; file: FileEntry | null }

type Mode = "found" | "kept" | "failed"
type Action = "delete" | "move" | "keep" | "unkeep"

export function ShotGrid({
  runId, kind, root, rootDir, folder, mode, items, canMove, locked,
}: {
  runId: string
  kind: ShotKind
  root: string
  rootDir: string
  folder: string[]
  mode: Mode
  items: ShotItem[]
  canMove: boolean
  /** A Find Similar scan is reading this folder: no changes until it's done. */
  locked: boolean
}) {
  const router = useRouter()
  const text = SHOT_TEXT[kind]
  const [, startTransition] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState<Action | null>(null)
  const [viewer, setViewer] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; names: string[] } | null>(null)
  const [temp, setTemp] = useState<string[] | null>(null)

  // Fresh data from the server: anything hidden optimistically is gone for real, or back (Undo).
  const [prevItems, setPrevItems] = useState(items)
  if (prevItems !== items) {
    setPrevItems(items)
    setHidden(new Set())
  }

  const shown = useMemo(() => items.filter((i) => !hidden.has(i.id)), [items, hidden])
  const chosen = shown.filter((i) => selected.has(i.id))
  const files = useMemo(() => shown.flatMap((i) => (i.file ? [i.file] : [])), [shown])
  const selectable = mode !== "failed" && !locked
  const allSelected = shown.length > 0 && chosen.length === shown.length

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  async function act(action: Action) {
    const ids = chosen.map((i) => i.id)
    if (!ids.length || busy) return
    setBusy(action)
    let closed = false
    try {
      const r = await shotAction({ runId, ids, action })
      if ("error" in r) {
        toast.error(r.error)
        return
      }
      closed = r.closed
      setHidden((prev) => new Set([...prev, ...r.ids]))
      setSelected((prev) => new Set([...prev].filter((id) => !r.ids.includes(id))))
      if (r.failed.length) toast.error(`Couldn't change ${r.failed.length} image${r.failed.length === 1 ? "" : "s"}`, { description: `${r.failed[0].name}: ${r.failed[0].error}` })
      const n = r.ids.length
      const what = `${n} image${n === 1 ? "" : "s"}`
      if (!n) return
      if (action === "delete" && r.batchId) {
        const batchId = r.batchId
        toast.success(`Deleted ${what}`, {
          duration: 10_000,
          action: {
            label: "Undo",
            onClick: async () => {
              const u = await undoShotDeleteAction({ runId, batchId, ids: r.ids })
              if ("error" in u) toast.error(u.error)
              else toast.success(`Restored ${u.restored}`)
              startTransition(() => router.refresh())
            },
          },
        })
      } else if (action === "move") toast.success(`Moved ${what} to Sort Dropoff`)
      else if (action === "keep") toast.success(`Moved ${what} to ${text.kept}`)
      else toast.success(`Moved ${what} back to ${text.flagged}`)
    } catch {
      toast.error("Something went wrong. Check that the NAS is reachable.")
    } finally {
      setBusy(null)
      // That was the last image to handle: the scan is closed, back to the list.
      if (closed) toast.success("Review finished.")
      startTransition(() => (closed ? router.push(`/ai?tab=${kind}`) : router.refresh()))
    }
  }

  // Right-click: the selection when the image is part of it, otherwise just that image.
  const openMenu = (e: React.MouseEvent, item: ShotItem) => {
    if (!item.file) return
    e.preventDefault()
    const names = selected.has(item.id) ? chosen.filter((i) => i.file).map((i) => i.name) : [item.name]
    setMenu({ x: e.clientX, y: e.clientY, names })
  }

  const spin = (a: Action, icon: React.ReactNode) => (busy === a ? <Loader2 className="h-4 w-4 animate-spin" /> : icon)

  return (
    <div className="space-y-3">
      {locked && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">{SCAN_LOCK_MESSAGE}</p>}
      {selectable && (
        <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 px-3 py-2 shadow-sm backdrop-blur">
          <Button variant="outline" size="sm" onClick={() => setSelected(allSelected ? new Set() : new Set(shown.map((i) => i.id)))}>
            {allSelected ? "Clear selection" : `Select all (${shown.length})`}
          </Button>
          <span className="text-sm text-muted-foreground">{chosen.length} selected</span>
          <div className="ml-auto flex flex-wrap gap-2">
            {mode === "found" && (
              <Button variant="outline" size="sm" disabled={!chosen.length || !!busy} onClick={() => act("keep")}>
                {spin("keep", <ShieldCheck className="h-4 w-4" />)} {text.keep}
              </Button>
            )}
            {mode === "kept" && (
              <Button variant="outline" size="sm" disabled={!chosen.length || !!busy} onClick={() => act("unkeep")}>
                {spin("unkeep", <ScanEye className="h-4 w-4" />)} {text.unkeep}
              </Button>
            )}
            {canMove && (
              <Button variant="outline" size="sm" disabled={!chosen.length || !!busy} onClick={() => act("move")}>
                {spin("move", <FolderOutput className="h-4 w-4" />)} Move to Sort Dropoff
              </Button>
            )}
            <Button variant="destructive" size="sm" disabled={!chosen.length || !!busy} onClick={() => act("delete")}>
              {spin("delete", <Trash2 className="h-4 w-4" />)} Delete{chosen.length ? ` ${chosen.length}` : ""}
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {shown.map((item) => {
          const isSel = selected.has(item.id)
          const fileIndex = item.file ? files.indexOf(item.file) : -1
          return (
            <div key={item.id} className="min-w-0 space-y-1">
              <div
                role={selectable ? "checkbox" : undefined}
                aria-checked={selectable ? isSel : undefined}
                tabIndex={selectable ? 0 : undefined}
                onClick={() => selectable && toggle(item.id)}
                onKeyDown={(e) => {
                  if (selectable && (e.key === " " || e.key === "Enter")) {
                    e.preventDefault()
                    toggle(item.id)
                  }
                }}
                onDoubleClick={() => fileIndex >= 0 && setViewer(fileIndex)}
                onContextMenu={(e) => openMenu(e, item)}
                style={{ touchAction: "manipulation" }}
                className={cn(
                  "group relative aspect-square select-none overflow-hidden rounded-md bg-muted",
                  selectable && "cursor-pointer",
                  isSel && "ring-[3px] ring-primary ring-offset-2 ring-offset-background"
                )}
                title={item.name}
              >
                {item.file ? (
                  <PhotoImage
                    src={mediaUrl(root, folder, item.name, "thumb", item.file.version)}
                    alt={item.name}
                    delayMs={100}
                    fallbackLabel={item.name}
                    className={cn("transition-transform duration-150", isSel && "scale-[0.94]")}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground"><ImageOff className="h-6 w-6" /></div>
                )}
                {selectable && (
                  <span
                    className={cn(
                      "absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2",
                      isSel ? "border-primary bg-primary text-primary-foreground" : "border-white/90 bg-black/25"
                    )}
                  >
                    {isSel && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                  </span>
                )}
                {fileIndex >= 0 && (
                  <button
                    type="button"
                    aria-label={`View ${item.name}`}
                    title="View full size"
                    onClick={(e) => {
                      e.stopPropagation()
                      setViewer(fileIndex)
                    }}
                    className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white"
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground" title={item.error ?? item.note ?? item.name}>
                {item.error ? <span className="text-destructive">{item.error}</span> : item.note || item.name}
              </p>
            </div>
          )
        })}
      </div>

      {viewer !== null && files[viewer] && (
        <Lightbox
          root={root}
          rootDir={rootDir}
          folder={folder}
          items={files}
          index={viewer}
          canMove={false}
          canEdit={false}
          busy={false}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
          onMove={() => {}}
          onDelete={() => {}}
          onRotate={() => {}}
          onTemp={(name) => setTemp([name])}
        />
      )}
      {menu && (
        <PhotoMenu
          x={menu.x}
          y={menu.y}
          count={menu.names.length}
          canRotate={false}
          showMove={false}
          canMove={false}
          canEdit={false}
          showEdit={false}
          canTemp={!busy}
          onAction={() => setTemp(menu.names)}
          onClose={() => setMenu(null)}
        />
      )}
      {temp && (
        <TempDialog
          target={{ root, folder, names: temp }}
          canMove={!locked}
          onDone={(ok, moved) => {
            if (moved) {
              const gone = shown.filter((i) => ok.includes(i.name)).map((i) => i.id)
              setHidden((prev) => new Set([...prev, ...gone]))
              setSelected((prev) => new Set([...prev].filter((id) => !gone.includes(id))))
            }
            startTransition(() => router.refresh())
          }}
          onClose={() => setTemp(null)}
        />
      )}
    </div>
  )
}
