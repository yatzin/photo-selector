"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Check, Download, Loader2, Redo2, RotateCcw, SquareSplitHorizontal, Trash2, TriangleAlert, Undo2 } from "lucide-react"
import { toast } from "sonner"
import { Button, buttonVariants } from "@/components/ui/button"
import { useStoredValue } from "@/lib/hooks/use-stored-state"
import { exportStatusAction, importAssetAction, startExportAction } from "@/lib/actions/video-projects"
import { mediaUrl } from "@/lib/format"
import { cn } from "@/lib/utils"
import { newId } from "@/lib/video/ids"
import { canRedo, canUndo, commit, createHistory, redo, undo, type History } from "@/lib/video/history"
import { addClip, allClips, assetKind, clipsAt, DEFAULT_IMAGE, removeClip, resolveStart, setTransform, splitClip, totalLength, trackEnd, type Asset, type Edit, type Project } from "@/lib/video/project"
import { dragMove, IDENTITY, isIdentity } from "@/lib/video/transform"
import { formatTimecode } from "@/lib/video/time"
import { FileTree, type InboxFolder } from "./file-tree"
import { Preview } from "./preview"
import { ResizeHandle } from "./resize-handle"
import { usePreviewPlayer } from "./use-preview-player"
import { Timeline, type DropTarget } from "./timeline"
import { useAutosave } from "./use-autosave"

// The editor: file tree on the left, preview in the middle, timeline below.
// Slice 1 shell: import, add to timeline and autosave; drag/trim/split come
// with the timeline interactions, playback with the preview player.

const DEFAULT_ZOOM = 60 // px per second
const MIN_PREVIEW = 120 // px
const MIN_TIMELINE = 160 // px
const HANDLE = 8 // px, the resize handle's height
/** Arrow keys' nudge direction. */
const ARROWS: Record<string, [number, number] | undefined> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }

/**
 * Server-owned fields (assets, name, settings) and the undoable edit, in one
 * state so an edit queued right after an import sees the new asset.
 */
type EditorState = { meta: Omit<Project, keyof Edit>; history: History<Edit> }

function initialState(p: Project): EditorState {
  const { tracks, ...meta } = p
  return { meta, history: createHistory<Edit>({ tracks }) }
}

