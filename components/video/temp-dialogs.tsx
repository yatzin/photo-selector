"use client"

import { useState, useTransition } from "react"
import { Clapperboard, FolderPlus, Loader2, Pencil, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { createTempFolderAction, deleteTempFolderAction, renameTempFileAction, renameTempFolderAction } from "@/lib/actions/temp"
import { deleteAction } from "@/lib/actions/media"
import { formatBytes, mediaUrl } from "@/lib/format"
import { Callout } from "./ui/callout"
import { CancelButton, DialogFooter, EditorDialog, PrimaryButton, useEditorDialog } from "./ui/editor-dialog"

// The dialogs for Personal Storage, used by the Video Editing side panel and
// the library's temp folder pages: New folder, a delete warning (a file or a
// whole folder) and a preview that plays a video or shows an image. Folders
// and files are named by `parent`, the path of the folder they sit in.

export type TempFile = { name: string; size: number; kind: "image" | "video" }

/** Where the dialog was opened: the folder path joined for display ("Mike/Trips"). */
const where = (parent: string[]) => parent.join(" / ")

export function NewFolderDialog({ parent, onClose, onDone }: { parent: string[]; onClose: () => void; onDone: (name: string) => void }) {
  const state = useEditorDialog(onClose)
  const [name, setName] = useState("")
  const [pending, startTransition] = useTransition()

  function submit() {
    if (!name.trim() || pending) return
    startTransition(async () => {
      const r = await createTempFolderAction(parent, name)
      if ("error" in r) return void toast.error(r.error)
      state.close()
      onDone(r.name)
    })
  }

  return (
    <EditorDialog
      state={state}
      icon={FolderPlus}
      title="New folder"
      subtitle={`Inside ${where(parent)}`}
      size="sm"
      dismissible={!pending}
      onSubmit={submit}
      footer={
        <DialogFooter>
          <CancelButton state={state} disabled={pending} />
          <PrimaryButton busy={pending} disabledReason={!name.trim() ? "Enter a name first." : null}>
            {pending && <Loader2 className="motion-safe:animate-spin" />}
            Create folder
          </PrimaryButton>
        </DialogFooter>
      }
    >
      <div className="grid gap-1.5">
        <label htmlFor="temp-folder-name" className="field-label">Folder name</label>
        <Input
          id="temp-folder-name"
          data-initial-focus
          placeholder="Summer trip"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          className="h-9 pointer-coarse:h-11"
          autoComplete="off"
        />
      </div>
    </EditorDialog>
  )
}

export type DeleteTarget = { kind: "file"; parent: string[]; file: TempFile } | { kind: "folder"; parent: string[]; name: string; count: number }

/** The warning before a file or a folder is deleted. Both go to the trash, which keeps them for a while. */
export function DeleteTempDialog({ target, onClose, onDone }: { target: DeleteTarget; onClose: () => void; onDone: () => void }) {
  const state = useEditorDialog(onClose)
  const [pending, startTransition] = useTransition()
  const label = target.kind === "file" ? target.file.name : target.name

  function submit() {
    if (pending) return
    startTransition(async () => {
      const r =
        target.kind === "file"
          ? await deleteAction({ root: "temp", folder: target.parent, names: [target.file.name] })
          : await deleteTempFolderAction(target.parent, target.name)
      if ("error" in r) return void toast.error(r.error)
      if ("failed" in r && r.failed.length) return void toast.error(`Couldn't delete ${label}`, { description: r.failed[0].error })
      state.close()
      onDone()
    })
  }

  return (
    <EditorDialog
      state={state}
      icon={Trash2}
      title={target.kind === "file" ? "Delete file" : "Delete folder"}
      subtitle={`${where(target.parent)} / ${label}`}
      size="sm"
      dismissible={!pending}
      onSubmit={submit}
      footer={
        <DialogFooter>
          <CancelButton state={state} disabled={pending} initialFocus />
          <PrimaryButton busy={pending} className="bg-destructive text-white hover:bg-destructive/90 dark:text-neutral-950">
            {pending ? <Loader2 className="motion-safe:animate-spin" /> : <Trash2 />}
            {target.kind === "file" ? "Delete file" : "Delete folder"}
          </PrimaryButton>
        </DialogFooter>
      }
    >
      <Callout tone="danger" title={target.kind === "file" ? "This removes the file for everyone" : "This removes the folder and everything in it"}>
        <p className="break-words">
          {target.kind === "file"
            ? `${target.file.name} (${formatBytes(target.file.size)}) is deleted from Personal Storage. Projects that already imported it keep their own copy.`
            : `${target.name} is deleted with ${target.count === 0 ? "its (empty) subfolders" : `the ${target.count.toLocaleString()} photo${target.count === 1 ? "" : "s"} and video${target.count === 1 ? "" : "s"} in it and its subfolders`}. Projects that already imported them keep their own copies.`}
        </p>
        <p className="mt-1.5">It goes to the trash and is removed for good after 30 days.</p>
      </Callout>
    </EditorDialog>
  )
}

/** Plays a video (with controls) or shows an image from Personal Storage, original quality. */
export function TempPreviewDialog({ parent, file, onClose }: { parent: string[]; file: TempFile; onClose: () => void }) {
  const state = useEditorDialog(onClose)
  const version = String(file.size)
  return (
    <EditorDialog
      state={state}
      icon={Clapperboard}
      title={file.name}
      subtitle={`${where(parent)} · ${formatBytes(file.size)}`}
      size="xl"
      bodyClassName="p-0"
      footer={
        <DialogFooter>
          <CancelButton state={state} label="Close" initialFocus />
        </DialogFooter>
      }
    >
      <div className="flex max-h-[70dvh] min-h-48 items-center justify-center bg-black">
        {file.kind === "video" ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- the user's own footage, no captions exist
          <video src={mediaUrl("temp", parent, file.name, "original", version)} controls autoPlay playsInline className="max-h-[70dvh] w-full" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- streamed from the media route
          <img src={mediaUrl("temp", parent, file.name, "preview", version)} alt={file.name} className="max-h-[70dvh] max-w-full object-contain" />
        )}
      </div>
    </EditorDialog>
  )
}

