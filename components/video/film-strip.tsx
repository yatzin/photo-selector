"use client"

import { cn } from "@/lib/utils"
import { filmstripTiles } from "@/lib/video/filmstrip"
import { useFilmFrames } from "./use-film-frames"

// A video clip's picture on the timeline: snapshots of the source along the
// clip, like a phone's trim bar. The snapshots belong to moments of the source,
// so dragging an edge crops the strip instead of moving the pictures. Until a
// snapshot is drawn its tile shows the file's poster.

export function FilmStrip({ url, poster, inSec, outSec, duration, loop, zoom, height, className }: {
  /** The video file's URL; "" shows only posters. */
  url: string
  poster: string
  inSec: number
  outSec: number
  /** The source file's length (s). */
  duration: number
  /** A looping clip repeats the source: later moments show the start again. */
  loop?: boolean
  /** Timeline px per second. */
  zoom: number
  /** The strip's height (px); a tile is 16:9. */
  height: number
  className?: string
}) {
  const tiles = filmstripTiles({ inSec, outSec, zoom, tileWidth: Math.max(24, Math.round((height * 16) / 9)), duration: loop && duration > 0 ? Infinity : duration })
  const source = (at: number) => (loop && duration > 0 ? at % duration : at)
  const frame = useFilmFrames(url, tiles.map((t) => source(t.at)))
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      {tiles.map((t) => {
        const src = frame(source(t.at)) ?? poster
        return (
          // eslint-disable-next-line @next/next/no-img-element
          src ? <img key={t.x} src={src} alt="" draggable={false} className="absolute top-0 h-full object-cover" style={{ left: t.x, width: t.width }} /> : null
        )
      })}
    </div>
  )
}