export function Editor({
  folder, userFolder, initial, inbox,
}: {
  folder: string
  userFolder: string
  initial: Project
  inbox: InboxFolder[]
}) {
  const [editor, setEditor] = useState(() => initialState(initial))
  const project = useMemo<Project>(() => ({ ...editor.meta, ...editor.history.present }), [editor.meta, editor.history.present])
  // The latest project for code that runs after an await, which outlives the render that started it.
  const latest = useRef(project)
  useEffect(() => {
    latest.current = project
  })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Undo can take away the selected clip: drop a selection that no longer exists.
  if (selectedId !== null && !allClips(project).some((c) => c.id === selectedId)) setSelectedId(null)

  /** One user gesture: one undo step. Repeats with the same `group` in quick succession make one step together. */
  const edit = useCallback((change: (p: Project) => Project, group?: string) => {
    setEditor((s) => {
      const next = change({ ...s.meta, ...s.history.present })
      const history = commit(s.history, { tracks: next.tracks }, group)
      return history === s.history ? s : { ...s, history }
    })
  }, [])
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  const [importing, setImporting] = useState<string | null>(null)
  // The guard against a second import: a ref, so two quick drops in one render can't both start.
  const importingRef = useRef(false)
  const { state: save, flush, isDirty } = useAutosave(folder, project)
  const [exportProgress, setExportProgress] = useState<number | null>(null)
  const exportTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const resumeAfterScrub = useRef(false)

  // Preview height: none stored (the default) lets the preview take what the timeline leaves.
  // The server and first paint use the default; a stored height takes over on hydration.
  const [storedHeight, setStoredHeight] = useStoredValue("ps.video.previewHeight")
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const parsedHeight = storedHeight ? Number(storedHeight) : NaN
  const previewHeight = dragHeight ?? (parsedHeight >= MIN_PREVIEW ? parsedHeight : null)
  const column = useRef<HTMLDivElement>(null)
  const previewBox = useRef<HTMLDivElement>(null)
  const [sizes, setSizes] = useState({ preview: 0, column: 0 })
  useEffect(() => {
    const col = column.current
    const pre = previewBox.current
    if (!col || !pre) return
    const ro = new ResizeObserver(() => setSizes({ preview: Math.round(pre.offsetHeight), column: col.clientHeight }))
    ro.observe(col)
    ro.observe(pre)
    return () => ro.disconnect()
  }, [])
  const maxPreview = Math.max(MIN_PREVIEW, sizes.column - HANDLE - MIN_TIMELINE)

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

  /** Copies an Inbox file into Project media (or finds the copy already there); its asset id and asset, or null when it failed. */
  async function importFile(inboxFolder: string, name: string): Promise<{ id: string; asset: Asset } | null> {
    if (importingRef.current) {
      toast.info("Wait for the current import to finish.")
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
      setEditor((s) => ({ ...s, meta: { ...s.meta, assets: { ...s.meta.assets, [r.id]: r.asset } } }))
      return { id: r.id, asset: r.asset }
    } catch {
      toast.error("Something went wrong importing that file.")
      return null
    } finally {
      importingRef.current = false
      setImporting(null)
    }
  }

  /** An Inbox file dropped on the timeline: import it, then put it where it was dropped. */
  async function dropFromInbox(inboxFolder: string, name: string, target: DropTarget) {
    const imported = await importFile(inboxFolder, name)
    if (!imported) return
    const id = newId()
    // Clips may have changed while importing; addClip slides the clip clear of the others, and a layer
    // removed meanwhile makes the clip a new top layer rather than dropping it.
    edit((p) => addClip(p, imported.id, Math.min(target.track, p.tracks.length), target, id))
    // The ghost had a guessed length before the import: say so when the real length slid the clip along.
    const p = latest.current
    const track = Math.min(target.track, p.tracks.length)
    const length = assetKind(imported.asset) === "image" ? DEFAULT_IMAGE : imported.asset.duration
    const start = resolveStart(p.tracks[track]?.clips ?? [], length, target.start, id)
    if (Math.abs(start - target.start) > 0.05) toast.info(`Placed at ${formatTimecode(start)} to avoid overlap`)
  }

  /** A finished export: the browser downloads the kept copy (the route serves it by project, so no name is needed). */
  function finished(reused: boolean, output?: string) {
    const a = document.createElement("a")
    a.href = `/api/video-projects/${encodeURIComponent(folder)}/download`
    a.download = ""
    a.hidden = true
    document.body.appendChild(a)
    a.click()
    a.remove()
    if (reused) toast.success("No changes since the last export. Downloading the existing copy.")
    else toast.success(`Exported ${output}`)
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
      // Nothing changed since the kept copy: the job is already done, so no polling.
      if (started.reused) {
        stop()
        finished(true, started.output)
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
            if (s.state === "done") finished(s.reused === true, s.output)
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
    // After the base track's last clip.
    edit((p) => addClip(p, assetId, 0, { start: trackEnd(p.tracks[0]) }, id))
  }

  const { pause } = player
  /** Undo or redo one step. Playback stops; the player shows the frame at the playhead in the new timeline. */
  const step = useCallback(
    (dir: "undo" | "redo") => {
      pause()
      setEditor((s) => {
        const history = dir === "undo" ? undo(s.history) : redo(s.history)
        return history === s.history ? s : { ...s, history }
      })
    },
    [pause]
  )

  // What S and the Split button cut: the selected clip when it's under the playhead, else the topmost one there.
  const playheadHits = clipsAt(project, playhead)
  const splitTarget = playheadHits.tracks.find((h) => h?.clip.id === selectedId)?.clip.id ?? playheadHits.top?.clip.id ?? null

  /** Splits at the playhead (S, or the toolbar); false when there's no clip under it. One undo step. */
  function splitAtPlayhead(): boolean {
    if (!splitTarget) return false
    const id = splitTarget
    const at = playhead
    const splitId = newId()
    edit((p) => splitClip(p, id, at, splitId))
    return true
  }

  /** Removes the selected clip (Delete, or the toolbar); false with no selection. One undo step. */
  function deleteSelected(): boolean {
    if (!selectedId) return false
    const id = selectedId
    edit((p) => removeClip(p, id))
    setSelectedId(null)
    return true
  }

  // The selected clip when it shows at the playhead (the preview draws its frame), and whether it's moved, scaled or cropped.
  // At the end the preview still shows the last frame, so look just before it, as the preview does.
  const shownTotal = totalLength(project)
  const shownHits = playhead >= shownTotal ? clipsAt(project, Math.max(0, shownTotal - 0.001)) : playheadHits
  const canvasSelected = shownHits.tracks.some((h) => h !== null && h.clip.id === selectedId) ? selectedId : null
  const transformed = selectedId !== null && allClips(project).some((c) => c.id === selectedId && !isIdentity(c.transform))

  /** Puts the selected clip's picture back as fit (the toolbar's Reset). One undo step. */
  function resetTransform() {
    if (!selectedId) return
    const id = selectedId
    edit((p) => setTransform(p, id, IDENTITY))
  }

  /** Moves the clip selected on the canvas by fractions of the canvas (arrow keys); quick repeats make one undo step. */
  function nudge(dx: number, dy: number): boolean {
    if (!canvasSelected) return false
    const id = canvasSelected
    edit((p) => {
      const clip = allClips(p).find((c) => c.id === id)
      return clip ? setTransform(p, id, dragMove(clip.transform ?? IDENTITY, dx, dy)) : p
    }, `nudge-${id}`)
    return true
  }

  // Keyboard: Space plays, S splits the selected clip under the playhead (else the topmost one there),
  // Delete removes the selection, Esc clears it, Cmd/Ctrl+Z undoes, Cmd/Ctrl+Shift+Z and Ctrl+Y redo,
  // the arrows nudge the clip selected on the canvas by 1% (Shift: 5%).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null
      // A handler that already acted (a clip's own Enter/Space select) prevents the default.
      if (e.defaultPrevented) return
      if (t?.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]")) return
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const key = e.key.toLowerCase()
        if (key === "z" || (key === "y" && e.ctrlKey && !e.shiftKey)) {
          e.preventDefault()
          step(key === "z" && !e.shiftKey ? "undo" : "redo")
        }
        return
      }
      const arrow = ARROWS[e.key]
      if (arrow && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // A focused slider or resize handle takes its own arrows.
        if (t?.closest("[role=slider], [role=separator]")) return
        const by = e.shiftKey ? 0.05 : 0.01
        if (nudge(arrow[0] * by, arrow[1] * by)) e.preventDefault()
        return
      }
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === " ") {
        // Space already activates a focused button, link or slider.
        if (t?.closest("button, a, [role=button], [role=menuitem], [role=slider]")) return
        e.preventDefault()
        toggle()
      } else if (e.key === "s" || e.key === "S") {
        if (splitAtPlayhead()) e.preventDefault()
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (deleteSelected()) e.preventDefault()
      } else if (e.key === "Escape" && selectedId) {
        setSelectedId(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // No dependency list: the handler shares splitAtPlayhead and deleteSelected with the toolbar, which see this render's state.
  })

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
        <Button type="button" size="sm" onClick={startExport} disabled={allClips(project).length === 0 || exportProgress !== null}>
          {exportProgress === null ? <Download className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
          {exportProgress === null ? "Export" : `Exporting ${Math.round(exportProgress * 100)}%`}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 border-r border-border/60 md:block">
          <FileTree inbox={inbox} project={project} thumbUrl={thumbUrl} importing={importing} onAdd={addToTimeline} />
        </aside>
        <div ref={column} className="flex min-w-0 flex-1 flex-col">
          {/* With a set height the preview gives way first (flex-shrink) and the timeline grows; CSS keeps both minimums. */}
          <div
            ref={previewBox}
            className={cn("flex min-h-[120px] flex-col", previewHeight === null && "flex-1")}
            style={previewHeight === null ? undefined : { flex: `0 1 ${previewHeight}px` }}
          >
            <Preview player={player} project={project} imageUrl={imageUrl} selectedId={selectedId} onSelect={setSelectedId} onChange={edit} />
          </div>
          <ResizeHandle
            label="Resize preview"
            value={Math.min(maxPreview, Math.max(MIN_PREVIEW, sizes.preview))}
            min={MIN_PREVIEW}
            max={maxPreview}
            onResize={(px, done) => {
              if (!done) return setDragHeight(px)
              setStoredHeight(String(px))
              setDragHeight(null)
            }}
            onReset={() => {
              setStoredHeight("")
              setDragHeight(null)
            }}
          />
          {/* The tracks scroll inside the timeline (vertically too, with several layers); the bar above stays put. */}
          <div className={cn("flex flex-col bg-card", previewHeight === null ? "max-h-[60%] shrink-0" : "min-h-[160px] flex-1")}>
            <div role="toolbar" aria-label="Timeline tools" className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-3 text-xs text-muted-foreground">
              <span className="tabular-nums">{formatTimecode(playhead)} / {formatTimecode(totalLength(project))}</span>
              <div aria-hidden className="mx-2 h-5 w-px bg-border" />
              <Button type="button" size="icon-sm" variant="ghost" onClick={() => step("undo")} disabled={!canUndo(editor.history)} title="Undo (Ctrl+Z / ⌘Z)" aria-label="Undo">
                <Undo2 className="h-4 w-4" />
              </Button>
              <Button type="button" size="icon-sm" variant="ghost" onClick={() => step("redo")} disabled={!canRedo(editor.history)} title="Redo (Ctrl+Shift+Z / ⌘⇧Z or Ctrl+Y)" aria-label="Redo">
                <Redo2 className="h-4 w-4" />
              </Button>
              <Button type="button" size="icon-sm" variant="ghost" onClick={splitAtPlayhead} disabled={!splitTarget} title="Split at playhead (S)" aria-label="Split at playhead">
                <SquareSplitHorizontal className="h-4 w-4" />
              </Button>
              <Button type="button" size="icon-sm" variant="ghost" onClick={deleteSelected} disabled={!selectedId} title="Delete selected clip (Delete)" aria-label="Delete selected clip">
                <Trash2 className="h-4 w-4" />
              </Button>
              {transformed && (
                <Button type="button" size="sm" variant="ghost" onClick={resetTransform} title="Put the selected clip's picture back to fit the frame" aria-label="Reset size, position and crop">
                  <RotateCcw className="h-4 w-4" /> Reset
                </Button>
              )}
              <div className="flex-1" />
              <label className="flex items-center gap-2">
                Zoom
                <input type="range" min={20} max={200} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-28 accent-primary" />
              </label>
            </div>
            <Timeline project={project} thumbUrl={thumbUrl} selectedId={selectedId} playhead={playhead} zoom={zoom} onSelect={setSelectedId} onSeek={player.seek} onScrub={scrub} onChange={edit} onDropInbox={(f, n, t) => void dropFromInbox(f, n, t)} />
          </div>
        </div>
      </div>
    </div>
  )
}
