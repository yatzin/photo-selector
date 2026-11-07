"use client"

import { useRef, useState } from "react"
import { Film, Image as ImageIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { addClip, assetKind, clipLength, clipStarts, moveClip, totalLength, trimClip, type Project } from "@/lib/video/project"
import { newId } from "@/lib/video/ids"
import { dropIndex, trimDelta } from "@/lib/video/timeline-math"
import { formatTimecode } from "@/lib/video/time"
import { Thumb } from "./thumb"

// The bottom timeline: a ruler and one video track. Clips sit end to end (the
// track closes gaps). Drag a clip to reorder it, drag its edge handles to trim,
// drop a file from the left panel to add it (an Inbox file is imported first).

export const ASSET_DRAG_TYPE = "application/x-ps-asset"
/** An Inbox file being dragged: JSON { folder, name }. */
export const INBOX_DRAG_TYPE = "application/x-ps-inbox"

const TRACK_PAD = 16 // px of empty track after the last clip
const DRAG_THRESHOLD = 4 // px before a press on a clip becomes a drag

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
  /** An Inbox file was dropped at clip index `index`: import it, then add it there. */
  onDropInbox: (folder: string, name: string, index: number) => void
}) {
  // While a trim is being dragged the edit lives here; it's committed on release.
  const [trim, setTrim] = useState<{ id: string; edge: "in" | "out"; seconds: number } | null>(null)
  const [drag, setDrag] = useState<{ id: string; dx: number; to: number } | null>(null)
  const [dropTime, setDropTime] = useState<number | null>(null)
  const track = useRef<HTMLDivElement>(null)

  const shown = trim ? trimClip(project, trim.id, trim.edge, trim.seconds) : project
  // An out-edge trim ripples as you drag. An in-edge trim keeps every clip where it
  // was, so the left edge follows the pointer, and ripples on release.
  const layout = trim?.edge === "in" ? project : shown
  const starts = clipStarts(layout.clips)
  const total = totalLength(layout.clips)
  const width = Math.max(total * zoom + TRACK_PAD * 2, 600)
  const tickEvery = zoom >= 80 ? 1 : zoom >= 30 ? 5 : 10
  const ticks = Array.from({ length: Math.floor(width / zoom / tickEvery) + 1 }, (_, i) => i * tickEvery)

  /** Runs `move` for each pointer move until release, then `end`. */
  function track_(startEvent: React.PointerEvent, move: (dx: number) => void, end: (moved: boolean) => void) {
    const startX = startEvent.clientX
    let moved = false
    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - startX
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD) return
      moved = true
      move(dx)
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      end(moved)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  }

  function startTrim(e: React.PointerEvent, clipId: string, edge: "in" | "out") {
    e.stopPropagation()
    e.preventDefault()
    const clip = project.clips.find((c) => c.id === clipId)
    if (!clip) return
    let seconds: number | null = null
    onSelect(clipId)
    track_(
      e,
      (dx) => {
        const s = trimDelta(edge, clip, dx, zoom)
        seconds = s
        setTrim({ id: clipId, edge, seconds: s })
      },
      () => {
        setTrim(null)
        const s = seconds
        if (s !== null) onChange((p) => trimClip(p, clipId, edge, s))
      }
    )
  }

  /** Click or drag on the ruler: the preview follows the pointer until release. */
  function startScrub(e: React.PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    onScrub(true)
    const seekTo = (clientX: number) => onSeek(Math.min(total, timeAt(clientX)))
    seekTo(e.clientX)
    const onMove = (ev: PointerEvent) => seekTo(ev.clientX)
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      onScrub(false)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  }

  function startReorder(e: React.PointerEvent, clipId: string, index: number) {
    if (e.button !== 0) return
    const clip = project.clips[index]
    const others = project.clips.filter((c) => c.id !== clipId)
    const centre = starts[index] + clipLength(clip) / 2
    let to = index
    track_(
      e,
      (dx) => {
        to = dropIndex(others, centre + dx / zoom)
        setDrag({ id: clipId, dx, to })
      },
      (moved) => {
        setDrag(null)
        if (!moved) onSelect(clipId)
        else if (to !== index) onChange((p) => moveClip(p, clipId, to))
      }
    )
  }

  const timeAt = (clientX: number) => Math.max(0, (clientX - (track.current?.getBoundingClientRect().left ?? 0)) / zoom)

  // Where the dragged clip (or a dropped file) would land, as an x position.
  const markerAt = (index: number, clips = shown.clips) => (index < clips.length ? clipStarts(clips)[index] : totalLength(clips)) * zoom
  const marker =
    drag !== null
      ? markerAt(drag.to, shown.clips.filter((c) => c.id !== drag.id))
      : dropTime !== null
        ? markerAt(dropIndex(shown.clips, dropTime))
        : null

  return (
    <div className="relative overflow-x-auto overflow-y-hidden">
      <div className="relative" style={{ width }}>
        <div
          className="relative h-6 cursor-pointer touch-none border-b border-border/60 text-[10px] text-muted-foreground"
          onPointerDown={startScrub}
        >
          {ticks.map((t) => (
            <span key={t} className="pointer-events-none absolute top-0 h-full border-l border-border/60 pl-1 leading-6" style={{ left: t * zoom }}>
              {formatTimecode(t).slice(0, -2)}
            </span>
          ))}
        </div>
        <div
          ref={track}
          role="group"
          aria-label="Timeline"
          className="relative h-24"
          onPointerDown={(e) => e.target === e.currentTarget && onSelect(null)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(ASSET_DRAG_TYPE) && !e.dataTransfer.types.includes(INBOX_DRAG_TYPE)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = "copy"
            setDropTime(timeAt(e.clientX))
          }}
          onDragLeave={() => setDropTime(null)}
          onDrop={(e) => {
            const assetId = e.dataTransfer.getData(ASSET_DRAG_TYPE)
            const inbox = e.dataTransfer.getData(INBOX_DRAG_TYPE)
            setDropTime(null)
            if (!assetId && !inbox) return
            e.preventDefault()
            const index = dropIndex(project.clips, timeAt(e.clientX))
            if (assetId) {
              const id = newId()
              onChange((p) => addClip(p, assetId, index, id))
              return
            }
            try {
              const { folder, name } = JSON.parse(inbox) as { folder?: unknown; name?: unknown }
              if (typeof folder === "string" && typeof name === "string") onDropInbox(folder, name, index)
            } catch {
              // Not our drag after all.
            }
          }}
        >
          {shown.clips.length === 0 && (
            <div className="pointer-events-none flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Film className="h-4 w-4" /> Drag clips here to start your timeline
            </div>
          )}
          {shown.clips.map((clip, i) => {
            const dragging = drag?.id === clip.id
            const asset = project.assets[clip.asset]
            const file = asset?.file
            const image = asset !== undefined && assetKind(asset) === "image"
            // Zero except for the clip whose in edge is being dragged: how far that edge has moved.
            const inShift = clipLength(layout.clips[i]) - clipLength(clip)
            return (
              <div
                key={clip.id}
                role="button"
                tabIndex={0}
                aria-label={`Clip ${i + 1} of ${shown.clips.length}, ${image ? "image " : ""}${file ?? "missing file"}, ${clipLength(clip).toFixed(1)} seconds`}
                aria-pressed={selectedId === clip.id}
                onPointerDown={(e) => startReorder(e, clip.id, i)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(clip.id))}
                className={cn(
                  "group absolute top-2 bottom-2 touch-none select-none overflow-hidden rounded-lg border bg-muted outline-none",
                  !dragging && !trim && "transition-[left] duration-150 motion-reduce:transition-none",
                  selectedId === clip.id ? "z-10 border-primary ring-2 ring-primary" : "border-border hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring",
                  dragging ? "z-20 cursor-grabbing opacity-90 shadow-lg" : "cursor-grab"
                )}
                style={{
                  left: (starts[i] + inShift) * zoom + (dragging ? drag.dx : 0),
                  width: Math.max(clipLength(clip) * zoom - 2, 8),
                }}
                title={file}
              >
                <Thumb src={thumbUrl(clip.asset)} className="pointer-events-none h-full w-full object-cover opacity-80" />
                {image ? (
                  <span className="pointer-events-none absolute inset-x-3 bottom-0.5 flex items-center gap-1 truncate text-[10px] font-medium text-white drop-shadow">
                    <ImageIcon className="h-3 w-3 shrink-0" /> {clipLength(clip).toFixed(1)}s image
                  </span>
                ) : (
                  <span className="pointer-events-none absolute inset-x-3 bottom-0.5 truncate text-[10px] font-medium text-white drop-shadow">
                    {file ?? "Missing clip"} · {formatTimecode(clipLength(clip))}
                  </span>
                )}
                {(["in", "out"] as const).map((edge) => (
                  <span
                    key={edge}
                    aria-hidden
                    onPointerDown={(e) => startTrim(e, clip.id, edge)}
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
          {marker !== null && <div className="pointer-events-none absolute inset-y-1 z-30 w-0.5 -translate-x-1/2 rounded-full bg-primary" style={{ left: marker }} />}
        </div>
        <div className="pointer-events-none absolute top-0 bottom-0 z-40 w-px bg-primary" style={{ left: playhead * zoom }}>
          <div className="-ml-1 h-2 w-2 rounded-full bg-primary" />
        </div>
      </div>
    </div>
  )
}
