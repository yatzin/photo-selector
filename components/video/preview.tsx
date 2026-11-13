"use client"

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react"
import { TriangleAlert } from "lucide-react"
import { zoomAway, zoomedTransform } from "@/lib/video/zoom-fullscreen"
import { assetKind, assetLabel, backgroundOf, clipLength, isStill, isTextClip, loopSourceId, MAX_TRACKS, setTransform, totalLength, trackStarts, type ActiveClip, type Clip, type Project } from "@/lib/video/project"
import { edgeLook, transitionLook, type LayerStyle, type TransitionLook } from "@/lib/video/transition-preview"
import { edgeAt, laneClipAt, laneElementAt, overlapAt, transitionAt } from "@/lib/video/transitions"
import { isTransitionType } from "@/lib/video/transition-types"
import { fontById, fontFamily } from "@/lib/video/fonts"
import { shadowOffset, textLayout, textSize, type ClipText } from "@/lib/video/text"
import { animationState, isAnimated, typewriterCuts, type AnimState } from "@/lib/video/text-animation"
import type { KeyOptions } from "@/lib/video/chroma"
import { clipRect, containsPoint, cropLeftOf, cropRightOf, IDENTITY, isIdentity, rotatedBounds, rotationOf, type Content, type Transform } from "@/lib/video/transform"
import { formatTimecode } from "@/lib/video/time"
import { clampViewZoom, wheelViewZoom, zoomAt } from "@/lib/video/viewer-zoom"
import { cn } from "@/lib/utils"
import { parseStockDrag } from "@/lib/stock/drag"
import type { StockRef } from "@/lib/stock/types"
import { ASSET_DRAG_TYPE, hasMediaDrag, INBOX_DRAG_TYPE, STOCK_DRAG_TYPE } from "./timeline"
import { FxCopies, FxOverlays, fxStyle, TransitionFxDefs, VideoMirror } from "./transition-layers"
import { KeyedVideo } from "./keyed-video"
import { ViewerZoomControl } from "./viewer-zoom-control"
import { TransformOverlay, type GestureState, type TransformTarget } from "./transform-overlay"
import type { PreviewPlayer } from "./use-preview-player"

/** A file from the left panel dropped on the canvas: a Project media item, or an Inbox file to import first. */
export type MediaDrop = { kind: "asset"; id: string } | { kind: "inbox"; folder: string; name: string } | { kind: "stock"; ref: StockRef }

const VIEW_PAD = 16 // px kept round the canvas inside the viewer
const HINT_ROOM = 26 // px the hint needs below the canvas to sit outside it

// The player above the timeline: a black canvas the project's shape. Each
// track has two stacked <video> elements that take turns (see
// use-preview-player). Every track with a clip at the playhead shows it,
// lowest track first, each picture fit to the canvas and then moved, scaled,
// flipped, cropped and turned by its clip's transform (lib/video/transform), so a lower layer
// shows wherever an upper one doesn't cover and black shows where nothing
// does (the project's background color, black unless set). A clip with no transform fills the canvas letterboxed in black, as it
// always has (and as the export draws it). An image clip shows as a still in its track's place, and a
// text clip as its text (TextPicture) in its content box, placed the same way, its in or out
// animation drawn as it is at the playhead (AnimatedText). Clicking the
// canvas selects a clip there and TransformOverlay edits it, with a hint
// about Alt below the canvas while a drag runs. A file dragged from the left
// panel onto the canvas is added at the playhead (onDrop). The area around
// the canvas is light gray. A clip the
// browser can't decode shows a message here and still exports, one whose file
// is missing says so (export fails on it). Play/Pause lives in the timeline's toolbar.
// Double-clicking a text clip on the canvas opens its Edit text dialog (onEditText).
// A clip's in or out edge transition is drawn on the clip itself, the other
// side nothing (the layers below show through), as the export draws it.

/**
 * Where a picture sits in the canvas box: its full rect in percent, the crop
 * as a clip-path inset of its own box, flips and the rotation as a CSS
 * transform about the box's centre (the content centre). The clip-path is cut
 * in the element's own, unflipped box before its transform, so a flip swaps
 * the insets it mirrors: the cut stays on the side the user sees, as the
 * canonical order says (flip, then a screen-axis crop, then the turn). With no
 * transform it fills the canvas, letterboxed in black (object-contain); a
 * text's box (`{ w, h }`) is placed at its own size, centred, even then.
 */
