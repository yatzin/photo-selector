"use client"

import { useState } from "react"
import { Maximize, ZoomIn, ZoomOut } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MAX_VIEW_ZOOM, MIN_VIEW_ZOOM, parseViewZoom, stepViewZoom } from "@/lib/video/viewer-zoom"

// The scene viewer's zoom, a column at its right: zoom in, a typed percent
// (100 = the canvas fit in the viewer), zoom out, and Fit. Enter or leaving
// the field applies what was typed; Esc puts the current value back.

export function ViewerZoomControl({ zoom, onChange }: { zoom: number; onChange: (zoom: number) => void }) {
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? String(Math.round(zoom * 100))
  const apply = () => {
    const v = text === null ? null : parseViewZoom(text)
    setText(null)
    if (v !== null && Math.abs(v - zoom) > 1e-9) onChange(v)
  }
  return (
    <div role="group" aria-label="Viewer zoom" className="flex w-14 shrink-0 flex-col items-center gap-1 self-center">
      <Button type="button" size="icon-sm" variant="ghost" disabled={zoom >= MAX_VIEW_ZOOM} onClick={() => onChange(stepViewZoom(zoom, 1))} title="Zoom in" aria-label="Zoom viewer in">
        <ZoomIn className="h-4 w-4" />
      </Button>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          aria-label="Viewer zoom percent"
          title="Viewer zoom % (100 fits the viewer; the mouse wheel zooms too)"
          value={shown}
          onChange={(e) => setText(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={apply}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              apply()
            } else if (e.key === "Escape") {
              e.preventDefault()
              e.stopPropagation()
              setText(null)
              e.currentTarget.blur()
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault()
              setText(null)
              onChange(stepViewZoom(zoom, e.key === "ArrowUp" ? 1 : -1))
            }
          }}
          className="h-7 w-12 rounded-md border border-input bg-card pl-1 pr-3.5 text-right text-xs tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span aria-hidden className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
      </div>
      <Button type="button" size="icon-sm" variant="ghost" disabled={zoom <= MIN_VIEW_ZOOM} onClick={() => onChange(stepViewZoom(zoom, -1))} title="Zoom out" aria-label="Zoom viewer out">
        <ZoomOut className="h-4 w-4" />
      </Button>
      <Button type="button" size="icon-sm" variant="ghost" disabled={zoom === 1} onClick={() => onChange(1)} title="Fit the canvas in the viewer" aria-label="Fit viewer">
        <Maximize className="h-4 w-4" />
      </Button>
    </div>
  )
}
