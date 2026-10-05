"use client"

import { useEffect, useRef } from "react"
import { FolderOutput, ImageOff, RotateCcw, RotateCw, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"

// Right-click menu for photos in the grid. It acts on the selection when the
// clicked photo is part of it, otherwise on just that photo.

export type PhotoMenuAction = "rotate-ccw" | "rotate-cw" | "move" | "delete" | "bad-photos"

export function PhotoMenu({
  x, y, count, canRotate, showMove, canMove, canEdit, showBadPhotos = false, onAction, onClose,
}: {
  x: number
  y: number
  /** How many photos the menu acts on. */
  count: number
  canRotate: boolean
  /** Only photos in Mobile Upload can be moved to Dropoff. */
  showMove: boolean
  canMove: boolean
  canEdit: boolean
  /** The clicked photo was flagged by Quality Checks: link to that review. */
  showBadPhotos?: boolean
  onAction: (action: PhotoMenuAction) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: Event) => {
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return
      if (e.type === "pointerdown" && ref.current?.contains(e.target as Node)) return
      onClose()
    }
    window.addEventListener("pointerdown", close, true)
    window.addEventListener("keydown", close, true)
    window.addEventListener("resize", close)
    window.addEventListener("scroll", close, true)
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
    return () => {
      window.removeEventListener("pointerdown", close, true)
      window.removeEventListener("keydown", close, true)
      window.removeEventListener("resize", close)
      window.removeEventListener("scroll", close, true)
    }
  }, [onClose])

  // Keep the menu on screen near the pointer.
  const W = showBadPhotos ? 260 : 210
  const H = showBadPhotos ? 220 : 180
  const left = Math.min(x, window.innerWidth - W - 8)
  const top = Math.min(y, window.innerHeight - H - 8)
  const n = count > 1 ? ` ${count}` : ""

  const item = (action: PhotoMenuAction, label: string, icon: React.ReactNode, enabled: boolean, danger = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={!enabled}
      onClick={() => {
        onClose()
        onAction(action)
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none",
        "hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-40",
        danger && "text-destructive"
      )}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Photo actions"
      className="fixed z-50 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left, top, width: W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {item("rotate-ccw", `Rotate left${n}`, <RotateCcw className="h-4 w-4" />, canEdit && canRotate)}
      {item("rotate-cw", `Rotate right${n}`, <RotateCw className="h-4 w-4" />, canEdit && canRotate)}
      {showMove && item("move", `Move${n} to Dropoff`, <FolderOutput className="h-4 w-4" />, canMove)}
      <div className="my-1 h-px bg-border" />
      {item("delete", `Delete${n}`, <Trash2 className="h-4 w-4" />, canEdit, true)}
      {showBadPhotos && (
        <>
          <div className="my-1 h-px bg-border" />
          {item("bad-photos", "See all bad images in this folder", <ImageOff className="h-4 w-4 text-red-600 dark:text-red-400" />, true)}
        </>
      )}
    </div>
  )
}
