"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Film, Image as ImageIcon, Magnet, Plus, Volume2, VolumeX, X } from "lucide-react"
import { useStoredValue } from "@/lib/hooks/use-stored-state"
import { cn } from "@/lib/utils"
import {
  addClip, addTrack, assetKind, baseInsertion, clipLength, DEFAULT_IMAGE, findAssetsBySource, isMagnetic, MAX_TRACKS, moveClip, removeTrack, resolveStart,
  setBaseMagnetic, setClipMuted, totalLength, trackStarts, trimClip, type Clip, type Project,
} from "@/lib/video/project"
import { newId } from "@/lib/video/ids"
import {
  autoPanSpeed, clampRowZoom, clampZoom, MAX_ROW_ZOOM, MIN_ROW_ZOOM, rowHeight, snapStart, timelineWidth, trimDelta, wheelPixels, wheelZoomFactor, zoomAround,
} from "@/lib/video/timeline-math"
import { formatTimecode } from "@/lib/video/time"
import { ClipWaveform } from "./clip-waveform"
import { Thumb } from "./thumb"

// The bottom timeline: a ruler and stacked tracks (layers), the top layer at
// the top and the base track (layer 1) at the bottom. Clips on every track sit at
// their own start, gaps allowed, and a higher layer draws over the ones below.
// Drag a clip along or between tracks, drag its edge
// handles to trim, drop a file from the left panel onto a track to add it (an
// Inbox file is imported first), or onto the dashed row above to add a layer.
// The width follows the content (never narrower than the view), grows while
// something is dragged towards the end, and any drag near the left or right
// edge scrolls the view. From three layers the rows are half height, with a
// vertical zoom on the right. Layer 1's Snap box keeps its clips end to end: a
// drop or drag there shows an insertion line between clips instead of a ghost.
// The mouse wheel zooms the rows over the layer numbers, zooms time over the
// ruler (or with Ctrl/Cmd over the clips) and scrolls sideways over the clips
// (Shift: up and down). A clip with sound has its own mute button and, when
// waveforms are on, its waveform over the thumbnail.

export const ASSET_DRAG_TYPE = "application/x-ps-asset"
/** An Inbox file being dragged: JSON { folder, name }. */
export const INBOX_DRAG_TYPE = "application/x-ps-inbox"

/** Where a clip lands: a track (one past the top makes a new layer) and its start there. */
export type DropTarget = { track: number; start: number }

const HEADER = 44 // px, the sticky column with each track's number and buttons
const TIGHT_HEADER = 60 // px, the same column on short rows, where its controls sit side by side
const TIGHT_ROW = 56 // px: rows shorter than this use the tight layout
const NEW_ROW = 36 // px, the add-a-layer drop zone above the top track
const MIN_NEW_ROW = 24 // px, that zone at its smallest (it follows short rows down to this)
const TRACK_PAD = 240 // px of empty timeline after the last clip, room to drag overlay clips into
const DRAG_EXTRA = 10 // s of timeline kept past a dragged item's end, so it can go on to the right
const DRAG_THRESHOLD = 4 // px before a press on a clip becomes a drag
const SNAP_PX = 8 // px within which a dragged clip snaps to the playhead, 0 or another clip's edge
const ROW_ZOOM_KEY = "ps.video.rowZoom"

export const hasMediaDrag = (dt: DataTransfer | null) => dt !== null && (dt.types.includes(ASSET_DRAG_TYPE) || dt.types.includes(INBOX_DRAG_TYPE))

const sameTarget =(a: DropTarget | null, b: DropTarget | null) => a === b || (a !== null && b !== null && a.track === b.track && a.start === b.start)

/** 0, the playhead and both edges of every clip but `ignore`: where a dragged clip snaps. */
function snapPoints(p: Project, playhead: number, ignore?: string): number[] {
  const points = [0, playhead]
  p.tracks.forEach((t) => {
    const starts = trackStarts(t)
    t.clips.forEach((c, k) => {
      if (c.id !== ignore) points.push(starts[k], starts[k] + clipLength(c))
    })
  })
  return points
}

