"use client"

import { useCallback, useEffect, useState } from "react"
import { ImageOff } from "lucide-react"
import { cn } from "@/lib/utils"

// A thumbnail that shows an animated placeholder until the image has loaded,
// then fades it in. With `delayMs`, the request starts only after the tile
// has been on screen that long, so scrolling fast through thousands of
// photos doesn't make the NAS render thumbnails nobody looked at.

export function PhotoImage({
  src, alt, delayMs = 0, className, imgClassName, fallbackLabel,
}: {
  src: string
  alt: string
  delayMs?: number
  className?: string
  imgClassName?: string
  fallbackLabel?: string
}) {
  const [armed, setArmed] = useState(delayMs === 0)
  const [state, setState] = useState<{ src: string; status: "loading" | "loaded" | "failed" }>({ src, status: "loading" })
  // A new src (rotated photo, different file) starts over.
  if (state.src !== src) setState({ src, status: "loading" })

  useEffect(() => {
    if (armed) return
    const t = setTimeout(() => setArmed(true), delayMs)
    return () => clearTimeout(t)
  }, [armed, delayMs])

  const status = state.src === src ? state.status : "loading"

  // A cached image rendered on the server can finish loading before React
  // attaches onLoad, so the event is missed; check once it's in the page.
  const imgRef = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img?.complete) return
      setState((s) => (s.src === src && s.status === "loading" ? { src, status: img.naturalWidth > 0 ? "loaded" : "failed" } : s))
    },
    [src]
  )

  if (status === "failed") {
    return (
      <div className={cn("flex h-full w-full flex-col items-center justify-center gap-1 bg-muted p-2 text-muted-foreground", className)}>
        <ImageOff className="h-6 w-6" strokeWidth={1.5} />
        {fallbackLabel && <span className="line-clamp-2 break-all text-center text-[11px]">{fallbackLabel}</span>}
      </div>
    )
  }

  return (
    <div className={cn("relative h-full w-full", status !== "loaded" && "shimmer bg-muted", className)}>
      {armed && (
        // eslint-disable-next-line @next/next/no-img-element -- served from our own cache, already sized
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          decoding="async"
          loading="lazy"
          draggable={false}
          onLoad={() => setState({ src, status: "loaded" })}
          onError={() => setState({ src, status: "failed" })}
          className={cn("h-full w-full object-cover transition-opacity duration-300", status === "loaded" ? "opacity-100" : "opacity-0", imgClassName)}
        />
      )}
    </div>
  )
}
