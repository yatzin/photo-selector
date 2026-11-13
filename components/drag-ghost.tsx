"use client"

import { useEffect } from "react"
import { DRAG_BADGE_EVENT } from "@/lib/drag-ghost"
import { addCountBadge, buildDragPicture } from "@/lib/drag-picture"

// The picture that rides along while anything on the site is dragged (a photo,
// a folder row, a stock result, a media item...): a smaller copy of the dragged
// element, drawn by the browser itself at the pointer's bottom right, out of
// the way, instead of the full-size picture under it. The browser draws and
// moves it, so it follows the pointer smoothly; it can't be moved while the drag
// runs, so it doesn't hop to the other side at the window's edges. A drag that
// carries several items (a source says so with DRAG_BADGE_EVENT) shows their count.

const GAP = 14

export function DragGhost() {
  useEffect(() => {
    let picture: HTMLDivElement | null = null

    const drop = () => {
      picture?.remove()
      picture = null
    }

    const onStart = (e: DragEvent) => {
      drop()
      const el = e.target
      if (!(el instanceof HTMLElement) || !e.dataTransfer) return // a dragged text selection keeps the browser's picture
      const made = buildDragPicture(el)
      if (!made) return
      // Off screen but rendered: the browser snapshots it when the drag starts.
      picture = made.root
      picture.style.cssText += ";position:fixed;top:-2000px;left:0"
      document.body.appendChild(picture)
      // The picture's top left is placed GAP right of and below the pointer.
      e.dataTransfer.setDragImage(picture, -GAP, -GAP)
      // Taken down once the browser has its snapshot (after this event, and the badge below).
      setTimeout(drop, 0)
    }

    const onBadge = (e: Event) => {
      const n = (e as CustomEvent<number>).detail
      if (!picture || !(n > 1)) return
      addCountBadge(picture, n)
    }

    window.addEventListener("dragstart", onStart, true)
    window.addEventListener(DRAG_BADGE_EVENT, onBadge)
    return () => {
      window.removeEventListener("dragstart", onStart, true)
      window.removeEventListener(DRAG_BADGE_EVENT, onBadge)
      drop()
    }
  }, [])

  return null
}
