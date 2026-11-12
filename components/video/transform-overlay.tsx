"use client"

import { useEffect, useRef, useState } from "react"
import { FlipHorizontal2, FlipVertical2, Maximize2, RotateCw } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  angleFrom, clipRect, containsPoint, contentCentre, dragCorner, dragEdge, dragMove, IDENTITY, isIdentity, normalizeAngle, rotatedBounds, rotatedCorners, rotatePoint, rotationOf, scaleAbout, snapAngle,
  snapCorner, snapEdge, snapToCanvas, toggleFlip, toLocal, withRotation, type Content, type Corner, type Edge, type Guides, type Transform,
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
// too (1%, Shift 5%). The frame and its handles turn with a rotated clip, and
// drags on them work in the clip's own axes (a rotated clip's move snaps its
// bounding box; its corner and crop drags don't snap). Floating white buttons
// sit outside the frame: Rotate at the top right (drag round the centre,
// 15 degree steps unless Alt is held, double-click for 0, arrows 1 degree,
// Shift 15) and the two flips at the top left (each click one undo step).
// A double-click on a clip (the selected one first, else the topmost there)
// goes to onDoubleClickClip.

const DRAG_THRESHOLD = 3 // screen px before a press becomes a drag
const SNAP_PX = 6 // screen px within which an edge or centre snaps to the canvas's
const MIN_SIDE_FOR_MIDDLE = 48 // screen px: a shorter side hides its middle crop handle, which would crowd the corners
const FLOAT_OFFSET = 22 // screen px out from a frame corner, along the frame's own axes, to a floating button's centre
const FLOAT_SIZE = 24 // screen px, a floating button's diameter

/** `aspect`: the picture's aspect, or a text's content box (lib/video/transform's Content). */
export type TransformTarget = {
  id: string
  label: string
  aspect: Content
  transform: Transform
  /** A picture clip (not text): it can be sent back to filling the frame. */
  canFill?: boolean
}

