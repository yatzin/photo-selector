"use client"

import { useRef, useState } from "react"
import { ArrowRight, Ban, Type } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { isTextClip, type Clip, type Project } from "@/lib/video/project"
import { DEFAULT_TRANSITION, MIN_TRANSITION, TRANSITION_TYPES, type Transition, type TransitionType } from "@/lib/video/transition-types"
import { transitionKeyframes } from "@/lib/video/transition-preview"
import { TRANSITION_GROUPS, TRANSITION_INFO, transitionLimits } from "@/lib/video/transitions"
import { Thumb } from "./thumb"

// The Transition dialog for one cut: the clip before it and the clip after it
// (`clipId`, which holds the transition), a radio grid of transitions, each
// tile looping a small sample of its effect (CSS keyframes from the preview's
// own maths), None to take it off, and the duration. Apply (or Remove) is one
// undo step; Esc cancels.

const KEYFRAME_PREFIX = "ps-tx"
const KEYFRAMES = TRANSITION_TYPES.map((t) => transitionKeyframes(t, KEYFRAME_PREFIX)).join("\n")
const LOOP = "2.4s linear infinite"

type Choice = TransitionType | "none"
const CHOICES: Choice[] = ["none", ...TRANSITION_GROUPS.flatMap((g) => TRANSITION_TYPES.filter((t) => TRANSITION_INFO[t].group === g))]

const fmt = (n: number) => String(Math.floor(n * 10 + 1e-9) / 10)

/** The tile's sample: an "A" picture turning into a "B" one with the effect, looping. */
function Sample({ type }: { type: TransitionType }) {
  const layer = "absolute inset-0 flex items-center justify-center text-[11px] font-bold"
  return (
    <span aria-hidden className="relative block h-9 w-16 overflow-hidden rounded bg-black">
      <span className={cn(layer, "bg-sky-500 text-white")} style={{ animation: `${KEYFRAME_PREFIX}-${type}-from ${LOOP}` }}>A</span>
      <span className={cn(layer, "bg-amber-400 text-neutral-900")} style={{ animation: `${KEYFRAME_PREFIX}-${type}-to ${LOOP}` }}>B</span>
      <span className="absolute inset-0" style={{ animation: `${KEYFRAME_PREFIX}-${type}-tint ${LOOP}` }} />
    </span>
  )
}

function ClipChip({ project, clip, thumbUrl, label }: { project: Project; clip: Clip; thumbUrl: (assetId: string) => string; label: string }) {
  const name = isTextClip(clip) ? `Text "${clip.text.content.replace(/\s+/g, " ")}"` : (project.assets[clip.asset]?.file ?? "Missing file")
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border p-1.5">
      {isTextClip(clip) ? (
        <span className="flex h-8 w-12 shrink-0 items-center justify-center rounded bg-violet-500/25 text-violet-950 dark:text-violet-50"><Type className="h-4 w-4" /></span>
      ) : (
        <Thumb src={thumbUrl(clip.asset)} className="h-8 w-12 shrink-0 rounded object-cover" />
      )}
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="truncate text-xs" title={name}>{name}</div>
      </div>
    </div>
  )
}

