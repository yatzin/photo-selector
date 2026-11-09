"use client"

import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

// A bar between two panels that sets one's size: drag it, or focus it and use
// the arrow keys (Home/End for the limits). Double-click resets.
// `onResize(px, done)` reports every step of a drag (done = false) and the
// final size (done = true). By default it is a horizontal bar between stacked
// panels and sets the upper one's height; with axis "x" it is a vertical bar
// between side-by-side panels and sets the width of the one `after` it (the
// right one: dragging left makes it wider) or, with `before`, the left one.

const KEY_STEP = 24

export function ResizeHandle({
  label, value, min, max, onResize, onReset, className, axis = "y", sizes = "before",
}: {
  label: string
  /** "y": a bar across, sizing the panel above it. "x": a bar down, sizing the panel `sizes` says. */
  axis?: "x" | "y"
  /** With axis "x": which side's width `value` is. */
  sizes?: "before" | "after"
  /** The sized panel's current size (height, or width with axis "x"), px. */
  value: number
  min: number
  max: number
  onResize: (px: number, done: boolean) => void
  onReset: () => void
  className?: string
}) {
  const stopDrag = useRef<(() => void) | null>(null)
  const clamp = (px: number) => Math.round(Math.max(min, Math.min(max, px)))

  // A drag still running when the editor goes away mustn't leave listeners behind.
  useEffect(() => () => stopDrag.current?.(), [])

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    stopDrag.current?.()
    const startAt = axis === "x" ? e.clientX : e.clientY
    const sign = axis === "x" && sizes === "after" ? -1 : 1
    const start = value
    let last = start
    const onMove = (ev: PointerEvent) => {
      last = clamp(start + sign * ((axis === "x" ? ev.clientX : ev.clientY) - startAt))
      onResize(last, false)
    }
    const stop = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      stopDrag.current = null
    }
    const onUp = () => {
      stop()
      onResize(last, true)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
    stopDrag.current = stop
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const grow = axis === "x" ? (sizes === "after" ? "ArrowLeft" : "ArrowRight") : "ArrowDown"
    const shrink = axis === "x" ? (sizes === "after" ? "ArrowRight" : "ArrowLeft") : "ArrowUp"
    const next = e.key === shrink ? value - KEY_STEP : e.key === grow ? value + KEY_STEP : e.key === "Home" ? min : e.key === "End" ? max : null
    if (next === null) return
    e.preventDefault()
    onResize(clamp(next), true)
  }

  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} (double-click to reset)`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={cn(
        "group relative flex shrink-0 touch-none items-center justify-center bg-border/60 outline-none hover:bg-editor-accent/30 focus-visible:bg-editor-accent/40",
        axis === "x" ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize",
        className
      )}
    >
      <span aria-hidden="true" className={cn("rounded-full bg-muted-foreground/50 group-hover:bg-editor-accent", axis === "x" ? "h-10 w-0.5" : "h-0.5 w-10")} />
    </div>
  )
}
