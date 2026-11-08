"use client"

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { useTheme } from "next-themes"
import { cn } from "@/lib/utils"
import { waveformBars } from "@/lib/video/peaks"
import { dragSelection, sourceTicks, stepSelection, timeToX, type SourceDragMode, type SourceSelection } from "@/lib/video/source-window"
import { formatTimecode } from "@/lib/video/time"
import { useAssetPeaksState } from "./use-asset-peaks"

// The Edit length dialog's source strip: the whole media file's waveform
// (0..duration), mirrored bars in the editor accent (muted grey for a muted
// clip), with the clip's source window framed and the rest dimmed. Drag the
// left or right handle to crop, the window to slide it (same length); edges
// snap to the tick marks and the file's ends within SNAP_PX unless Alt is
// held. The handles and the window are sliders for the keyboard (arrows 0.01
// s, Shift 0.1 s, Home/End). Double-click resets to the whole file.

const HEIGHT = 100 // css px
const STEP = 2 // css px per bar, gap included
const SNAP_PX = 6
const HANDLE = 10 // css px; the handles sit outside the window so a short one stays reachable

const secs = (t: number) => `${t.toFixed(2)} s`

export function SourceStrip({ folder, assetId, duration, selection, minLength, muted, onChange }: {
  folder: string
  assetId: string
  /** The media file's length (s). */
  duration: number
  selection: SourceSelection
  minLength: number
  muted: boolean
  onChange: (selection: SourceSelection) => void
}) {
  const { status, peaks } = useAssetPeaksState(folder, assetId, true)
  const { resolvedTheme } = useTheme()
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [drag, setDrag] = useState<{ mode: SourceDragMode; x: number; from: SourceSelection; snapping: boolean } | null>(null)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // The whole file never changes with the selection, so the bars redraw only on size, peaks, mute or theme.
  useEffect(() => {
    const c = canvas.current
    if (!c || !peaks || !(width > 0)) return
    const frame = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1
      c.width = Math.round(width * dpr)
      c.height = Math.round(HEIGHT * dpr)
      const ctx = c.getContext("2d")
      if (!ctx) return
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.fillStyle = getComputedStyle(c).color
      const bars = waveformBars(peaks.peaks, peaks.rate, 0, duration, width, STEP)
      const mid = c.height / 2
      const barW = Math.max(1, Math.round(STEP * dpr) - 1)
      const half = (c.height - 4 * dpr) / 2
      bars.forEach((b, j) => {
        const h = Math.max(dpr / 2, b * half)
        ctx.fillRect(Math.round(j * STEP * dpr), Math.round(mid - h), barW, Math.max(1, Math.round(2 * h)))
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [peaks, width, duration, muted, resolvedTheme])

  const x = (t: number) => timeToX(Math.min(duration, Math.max(0, t)), duration, width)
  const ticks = sourceTicks(duration, width)
  const view = { in: Math.min(selection.in, duration), out: Math.min(selection.out, duration) }

  function down(mode: SourceDragMode, e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !(width > 0)) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus({ preventScroll: true })
    setDrag({ mode, x: e.clientX, from: selection, snapping: !e.altKey })
  }

  function move(e: PointerEvent<HTMLDivElement>) {
    if (!drag || !(width > 0)) return
    const snapping = !e.altKey
    if (snapping !== drag.snapping) setDrag({ ...drag, snapping })
    const delta = ((e.clientX - drag.x) / width) * duration
    onChange(dragSelection(drag.mode, duration, drag.from, delta, minLength, [0, duration, ...ticks], snapping, (SNAP_PX / width) * duration))
  }

  function up(e: PointerEvent<HTMLDivElement>) {
    if (!drag) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDrag(null)
  }

  function key(mode: SourceDragMode, e: KeyboardEvent<HTMLDivElement>) {
    const next = stepSelection(mode, duration, selection, e.key, e.shiftKey, minLength)
    if (!next) return
    e.preventDefault()
    e.stopPropagation()
    onChange(next)
  }

  const pointer = (mode: SourceDragMode) => ({
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => down(mode, e),
    onPointerMove: move,
    onPointerUp: up,
    onPointerCancel: up,
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => key(mode, e),
  })

  const handle = (side: "in" | "out") => (
    <div
      role="slider"
      tabIndex={0}
      aria-label={side === "in" ? "Source start" : "Source end"}
      aria-valuemin={side === "in" ? 0 : Math.min(duration, view.in + minLength)}
      aria-valuemax={side === "in" ? Math.max(0, view.out - minLength) : duration}
      aria-valuenow={side === "in" ? view.in : view.out}
      aria-valuetext={`${side} ${secs(side === "in" ? view.in : view.out)}`}
      data-handle={side}
      className="absolute top-0 flex cursor-ew-resize touch-none items-center justify-center rounded-sm bg-editor-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      style={{ height: HEIGHT, width: HANDLE, left: side === "in" ? x(view.in) : x(view.out) + HANDLE }}
      {...pointer(side)}
    >
      <span aria-hidden className="h-6 w-0.5 rounded-full bg-editor-accent-foreground/90" />
    </div>
  )

  return (
    <div className="grid gap-1">
      <div
        className="relative select-none"
        style={{ height: HEIGHT, paddingLeft: HANDLE, paddingRight: HANDLE }}
        onDoubleClick={() => onChange({ in: 0, out: duration })}
      >
        <div ref={wrap} className="relative h-full overflow-hidden rounded-md bg-muted/60">
          {status === "ready" && (
            <canvas ref={canvas} aria-hidden className={cn("absolute inset-0 h-full w-full", muted ? "text-muted-foreground" : "text-editor-accent")} />
          )}
          {status === "loading" && <div aria-hidden className="absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 animate-pulse rounded-full bg-muted-foreground/40" />}
          {status === "failed" && (
            <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Waveform unavailable</p>
          )}
          {ticks.map((t) => (
            <div key={t} aria-hidden className="pointer-events-none absolute bottom-0 h-2 w-px bg-foreground/30" style={{ left: x(t) }} />
          ))}
          {/* Outside the window: dimmed. */}
          <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 bg-background/70" style={{ width: x(view.in) }} />
          <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 bg-background/70" style={{ left: x(view.out) }} />
        </div>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Source window"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, duration - (view.out - view.in))}
          aria-valuenow={view.in}
          aria-valuetext={`${secs(view.in)} to ${secs(view.out)}`}
          data-handle="move"
          className={cn(
            "absolute top-0 touch-none border-y-2 border-editor-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            drag?.mode === "move" ? "cursor-grabbing" : "cursor-grab"
          )}
          style={{ height: HEIGHT, left: HANDLE + x(view.in), width: Math.max(1, x(view.out) - x(view.in)) }}
          {...pointer("move")}
        />
        {handle("in")}
        {handle("out")}
        {drag && (
          <div aria-hidden className="pointer-events-none absolute -top-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-neutral-900/80 px-2.5 py-0.5 text-[11px] text-white shadow dark:bg-neutral-100/90 dark:text-neutral-900">
            {drag.snapping ? "Hold Alt to turn snapping off" : "Snapping off"}
          </div>
        )}
      </div>
      <div aria-hidden className="relative h-4 text-[10px] text-muted-foreground tabular-nums" style={{ marginLeft: HANDLE, marginRight: HANDLE }}>
        <span className="absolute left-0">{formatTimecode(0)}</span>
        {ticks.map((t) => (
          <span key={t} className="absolute -translate-x-1/2" style={{ left: x(t) }}>{formatTimecode(t)}</span>
        ))}
        <span className="absolute right-0">{formatTimecode(duration)}</span>
      </div>
    </div>
  )
}