export function placement(aspect: Content, W: number, H: number, t: Transform, exact = false): CSSProperties {
  // `exact`: always the picture's own box (a keyed video's canvas, which has no letterboxing of its own).
  if (!exact && isIdentity(t) && typeof aspect === "number") return { left: 0, top: 0, width: "100%", height: "100%", backgroundColor: "black" }
  const r = clipRect(aspect, W, H, t)
  const cl = cropLeftOf(t)
  const cr = cropRightOf(t)
  const cropped = t.cropTop > 0 || t.cropBottom > 0 || cl > 0 || cr > 0
  const [top, bottom] = t.flipV ? [t.cropBottom, t.cropTop] : [t.cropTop, t.cropBottom]
  const [left, right] = t.flipH ? [cr, cl] : [cl, cr]
  const deg = rotationOf(t)
  const turn = [deg !== 0 ? `rotate(${deg}deg)` : "", t.flipH || t.flipV ? `scale(${t.flipH ? -1 : 1}, ${t.flipV ? -1 : 1})` : ""].filter(Boolean).join(" ")
  return {
    left: `${(r.x / W) * 100}%`,
    top: `${(r.y / H) * 100}%`,
    width: `${(r.w / W) * 100}%`,
    height: `${(r.h / H) * 100}%`,
    clipPath: cropped ? `inset(${top * 100}% ${right * 100}% ${bottom * 100}% ${left * 100}%)` : undefined,
    transform: turn || undefined,
  }
}

/** The font size the text is laid out at in its SVG; the viewBox scales it to the box on screen. */
const TEXT_LAYOUT_PX = 100

/**
 * A text clip's picture, filling its content box: each line of textLayout as
 * SVG text in the clip's bundled font, centred on its baseline, so it lands where the
 * export's drawtext puts it. Spaces are kept; nothing wraps. Hidden (its box
 * still placed) until the font has loaded, so it never shows in another font.
 */
export function TextPicture({ text, ready }: { text: ClipText; ready: boolean }) {
  const l = textLayout(text, TEXT_LAYOUT_PX)
  const off = text.shadow ? shadowOffset(text.shadow, TEXT_LAYOUT_PX) : null
  return (
    <svg viewBox={`0 0 ${l.w} ${l.h}`} preserveAspectRatio="none" aria-hidden className={cn("absolute inset-0 h-full w-full", !ready && "invisible")}>
      {l.lines.map((line, i) => {
        if (line.text.trim() === "") return null
        const style = { fontFamily: `"${fontFamily(fontById(text.font))}"`, whiteSpace: "pre" } as const
        return (
          <g key={i}>
            {text.shadow && off && (
              <text x={line.cx + off.dx} y={line.baseline + off.dy} textAnchor="middle" fill={text.shadow.color} fontSize={TEXT_LAYOUT_PX} style={style}>{line.text}</text>
            )}
            <text x={line.cx} y={line.baseline} textAnchor="middle" fill={text.color} fontSize={TEXT_LAYOUT_PX} style={style}>{line.text}</text>
          </g>
        )
      })}
    </svg>
  )
}

const pct = (n: number) => `${n * 100}%`

/** A transition's look for one picture (lib/video/transition-preview) as the style of its canvas-sized layer. */
export { fxStyle }

/**
 * z-index of a lane's pictures: the clip on show, under it a transition's
 * outgoing clip (over it when the look says, `fromOnTop`), and a transition's
 * overlays and tint over both.
 */
const laneZ = (lane: number, level: "outgoing" | "incoming" | "top" | "over") => 4 * lane + { outgoing: 1, incoming: 2, top: 3, over: 4 }[level]
const outgoingZ = (lane: number, fx: TransitionLook | null) => laneZ(lane, fx?.fromOnTop ? "top" : "outgoing")

/**
 * A sweep's or a typewriter's cut as a clip-path in the text box's own,
 * unflipped box. A sweep's side is on screen (after the flips, as the export
 * masks it), so a flip mirrors it here; the typewriter's units are the
 * text's own, before any flip, so they're used as they are.
 */
function animClip(s: AnimState, cuts: ReturnType<typeof typewriterCuts> | null, t: Transform): string | undefined {
  if (s.reveal) {
    const f = s.reveal.fraction
    const dir = s.reveal.dir
    let [x0, x1] = dir === "left" ? [0, f] : dir === "right" ? [1 - f, 1] : [0, 1]
    let [y0, y1] = dir === "up" ? [0, f] : dir === "down" ? [1 - f, 1] : [0, 1]
    if (t.flipH) [x0, x1] = [1 - x1, 1 - x0]
    if (t.flipV) [y0, y1] = [1 - y1, 1 - y0]
    return `inset(${pct(y0)} ${pct(1 - x1)} ${pct(1 - y1)} ${pct(x0)})`
  }
  const c = s.chars !== null && cuts ? cuts[s.chars] : undefined
  if (!c) return undefined
  // What shows: every row above the first hidden character's, and its row up to it.
  return `polygon(0 0, 100% 0, 100% ${pct(c.top)}, ${pct(c.x)} ${pct(c.top)}, ${pct(c.x)} ${pct(c.bottom)}, 0 ${pct(c.bottom)})`
}

