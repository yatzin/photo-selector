"use client"

import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import {
  clipRect, dragCorner, dragEdge, dragMove, scaleAbout, snapCorner, snapEdge, snapToCanvas, type Corner, type Edge, type Guides, type Transform,
} from "@/lib/video/transform"

// The layer over the preview canvas that edits where a clip's picture sits.
// A press on the canvas selects the topmost clip under the pointer (and drags
// it); empty canvas clears the selection. The selected clip gets a frame
// around its visible strip: drag the body to move it, a corner to scale it
// about the opposite corner (aspect locked), an edge's middle handle (top,
// bottom, left, right) to crop that side. A drag shows a draft (onDraft) and
// commits once on release; Esc cancels it. Edges and centres snap to the
// canvas centre lines and edges, each line drawn while snapped; holding Alt
// (pressed or released mid-drag too) turns snapping off, and onGesture tells
// the preview so its hint can say so. A focused handle takes the arrow keys
// too (1%, Shift 5%).

const DRAG_THRESHOLD = 3 // screen px before a press becomes a drag
const SNAP_PX = 6 // screen px within which an edge or centre snaps to the canvas's
const MIN_SIDE_FOR_MIDDLE = 48 // screen px: a shorter side hides its middle crop handle, which would crowd the corners

export type TransformTarget = { id: string; label: string; aspect: number; transform: Transform }

type Gesture = { kind: "move" } | { kind: "corner"; corner: Corner } | { kind: "edge"; edge: Edge }

/** A canvas drag in progress, for the preview's hint: whether snapping is on (Alt held turns it off). */
export type GestureState = { snapping: boolean } | null

const CORNERS: { corner: Corner; label: string; cursor: string; left: string; top: string }[] = [
  { corner: "tl", label: "Resize from top left", cursor: "cursor-nwse-resize", left: "0%", top: "0%" },
  { corner: "tr", label: "Resize from top right", cursor: "cursor-nesw-resize", left: "100%", top: "0%" },
  { corner: "bl", label: "Resize from bottom left", cursor: "cursor-nesw-resize", left: "0%", top: "100%" },
  { corner: "br", label: "Resize from bottom right", cursor: "cursor-nwse-resize", left: "100%", top: "100%" },
]
const EDGES: { edge: Edge; label: string; left: string; top: string }[] = [
  { edge: "top", label: "Crop from top", left: "50%", top: "0%" },
  { edge: "bottom", label: "Crop from bottom", left: "50%", top: "100%" },
  { edge: "left", label: "Crop from left", left: "0%", top: "50%" },
  { edge: "right", label: "Crop from right", left: "100%", top: "50%" },
]
const isSide = (edge: Edge) => edge === "left" || edge === "right"

const pct = (v: number, of: number) => `${(v / of) * 100}%`

