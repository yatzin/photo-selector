"use client"

import { Pause, Play, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { clipAt, type Project } from "@/lib/video/project"
import { cn } from "@/lib/utils"
import type { PreviewPlayer } from "./use-preview-player"

// The player above the timeline. Two stacked <video> elements take turns (see
// use-preview-player); a clip the browser can't decode shows a message here and
// still exports, one whose file is missing says so (export fails on it).

export function Preview({ player, project }: { player: PreviewPlayer; project: Project }) {
  const current = clipAt(project.clips, player.time)
  const currentAsset = (current ? project.clips[current.index] : project.clips.at(-1))?.asset
  const cantPlay = currentAsset !== undefined && player.failed.has(currentAsset)
  const missing = currentAsset !== undefined && player.missing.has(currentAsset)

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/90 p-4">
      <div className="relative aspect-video max-h-full max-w-full overflow-hidden rounded-md bg-black" style={{ height: "100%" }}>
        {[player.slotA, player.slotB].map((ref, slot) => (
          <video
            key={slot}
            ref={ref}
            playsInline
            preload="auto"
            aria-hidden={player.active !== slot}
            onError={() => player.onVideoError(slot)}
            className={cn("absolute inset-0 h-full w-full object-contain", player.active === slot ? "opacity-100" : "opacity-0")}
          />
        ))}
        {project.clips.length === 0 && (
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
        {project.clips.length > 0 && (
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
