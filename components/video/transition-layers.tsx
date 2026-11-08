"use client"

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react"
import { WHIP_BLUR, WHIP_LEVELS } from "@/lib/video/transition-fx"
import { TRANSITION_FILTERS, type LayerStyle, type Overlay } from "@/lib/video/transition-preview"

// The pieces the app's own transitions draw beside the two pictures
// (lib/video/transition-preview): copies of a picture, overlays and the SVG
// filters they name. A copy of a video is a canvas that mirrors the video's
// current frame, placed exactly as the video is (the same box and
// object-fit), drawn again whenever the frame changes; a copy of a still is
// the still again.

/** A transition's look for one layer as its style. */
export const fxStyle = (s: LayerStyle | undefined): CSSProperties =>
  s
    ? {
        opacity: s.opacity, transform: s.transform, transformOrigin: s.transformOrigin, clipPath: s.clipPath, filter: s.filter, mixBlendMode: s.mixBlendMode,
        maskImage: s.maskImage, WebkitMaskImage: s.maskImage, maskSize: s.maskSize, WebkitMaskSize: s.maskSize,
        maskPosition: s.maskPosition, WebkitMaskPosition: s.maskPosition, maskRepeat: s.maskRepeat, WebkitMaskRepeat: s.maskRepeat,
      }
    : {}

/** Copies of a picture, each in a canvas-sized layer at `zIndex` styled by its own look; `children` is the picture. */
export function FxCopies({ styles, zIndex, id, children }: { styles: LayerStyle[] | undefined; zIndex: number; id: string; children: ReactNode }) {
  if (!styles?.length) return null
  return styles.map((s, i) => (
    <div key={`${id}-copy-${i}`} aria-hidden className="pointer-events-none absolute inset-0" style={{ zIndex, ...fxStyle(s) }}>
      {children}
    </div>
  ))
}

/** A transition's boxes over both pictures. */
export function FxOverlays({ overlays, zIndex }: { overlays: Overlay[] | undefined; zIndex: number }) {
  if (!overlays?.length) return null
  const pct = (n: number) => `${n * 100}%`
  return overlays.map((o, i) => (
    <div key={i} aria-hidden className="pointer-events-none absolute" style={{ zIndex, left: pct(o.x), top: pct(o.y), width: pct(o.w), height: pct(o.h), background: o.background, opacity: o.opacity ?? 1 }} />
  ))
}

/** Largest side (px) a mirror draws at: plenty for the preview, cheap to copy. */
const MIRROR_MAX = 960

/**
 * A canvas showing `video()`'s current frame, with the video's own class and
 * style (so it sits and fits where the video does). It redraws on every
 * animation frame where the video's time moved or a seek finished.
 */
export function VideoMirror({ video, className, style }: { video: () => HTMLVideoElement | null; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const source = useRef(video)
  useEffect(() => {
    source.current = video
  })
  useEffect(() => {
    let raf = 0
    let last = -1
    let drawnFrom: HTMLVideoElement | null = null
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = ref.current
      const v = source.current()
      if (!c || !v || v.readyState < 2 || !(v.videoWidth > 0)) return
      if (v === drawnFrom && v.currentTime === last && !v.seeking) return
      const k = Math.min(1, MIRROR_MAX / Math.max(v.videoWidth, v.videoHeight))
      const w = Math.max(1, Math.round(v.videoWidth * k))
      const h = Math.max(1, Math.round(v.videoHeight * k))
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      }
      c.getContext("2d")?.drawImage(v, 0, 0, w, h)
      last = v.currentTime
      drawnFrom = v
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={ref} aria-hidden className={className} style={style} />
}

/** The SVG filters the transitions name: one colour channel kept, and a whip's blur at each level, sideways and up and down. */
export function TransitionFxDefs() {
  const keep = (row: number) => {
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]
    m[row * 5 + row] = 1
    return m.join(" ")
  }
  const { r, g, b } = TRANSITION_FILTERS.channels
  return (
    <svg aria-hidden width="0" height="0" className="absolute h-0 w-0 overflow-hidden">
      <defs>
        {([[r, 0], [g, 1], [b, 2]] as const).map(([id, row]) => (
          <filter key={id} id={id} colorInterpolationFilters="sRGB" x="0" y="0" width="1" height="1">
            <feColorMatrix type="matrix" values={keep(row)} />
          </filter>
        ))}
        {(["h", "v"] as const).flatMap((axis) =>
          WHIP_LEVELS.slice(1).map((level, i) => {
            const s = level * WHIP_BLUR
            return (
              <filter key={`${axis}${i}`} id={TRANSITION_FILTERS.blur(axis, i + 1)} primitiveUnits="objectBoundingBox" colorInterpolationFilters="sRGB" x="-0.2" y="-0.2" width="1.4" height="1.4">
                <feGaussianBlur stdDeviation={axis === "h" ? `${s} 0` : `0 ${s}`} edgeMode="none" />
              </filter>
            )
          })
        )}
      </defs>
    </svg>
  )
}
