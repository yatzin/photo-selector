"use client"

import { useEffect, useState } from "react"
import { filmFrameIndex } from "@/lib/video/film"

// A video's filmstrip snapshots, from the film route (lib/video/film): one
// request for how they're spaced (the server makes them all on the first one),
// then each tile is just an image URL for the snapshot nearest its moment, which
// the browser caches. Nothing until the answer is in; if there is none (not a
// video, or the server couldn't read it) the tiles keep the file's poster.

type Info = { interval: number; count: number }

// Per film URL: the request in flight, or what it gave.
const cache = new Map<string, Promise<Info | null> | Info | null>()

function fetchInfo(base: string): Promise<Info | null> {
  const job = fetch(`${base}/info`)
    .then(async (r): Promise<Info | null> => {
      if (!r.ok) return null
      const v = (await r.json()) as Partial<Info>
      return typeof v.interval === "number" && Number.isFinite(v.interval) && typeof v.count === "number" && Number.isInteger(v.count) ? { interval: v.interval, count: v.count } : null
    })
    .then(
      (info) => {
        cache.set(base, info)
        return info
      },
      () => {
        // A network failure: forget it, so the next mount asks again.
        cache.delete(base)
        return null
      }
    )
  cache.set(base, job)
  return job
}

const settled = (v: Promise<Info | null> | Info | null | undefined): v is Info | null => v !== undefined && !(v instanceof Promise)

/** A lookup from a source moment (s) to its snapshot's URL, or undefined until the snapshots are ready (or when there are none). */
export function useFilmFrames(projectFolder: string, assetId: string): (t: number) => string | undefined {
  const base = `/api/video-projects/${encodeURIComponent(projectFolder)}/film/${encodeURIComponent(assetId)}`
  const [loaded, setLoaded] = useState<{ base: string; info: Info | null } | null>(null)
  useEffect(() => {
    const known = cache.get(base)
    if (settled(known)) return
    let alive = true
    void (known ?? fetchInfo(base)).then((info) => {
      if (alive) setLoaded({ base, info })
    })
    return () => {
      alive = false
    }
  }, [base])
  const known = cache.get(base)
  const info = settled(known) ? known : loaded?.base === base ? loaded.info : null
  return (t) => (info ? `${base}/${filmFrameIndex(t, info.interval, info.count)}` : undefined)
}
