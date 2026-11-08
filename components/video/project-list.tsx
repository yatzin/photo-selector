"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useSyncExternalStore, useTransition } from "react"
import { Clapperboard, FolderPlus, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { createProjectAction, deleteProjectAction, renameProjectAction } from "@/lib/actions/video-projects"
import { Callout } from "./ui/callout"
import { CancelButton, DialogFooter, EditorDialog, PrimaryButton, useEditorDialog } from "./ui/editor-dialog"

type Project = { folder: string; name: string; clips: number; modified: number }
type Dialogue = { kind: "new" } | { kind: "rename"; project: Project } | { kind: "delete"; project: Project }

const subscribeNothing = () => () => {}

export function ProjectList({ projects }: { projects: Project[] }) {
  const [dialog, setDialog] = useState<Dialogue | null>(null)
  const mounted = useSyncExternalStore(subscribeNothing, () => true, () => false)
  const open = (next: Dialogue) => setDialog(next)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Video Editing</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {projects.length.toLocaleString()} project{projects.length === 1 ? "" : "s"}
          </p>
        </div>
        <Button onClick={() => open({ kind: "new" })}>
          <Plus className="h-4 w-4" />
          New project
        </Button>
      </div>

      {projects.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
          No projects yet. Create one to start editing.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {projects.map((p) => (
            <div key={p.folder} className="flex items-center gap-1 rounded-lg border bg-card pr-2 transition-colors hover:bg-muted/40">
              <Link href={`/tools/video-editing/${encodeURIComponent(p.folder)}`} className="flex min-w-0 flex-1 items-center gap-3 p-4">
                <Clapperboard className="h-5 w-5 shrink-0 text-link" strokeWidth={1.5} />
                <div className="min-w-0">
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.clips.toLocaleString()} clip{p.clips === 1 ? "" : "s"}
                    {/* The server's locale and time zone differ from the browser's, so the date is filled in after mount. */}
                    {mounted && <> &middot; <time dateTime={new Date(p.modified).toISOString()}>{new Date(p.modified).toLocaleString()}</time></>}
                  </div>
                </div>
              </Link>
              <Button variant="ghost" size="icon-sm" onClick={() => open({ kind: "rename", project: p })}>
                <Pencil className="h-4 w-4" />
                <span className="sr-only">Rename {p.name}</span>
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => open({ kind: "delete", project: p })}>
                <Trash2 className="h-4 w-4" />
                <span className="sr-only">Delete {p.name}</span>
              </Button>
            </div>
          ))}
        </div>
      )}

      {dialog && <ProjectDialog key={dialog.kind + (dialog.kind === "new" ? "" : dialog.project.folder)} dialog={dialog} onClose={() => setDialog(null)} />}
    </div>
  )
}

/** New, Rename or Delete for a project: the editor's dialog shell, busy while the server works. */
function ProjectDialog({ dialog, onClose }: { dialog: Dialogue; onClose: () => void }) {
  const router = useRouter()
  const dialogState = useEditorDialog(onClose)
  const [name, setName] = useState(dialog.kind === "rename" ? dialog.project.name : "")
  const [pending, startTransition] = useTransition()

  function submit() {
    if (dialog.kind !== "delete" && !name.trim()) return
    startTransition(async () => {
      if (dialog.kind === "new") {
        const res = await createProjectAction(name)
        if ("error" in res) return void toast.error(res.error)
        dialogState.close()
        router.push(`/tools/video-editing/${encodeURIComponent(res.folder)}`)
      } else if (dialog.kind === "rename") {
        const res = await renameProjectAction(dialog.project.folder, name)
        if ("error" in res) return void toast.error(res.error)
        dialogState.close()
        router.refresh()
      } else {
        const res = await deleteProjectAction(dialog.project.folder)
        if ("error" in res) return void toast.error(res.error)
        dialogState.close()
        router.refresh()
      }
    })
  }

  return (
    <EditorDialog
      state={dialogState}
      icon={dialog.kind === "new" ? FolderPlus : dialog.kind === "rename" ? Pencil : Trash2}
      title={dialog.kind === "new" ? "New project" : dialog.kind === "rename" ? "Rename project" : "Delete project"}
      subtitle={dialog.kind === "new" ? "Clips, settings and exports live in its own folder." : dialog.project.name}
      size="sm"
      dismissible={!pending}
      onSubmit={submit}
      footer={
        <DialogFooter>
          <CancelButton state={dialogState} disabled={pending} initialFocus={dialog.kind === "delete"} />
          <PrimaryButton
            busy={pending}
            disabledReason={dialog.kind !== "delete" && !name.trim() ? "Enter a name first." : null}
            className={dialog.kind === "delete" ? "bg-destructive text-white hover:bg-destructive/90 dark:text-neutral-950" : undefined}
          >
            {pending && <Loader2 className="motion-safe:animate-spin" />}
            {dialog.kind === "new" ? "Create project" : dialog.kind === "rename" ? "Rename project" : "Delete project"}
          </PrimaryButton>
        </DialogFooter>
      }
    >
      {dialog.kind === "delete" ? (
        <Callout tone="danger" title="This can't be undone">
          <p>
            &ldquo;{dialog.project.name}&rdquo; is deleted with its clips, settings and exported videos. Source videos in the Inbox are not touched.
          </p>
        </Callout>
      ) : (
        <div className="grid gap-1.5">
          <label htmlFor="project-name" className="field-label">Project name</label>
          <Input
            id="project-name"
            data-initial-focus
            placeholder="Summer trip"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            className="h-9 pointer-coarse:h-11"
            autoComplete="off"
          />
        </div>
      )}
    </EditorDialog>
  )
}
