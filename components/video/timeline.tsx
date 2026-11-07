"use client"

import { useEffect, useRef, useState } from "react"
import { Film, Image as ImageIcon, Plus, Volume2, VolumeX, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  addClip, addTrack, assetKind, clipLength, DEFAULT_IMAGE, findAssetsBySource, MAX_TRACKS, moveClip, removeTrack, resolveStart, setTrackMuted,
  totalLength, trackStarts, trimClip, type Clip, type Project,
} from "@/lib/video/project"
import { newId } from "@/lib/video/ids"
import { snapStart, trimDelta } from "@/lib/video/timeline-math"
import { formatTimecode } from "@/lib/video/time"
import { Thumb } from "./thumb"

// The bottom timeline: a ruler and stacked tracks (layers), the top layer at
// the top and the base track (V1) at the bottom. Clips on every track sit at
// their own start, gaps allowed, and a higher layer draws over the ones below.
// Drag a clip along or between tracks, drag its edge
// handles to trim, drop a file from the left panel onto a track to add it (an
// Inbox file is imported first), or onto the dashed row above to add a layer.

export const ASSET_DRAG_TYPE = "application/x-ps-asset"
/** An Inbox file being dragged: JSON { folder, name }. */
export const INBOX_DRAG_TYPE = "application/x-ps-inbox"

/** Where a clip lands: a track (one past the top makes a new layer) and its start there. */
export type DropTarget = { track: number; start: number }

const HEADER = 44 // px, the sticky column with each track's label and mute
const ROW = 80 // px per track
const NEW_ROW = 36 // px, the add-a-layer drop zone above the top track
const TRACK_PAD = 240 // px of empty timeline after the last clip, room to drag overlay clips into
const DRAG_THRESHOLD = 4 // px before a press on a clip becomes a drag
const SNAP_PX = 8 // px within which a dragged clip snaps to the playhead, 0 or another clip's edge

const hasMediaDrag = (dt: DataTransfer | null) => dt !== null && (dt.types.includes(ASSET_DRAG_TYPE) || dt.types.includes(INBOX_DRAG_TYPE))

const sameTarget =(a: DropTarget | null, b: DropTarget | null) => a === b || (a !== null && b !== null && a.track === b.track && a.start === b.start)

/** 0, the playhead and both edges of every clip but `ignore`: where a dragged clip snaps. */
function snapPoints(p: Project, playhead: number, ignore?: string): number[] {
  const points = [0, playhead]
  p.tracks.forEach((t) => {
    const starts = trackStarts(t)
    t.clips.forEach((c, k) => {
      if (c.id !== ignore) points.push(starts[k], starts[k] + clipLength(c))
    })
  })
  return points
}

