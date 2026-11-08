"use client"

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react"
import { useTheme } from "next-themes"
import { cn } from "@/lib/utils"
import { waveformBars } from "@/lib/video/peaks"
import { dragSelection, stepSelection, type SourceDragMode, type SourceSelection } from "@/lib/video/source-window"
import { clampViewport, fullViewport, maxZoom, nextZoom, panViewport, viewTicks, viewTimeToX, viewXToTime, zoomOf, zoomViewport, type Viewport } from "@/lib/video/source-zoom"
import { formatTimecode } from "@/lib/video/time"
import { useAssetPeaksState } from "./use-asset-peaks"

// The Edit length dialog's source strip: the media file's waveform, mirrored
// bars in the editor accent (muted grey for a muted clip), with the clip's
// source window framed and the rest dimmed. Drag the left or right handle to
// crop, the window to slide it (same length); edges snap to the tick marks and
// the file's ends within SNAP_PX unless Alt is held. The handles and the
// window are sliders for the keyboard (arrows 0.01 s, Shift 0.1 s, Home/End).
// Double-click resets to the whole file. With `onSeek`, a ruler row above the
// waveform scrubs the dialog's preview (click or drag; the dialog keeps it
// inside the selection) and `playhead` draws its position as a line.
//
// Zoom (lib/video/source-zoom): + and - at the wave's top right (or the + -
// and 0 keys inside the strip, or Ctrl/Cmd + wheel) zoom in steps of 2x from
// the whole file up to 32x or a one-second view, focused on the selection;
// Fit (or a double-click on the readout) goes back to the whole file. Zoomed,
// the wheel (or Shift + wheel) pans, as do dragging the time labels and the
// overview bar under them (the whole file with the visible part framed), and
// a handle or the window dragged to the strip's edge pans the view along.
// The bars redraw for the visible part, one bar per peak when zoomed in deep.

const HEIGHT = 112 // css px
const SNAP_PX = 6
const HANDLE = 10 // css px; the handles sit outside the window so a short one stays reachable
const RULER = 14 // css px; the scrub row above the waveform
const EDGE_PX = 18 // a drag this close to the strip's edge pans the view

const secs = (t: number) => `${t.toFixed(2)} s`
const zoomText = (z: number) => `${z >= 10 ? Math.round(z) : Math.round(z * 10) / 10}×`

