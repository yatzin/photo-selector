"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowLeft, FolderInput, Loader2, RotateCcw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Thumb } from "@/components/video/thumb"
import { CancelButton, DialogFooter, EditorDialog, useEditorDialog } from "@/components/video/ui/editor-dialog"
import { listTempFoldersAction, listTempTrashAction, moveTrashAction, restoreTrashAction } from "@/lib/actions/temp"
import { formatBytes, mediaUrl } from "@/lib/format"
import { TRASH_DIR } from "@/lib/media"
import { trashDaysLeft, type TrashBatch, type TrashFile } from "@/lib/temp-trash"

// The Personal Storage trash: every delete still held (the app keeps it 30
// days, then removes it), each with when it was deleted and when it goes for
// good. Double-click a file to preview and play it. A file can be restored to
// where it was deleted from, or moved into another Personal Storage folder; a
// whole delete can be restored at once.

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
const DAY = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" })

/** The header button; the trash opens in a dialog. */
export function TrashButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} title="Deleted files and folders, kept for 30 days">
        <Trash2 className="h-4 w-4" />
        Trash
      </Button>
      {open && <TrashDialog onClose={() => setOpen(false)} />}
    </>
  )
}

const pathOf = (f: TrashFile) => [...f.folder, f.name].join(" / ")
const keyOf = (id: string, f: TrashFile) => `${id}/${f.folder.join("/")}/${f.name}`
/** The folder a file was in, shown as where it will go back to. */
const fromOf = (f: TrashFile) => (f.folder.length ? f.folder.join(" / ") : "Personal Storage")

function TrashDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const state = useEditorDialog(onClose)
  const [batches, setBatches] = useState<TrashBatch[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ batch: TrashBatch; file: TrashFile } | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [folders, setFolders] = useState<string[] | null>(null)
  const [target, setTarget] = useState("")
  // "Days left" counts from when the dialog opened.
  const [now] = useState(() => Date.now())

  const load = useCallback(() => {
    listTempTrashAction().then(
      (list) => {
        setBatches(list)
        setError(null)
      },
      () => setError("Couldn't read the trash.")
    )
  }, [])
  useEffect(() => {
    load()
  }, [load])

  async function restore(batch: TrashBatch, files: TrashFile[] | null) {
    setBusy(files ? keyOf(batch.id, files[0]) : batch.id)
    try {
      const r = await restoreTrashAction(batch.id, files ? files.map((f) => ({ folder: f.folder, name: f.name })) : null)
      if ("error" in r) return void toast.error(r.error)
      if (r.failed.length) toast.error(`Couldn't restore ${r.failed.length} file${r.failed.length === 1 ? "" : "s"}`, { description: `${r.failed[0].name}: ${r.failed[0].error}` })
      if (r.restored) toast.success(`Restored ${r.restored} file${r.restored === 1 ? "" : "s"}`)
      load()
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  async function startMove(key: string) {
    setMoving(key)
    setTarget("")
    if (!folders) setFolders(await listTempFoldersAction().catch(() => []))
  }

  async function move(batch: TrashBatch, file: TrashFile) {
    if (!target) return
    setBusy(keyOf(batch.id, file))
    try {
      const r = await moveTrashAction(batch.id, { folder: file.folder, name: file.name }, target.split("/"))
      if ("error" in r) return void toast.error(r.error)
      toast.success(`Moved ${r.name} to ${target.split("/").join(" / ")}`)
      setMoving(null)
      load()
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const total = batches?.reduce((n, b) => n + b.files.length, 0) ?? 0

  return (
    <EditorDialog
      state={state}
      icon={Trash2}
      title="Trash"
      subtitle={batches === null ? "Loading…" : `${total.toLocaleString()} deleted file${total === 1 ? "" : "s"}. The app removes each delete for good after 30 days.`}
      size="xl"
      footer={
        <DialogFooter>
          <CancelButton state={state} label="Close" initialFocus />
        </DialogFooter>
      }
    >
      {preview ? (
        <div className="grid gap-3">
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setPreview(null)}>
              <ArrowLeft className="h-4 w-4" />
              Back to the trash
            </Button>
            <span className="min-w-0 truncate text-sm" title={pathOf(preview.file)}>{pathOf(preview.file)}</span>
          </div>
          <div className="flex max-h-[60dvh] min-h-48 items-center justify-center rounded-lg bg-black">
            {preview.file.kind === "video" ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption -- the user's own footage, no captions exist
              <video src={mediaUrl("temp", [TRASH_DIR, preview.batch.id, ...preview.file.folder], preview.file.name, "original", String(preview.file.size))} controls autoPlay playsInline className="max-h-[60dvh] w-full" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- streamed from the media route
              <img src={mediaUrl("temp", [TRASH_DIR, preview.batch.id, ...preview.file.folder], preview.file.name, "preview", String(preview.file.size))} alt={preview.file.name} className="max-h-[60dvh] max-w-full object-contain" />
            )}
          </div>
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : batches === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
      ) : batches.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">The trash is empty.</p>
      ) : (
        <div className="grid gap-5">
          <p className="text-xs text-muted-foreground">Double-click a file to preview it.</p>
          {batches.map((batch) => {
            const days = trashDaysLeft(batch.expiresAt, now)
            return (
              <section key={batch.id} aria-label={`Deleted ${WHEN.format(batch.deletedAt)}`} className="rounded-lg border">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">Deleted {WHEN.format(batch.deletedAt)}</div>
                    <div className={days <= 3 ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                      Removed for good {DAY.format(batch.expiresAt)} ({days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}) · {batch.files.length} file{batch.files.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void restore(batch, null)}>
                    {busy === batch.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                    Restore all
                  </Button>
                </div>
                <ul className="divide-y">
                  {batch.files.map((file) => {
                    const key = keyOf(batch.id, file)
                    return (
                      <li key={key} className="px-3 py-2" onDoubleClick={(e) => !(e.target as HTMLElement).closest("button, select") && setPreview({ batch, file })} title="Double-click to preview">
                        <div className="flex items-center gap-3">
                          <Thumb src={mediaUrl("temp", [TRASH_DIR, batch.id, ...file.folder], file.name, "thumb", String(file.size))} className="h-10 w-16 shrink-0 rounded bg-muted object-cover" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm" title={file.name}>{file.name}</div>
                            <div className="truncate text-xs text-muted-foreground" title={fromOf(file)}>From {fromOf(file)} · {formatBytes(file.size)}</div>
                          </div>
                          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void restore(batch, [file])} title="Put it back where it was">
                            {busy === key ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                            Restore
                          </Button>
                          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void startMove(key)} title="Move it to another folder">
                            <FolderInput className="h-4 w-4" />
                            Move…
                          </Button>
                        </div>
                        {moving === key && (
                          <div className="mt-2 flex flex-wrap items-center gap-2 pl-[4.75rem]">
                            <select
                              aria-label={`Folder to move ${file.name} to`}
                              value={target}
                              onChange={(e) => setTarget(e.target.value)}
                              disabled={folders === null}
                              className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
                            >
                              <option value="" disabled>{folders === null ? "Loading folders…" : "Choose a folder…"}</option>
                              {folders?.map((f) => (
                                <option key={f} value={f}>{f.split("/").join(" / ")}</option>
                              ))}
                            </select>
                            <Button type="button" size="sm" disabled={!target || busy !== null} onClick={() => void move(batch, file)}>Move here</Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => setMoving(null)}>Cancel</Button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </EditorDialog>
  )
}
