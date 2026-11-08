"use client"

import { useRef, useState } from "react"
import { ArrowRight, Ban, Type } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { isTextClip, type Clip, type Project } from "@/lib/video/project"
import {
  DEFAULT_CUT_AUDIO, DEFAULT_TRANSITION, isTransitionType, MIN_CUT_AUDIO, MIN_TRANSITION, TRANSITION_TYPES, type CutAudio, type Transition, type TransitionType,
} from "@/lib/video/transition-types"
import { lookParts, transitionKeyframes } from "@/lib/video/transition-preview"
import { transitionGuide } from "@/lib/video/transition-info"
import {
  applyCut, cutAudioRange, cutTrims, setCutAudio, setTransition, TRANSITION_GROUPS, TRANSITION_INFO, transitionRange, type CutRange,
} from "@/lib/video/transitions"
import { CutLoopPreview } from "./cut-loop-preview"
import { TransitionFxDefs } from "./transition-layers"
import { Thumb } from "./thumb"

// The Transition / audio overlap dialog for one cut: the clip before it and
// the clip after it (`clipId`, which holds both), a radio grid of
// transitions, each tile looping a small sample of its effect (CSS keyframes
// from the preview's own maths), None to take it off, and the duration; beside
// it (below on a narrow window) a live loop of the two real clips across the
// cut with the chosen transition (CutLoopPreview) and what the transition is
// good and bad for. Under them the audio overlap: none, a J-cut or an L-cut
// and its length. The longest each can be comes from the clips' lengths: a
// clip without the footage beyond the cut is trimmed to make it
// (lib/video/transitions' transitionPlan), and a note says what Apply will
// trim and how far later clips move. Apply (or Remove) is one undo step; Esc
// cancels.

const KEYFRAME_PREFIX = "ps-tx"
const KEYFRAMES = TRANSITION_TYPES.map((t) => transitionKeyframes(t, KEYFRAME_PREFIX)).join("\n")
const LOOP = "2.4s linear infinite"

type Choice = TransitionType | "none"
const CHOICES: Choice[] = ["none", ...TRANSITION_GROUPS.flatMap((g) => TRANSITION_TYPES.filter((t) => TRANSITION_INFO[t].group === g))]

const fmt = (n: number) => String(Math.floor(n * 10 + 1e-9) / 10)
/** A trim, to the hundredth. */
const fmt2 = (n: number) => String(Math.round(n * 100) / 100)

/** The tile grids: as many columns as fit. */
const TILE_GRID = "grid grid-cols-[repeat(auto-fill,minmax(4.75rem,1fr))] gap-2"

/** Each type's copies, overlays and order (the same all through its sample). */
const PARTS = Object.fromEntries(TRANSITION_TYPES.map((t) => [t, lookParts(t)])) as Record<TransitionType, ReturnType<typeof lookParts>>

/** The tile's sample: an "A" picture turning into a "B" one with the effect, looping (with any copies and overlays the effect draws). */
function Sample({ type }: { type: TransitionType }) {
  const layer = "absolute inset-0 flex items-center justify-center text-[11px] font-bold"
  const parts = PARTS[type]
  const anim = (name: string) => `${KEYFRAME_PREFIX}-${type}-${name} ${LOOP}`
  // Blend modes and transform origins don't change over a sample: set once.
  const fixed = (s: { mixBlendMode?: "plus-lighter"; transformOrigin?: string }) => ({ mixBlendMode: s.mixBlendMode, transformOrigin: s.transformOrigin })
  const a = cn(layer, "bg-sky-500 text-white")
  const b = cn(layer, "bg-amber-400 text-neutral-900")
  const fromZ = parts.fromOnTop ? 3 : 1
  return (
    <span aria-hidden className="relative isolate block h-9 w-16 overflow-hidden rounded bg-black">
      <span className={a} style={{ zIndex: fromZ, animation: anim("from") }}>A</span>
      {parts.fromCopies.map((s, i) => <span key={`f${i}`} className={a} style={{ zIndex: fromZ, ...fixed(s), animation: anim(`from-c${i}`) }}>A</span>)}
      <span className={b} style={{ zIndex: 2, animation: anim("to") }}>B</span>
      {parts.toCopies.map((s, i) => <span key={`t${i}`} className={b} style={{ zIndex: 2, ...fixed(s), animation: anim(`to-c${i}`) }}>B</span>)}
      {parts.overlays.map((_, i) => <span key={`o${i}`} className="absolute" style={{ zIndex: 4, animation: anim(`ov${i}`) }} />)}
      <span className="absolute inset-0" style={{ zIndex: 4, animation: anim("tint") }} />
    </span>
  )
}

