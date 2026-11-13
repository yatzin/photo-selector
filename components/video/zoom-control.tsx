"use client"

import { useState } from "react"
import { ZoomIn, ZoomOut } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MAX_SCALE, MIN_SCALE, parseZoomPercent, zoomedScale } from "@/lib/video/transform"

// The toolbar's zoom for the selected picture: zoom out, a typed percent (100 =
// fit the frame), zoom in. Enter or leaving the field applies what was typed;
// Esc puts the current value back; Up and Down step.

export function ZoomControl({ scale, onChange }: { scale: number; onChange: (scale: number) => void }) {
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? String(Math.round(scale * 100))
  const apply = () => {
    const v = text === null ? null : parseZoomPercent(text)
    setText(null)
    if (v !== null && Math.abs(v - scale) > 1e-9) onChange(v)
  }
  return (
    <div role="group" aria-label="Zoom" className="flex shrink-0 items-center gap-0.5">
      <Button type="button" size="icon-sm" variant="ghost" disabled={scale <= MIN_SCALE} onClick={() => onChange(zoomedScale(scale, -1))} title="Zoom out" aria-label="Zoom out">
        <ZoomOut className="h-4 w-4" />
      </Button>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          aria-label="Zoom percent"
          title="Zoom % (100 fits the frame)"
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
              onChange(zoomedScale(scale, e.key === "ArrowUp" ? 1 : -1))
            }
          }}
          className="h-7 w-14 rounded-md border border-input bg-card pl-1.5 pr-4 text-right text-xs tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span aria-hidden className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
      </div>
      <Button type="button" size="icon-sm" variant="ghost" disabled={scale >= MAX_SCALE} onClick={() => onChange(zoomedScale(scale, 1))} title="Zoom in" aria-label="Zoom in">
        <ZoomIn className="h-4 w-4" />
      </Button>
    </div>
  )
}