export function TransitionDialog({ project, clipId, thumbUrl, onApply, onClose }: {
  project: Project
  /** The clip after the cut: it holds the transition from the clip before it. */
  clipId: string
  thumbUrl: (assetId: string) => string
  /** Sets the transition (null: removes it). */
  onApply: (spec: Transition | null) => void
  onClose: () => void
}) {
  const track = project.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const index = track ? track.clips.findIndex((c) => c.id === clipId) : -1
  const clip = track?.clips[index]
  const before = track?.clips[index - 1]
  const current = clip?.transition
  const { max, reason } = transitionLimits(project, clipId)
  const [choice, setChoice] = useState<Choice>(current?.type ?? "fade")
  const [text, setText] = useState(fmt(current?.duration ?? Math.min(DEFAULT_TRANSITION, Math.max(MIN_TRANSITION, max))))
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])

  const seconds = Number(text)
  const durationError =
    text.trim() === "" || !Number.isFinite(seconds) ? "Enter a number." : seconds < MIN_TRANSITION - 1e-9 ? `At least ${MIN_TRANSITION} s.` : seconds > max + 1e-9 ? `At most ${fmt(max)} s here.` : null
  const noFootage = reason !== "ok"
  const canApply = choice === "none" ? current !== undefined : !noFootage && durationError === null

  function apply() {
    if (!canApply) return
    onApply(choice === "none" ? null : { type: choice, duration: seconds })
    onClose()
  }

  /** Arrow keys move through the options (and pick, as radios do), Home and End jump to the ends. */
  function onKey(e: React.KeyboardEvent, i: number) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0
    const to = e.key === "Home" ? 0 : e.key === "End" ? CHOICES.length - 1 : step ? (i + step + CHOICES.length) % CHOICES.length : -1
    if (to < 0) return
    e.preventDefault()
    setChoice(CHOICES[to])
    optionRefs.current[to]?.focus()
  }

  const option = (c: Choice) => {
    const i = CHOICES.indexOf(c)
    const checked = choice === c
    const name = c === "none" ? "None" : TRANSITION_INFO[c].name
    return (
      <button
        key={c}
        ref={(el) => {
          optionRefs.current[i] = el
        }}
        type="button"
        role="radio"
        aria-checked={checked}
        tabIndex={checked ? 0 : -1}
        onClick={() => setChoice(c)}
        onKeyDown={(e) => onKey(e, i)}
        className={cn(
          "flex flex-col items-center gap-1 rounded-lg border p-1.5 text-[11px] leading-tight outline-none focus-visible:ring-2 focus-visible:ring-ring",
          checked ? "border-editor-accent bg-editor-accent/10 ring-1 ring-editor-accent" : "border-border hover:bg-muted"
        )}
      >
        {c === "none" ? (
          <span aria-hidden className="flex h-9 w-16 items-center justify-center rounded bg-muted text-muted-foreground"><Ban className="h-4 w-4" /></span>
        ) : (
          <Sample type={c} />
        )}
        <span className="text-center">{name}</span>
      </button>
    )
  }

  if (!clip || !before) return null
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl" finalFocus={false}>
        <style>{`${KEYFRAMES}\n@media (prefers-reduced-motion: reduce){[data-transition-grid] span{animation-play-state:paused!important}}`}</style>
        <DialogHeader>
          <DialogTitle>Transition</DialogTitle>
          <DialogDescription>Blends the two clips across the cut, half before it and half after.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            apply()
          }}
        >
          <div className="flex items-center gap-2">
            <ClipChip project={project} clip={before} thumbUrl={thumbUrl} label="From" />
            <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
            <ClipChip project={project} clip={clip} thumbUrl={thumbUrl} label="To" />
          </div>
          <div role="radiogroup" aria-label="Transition" data-transition-grid className="grid gap-3">
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">{option("none")}</div>
            {TRANSITION_GROUPS.map((g) => (
              <div key={g} className="grid gap-1.5">
                <div className="text-xs font-medium text-muted-foreground">{g}</div>
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">{TRANSITION_TYPES.filter((t) => TRANSITION_INFO[t].group === g).map((t) => option(t))}</div>
              </div>
            ))}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="transition-duration">Duration (seconds)</Label>
            <Input
              id="transition-duration"
              type="number"
              inputMode="decimal"
              step={0.1}
              min={MIN_TRANSITION}
              max={noFootage ? undefined : max}
              value={text}
              disabled={noFootage || choice === "none"}
              aria-invalid={!noFootage && choice !== "none" && durationError ? true : undefined}
              aria-describedby="transition-duration-note"
              onChange={(e) => setText(e.target.value)}
              className="w-28"
            />
            <p id="transition-duration-note" className={cn("text-xs", noFootage || (choice !== "none" && durationError) ? "text-destructive" : "text-muted-foreground")}>
              {noFootage
                ? "No extra footage at this cut: trim the clip shorter first."
                : choice !== "none" && durationError
                  ? durationError
                  : `Up to ${fmt(max)} s here: each clip plays half of it beyond the cut, from the footage past its end or before its start, and it can't be longer than either clip.`}
            </p>
          </div>
          <DialogFooter>
            {current && (
              <Button
                type="button"
                variant="outline"
                className="sm:mr-auto"
                onClick={() => {
                  onApply(null)
                  onClose()
                }}
              >
                Remove
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!canApply}>Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