/** A clip's name in the dialog's words. */
const clipName = (project: Project, clip: Clip) => (isTextClip(clip) ? `Text "${clip.text.content.replace(/\s+/g, " ")}"` : (project.assets[clip.asset]?.file ?? "Missing file"))

function ClipChip({ project, clip, thumbUrl, label }: { project: Project; clip: Clip; thumbUrl: (assetId: string) => string; label: string }) {
  const name = clipName(project, clip)
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

type AudioChoice = CutAudio["mode"] | "none"

/** Why an audio overlap can't be had, in the dialog's words. */
const AUDIO_REASON: Record<CutAudio["mode"], Record<Exclude<CutRange["reason"], "ok">, string>> = {
  j: { "not-adjoining": "No clip right before this one.", "no-audio": "The incoming clip has no audio, so there's nothing to bring in early.", "too-short": "The clips are too short for it." },
  l: { "not-adjoining": "No clip right before this one.", "no-audio": "The outgoing clip has no audio, so there's nothing to carry on.", "too-short": "The clips are too short for it." },
}

/** Why a range stops where it does: "(the second clip is only 1.6 s long)". */
function limitNote(r: CutRange, what: string): string {
  if (r.limit === "cap") return `(the longest ${what} can be)`
  if (r.limit === "outgoing") return `(the first clip is only ${fmt(r.lengths.outgoing)} s long)`
  return r.limit === "incoming" ? `(the second clip is only ${fmt(r.lengths.incoming)} s long)` : ""
}

/** A duration typed in a dialog: the error to show, or null when it's a number from `min` to `max`. */
function durationProblem(text: string, min: number, max: number): string | null {
  const n = Number(text)
  if (text.trim() === "" || !Number.isFinite(n)) return "Enter a number."
  if (n < min - 1e-9) return `At least ${min} s.`
  return n > max + 1e-9 ? `At most ${fmt(max)} s here.` : null
}

/** What the loop previews for a typed duration: the number clamped to `min`..`max` (`max` when it isn't one). */
const previewSeconds = (text: string, min: number, max: number) => {
  const n = Number(text)
  return Math.min(max, Math.max(min, text.trim() !== "" && Number.isFinite(n) ? n : max))
}

export function TransitionDialog({ project, clipId, thumbUrl, videoUrl, imageUrl, onApply, onClose }: {
  project: Project
  /** The clip after the cut: it holds the transition and the audio overlap from the clip before it. */
  clipId: string
  thumbUrl: (assetId: string) => string
  /** A video asset's file and an image asset's picture, for the loop. */
  videoUrl: (assetId: string) => string
  imageUrl: (assetId: string) => string
  /** Sets the transition and the audio overlap (null: removes it), as one edit. */
  onApply: (spec: { transition: Transition | null; cutAudio: CutAudio | null }) => void
  onClose: () => void
}) {
  const track = project.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const index = track ? track.clips.findIndex((c) => c.id === clipId) : -1
  const clip = track?.clips[index]
  const before = track?.clips[index - 1]
  const current = clip?.transition
  const currentAudio = clip?.cutAudio
  // The transition's range with the cut's audio overlap taken off (Apply sets the transition first, then the overlap).
  const bare = setCutAudio(project, clipId, null)
  const range = transitionRange(bare, clipId)
  const { max } = range
  const [choice, setChoice] = useState<Choice>(current && isTransitionType(current.type) ? current.type : "fade")
  const [text, setText] = useState(fmt(current?.duration ?? Math.min(DEFAULT_TRANSITION, Math.max(MIN_TRANSITION, max))))
  const [audioMode, setAudioMode] = useState<AudioChoice>(currentAudio?.mode ?? "none")
  const [audioText, setAudioText] = useState(fmt(currentAudio?.duration ?? DEFAULT_CUT_AUDIO))
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])

  const seconds = Number(text)
  const durationError = durationProblem(text, MIN_TRANSITION, max)
  const noFootage = range.reason !== "ok"
  // The overlap's range once the transition shown is set.
  const shownTransition: Transition | null = choice === "none" || noFootage ? null : { type: choice, duration: previewSeconds(text, MIN_TRANSITION, max) }
  const audioLimits = cutAudioRange(setTransition(bare, clipId, shownTransition), clipId)
  const audioMax = audioMode === "none" ? 0 : audioLimits[audioMode].max
  const audioSeconds = Number(audioText)
  const audioError = audioMode === "none" ? null : durationProblem(audioText, MIN_CUT_AUDIO, audioMax)
  const transitionOk = choice === "none" || (!noFootage && durationError === null)
  const canApply = transitionOk && audioError === null && (choice !== "none" || audioMode !== "none" || current !== undefined || currentAudio !== undefined)
  const shownAudio: CutAudio | null = audioMode === "none" || audioMax < MIN_CUT_AUDIO ? null : { mode: audioMode, duration: previewSeconds(audioText, MIN_CUT_AUDIO, audioMax) }
  // What Apply will trim, and how far the rest of the layer moves.
  const after = applyCut(project, clipId, { transition: shownTransition, cutAudio: shownAudio })
  const trims = cutTrims(project, after, clipId)
  const hasLater = track !== undefined && track.clips.length > index + 1
  const shorter = (current !== undefined && shownTransition !== null && shownTransition.duration < current.duration) || (currentAudio !== undefined && shownAudio !== null && shownAudio.duration < currentAudio.duration)

  function apply() {
    if (!canApply) return
    onApply({
      transition: choice === "none" ? null : { type: choice, duration: seconds },
      cutAudio: audioMode === "none" ? null : { mode: audioMode, duration: audioSeconds },
    })
    onClose()
  }

  /** Picks an audio overlap mode, its duration brought within what this cut allows. */
  function pickAudio(mode: AudioChoice) {
    setAudioMode(mode)
    if (mode === "none") return
    const most = audioLimits[mode].max
    const n = Number(audioText)
    if (!Number.isFinite(n) || n > most) setAudioText(fmt(Math.min(most, DEFAULT_CUT_AUDIO)))
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
  const guide = transitionGuide(choice)
  const trimNote = (() => {
    if (trims.ripple <= 0) return shorter ? "Trims made for a longer one are kept." : null
    const parts = [
      ...(trims.outgoing > 0 ? [`${fmt2(trims.outgoing)} s from the end of ${clipName(project, before)}`] : []),
      ...(trims.incoming > 0 ? [`${fmt2(trims.incoming)} s from the start of ${clipName(project, clip)}`] : []),
    ]
    const later = hasLater ? `; later clips on this layer move ${fmt2(trims.ripple)} s earlier` : ""
    return `Applying trims ${parts.join(" and ")}${later}.${shorter ? " Trims are kept." : ""}`
  })()
  const audioNote = (mode: CutAudio["mode"]) => {
    const r = audioLimits[mode].reason
    return r === "ok" ? `up to ${fmt(audioLimits[mode].max)} s` : AUDIO_REASON[mode][r]
  }
  const audioOption = (mode: AudioChoice, label: string) => {
    const disabled = mode !== "none" && audioLimits[mode].reason !== "ok"
    return (
      <label key={mode} className={cn("flex items-start gap-2 rounded-lg border p-2 text-xs", audioMode === mode ? "border-editor-accent bg-editor-accent/10" : "border-border", disabled ? "opacity-60" : "cursor-pointer hover:bg-muted")}>
        <input type="radio" name="cut-audio" value={mode} checked={audioMode === mode} disabled={disabled} onChange={() => pickAudio(mode)} className="mt-0.5 accent-editor-accent" />
        <span className="grid gap-0.5">
          <span className="font-medium text-foreground">{label}</span>
          {mode !== "none" && <span className={cn(disabled ? "text-destructive" : "text-muted-foreground")}>{audioNote(mode)}</span>}
        </span>
      </label>
    )
  }
  const audioShown = shownAudio ? fmt(shownAudio.duration) : ""
  const audioExplain =
    audioMode === "j"
      ? `You hear the next clip ${audioShown} s before its picture appears, over the end of the previous clip; the two sounds mix, with a short fade-in.`
      : audioMode === "l"
        ? `The previous clip's sound carries on ${audioShown} s over the start of the next clip; the two sounds mix, with a short fade-out.`
        : choice === "none"
          ? "The sound cuts with the picture."
          : "The sound crossfades over the transition."
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[min(60rem,calc(100%-2rem))]" finalFocus={false}>
        <style>{`${KEYFRAMES}\n@media (prefers-reduced-motion: reduce){[data-transition-grid] span{animation-play-state:paused!important}}`}</style>
        <TransitionFxDefs />
        <DialogHeader>
          <DialogTitle>Transition / audio overlap</DialogTitle>
          <DialogDescription>What happens at this cut: a transition blends the two clips across it, half before and half after; an audio overlap lets the sound lead or trail the picture.</DialogDescription>
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
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
            <div className="grid content-start gap-4">
              <div role="radiogroup" aria-label="Transition" data-transition-grid className="grid gap-3">
                <div className={TILE_GRID}>{option("none")}</div>
                {TRANSITION_GROUPS.map((g) => (
                  <div key={g} className="grid gap-1.5">
                    <div className="text-xs font-medium text-muted-foreground">{g}</div>
                    <div className={TILE_GRID}>{TRANSITION_TYPES.filter((t) => TRANSITION_INFO[t].group === g).map((t) => option(t))}</div>
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
                    ? "These clips are too short for a transition: each needs half of it, and 0.2 s of its own."
                    : choice !== "none" && durationError
                      ? durationError
                      : `Longest possible: ${fmt(max)} s ${limitNote(range, "a transition")}. Each clip plays half of it beyond the cut; a clip without that much footage is trimmed to make it.`}
                </p>
              </div>
            </div>
            <div className="grid content-start gap-3">
              <CutLoopPreview
                project={project}
                from={before}
                to={clip}
                type={noFootage ? "none" : choice}
                duration={noFootage ? 0 : previewSeconds(text, MIN_TRANSITION, max)}
                audio={shownAudio}
                videoUrl={videoUrl}
                imageUrl={imageUrl}
              />
              <div aria-live="polite" className="grid gap-2 text-xs" data-transition-guide>
                <div className="text-sm font-medium">{choice === "none" ? "None (hard cut)" : TRANSITION_INFO[choice].name}</div>
                {(
                  [
                    ["What it does", guide.does],
                    ["Best for", guide.bestFor],
                    ["Avoid when", guide.avoid],
                  ] as const
                ).map(([label, body]) => (
                  <div key={label} className="grid gap-0.5">
                    <div className="font-medium text-muted-foreground">{label}</div>
                    <p className="leading-snug">{body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <fieldset className="grid gap-2 border-t border-border pt-4">
            <legend className="float-left mb-1 w-full text-sm font-medium">Audio overlap</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {audioOption("none", "None")}
              {audioOption("j", "J-cut (audio comes in early)")}
              {audioOption("l", "L-cut (audio carries on)")}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="cut-audio-duration">Overlap (seconds)</Label>
              <Input
                id="cut-audio-duration"
                type="number"
                inputMode="decimal"
                step={0.1}
                min={MIN_CUT_AUDIO}
                max={audioMode === "none" ? undefined : audioMax}
                value={audioText}
                disabled={audioMode === "none"}
                aria-invalid={audioError ? true : undefined}
                aria-describedby="cut-audio-note"
                onChange={(e) => setAudioText(e.target.value)}
                className="w-28"
              />
            </div>
            <p id="cut-audio-note" className={cn("text-xs", audioError ? "text-destructive" : "text-muted-foreground")}>
              {audioError ?? audioExplain}
              {!audioError && audioMode !== "none" && choice !== "none" && " It replaces the transition's sound crossfade."}
              {!audioError && audioMode !== "none" && audioLimits[audioMode].reason === "ok" && ` Longest possible: ${fmt(audioMax)} s ${limitNote(audioLimits[audioMode], "an overlap")}.`}
            </p>
          </fieldset>
          {trimNote && (
            <p data-trim-note className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-950 dark:text-amber-100" aria-live="polite">
              {trimNote}
            </p>
          )}
          <DialogFooter>
            {(current || currentAudio) && (
              <Button
                type="button"
                variant="outline"
                className="sm:mr-auto"
                onClick={() => {
                  onApply({ transition: null, cutAudio: null })
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
