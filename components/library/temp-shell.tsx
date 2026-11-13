"use client"

import { useState } from "react"
import { useStoredValue } from "@/lib/hooks/use-stored-state"
import { ResizeHandle } from "@/components/video/resize-handle"

// A Personal Storage folder page with its folder navigation on the left and a
// grip line between them: drag it (or focus it and use the arrow keys) to set
// how wide the navigation is; double-click resets. The width is kept in this
// browser. Below the lg breakpoint the navigation is hidden.

const DEFAULT_WIDTH = 260
const MIN_WIDTH = 160
const MAX_WIDTH = 560

export function TempShell({ nav, children }: { nav: React.ReactNode; children: React.ReactNode }) {
  const [stored, setStored] = useStoredValue("ps.tempNavWidth")
  // While the grip is held the width follows it; only the final width is stored.
  const [dragging, setDragging] = useState<number | null>(null)
  const saved = Number(stored)
  const width = dragging ?? (Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : DEFAULT_WIDTH)

  return (
    <div className="flex items-start gap-3">
      <aside className="sticky top-0 hidden max-h-[calc(100svh-9rem)] shrink-0 overflow-x-hidden overflow-y-auto lg:block" style={{ width }}>
        {nav}
      </aside>
      <ResizeHandle
        axis="x"
        sizes="before"
        label="Folder list width"
        value={width}
        min={MIN_WIDTH}
        max={MAX_WIDTH}
        onResize={(px, done) => {
          if (done) {
            setStored(String(px))
            setDragging(null)
          } else setDragging(px)
        }}
        onReset={() => {
          setStored(String(DEFAULT_WIDTH))
          setDragging(null)
        }}
        className="hidden self-stretch rounded-full lg:flex"
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
