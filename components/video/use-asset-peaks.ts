"use client"

import { useEffect, useState } from "react"
import { decodePeaks } from "@/lib/video/peaks"

// An asset's waveform peaks from the peaks route, fetched once per page for
// all the clips that use it. Nothing (null) while loading, when the asset has
// no sound or the request failed; it never holds up a render.

export type AssetPeaks = { rate: number; peaks: Uint8Array }

// Per URL: the request in flight, or what it gave.
const cache = new Map<string, Promise<AssetPeaks | null> | AssetPeaks | null>()

function fetchPeaks(url: string): Promise<AssetPeaks | null> {
  const job = fetch(url)
    .then(async (r) => (r.ok ? decodePeaks(new Uint8Array(await r.arrayBuffer())) : null))
    .then(
      (peaks) => {
        cache.set(url, peaks)
        return peaks
      },
      () => {
        // A network failure: forget it, so the clip's next mount asks again.
        cache.delete(url)
        return null
      }
    )
  cache.set(url, job)
  return job
}

const settled = (v: Promise<AssetPeaks | null> | AssetPeaks | null | undefined): v is AssetPeaks | null => v !== undefined && !(v instanceof Promise)

/** The peaks of `assetId` in project `projectFolder`; fetched only while `enabled`. */
export function useAssetPeaks(projectFolder: string, assetId: string, enabled: boolean): AssetPeaks | null {
  const url = `/api/video-projects/${encodeURIComponent(projectFolder)}/peaks/${encodeURIComponent(assetId)}`
  const [loaded, setLoaded] = useState<{ url: string; peaks: AssetPeaks | null } | null>(null)
  useEffect(() => {
    if (!enabled) return
    const known = cache.get(url)
    if (settled(known)) return
    let alive = true
    void (known ?? fetchPeaks(url)).then((peaks) => {
      if (alive) setLoaded({ url, peaks })
    })
    return () => {
      alive = false
    }
  }, [url, enabled])
  if (!enabled) return null
  const known = cache.get(url)
  if (settled(known)) return known
  return loaded?.url === url ? loaded.peaks : null
}
