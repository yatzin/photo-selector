"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Blend, Film, Image as ImageIcon, Magnet, Plus, Type, Volume2, VolumeX, X } from "lucide-react"
import { useStoredValue } from "@/lib/hooks/use-stored-state"
import { cn } from "@/lib/utils"
import {
  addClip, addTrack, adjoins, assetKind, baseInsertion, clipEnd, clipLength, DEFAULT_IMAGE, findAssetsBySource, isMagnetic, isTextClip, leftTrimDraft, linksBefore, MAX_TRACKS, MIN_CLIP, moveClip,
  removeClip, removeTrack, resolveStart, setBaseMagnetic, setClipMuted, setClipText, splitClip, totalLength, trackStarts, trimClip, type Clip, type Project,
} from "@/lib/video/project"
import { setClipTiming } from "@/lib/video/clip-timing"
import { linkedChain, moveGroup, transitionName, unlinkClip, unlinkCut } from "@/lib/video/transitions"
import { newId } from "@/lib/video/ids"
import {
  autoPanSpeed, clampRowZoom, clampZoom, MAX_ROW_ZOOM, MIN_ROW_ZOOM, rowHeight, snapEdges, timelineWidth, trimDelta, wheelPixels, wheelZoomFactor, zoomAround,
} from "@/lib/video/timeline-math"
import { formatTimecode } from "@/lib/video/time"
import { ClipMenu, type ClipMenuItem } from "./clip-menu"
import { ClipWaveform } from "./clip-waveform"
import { EditLengthDialog } from "./edit-length-dialog"
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
// drop or drag there shows an insertion line between clips instead of a ghost,
// and a left-edge trim there shows the plain trim while dragging and packs on
// release. A dragged clip, a dragged trim edge and a file's ghost snap to the
// playhead, 0 and every other clip's edges on any layer (a fuchsia line marks
// the point); holding Alt turns that off, as a hint over the timeline says.
// The mouse wheel zooms the rows over the layer numbers, zooms time over the
// ruler (or with Ctrl/Cmd over the clips) and scrolls sideways over the clips
// (Shift: up and down). A clip with sound has its own mute button and, when
// waveforms are on, its waveform over the thumbnail. Right-clicking a clip
// opens its menu (split at the playhead, delete, mute, and for an image Edit
// length..., a dialog for its start and length). A text clip is a coloured
// block with its text; it has Edit length... too, Edit text... (also a
// double-click), Animation... (the same dialog on its Animation tab) and
// Horizontal / Vertical (letters across or stacked). A ramp at each end of the
// block shows how long its in and out animations run. A transition is an amber
// block straddling its cut (click: the Transition dialog); the selected clip
// has a white circle at each cut with an adjoining clip for adding one (or an
// audio overlap: the same dialog). A J-cut or L-cut is a thin teal band along
// the bottom of the clip its sound overlaps, beside the cut. A clip linked by
// a transition or an audio overlap can't be dragged off or trimmed apart at
// that cut: it shows a red X and a notice offers to unlink it or move its
// whole chain.

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
const SNAP_PX = 8 // px within which a dragged clip or edge snaps to the playhead, 0 or another clip's edge
const ROW_ZOOM_KEY = "ps.video.rowZoom"
const NOTICE_MS = 6000 // how long a notice stays (longer while hovered or focused)
const REJECT_MS = 800 // how long a refused clip shows its red X

/**
 * A message over the timeline (where the Alt hint goes) after an edit was
 * refused or changed something: `unlink` offers to take a clip's transitions
 * off (or one cut's, `cut`), `group` to move its whole linked chain instead.
 */
type Notice = {
  text: string
  unlink?: { id: string; cut?: boolean }
  group?: { id: string; count: number; run: () => void }
  /** Where it sits in the view (px from its left): centred there, or its left or right edge there. */
  anchor?: { x: number; side: "center" | "left" | "right" }
}

/** Seconds, without trailing zeros (0.65, 1, 1.5). */
const secs = (n: number) => String(Number(n.toFixed(2)))

export const hasMediaDrag = (dt: DataTransfer | null) => dt !== null && (dt.types.includes(ASSET_DRAG_TYPE) || dt.types.includes(INBOX_DRAG_TYPE))

const sameTarget =(a: DropTarget | null, b: DropTarget | null) => a === b || (a !== null && b !== null && a.track === b.track && a.start === b.start)

/** 0, the playhead and both edges of every clip but `ignore` (on every track but `skipTrack`): where a dragged clip or edge snaps. */
function snapPoints(p: Project, playhead: number, ignore?: string, skipTrack?: number): number[] {
  const points = [0, playhead]
  p.tracks.forEach((t, i) => {
    if (i === skipTrack) return
    const starts = trackStarts(t)
    t.clips.forEach((c, k) => {
      if (c.id !== ignore) points.push(starts[k], starts[k] + clipLength(c))
    })
  })
  return points
}

