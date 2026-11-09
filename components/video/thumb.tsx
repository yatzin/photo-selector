"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"

// A clip's thumbnail, or a "Missing file" placeholder when there's no URL or
// the image fails to load (the asset's file has gone from the project).

export function Thumb({ src, className }: { src: string; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null)
  if (!src || broken === src) {
    return <div className={cn("flex items-center justify-center bg-muted text-center text-[10px] text-muted-foreground", className)}>Missing file</div>
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      draggable={false}
      className={className}
      onError={() => setBroken(src)}
      // An error during server-rendered page load can fire before hydration, when onError isn't attached yet.
      ref={(img) => {
        if (img?.complete && img.naturalWidth === 0) setBroken(src)
      }}
    />
  )
}
