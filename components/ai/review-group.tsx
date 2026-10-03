"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Check, Loader2, Trash2, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { mediaUrl } from "@/lib/format"
import { TRASH_RETENTION_DAYS } from "@/lib/media"
import { dismissGroupAction, resolveGroupAction, trashGroupAction, undoGroupAction } from "@/lib/actions/ai"
import type { FileEntry } from "@/lib/library-server"
import { Lightbox } from "@/components/library/lightbox"
import { PhotoImage } from "@/components/library/photo-image"

export type ReviewPhoto = { name: string; rank: number | null; note: string | null; suggested: boolean; decision: "KEEP" | "TRASH" | null; current: FileEntry | null }

export type ReviewGroupProps = {
  id: string
  root: "upload" | "dropoff"
  folder: string[]
  status: "PENDING" | "ANALYZED" | "FAILED" | "RESOLVED" | "DISMISSED"
  reason: string | null
  error: string | null
  photos: ReviewPhoto[]
  /** The folder is being scanned; files there must not change yet. */
  locked: boolean
}

/** The photos picked by default: the AI's suggestions that are still there. */
export function suggestedKeep(photos: ReviewPhoto[]): Set<string> {
  return new Set(photos.filter((p) => p.current && p.suggested).map((p) => p.name))
}