export function Timeline({
  project, folder, thumbUrl, selectedId, playhead, zoom, waveforms, onZoom, onSelect, onSeek, onScrub, onChange, onDropInbox, onEditText, onTransition,
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
  /** Open a text clip's Edit text dialog (on its Animation tab for "animation"). */
  onEditText: (id: string, section?: "text" | "animation") => void
  /** Open the Transition dialog for the cut before clip `id`. */
  onTransition: (id: string) => void
}) {
  // While a trim is being dragged the edit lives here; it's committed on release.
  const [trim, setTrim] = useState<{ id: string; edge: "in" | "out"; seconds: number } | null>(null)
  // A drag that snaps: whether Alt has snapping off, and the time it's snapped to (null: none), for the hint and the guide line.
  const [snap, setSnap] = useState<{ off: boolean; at: number | null } | null>(null)
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
  // The last file drag over a row, so auto-pan can move its ghost along (with Alt, snapping off).
  const fileDrag = useRef<{ clientX: number; track: number; alt: boolean } | null>(null)
  // A wheel zoom asked for but not rendered yet: the zoom and the scrollLeft that keeps the pointer's time in place.
  const pendingZoom = useRef<{ zoom: number; scrollLeft: number } | null>(null)
  const onWheelRef = useRef<(e: WheelEvent) => void>(() => {})
  // The row zoom the wheel last asked for, so quick notches add up before the next render catches up.
  const wheelRowZoom = useRef<number | null>(null)
  // Alt held during a pointer drag (snapping off), kept up to date by follow.
  const altHeld = useRef(false)
  // The right-click menu: the clip it's for and where the pointer was (viewport px).
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  // The clip whose Edit length dialog is open.
  const [lengthFor, setLengthFor] = useState<string | null>(null)
  // A refused edit's message (and the hover or focus that keeps it up), and the clip flashing its red X.
  const [notice, setNotice] = useState<Notice | null>(null)
  const [noticeHeld, setNoticeHeld] = useState(false)
  const [rejected, setRejected] = useState<string | null>(null)

  useEffect(() => {
    if (!notice || noticeHeld) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice, noticeHeld])

  useEffect(() => {
    if (!rejected) return
    const timer = setTimeout(() => setRejected(null), REJECT_MS)
    return () => clearTimeout(timer)
  }, [rejected])

  /**
   * A refused edit on a clip: its red X, and a notice. The notice goes at the
   * top centre of the view like the Alt hint, or beside the playhead when that
   * is near the centre, so it never covers it.
   */
  function refuse(id: string | null, n: Notice) {
    if (id) setRejected(id)
    const { header: h, zoom: z, playhead: t } = live.current
    const view = scroller.current?.clientWidth ?? 600
    const centre = h + (view - h) / 2
    const x = h + t * z - (scroller.current?.scrollLeft ?? 0)
    const near = x > h && x < view && Math.abs(x - centre) < 260
    setNoticeHeld(false)
    setNotice({ ...n, anchor: !near ? { x: centre, side: "center" } : x < centre ? { x: x + 12, side: "left" } : { x: x - 12, side: "right" } })
  }

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
      setSnap(null)
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

  // A left-edge trim on a snapped base shows unpacked while dragging (leftTrimDraft); anything else is the trim itself.
  const shown = !trim ? project : trim.edge === "in" ? leftTrimDraft(project, trim.id, trim.seconds).draft : trimClip(project, trim.id, trim.edge, trim.seconds)
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
   * (unless `snapOn` is false) and slid clear of the clips there, and `guide`,
   * the time its start or end snapped to (null when it didn't, or the slide
   * took it off). `ignore` is the clip being moved. On a snapped V1 it's the
   * slot the pointer time `at` picks (baseInsertion), its start that slot's
   * boundary, with no snapping.
   */
  function targetFor(track: number, left: number, length: number, ignore?: string, at = left, snapOn = true): { to: DropTarget; guide: number | null } {
    const { project: p, playhead: t, zoom: z } = live.current
    if (track === 0 && isMagnetic(p)) return { to: { track, start: baseInsertion(p.tracks[0].clips, at, ignore).start }, guide: null }
    const s = snapOn ? snapEdges([left, left + length], snapPoints(p, t, ignore), SNAP_PX, z) : null
    const snapped = Math.max(0, !s ? left : s.edge === 0 ? s.at : s.at - length)
    const start = resolveStart(p.tracks[track]?.clips ?? [], length, snapped, ignore)
    return { to: { track, start }, guide: s && Math.abs(start - snapped) < 1e-9 ? s.at : null }
  }

  /**
   * On a snapped V1, the clip whose transition a drop or move landing at `start`
   * would part (it goes in between two clips there); null anywhere else, where
   * a clip slides clear of others and so never lands between two that adjoin.
   */
  function linkedCutAt(track: number, start: number, ignore?: string): string | null {
    const p = live.current.project
    if (track !== 0 || !isMagnetic(p)) return null
    const others = p.tracks[0].clips.filter((c) => c.id !== ignore)
    const slot = baseInsertion(others, start, ignore).index
    const after = others[slot]
    return slot > 0 && after && linksBefore(after) && adjoins(others[slot - 1], after) ? after.id : null
  }

  /** The notice for an edit refused because a transition or audio overlap links clips (`cut`: the drop would part that one cut). */
  const linkedNotice = (id: string, extra: Partial<Notice> = {}, cut = false): Notice => ({ text: "This clip is linked by a transition or audio overlap.", unlink: { id, cut }, ...extra })

  /** The hint and guide for a snapping drag landing on `track`: none on a snapped V1 (its insertion line doesn't snap). */
  const snapState = (track: number, off: boolean, guide: number | null) => (track === 0 && isMagnetic(live.current.project) ? null : { off, at: off ? null : guide })

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
   * pointer position after every pan step. A drag that `snaps` keeps altHeld
   * up to date (the pointer's altKey, and Alt pressed or released without a
   * move, which runs `onMove` again); Alt's browser default is held off.
   */
  function follow(onMove: (e: PointerEvent) => boolean | void, onEnd: () => void, snaps = false) {
    stopFollowing.current?.()
    let last: PointerEvent | null = null
    const move = (e: PointerEvent) => {
      last = e
      if (snaps) altHeld.current = e.altKey
      if (onMove(e) === false) return
      panAt(e.clientX, () => {
        if (last) onMove(last)
      })
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return
      e.preventDefault()
      const down = e.type === "keydown"
      if (down === altHeld.current) return
      altHeld.current = down
      if (last) onMove(last)
    }
    const up = () => {
      stop()
      onEnd()
      setSnap(null)
    }
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
      window.removeEventListener("keydown", key, true)
      window.removeEventListener("keyup", key, true)
      stopPan()
      if (stopFollowing.current === stop) stopFollowing.current = null
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
    if (snaps) {
      window.addEventListener("keydown", key, true)
      window.addEventListener("keyup", key, true)
    }
    stopFollowing.current = stop
  }

  /** How far the view has scrolled since `from` (px; auto-pan or the wheel), to turn pointer travel into travel along the timeline. */
  const scrolledSince = (from: { x: number; y: number }) => ({
    x: (scroller.current?.scrollLeft ?? from.x) - from.x,
    y: (scroller.current?.scrollTop ?? from.y) - from.y,
  })
  const scrollNow = () => ({ x: scroller.current?.scrollLeft ?? 0, y: scroller.current?.scrollTop ?? 0 })

  /**
   * Drag a clip's edge handle: the dragged edge snaps to the playhead, 0 and
   * the other clips' edges on every layer (on a snapped V1, the other layers'
   * only: its own clips ride along). On a snapped V1 the left edge shows the
   * plain trim while dragging and the base packs on release (leftTrimDraft);
   * the right edge ripples live there, as before. One undo step.
   */
  function startTrim(e: React.PointerEvent, clip: Clip, edge: "in" | "out", track: number) {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    // An edge at a cut with a transition or audio overlap can't move apart from its neighbour (a snapped V1 keeps them together, so there it can).
    const p0 = live.current.project
    const clips0 = p0.tracks[track]?.clips ?? []
    const k0 = clips0.findIndex((c) => c.id === clip.id)
    const neighbour = edge === "in" ? clips0[k0] : clips0[k0 + 1]
    const linkedEdge = neighbour && linksBefore(neighbour) && adjoins(clips0[edge === "in" ? k0 - 1 : k0], neighbour)
    if (linkedEdge && !(track === 0 && isMagnetic(p0))) {
      onSelect(clip.id)
      refuse(clip.id, linkedNotice(clip.id))
      return
    }
    const startX = e.clientX
    const scroll0 = scrollNow()
    let moved = false
    let seconds: number | null = null
    altHeld.current = e.altKey
    onSelect(clip.id)
    follow(
      (ev) => {
        const cdx = ev.clientX - startX
        if (!moved && Math.abs(cdx) < DRAG_THRESHOLD) return false
        moved = true
        const { project: p, playhead: t, zoom: z } = live.current
        let s = trimDelta(edge, clip, cdx + scrolledSince(scroll0).x, z)
        const off = altHeld.current
        let guide: number | null = null
        // The left edge of a snapped V1 clip is only a stand-in until release (the magnet then packs the layer), so it doesn't snap.
        const deferredLeft = edge === "in" && track === 0 && isMagnetic(p)
        if (!off && !deferredLeft) {
          // Either edge sits at start + (seconds - in) on the timeline, an image's too (its in is 0).
          const hit = snapEdges([clip.start + s - clip.in], snapPoints(p, t, clip.id, track === 0 && isMagnetic(p) ? 0 : undefined), SNAP_PX, z)
          if (hit) {
            s += hit.shift
            // A guide only when the edge got there (a neighbour or a limit may have stopped it).
            const c = (edge === "in" ? leftTrimDraft(p, clip.id, s).draft : trimClip(p, clip.id, edge, s)).tracks[track]?.clips.find((x) => x.id === clip.id)
            if (c && Math.abs((edge === "in" ? c.start : clipEnd(c)) - hit.at) < 1e-6) guide = hit.at
          }
        }
        seconds = s
        setTrim({ id: clip.id, edge, seconds: s })
        setSnap(deferredLeft ? null : { off, at: guide })
      },
      () => {
        setTrim(null)
        const s = seconds
        if (s === null) return
        // Off a snapped base leftTrimDraft's seconds are s itself.
        const trimmed = (p: Project) => (edge === "in" ? trimClip(p, clip.id, "in", leftTrimDraft(p, clip.id, s).seconds) : trimClip(p, clip.id, edge, s))
        // A transition or audio overlap the trim leaves without enough footage goes (fixTransitions): say so.
        const count = (p: Project, key: "transition" | "cutAudio") => p.tracks.reduce((n, t) => n + t.clips.filter((c) => c[key]).length, 0)
        const after = trimmed(live.current.project)
        if (count(after, "transition") < count(live.current.project, "transition")) refuse(null, { text: "Transition removed: not enough footage left at the cut." })
        else if (count(after, "cutAudio") < count(live.current.project, "cutAudio")) refuse(null, { text: "Audio overlap removed: not enough footage left at the cut." })
        onChange(trimmed)
      },
      true
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
    // The last pointer position as a time, the clip's unsnapped start there, and whether snapping was on: what Move all linked clips replays.
    let last = { at: 0, left, snapOn: true }
    altHeld.current = e.altKey
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
        const off = altHeld.current
        last = { at: timeAt(ev.clientX), left: newLeft, snapOn: !off }
        const r = targetFor(rowAt(ev.clientY), newLeft, length, clip.id, last.at, !off)
        to = r.to
        setDrag({ id: clip.id, length, dx, dy, target: r.to, end: Math.max(newLeft, r.to.start) + length })
        setSnap(snapState(r.to.track, off, r.guide))
      },
      () => {
        setDrag(null)
        if (!moved) return onSelect(clip.id)
        const t = to
        if (!t) return
        const stays = t.track === track && Math.abs(t.start - left) < 1e-9
        if (stays) return setLanded(clip.id)
        // A clip linked by a transition or audio overlap doesn't come apart: it springs back, and the notice offers to unlink it or move its whole chain.
        const chain = linkedChain(live.current.project, clip.id)
        if (chain.length > 1) {
          const replay = last
          return refuse(clip.id, linkedNotice(clip.id, { group: { id: clip.id, count: chain.length, run: () => moveChain(clip.id, replay.left - left, replay.at, replay.snapOn) } }))
        }
        const cut = linkedCutAt(t.track, t.start, clip.id)
        if (cut) return refuse(clip.id, linkedNotice(cut, {}, true))
        setLanded(clip.id)
        onChange((p) => moveClip(p, clip.id, t.track, t))
      },
      true
    )
  }

  /**
   * Moves the chain of clips linked to `id` along its layer by `delta` seconds
   * (the drag Move all linked clips replays), its leading edge (or its end)
   * snapping as a dragged clip does; on a snapped V1 into the slot the pointer
   * time `at` picks. One undo step.
   */
  function moveChain(id: string, delta: number, at: number, snapOn: boolean) {
    const { project: p, playhead: t, zoom: z } = live.current
    const ids = new Set(linkedChain(p, id))
    const track = p.tracks.findIndex((tr) => tr.clips.some((c) => c.id === id))
    const group = p.tracks[track]?.clips.filter((c) => ids.has(c.id)) ?? []
    if (group.length === 0) return
    const length = clipEnd(group[group.length - 1]) - group[0].start
    const magnetic = track === 0 && isMagnetic(p)
    let start = Math.max(0, group[0].start + delta)
    if (!magnetic && snapOn) {
      const points = [0, t, ...p.tracks.flatMap((tr) => tr.clips.filter((c) => !ids.has(c.id)).flatMap((c) => [c.start, clipEnd(c)]))]
      const s = snapEdges([start, start + length], points, SNAP_PX, z)
      if (s) start = Math.max(0, s.edge === 0 ? s.at : s.at - length)
    }
    setNotice(null)
    onChange((q) => moveGroup(q, id, magnetic ? at : start))
  }

  /** The ghost of a file dragged over `track` with the pointer at `clientX` (Alt held: no snapping). */
  function placeGhost(clientX: number, track: number, alt: boolean) {
    const { to: next, guide } = targetFor(track, timeAt(clientX), live.current.outside?.length ?? DEFAULT_IMAGE, undefined, undefined, !alt)
    setDrop((prev) => (sameTarget(prev, next) ? prev : next))
    const s = snapState(track, alt, guide)
    setSnap((prev) => (prev?.off === s?.off && prev?.at === s?.at ? prev : s))
  }

  // Drag and drop of files onto a track row (`track` one past the top is the add-a-layer row).
  function dragOver(e: React.DragEvent, track: number) {
    if (!hasMediaDrag(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
    fileDrag.current = { clientX: e.clientX, track, alt: e.altKey }
    placeGhost(e.clientX, track, e.altKey)
  }

  function dragLeave(e: React.DragEvent) {
    // Moving onto a clip inside the row isn't leaving it.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    fileDrag.current = null
    setDrop(null)
    setSnap(null)
  }

  // A file dragged anywhere over the timeline (rows, ruler, headers) auto-pans near the edges; the ghost follows when it's over a row.
  function panDragOver(e: React.DragEvent) {
    if (!hasMediaDrag(e.dataTransfer)) return
    panAt(e.clientX, () => {
      const f = fileDrag.current
      if (f) placeGhost(f.clientX, f.track, f.alt)
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
    setSnap(null)
    fileDrag.current = null
    stopPan()
    if (!assetId && !inbox) return
    e.preventDefault()
    const t = timeAt(e.clientX)
    const snapOn = !e.altKey
    // Not in between two clips a transition or audio overlap links.
    const cut = linkedCutAt(track, t)
    if (cut) return refuse(null, linkedNotice(cut, {}, true))
    if (assetId) {
      const asset = live.current.project.assets[assetId]
      if (!asset) return
      const { to } = targetFor(track, t, assetKind(asset) === "image" ? DEFAULT_IMAGE : asset.duration, undefined, undefined, snapOn)
      const id = newId()
      onChange((p) => addClip(p, assetId, to.track, to, id))
      return
    }
    try {
      const { folder, name } = JSON.parse(inbox) as { folder?: unknown; name?: unknown }
      // The clip's real length is known after the import; addClip slides it clear of overlaps again then.
      if (typeof folder === "string" && typeof name === "string") onDropInbox(folder, name, targetFor(track, t, outside?.length ?? DEFAULT_IMAGE, undefined, undefined, snapOn).to)
    } catch {
      // Not our drag after all.
    }
  }

  const clipEl = (id: string) => scroller.current?.querySelector<HTMLElement>(`[data-clip-id="${CSS.escape(id)}"]`) ?? null

  /** Right click on a clip (or the menu key on a focused one): select it and open its menu there. Not during a drag. */
  function openMenu(e: React.MouseEvent, clip: Clip) {
    e.preventDefault()
    if (stopFollowing.current || drag || trim) return
    // The menu key gives no pointer position: open at the clip's bottom left.
    let { clientX: x, clientY: y } = e
    if (x === 0 && y === 0) {
      const r = e.currentTarget.getBoundingClientRect()
      x = r.left
      y = r.bottom
    }
    onSelect(clip.id)
    setMenu({ id: clip.id, x, y })
  }

  function closeMenu() {
    const id = menu?.id
    setMenu(null)
    if (id) clipEl(id)?.focus({ preventScroll: true })
  }

  /** What a clip's menu offers; each kind of clip adds its own items here. */
  function menuItems(clip: Clip): ClipMenuItem[] {
    const asset = isTextClip(clip) ? undefined : project.assets[clip.asset]
    const image = asset !== undefined && assetKind(asset) === "image"
    const audible = asset !== undefined && !image && asset.hasAudio
    const id = clip.id
    // Split works only with the playhead inside the clip, at least MIN_CLIP from either end (as splitClip needs).
    const local = playhead - clip.start
    const items: ClipMenuItem[] = [
      {
        label: "Split at playhead",
        hint: "S",
        disabled: !(local >= MIN_CLIP && clipLength(clip) - local >= MIN_CLIP),
        onSelect: () => {
          const at = live.current.playhead
          const splitId = newId()
          onChange((p) => splitClip(p, id, at, splitId))
        },
      },
      {
        label: "Delete",
        hint: "Delete",
        onSelect: () => {
          onChange((p) => removeClip(p, id))
          onSelect(null)
        },
      },
    ]
    if (audible) items.push({ label: clip.muted ? "Unmute" : "Mute", hint: "M", onSelect: () => onChange((p) => setClipMuted(p, id, !clip.muted)) })
    if (image || isTextClip(clip)) items.push({ label: "Edit length...", onSelect: () => setLengthFor(id) })
    if (isTextClip(clip)) {
      const text = clip.text
      items.push(
        { label: "Edit text...", onSelect: () => onEditText(id) },
        { label: "Animation...", onSelect: () => onEditText(id, "animation") },
        ...(["horizontal", "vertical"] as const).map((orientation) => ({
          label: orientation === "horizontal" ? "Horizontal" : "Vertical",
          checked: text.orientation === orientation,
          onSelect: () => onChange((p) => setClipText(p, id, { ...text, orientation })),
        }))
      )
    }
    return items
  }

  const menuClip = menu ? project.tracks.flatMap((t) => t.clips).find((c) => c.id === menu.id) : undefined
  const lengthTrack = lengthFor ? project.tracks.findIndex((t) => t.clips.some((c) => c.id === lengthFor)) : -1
  const lengthClip = lengthTrack >= 0 ? project.tracks[lengthTrack].clips.find((c) => c.id === lengthFor) : undefined

  // Clips and ghosts sit 8 px in from a row's top and bottom, 4 px on short rows.
  const inset = tight ? "top-1 bottom-1" : "top-2 bottom-2"
  const ghost = (start: number, shift = 0) => (
    <div
      className={cn("pointer-events-none absolute z-10 rounded-lg border-2 border-dashed border-editor-accent bg-editor-accent/10", inset)}
      style={{ left: start * zoom + shift, width: Math.max(targetLength * zoom - 2, 8) }}
    />
  )
  // On a snapped V1: where the clip goes in, between two clips.
  const insertLine = (start: number) => (
    <div className="pointer-events-none absolute inset-y-0.5 z-30 w-1 -translate-x-1/2 rounded-full bg-editor-accent" style={{ left: start * zoom }} />
  )
  const magnetic = isMagnetic(project)
  // A drag that snaps shows the Alt hint, and the guide line while it's snapped.
  const snapHint = snap && (drag || trim || drop) ? snap : null
  const guide = snapHint && !snapHint.off ? snapHint.at : null

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
              <div className="pointer-events-none absolute bottom-0 h-2 w-2 -translate-x-1/2 rounded-full bg-editor-accent" style={{ left: playhead * zoom }} />
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
                  dragging ? "border-editor-accent/60 bg-editor-accent/5 text-foreground" : "border-transparent text-muted-foreground/60"
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
                          magnetic ? "border-editor-accent bg-editor-accent/15 text-editor-accent" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
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
                    const text = isTextClip(clip) ? clip.text : null
                    const asset = text ? undefined : project.assets[clip.asset]
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
                        aria-label={`${label}, clip ${k + 1} of ${track.clips.length}, ${text ? `text "${text.content}"` : `${image ? "image " : ""}${file ?? "missing file"}`}, at ${formatTimecode(starts[k])}, ${clipLength(clip).toFixed(1)} seconds${muted ? ", muted" : ""}`}
                        aria-pressed={selectedId === clip.id}
                        aria-haspopup="menu"
                        data-clip-id={clip.id}
                        onPointerDown={(e) => startMove(e, clip, i, starts[k])}
                        onContextMenu={(e) => openMenu(e, clip)}
                        onDoubleClick={text ? () => onEditText(clip.id) : undefined}
                        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(clip.id))}
                        className={cn(
                          "group absolute touch-none select-none overflow-hidden rounded-lg border outline-none",
                          inset,
                          text ? "bg-violet-500/25 dark:bg-violet-400/25" : isBase ? "bg-muted" : "bg-sky-500/15",
                          !moving && !trim && landed !== clip.id && "transition-[left] duration-150 motion-reduce:transition-none",
                          selectedId === clip.id
                            ? "z-10 border-editor-accent ring-2 ring-editor-accent"
                            : text
                              ? "border-violet-500/70 hover:border-violet-500 focus-visible:ring-2 focus-visible:ring-ring dark:border-violet-400/70 dark:hover:border-violet-300"
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
                        title={text ? `${text.content} (double-click to edit)` : file}
                      >
                        {text?.animIn && (
                          // The in animation's length: a ramp up from the clip's start.
                          <div
                            aria-hidden
                            className="pointer-events-none absolute inset-y-0 left-0 bg-violet-600/30 [clip-path:polygon(0_100%,100%_0,100%_100%)] dark:bg-violet-300/30"
                            style={{ width: Math.min(text.animIn.duration * zoom, clipWidth) }}
                          />
                        )}
                        {text?.animOut && (
                          // The out animation's length: a ramp down to the clip's end.
                          <div
                            aria-hidden
                            className="pointer-events-none absolute inset-y-0 right-0 bg-violet-600/30 [clip-path:polygon(0_0,100%_100%,0_100%)] dark:bg-violet-300/30"
                            style={{ width: Math.min(text.animOut.duration * zoom, clipWidth) }}
                          />
                        )}
                        {text ? (
                          // The text itself, on one line, over a block in its layer's place.
                          <span className="pointer-events-none absolute inset-x-3 inset-y-0 flex items-center gap-1 overflow-hidden text-[11px] font-medium text-violet-950 dark:text-violet-50">
                            <Type aria-hidden className="h-3 w-3 shrink-0" />
                            <span className="truncate">{text.content.replace(/\s+/g, " ")}</span>
                          </span>
                        ) : (
                          <Thumb src={thumbUrl(clip.asset)} className={cn("pointer-events-none h-full w-full object-cover", isBase ? "opacity-80" : "opacity-70")} />
                        )}
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
                        {text ? null : image ? (
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
                        {rejected === clip.id && (
                          // A refused move or trim: a red X across the block for a moment.
                          <svg aria-hidden className="pointer-events-none absolute inset-0 z-20 h-full w-full bg-red-500/15" preserveAspectRatio="none" viewBox="0 0 100 100">
                            <path d="M4 6 L96 94 M96 6 L4 94" stroke="#ef4444" strokeWidth={4} strokeLinecap="round" vectorEffect="non-scaling-stroke" fill="none" />
                          </svg>
                        )}
                        {(["in", "out"] as const).map((edge) => (
                          <span
                            key={edge}
                            aria-hidden
                            onPointerDown={(e) => startTrim(e, clip, edge, i)}
                            className={cn(
                              "absolute inset-y-0 flex w-3 cursor-ew-resize touch-none items-center justify-center bg-editor-accent/80 opacity-0 transition-opacity group-hover:opacity-100",
                              selectedId === clip.id && "opacity-100",
                              edge === "in" ? "left-0 rounded-l-lg" : "right-0 rounded-r-lg"
                            )}
                          >
                            <span className="h-[60%] max-h-5 w-0.5 rounded-full bg-editor-accent-foreground/90" />
                          </span>
                        ))}
                      </div>
                    )
                  })}
                  {track.clips.map((clip, k) => {
                    // A transition: a tinted block straddling its cut, half over each clip.
                    if (!clip.transition || !adjoins(track.clips[k - 1], clip)) return null
                    const name = transitionName(clip.transition.type)
                    const w = Math.max(clip.transition.duration * zoom, 16)
                    return (
                      <button
                        key={`tx-${clip.id}`}
                        type="button"
                        aria-label={`Transition: ${name}, ${secs(clip.transition.duration)}s`}
                        title={`${name}, ${secs(clip.transition.duration)} s (click to change)`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => onTransition(clip.id)}
                        className={cn(
                          "absolute top-1/2 z-[15] flex -translate-y-1/2 items-center justify-center gap-1 overflow-hidden rounded-md border px-1 text-[10px] font-medium shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          "border-amber-600/80 bg-amber-300/90 text-amber-950 hover:bg-amber-200 dark:border-amber-300/80 dark:bg-amber-500/85 dark:text-amber-950 dark:hover:bg-amber-400",
                          tight ? "h-4" : "h-5"
                        )}
                        style={{ left: clip.start * zoom - w / 2, width: w }}
                      >
                        <Blend aria-hidden className="h-3 w-3 shrink-0" />
                        {w >= 70 && <span className="truncate">{name}</span>}
                      </button>
                    )
                  })}
                  {track.clips.map((clip, k) => {
                    // An audio overlap: a thin teal band along the bottom of the clip its sound overlaps, from the cut.
                    const a = clip.cutAudio
                    if (!a || !adjoins(track.clips[k - 1], clip)) return null
                    const label = `${a.mode === "j" ? "J" : "L"}-cut ${secs(a.duration)} s`
                    return (
                      <div
                        key={`ca-${clip.id}`}
                        aria-hidden
                        title={label}
                        data-cut-audio={a.mode}
                        className="absolute bottom-0.5 z-[14] h-1 rounded-full bg-teal-500 ring-1 ring-teal-900/40 dark:bg-teal-300 dark:ring-teal-950/60"
                        style={{ left: (a.mode === "j" ? clip.start - a.duration : clip.start) * zoom, width: Math.max(2, a.duration * zoom) }}
                      />
                    )
                  })}
                  {(() => {
                    // The selected clip's cuts with a neighbour: a white circle on each opens its Transition / audio overlap dialog.
                    const k = !drag && !trim && selectedId ? track.clips.findIndex((c) => c.id === selectedId) : -1
                    if (k < 0) return null
                    const c = track.clips[k]
                    const next = track.clips[k + 1]
                    const cuts = [
                      ...(adjoins(track.clips[k - 1], c) ? [{ side: "before" as const, at: c.start, holder: c }] : []),
                      ...(adjoins(c, next) ? [{ side: "after" as const, at: clipEnd(c), holder: next }] : []),
                    ]
                    return cuts.map(({ side, at, holder }) => {
                      const tr = holder.transition
                      const a = holder.cutAudio
                      const set = [tr ? `${transitionName(tr.type)}, ${secs(tr.duration)} s` : "", a ? `${a.mode === "j" ? "J" : "L"}-cut ${secs(a.duration)} s` : ""].filter(Boolean).join("; ")
                      return (
                        <button
                          key={`cut-${side}`}
                          type="button"
                          aria-label={`Transition / audio overlap ${side} this clip${set ? `: ${set}` : ""}`}
                          title={set ? `Transition / audio overlap ${side} this clip: ${set}` : `Add a transition or audio overlap ${side} this clip`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => onTransition(holder.id)}
                          className={cn(
                            // On the clip's top border at the cut, so the trim handles below it stay free.
                            "absolute z-30 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full shadow-[0_1px_4px_rgb(0_0_0/0.45)] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            tight ? "top-1 h-4 w-4" : "top-2 h-5 w-5",
                            tr || a ? "bg-editor-accent text-editor-accent-foreground ring-2 ring-white" : "bg-white text-neutral-900 ring-1 ring-black/25 hover:bg-neutral-100"
                          )}
                          style={{ left: at * zoom }}
                        >
                          <Blend aria-hidden className={tight ? "h-2.5 w-2.5" : "h-3 w-3"} />
                        </button>
                      )
                    })
                  })()}
                  {target?.track === i && (isBase && magnetic ? insertLine(target.start) : ghost(target.start))}
                </div>
              </div>
            )
          })}
          <div className="pointer-events-none absolute top-6 bottom-0 z-20 w-px bg-editor-accent" style={{ left: header + playhead * zoom }} />
          {/* 2 px, centred on the snapped time, across every row: the same guide the preview draws. */}
          {guide !== null && <div aria-hidden className="pointer-events-none absolute top-6 bottom-0 z-30 w-0.5 -translate-x-1/2 bg-fuchsia-400" style={{ left: header + guide * zoom }} />}
        </div>
      </div>
      {snapHint && (
        // Over the view, not the scrolled content: top centre of the clips area, just under the ruler.
        <div
          aria-hidden
          className="pointer-events-none absolute top-7 z-50 -translate-x-1/2 whitespace-nowrap rounded-full bg-neutral-900/80 px-2.5 py-0.5 text-[11px] text-white shadow dark:bg-neutral-100/90 dark:text-neutral-900"
          style={{ left: header + Math.max(0, (viewport > 0 ? viewport : 600) - header) / 2 }}
        >
          {snapHint.off ? "Snapping off" : "Hold Alt to turn snapping off"}
        </div>
      )}
      <span className="sr-only" aria-live="polite">{notice?.text ?? ""}</span>
      {notice && !snapHint && (
        // Where the Alt hint goes; it stays while hovered or focused.
        <div
          className={cn(
            "absolute top-7 z-50 flex items-center gap-2 whitespace-nowrap rounded-full bg-neutral-900/90 py-0.5 pr-1 pl-3 text-[11px] text-white shadow dark:bg-neutral-100/95 dark:text-neutral-900",
            notice.anchor?.side === "left" ? "" : notice.anchor?.side === "right" ? "-translate-x-full" : "-translate-x-1/2"
          )}
          style={{ left: notice.anchor?.x ?? header + Math.max(0, (viewport > 0 ? viewport : 600) - header) / 2 }}
          onPointerEnter={() => setNoticeHeld(true)}
          onPointerLeave={() => setNoticeHeld(false)}
          onFocus={() => setNoticeHeld(true)}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setNoticeHeld(false)}
        >
          <span className={cn(!notice.unlink && !notice.group && "pr-2")}>{notice.text}</span>
          {notice.unlink && (
            <button
              type="button"
              className="rounded-full bg-white/15 px-2 py-0.5 font-medium hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:bg-black/10 dark:hover:bg-black/20"
              onClick={() => {
                const { id, cut } = notice.unlink!
                setNotice(null)
                onChange((p) => (cut ? unlinkCut(p, id) : unlinkClip(p, id)))
              }}
            >
              {notice.unlink.cut ? "Unlink this cut" : "Unlink this clip"}
            </button>
          )}
          {notice.group && (
            <button
              type="button"
              className="rounded-full bg-white/15 px-2 py-0.5 font-medium hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:bg-black/10 dark:hover:bg-black/20"
              onClick={notice.group.run}
            >
              Move all linked clips ({notice.group.count})
            </button>
          )}
          <button type="button" aria-label="Dismiss" className="rounded-full p-0.5 hover:bg-white/20 dark:hover:bg-black/10" onClick={() => setNotice(null)}>
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {menu && menuClip && <ClipMenu x={menu.x} y={menu.y} label="Clip" items={menuItems(menuClip)} onClose={closeMenu} />}
      {lengthClip && (
        <EditLengthDialog
          key={lengthClip.id}
          project={project}
          clip={lengthClip}
          track={lengthTrack}
          onUnlink={() => {
            const id = lengthClip.id
            onChange((p) => unlinkClip(p, id))
          }}
          onApply={(timing, mode) => {
            const id = lengthClip.id
            // At most one clip can be split around the new range, so one fresh id covers it.
            const pieceId = newId()
            onChange((p) => {
              const r = setClipTiming(p, id, timing, mode, () => pieceId)
              return r.ok ? r.project : p
            })
          }}
          onClose={() => {
            const id = lengthClip.id
            setLengthFor(null)
            // The dialog unmounts at once, so focus goes back to the clip here, after it's gone.
            setTimeout(() => clipEl(id)?.focus({ preventScroll: true }), 0)
          }}
        />
      )}
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
            className="min-h-0 w-4 flex-1 accent-editor-accent [direction:rtl] [writing-mode:vertical-lr]"
          />
        </div>
      )}
    </div>
  )
}
