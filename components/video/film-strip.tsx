"use client"

import { useEffect, useState, type RefObject } from "react"
import { cn } from "@/lib/utils"
import { filmstripTiles } from "@/lib/video/filmstrip"
import { useFilmFrames } from "./use-film-frames"

// A video clip's picture on the timeline: snapshots of the source along the
// clip, like a phone's trim bar. The snapshots belong to moments of the source,
// so dragging an edge crops the strip instead of moving the pictures. Until a
// snapshot is drawn its tile shows the file's poster.

const CHUNK = 400 // px: the window moves in steps this big, so scrolling re-renders the strip only now and then

export function FilmStrip({ folder, assetId, poster, inSec, outSec, duration, loop, zoom, height, left, scroller, className }: {
  /** The project folder and the asset: their snapshots come from the server (use-film-frames). */
  folder: string
  assetId: string
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
  /** The clip's left edge in the scrolled content (px), and the timeline's scroll viewport: only tiles near the screen are made. */
  left: number
  scroller: RefObject<HTMLDivElement | null>
  className?: string
}) {
  // The part of the clip on or near the screen (a screenful either side), in px from the clip's left edge.
  const [view, setView] = useState({ from: 0, to: CHUNK * 8 })
  useEffect(() => {
    const el = scroller.current
    const update = () => {
      if (!el) return
      const w = Math.max(el.clientWidth, CHUNK)
      const from = Math.floor((el.scrollLeft - left - w) / CHUNK) * CHUNK
      const to = Math.ceil((el.scrollLeft - left + 2 * w) / CHUNK) * CHUNK
      setView((v) => (v.from === from && v.to === to ? v : { from, to }))
    }
    update()
    el?.addEventListener("scroll", update, { passive: true })
    window.addEventListener("resize", update)
    return () => {
      el?.removeEventListener("scroll", update)
      window.removeEventListener("resize", update)
    }
  }, [scroller, left])
  const tiles = filmstripTiles({ inSec, outSec, zoom, tileWidth: Math.max(24, Math.round((height * 16) / 9)), duration: loop && duration > 0 ? Infinity : duration, view })
  const source = (at: number) => (loop && duration > 0 ? at % duration : at)
  const frame = useFilmFrames(folder, assetId)
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