export function TransformOverlay({
  width: W, height: H, displayWidth, selected, hitTest, onSelect, onDraft, onCommit, onGesture,
}: {
  /** The canvas (project) size in px; the overlay covers the canvas on screen. */
  width: number
  height: number
  /** The canvas's width on screen (px), when measured: a frame side shorter than MIN_SIDE_FOR_MIDDLE there hides its middle handle. */
  displayWidth?: number
  /** The selected clip when it's showing at the playhead, with its transform as shown (a draft while dragging). */
  selected: TransformTarget | null
  /** The topmost clip whose visible strip holds this canvas point, or null. */
  hitTest: (x: number, y: number) => TransformTarget | null
  onSelect: (id: string | null) => void
  /** A drag's live transform (null: none). */
  onDraft: (draft: { id: string; transform: Transform } | null) => void
  /** One undo step: `group` merges quick repeats (keyboard steps). */
  onCommit: (id: string, transform: Transform, group?: string) => void
  /** A drag started moving or Alt changed during it ({ snapping }), or it ended (null). */
  onGesture?: (state: GestureState) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const stopGesture = useRef<(() => void) | null>(null)
  const [guides, setGuides] = useState<Guides | null>(null)

  // A drag still running when the preview unmounts mustn't leave its listeners behind.
  useEffect(() => () => stopGesture.current?.(), [])

  /** Canvas px per screen px (the canvas keeps the project's aspect, so one factor serves both axes). */
  function canvasScale(): number {
    const r = root.current?.getBoundingClientRect()
    return r && r.width > 0 ? W / r.width : 1
  }

  function toCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const r = root.current?.getBoundingClientRect()
    if (!r || !(r.width > 0) || !(r.height > 0)) return { x: -1, y: -1 }
    return { x: ((clientX - r.left) / r.width) * W, y: ((clientY - r.top) / r.height) * H }
  }

  /**
   * One pointer drag on `target`. Everything it needs is taken now (the start
   * transform, the canvas scale), so later renders can't hand it stale values;
   * the result goes out through onDraft and, on release, onCommit. A press
   * that never moves is a click: `onClick` runs instead.
   */
  function startGesture(e: React.PointerEvent, target: TransformTarget, gesture: Gesture, onClick?: (e: PointerEvent) => void) {
    stopGesture.current?.()
    const k = canvasScale()
    const { id, aspect, transform: t0 } = target
    const sx = e.clientX
    const sy = e.clientY
    const pointerId = e.pointerId
    let moved = false
    let current: Transform | null = null
    // The pointer's last position and Alt, so Alt pressed or released mid-drag redoes the frame without a pointer move.
    let lastX = sx
    let lastY = sy
    let alt = e.altKey

    const update = () => {
      const dxs = lastX - sx
      const dys = lastY - sy
      if (!moved && Math.hypot(dxs, dys) < DRAG_THRESHOLD) return
      moved = true
      const dx = dxs * k
      const dy = dys * k
      const snap = !alt
      const threshold = SNAP_PX * k
      let t: Transform
      let g: Guides | null = null
      if (gesture.kind === "move") {
        t = dragMove(t0, dx / W, dy / H)
        if (snap) {
          const s = snapToCanvas(clipRect(aspect, W, H, t).visible, W, H, threshold)
          t = dragMove(t, s.dx / W, s.dy / H)
          g = s.guides
        }
      } else if (gesture.kind === "corner") {
        t = dragCorner(t0, gesture.corner, aspect, W, H, dx, dy, { anchor: "opposite" })
        if (snap) ({ t, guides: g } = snapCorner(t0, gesture.corner, aspect, W, H, t, threshold))
      } else {
        const d = isSide(gesture.edge) ? dx : dy
        if (snap) ({ t, guides: g } = snapEdge(t0, gesture.edge, aspect, W, H, d, threshold))
        else t = dragEdge(t0, gesture.edge, aspect, W, H, d)
      }
      current = t
      onDraft({ id, transform: t })
      setGuides(g)
      onGesture?.({ snapping: snap })
    }
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      lastX = ev.clientX
      lastY = ev.clientY
      alt = ev.altKey
      update()
    }
    const finish = (commit: boolean, ev?: PointerEvent) => {
      stop()
      onDraft(null)
      setGuides(null)
      if (moved) onGesture?.(null)
      if (commit && moved && current) onCommit(id, current)
      else if (commit && !moved && ev) onClick?.(ev)
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(true, ev)
    }
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(false)
    }
    // Capture phase, so the editor's own Esc (clear the selection) sees it handled.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Alt") {
        // Alt is the drag's snapping switch here, not the browser's menu key.
        ev.preventDefault()
        const down = ev.type === "keydown"
        if (down === alt) return
        alt = down
        update()
        return
      }
      if (ev.key !== "Escape" || ev.type !== "keydown") return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    const stop = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("keyup", onKey, true)
      if (stopGesture.current === stop) stopGesture.current = null
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("keyup", onKey, true)
    stopGesture.current = stop
  }

  /** Selects what's under a click on the canvas: the topmost clip there, or nothing. */
  function selectAt(clientX: number, clientY: number) {
    const p = toCanvas(clientX, clientY)
    onSelect(hitTest(p.x, p.y)?.id ?? null)
  }

  /** A press on the canvas outside the frame: select the topmost clip there and drag it, or clear the selection. */
  function pressCanvas(e: React.PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    const p = toCanvas(e.clientX, e.clientY)
    const hit = hitTest(p.x, p.y)
    onSelect(hit?.id ?? null)
    if (hit) startGesture(e, hit, { kind: "move" })
  }

  /** A press inside the frame moves the selected clip (even under a higher layer); a click there picks the topmost clip. */
  function pressFrame(e: React.PointerEvent) {
    if (e.button !== 0 || !selected) return
    e.preventDefault()
    e.stopPropagation()
    startGesture(e, selected, { kind: "move" }, (ev) => selectAt(ev.clientX, ev.clientY))
  }

  function pressHandle(e: React.PointerEvent, gesture: Gesture) {
    if (e.button !== 0 || !selected) return
    e.preventDefault()
    e.stopPropagation()
    startGesture(e, selected, gesture)
  }

  /**
   * Arrow keys on a focused handle: a corner scales by 1% (Shift 5%), up and
   * right grow; the top or bottom handle moves its edge by 1% of the height
   * (up, down), the left or right handle by 1% of the width (left, right).
   */
  function handleKey(e: React.KeyboardEvent, gesture: Gesture) {
    if (!selected || e.altKey || e.ctrlKey || e.metaKey) return
    const up = e.key === "ArrowUp" || e.key === "ArrowRight"
    const down = e.key === "ArrowDown" || e.key === "ArrowLeft"
    if (!up && !down) return
    e.preventDefault()
    e.stopPropagation()
    const { id, aspect, transform: t0 } = selected
    const step = e.shiftKey ? 0.05 : 0.01
    let t: Transform
    if (gesture.kind === "corner") {
      t = scaleAbout(t0, aspect, W, H, gesture.corner, up ? 1 + step : 1 - step)
    } else if (gesture.kind === "edge") {
      const r = clipRect(aspect, W, H, t0)
      if (isSide(gesture.edge)) {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
        t = dragEdge(t0, gesture.edge, aspect, W, H, (e.key === "ArrowRight" ? 1 : -1) * step * r.w)
      } else {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
        t = dragEdge(t0, gesture.edge, aspect, W, H, (e.key === "ArrowDown" ? 1 : -1) * step * r.h)
      }
    } else return
    onCommit(id, t, `transform-key-${id}`)
  }

  const v = selected ? clipRect(selected.aspect, W, H, selected.transform).visible : null
  // Screen px per canvas px; unknown (not measured yet) shows every handle.
  const px = displayWidth && displayWidth > 0 ? displayWidth / W : null
  const showEdge = (edge: Edge) => !v || px === null || (isSide(edge) ? v.h : v.w) * px >= MIN_SIDE_FOR_MIDDLE

  return (
    <div ref={root} className="absolute inset-0 touch-none" onPointerDown={pressCanvas}>
      {/* 2 px, centred on the line: a centred 1 px line often straddles two device pixels and blurs to half strength, faint over a picture. */}
      {guides?.x.map((x) => (
        <div key={`x${x}`} aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-fuchsia-400" style={{ left: pct(x, W) }} />
      ))}
      {guides?.y.map((y) => (
        <div key={`y${y}`} aria-hidden className="pointer-events-none absolute inset-x-0 h-0.5 -translate-y-1/2 bg-fuchsia-400" style={{ top: pct(y, H) }} />
      ))}
      {selected && v && (
        <div
          role="group"
          aria-label={`${selected.label}: drag to move, arrow keys nudge`}
          // Sky with a dark halo inside and out: it reads on the black canvas and on the light gray around it.
          className="absolute cursor-move touch-none shadow-[0_0_0_3px_rgb(0_0_0/0.5),inset_0_0_0_1px_rgb(0_0_0/0.5)] outline outline-2 outline-sky-400"
          style={{ left: pct(v.x, W), top: pct(v.y, H), width: pct(v.w, W), height: pct(v.h, H) }}
          onPointerDown={pressFrame}
        >
          {CORNERS.map((c) => (
            <button
              key={c.corner}
              type="button"
              aria-label={c.label}
              title={c.label}
              className={cn("absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", c.cursor)}
              style={{ left: c.left, top: c.top }}
              onPointerDown={(e) => pressHandle(e, { kind: "corner", corner: c.corner })}
              onKeyDown={(e) => handleKey(e, { kind: "corner", corner: c.corner })}
            >
              <span className="h-2.5 w-2.5 rounded-[2px] border border-neutral-900 bg-white shadow-[0_0_0_1px_rgb(255_255_255/0.6)]" />
            </button>
          ))}
          {EDGES.filter((d) => showEdge(d.edge)).map((d) => (
            <button
              key={d.edge}
              type="button"
              aria-label={d.label}
              title={d.label}
              className={cn(
                "absolute flex -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isSide(d.edge) ? "h-6 w-5 cursor-ew-resize" : "h-5 w-6 cursor-ns-resize"
              )}
              style={{ left: d.left, top: d.top }}
              onPointerDown={(e) => pressHandle(e, { kind: "edge", edge: d.edge })}
              onKeyDown={(e) => handleKey(e, { kind: "edge", edge: d.edge })}
            >
              <span className={cn("rounded-full border border-neutral-900 bg-white shadow-[0_0_0_1px_rgb(255_255_255/0.6)]", isSide(d.edge) ? "h-4 w-1.5" : "h-1.5 w-4")} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