/** Renames a folder, or a photo or video (its extension stays: the field holds what comes before it). */
export function RenameDialog({ kind, parent, name, onClose, onDone }: { kind: "folder" | "file"; parent: string[]; name: string; onClose: () => void; onDone: (newName: string) => void }) {
  const state = useEditorDialog(onClose)
  const dot = kind === "file" ? name.lastIndexOf(".") : -1
  const ext = dot > 0 ? name.slice(dot) : ""
  const [value, setValue] = useState(dot > 0 ? name.slice(0, dot) : name)
  const [pending, startTransition] = useTransition()
  const unchanged = value.trim() === (dot > 0 ? name.slice(0, dot) : name)

  function submit() {
    if (!value.trim() || unchanged || pending) return
    startTransition(async () => {
      const r = kind === "file" ? await renameTempFileAction(parent, name, value) : await renameTempFolderAction(parent, name, value)
      if ("error" in r) return void toast.error(r.error)
      state.close()
      onDone(r.name)
    })
  }

  return (
    <EditorDialog
      state={state}
      icon={Pencil}
      title={kind === "file" ? "Rename file" : "Rename folder"}
      subtitle={`${where(parent)} / ${name}`}
      size="sm"
      dismissible={!pending}
      onSubmit={submit}
      footer={
        <DialogFooter>
          <CancelButton state={state} disabled={pending} />
          <PrimaryButton busy={pending} disabledReason={!value.trim() ? "Enter a name first." : unchanged ? "Change the name first." : null}>
            {pending && <Loader2 className="motion-safe:animate-spin" />}
            Rename
          </PrimaryButton>
        </DialogFooter>
      }
    >
      <div className="grid gap-1.5">
        <label htmlFor="temp-rename" className="field-label">{kind === "file" ? "File name" : "Folder name"}</label>
        <div className="flex items-center gap-2">
          <Input id="temp-rename" data-initial-focus value={value} maxLength={kind === "file" ? 180 : 80} onChange={(e) => setValue(e.target.value)} className="h-9 min-w-0 flex-1 pointer-coarse:h-11" autoComplete="off" />
          {ext && <span className="shrink-0 text-sm text-muted-foreground">{ext}</span>}
        </div>
      </div>
    </EditorDialog>
  )
}
