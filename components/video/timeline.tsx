"use client"

import { Film } from "lucide-react"
import { cn } from "@/lib/utils"
import { clipLength, clipStarts, totalLength, type Project } from "@/lib/video/project"
import { formatTimecode } from "@/lib/video/time"

// The bottom timeline: a ruler and one video track of clips, sized by length.
// Editing gestures (drag, trim, split) are added on top of this in Task 6.

const TRACK_PAD = 16 // px of empty track after the last clip, so there's room to drop

export function Timeline({
  project, thumbUrl, selectedId, playhead, zoom, onSelect, onSeek,
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
}) {
  const starts = clipStarts(project.clips)
  const total = totalLength(project.clips)
  const width = Math.max(total * zoom + TRACK_PAD * 2, 600)
  const tickEvery = zoom >= 80 ? 1 : zoom >= 30 ? 5 : 10
  const ticks = Array.from({ length: Math.floor(width / zoom / tickEvery) + 1 }, (_, i) => i * tickEvery)

  return (
    <div className="relative overflow-x-auto overflow-y-hidden">
      <div className="relative" style={{ width }} onPointerDown={(e) => e.target === e.currentTarget && onSelect(null)}>
        <div
          className="relative h-6 cursor-pointer border-b border-border/60 text-[10px] text-muted-foreground"
          onPointerDown={(e) => onSeek(Math.min(total, Math.max(0, (e.clientX - e.currentTarget.getBoundingClientRect().left) / zoom)))}
        >
          {ticks.map((t) => (
            <span key={t} className="pointer-events-none absolute top-0 h-full border-l border-border/60 pl-1 leading-6" style={{ left: t * zoom }}>
              {formatTimecode(t).slice(0, -2)}
            </span>
          ))}
        </div>
        <div className="relative h-24" onPointerDown={(e) => e.target === e.currentTarget && onSelect(null)}>
          {project.clips.length === 0 && (
            <div className="pointer-events-none flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Film className="h-4 w-4" /> Add clips from the left to start your timeline
            </div>
          )}
          {project.clips.map((clip, i) => (
            <button
              key={clip.id}
              type="button"
              onClick={() => onSelect(clip.id)}
              className={cn(
                "absolute top-2 bottom-2 overflow-hidden rounded-lg border bg-muted text-left outline-none transition-shadow",
                selectedId === clip.id ? "border-primary ring-2 ring-primary" : "border-border hover:border-foreground/40"
              )}
              style={{ left: starts[i] * zoom, width: Math.max(clipLength(clip) * zoom - 2, 8) }}
              title={project.assets[clip.asset]?.file}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumbUrl(clip.asset)} alt="" draggable={false} className="h-full w-full object-cover opacity-80" />
              <span className="absolute inset-x-1 bottom-0.5 truncate text-[10px] font-medium text-white drop-shadow">
                {project.assets[clip.asset]?.file ?? "Missing clip"}
              </span>
            </button>
          ))}
        </div>
        <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-primary" style={{ left: playhead * zoom }}>
          <div className="-ml-1 h-2 w-2 rounded-full bg-primary" />
        </div>
      </div>
    </div>
  )
}
