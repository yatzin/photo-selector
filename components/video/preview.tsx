"use client"

import { useEffect, useRef, useState, type CSSProperties } from "react"
import { Pause, Play, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { assetKind, clipsAt, MAX_TRACKS, setTransform, totalLength, trackStarts, type Clip, type Project } from "@/lib/video/project"
import { clipRect, cropLeftOf, cropRightOf, IDENTITY, isIdentity, type Transform } from "@/lib/video/transform"
import { cn } from "@/lib/utils"
import { TransformOverlay, type TransformTarget } from "./transform-overlay"
import type { PreviewPlayer } from "./use-preview-player"

// The player above the timeline: a black canvas the project's shape. Each
// track has two stacked <video> elements that take turns (see
// use-preview-player). Every track with a clip at the playhead shows it,
// lowest track first, each picture fit to the canvas and then moved, scaled
// and cropped by its clip's transform (lib/video/transform), so a lower layer
// shows wherever an upper one doesn't cover and black shows where nothing
// does. A clip with no transform fills the canvas letterboxed in black, as it
// always has (and as the export draws it). An image clip shows as a still in its track's place. Clicking the
// canvas selects a clip there and TransformOverlay edits it. A clip the
// browser can't decode shows a message here and still exports, one whose file
// is missing says so (export fails on it).

/**
 * Where a picture sits in the canvas box: its full rect in percent, the crop
 * as a clip-path inset of its own box. With no transform it fills the canvas,
 * letterboxed in black (object-contain).
 */
function placement(aspect: number, W: number, H: number, t: Transform): CSSProperties {
  if (isIdentity(t)) return { left: 0, top: 0, width: "100%", height: "100%", backgroundColor: "black" }
  const r = clipRect(aspect, W, H, t)
  const cl = cropLeftOf(t)
  const cr = cropRightOf(t)
  const cropped = t.cropTop > 0 || t.cropBottom > 0 || cl > 0 || cr > 0
  return {
    left: `${(r.x / W) * 100}%`,
    top: `${(r.y / H) * 100}%`,
    width: `${(r.w / W) * 100}%`,
    height: `${(r.h / H) * 100}%`,
    clipPath: cropped ? `inset(${t.cropTop * 100}% ${cr * 100}% ${t.cropBottom * 100}% ${cl * 100}%)` : undefined,
  }
}

export function Preview({
  player, project, imageUrl, selectedId, onSelect, onChange,
}: {
  player: PreviewPlayer
  project: Project
  imageUrl: (assetId: string) => string
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Applies an edit to the current project; `group` merges quick repeats into one undo step. */
  onChange: (edit: (p: Project) => Project, group?: string) => void
}) {
  const [brokenImage, setBrokenImage] = useState<string | null>(null)
  // Each asset's picture aspect (width / height), learnt from the loaded video or image.
  const [aspects, setAspects] = useState<Record<string, number>>({})
  // The transform being dragged, shown instead of the clip's until it's committed.
  const [draft, setDraft] = useState<{ id: string; transform: Transform } | null>(null)
  // The canvas box's size on screen: the project's shape fit inside the area.
  const area = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  const { width: W, height: H } = project

  useEffect(() => {
    const el = area.current
    if (!el) return
    const measure = () => {
      const aw = el.clientWidth
      const ah = el.clientHeight
      if (!(aw > 0 && ah > 0)) return
      const w = Math.min(aw, (ah * W) / H)
      const next = { w: Math.floor(w), h: Math.floor((w * H) / W) }
      setBox((b) => (b && b.w === next.w && b.h === next.h ? b : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [W, H])

  const total = totalLength(project)
  const hasClips = total > 0
  // At the end the last frame stays up.
  const look = player.time >= total ? Math.max(0, total - 0.001) : player.time
  const { tracks: hits, top } = clipsAt(project, look)
  const currentAsset = top?.clip.asset
  const cantPlay = currentAsset !== undefined && player.failed.has(currentAsset)
  const missing = currentAsset !== undefined && player.missing.has(currentAsset)

  const isImage = (clip: Clip | undefined) => {
    const asset = clip && project.assets[clip.asset]
    return asset !== undefined && assetKind(asset) === "image"
  }
  const transformOf = (clip: Clip) => (draft?.id === clip.id ? draft.transform : clip.transform ?? IDENTITY)
  const aspectOf = (assetId: string) => aspects[assetId] ?? W / H
  const learnAspect = (assetId: string | null, w: number, h: number) => {
    if (!assetId || !(w > 0 && h > 0)) return
    const ratio = w / h
    setAspects((a) => (a[assetId] === ratio ? a : { ...a, [assetId]: ratio }))
  }
  const lanes = project.tracks.slice(0, MAX_TRACKS)
  const topImage = top && isImage(top.clip) ? imageUrl(top.clip.asset) : ""

  const target = (clip: Clip, lane: number): TransformTarget => ({
    id: clip.id,
    label: `Layer ${lane + 1}, ${project.assets[clip.asset]?.file ?? "missing file"}`,
    aspect: aspectOf(clip.asset),
    transform: transformOf(clip),
  })
  const selectedHit = hits.find((h) => h?.clip.id === selectedId)
  const selected = selectedHit ? target(selectedHit.clip, selectedHit.track) : null
  /** The topmost clip at the playhead that covers canvas point x, y (its visible strip; with no transform, the whole canvas). */
  const hitTest = (x: number, y: number): TransformTarget | null => {
    for (let lane = hits.length - 1; lane >= 0; lane--) {
      const hit = hits[lane]
      if (!hit) continue
      const t = transformOf(hit.clip)
      const v = isIdentity(t) ? { x: 0, y: 0, w: W, h: H } : clipRect(aspectOf(hit.clip.asset), W, H, t).visible
      if (x >= v.x && x <= v.x + v.w && y >= v.y && y <= v.y + v.h) return target(hit.clip, lane)
    }
    return null
  }

  // The next clip on each track, when it's an image: fetched before the cut so a cut to it doesn't flash black.
  const nextStills = project.tracks
    .map((track, i) => {
      const hit = hits[i]
      const starts = trackStarts(track)
      const next = hit ? track.clips[hit.index + 1] : track.clips[starts.findIndex((s) => s > look)]
      const a = next && project.assets[next.asset]
      return next && a && assetKind(a) === "image" ? imageUrl(next.asset) : ""
    })
    .filter(Boolean)
    .join("\n")
  useEffect(() => {
    for (const url of nextStills.split("\n")) if (url) new Image().src = url
  }, [nextStills])

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-black/90 p-4">
      <div ref={area} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center">
        <div
          className={cn("relative", !box && "max-h-full max-w-full")}
          style={box ? { width: box.w, height: box.h } : { height: "100%", aspectRatio: `${W} / ${H}` }}
        >
          {/* isolate: the layers' z-index stays inside the canvas, under the overlay and the play button. */}
          <div className="absolute inset-0 isolate overflow-hidden rounded-md bg-black">
            {lanes.map((track, lane) =>
              [0, 1].map((slot) => {
                const clip = hits[lane]?.clip
                const shown = clip !== undefined && !isImage(clip) && player.active[lane] === slot
                return (
                  <video
                    key={`${lane}-${slot}`}
                    ref={(v) => player.attach(lane, slot, v)}
                    playsInline
                    preload="auto"
                    aria-hidden={!shown}
                    onError={() => player.onVideoError(lane, slot)}
                    onLoadedMetadata={(e) => learnAspect(player.assetIn(lane, slot), e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
                    onResize={(e) => learnAspect(player.assetIn(lane, slot), e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
                    className={cn("absolute object-contain", shown ? "opacity-100" : "inset-0 h-full w-full opacity-0")}
                    style={shown ? { ...placement(aspectOf(clip.asset), W, H, transformOf(clip)), zIndex: lane + 1 } : { zIndex: 0 }}
                  />
                )
              })
            )}
            {/* Stills after the videos in the DOM, so a still coming and going never moves (and so pauses) a video. */}
            {lanes.map((track, lane) => {
              const clip = hits[lane]?.clip
              if (!clip || !isImage(clip)) return null
              const still = imageUrl(clip.asset)
              if (!still) return null
              return (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={`still-${lane}`}
                  src={still}
                  alt=""
                  draggable={false}
                  className="absolute object-contain"
                  style={{ ...placement(aspectOf(clip.asset), W, H, transformOf(clip)), zIndex: lane + 1 }}
                  onLoad={(e) => learnAspect(clip.asset, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
                  onError={() => setBrokenImage(still)}
                />
              )
            })}
            {topImage && brokenImage === topImage && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/80 px-6 text-center text-sm text-white/80">
                <TriangleAlert className="h-5 w-5" />
                This image is missing from the project or can&apos;t be shown.
              </div>
            )}
            {!hasClips && (
              <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-white/60">Import a clip and add it to the timeline</div>
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
              selected={selected}
              hitTest={hitTest}
              onSelect={onSelect}
              onDraft={setDraft}
              onCommit={(id, t, group) => onChange((p) => setTransform(p, id, t), group)}
            />
          )}
          {hasClips && (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              onClick={player.toggle}
              className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full opacity-80 hover:opacity-100"
              title={player.playing ? "Pause (Space)" : "Play (Space)"}
            >
              {player.playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              <span className="sr-only">{player.playing ? "Pause" : "Play"}</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
