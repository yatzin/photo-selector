"use client"

import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

// A horizontal bar between two stacked panels that sets the upper one's height:
// drag it, or focus it and use the arrow keys (Home/End for the limits).
// Double-click resets. `onResize(px, done)` reports every step of a drag
// (done = false) and the final height (done = true).

const KEY_STEP = 24

export function ResizeHandle({
  label, value, min, max, onResize, onReset, className,
}: {
  label: string
  /** The upper panel's current height, px. */
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
    const startY = e.clientY
    const start = value
    let last = start
    const onMove = (ev: PointerEvent) => {
      last = clamp(start + ev.clientY - startY)
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
    const next =
      e.key === "ArrowUp" ? value - KEY_STEP : e.key === "ArrowDown" ? value + KEY_STEP : e.key === "Home" ? min : e.key === "End" ? max : null
    if (next === null) return
    e.preventDefault()
    onResize(clamp(next), true)
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
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
        "group relative flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center bg-border/60 outline-none hover:bg-editor-accent/30 focus-visible:bg-editor-accent/40",
        className
      )}
    >
      <span aria-hidden="true" className="h-0.5 w-10 rounded-full bg-muted-foreground/50 group-hover:bg-editor-accent" />
    </div>
  )
}