export function ReviewGroup({
  id, root, folder, status, reason, error, photos, locked, keep, onToggle, disabled = false,
}: ReviewGroupProps & {
  /** Picked photos; the list above owns them so "Accept all selections" can read every group's picks. */
  keep: Set<string>
  onToggle: (name: string) => void
  /** A page-wide action is running. */
  disabled?: boolean
}) {
  const router = useRouter()
  const ordered = useMemo(() => [...photos].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)), [photos])
  const present = ordered.filter((p) => p.current)
  const [busy, setBusy] = useState(false)
  // Collapses the group the moment an action is clicked, so it's clear
  // something happened; it comes back if the action fails.
  const [leaving, setLeaving] = useState(false)
  const [viewer, setViewer] = useState<number | null>(null)
  const items = present.map((p) => p.current!)

  useEffect(() => {
    if (viewer === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewer(null)
      else if (e.key === "ArrowRight") setViewer((v) => (v !== null && v < items.length - 1 ? v + 1 : v))
      else if (e.key === "ArrowLeft") setViewer((v) => (v !== null && v > 0 ? v - 1 : v))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [viewer, items.length])

  const kept = present.filter((p) => keep.has(p.name)).length
  const trashed = present.length - kept
  const done = status === "RESOLVED" || status === "DISMISSED"

  async function act(fn: () => Promise<unknown>, success: (r: Record<string, number>) => string, undoable = true) {
    setBusy(true)
    setLeaving(true)
    const r = (await fn()) as { error?: string } & Record<string, number>
    setBusy(false)
    if (r.error) {
      setLeaving(false)
      toast.error(r.error)
    } else {
      toast.success(success(r), undoable ? { action: { label: "Undo", onClick: () => void undoGroupAction(id).then(() => router.refresh()) } } : undefined)
    }
    router.refresh()
  }

  const off = busy || locked || disabled

  if (done) {
    const keptNames = photos.filter((p) => p.decision === "KEEP").length
    const trashedNames = photos.filter((p) => p.decision === "TRASH").length
    return (
      <Collapse gone={leaving}>
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
        <span className="text-muted-foreground">
          {status === "DISMISSED"
            ? "Marked as not duplicates"
            : keptNames === 0
              ? `Deleted all ${trashedNames}`
              : `${root === "upload" ? "Moved" : "Kept"} ${keptNames}, trashed ${trashedNames}`}
        </span>
        <Button variant="ghost" size="sm" disabled={off} onClick={() => act(() => undoGroupAction(id), (r) => (r.restored ? `Restored ${r.restored} from trash.` : "Back in To review."), false)}>
          <Undo2 className="h-4 w-4" /> Undo
        </Button>
      </div>
      </Collapse>
    )
  }

  return (
    <Collapse gone={leaving}>
    <div className="rounded-lg border bg-card p-4 space-y-3">
      {reason && <p className="text-sm">{reason}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(180px, 42vw), 1fr))" }}>
        {ordered.map((p) => {
          const selected = keep.has(p.name)
          if (!p.current) {
            return (
              <div key={p.name} className="flex aspect-square flex-col items-center justify-center rounded-md border border-dashed p-2 text-center text-xs text-muted-foreground">
                <span className="font-medium">No longer here</span>
                <span className="break-all">{p.name}</span>
              </div>
            )
          }
          const index = items.indexOf(p.current)
          return (
            <div key={p.name} className="space-y-1">
              <button
                type="button"
                onClick={() => onToggle(p.name)}
                onDoubleClick={() => setViewer(index)}
                title={`${p.name} — click to keep or trash, double-click to view`}
                style={{ touchAction: "manipulation" }}
                className={cn(
                  "relative block aspect-square w-full overflow-hidden rounded-md bg-muted",
                  selected ? "ring-[3px] ring-primary ring-offset-2 ring-offset-background" : ""
                )}
              >
                <PhotoImage src={mediaUrl(root, folder, p.name, "thumb", p.current.version)} alt={p.name} fallbackLabel={p.name} />
                {p.rank !== null && <span className="absolute left-1.5 top-1.5 rounded-full bg-black/65 px-1.5 py-0.5 text-[11px] font-semibold text-white">#{p.rank}</span>}
                {selected && <span className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="h-3.5 w-3.5" strokeWidth={3} /></span>}
              </button>
              {p.note && <p className="text-xs text-muted-foreground line-clamp-2">{p.note}</p>}
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {status === "ANALYZED" && present.length > 0 && (
          <Button
            size="sm"
            className="mr-auto bg-destructive text-white hover:bg-destructive/90"
            disabled={off}
            onClick={() =>
              confirm(
                `Are you sure you want to delete all ${present.length} photo${present.length === 1 ? "" : "s"} in this group? ` +
                  `They go to the trash and can be brought back with Undo for ${TRASH_RETENTION_DAYS} days.`
              ) && act(() => trashGroupAction(id), (r) => `Deleted ${r.trashed} photo${r.trashed === 1 ? "" : "s"}.`)
            }
          >
            <Trash2 className="h-4 w-4" /> Delete all
          </Button>
        )}
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <Button variant="ghost" size="sm" disabled={off} onClick={() => act(() => dismissGroupAction(id), () => "Marked as not duplicates.")}>
          {present.length < 2 ? "Done" : "Not duplicates"}
        </Button>
        {status === "ANALYZED" && present.length >= 2 && (
          <Button
            size="sm"
            disabled={off || kept === 0}
            onClick={() => act(() => resolveGroupAction(id, [...keep]), (r) => `${root === "upload" ? `Moved ${r.moved}` : `Kept ${r.kept}`}, trashed ${r.trashed}.`)}
          >
            {root === "upload" ? `Move ${kept} to Dropoff` : `Keep ${kept}`}, trash {trashed}
          </Button>
        )}
      </div>
      {viewer !== null && items[viewer] && (
        <Lightbox
          root={root}
          folder={folder}
          items={items}
          index={viewer}
          canMove={false}
          canEdit={false}
          busy={false}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
          onMove={() => {}}
          onDelete={() => {}}
          onRotate={() => {}}
        />
      )}
    </div>
    </Collapse>
  )
}

/** Animates a group's height and opacity to nothing; the spacing between groups lives inside so it collapses too. */
function Collapse({ gone, children }: { gone: boolean; children: React.ReactNode }) {
  return (
    <div
      className="grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none"
      style={{ gridTemplateRows: gone ? "0fr" : "1fr", opacity: gone ? 0 : 1 }}
      aria-hidden={gone || undefined}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="pb-4">{children}</div>
      </div>
    </div>
  )
}