export function Timeline({
  project, thumbUrl, selectedId, playhead, zoom, onSelect, onSeek, onScrub, onChange, onDropInbox,
}: {
  project: Project
  /** Thumbnail URL for an asset id. */
  thumbUrl: (assetId: string) => string
  selectedId: string | null
  playhead: number
  /** Pixels per second. */
  zoom: number
  onSelect: (id: string | null) => void
  onSeek: (t: number) => void
  /** Scrubbing on the ruler started (true) or ended (false). */
  onScrub: (active: boolean) => void
  /** Applies an edit to the current project (not the one this render saw, which may be stale by then). */
  onChange: (edit: (p: Project) => Project) => void
  /** An Inbox file was dropped: import it, then add it at `target`. */
  onDropInbox: (folder: string, name: string, target: DropTarget) => void
}) {
  // While a trim is being dragged the edit lives here; it's committed on release.
  const [trim, setTrim] = useState<{ id: string; edge: "in" | "out"; seconds: number } | null>(null)
  // A clip being dragged: how far the pointer has moved and where the clip would land.
  const [drag, setDrag] = useState<{ id: string; length: number; dx: number; dy: number; target: DropTarget | null } | null>(null)
  // A file from the left panel being dragged (anywhere): its clip length, when known, for the ghost.
  const [outside, setOutside] = useState<{ length: number } | null>(null)
  const [drop, setDrop] = useState<DropTarget | null>(null)
  const origin = useRef<HTMLDivElement>(null)
  const rowEls = useRef<(HTMLDivElement | null)[]>([])
  const newRowEl = useRef<HTMLDivElement>(null)
  const stopFollowing = useRef<(() => void) | null>(null)
  // The latest props for window listeners, which outlive the render that added them.
  const live = useRef({ project, playhead, zoom })
  useEffect(() => {
    live.current = { project, playhead, zoom }
  })

  // A pointer drag still running when the timeline unmounts mustn't leave its listeners behind.
  useEffect(() => () => stopFollowing.current?.(), [])

  // A file dragged from the left panel: show the add-a-layer zone and size the ghost while it's in the air.
  useEffect(() => {
    const onStart = (e: DragEvent) => {
      const dt = e.dataTransfer
      if (!dt || !hasMediaDrag(dt)) return
      // The data can only be read during dragstart itself.
      const p = live.current.project
      let length = DEFAULT_IMAGE
      const assetId = dt.getData(ASSET_DRAG_TYPE)
      const known = assetId ? p.assets[assetId] : undefined
      if (known) length = assetKind(known) === "image" ? DEFAULT_IMAGE : known.duration
      if (!assetId) {
        try {
          const { folder, name } = JSON.parse(dt.getData(INBOX_DRAG_TYPE)) as { folder?: unknown; name?: unknown }
          const copy = typeof folder === "string" && typeof name === "string" ? findAssetsBySource(p, `${folder}/${name}`)[0]?.asset : undefined
          if (copy && assetKind(copy) === "video") length = copy.duration
        } catch {
          // Not our drag after all; the default length will do for the ghost.
        }
      }
      // Changing the page inside dragstart can cancel the drag in some browsers: update after it.
      setTimeout(() => setOutside({ length }), 0)
    }
    const onEnd = () => {
      setOutside(null)
      setDrop(null)
    }
    window.addEventListener("dragstart", onStart)
    window.addEventListener("dragend", onEnd)
    window.addEventListener("drop", onEnd)
    return () => {
      window.removeEventListener("dragstart", onStart)
      window.removeEventListener("dragend", onEnd)
      window.removeEventListener("drop", onEnd)
    }
  }, [])

  const shown = trim ? trimClip(project, trim.id, trim.edge, trim.seconds) : project
  const total = Math.max(totalLength(project), totalLength(shown))
  const width = Math.max(total * zoom + TRACK_PAD, 600)
  const tickEvery = zoom >= 80 ? 1 : zoom >= 30 ? 5 : 10
  const ticks = Array.from({ length: Math.floor(width / zoom / tickEvery) + 1 }, (_, i) => i * tickEvery)
  const canAddTrack = project.tracks.length < MAX_TRACKS
  const dragging = outside !== null || drag !== null
  const target = drag ? drag.target : drop
  const targetLength = drag ? drag.length : (outside?.length ?? DEFAULT_IMAGE)

  const timeAt = (clientX: number) => Math.max(0, (clientX - (origin.current?.getBoundingClientRect().left ?? 0)) / live.current.zoom)

  /** The track under the pointer: the nearest row (the top one above the rows), or one past the top on and just above the add-a-layer row. */
  function rowAt(clientY: number): number {
    const count = live.current.project.tracks.length
    const zone = newRowEl.current?.getBoundingClientRect()
    if (zone && clientY >= zone.top - ROW / 2 && clientY < zone.bottom) return count
    for (let i = count - 1; i >= 0; i--) {
      const r = rowEls.current[i]?.getBoundingClientRect()
      if (r && clientY < r.bottom) return i
    }
    return 0
  }

  /**
   * Where a clip `length` long lands on `track`: its left edge `left` (the
   * pointer time) snapped and slid clear of the clips there. `ignore` is the
   * clip being moved.
   */
  function targetFor(track: number, left: number, length: number, ignore?: string): DropTarget {
    const { project: p, playhead: t, zoom: z } = live.current
    const start = snapStart(left, length, snapPoints(p, t, ignore), SNAP_PX, z)
    return { track, start: resolveStart(p.tracks[track]?.clips ?? [], length, start, ignore) }
  }

  /** Window listeners for one pointer drag, removed on release (or unmount). */
  function follow(onMove: (e: PointerEvent) => void, onEnd: () => void) {
    stopFollowing.current?.()
    const up = () => {
      stop()
      onEnd()
    }
    const stop = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
      if (stopFollowing.current === stop) stopFollowing.current = null
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
    stopFollowing.current = stop
  }

  function startTrim(e: React.PointerEvent, clip: Clip, edge: "in" | "out") {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    let moved = false
    let seconds: number | null = null
    onSelect(clip.id)
    follow(
      (ev) => {
        const dx = ev.clientX - startX
        if (!moved && Math.abs(dx) < DRAG_THRESHOLD) return
        moved = true
        const s = trimDelta(edge, clip, dx, live.current.zoom)
        seconds = s
        setTrim({ id: clip.id, edge, seconds: s })
      },
      () => {
        setTrim(null)
        const s = seconds
        if (s !== null) onChange((p) => trimClip(p, clip.id, edge, s))
      }
    )
  }

  /** Click or drag on the ruler: the preview follows the pointer until release. */
  function startScrub(e: React.PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    onScrub(true)
    const seekTo = (clientX: number) => onSeek(Math.min(totalLength(live.current.project), timeAt(clientX)))
    seekTo(e.clientX)
    follow((ev) => seekTo(ev.clientX), () => onScrub(false))
  }

  /** Press on a clip: a click selects it, a drag moves it along its track or onto another one. */
  function startMove(e: React.PointerEvent, clip: Clip, track: number, left: number) {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    const length = clipLength(clip)
    let moved = false
    let to: DropTarget | null = null
    follow(
      (ev) => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        moved = true
        const newLeft = Math.max(0, left + dx / live.current.zoom)
        to = targetFor(rowAt(ev.clientY), newLeft, length, clip.id)
        setDrag({ id: clip.id, length, dx, dy, target: to })
      },
      () => {
        setDrag(null)
        if (!moved) return onSelect(clip.id)
        const t = to
        if (!t) return
        const stays = t.track === track && Math.abs(t.start - left) < 1e-9
        if (!stays) onChange((p) => moveClip(p, clip.id, t.track, t))
      }
    )
  }

  // Drag and drop of files onto a track row (`track` one past the top is the add-a-layer row).
  function dragOver(e: React.DragEvent, track: number) {
    if (!hasMediaDrag(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
    const t = timeAt(e.clientX)
    const next = targetFor(track, t, outside?.length ?? DEFAULT_IMAGE)
    setDrop((prev) => (sameTarget(prev, next) ? prev : next))
  }

  function dragLeave(e: React.DragEvent) {
    // Moving onto a clip inside the row isn't leaving it.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    setDrop(null)
  }

  function dropOn(e: React.DragEvent, track: number) {
    const assetId = e.dataTransfer.getData(ASSET_DRAG_TYPE)
    const inbox = e.dataTransfer.getData(INBOX_DRAG_TYPE)
    setDrop(null)
    if (!assetId && !inbox) return
    e.preventDefault()
    const t = timeAt(e.clientX)
    if (assetId) {
      const asset = live.current.project.assets[assetId]
      if (!asset) return
      const to = targetFor(track, t, assetKind(asset) === "image" ? DEFAULT_IMAGE : asset.duration)
      const id = newId()
      onChange((p) => addClip(p, assetId, to.track, to, id))
      return
    }
    try {
      const { folder, name } = JSON.parse(inbox) as { folder?: unknown; name?: unknown }
      // The clip's real length is known after the import; addClip slides it clear of overlaps again then.
      if (typeof folder === "string" && typeof name === "string") onDropInbox(folder, name, targetFor(track, t, outside?.length ?? DEFAULT_IMAGE))
    } catch {
      // Not our drag after all.
    }
  }

  const ghost = (start: number, shift = 0) => (
    <div
      className="pointer-events-none absolute top-2 bottom-2 z-10 rounded-lg border-2 border-dashed border-primary bg-primary/10"
      style={{ left: start * zoom + shift, width: Math.max(targetLength * zoom - 2, 8) }}
    />
  )

  const allEmpty = project.tracks.every((t) => t.clips.length === 0)
  const rows = shown.tracks.map((_, i) => i).reverse()

  return (
    <div className="relative min-h-0 flex-1 overflow-auto">
      <div className="relative" style={{ width: HEADER + width }}>
        <div className="sticky top-0 z-40 flex h-6 border-b border-border/60 bg-card">
          <div className="sticky left-0 z-50 flex shrink-0 items-center justify-center border-r border-border/60 bg-card" style={{ width: HEADER }}>
            <button
              type="button"
              onClick={() => onChange(addTrack)}
              disabled={!canAddTrack}
              title={canAddTrack ? "Add layer" : `At most ${MAX_TRACKS} layers`}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="sr-only">Add layer</span>
            </button>
          </div>
          <div ref={origin} className="relative flex-1 cursor-pointer touch-none text-[10px] text-muted-foreground" onPointerDown={startScrub}>
            {ticks.map((t) => (
              <span key={t} className="pointer-events-none absolute top-0 h-full border-l border-border/60 pl-1 leading-6" style={{ left: t * zoom }}>
                {formatTimecode(t).slice(0, -2)}
              </span>
            ))}
            <div className="pointer-events-none absolute bottom-0 h-2 w-2 -translate-x-1/2 rounded-full bg-primary" style={{ left: playhead * zoom }} />
          </div>
        </div>

        <span className="sr-only" aria-live="polite">{dragging && canAddTrack ? "Drop on the row above the top layer to add a layer." : ""}</span>
        {canAddTrack && (
          <div className="flex" style={{ height: NEW_ROW }}>
            <div className="sticky left-0 z-30 shrink-0 border-r border-border/60 bg-card" style={{ width: HEADER }} />
            <div
              ref={newRowEl}
              role="group"
              aria-label="Drop here to add a layer"
              className={cn(
                "relative my-1 flex-1 rounded-md border-2 border-dashed text-[11px]",
                dragging ? "border-primary/60 bg-primary/5 text-foreground" : "border-transparent text-muted-foreground/60"
              )}
              onDragOver={(e) => dragOver(e, project.tracks.length)}
              onDragLeave={dragLeave}
              onDrop={(e) => dropOn(e, project.tracks.length)}
            >
              <span className="pointer-events-none sticky left-2 inline-flex h-full items-center px-2">
                {dragging ? "Drop here to add a layer" : "Drag media here for a new layer"}
              </span>
              {/* -2 px: the ghost sits inside this row's border, and lines up with the time grid. */}
              {target?.track === project.tracks.length && ghost(target.start, -2)}
            </div>
          </div>
        )}

        {rows.map((i) => {
          const track = shown.tracks[i]
          const isBase = i === 0
          const muted = Boolean(track.muted)
          const starts = trackStarts(track)
          const label = isBase ? "Layer 1 (base)" : `Layer ${i + 1}`
          return (
            <div key={track.id} className="flex border-b border-border/60" style={{ height: ROW }}>
              <div className="sticky left-0 z-30 flex shrink-0 flex-col items-center justify-center gap-0.5 border-r border-border/60 bg-card text-[11px]" style={{ width: HEADER }}>
                <span className={cn("font-medium", muted && "text-muted-foreground")} title={label}>V{i + 1}</span>
                {isBase && <span aria-hidden className="rounded bg-muted px-1 text-[9px] leading-tight text-muted-foreground" title={label}>base</span>}
                <button
                  type="button"
                  aria-pressed={muted}
                  title={muted ? `Unmute ${label}` : `Mute ${label}`}
                  onClick={() => onChange((p) => setTrackMuted(p, track.id, !muted))}
                  className={cn("flex h-5 w-5 items-center justify-center rounded hover:bg-muted", muted ? "text-destructive" : "text-muted-foreground hover:text-foreground")}
                >
                  {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                  <span className="sr-only">Mute {label}</span>
                </button>
                {!isBase && project.tracks[i]?.clips.length === 0 && (
                  <button
                    type="button"
                    title={`Remove ${label}`}
                    onClick={() => onChange((p) => removeTrack(p, track.id))}
                    className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                    <span className="sr-only">Remove {label}</span>
                  </button>
                )}
              </div>
              <div
                ref={(el) => {
                  rowEls.current[i] = el
                }}
                role="group"
                aria-label={muted ? `${label}, muted` : label}
                className={cn("relative flex-1", !isBase && "bg-muted/20")}
                onPointerDown={(e) => e.target === e.currentTarget && onSelect(null)}
                onDragOver={(e) => dragOver(e, i)}
                onDragLeave={dragLeave}
                onDrop={(e) => dropOn(e, i)}
              >
                {isBase && allEmpty && !dragging && (
                  <div className="pointer-events-none sticky left-0 flex h-full w-[min(100%,32rem)] items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Film className="h-4 w-4" /> Drag clips here to start your timeline
                  </div>
                )}
                {track.clips.map((clip, k) => {
                  const moving = drag?.id === clip.id
                  const asset = project.assets[clip.asset]
                  const file = asset?.file
                  const image = asset !== undefined && assetKind(asset) === "image"
                  const left = starts[k]
                  return (
                    <div
                      key={clip.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${label}, clip ${k + 1} of ${track.clips.length}, ${image ? "image " : ""}${file ?? "missing file"}, at ${formatTimecode(starts[k])}, ${clipLength(clip).toFixed(1)} seconds`}
                      aria-pressed={selectedId === clip.id}
                      onPointerDown={(e) => startMove(e, clip, i, starts[k])}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(clip.id))}
                      className={cn(
                        "group absolute top-2 bottom-2 touch-none select-none overflow-hidden rounded-lg border outline-none",
                        isBase ? "bg-muted" : "bg-sky-500/15",
                        !moving && !trim && "transition-[left] duration-150 motion-reduce:transition-none",
                        selectedId === clip.id
                          ? "z-10 border-primary ring-2 ring-primary"
                          : isBase
                            ? "border-border hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring"
                            : "border-sky-500/60 hover:border-sky-400 focus-visible:ring-2 focus-visible:ring-ring",
                        moving ? "pointer-events-none z-20 cursor-grabbing opacity-70 shadow-lg" : "cursor-grab",
                        muted && "opacity-60"
                      )}
                      style={{
                        left: left * zoom,
                        width: Math.max(clipLength(clip) * zoom - 2, 8),
                        transform: moving ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
                      }}
                      title={file}
                    >
                      <Thumb src={thumbUrl(clip.asset)} className={cn("pointer-events-none h-full w-full object-cover", isBase ? "opacity-80" : "opacity-70")} />
                      {image ? (
                        <span className="pointer-events-none absolute inset-x-3 bottom-0.5 flex items-center gap-1 truncate text-[10px] font-medium text-white drop-shadow">
                          <ImageIcon className="h-3 w-3 shrink-0" /> {clipLength(clip).toFixed(1)}s image
                        </span>
                      ) : (
                        <span className="pointer-events-none absolute inset-x-3 bottom-0.5 truncate text-[10px] font-medium text-white drop-shadow">
                          {file ?? "Missing clip"} · {formatTimecode(clipLength(clip))}
                        </span>
                      )}
                      {muted && <VolumeX className="pointer-events-none absolute top-1 right-3 h-3 w-3 text-white drop-shadow" />}
                      {(["in", "out"] as const).map((edge) => (
                        <span
                          key={edge}
                          aria-hidden
                          onPointerDown={(e) => startTrim(e, clip, edge)}
                          className={cn(
                            "absolute inset-y-0 flex w-3 cursor-ew-resize touch-none items-center justify-center bg-primary/80 opacity-0 transition-opacity group-hover:opacity-100",
                            selectedId === clip.id && "opacity-100",
                            edge === "in" ? "left-0 rounded-l-lg" : "right-0 rounded-r-lg"
                          )}
                        >
                          <span className="h-5 w-0.5 rounded-full bg-primary-foreground/90" />
                        </span>
                      ))}
                    </div>
                  )
                })}
                {target?.track === i && ghost(target.start)}
              </div>
            </div>
          )
        })}
        <div className="pointer-events-none absolute top-6 bottom-0 z-20 w-px bg-primary" style={{ left: HEADER + playhead * zoom }} />
      </div>
    </div>
  )
}
