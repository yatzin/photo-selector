"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowLeft, Check, Download, Loader2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Button, buttonVariants } from "@/components/ui/button"
import { exportStatusAction, importAssetAction, startExportAction } from "@/lib/actions/video-projects"
import { mediaUrl } from "@/lib/format"
import { newId } from "@/lib/video/ids"
import { addClip, assetKind, removeClip, splitClip, totalLength, type Project } from "@/lib/video/project"
import { clipIdAt } from "@/lib/video/timeline-math"
import { formatTimecode } from "@/lib/video/time"
import { FileTree, type InboxFolder } from "./file-tree"
import { Preview } from "./preview"
import { usePreviewPlayer } from "./use-preview-player"
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
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  const [importing, setImporting] = useState<string | null>(null)
  // The guard against a second import: a ref, so two quick drops in one render can't both start.
  const importingRef = useRef(false)
  const { state: save, flush, isDirty } = useAutosave(folder, project)
  const [exportProgress, setExportProgress] = useState<number | null>(null)
  const exportTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const resumeAfterScrub = useRef(false)

  useEffect(() => () => {
    if (exportTimer.current) clearInterval(exportTimer.current)
  }, [])

  // Closing the tab with an unsaved edit asks first.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirty()) return
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [isDirty])

  // The asset id is the cache key: the media route caches for a year, and a
  // file name can come back with different content after a re-import.
  const thumbUrl = useCallback(
    (assetId: string) => {
      const file = project.assets[assetId]?.file
      return file ? mediaUrl("video-projects", [userFolder, folder, "assets"], file, "thumb", assetId) : ""
    },
    [project.assets, userFolder, folder]
  )

  const videoUrl = useCallback(
    (assetId: string) => {
      const asset = project.assets[assetId]
      return asset && assetKind(asset) === "video" ? mediaUrl("video-projects", [userFolder, folder, "assets"], asset.file, "original", assetId) : ""
    },
    [project.assets, userFolder, folder]
  )

  /** A still shown in the preview while an image clip is current (the converted preview, so HEIC and DNG show too). */
  const imageUrl = useCallback(
    (assetId: string) => {
      const asset = project.assets[assetId]
      return asset && assetKind(asset) === "image" ? mediaUrl("video-projects", [userFolder, folder, "assets"], asset.file, "preview", assetId) : ""
    },
    [project.assets, userFolder, folder]
  )
  const player = usePreviewPlayer(project, videoUrl)
  const playhead = player.time
  const { toggle } = player

  /** Playback pauses while the ruler is scrubbed and picks up again after. */
  function scrub(active: boolean) {
    if (active) {
      resumeAfterScrub.current = player.playing
      player.pause()
    } else if (resumeAfterScrub.current) {
      resumeAfterScrub.current = false
      player.play()
    }
  }

  /** Copies an Inbox file into Project media (or finds the copy already there); its asset id, or null when it failed. */
  async function importFile(inboxFolder: string, name: string, fromDrop = false): Promise<string | null> {
    if (importingRef.current) {
      if (fromDrop) toast.info("Wait for the current import to finish.")
      return null
    }
    importingRef.current = true
    setImporting(`${inboxFolder}/${name}`)
    try {
      const r = await importAssetAction(folder, [inboxFolder], name)
      if ("error" in r) {
        toast.error(r.error)
        return null
      }
      // The server owns assets: take the new one from its reply.
      setProject((p) => ({ ...p, assets: { ...p.assets, [r.id]: r.asset } }))
      if (r.reused && !fromDrop) toast.info(`${name} is already in Project media.`)
      return r.id
    } catch {
      toast.error("Something went wrong importing that file.")
      return null
    } finally {
      importingRef.current = false
      setImporting(null)
    }
  }

  /** An Inbox file dropped on the timeline: import it, then put it where it was dropped. */
  async function dropFromInbox(inboxFolder: string, name: string, index: number) {
    const assetId = await importFile(inboxFolder, name, true)
    if (!assetId) return
    const id = newId()
    // Clips may have changed while importing; addClip clamps the index to the current timeline.
    setProject((p) => addClip(p, assetId, index, id))
  }

  async function startExport() {
    if (exportProgress !== null) return
    setExportProgress(0)
    const stop = () => {
      if (exportTimer.current) clearInterval(exportTimer.current)
      exportTimer.current = null
      setExportProgress(null)
    }
    try {
      // The server exports what's stored, so store any pending edit first.
      if (!(await flush())) {
        toast.error("Couldn't save the project, so it wasn't exported.")
        stop()
        return
      }
      const started = await startExportAction(folder)
      if ("error" in started) {
        toast.error(started.error)
        stop()
        return
      }
      let polling = false
      exportTimer.current = setInterval(async () => {
        if (polling) return
        polling = true
        try {
          const s = await exportStatusAction(started.jobId)
          if (s.state === "running") {
            setExportProgress(s.progress)
          } else {
            stop()
            if (s.state === "done") toast.success(`Exported ${s.output}`)
            else toast.error(s.error ?? "Export failed.")
          }
        } catch {
          stop()
          toast.error("Lost contact with the export.")
        } finally {
          polling = false
        }
      }, 1000)
    } catch {
      stop()
      toast.error("Something went wrong starting the export.")
    }
  }

  function addToTimeline(assetId: string) {
    const id = newId()
    setProject((p) => addClip(p, assetId, p.clips.length, id))
  }

  // Keyboard: Space plays, S splits the clip under the playhead, Delete removes the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null
      // A handler that already acted (a clip's own Enter/Space select) prevents the default.
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if (t?.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]")) return
      if (e.key === " ") {
        // Space already activates a focused button, link or slider.
        if (t?.closest("button, a, [role=button], [role=menuitem], [role=slider]")) return
        e.preventDefault()
        toggle()
      } else if (e.key === "s" || e.key === "S") {
        const id = clipIdAt(project.clips, playhead)
        if (!id) return
        e.preventDefault()
        const splitId = newId()
        setProject((p) => splitClip(p, id, playhead, splitId))
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault()
        setProject((p) => removeClip(p, selectedId))
        setSelectedId(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [project.clips, playhead, selectedId, toggle])

  return (
    <div className="-m-6 flex h-[calc(100%+3rem)] flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-4">
        <Link href="/tools/video-editing" title="All projects" className={buttonVariants({ variant: "ghost", size: "icon-sm" })}>
          <ArrowLeft className="h-4 w-4" />
          <span className="sr-only">All projects</span>
        </Link>
        <h1 className="truncate font-heading text-base font-semibold">{project.name}</h1>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {save === "saving" && <><Loader2 className="h-3 w-3 animate-spin" /> Saving…</>}
          {save === "saved" && <><Check className="h-3 w-3" /> Saved</>}
          {/* Only a failure is announced; Saving/Saved after every edit would be noise. */}
          <span aria-live="polite">
            {save === "error" && <span className="flex items-center gap-1 text-destructive"><TriangleAlert className="h-3 w-3" /> Couldn&apos;t save</span>}
          </span>
        </span>
        <div className="flex-1" />
        <Button type="button" size="sm" onClick={startExport} disabled={project.clips.length === 0 || exportProgress !== null}>
          {exportProgress === null ? <Download className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
          {exportProgress === null ? "Export" : `Exporting ${Math.round(exportProgress * 100)}%`}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 border-r border-border/60 md:block">
          <FileTree inbox={inbox} project={project} thumbUrl={thumbUrl} importing={importing} onImport={(f, n) => void importFile(f, n)} onAdd={addToTimeline} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <Preview player={player} project={project} imageUrl={imageUrl} />
          <div className="shrink-0 border-t border-border/60 bg-card">
            <div className="flex h-9 items-center gap-3 border-b border-border/60 px-3 text-xs text-muted-foreground">
              <span className="tabular-nums">{formatTimecode(playhead)} / {formatTimecode(totalLength(project.clips))}</span>
              <span className="hidden sm:inline">Space play · S split · Delete remove · drag edges to trim</span>
              <div className="flex-1" />
              <label className="flex items-center gap-2">
                Zoom
                <input type="range" min={20} max={200} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-28 accent-primary" />
              </label>
            </div>
            <Timeline project={project} thumbUrl={thumbUrl} selectedId={selectedId} playhead={playhead} zoom={zoom} onSelect={setSelectedId} onSeek={player.seek} onScrub={scrub} onChange={setProject} onDropInbox={(f, n, i) => void dropFromInbox(f, n, i)} />
          </div>
        </div>
      </div>
    </div>
  )
}
