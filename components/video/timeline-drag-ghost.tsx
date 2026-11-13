"use client"

import { useEffect, useLayoutEffect, useRef } from "react"
import { addCountBadge, buildDragPicture } from "@/lib/drag-picture"

// While a clip (or a linked group) is dragged along the timeline it stays in
// place, dimmed, with the landing spot marked; this smaller, opaque copy of it
// follows the pointer at its bottom right, out of the way. At the window's right
// or bottom edge, where it would fall off, it hops to the pointer's other side.

const GAP = 14
const EDGE = 4

export function TimelineDragGhost({ id, count, x, y }: { id: string; count: number; x: number; y: number }) {
  const picture = useRef<{ root: HTMLDivElement; w: number; h: number } | null>(null)

  // The pointer stays an ordinary arrow with a small box and plus (like dragging from Project media), not a grabbing hand (globals.css).
  useEffect(() => {
    document.documentElement.setAttribute("data-clip-dragging", "")
    return () => document.documentElement.removeAttribute("data-clip-dragging")
  }, [])

  useEffect(() => {
    const el = document.querySelector<HTMLElement>(`[data-clip-id="${CSS.escape(id)}"]`)
    const made = el ? buildDragPicture(el) : null
    if (!made) return
    made.root.style.position = "fixed"
    made.root.style.top = "0"
    made.root.style.left = "0"
    made.root.style.zIndex = "2147483647"
    made.root.style.pointerEvents = "none"
    if (count > 1) addCountBadge(made.root, count)
    document.body.appendChild(made.root)
    picture.current = made
    return () => {
      made.root.remove()
      picture.current = null
    }
  }, [id, count])

  // Follows the pointer: below and right of it, or above and left where that would leave the window.
  useLayoutEffect(() => {
    const p = picture.current
    if (!p) return
    const left = x + GAP + p.w > window.innerWidth - EDGE ? x - GAP - p.w : x + GAP
    const top = y + GAP + p.h > window.innerHeight - EDGE ? y - GAP - p.h : y + GAP
    p.root.style.transform = `translate3d(${Math.max(EDGE, left)}px, ${Math.max(EDGE, top)}px, 0)`
  }, [x, y, id, count])

  return null
}
