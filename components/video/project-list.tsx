"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState, useSyncExternalStore, useTransition } from "react"
import { ArrowDown, ArrowUp, ChevronDown, Clapperboard, FolderPlus, Inbox, Loader2, Pencil, Plus, Search, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button, buttonVariants } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { FieldHelp } from "@/components/ui/field-help"
import { Input } from "@/components/ui/input"
import { createProjectAction, deleteProjectAction, renameProjectAction } from "@/lib/actions/video-projects"
import { formatBytes } from "@/lib/format"
import { firstDir, formatLength, sortProjects, type SortDir, type SortKey } from "@/lib/video/project-sort"
import { daysLeft, RETENTION_MONTHS } from "@/lib/video/retention"
import { cn } from "@/lib/utils"
import { Callout } from "./ui/callout"
import { CancelButton, DialogFooter, EditorDialog, PrimaryButton, useEditorDialog } from "./ui/editor-dialog"

// Video Editing's start page, laid out like a file browser: each project is a
// file in a details list (name, modified, clips, length, size, and when it
// expires), sorted by clicking a column heading (name or date to start with),
// filtered by the search box, opened by clicking its name. Projects are
// staging files and go after 6 months unchanged (lib/video/retention), as the
// note at the top says. "Manage inbox" lists the inbox folders, one per user.

type Project = { folder: string; name: string; clips: number; modified: number; duration: number; bytes: number }
type InboxUser = { name: string; files: number }
type Dialogue = { kind: "new" } | { kind: "rename"; project: Project } | { kind: "delete"; project: Project }

const subscribeNothing = () => () => {}

// Name, modified, clips, length, size, expires, actions (the middle ones only from lg up).
const ROW = "grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-x-3 lg:grid-cols-[minmax(0,1fr)_10.5rem_4rem_5rem_5.5rem_7rem_5rem]"
const COLUMNS: { key: SortKey | null; label: string; align?: "right" }[] = [
  { key: "modified", label: "Modified" },
  { key: "clips", label: "Clips", align: "right" },
  { key: "duration", label: "Length", align: "right" },
  { key: "size", label: "Size", align: "right" },
  { key: null, label: "Expires" },
]

