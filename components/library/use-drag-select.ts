"use client"

import { useEffect, useRef } from "react"
import { dragSelection, edgeScrollSpeed } from "@/lib/drag-select"

// Drag across photos to select the range from where the drag started to
// where the pointer is (photos never move). Mouse: press and drag. Touch:
// press and hold until the photo selects, then drag; a quick swipe still
// scrolls. Dragging near the top or bottom edge scrolls the grid. Starting on
// a selected photo deselects the range instead.

const MOUSE_SLOP = 6
const TOUCH_SLOP = 10
const LONG_PRESS_MS = 450

type Options = {
  grid: () => HTMLElement | null
  scrollEl: HTMLElement | null
  /** The photo index at (x, y) from the grid's top-left, or -1 (e.g. over a month header). */
  hit: (x: number, y: number) => number
  names: string[]
  selected: Set<string>
  /** Called with the new selection, the photo under the pointer, and the one the drag started on. */
  apply: (next: Set<string>, current: string, start: string) => void
}

type Drag = {
  phase: "pending" | "dragging"
  pointerId: number
  touch: boolean
  startX: number
  startY: number
  start: number
  last: number
  x: number
  y: number
  mode: "add" | "remove"
  base: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  frame: number | null
}

export function useDragSelect(options: Options) {
  // Handlers outlive renders; they always read the latest options.
  const opts = useRef(options)
  useEffect(() => {
    opts.current = options
  })
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const cleanup = useRef<() => void>(() => {})

  useEffect(() => () => cleanup.current(), [])

  function indexAtPointer(d: Drag): number {
    const { grid, hit } = opts.current
    const el = grid()
    if (!el) return -1
    const r = el.getBoundingClientRect()
    return hit(d.x - r.left, d.y - r.top)
  }

  function update(d: Drag) {
    const index = indexAtPointer(d)
    if (index < 0 || index === d.last) return
    d.last = index
    const { names, apply } = opts.current
    apply(dragSelection(d.base, names, d.start, index, d.mode), names[index], names[d.start])
  }

  function autoScroll() {
    const d = drag.current
    if (!d || d.phase !== "dragging") return
    const el = opts.current.scrollEl
    if (el) {
      const r = el.getBoundingClientRect()
      const speed = edgeScrollSpeed(d.y, Math.max(0, r.top), Math.min(window.innerHeight, r.bottom))
      if (speed) {
        el.scrollBy(0, speed)
        update(d)
      }
    }
    d.frame = requestAnimationFrame(autoScroll)
  }

  function begin(d: Drag) {
    d.phase = "dragging"
    const { names, selected } = opts.current
    d.base = new Set(selected)
    d.mode = selected.has(names[d.start]) ? "remove" : "add"
    d.last = -1
    update(d)
    suppressClick.current = true
    if (d.touch) navigator.vibrate?.(8)
    d.frame = requestAnimationFrame(autoScroll)
  }

  function end() {
    const d = drag.current
    if (!d) return
    if (d.timer) clearTimeout(d.timer)
    if (d.frame !== null) cancelAnimationFrame(d.frame)
    const dragged = d.phase === "dragging"
    drag.current = null
    cleanup.current()
    // The click that follows the pointerup must not toggle a photo.
    if (dragged) setTimeout(() => (suppressClick.current = false), 0)
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || drag.current) return
    if ((e.target as HTMLElement).closest("button")) return // the select circle keeps its own tap
    const touch = e.pointerType !== "mouse"
    const d: Drag = {
      phase: "pending", pointerId: e.pointerId, touch, startX: e.clientX, startY: e.clientY,
      start: -1, last: -1, x: e.clientX, y: e.clientY, mode: "add", base: new Set(), timer: null, frame: null,
    }
    d.start = indexAtPointer(d)
    if (d.start < 0) return
    if (!touch) e.preventDefault() // no text selection while dragging
    drag.current = d
    if (touch) d.timer = setTimeout(() => drag.current === d && begin(d), LONG_PRESS_MS)

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== d.pointerId) return
      d.x = ev.clientX
      d.y = ev.clientY
      if (d.phase === "pending") {
        const moved = Math.hypot(d.x - d.startX, d.y - d.startY)
        if (d.touch && moved > TOUCH_SLOP) end() // a swipe: let the page scroll
        else if (!d.touch && moved > MOUSE_SLOP) begin(d)
      } else {
        update(d)
      }
    }
    const up = (ev: PointerEvent) => ev.pointerId === d.pointerId && end()
    // While a touch drag is on, the finger selects instead of scrolling.
    const blockScroll = (ev: TouchEvent) => drag.current?.phase === "dragging" && ev.preventDefault()
    const noMenu = (ev: Event) => drag.current && ev.preventDefault()
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
    window.addEventListener("touchmove", blockScroll, { passive: false })
    window.addEventListener("contextmenu", noMenu)
    cleanup.current = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
      window.removeEventListener("touchmove", blockScroll)
      window.removeEventListener("contextmenu", noMenu)
      cleanup.current = () => {}
    }
  }

  function onClickCapture(e: React.MouseEvent) {
    if (!suppressClick.current) return
    suppressClick.current = false
    e.stopPropagation()
    e.preventDefault()
  }

  return { onPointerDown, onClickCapture }
}