export function Timeline({
  project, folder, thumbUrl, selectedId, playhead, zoom, waveforms, onZoom, onSelect, onSeek, onScrub, onChange, onDropInbox,
}: {
  project: Project
  /** The project's folder, for the waveform peaks route. */
  folder: string
  /** Thumbnail URL for an asset id. */
  thumbUrl: (assetId: string) => string
  selectedId: string | null
  playhead: number
  /** Pixels per second. */
  zoom: number
  /** Whether clips with sound show their waveform. */
  waveforms: boolean
  /** The wheel changed the zoom (px per second, already clamped). */
  onZoom: (zoom: number) => void
  onSelect: (id: string | null) => void
  onSeek: (t: number) => void
  /** Scrubbing on the ruler started (true) or ended (false). */
  onScrub: (active: boolean) => void
  /** Applies an edit to the current project (not the one this render saw, which may be stale by then). */
  onChange: (edit: (p: Project) => Project) => void
  /** An Inbox file was dropped: import it, then add it at `target`. */
  onDropInbox: (folder: string, name: string, target: DropTarget) => void
}) {
  // While a trim is being dragged the edit lives here; it's committed on release.
  const [trim, setTrim] = useState<{ id: string; edge: "in" | "out"; seconds: number } | null>(null)
  // A clip being dragged: how far it has moved (content px, scrolling included), where it would land and where its end is.
  const [drag, setDrag] = useState<{ id: string; length: number; dx: number; dy: number; target: DropTarget | null; end: number } | null>(null)
  // The clip last dropped by a drag: it lands where its ghost was, without sliding there from where it started (until the next press).
  const [landed, setLanded] = useState<string | null>(null)
  // A file from the left panel being dragged (anywhere): its clip length, when known, for the ghost.
  const [outside, setOutside] = useState<{ length: number } | null>(null)
  const [drop, setDrop] = useState<DropTarget | null>(null)
  // The scroll viewport's inner width (px; 0 until measured).
  const [viewport, setViewport] = useState(0)
  // Vertical zoom for short rows; the server and first paint use 1, a stored one takes over on hydration.
  const [storedRowZoom, setStoredRowZoom] = useStoredValue(ROW_ZOOM_KEY)
  const rowZoom = clampRowZoom(storedRowZoom ? Number(storedRowZoom) : 1)
  const scroller = useRef<HTMLDivElement>(null)
  const origin = useRef<HTMLDivElement>(null)
  const rowEls = useRef<(HTMLDivElement | null)[]>([])
  const newRowEl = useRef<HTMLDivElement>(null)
  const stopFollowing = useRef<(() => void) | null>(null)
  // Auto-pan while a drag is near an edge: the pointer's x, what to redo after each scroll step, and the rAF loop.
  const pan = useRef<{ x: number; onPan: () => void; frame: number | null; last: number; carry: number } | null>(null)
  // The last file drag over a row, so auto-pan can move its ghost along.
  const fileDrag = useRef<{ clientX: number; track: number } | null>(null)
  // A wheel zoom asked for but not rendered yet: the zoom and the scrollLeft that keeps the pointer's time in place.
  const pendingZoom = useRef<{ zoom: number; scrollLeft: number } | null>(null)
  const onWheelRef = useRef<(e: WheelEvent) => void>(() => {})
  // The row zoom the wheel last asked for, so quick notches add up before the next render catches up.
  const wheelRowZoom = useRef<number | null>(null)

  const row = rowHeight(project.tracks.length, rowZoom)
  const tight = row < TIGHT_ROW
  const header = tight ? TIGHT_HEADER : HEADER
  const newRow = Math.max(MIN_NEW_ROW, Math.min(NEW_ROW, row))

  // The latest props for window listeners and the pan loop, which outlive the render that added them.
  const live = useRef({ project, playhead, zoom, row, header, outside })
  useEffect(() => {
    live.current = { project, playhead, zoom, row, header, outside }
    onWheelRef.current = onWheel
    wheelRowZoom.current = null
  })

  // React's onWheel is passive and can't keep the page from scrolling, so the wheel is listened to here.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const handler = (e: WheelEvent) => onWheelRef.current(e)
    el.addEventListener("wheel", handler, { passive: false })
    return () => el.removeEventListener("wheel", handler)
  }, [])

  // The zoom a wheel asked for has rendered: scroll so the time under the pointer stays there.
  useLayoutEffect(() => {
    const p = pendingZoom.current
    pendingZoom.current = null
    if (p && scroller.current && p.zoom === zoom) scroller.current.scrollLeft = p.scrollLeft
  }, [zoom])

  // A pointer drag still running when the timeline unmounts mustn't leave its listeners (or its pan loop) behind.
  useEffect(() => () => {
    stopFollowing.current?.()
    stopPan()
  }, [])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewport(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // A file dragged from the left panel: show the add-a-layer zone and size the ghost while it's in the air.
  useEffect(() => {
    const onStart = (e: DragEvent) => {
      const dt = e.dataTransfer
      if (!dt || !hasMediaDrag(dt)) return
      // The data can only be read during dragstart itself.
      const p = live.current.project
      let length = DEFAULT_IMAGE
      const assetId = dt.getData(ASSET_DRAG_TYPE)
      const known = assetId ? p.assets[assetId] : undefined
      if (known) length = assetKind(known) === "image" ? DEFAULT_IMAGE : known.duration
      if (!assetId) {
        try {
          const { folder, name } = JSON.parse(dt.getData(INBOX_DRAG_TYPE)) as { folder?: unknown; name?: unknown }
          const copy = typeof folder === "string" && typeof name === "string" ? findAssetsBySource(p, `${folder}/${name}`)[0]?.asset : undefined
          if (copy && assetKind(copy) === "video") length = copy.duration
        } catch {
          // Not our drag after all; the default length will do for the ghost.
        }
      }
      // Changing the page inside dragstart can cancel the drag in some browsers: update after it.
      setTimeout(() => setOutside({ length }), 0)
    }
    const onEnd = () => {
      setOutside(null)
      setDrop(null)
      fileDrag.current = null
      stopPan()
    }
    window.addEventListener("dragstart", onStart)
    window.addEventListener("dragend", onEnd)
    window.addEventListener("drop", onEnd)
    return () => {
      window.removeEventListener("dragstart", onStart)
      window.removeEventListener("dragend", onEnd)
      window.removeEventListener("drop", onEnd)
    }
  }, [])

  const shown = trim ? trimClip(project, trim.id, trim.edge, trim.seconds) : project
  const total = Math.max(totalLength(project), totalLength(shown))
  const canAddTrack = project.tracks.length < MAX_TRACKS
  const dragging = outside !== null || drag !== null
  const target = drag ? drag.target : drop
  const targetLength = drag ? drag.length : (outside?.length ?? DEFAULT_IMAGE)
  // Where the dragged item ends (s), so the timeline reaches past it while the gesture runs; null with none.
  const dragEnd = drag ? drag.end : trim ? total : drop ? drop.start + targetLength : null
  const width = timelineWidth({ contentEnd: total, zoom, viewport: viewport > 0 ? Math.max(0, viewport - header) : 600, pad: TRACK_PAD, dragEnd, extra: DRAG_EXTRA })
  const tickEvery = zoom >= 80 ? 1 : zoom >= 30 ? 5 : 10
  const ticks = Array.from({ length: Math.floor(width / zoom / tickEvery) + 1 }, (_, i) => i * tickEvery)

  // The ruler's left edge on screen moves as the view scrolls, so this is right at any scroll position.
  const timeAt = (clientX: number) => Math.max(0, (clientX - (origin.current?.getBoundingClientRect().left ?? 0)) / live.current.zoom)

  /** The track under the pointer: the nearest row (the top one above the rows), or one past the top on and just above the add-a-layer row. */
  function rowAt(clientY: number): number {
    const count = live.current.project.tracks.length
    const zone = newRowEl.current?.getBoundingClientRect()
    if (zone && clientY >= zone.top - live.current.row / 2 && clientY < zone.bottom) return count
    for (let i = count - 1; i >= 0; i--) {
      const r = rowEls.current[i]?.getBoundingClientRect()
      if (r && clientY < r.bottom) return i
    }
    return 0
  }

  /**
   * Where a clip `length` long lands on `track`: its left edge `left` snapped
   * and slid clear of the clips there. `ignore` is the clip being moved. On a
   * snapped V1 it's the slot the pointer time `at` picks (baseInsertion), its
   * start that slot's boundary.
   */
  function targetFor(track: number, left: number, length: number, ignore?: string, at = left): DropTarget {
    const { project: p, playhead: t, zoom: z } = live.current
    if (track === 0 && isMagnetic(p)) return { track, start: baseInsertion(p.tracks[0].clips, at, ignore).start }
    const start = snapStart(left, length, snapPoints(p, t, ignore), SNAP_PX, z)
    return { track, start: resolveStart(p.tracks[track]?.clips ?? [], length, start, ignore) }
  }

  /** Zooms time by `factor` around the pointer at `clientX`; false when the zoom is already at its limit. */
  function zoomAt(clientX: number, factor: number): boolean {
    const el = scroller.current
    if (!el) return false
    const from = pendingZoom.current ?? { zoom: live.current.zoom, scrollLeft: el.scrollLeft }
    const next = clampZoom(from.zoom * factor)
    if (next === from.zoom) return false
    const x = clientX - el.getBoundingClientRect().left - live.current.header
    pendingZoom.current = { zoom: next, scrollLeft: zoomAround(from.zoom, next, x, from.scrollLeft) }
    onZoom(next)
    return true
  }

  /**
   * The mouse wheel. Over the layer numbers it zooms the rows, over the ruler
   * (or with Ctrl/Cmd anywhere else) it zooms time around the pointer, and
   * over the clips it scrolls sideways (Shift: up and down). The page keeps
   * the wheel only when there's nothing here for it to do, and a drag in
   * progress is left alone.
   */
  function onWheel(e: WheelEvent) {
    if (stopFollowing.current) return
    const el = scroller.current
    if (!el) return
    const d = wheelPixels(e, el.clientHeight)
    const area = e.target instanceof Element ? e.target.closest("[data-wheel]")?.getAttribute("data-wheel") : null
    let used = false
    if (area === "layers") {
      const now = wheelRowZoom.current ?? rowZoom
      const next = clampRowZoom(now * wheelZoomFactor(d.y || d.x))
      if (next !== now) {
        wheelRowZoom.current = next
        setRowZoom(next)
        used = true
      }
    } else if (area === "ruler" || e.ctrlKey || e.metaKey) {
      used = zoomAt(e.clientX, wheelZoomFactor(d.y || d.x))
    } else if (e.shiftKey) {
      // Some browsers turn Shift+wheel into a sideways delta.
      const by = d.y || d.x
      if (el.scrollHeight > el.clientHeight && by !== 0) {
        el.scrollTop += by
        used = true
      }
    } else {
      const by = d.y + d.x
      if (el.scrollWidth > el.clientWidth && by !== 0) {
        el.scrollLeft += by
        used = true
      }
    }
    if (used) e.preventDefault()
  }

  function stopPan() {
    if (pan.current?.frame != null) cancelAnimationFrame(pan.current.frame)
    pan.current = null
  }

  /**
   * A drag's pointer is at `clientX`: near the left or right edge of the view
   * this scrolls it (autoPanSpeed, once per frame) and calls `onPan` after
   * every step that moved, so the dragged item is placed again at the new
   * scroll position. Runs until the pointer leaves the edge or stopPan.
   */
  function panAt(clientX: number, onPan: () => void) {
    const p = (pan.current ??= { x: clientX, onPan, frame: null, last: 0, carry: 0 })
    p.x = clientX
    p.onPan = onPan
    if (p.frame !== null) return
    const tick = (now: number) => {
      const cur = pan.current
      const el = scroller.current
      if (cur !== p || !el) return
      const r = el.getBoundingClientRect()
      const speed = autoPanSpeed(p.x, r.left + live.current.header, r.left + el.clientWidth)
      if (speed === 0) {
        p.frame = null
        return
      }
      // At most 50 ms a step (a frame after a stall mustn't jump), whole pixels at a time with the rest carried.
      p.carry += (speed * Math.min(50, now - p.last)) / 1000
      p.last = now
      const step = Math.trunc(p.carry)
      p.carry -= step
      if (step !== 0) {
        const before = el.scrollLeft
        el.scrollLeft = Math.max(0, before + step)
        if (el.scrollLeft !== before) p.onPan()
      }
      p.frame = requestAnimationFrame(tick)
    }
    p.last = performance.now()
    p.frame = requestAnimationFrame(tick)
  }

  /**
   * Window listeners for one pointer drag, removed on release (or unmount).
   * `onMove` returns false while the press isn't a drag yet; once it is, the
   * view auto-pans near its edges and `onMove` runs again with the last
   * pointer position after every pan step.
   */
  function follow(onMove: (e: PointerEvent) => boolean | void, onEnd: () => void) {
    stopFollowing.current?.()
    let last: PointerEvent | null = null
    const move = (e: PointerEvent) => {
      last = e
      if (onMove(e) === false) return
      panAt(e.clientX, () => {
        if (last) onMove(last)
      })
    }
    const up = () => {
      stop()
      onEnd()
    }
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
      stopPan()
      if (stopFollowing.current === stop) stopFollowing.current = null
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
    stopFollowing.current = stop
  }

  /** How far the view has scrolled since `from` (px; auto-pan or the wheel), to turn pointer travel into travel along the timeline. */
  const scrolledSince = (from: { x: number; y: number }) => ({
    x: (scroller.current?.scrollLeft ?? from.x) - from.x,
    y: (scroller.current?.scrollTop ?? from.y) - from.y,
  })
  const scrollNow = () => ({ x: scroller.current?.scrollLeft ?? 0, y: scroller.current?.scrollTop ?? 0 })

  function startTrim(e: React.PointerEvent, clip: Clip, edge: "in" | "out") {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const scroll0 = scrollNow()
    let moved = false
    let seconds: number | null = null
    onSelect(clip.id)
    follow(
      (ev) => {
        const cdx = ev.clientX - startX
        if (!moved && Math.abs(cdx) < DRAG_THRESHOLD) return false
        moved = true
        const s = trimDelta(edge, clip, cdx + scrolledSince(scroll0).x, live.current.zoom)
        seconds = s
        setTrim({ id: clip.id, edge, seconds: s })
      },
      () => {
        setTrim(null)
        const s = seconds
        if (s !== null) onChange((p) => trimClip(p, clip.id, edge, s))
      }
    )
  }

  /** Click or drag on the ruler: the preview follows the pointer until release. */
  function startScrub(e: React.PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    onScrub(true)
    const seekTo = (clientX: number) => onSeek(Math.min(totalLength(live.current.project), timeAt(clientX)))
    seekTo(e.clientX)
    follow((ev) => seekTo(ev.clientX), () => onScrub(false))
  }

  /** Press on a clip: a click selects it, a drag moves it along its track or onto another one. */
  function startMove(e: React.PointerEvent, clip: Clip, track: number, left: number) {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    const scroll0 = scrollNow()
    const length = clipLength(clip)
    let moved = false
    let to: DropTarget | null = null
    setLanded(null)
    follow(
      (ev) => {
        const cdx = ev.clientX - startX
        const cdy = ev.clientY - startY
        if (!moved && Math.hypot(cdx, cdy) < DRAG_THRESHOLD) return false
        moved = true
        // Travel along the timeline: the pointer's, plus whatever scrolled under it since the press.
        const scrolled = scrolledSince(scroll0)
        const dx = cdx + scrolled.x
        const dy = cdy + scrolled.y
        const newLeft = Math.max(0, left + dx / live.current.zoom)
        to = targetFor(rowAt(ev.clientY), newLeft, length, clip.id, timeAt(ev.clientX))
        setDrag({ id: clip.id, length, dx, dy, target: to, end: Math.max(newLeft, to.start) + length })
      },
      () => {
        setDrag(null)
        if (!moved) return onSelect(clip.id)
        setLanded(clip.id)
        const t = to
        if (!t) return
        const stays = t.track === track && Math.abs(t.start - left) < 1e-9
        if (!stays) onChange((p) => moveClip(p, clip.id, t.track, t))
      }
    )
  }

  /** The ghost of a file dragged over `track` with the pointer at `clientX`. */
  function placeGhost(clientX: number, track: number) {
    const next = targetFor(track, timeAt(clientX), live.current.outside?.length ?? DEFAULT_IMAGE)
    setDrop((prev) => (sameTarget(prev, next) ? prev : next))
  }

  // Drag and drop of files onto a track row (`track` one past the top is the add-a-layer row).
  function dragOver(e: React.DragEvent, track: number) {
    if (!hasMediaDrag(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
    fileDrag.current = { clientX: e.clientX, track }
    placeGhost(e.clientX, track)
  }

  function dragLeave(e: React.DragEvent) {
    // Moving onto a clip inside the row isn't leaving it.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    fileDrag.current = null
    setDrop(null)
  }

  // A file dragged anywhere over the timeline (rows, ruler, headers) auto-pans near the edges; the ghost follows when it's over a row.
  function panDragOver(e: React.DragEvent) {
    if (!hasMediaDrag(e.dataTransfer)) return
    panAt(e.clientX, () => {
      const f = fileDrag.current
      if (f) placeGhost(f.clientX, f.track)
    })
  }

  function panDragLeave(e: React.DragEvent) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    stopPan()
  }

  function dropOn(e: React.DragEvent, track: number) {
    const assetId = e.dataTransfer.getData(ASSET_DRAG_TYPE)
    const inbox = e.dataTransfer.getData(INBOX_DRAG_TYPE)
    setDrop(null)
    fileDrag.current = null
    stopPan()
    if (!assetId && !inbox) return
    e.preventDefault()
    const t = timeAt(e.clientX)
    if (assetId) {
      const asset = live.current.project.assets[assetId]
      if (!asset) return
      const to = targetFor(track, t, assetKind(asset) === "image" ? DEFAULT_IMAGE : asset.duration)
      const id = newId()
      onChange((p) => addClip(p, assetId, to.track, to, id))
      return
    }
    try {
      const { folder, name } = JSON.parse(inbox) as { folder?: unknown; name?: unknown }
      // The clip's real length is known after the import; addClip slides it clear of overlaps again then.
      if (typeof folder === "string" && typeof name === "string") onDropInbox(folder, name, targetFor(track, t, outside?.length ?? DEFAULT_IMAGE))
    } catch {
      // Not our drag after all.
    }
  }

  // Clips and ghosts sit 8 px in from a row's top and bottom, 4 px on short rows.
  const inset = tight ? "top-1 bottom-1" : "top-2 bottom-2"
  const ghost = (start: number, shift = 0) => (
    <div
      className={cn("pointer-events-none absolute z-10 rounded-lg border-2 border-dashed border-primary bg-primary/10", inset)}
      style={{ left: start * zoom + shift, width: Math.max(targetLength * zoom - 2, 8) }}
    />
  )
  // On a snapped V1: where the clip goes in, between two clips.
  const insertLine = (start: number) => (
    <div className="pointer-events-none absolute inset-y-0.5 z-30 w-1 -translate-x-1/2 rounded-full bg-primary" style={{ left: start * zoom }} />
  )
  const magnetic = isMagnetic(project)

  const allEmpty = project.tracks.every((t) => t.clips.length === 0)
  const rows = shown.tracks.map((_, i) => i).reverse()
  const setRowZoom = (z: number) => setStoredRowZoom(String(clampRowZoom(z)))

  return (
    <div className="relative flex min-h-0 flex-1">
      <div ref={scroller} className="relative min-h-0 min-w-0 flex-1 overflow-auto" onDragOver={panDragOver} onDragLeave={panDragLeave}>
        <div className="relative" style={{ width: header + width }}>
          <div className="sticky top-0 z-40 flex h-6 border-b border-border/60 bg-card">
            <div data-wheel="layers" className="sticky left-0 z-50 flex shrink-0 items-center justify-center border-r border-border/60 bg-card" style={{ width: header }}>
              <button
                type="button"
                onClick={() => onChange(addTrack)}
                disabled={!canAddTrack}
                title={canAddTrack ? "Add layer" : `At most ${MAX_TRACKS} layers`}
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="sr-only">Add layer</span>
              </button>
            </div>
            <div ref={origin} data-wheel="ruler" className="relative flex-1 cursor-pointer touch-none text-[10px] text-muted-foreground" onPointerDown={startScrub}>
              {ticks.map((t) => (
                <span key={t} className="pointer-events-none absolute top-0 h-full border-l border-border/60 pl-1 leading-6" style={{ left: t * zoom }}>
                  {formatTimecode(t).slice(0, -2)}
                </span>
              ))}
              <div className="pointer-events-none absolute bottom-0 h-2 w-2 -translate-x-1/2 rounded-full bg-primary" style={{ left: playhead * zoom }} />
            </div>
          </div>

          <span className="sr-only" aria-live="polite">{dragging && canAddTrack ? "Drop on the row above the top layer to add a layer." : ""}</span>
          {canAddTrack && (
            <div className="flex" style={{ height: newRow }}>
              <div data-wheel="layers" className="sticky left-0 z-30 shrink-0 border-r border-border/60 bg-card" style={{ width: header }} />
              <div
                ref={newRowEl}
                role="group"
                aria-label="Drop here to add a layer"
                className={cn(
                  "relative my-1 flex-1 rounded-md border-2 border-dashed text-[11px]",
                  dragging ? "border-primary/60 bg-primary/5 text-foreground" : "border-transparent text-muted-foreground/60"
                )}
                onDragOver={(e) => dragOver(e, project.tracks.length)}
                onDragLeave={dragLeave}
                onDrop={(e) => dropOn(e, project.tracks.length)}
              >
                <span className="pointer-events-none sticky left-2 inline-flex h-full items-center px-2">
                  {dragging ? "Drop here to add a layer" : "Drag media here for a new layer"}
                </span>
                {/* -2 px: the ghost sits inside this row's border, and lines up with the time grid. */}
                {target?.track === project.tracks.length && ghost(target.start, -2)}
              </div>
            </div>
          )}

          {rows.map((i) => {
            const track = shown.tracks[i]
            const isBase = i === 0
            const starts = trackStarts(track)
            const label = isBase ? "Layer 1 (base)" : `Layer ${i + 1}`
            return (
              <div key={track.id} className="flex border-b border-border/60" style={{ height: row }}>
                <div
                  data-wheel="layers"
                  className={cn(
                    "sticky left-0 z-30 flex shrink-0 items-center justify-center border-r border-border/60 bg-card text-[11px]",
                    tight ? "flex-row gap-0.5 px-0.5" : "flex-col gap-0.5"
                  )}
                  style={{ width: header }}
                >
                  <span className="font-medium" title={label}>{i + 1}</span>
                  {isBase && !tight && <span aria-hidden className="rounded bg-muted px-1 text-[9px] leading-tight text-muted-foreground" title={label}>base</span>}
                  <div className="flex items-center gap-0.5">
                    {isBase && (
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={magnetic}
                        aria-label="Snap clips together on layer 1 (no gaps)"
                        title="Snap clips together on layer 1 (no gaps)"
                        onClick={() => onChange((p) => setBaseMagnetic(p, !isMagnetic(p)))}
                        className={cn(
                          "flex shrink-0 items-center justify-center rounded border",
                          tight ? "h-4 w-4" : "h-5 w-5",
                          magnetic ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                      >
                        <Magnet className="h-3 w-3" />
                      </button>
                    )}
                    {!isBase && project.tracks[i]?.clips.length === 0 && (
                      <button
                        type="button"
                        title={`Remove ${label}`}
                        onClick={() => onChange((p) => removeTrack(p, track.id))}
                        className={cn("flex shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground", tight ? "h-4 w-4" : "h-5 w-5")}
                      >
                        <X className="h-3.5 w-3.5" />
                        <span className="sr-only">Remove {label}</span>
                      </button>
                    )}
                  </div>
                </div>
                <div
                  ref={(el) => {
                    rowEls.current[i] = el
                  }}
                  role="group"
                  aria-label={label}
                  className={cn("relative flex-1", !isBase && "bg-muted/20")}
                  onPointerDown={(e) => e.target === e.currentTarget && onSelect(null)}
                  onDragOver={(e) => dragOver(e, i)}
                  onDragLeave={dragLeave}
                  onDrop={(e) => dropOn(e, i)}
                >
                  {isBase && allEmpty && !dragging && (
                    <div className="pointer-events-none sticky left-0 flex h-full w-[min(100%,32rem)] items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Film className="h-4 w-4" /> Drag clips here to start your timeline
                    </div>
                  )}
                  {track.clips.map((clip, k) => {
                    const moving = drag?.id === clip.id
                    const asset = project.assets[clip.asset]
                    const file = asset?.file
                    const image = asset !== undefined && assetKind(asset) === "image"
                    // Only a video with sound can be muted or show a waveform.
                    const audible = asset !== undefined && !image && asset.hasAudio
                    const muted = Boolean(clip.muted)
                    const left = starts[k]
                    const clipWidth = Math.max(clipLength(clip) * zoom - 2, 8)
                    return (
                      <div
                        key={clip.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`${label}, clip ${k + 1} of ${track.clips.length}, ${image ? "image " : ""}${file ?? "missing file"}, at ${formatTimecode(starts[k])}, ${clipLength(clip).toFixed(1)} seconds${muted ? ", muted" : ""}`}
                        aria-pressed={selectedId === clip.id}
                        onPointerDown={(e) => startMove(e, clip, i, starts[k])}
                        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(clip.id))}
                        className={cn(
                          "group absolute touch-none select-none overflow-hidden rounded-lg border outline-none",
                          inset,
                          isBase ? "bg-muted" : "bg-sky-500/15",
                          !moving && !trim && landed !== clip.id && "transition-[left] duration-150 motion-reduce:transition-none",
                          selectedId === clip.id
                            ? "z-10 border-primary ring-2 ring-primary"
                            : isBase
                              ? "border-border hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring"
                              : "border-sky-500/60 hover:border-sky-400 focus-visible:ring-2 focus-visible:ring-ring",
                          moving ? "pointer-events-none z-20 cursor-grabbing opacity-70 shadow-lg" : "cursor-grab"
                        )}
                        style={{
                          left: left * zoom,
                          width: clipWidth,
                          transform: moving ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
                        }}
                        title={file}
                      >
                        <Thumb src={thumbUrl(clip.asset)} className={cn("pointer-events-none h-full w-full object-cover", isBase ? "opacity-80" : "opacity-70")} />
                        {waveforms && audible && (
                          <ClipWaveform
                            folder={folder}
                            assetId={clip.asset}
                            inSec={clip.in}
                            outSec={clip.out}
                            width={clipWidth - 2}
                            height={row - (tight ? 8 : 16) - 2}
                            left={left * zoom}
                            muted={muted}
                            scroller={scroller}
                          />
                        )}
                        {image ? (
                          <span className="pointer-events-none absolute inset-x-3 bottom-0.5 flex items-center gap-1 truncate text-[10px] font-medium text-white drop-shadow">
                            <ImageIcon className="h-3 w-3 shrink-0" /> {clipLength(clip).toFixed(1)}s image
                          </span>
                        ) : (
                          <span className="pointer-events-none absolute inset-x-3 bottom-0.5 truncate text-[10px] font-medium text-white drop-shadow">
                            {file ?? "Missing clip"} · {formatTimecode(clipLength(clip))}
                          </span>
                        )}
                        {audible && (
                          <button
                            type="button"
                            aria-pressed={muted}
                            aria-label={muted ? "Unmute clip" : "Mute clip"}
                            title={muted ? "Unmute clip" : "Mute clip"}
                            // Its own press: no drag, no select, and Enter or Space doesn't reach the clip.
                            onPointerDown={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation()
                              onChange((p) => setClipMuted(p, clip.id, !muted))
                            }}
                            className={cn(
                              "absolute right-3.5 z-10 flex items-center justify-center rounded bg-black/50 text-white outline-none transition-opacity hover:bg-black/70 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
                              // Short rows leave a clip 14 px inside its border at the smallest zoom.
                              tight ? "top-0 h-3.5 w-3.5" : "top-1 h-4 w-4",
                              muted || selectedId === clip.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                            )}
                          >
                            {muted ? <VolumeX className={cn("text-red-300", tight ? "h-2.5 w-2.5" : "h-3 w-3")} /> : <Volume2 className={tight ? "h-2.5 w-2.5" : "h-3 w-3"} />}
                          </button>
                        )}
                        {(["in", "out"] as const).map((edge) => (
                          <span
                            key={edge}
                            aria-hidden
                            onPointerDown={(e) => startTrim(e, clip, edge)}
                            className={cn(
                              "absolute inset-y-0 flex w-3 cursor-ew-resize touch-none items-center justify-center bg-primary/80 opacity-0 transition-opacity group-hover:opacity-100",
                              selectedId === clip.id && "opacity-100",
                              edge === "in" ? "left-0 rounded-l-lg" : "right-0 rounded-r-lg"
                            )}
                          >
                            <span className="h-[60%] max-h-5 w-0.5 rounded-full bg-primary-foreground/90" />
                          </span>
                        ))}
                      </div>
                    )
                  })}
                  {target?.track === i && (isBase && magnetic ? insertLine(target.start) : ghost(target.start))}
                </div>
              </div>
            )
          })}
          <div className="pointer-events-none absolute top-6 bottom-0 z-20 w-px bg-primary" style={{ left: header + playhead * zoom }} />
        </div>
      </div>
      {project.tracks.length >= 3 && (
        <div className="flex w-7 shrink-0 flex-col items-center gap-1 border-l border-border/60 bg-card py-2" title="Layer height (double-click to reset)">
          <span aria-hidden className="text-[9px] leading-none text-muted-foreground">{Math.round(rowZoom * 100)}%</span>
          {/* Vertical, larger at the top; the editor's arrow-key nudge leaves inputs alone, so the arrows step it. */}
          <input
            type="range"
            aria-label="Layer height"
            aria-valuetext={`${Math.round(rowZoom * 100)}%`}
            min={MIN_ROW_ZOOM}
            max={MAX_ROW_ZOOM}
            step={0.05}
            value={rowZoom}
            onChange={(e) => setRowZoom(Number(e.target.value))}
            onDoubleClick={() => setRowZoom(1)}
            className="min-h-0 w-4 flex-1 accent-primary [direction:rtl] [writing-mode:vertical-lr]"
          />
        </div>
      )}
    </div>
  )
}