type Gesture = { kind: "move" } | { kind: "corner"; corner: Corner } | { kind: "edge"; edge: Edge } | { kind: "rotate" }

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
  width: W, height: H, displayWidth, room, selected, hitTest, onSelect, onDraft, onCommit, onGesture, onDoubleClickClip,
}: {
  /** The canvas (project) size in px; the overlay covers the canvas on screen. */
  width: number
  height: number
  /** The canvas's width on screen (px), when measured: a frame side shorter than MIN_SIDE_FOR_MIDDLE there hides its middle handle. */
  displayWidth?: number
  /** Screen px visible around the canvas on each side (x: left and right, y: top and bottom): the floating buttons stay inside it. */
  room?: { x: number; y: number }
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
  /** A double-click on a clip's picture (not on a handle or button). */
  onDoubleClickClip?: (id: string) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const stopGesture = useRef<(() => void) | null>(null)
  const [guides, setGuides] = useState<Guides | null>(null)
  // The angle while the rotate handle is dragged (degrees), for the readout by it.
  const [angle, setAngle] = useState<number | null>(null)

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
    const rot0 = rotationOf(t0)
    const sx = e.clientX
    const sy = e.clientY
    // The rotate handle turns the clip about its content centre by the pointer's angle round it since the press.
    const pivot = contentCentre(W, H, t0)
    const a0 = angleFrom(pivot, toCanvas(sx, sy))
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
          // A turned clip snaps its bounding box (rotatedBounds is the strip itself when it isn't turned).
          const s = snapToCanvas(rotatedBounds(aspect, W, H, t), W, H, threshold)
          t = dragMove(t, s.dx / W, s.dy / H)
          g = s.guides
        }
      } else if (gesture.kind === "corner") {
        // dragCorner takes the drag in the clip's own axes and keeps the opposite corner where it shows.
        t = dragCorner(t0, gesture.corner, aspect, W, H, dx, dy, { anchor: "opposite" })
        if (snap && rot0 === 0) ({ t, guides: g } = snapCorner(t0, gesture.corner, aspect, W, H, t, threshold))
      } else if (gesture.kind === "edge") {
        // Along the clip's own axis: a turned clip's crop handle follows its side.
        const local = toLocal(dx, dy, rot0)
        const d = isSide(gesture.edge) ? local.x : local.y
        if (snap && rot0 === 0) ({ t, guides: g } = snapEdge(t0, gesture.edge, aspect, W, H, d, threshold))
        else t = dragEdge(t0, gesture.edge, aspect, W, H, d)
      } else {
        const turned = normalizeAngle(rot0 + angleFrom(pivot, toCanvas(lastX, lastY)) - a0)
        t = withRotation(t0, snap ? snapAngle(turned) : turned)
        setAngle(rotationOf(t))
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
      setAngle(null)
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
   * (up, down), the left or right handle by 1% of the width (left, right);
   * the rotate handle turns by 1 degree (Shift 15), right clockwise.
   */
  function handleKey(e: React.KeyboardEvent, gesture: Gesture) {
    if (!selected || e.altKey || e.ctrlKey || e.metaKey) return
    if (gesture.kind === "rotate") {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
      e.preventDefault()
      e.stopPropagation()
      const { id, transform: t0 } = selected
      onCommit(id, withRotation(t0, rotationOf(t0) + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 15 : 1)), `rotate-key-${id}`)
      return
    }
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

  /** A double-click on the canvas: the selected clip when it's under the pointer, else the topmost one there. Handles and buttons keep theirs. */
  function doubleClick(e: React.MouseEvent) {
    if (!onDoubleClickClip || (e.target instanceof Element && e.target.closest("button"))) return
    const p = toCanvas(e.clientX, e.clientY)
    const id = selected && containsPoint(selected.aspect, W, H, selected.transform, p.x, p.y) ? selected.id : hitTest(p.x, p.y)?.id
    if (id) onDoubleClickClip(id)
  }

  /** Rotate handle and flip buttons: the press is theirs alone (no move, no select). */
  const own = (e: React.PointerEvent) => {
    e.stopPropagation()
    if (e.button === 0) e.preventDefault()
  }

  const v = selected ? clipRect(selected.aspect, W, H, selected.transform).visible : null
  const rot = selected ? rotationOf(selected.transform) : 0
  // Screen px per canvas px; unknown (not measured yet) shows every handle.
  const px = displayWidth && displayWidth > 0 ? displayWidth / W : null
  const showEdge = (edge: Edge) => !v || px === null || (isSide(edge) ? v.h : v.w) * px >= MIN_SIDE_FOR_MIDDLE
  // The frame turns about the content centre, given as a point of its own box.
  const pivot = selected ? contentCentre(W, H, selected.transform) : null
  const origin = v && pivot && v.w > 0 && v.h > 0 ? `${((pivot.x - v.x) / v.w) * 100}% ${((pivot.y - v.y) / v.h) * 100}%` : undefined

  /**
   * Floating buttons' centres (screen px from the canvas's top left), each
   * `local` px out from the frame's `corner` (in the frame's own axes, so they
   * stay with a turned frame), shifted together as a group to stay inside the
   * visible area round the canvas (so a pair never lands on itself).
   */
  const floating = (corner: { x: number; y: number }, locals: { x: number; y: number }[]) => {
    if (px === null) return null
    const pts = locals.map((local) => {
      const off = rotatePoint(local, { x: 0, y: 0 }, rot)
      return { x: corner.x * px + off.x, y: corner.y * px + off.y }
    })
    if (!room) return pts
    const r = FLOAT_SIZE / 2 + 2
    const shift = (vals: number[], lo: number, hi: number) => {
      const min = Math.min(...vals)
      const max = Math.max(...vals)
      return min < lo ? lo - min : max > hi ? hi - max : 0
    }
    const sx = shift(pts.map((q) => q.x), -room.x + r, W * px + room.x - r)
    const sy = shift(pts.map((q) => q.y), -room.y + r, H * px + room.y - r)
    return pts.map((q) => ({ x: q.x + sx, y: q.y + sy }))
  }
  const corners = v && pivot ? rotatedCorners(v, pivot, rot) : null
  // The rotate handle and, to its left, the fill-the-frame button (shown while the clip isn't at its fitted, centred size). They shift together to stay in view.
  const topRight = corners ? floating(corners[1], [{ x: FLOAT_OFFSET, y: -FLOAT_OFFSET }, { x: FLOAT_OFFSET - FLOAT_SIZE - 4, y: -FLOAT_OFFSET }]) : null
  const rotateAt = topRight?.[0] ?? null
  const fillAt = selected?.canFill && !isIdentity(selected.transform) ? topRight?.[1] ?? null : null
  const flips = corners ? floating(corners[0], [{ x: -FLOAT_OFFSET, y: -FLOAT_OFFSET }, { x: FLOAT_SIZE + 4 - FLOAT_OFFSET, y: -FLOAT_OFFSET }]) : null
  const flipHAt = flips?.[0] ?? null
  const flipVAt = flips?.[1] ?? null
  const floatClass =
    "absolute z-10 flex -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full bg-white text-neutral-900 shadow-[0_1px_4px_rgb(0_0_0/0.45)] ring-1 ring-black/25 outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring"

  return (
    <div ref={root} className="absolute inset-0 touch-none" onPointerDown={pressCanvas} onDoubleClick={doubleClick}>
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
          // Sky with a dark halo inside and out: it reads on the black canvas and on the light gray around it (lighter in dark mode).
          className="absolute cursor-move touch-none shadow-[0_0_0_3px_rgb(0_0_0/0.5),inset_0_0_0_1px_rgb(0_0_0/0.5)] outline outline-2 outline-sky-400 dark:outline-editor-accent"
          style={{
            left: pct(v.x, W), top: pct(v.y, H), width: pct(v.w, W), height: pct(v.h, H),
            transform: rot !== 0 ? `rotate(${rot}deg)` : undefined, transformOrigin: rot !== 0 ? origin : undefined,
          }}
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
      {selected && rotateAt && (
        <>
          <button
            type="button"
            aria-label="Rotate"
            title="Rotate (drag; double-click to straighten)"
            className={cn(floatClass, angle === null ? "cursor-grab" : "cursor-grabbing")}
            style={{ left: rotateAt.x, top: rotateAt.y, width: FLOAT_SIZE, height: FLOAT_SIZE }}
            onPointerDown={(e) => {
              own(e)
              if (e.button === 0) startGesture(e, selected, { kind: "rotate" })
            }}
            onDoubleClick={() => rot !== 0 && onCommit(selected.id, withRotation(selected.transform, 0))}
            onKeyDown={(e) => handleKey(e, { kind: "rotate" })}
          >
            <RotateCw className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
          {angle !== null && (
            <div
              aria-hidden
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded bg-neutral-900/85 px-1.5 py-0.5 text-[11px] tabular-nums text-white shadow"
              style={{ left: rotateAt.x, top: rotateAt.y - FLOAT_SIZE / 2 - 4 }}
            >
              {`${Math.round(angle)}°`}
            </div>
          )}
        </>
      )}
      {selected && fillAt && (
        <button
          type="button"
          aria-label="Fill the frame"
          title="Fill the frame (resets size, position, crop and rotation)"
          className={cn(floatClass, "cursor-pointer")}
          style={{ left: fillAt.x, top: fillAt.y, width: FLOAT_SIZE, height: FLOAT_SIZE }}
          onPointerDown={own}
          onClick={() => onCommit(selected.id, IDENTITY)}
        >
          <Maximize2 className="h-3.5 w-3.5" strokeWidth={2.5} />
        </button>
      )}
      {selected && flipHAt && flipVAt && (
        <>
          {([
            // The icons and their places stay; what each one does is swapped (the left one mirrors top and bottom, the right one left and right).
            { axis: "v", at: flipHAt, label: "Flip vertically", title: "Flip vertically (mirror top and bottom)", on: Boolean(selected.transform.flipV), Icon: FlipHorizontal2 },
            { axis: "h", at: flipVAt, label: "Flip horizontally", title: "Flip horizontally (mirror left and right)", on: Boolean(selected.transform.flipH), Icon: FlipVertical2 },
          ] as const).map((f) => (
            <button
              key={f.axis}
              type="button"
              aria-label={f.label}
              aria-pressed={f.on}
              title={f.title}
              className={cn(floatClass, "cursor-pointer aria-pressed:ring-2 aria-pressed:ring-sky-500")}
              style={{ left: f.at.x, top: f.at.y, width: FLOAT_SIZE, height: FLOAT_SIZE }}
              onPointerDown={own}
              onClick={() => onCommit(selected.id, toggleFlip(selected.transform, f.axis))}
            >
              <f.Icon className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          ))}
        </>
      )}
    </div>
  )
}