/**
 * A text clip with an in or out animation, drawn as its animation is at the
 * playhead (lib/video/text-animation): only this follows the playhead at frame
 * rate (the player's subscribeFrame), so playing or scrubbing doesn't re-render
 * the rest of the editor for it. The slide's offset, the scale and the extra
 * turn move a canvas-sized layer about the content centre, on top of the
 * clip's own placement (`children`); the selection's handles stay on the
 * clip's resting frame.
 */
function AnimatedText({ player, clip, transform, W, H, total, zIndex, children }: {
  player: PreviewPlayer
  clip: Clip & { text: ClipText }
  transform: Transform
  W: number
  H: number
  total: number
  zIndex: number
  children: (clipPath: string | undefined) => ReactNode
}) {
  const now = useSyncExternalStore(player.subscribeFrame, player.frameTime, () => 0)
  const { text } = clip
  const typing = text.animIn?.type === "typewriter" || text.animOut?.type === "typewriter"
  const cuts = useMemo(() => (typing ? typewriterCuts(text) : null), [typing, text])
  const look = now >= total ? Math.max(0, total - 0.001) : now
  const length = clipLength(clip)
  const b = rotatedBounds(textSize(text, Math.min(W, H)), W, H, transform)
  const s = animationState(text, Math.max(0, Math.min(length, look - clip.start)), length, {
    bounds: { x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H },
    units: cuts?.length ?? 0,
  })
  return (
    <div
      className="absolute inset-0"
      style={{
        zIndex,
        opacity: s.opacity,
        transform: `translate(${pct(s.offsetX)}, ${pct(s.offsetY)}) rotate(${s.rotationDeg}deg) scale(${s.scale})`,
        transformOrigin: `${pct(0.5 + transform.x)} ${pct(0.5 + transform.y)}`,
      }}
    >
      {children(animClip(s, cuts, transform))}
    </div>
  )
}

/** The CSS families of `families` (one a line) that have loaded; a font that fails to load counts too (its text then shows in a fallback). */
function useLoadedFonts(families: string): ReadonlySet<string> {
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    let live = true
    for (const family of families.split("\n")) {
      if (!family) continue
      const done = () => live && setLoaded((s) => (s.has(family) ? s : new Set(s).add(family)))
      document.fonts.load(`${TEXT_LAYOUT_PX}px "${family}"`).then(done, done)
    }
    return () => {
      live = false
    }
  }, [families])
  return loaded
}

