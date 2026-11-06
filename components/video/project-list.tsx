"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useSyncExternalStore, useTransition } from "react"
import { Clapperboard, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { createProjectAction, deleteProjectAction, renameProjectAction } from "@/lib/actions/video-projects"

type Project = { folder: string; name: string; clips: number; modified: number }
type Dialogue = { kind: "new" } | { kind: "rename"; project: Project } | { kind: "delete"; project: Project }

const subscribeNothing = () => () => {}

export function ProjectList({ projects }: { projects: Project[] }) {
  const router = useRouter()
  const [dialog, setDialog] = useState<Dialogue | null>(null)
  const [name, setName] = useState("")
  const [pending, startTransition] = useTransition()
  const mounted = useSyncExternalStore(subscribeNothing, () => true, () => false)

  function open(next: Dialogue) {
    setName(next.kind === "rename" ? next.project.name : "")
    setDialog(next)
  }

  function submit() {
    if (!dialog) return
    const current = dialog
    startTransition(async () => {
      if (current.kind === "new") {
        const res = await createProjectAction(name)
        if ("error" in res) return void toast.error(res.error)
        setDialog(null)
        router.push(`/tools/video-editing/${encodeURIComponent(res.folder)}`)
      } else if (current.kind === "rename") {
        const res = await renameProjectAction(current.project.folder, name)
        if ("error" in res) return void toast.error(res.error)
        setDialog(null)
        router.refresh()
      } else {
        const res = await deleteProjectAction(current.project.folder)
        if ("error" in res) return void toast.error(res.error)
        setDialog(null)
        router.refresh()
      }
    })
  }

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

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && !pending && setDialog(null)}>
        <DialogContent>
          {dialog && (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                submit()
              }}
            >
              <DialogHeader>
                <DialogTitle>
                  {dialog.kind === "new" ? "New project" : dialog.kind === "rename" ? "Rename project" : "Delete project"}
                </DialogTitle>
              </DialogHeader>
              {dialog.kind === "delete" ? (
                <p className="text-sm text-muted-foreground">
                  Delete &ldquo;{dialog.project.name}&rdquo;? Its clips, settings and exported videos are deleted, and this can&apos;t be undone. Source videos in the Inbox are not touched.
                </p>
              ) : (
                <Input autoFocus aria-label="Project name" placeholder="Project name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
              )}
              <DialogFooter>
                <Button type="button" variant="outline" disabled={pending} onClick={() => setDialog(null)}>
                  Cancel
                </Button>
                <Button type="submit" variant={dialog.kind === "delete" ? "destructive" : "default"} disabled={pending || (dialog.kind !== "delete" && !name.trim())}>
                  {dialog.kind === "new" ? "Create" : dialog.kind === "rename" ? "Rename" : "Delete"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
