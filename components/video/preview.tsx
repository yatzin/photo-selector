"use client"

import { useEffect, useState } from "react"
import { Pause, Play, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { assetKind, clipsAt, MAX_TRACKS, totalLength, trackStarts, type Project } from "@/lib/video/project"
import { cn } from "@/lib/utils"
import type { PreviewPlayer } from "./use-preview-player"

// The player above the timeline. Each track has two stacked <video> elements
// that take turns (see use-preview-player); only the topmost track with a
// clip is shown, the lower ones play unseen so their sound is heard. A clip
// the browser can't decode shows a message here and still exports, one whose
// file is missing says so (export fails on it). An image clip on top shows as
// a still over the video slots.

export function Preview({ player, project, imageUrl }: { player: PreviewPlayer; project: Project; imageUrl: (assetId: string) => string }) {
  const [brokenImage, setBrokenImage] = useState<string | null>(null)
  const total = totalLength(project)
  const hasClips = total > 0
  // At the end the last frame stays up.
  const look = player.time >= total ? Math.max(0, total - 0.001) : player.time
  const { tracks: hits, top } = clipsAt(project, look)
  const currentAsset = top?.clip.asset
  const cantPlay = currentAsset !== undefined && player.failed.has(currentAsset)
  const missing = currentAsset !== undefined && player.missing.has(currentAsset)
  const asset = currentAsset !== undefined ? project.assets[currentAsset] : undefined
  const image = asset !== undefined && assetKind(asset) === "image"
  const still = currentAsset !== undefined && image ? imageUrl(currentAsset) : ""
  const visibleLane = top && !image ? top.track : -1

  // The next clip on each track, when it's an image: fetched before the cut so a cut to it doesn't flash black.
  const nextStills = project.tracks
    .map((track, i) => {
      const hit = hits[i]
      const starts = trackStarts(track, i === 0)
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
    <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/90 p-4">
      <div className="relative aspect-video max-h-full max-w-full overflow-hidden rounded-md bg-black" style={{ height: "100%" }}>
        {project.tracks.slice(0, MAX_TRACKS).map((track, lane) =>
          [0, 1].map((slot) => {
            const shown = visibleLane === lane && player.active[lane] === slot
            return (
              <video
                key={`${lane}-${slot}`}
                ref={(v) => player.attach(lane, slot, v)}
                playsInline
                preload="auto"
                aria-hidden={!shown}
                onError={() => player.onVideoError(lane, slot)}
                className={cn("absolute inset-0 h-full w-full object-contain", shown ? "opacity-100" : "opacity-0")}
              />
            )
          })
        )}
        {still && (
          <div className="absolute inset-0 bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={still} alt="" draggable={false} className="h-full w-full object-contain" onError={() => setBrokenImage(still)} />
            {brokenImage === still && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 px-6 text-center text-sm text-white/80">
                <TriangleAlert className="h-5 w-5" />
                This image is missing from the project or can&apos;t be shown.
              </div>
            )}
          </div>
        )}
        {!hasClips && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/60">Import a clip and add it to the timeline</div>
        )}
        {cantPlay && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 px-6 text-center text-sm text-white/80">
            <TriangleAlert className="h-5 w-5" />
            {missing
              ? "This clip's file is missing from the project, so it can't play or export. Remove it from the timeline."
              : "Can't preview this clip in your browser. It will still export."}
          </div>
        )}
        {hasClips && (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            onClick={player.toggle}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full opacity-80 hover:opacity-100"
            title={player.playing ? "Pause (Space)" : "Play (Space)"}
          >
            {player.playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            <span className="sr-only">{player.playing ? "Pause" : "Play"}</span>
          </Button>
        )}
      </div>
    </div>
  )
}