export function Preview({
  player, project, imageUrl, selectedId, onSelect, onChange, onDrop, onEditText, onBackgroundMenu,
}: {
  player: PreviewPlayer
  project: Project
  imageUrl: (assetId: string, key?: KeyOptions) => string
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Applies an edit to the current project; `group` merges quick repeats into one undo step. */
  onChange: (edit: (p: Project) => Project, group?: string) => void
  /** A file from the left panel was dropped on the canvas: add it at the playhead. */
  onDrop: (drop: MediaDrop) => void
  /** A text clip was double-clicked on the canvas: edit its text. */
  onEditText: (id: string) => void
  /** Right-click on the canvas where no clip is: open the background color picker at the pointer (absent while the project exports). */
  onBackgroundMenu?: (x: number, y: number) => void
}) {
  const [brokenImage, setBrokenImage] = useState<string | null>(null)
  // A canvas drag in progress (for the Alt hint), and a file dragged over the canvas.
  const [gesture, setGesture] = useState<GestureState>(null)
  const [dropOver, setDropOver] = useState(false)
  // Each asset's picture aspect (width / height), learnt from the loaded video or image.
  const [aspects, setAspects] = useState<Record<string, number>>({})
  // The transform being dragged, shown instead of the clip's until it's committed.
  const [draft, setDraft] = useState<{ id: string; transform: Transform } | null>(null)
  // WebGL is missing: keyed videos show unkeyed rather than not at all.
  const [keyFailed, setKeyFailed] = useState(false)
  const { width: W, height: H } = project
  // The viewer: `frame` is the fixed pane; the scroller inside it scrolls when the zoomed canvas is bigger.
  const area = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  // View zoom (1 = the canvas fit in the pane), reset when the project's shape changes.
  const [zoom, setZoomState] = useState(1)
  const zoomRef = useRef(1)
  const shape = `${W}x${H}`
  const [shapeSeen, setShapeSeen] = useState(shape)
  if (shapeSeen !== shape) {
    setShapeSeen(shape)
    setZoomState(1)
  }
  useLayoutEffect(() => {
    zoomRef.current = zoom
  }, [zoom])
  // The canvas fit inside the pane (less its padding), and the pane's own size.
  const [fit, setFit] = useState<{ w: number; h: number; fw: number; fh: number } | null>(null)
  // The scroll a zoom wants once the new size is laid out.
  const pendingScroll = useRef<{ x: number; y: number } | null>(null)
  // The part of the pane visible, in px from the canvas's top left (the floating buttons stay inside it).
  const [view, setView] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null)
  // `below`: the px between the canvas's bottom and the pane's; `side` the same to the left or right (0 once it overflows).
  const box = fit
    ? (() => {
        const w = Math.max(1, Math.floor(fit.w * zoom))
        const h = Math.max(1, Math.floor((w * H) / W))
        return { w, h, below: Math.max(0, Math.floor((fit.fh - h) / 2)), side: Math.max(0, Math.floor((fit.fw - w) / 2)) }
      })()
    : null

  const setZoom = (z: number, pointer?: { x: number; y: number }) => {
    const next = clampViewZoom(z)
    const el = scroller.current
    if (el && fit) {
      // Zoom about the pointer, or the pane's centre.
      const at = pointer ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 }
      const from = pendingScroll.current ?? { x: el.scrollLeft, y: el.scrollTop }
      pendingScroll.current = zoomAt(from, { fitW: fit.w, fitH: fit.h, viewW: el.clientWidth, viewH: el.clientHeight, pad: VIEW_PAD }, at, zoomRef.current, next)
    }
    zoomRef.current = next
    setZoomState(next)
  }

  useEffect(() => {
    const el = area.current
    if (!el) return
    const measure = () => {
      const fw = el.clientWidth
      const fh = el.clientHeight
      const aw = fw - 2 * VIEW_PAD
      const ah = fh - 2 * VIEW_PAD
      if (!(aw > 0 && ah > 0)) return
      const w = Math.floor(Math.min(aw, (ah * W) / H))
      const h = Math.floor((w * H) / W)
      setFit((f) => (f && f.w === w && f.h === h && f.fw === fw && f.fh === fh ? f : { w, h, fw, fh }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [W, H])

  // After a zoom is laid out: apply its scroll; then keep `view` current.
  const readView = () => {
    const s = scroller.current
    const c = canvas.current
    if (!s || !c) return
    const sr = s.getBoundingClientRect()
    const cr = c.getBoundingClientRect()
    const left = Math.round(sr.left + s.clientLeft - cr.left)
    const top = Math.round(sr.top + s.clientTop - cr.top)
    const next = { left, top, right: left + s.clientWidth, bottom: top + s.clientHeight }
    setView((v) => (v && v.left === next.left && v.top === next.top && v.right === next.right && v.bottom === next.bottom ? v : next))
  }
  useLayoutEffect(() => {
    const s = scroller.current
    const p = pendingScroll.current
    if (s && p) {
      pendingScroll.current = null
      s.scrollLeft = p.x
      s.scrollTop = p.y
    }
    readView()
  })

  // The wheel zooms about the pointer (a native, non-passive listener so it can stop the page scrolling).
  useEffect(() => {
    const el = area.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const s = scroller.current
      if (!s) return
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1
      const dy = e.deltaY !== 0 ? e.deltaY : e.deltaX
      const r = s.getBoundingClientRect()
      setZoom(wheelViewZoom(zoomRef.current, dy * unit), { x: e.clientX - r.left - s.clientLeft, y: e.clientY - r.top - s.clientTop })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  })

  // A click (a press and release that hardly moves) on the gray around the canvas, not on a scrollbar, clears the selection.
  const gray = useRef<{ id: number; x: number; y: number } | null>(null)
  function grayDown(e: React.PointerEvent<HTMLDivElement>) {
    gray.current = null
    if (e.button !== 0 || !(e.target instanceof Element) || e.target.closest("[data-transform-overlay]")) return
    const s = e.currentTarget
    const r = s.getBoundingClientRect()
    const x = e.clientX - r.left - s.clientLeft
    const y = e.clientY - r.top - s.clientTop
    if (x < 0 || y < 0 || x >= s.clientWidth || y >= s.clientHeight) return // a scrollbar
    gray.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
  }
  function grayUp(e: React.PointerEvent<HTMLDivElement>) {
    const g = gray.current
    gray.current = null
    if (g && g.id === e.pointerId && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 4) onSelect(null)
  }

  // The copies a looping clip plays as (the player's own expansion), so lanes, clip indexes and the player's slots line up; ids map back with loopSourceId.
  const playback = player.playback
  const total = totalLength(playback)
  const hasClips = total > 0
  // At the end the last frame stays up.
  const look = player.time >= total ? Math.max(0, total - 0.001) : player.time
  // The clip each track shows (through a transition, the incoming one), the topmost of them, and each track's running transition.
  const hits: (ActiveClip | null)[] = playback.tracks.map((t, track) => {
    const at = laneClipAt(t, look)
    return at && { track, ...at, clip: t.clips[at.index] }
  })
  const top = hits.reduce<ActiveClip | null>((above, h) => h ?? above, null)
  const windows = playback.tracks.map((t) => transitionAt(t, look))
  // Each lane's look: its running transition's, else its clip's running edge transition's (against nothing, lib/video/transition-preview edgeLook).
  const looks = playback.tracks.map((_, lane): TransitionLook | null => {
    const w = windows[lane]
    if (w) return isTransitionType(w.type) ? transitionLook(w.type, w.progress, W / H, { outgoing: playback.tracks[lane].clips[w.from]?.transform, incoming: hits[lane]?.clip.transform }) : null
    const hit = hits[lane]
    const e = hit ? edgeAt(hit.clip, look) : null
    return e && isTransitionType(e.type) ? edgeLook(e.type, e.edge, e.progress, W / H) : null
  })
  const currentAsset = top?.clip.asset
  const cantPlay = currentAsset !== undefined && player.failed.has(currentAsset)
  const missing = currentAsset !== undefined && player.missing.has(currentAsset)

  const isImage = (clip: Clip | undefined) => {
    const asset = clip && !isTextClip(clip) ? project.assets[clip.asset] : undefined
    return asset !== undefined && assetKind(asset) === "image"
  }
  const transformOf = (clip: Clip) => (draft?.id === loopSourceId(clip.id) ? draft.transform : clip.transform ?? IDENTITY)
  const aspectOf = (assetId: string) => aspects[assetId] ?? W / H
  /**
   * A picture or video clip's place as it shows now: with a zoom cut's zoom running inside it (lib/video/zoom-fullscreen),
   * moved part of the way to full screen (the handles keep the clip's own place, transformOf). A clip with a zoom is
   * always placed in its own box: no black letterbox, as in the export, where the canvas color shows.
   */
  const hasZoom = (clip: Clip) => !isTextClip(clip) && (clip.zoomIn !== undefined || clip.zoomOut !== undefined)
  const shownPlacement = (clip: Clip, exact = false) => {
    const t = transformOf(clip)
    const away = hasZoom(clip) ? zoomAway(clip, clipLength(clip), look - clip.start) : 0
    return placement(aspectOf(clip.asset), W, H, zoomedTransform(t, away), exact || hasZoom(clip))
  }
  /** What clipRect places for a clip: a text's content box, else its picture's aspect. */
  const contentOf = (clip: Clip): Content => (isTextClip(clip) ? textSize(clip.text, Math.min(W, H)) : aspectOf(clip.asset))
  const learnAspect = (assetId: string | null, w: number, h: number) => {
    if (!assetId || !(w > 0 && h > 0)) return
    const ratio = w / h
    setAspects((a) => (a[assetId] === ratio ? a : { ...a, [assetId]: ratio }))
  }
  /** A still (an image's picture or a text) in a canvas-sized layer at `zIndex`, styled by a transition's look (and copies of it, `copies`); null for a video. */
  const stillLayer = (clip: Clip, zIndex: number, fx: LayerStyle | undefined, copies?: LayerStyle[]) => {
    let inner: ReactNode
    if (isTextClip(clip)) {
      const ready = loadedFonts.has(fontFamily(fontById(clip.text.font)))
      inner = isAnimated(clip.text) ? (
        <AnimatedText player={player} clip={clip} transform={transformOf(clip)} W={W} H={H} total={total} zIndex={0}>
          {(clipPath) => (
            <div className="absolute" style={placement(contentOf(clip), W, H, transformOf(clip))}>
              <div className="absolute inset-0" style={{ clipPath }}>
                <TextPicture text={clip.text} ready={ready} />
              </div>
            </div>
          )}
        </AnimatedText>
      ) : (
        <div className="absolute" style={placement(contentOf(clip), W, H, transformOf(clip))}>
          <TextPicture text={clip.text} ready={ready} />
        </div>
      )
    } else {
      const still = isImage(clip) ? imageUrl(clip.asset, clip.key) : ""
      if (!still) return null
      inner = (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={still}
          alt=""
          draggable={false}
          className="absolute max-w-none object-contain"
          style={shownPlacement(clip)}
          onLoad={(e) => learnAspect(clip.asset, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
          onError={() => setBrokenImage(still)}
        />
      )
    }
    return (
      <Fragment key={clip.id}>
        <div className="absolute inset-0" style={{ zIndex, ...fxStyle(fx) }}>
          {inner}
        </div>
        <FxCopies styles={copies} zIndex={zIndex} id={clip.id}>{inner}</FxCopies>
      </Fragment>
    )
  }

  const lanes = playback.tracks.slice(0, MAX_TRACKS)
  // Every text clip's font, loaded ahead (not only the ones at the playhead), so playing on to a text doesn't wait for it.
  const textFonts = [...new Set(playback.tracks.flatMap((t) => t.clips.filter(isTextClip).map((c) => fontFamily(fontById(c.text.font)))))].sort().join("\n")
  const loadedFonts = useLoadedFonts(textFonts)
  const topImage = top && isImage(top.clip) ? imageUrl(top.clip.asset, top.clip.key) : ""

  const target = (clip: Clip, lane: number): TransformTarget => ({
    id: loopSourceId(clip.id),
    label: `Layer ${lane + 1}, ${isTextClip(clip) ? `text "${clip.text.content}"` : (Object.hasOwn(project.assets, clip.asset) ? assetLabel(project.assets[clip.asset]) : "missing file")}`,
    aspect: contentOf(clip),
    transform: transformOf(clip),
    canFill: !isTextClip(clip),
  })
  const selectedHit = hits.find((h) => h && loopSourceId(h.clip.id) === selectedId)
  const selected = selectedHit ? target(selectedHit.clip, selectedHit.track) : null
  /** The topmost clip at the playhead that covers canvas point x, y (its visible strip as it shows, turned too; with no transform, the whole canvas, but a text only its box). */
  const hitTest = (x: number, y: number): TransformTarget | null => {
    for (let lane = hits.length - 1; lane >= 0; lane--) {
      const hit = hits[lane]
      if (!hit) continue
      const t = transformOf(hit.clip)
      const on = isIdentity(t) && !isTextClip(hit.clip) ? x >= 0 && x <= W && y >= 0 && y <= H : containsPoint(contentOf(hit.clip), W, H, t, x, y)
      if (on) return target(hit.clip, lane)
    }
    return null
  }

  // The next clip on each track, when it's an image: fetched before the cut so a cut to it doesn't flash black.
  const nextStills = playback.tracks
    .map((track, i) => {
      const hit = hits[i]
      const starts = trackStarts(track)
      const next = hit ? track.clips[hit.index + 1] : track.clips[starts.findIndex((s) => s > look)]
      const a = next && !isTextClip(next) ? project.assets[next.asset] : undefined
      return next && a && assetKind(a) === "image" ? imageUrl(next.asset, next.key) : ""
    })
    .filter(Boolean)
    .join("\n")
  useEffect(() => {
    for (const url of nextStills.split("\n")) if (url) new Image().src = url
  }, [nextStills])

  // A drag that ends anywhere (dropped elsewhere, or Esc) takes the canvas's drop highlight with it.
  useEffect(() => {
    const clear = () => setDropOver(false)
    window.addEventListener("dragend", clear)
    window.addEventListener("drop", clear)
    return () => {
      window.removeEventListener("dragend", clear)
      window.removeEventListener("drop", clear)
    }
  }, [])

  function dragOver(e: React.DragEvent) {
    if (!hasMediaDrag(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
    setDropOver(true)
  }

  function dragLeave(e: React.DragEvent) {
    // Moving onto the overlay or a handle inside the canvas isn't leaving it.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    setDropOver(false)
  }

  function drop(e: React.DragEvent) {
    setDropOver(false)
    const id = e.dataTransfer.getData(ASSET_DRAG_TYPE)
    const inbox = e.dataTransfer.getData(INBOX_DRAG_TYPE)
    const stock = e.dataTransfer.getData(STOCK_DRAG_TYPE)
    if (!id && !inbox && !stock) return
    e.preventDefault()
    if (id) return onDrop({ kind: "asset", id })
    if (stock) {
      const r = parseStockDrag(stock)
      if (r) onDrop({ kind: "stock", ref: { source: r.source, id: r.id, kind: r.kind } })
      return
    }
    try {
      const { folder, name } = JSON.parse(inbox) as { folder?: unknown; name?: unknown }
      if (typeof folder === "string" && typeof name === "string") onDrop({ kind: "inbox", folder, name })
    } catch {
      // Not our drag after all.
    }
  }

  // The Alt hint: below the canvas when the gray margin has room for it, else inside at the bottom.
  // The overlay (and any drag on it) goes when the last clip does.
  if (!hasClips && gesture) setGesture(null)
  const hint = hasClips && gesture ? (gesture.snapping ? (gesture.hundred ? "Snapped to 100% — hold Alt to turn snapping off" : "Hold Alt to turn snapping off") : "Snapping off") : null
  const hintOutside = box !== null && (zoom > 1 || box.below >= HINT_ROOM)
  const hintPill = (className: string) => (
    <div aria-hidden className={cn("pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-full bg-neutral-900/80 px-2.5 py-0.5 text-[11px] text-white shadow dark:bg-neutral-100/90 dark:text-neutral-900", className)}>
      {hint}
    </div>
  )

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-neutral-200 dark:bg-neutral-700">
      <div ref={area} className="relative min-h-0 min-w-0 flex-1">
      {/* Scrolls (native scrollbars) once the zoomed canvas outgrows the pane; a click on the gray clears the selection. */}
      <div ref={scroller} className="absolute inset-0 overflow-auto" onPointerDown={grayDown} onPointerUp={grayUp} onPointerCancel={() => (gray.current = null)}>
      <div className={cn("flex items-center justify-center", box ? "h-max min-h-full w-max min-w-full" : "h-full w-full")} style={{ padding: VIEW_PAD }}>
        <div
          ref={canvas}
          className={cn("relative shrink-0", !box && "max-h-full max-w-full")}
          style={box ? { width: box.w, height: box.h } : { height: "100%", aspectRatio: `${W} / ${H}` }}
          onDragOver={dragOver}
          onDragLeave={dragLeave}
          onDrop={drop}
          onContextMenu={(e) => {
            const r = canvas.current?.getBoundingClientRect()
            if (!onBackgroundMenu || !r || r.width === 0 || r.height === 0) return
            if (hitTest(((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H)) return
            e.preventDefault()
            onBackgroundMenu(e.clientX, e.clientY)
          }}
        >
          {/* isolate: the layers' z-index stays inside the canvas, under the overlay. */}
          <div className="absolute inset-0 isolate overflow-hidden rounded-md" style={{ backgroundColor: backgroundOf(project) }}>
            <TransitionFxDefs />
            {/* Each video sits in a canvas-sized layer that a transition styles (lib/video/transition-preview). */}
            {lanes.map((track, lane) => {
              const clip = hits[lane]?.clip
              const w = windows[lane]
              const from = w ? track.clips[w.from] : undefined
              const fx = looks[lane]
              // What the player's slots hold: the lane's own video (through an overlap, the incoming one from its
              // start, a J-cut's lead too) and the overlap's outgoing video as the tail, in the other slot or under a still.
              const own = laneElementAt(track, look)
              const ownClip = own ? track.clips[own.index] : undefined
              const ow = overlapAt(track, look)
              const tailClip = ow && !isStill(project, track.clips[ow.from]) ? track.clips[ow.from] : undefined
              const ownVideo = ownClip !== undefined && !isStill(project, ownClip)
              const tailSlot = tailClip ? (ownVideo ? 1 - player.active[lane] : player.active[lane]) : -1
              return [0, 1].map((slot) => {
                const held = slot === tailSlot ? tailClip : ownVideo && player.active[lane] === slot ? ownClip : undefined
                // A held video shows when it's the picture there (laneClipAt), or the outgoing one of a running transition;
                // an audio overlap's video outside the transition plays on unseen.
                const outgoing = held !== undefined && held === from
                const shown = held !== undefined && (held === clip || outgoing) ? held : undefined
                const z = outgoing ? outgoingZ(lane, fx) : laneZ(lane, "incoming")
                const videoStyle = shown ? shownPlacement(shown) : undefined
                // A keyed clip is drawn by a canvas (the shader); its video plays unseen.
                const keyed = shown?.key && !keyFailed ? shown.key : undefined
                return (
                  <Fragment key={`${lane}-${slot}`}>
                    <div className="absolute inset-0" style={shown ? { zIndex: z, ...fxStyle(outgoing ? fx?.from : fx?.to) } : { zIndex: 0 }}>
                      <video
                        ref={(v) => player.attach(lane, slot, v)}
                        playsInline
                        preload="auto"
                        aria-hidden={!shown}
                        onError={() => player.onVideoError(lane, slot)}
                        onCanPlay={() => player.onVideoPlayable(lane, slot)}
                        onLoadedMetadata={(e) => learnAspect(player.assetIn(lane, slot), e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
                        onResize={(e) => learnAspect(player.assetIn(lane, slot), e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
                        className={cn("absolute max-w-none object-contain", shown && !keyed ? "opacity-100" : shown ? "opacity-0" : "inset-0 h-full w-full opacity-0")}
                        style={videoStyle}
                      />
                      {shown && keyed && (
                        <KeyedVideo
                          video={() => player.videoAt(lane, slot)}
                          keyColor={keyed.key}
                          tolerance={keyed.tolerance}
                          style={shownPlacement(shown, true)}
                          onUnsupported={() => setKeyFailed(true)}
                        />
                      )}
                    </div>
                    {shown && (
                      <FxCopies styles={outgoing ? fx?.fromCopies : fx?.toCopies} zIndex={z} id={`${lane}-${slot}`}>
                        <VideoMirror video={() => player.videoAt(lane, slot)} className="absolute object-contain" style={videoStyle} />
                      </FxCopies>
                    )}
                  </Fragment>
                )
              })
            })}
            {/* The audio layer's two elements (use-preview-player): sound only, nothing to see. */}
            {[0, 1].map((slot) => (
              <audio key={`audio-${slot}`} ref={(a) => player.attachAudio(slot, a)} preload="auto" data-audio-slot={slot} hidden />
            ))}
            {/* Stills after the videos in the DOM, so a still coming and going never moves (and so pauses) a video. */}
            {lanes.map((track, lane) => {
              const clip = hits[lane]?.clip
              const w = windows[lane]
              const from = w ? track.clips[w.from] : undefined
              const fx = looks[lane]
              return (
                <Fragment key={`stills-${lane}`}>
                  {from && stillLayer(from, outgoingZ(lane, fx), fx?.from, fx?.fromCopies)}
                  {clip && stillLayer(clip, laneZ(lane, "incoming"), fx?.to, fx?.toCopies)}
                  <FxOverlays overlays={fx?.overlays} zIndex={laneZ(lane, "over")} />
                  {fx?.tint && <div aria-hidden className="absolute inset-0" style={{ zIndex: laneZ(lane, "over"), background: fx.tint.color, opacity: fx.tint.opacity }} />}
                </Fragment>
              )
            })}
            {topImage && brokenImage === topImage && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/80 px-6 text-center text-sm text-white/80">
                <TriangleAlert className="h-5 w-5" />
                This image is missing from the project or can&apos;t be shown.
              </div>
            )}
            {!hasClips && (
              <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-white/60">Drag media here or onto the timeline</div>
            )}
            {cantPlay && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/80 px-6 text-center text-sm text-white/80">
                <TriangleAlert className="h-5 w-5" />
                {missing
                  ? "This clip's file is missing from the project, so it can't play or export. Remove it from the timeline."
                  : "Can't preview this clip in your browser. It will still export."}
              </div>
            )}
          </div>
          {hasClips && (
            <TransformOverlay
              width={W}
              height={H}
              displayWidth={box?.w}
              room={box ? { x: box.side, y: box.below } : undefined}
              view={view ?? undefined}
              selected={selected}
              hitTest={hitTest}
              onSelect={onSelect}
              onDraft={setDraft}
              onCommit={(id, t, group) => onChange((p) => setTransform(p, id, t), group)}
              onGesture={setGesture}
              onDoubleClickClip={(id) => {
                if (hits.some((h) => h && loopSourceId(h.clip.id) === id && isTextClip(h.clip))) onEditText(id)
              }}
            />
          )}
          {hint && !hintOutside && hintPill("bottom-3")}
          {dropOver && (
            // Above the overlay, and never in the way of the drop itself.
            <div className="pointer-events-none absolute -inset-1 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-sky-500 bg-sky-500/10 dark:border-editor-accent dark:bg-editor-accent/10">
              <span className="rounded-md bg-neutral-900/80 px-2.5 py-1 text-xs text-white shadow">Drop to add at {formatTimecode(player.time)}</span>
            </div>
          )}
        </div>
      </div>
      </div>
      {hint && hintOutside && hintPill("bottom-1")}
      </div>
      <div className="flex shrink-0 items-stretch py-4 pr-2">
        <ViewerZoomControl zoom={zoom} onChange={(z) => setZoom(z)} />
      </div>
    </div>
  )
}