export function ProjectList({ projects, inboxUsers }: { projects: Project[]; inboxUsers: InboxUser[] }) {
  const router = useRouter()
  const [dialog, setDialog] = useState<Dialogue | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "modified", dir: "desc" })
  const [query, setQuery] = useState("")
  // The server's locale, time zone and clock differ from the browser's, so dates and "days left" are filled in after mount.
  const mounted = useSyncExternalStore(subscribeNothing, () => true, () => false)
  const [now] = useState(() => Date.now())
  const open = (next: Dialogue) => setDialog(next)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sortProjects(q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects, sort.key, sort.dir)
  }, [projects, query, sort])
  const totalBytes = projects.reduce((n, p) => n + p.bytes, 0)
  const choose = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: firstDir(key) }))
  const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

  const sortButton = (key: SortKey, label: string) => (
    <button
      type="button"
      onClick={() => choose(key)}
      className={cn(
        "inline-flex items-center gap-1 rounded-md py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        sort.key === key && "text-foreground"
      )}
    >
      {label}
      {sort.key === key ? sort.dir === "asc" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden /> : <span className="size-3" aria-hidden />}
    </button>
  )
  const ariaSort = (key: SortKey) => (sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none")

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Video Editing</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {projects.length.toLocaleString()} project{projects.length === 1 ? "" : "s"}
            {projects.length > 0 && <> &middot; {formatBytes(totalBytes)}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger className={cn(buttonVariants({ variant: "outline" }), "gap-2")}>
              <Inbox className="h-4 w-4" />
              Manage inbox
              <ChevronDown className="h-4 w-4 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Inbox folders</DropdownMenuLabel>
              </DropdownMenuGroup>
              {inboxUsers.length === 0 ? (
                <DropdownMenuItem disabled>No inbox folders yet</DropdownMenuItem>
              ) : (
                inboxUsers.map((u) => (
                  <DropdownMenuItem key={u.name} onClick={() => router.push(`/library/video-inbox/${encodeURIComponent(u.name)}`)}>
                    <span className="min-w-0 flex-1 truncate">{u.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{u.files.toLocaleString()} file{u.files === 1 ? "" : "s"}</span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button onClick={() => open({ kind: "new" })}>
            <Plus className="h-4 w-4" />
            New project
          </Button>
        </div>
      </div>

      <Callout tone="info">
        <p>
          These files are temporary staging files for video projects. A project that hasn&apos;t changed for {RETENTION_MONTHS} months is deleted automatically, so export what you want to keep.
        </p>
      </Callout>

      {projects.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
          No projects yet. Create one to start editing.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex max-w-sm items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" aria-label="Search projects" placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 pl-8" />
          </div>
          <FieldHelp id="video.search" />
          </div>
          <div role="table" aria-label="Video projects" className="overflow-hidden rounded-xl border bg-card">
            <div role="row" className={cn(ROW, "border-b bg-muted/40 px-4 py-1.5")}>
              <div role="columnheader" aria-sort={ariaSort("name")}>{sortButton("name", "Name")}</div>
              {COLUMNS.map((c) => (
                <div key={c.label} role="columnheader" aria-sort={c.key ? ariaSort(c.key) : undefined} className={cn("hidden lg:flex", c.align === "right" && "justify-end")}>
                  {c.key ? sortButton(c.key, c.label) : <span className="py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{c.label}</span>}
                </div>
              ))}
              <div role="columnheader"><span className="sr-only">Actions</span></div>
            </div>
            {shown.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted-foreground">No project matches &ldquo;{query}&rdquo;.</p>}
            {shown.map((p) => {
              const left = mounted ? daysLeft(p.modified, now) : null
              const soon = left !== null && left <= 30
              return (
                <div key={p.folder} role="row" className={cn(ROW, "relative border-b px-4 py-2.5 transition-colors last:border-b-0 hover:bg-muted/50 focus-within:bg-muted/50")}>
                  <div role="cell" className="flex min-w-0 items-center gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-link/10 text-link">
                      <Clapperboard className="size-5" strokeWidth={1.5} />
                    </span>
                    <div className="min-w-0">
                      {/* The link's box covers the whole row; the buttons sit above it. */}
                      <Link
                        href={`/tools/video-editing/${encodeURIComponent(p.folder)}`}
                        className="block truncate font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                      >
                        {p.name}
                      </Link>
                      <div className="truncate text-xs text-muted-foreground lg:hidden">
                        {p.clips.toLocaleString()} clip{p.clips === 1 ? "" : "s"} &middot; {formatLength(p.duration)} &middot; {formatBytes(p.bytes)}
                        {mounted && <> &middot; {when(p.modified)}</>}
                      </div>
                    </div>
                  </div>
                  <div role="cell" className="hidden text-sm text-muted-foreground tabular-nums lg:block">
                    {mounted ? <time dateTime={new Date(p.modified).toISOString()}>{when(p.modified)}</time> : ""}
                  </div>
                  <div role="cell" className="hidden text-right text-sm text-muted-foreground tabular-nums lg:block">{p.clips.toLocaleString()}</div>
                  <div role="cell" className="hidden text-right text-sm text-muted-foreground tabular-nums lg:block">{formatLength(p.duration)}</div>
                  <div role="cell" className="hidden text-right text-sm text-muted-foreground tabular-nums lg:block">{formatBytes(p.bytes)}</div>
                  <div role="cell" className={cn("hidden text-sm tabular-nums lg:block", soon ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
                    {left === null ? "" : left === 0 ? "Today" : `${left.toLocaleString()} day${left === 1 ? "" : "s"}`}
                  </div>
                  <div role="cell" className="relative z-10 flex justify-end gap-0.5">
                    <Button variant="ghost" size="icon-sm" onClick={() => open({ kind: "rename", project: p })}>
                      <Pencil className="h-4 w-4" />
                      <span className="sr-only">Rename {p.name}</span>
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => open({ kind: "delete", project: p })}>
                      <Trash2 className="h-4 w-4" />
                      <span className="sr-only">Delete {p.name}</span>
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
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
          <div className="flex items-center gap-1.5">
            <label htmlFor="project-name" className="field-label">Project name</label>
            <FieldHelp id="video.project-name" />
          </div>
          <Input
            id="project-name"
            data-initial-focus
            placeholder="Summer trip…"
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