export function SourceStrip({ folder, assetId, duration, selection, minLength, muted, onChange, playhead = null, onSeek }: {
  folder: string
  assetId: string
  /** The media file's length (s). */
  duration: number
  selection: SourceSelection
  minLength: number
  muted: boolean
  onChange: (selection: SourceSelection) => void
  /** The preview's position in the source (s), drawn as a line; null for none. */
  playhead?: number | null
  /** Scrubbing on the ruler row: the source time under the pointer. */
  onSeek?: (t: number) => void
}) {
  const { status, peaks } = useAssetPeaksState(folder, assetId, true)
  const { resolvedTheme } = useTheme()
  const root = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [view, setView] = useState<Viewport>(() => fullViewport(duration))
  const [drag, setDrag] = useState<{ mode: SourceDragMode; x: number; from: SourceSelection; viewStart: number; snapping: boolean } | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const [pan, setPan] = useState<{ x: number; start: number; scale: number } | null>(null)
  const zoom = zoomOf(view, duration)
  const zoomed = zoom > 1 + 1e-9
  const deepest = maxZoom(duration)

  // A selection that moved out of view (typed In or Out, a preset) brings the view to it.
  const [seen, setSeen] = useState(selection)
  if (!drag && (seen.in !== selection.in || seen.out !== selection.out)) {
    setSeen(selection)
    const end = view.start + view.span
    if (selection.out <= view.start || selection.in >= end) {
      const c = (selection.in + selection.out) / 2
      setView(clampViewport({ start: c - view.span / 2, span: view.span }, duration))
    }
  }

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // The visible part's bars: on size, peaks, view, mute or theme (never on the selection).
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
      // One bar per peak once a peak is wider than two pixels.
      const step = Math.min(12, Math.max(2, Math.floor(width / (view.span * peaks.rate))))
      const bars = waveformBars(peaks.peaks, peaks.rate, view.start, view.start + view.span, width, step)
      const mid = c.height / 2
      const barW = Math.max(1, Math.round(step * dpr) - (step > 3 ? Math.round(dpr) : 1))
      const half = (c.height - 4 * dpr) / 2
      bars.forEach((b, j) => {
        const h = Math.max(dpr / 2, b * half)
        ctx.fillRect(Math.round(j * step * dpr), Math.round(mid - h), barW, Math.max(1, Math.round(2 * h)))
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [peaks, width, view.start, view.span, muted, resolvedTheme])

  const zoomBy = (dir: 1 | -1) => setView(zoomViewport(view, nextZoom(zoom, dir, duration) / zoom, selection, duration))
  const fit = () => setView(fullViewport(duration))

  // Ctrl/Cmd + wheel zooms (on the selection); zoomed, a plain or Shift wheel pans. Not passive, so the dialog doesn't scroll too.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const v = view
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        if (e.deltaY !== 0) zoomBy(e.deltaY < 0 ? 1 : -1)
        return
      }
      if (zoomOf(v, duration) <= 1 + 1e-9) return
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (delta === 0 || !(width > 0)) return
      e.preventDefault()
      setView(panViewport(v, (delta / width) * v.span, duration))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  })

  const x = (t: number) => viewTimeToX(t, view, width)
  const ticks = viewTicks(view, width)
  const sel = { in: Math.min(selection.in, duration), out: Math.min(selection.out, duration) }

  function down(mode: SourceDragMode, e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !(width > 0)) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus({ preventScroll: true })
    setDrag({ mode, x: e.clientX, from: selection, viewStart: view.start, snapping: !e.altKey })
  }

  function move(e: PointerEvent<HTMLDivElement>) {
    if (!drag || !(width > 0)) return
    const snapping = !e.altKey
    if (snapping !== drag.snapping) setDrag({ ...drag, snapping })
    // At the strip's edge the view pans along (a little per move), and the drag follows it.
    let v = view
    // The handles' parent is the clipped strip, the wave plus a handle's width each side.
    const box = e.currentTarget.parentElement?.getBoundingClientRect()
    if (box && zoomOf(v, duration) > 1 + 1e-9) {
      const by = e.clientX < box.left + HANDLE + EDGE_PX ? -1 : e.clientX > box.right - HANDLE - EDGE_PX ? 1 : 0
      if (by) {
        v = panViewport(v, by * v.span * 0.03, duration)
        setView(v)
      }
    }
    const delta = ((e.clientX - drag.x) / width) * v.span + (v.start - drag.viewStart)
    onChange(dragSelection(drag.mode, duration, drag.from, delta, minLength, [0, duration, ...viewTicks(v, width)], snapping, (SNAP_PX / width) * v.span))
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

  function scrub(e: PointerEvent<HTMLDivElement>) {
    onSeek?.(viewXToTime(e.clientX - e.currentTarget.getBoundingClientRect().left, view, width, duration))
  }

  /** Dragging the labels (scale 1: the view follows the pointer) or the overview bar (the window follows it). */
  const panner = (scale: () => number, jump?: (e: PointerEvent<HTMLDivElement>) => number | undefined) => ({
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || !zoomed || !(width > 0)) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      const start = jump?.(e) ?? view.start
      setPan({ x: e.clientX, start, scale: scale() })
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (!pan) return
      setView(clampViewport({ start: pan.start + (e.clientX - pan.x) * pan.scale, span: view.span }, duration))
    },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
      setPan(null)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    },
    onPointerCancel: () => setPan(null),
  })

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
      aria-valuemin={side === "in" ? 0 : Math.min(duration, sel.in + minLength)}
      aria-valuemax={side === "in" ? Math.max(0, sel.out - minLength) : duration}
      aria-valuenow={side === "in" ? sel.in : sel.out}
      aria-valuetext={`${side} ${secs(side === "in" ? sel.in : sel.out)}`}
      data-handle={side}
      className="absolute top-0 z-[3] flex cursor-ew-resize touch-none items-center justify-center rounded-[3px] bg-editor-accent shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none"
      style={{ height: HEIGHT, width: HANDLE, left: side === "in" ? x(sel.in) : x(sel.out) + HANDLE }}
      {...pointer(side)}
    >
      <span aria-hidden className="h-6 w-0.5 rounded-full bg-editor-accent-foreground/90" />
    </div>
  )

  const line = playhead !== null && Number.isFinite(playhead) ? x(playhead) : null
  const zoomButton = "flex size-8 items-center justify-center rounded-md text-foreground/80 outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35"
  const whole = (t: number) => `${Math.min(100, Math.max(0, duration > 0 ? (t / duration) * 100 : 0))}%`

  return (
    <div
      ref={root}
      className="grid gap-1"
      data-source-strip
      data-zoom={Math.round(zoom * 100) / 100}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest("input, textarea")) return
        if (e.key === "+" || e.key === "=") zoomBy(1)
        else if (e.key === "-" || e.key === "_") zoomBy(-1)
        else if (e.key === "0") fit()
        else return
        e.preventDefault()
      }}
    >
      {onSeek && (
        <div
          aria-hidden
          data-scrub
          className="relative cursor-pointer touch-none overflow-hidden rounded-sm bg-muted/60 select-none hover:bg-muted"
          style={{ height: RULER, marginLeft: HANDLE, marginRight: HANDLE }}
          onPointerDown={(e) => {
            if (e.button !== 0 || !(width > 0)) return
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            setScrubbing(true)
            scrub(e)
          }}
          onPointerMove={(e) => scrubbing && scrub(e)}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
            setScrubbing(false)
          }}
          onPointerCancel={() => setScrubbing(false)}
        >
          <div className="pointer-events-none absolute inset-y-0 bg-editor-accent/30" style={{ left: x(sel.in), width: Math.max(1, x(sel.out) - x(sel.in)) }} />
          {line !== null && <div className="pointer-events-none absolute -bottom-0.5 h-0 w-0 -translate-x-1/2 border-x-[5px] border-t-[7px] border-x-transparent border-t-foreground" style={{ left: line }} />}
        </div>
      )}
      <div className="relative select-none" style={{ height: HEIGHT }} onDoubleClick={(e) => !(e.target as HTMLElement).closest("[data-zoom-controls]") && onChange({ in: 0, out: duration })}>
        {/* Everything in the strip is clipped to it, handles included, so a zoomed view shows only its part. */}
        <div className="absolute inset-0 overflow-hidden">
          <div ref={wrap} className="absolute inset-y-0 overflow-hidden rounded-lg bg-muted/60 ring-1 ring-border ring-inset" style={{ left: HANDLE, right: HANDLE }}>
            {status === "ready" && <canvas ref={canvas} aria-hidden className={cn("absolute inset-0 h-full w-full", muted ? "text-muted-foreground" : "text-editor-accent")} />}
            {status === "loading" && <div aria-hidden className="shimmer absolute inset-0" />}
            {status === "failed" && <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Waveform unavailable</p>}
            {ticks.map((t) => (
              <div key={t} aria-hidden className="pointer-events-none absolute bottom-0 h-2 w-px bg-foreground/30" style={{ left: x(t) }} />
            ))}
            {/* Outside the window: dimmed. */}
            <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 bg-background/70" style={{ width: Math.max(0, x(sel.in)) }} />
            <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 bg-background/70" style={{ left: Math.min(width, Math.max(0, x(sel.out))) }} />
            {line !== null && <div aria-hidden data-playhead className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: line }} />}
          </div>
          <div
            role="slider"
            tabIndex={0}
            aria-label="Source window"
            aria-valuemin={0}
            aria-valuemax={Math.max(0, duration - (sel.out - sel.in))}
            aria-valuenow={sel.in}
            aria-valuetext={`${secs(sel.in)} to ${secs(sel.out)}`}
            data-handle="move"
            className={cn(
              "absolute top-0 z-[2] touch-none border-y-2 border-editor-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              drag?.mode === "move" ? "cursor-grabbing" : "cursor-grab"
            )}
            style={{ height: HEIGHT, left: HANDLE + x(sel.in), width: Math.max(1, x(sel.out) - x(sel.in)) }}
            {...pointer("move")}
          />
          {handle("in")}
          {handle("out")}
        </div>
        <div
          role="group"
          aria-label="Waveform zoom"
          data-zoom-controls
          className="absolute top-1.5 z-[4] flex items-center gap-0.5 rounded-lg bg-background/85 p-0.5 shadow-sm ring-1 ring-border backdrop-blur-sm"
          style={{ right: HANDLE + 6 }}
        >
          <button type="button" className={zoomButton} aria-label="Zoom out on waveform" title="Zoom out (−)" disabled={!zoomed} onClick={() => zoomBy(-1)} data-zoom-out>
            <ZoomOut className="size-4" />
          </button>
          <button
            type="button"
            className="h-8 min-w-9 rounded-md px-1 text-[11px] font-semibold tabular-nums text-foreground/80 outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Zoom ${zoomText(zoom)}; fit the whole file`}
            title="Fit the whole file (0)"
            onClick={fit}
            onDoubleClick={fit}
            data-zoom-readout
          >
            {zoomText(zoom)}
          </button>
          <button type="button" className={zoomButton} aria-label="Zoom in on waveform" title="Zoom in (+)" disabled={zoom >= deepest - 1e-9} onClick={() => zoomBy(1)} data-zoom-in>
            <ZoomIn className="size-4" />
          </button>
          <button type="button" className={zoomButton} aria-label="Fit the whole file" title="Fit the whole file (0)" disabled={!zoomed} onClick={fit} data-zoom-fit>
            <Maximize2 className="size-3.5" />
          </button>
        </div>
        {drag && (
          <div aria-hidden className="pointer-events-none absolute -top-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-neutral-900/85 px-2.5 py-0.5 text-[11px] whitespace-nowrap text-white shadow dark:bg-neutral-100/90 dark:text-neutral-900">
            {drag.snapping ? "Hold Alt to turn snapping off" : "Snapping off"}
          </div>
        )}
      </div>
      <div
        aria-hidden
        className={cn("relative h-4 overflow-hidden text-[10px] text-muted-foreground tabular-nums select-none", zoomed && "cursor-grab touch-none active:cursor-grabbing")}
        style={{ marginLeft: HANDLE, marginRight: HANDLE }}
        title={zoomed ? "Drag to move along the file" : undefined}
        data-pan-labels
        {...panner(() => -view.span / Math.max(1, width))}
      >
        <span className="absolute left-0">{formatTimecode(view.start)}</span>
        {ticks.map((t) => (
          <span key={t} className="absolute -translate-x-1/2" style={{ left: x(t) }}>{formatTimecode(t)}</span>
        ))}
        <span className="absolute right-0">{formatTimecode(view.start + view.span)}</span>
      </div>
      {/* The overview: the whole file, the selection on it, and the part the strip shows. */}
      <div
        role="slider"
        tabIndex={zoomed ? 0 : -1}
        aria-label="Visible part of the file"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, duration - view.span)}
        aria-valuenow={Math.round(view.start * 100) / 100}
        aria-valuetext={`${secs(view.start)} to ${secs(view.start + view.span)} of ${secs(duration)}`}
        aria-disabled={!zoomed || undefined}
        data-minimap
        className={cn("relative h-2.5 rounded-full bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring", zoomed ? "cursor-pointer touch-none" : "opacity-60")}
        style={{ marginLeft: HANDLE, marginRight: HANDLE }}
        onKeyDown={(e) => {
          const by = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0
          if (!by || !zoomed) return
          e.preventDefault()
          e.stopPropagation()
          setView(panViewport(view, by * view.span * (e.shiftKey ? 0.5 : 0.1), duration))
        }}
        {...panner(
          () => duration / Math.max(1, width),
          (e) => {
            // A press outside the frame centres it there first.
            const r = e.currentTarget.getBoundingClientRect()
            const t = ((e.clientX - r.left) / r.width) * duration
            if (t >= view.start && t <= view.start + view.span) return undefined
            const next = clampViewport({ start: t - view.span / 2, span: view.span }, duration)
            setView(next)
            return next.start
          }
        )}
      >
        <div aria-hidden className="pointer-events-none absolute inset-y-0 rounded-full bg-editor-accent/45" style={{ left: whole(sel.in), width: `calc(${whole(sel.out)} - ${whole(sel.in)})` }} />
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-y-0.5 rounded-full border-2 border-foreground/55 motion-safe:transition-[left,width] motion-safe:duration-150"
          style={{ left: whole(view.start), width: `calc(${whole(view.start + view.span)} - ${whole(view.start)})`, transitionDuration: pan || drag ? "0ms" : undefined }}
        />
      </div>
    </div>
  )
}
