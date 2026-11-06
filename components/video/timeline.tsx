"use client"

import { useRef, useState } from "react"
import { Film } from "lucide-react"
import { cn } from "@/lib/utils"
import { addClip, clipLength, clipStarts, moveClip, totalLength, trimClip, type Project } from "@/lib/video/project"
import { dropIndex, trimDelta } from "@/lib/video/timeline-math"
import { formatTimecode } from "@/lib/video/time"

// The bottom timeline: a ruler and one video track. Clips sit end to end (the
// track closes gaps). Drag a clip to reorder it, drag its edge handles to trim,
// drop a file from the left panel to add it.

export const ASSET_DRAG_TYPE = "application/x-ps-asset"

const TRACK_PAD = 16 // px of empty track after the last clip
const DRAG_THRESHOLD = 4 // px before a press on a clip becomes a drag

export function Timeline({
  project, thumbUrl, selectedId, playhead, zoom, onSelect, onSeek, onChange,
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
  onChange: (p: Project) => void
}) {
  // While a trim is being dragged the edit lives here; it's committed on release.
  const [draft, setDraft] = useState<Project | null>(null)
  const [drag, setDrag] = useState<{ id: string; dx: number; to: number } | null>(null)
  const [dropTime, setDropTime] = useState<number | null>(null)
  const track = useRef<HTMLDivElement>(null)

  const shown = draft ?? project
  const starts = clipStarts(shown.clips)
  const total = totalLength(shown.clips)
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
    let latest = project
    onSelect(clipId)
    track_(
      e,
      (dx) => {
        latest = trimClip(project, clipId, edge, trimDelta(edge, clip, dx, zoom))
        setDraft(latest)
      },
      () => {
        setDraft(null)
        if (latest !== project) onChange(latest)
      }
    )
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
        else if (to !== index) onChange(moveClip(project, clipId, to))
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
          className="relative h-6 cursor-pointer border-b border-border/60 text-[10px] text-muted-foreground"
          onPointerDown={(e) => onSeek(Math.min(total, timeAt(e.clientX)))}
        >
          {ticks.map((t) => (
            <span key={t} className="pointer-events-none absolute top-0 h-full border-l border-border/60 pl-1 leading-6" style={{ left: t * zoom }}>
              {formatTimecode(t).slice(0, -2)}
            </span>
          ))}
        </div>
        <div
          ref={track}
          className="relative h-24"
          onPointerDown={(e) => e.target === e.currentTarget && onSelect(null)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = "copy"
            setDropTime(timeAt(e.clientX))
          }}
          onDragLeave={() => setDropTime(null)}
          onDrop={(e) => {
            const assetId = e.dataTransfer.getData(ASSET_DRAG_TYPE)
            setDropTime(null)
            if (!assetId) return
            e.preventDefault()
            onChange(addClip(project, assetId, dropIndex(project.clips, timeAt(e.clientX)), crypto.randomUUID()))
          }}
        >
          {shown.clips.length === 0 && (
            <div className="pointer-events-none flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Film className="h-4 w-4" /> Drag clips here to start your timeline
            </div>
          )}
          {shown.clips.map((clip, i) => {
            const dragging = drag?.id === clip.id
            return (
              <div
                key={clip.id}
                role="button"
                tabIndex={0}
                aria-label={project.assets[clip.asset]?.file ?? "Missing clip"}
                aria-pressed={selectedId === clip.id}
                onPointerDown={(e) => startReorder(e, clip.id, i)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(clip.id))}
                className={cn(
                  "group absolute top-2 bottom-2 select-none overflow-hidden rounded-lg border bg-muted outline-none",
                  !dragging && !draft && "transition-[left] duration-150 motion-reduce:transition-none",
                  selectedId === clip.id ? "z-10 border-primary ring-2 ring-primary" : "border-border hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring",
                  dragging ? "z-20 cursor-grabbing opacity-90 shadow-lg" : "cursor-grab"
                )}
                style={{
                  left: starts[i] * zoom + (dragging ? drag.dx : 0),
                  width: Math.max(clipLength(clip) * zoom - 2, 8),
                }}
                title={project.assets[clip.asset]?.file}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={thumbUrl(clip.asset)} alt="" draggable={false} className="pointer-events-none h-full w-full object-cover opacity-80" />
                <span className="pointer-events-none absolute inset-x-3 bottom-0.5 truncate text-[10px] font-medium text-white drop-shadow">
                  {project.assets[clip.asset]?.file ?? "Missing clip"} · {formatTimecode(clipLength(clip))}
                </span>
                {(["in", "out"] as const).map((edge) => (
                  <span
                    key={edge}
                    onPointerDown={(e) => startTrim(e, clip.id, edge)}
                    className={cn(
                      "absolute inset-y-0 flex w-3 cursor-ew-resize items-center justify-center bg-primary/80 opacity-0 transition-opacity group-hover:opacity-100",
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
