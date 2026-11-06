"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight, Folder, Loader2, Plus, Video } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatBytes } from "@/lib/format"
import { formatTimecode } from "@/lib/video/time"
import type { Project } from "@/lib/video/project"
import { ASSET_DRAG_TYPE } from "./timeline"

// Left panel: the project's own media (already imported) and the Video Editing
// Inbox, where files can be imported from.

export type InboxFolder = { folder: string; files: { name: string; size: number }[] }

export function FileTree({
  inbox, project, thumbUrl, importing, onImport, onAdd,
}: {
  inbox: InboxFolder[]
  project: Project
  thumbUrl: (assetId: string) => string
  /** "folder/name" of the Inbox file being imported, if any. */
  importing: string | null
  onImport: (folder: string, name: string) => void
  /** Puts an imported asset on the end of the timeline. */
  onAdd: (assetId: string) => void
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const assets = Object.entries(project.assets)

  return (
    <div className="flex h-full flex-col overflow-y-auto text-sm">
      <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Project media</p>
      {assets.length === 0 && <p className="px-3 pb-2 text-xs text-muted-foreground">Import clips from the Inbox below.</p>}
      <ul className="px-2">
        {assets.map(([id, a]) => (
          <li
            key={id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(ASSET_DRAG_TYPE, id)
              e.dataTransfer.effectAllowed = "copy"
            }}
            className="group flex cursor-grab items-center gap-2 rounded-md p-1 hover:bg-muted/60 active:cursor-grabbing"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={thumbUrl(id)} alt="" draggable={false} className="h-9 w-14 shrink-0 rounded bg-muted object-cover" />
            <span className="min-w-0 flex-1">
              <span className="block truncate" title={a.file}>{a.file}</span>
              <span className="block text-[11px] text-muted-foreground tabular-nums">{formatTimecode(a.duration)}</span>
            </span>
            <Button type="button" size="icon-sm" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onAdd(id)} title="Add to timeline">
              <Plus className="h-4 w-4" />
              <span className="sr-only">Add {a.file} to timeline</span>
            </Button>
          </li>
        ))}
      </ul>

      <p className="mt-3 px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Inbox</p>
      {inbox.length === 0 && <p className="px-3 text-xs text-muted-foreground">No videos in the Video Editing Inbox yet.</p>}
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
                    <li key={key} className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/60">
                      <Video className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate" title={file.name}>{file.name}</span>
                        <span className="block text-[11px] text-muted-foreground">{formatBytes(file.size)}</span>
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className={cn("h-7 px-2 text-xs", importing !== key && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
                        disabled={importing !== null}
                        onClick={() => onImport(f.folder, file.name)}
                      >
                        {importing === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Import"}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
