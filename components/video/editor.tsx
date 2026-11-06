"use client"

import Link from "next/link"
import { useCallback, useState } from "react"
import { ArrowLeft, Check, Download, Loader2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Button, buttonVariants } from "@/components/ui/button"
import { importAssetAction } from "@/lib/actions/video-projects"
import { mediaUrl } from "@/lib/format"
import { addClip, totalLength, type Project } from "@/lib/video/project"
import { formatTimecode } from "@/lib/video/time"
import { FileTree, type InboxFolder } from "./file-tree"
import { Timeline } from "./timeline"
import { useAutosave } from "./use-autosave"

// The editor: file tree on the left, preview in the middle, timeline below.
// Slice 1 shell: import, add to timeline and autosave; drag/trim/split come
// with the timeline interactions, playback with the preview player.

const DEFAULT_ZOOM = 60 // px per second

export function Editor({
  folder, userFolder, initial, inbox,
}: {
  folder: string
  userFolder: string
  initial: Project
  inbox: InboxFolder[]
}) {
  const [project, setProject] = useState(initial)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [zoom] = useState(DEFAULT_ZOOM)
  const [importing, setImporting] = useState<string | null>(null)
  const save = useAutosave(folder, project)

  const thumbUrl = useCallback(
    (assetId: string) => {
      const file = project.assets[assetId]?.file
      return file ? mediaUrl("video-projects", [userFolder, folder, "assets"], file, "thumb", "1") : ""
    },
    [project.assets, userFolder, folder]
  )

  async function importFile(inboxFolder: string, name: string) {
    if (importing) return
    setImporting(`${inboxFolder}/${name}`)
    try {
      const r = await importAssetAction(folder, [inboxFolder], name)
      if ("error" in r) {
        toast.error(r.error)
        return
      }
      // The server owns assets: take the new one from its reply.
      setProject((p) => ({ ...p, assets: { ...p.assets, [r.id]: r.asset } }))
    } catch {
      toast.error("Something went wrong importing that clip.")
    } finally {
      setImporting(null)
    }
  }

  function addToTimeline(assetId: string) {
    setProject((p) => addClip(p, assetId, p.clips.length, crypto.randomUUID()))
  }

  return (
    <div className="-m-6 flex h-[calc(100%+3rem)] flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-4">
        <Link href="/tools/video-editing" title="All projects" className={buttonVariants({ variant: "ghost", size: "icon-sm" })}>
          <ArrowLeft className="h-4 w-4" />
          <span className="sr-only">All projects</span>
        </Link>
        <h1 className="truncate font-heading text-base font-semibold">{project.name}</h1>
        <span className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
          {save === "saving" && <><Loader2 className="h-3 w-3 animate-spin" /> Saving…</>}
          {save === "saved" && <><Check className="h-3 w-3" /> Saved</>}
          {save === "error" && <span className="flex items-center gap-1 text-destructive"><TriangleAlert className="h-3 w-3" /> Couldn&apos;t save</span>}
        </span>
        <div className="flex-1" />
        <Button type="button" size="sm" disabled title="Export arrives in a later step">
          <Download className="h-4 w-4" /> Export
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 border-r border-border/60 md:block">
          <FileTree inbox={inbox} project={project} thumbUrl={thumbUrl} importing={importing} onImport={importFile} onAdd={addToTimeline} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 items-center justify-center bg-black/90 p-4">
            <div className="flex aspect-video max-h-full max-w-full items-center justify-center rounded-md bg-black text-sm text-white/60" style={{ height: "100%" }}>
              {project.clips.length ? `Preview · ${formatTimecode(playhead)} / ${formatTimecode(totalLength(project.clips))}` : "Preview"}
            </div>
          </div>
          <div className="shrink-0 border-t border-border/60 bg-card">
            <Timeline project={project} thumbUrl={thumbUrl} selectedId={selectedId} playhead={playhead} zoom={zoom} onSelect={setSelectedId} onSeek={setPlayhead} />
          </div>
        </div>
      </div>
    </div>
  )
}
