"use client"

import { useRef, useState } from "react"
import { ArrowRight, Ban, Type } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { audioCutState, audioEdgeState } from "@/lib/video/audio-fx"
import { allClips, clipLength, isAudioClip, isTextClip, type Clip, type Project } from "@/lib/video/project"
import {
  AUDIO_CURVES, AUDIO_TRANSITION_TYPES, DEFAULT_CUT_AUDIO, DEFAULT_EDGE, DEFAULT_TRANSITION, EDGE_AUDIO_TYPES, EDGE_PICTURE_TYPES, isAudioCurve, isAudioTransitionType, isTransitionType, MAX_EDGE, MIN_CUT_AUDIO, MIN_EDGE,
  MIN_TRANSITION, TRANSITION_TYPES, type AnyTransitionType, type AudioTransitionType, type CutAudio, type Edge, type EdgeTransition, type Transition, type TransitionType,
} from "@/lib/video/transition-types"
import { edgeKeyframes, edgeLook, lookParts, transitionKeyframes } from "@/lib/video/transition-preview"
import { AUDIO_EDGE_GUIDES, AUDIO_TRANSITION_GUIDES, transitionGuide, type AudioEdgeType, type TransitionGuide } from "@/lib/video/transition-info"
import {
  applyCut, AUDIO_TRANSITION_GROUPS, AUDIO_TRANSITION_INFO, cutAudioRange, cutTrims, DEFAULT_AUDIO_TRANSITION, edgeLimits, edgeTransitionName, setCutAudio, setTransition, TRANSITION_GROUPS, TRANSITION_INFO, transitionName,
  transitionRange, type CutRange, type EdgeRange,
} from "@/lib/video/transitions"
import { CutLoopPreview } from "./cut-loop-preview"
import { AudioLoopPreview, EdgeLoopPreview } from "./edge-loop-preview"
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
// cancels. Between two audio clips the same dialog offers the audio
// transitions (curve tiles, a loop of the two sounds, no audio overlap), and
// for a clip's free edge it offers an in or out transition against nothing
// (TransitionDialog picks the mode).

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

function PictureCutDialog({ project, clipId, thumbUrl, videoUrl, imageUrl, onApply, onClose }: {
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
          <DialogTitle>Transition</DialogTitle>
          <DialogDescription>Between {clipName(project, before)} and {clipName(project, clip)}. A transition blends the two clips across the cut, half before and half after; an audio overlap lets the sound lead or trail the picture.</DialogDescription>
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

/** What a Transition dialog is for: the cut into `clipId` (the clip after it), or with `edge`, that clip's free edge. */
export type TransitionTarget = { clipId: string; edge?: Edge }

/**
 * The Transition dialog in the mode its target needs: a cut between picture
 * clips (transitions and audio overlaps, PictureCutDialog), a cut between
 * audio clips (the audio transitions, AudioCutDialog), or a clip's free edge
 * (in or out against nothing, EdgeDialog: picture transitions for a picture
 * clip, sound fades for an audio clip). A text clip's edges have their own
 * In and Out animations instead (Edit text, Animation tab), so they never
 * come here.
 */
export function TransitionDialog(props: {
  project: Project
  target: TransitionTarget
  thumbUrl: (assetId: string) => string
  videoUrl: (assetId: string) => string
  imageUrl: (assetId: string) => string
  audioUrl: (assetId: string) => string
  /** Sets the cut's transition and audio overlap (null: removes it), as one edit. */
  onApply: (spec: { transition: Transition | null; cutAudio: CutAudio | null }) => void
  /** Sets the edge's transition (null: removes it), as one edit. */
  onApplyEdge: (spec: EdgeTransition | null) => void
  onClose: () => void
}) {
  const { project, target } = props
  const clip = allClips(project).find((c) => c.id === target.clipId)
  if (!clip) return null
  if (target.edge) return <EdgeDialog {...props} clip={clip} edge={target.edge} />
  if (isAudioClip(project, clip)) return <AudioCutDialog {...props} clip={clip} />
  return <PictureCutDialog {...props} clipId={target.clipId} />
}

/** The guidance under a loop: the choice's name and what it does, is best for and should be avoided for. */
function GuidePanel({ name, guide, note }: { name: string; guide: TransitionGuide; note?: string }) {
  return (
    <div aria-live="polite" className="grid gap-2 text-xs" data-transition-guide>
      <div className="text-sm font-medium">{name}</div>
      {note && <p className="leading-snug text-muted-foreground">{note}</p>}
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
  )
}

/** A radio grid of tiles in groups, None first; arrow keys move through the options (and pick, as radios do), Home and End jump to the ends. */
function TileRadios<T extends string>({ label, groups, choice, onChoose, tile, name }: {
  label: string
  groups: { name: string; items: readonly T[] }[]
  choice: T | "none"
  onChoose: (c: T | "none") => void
  tile: (c: T) => React.ReactNode
  name: (c: T) => string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const all: (T | "none")[] = ["none", ...groups.flatMap((g) => g.items)]
  const option = (c: T | "none") => {
    const i = all.indexOf(c)
    const checked = choice === c
    return (
      <button
        key={c}
        ref={(el) => {
          refs.current[i] = el
        }}
        type="button"
        role="radio"
        aria-checked={checked}
        tabIndex={checked ? 0 : -1}
        onClick={() => onChoose(c)}
        onKeyDown={(e) => {
          const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0
          const to = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : step ? (i + step + all.length) % all.length : -1
          if (to < 0) return
          e.preventDefault()
          onChoose(all[to])
          refs.current[to]?.focus()
        }}
        className={cn(
          "flex flex-col items-center gap-1 rounded-lg border p-1.5 text-[11px] leading-tight outline-none focus-visible:ring-2 focus-visible:ring-ring",
          checked ? "border-editor-accent bg-editor-accent/10 ring-1 ring-editor-accent" : "border-border hover:bg-muted"
        )}
      >
        {c === "none" ? <span aria-hidden className="flex h-9 w-16 items-center justify-center rounded bg-muted text-muted-foreground"><Ban className="h-4 w-4" /></span> : tile(c)}
        <span className="text-center">{c === "none" ? "None" : name(c)}</span>
      </button>
    )
  }
  return (
    <div role="radiogroup" aria-label={label} data-transition-grid className="grid gap-3">
      <div className={TILE_GRID}>{option("none")}</div>
      {groups.map((g) => (
        <div key={g.name} className="grid gap-1.5">
          <div className="text-xs font-medium text-muted-foreground">{g.name}</div>
          <div className={TILE_GRID}>{g.items.map((c) => option(c))}</div>
        </div>
      ))}
    </div>
  )
}

/** An audio tile: each sound's gain across the transition (outgoing sky, incoming amber), or an edge fade's one line. */
function AudioSample({ type, edge }: { type: AudioTransitionType; edge?: Edge }) {
  const N = 24
  const line = (gain: (x: number) => number) => Array.from({ length: N + 1 }, (_, k) => `${(k / N) * 64},${34 - gain(k / N) * 30}`).join(" ")
  return (
    <svg aria-hidden viewBox="0 0 64 36" className="block h-9 w-16 rounded bg-muted">
      {edge ? (
        <polyline points={line((x) => audioEdgeState(type, edge, x).gain)} fill="none" strokeWidth={2} className="stroke-teal-600 dark:stroke-teal-300" />
      ) : (
        <>
          <polyline points={line((x) => audioCutState(type, "out", x).gain)} fill="none" strokeWidth={2} className="stroke-sky-600 dark:stroke-sky-300" />
          <polyline points={line((x) => audioCutState(type, "in", x).gain)} fill="none" strokeWidth={2} className="stroke-amber-600 dark:stroke-amber-300" />
        </>
      )}
    </svg>
  )
}

const EDGE_PREFIX = "ps-edge"
const EDGE_KEYFRAMES = (["in", "out"] as const).flatMap((edge) => EDGE_PICTURE_TYPES[edge].map((t) => edgeKeyframes(t, edge, EDGE_PREFIX))).join("\n")
const EDGE_PARTS = { in: new Map(EDGE_PICTURE_TYPES.in.map((t) => [t, edgeLook(t, "in", 0.5)])), out: new Map(EDGE_PICTURE_TYPES.out.map((t) => [t, edgeLook(t, "out", 0.5)])) }
const CHECKER_TILE: React.CSSProperties = { backgroundColor: "#262626", backgroundImage: "conic-gradient(#3a3a3a 25%, transparent 0 50%, #3a3a3a 0 75%, transparent 0)", backgroundSize: "10px 10px" }

/** A picture edge tile: the clip (A going out, B coming in) appearing from or leaving to a checkerboard, looping. */
function EdgeSample({ type, edge }: { type: TransitionType; edge: Edge }) {
  const parts = EDGE_PARTS[edge].get(type)
  const anim = (name: string) => `${EDGE_PREFIX}-${edge}-${type}-${name} ${LOOP}`
  const layer = cn("absolute inset-0 flex items-center justify-center text-[11px] font-bold", edge === "in" ? "bg-amber-400 text-neutral-900" : "bg-sky-500 text-white")
  const letter = edge === "in" ? "B" : "A"
  return (
    <span aria-hidden className="relative isolate block h-9 w-16 overflow-hidden rounded" style={CHECKER_TILE}>
      <span className={layer} style={{ zIndex: 2, animation: anim("to") }}>{letter}</span>
      {parts?.toCopies?.map((s, i) => <span key={i} className={layer} style={{ zIndex: 2, mixBlendMode: s.mixBlendMode, transformOrigin: s.transformOrigin, animation: anim(`to-c${i}`) }}>{letter}</span>)}
      {parts?.overlays?.map((_, i) => <span key={`o${i}`} className="absolute" style={{ zIndex: 4, animation: anim(`ov${i}`) }} />)}
    </span>
  )
}

/** The dialog's frame: title "Transition", the subtitle, and the form with Remove, Cancel and Apply. */
function Frame({ subtitle, onClose, onSubmit, onRemove, canApply, children }: {
  subtitle: string
  onClose: () => void
  onSubmit: () => void
  onRemove?: () => void
  canApply: boolean
  children: React.ReactNode
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[min(60rem,calc(100%-2rem))]" finalFocus={false}>
        <DialogHeader>
          <DialogTitle>Transition</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit()
          }}
        >
          {children}
          <DialogFooter>
            {onRemove && <Button type="button" variant="outline" className="sm:mr-auto" onClick={onRemove}>Remove</Button>}
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!canApply}>Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A duration field with its note: the error, or the longest it can be and why. */
function DurationField({ id, value, onChange, max, disabled, error, note }: { id: string; value: string; onChange: (v: string) => void; max: number; disabled: boolean; error: string | null; note: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Duration (seconds)</Label>
      <Input id={id} type="number" inputMode="decimal" step={0.1} min={MIN_EDGE} max={max > 0 ? max : undefined} value={value} disabled={disabled} aria-invalid={!disabled && error ? true : undefined} aria-describedby={`${id}-note`} onChange={(e) => onChange(e.target.value)} className="w-28" />
      <p id={`${id}-note`} className={cn("text-xs", !disabled && error ? "text-destructive" : "text-muted-foreground")}>{!disabled && error ? error : note}</p>
    </div>
  )
}

/** The cut between two adjoining audio clips: the audio transitions, its duration (trimming the clips as a picture cut does) and the sound's loop. */
function AudioCutDialog({ project, clip, audioUrl, onApply, onClose }: {
  project: Project
  clip: Clip
  audioUrl: (assetId: string) => string
  onApply: (spec: { transition: Transition | null; cutAudio: CutAudio | null }) => void
  onClose: () => void
}) {
  const track = project.audioTrack
  const index = track ? track.clips.findIndex((c) => c.id === clip.id) : -1
  const before = track?.clips[index - 1]
  const tr = clip.transition
  const current = tr && isAudioTransitionType(tr.type) ? { type: tr.type, duration: tr.duration } : undefined
  const range = transitionRange(project, clip.id)
  const { max } = range
  const noFootage = range.reason !== "ok"
  const [choice, setChoice] = useState<AudioTransitionType | "none">(current?.type ?? DEFAULT_AUDIO_TRANSITION)
  const [text, setText] = useState(fmt(current?.duration ?? Math.min(DEFAULT_TRANSITION, Math.max(MIN_TRANSITION, max))))
  const error = durationProblem(text, MIN_TRANSITION, max)
  const shown: Transition | null = choice === "none" || noFootage ? null : { type: choice, duration: previewSeconds(text, MIN_TRANSITION, max) }
  const after = applyCut(project, clip.id, { transition: shown, cutAudio: null })
  const trims = cutTrims(project, after, clip.id)
  const canApply = (choice === "none" ? current !== undefined : !noFootage && error === null)
  if (!before) return null
  const apply = () => {
    if (!canApply) return
    onApply({ transition: choice === "none" ? null : { type: choice, duration: Number(text) }, cutAudio: null })
    onClose()
  }
  const trimNote = trims.ripple > 0
    ? `Applying trims ${[...(trims.outgoing > 0 ? [`${fmt2(trims.outgoing)} s from the end of ${clipName(project, before)}`] : []), ...(trims.incoming > 0 ? [`${fmt2(trims.incoming)} s from the start of ${clipName(project, clip)}`] : [])].join(" and ")}${index < (track?.clips.length ?? 0) - 1 ? `; later clips on the audio layer move ${fmt2(trims.ripple)} s earlier` : ""}.`
    : null
  return (
    <Frame subtitle={`Between ${clipName(project, before)} and ${clipName(project, clip)}`} onClose={onClose} onSubmit={apply} canApply={canApply} onRemove={current ? () => { onApply({ transition: null, cutAudio: null }); onClose() } : undefined}>
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="grid content-start gap-4">
          <TileRadios
            label="Audio transition"
            groups={AUDIO_TRANSITION_GROUPS.map((g) => ({ name: g, items: AUDIO_TRANSITION_TYPES.filter((t) => AUDIO_TRANSITION_INFO[t].group === g) }))}
            choice={choice}
            onChoose={setChoice}
            tile={(t) => <AudioSample type={t} />}
            name={(t) => AUDIO_TRANSITION_INFO[t].name}
          />
          <DurationField
            id="transition-duration"
            value={text}
            onChange={setText}
            max={max}
            disabled={noFootage || choice === "none"}
            error={error}
            note={noFootage ? "These clips are too short for a transition: each needs half of it, and 0.2 s of its own." : `Longest possible: ${fmt(max)} s ${limitNote(range, "a transition")}. Each clip plays half of it beyond the cut; a clip without that much sound is trimmed to make it.`}
          />
        </div>
        <div className="grid content-start gap-3">
          <AudioLoopPreview cut={{ from: before, to: clip }} type={noFootage ? "none" : choice} duration={noFootage ? 0 : previewSeconds(text, MIN_TRANSITION, max)} audioUrl={audioUrl} />
          <GuidePanel name={choice === "none" ? "None (hard cut)" : AUDIO_TRANSITION_INFO[choice].name} guide={choice === "none" ? transitionGuide("none") : AUDIO_TRANSITION_GUIDES[choice]} />
        </div>
      </div>
      {trimNote && <p data-trim-note className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-950 dark:text-amber-100" aria-live="polite">{trimNote}</p>}
    </Frame>
  )
}

/** Why an edge transition can't be had, in the dialog's words. */
const EDGE_REASON: Record<Exclude<EdgeRange["reason"], "ok">, string> = {
  "not-found": "That clip is gone.",
  adjoining: "A clip touches this edge: use the transition between the two instead.",
  text: "A text clip comes in and goes out with its In and Out animations (Edit text, Animation).",
  "too-short": "This clip is too short for another edge transition beside the one at its other end.",
}

/** A clip's free edge: in from nothing or out to nothing, with the transitions its kind offers, the duration and a loop. */
function EdgeDialog({ project, clip, edge, videoUrl, imageUrl, audioUrl, onApplyEdge, onClose }: {
  project: Project
  clip: Clip
  edge: Edge
  videoUrl: (assetId: string) => string
  imageUrl: (assetId: string) => string
  audioUrl: (assetId: string) => string
  onApplyEdge: (spec: EdgeTransition | null) => void
  onClose: () => void
}) {
  const audio = isAudioClip(project, clip)
  const current = edge === "in" ? clip.edgeIn : clip.edgeOut
  const range = edgeLimits(project, clip.id, edge)
  const { max } = range
  const blocked = range.reason !== "ok"
  type Choice = AnyTransitionType | "none"
  const offered = (audio ? EDGE_AUDIO_TYPES[edge] : EDGE_PICTURE_TYPES[edge]) as readonly AnyTransitionType[]
  const [choice, setChoice] = useState<Choice>(current && offered.includes(current.type) ? current.type : audio ? "audio-equalpower" : "fade")
  const [text, setText] = useState(fmt(current?.duration ?? Math.min(DEFAULT_EDGE, Math.max(MIN_EDGE, max))))
  const error = durationProblem(text, MIN_EDGE, max)
  const seconds = previewSeconds(text, MIN_EDGE, max)
  const canApply = choice === "none" ? current !== undefined : !blocked && error === null
  const name = clipName(project, clip)
  const apply = () => {
    if (!canApply) return
    onApplyEdge(choice === "none" ? null : { type: choice, duration: Number(text) })
    onClose()
  }
  const guide = choice === "none"
    ? { name: edge === "in" ? "None (the clip just starts)" : "None (the clip just ends)", guide: edge === "in" ? NONE_IN : NONE_OUT }
    : audio
      ? { name: edgeTransitionName(choice, edge), guide: AUDIO_EDGE_GUIDES[choice as AudioEdgeType] }
      : { name: transitionName(choice), guide: transitionGuide(choice as TransitionType), note: `At ${edge === "in" ? "its start" : "its end"} the other picture is nothing: whatever is on the layers below shows, or black.` }
  return (
    <Frame
      subtitle={edge === "in" ? `In: start of ${name}` : `Out: end of ${name}`}
      onClose={onClose}
      onSubmit={apply}
      canApply={canApply}
      onRemove={current ? () => { onApplyEdge(null); onClose() } : undefined}
    >
      {!audio && <style>{`${EDGE_KEYFRAMES}\n@media (prefers-reduced-motion: reduce){[data-transition-grid] span{animation-play-state:paused!important}}`}</style>}
      {!audio && <TransitionFxDefs />}
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="grid content-start gap-4">
          {audio ? (
            <TileRadios
              label={edge === "in" ? "Fade in" : "Fade out"}
              groups={[
                { name: edge === "in" ? "Fade in curves" : "Fade out curves", items: AUDIO_CURVES },
                { name: "Creative", items: EDGE_AUDIO_TYPES[edge].filter((t) => !(AUDIO_CURVES as readonly string[]).includes(t)) },
              ]}
              choice={choice as AudioTransitionType | "none"}
              onChoose={setChoice}
              tile={(t) => <AudioSample type={t} edge={edge} />}
              name={(t) => (isAudioCurve(t) ? AUDIO_TRANSITION_INFO[t].name : edgeTransitionName(t, edge))}
            />
          ) : (
            <TileRadios
              label={edge === "in" ? "Transition in" : "Transition out"}
              groups={TRANSITION_GROUPS.map((g) => ({ name: g, items: EDGE_PICTURE_TYPES[edge].filter((t) => TRANSITION_INFO[t].group === g) })).filter((g) => g.items.length > 0)}
              choice={choice as TransitionType | "none"}
              onChoose={setChoice}
              tile={(t) => <EdgeSample type={t} edge={edge} />}
              name={(t) => TRANSITION_INFO[t].name}
            />
          )}
          <DurationField
            id="edge-duration"
            value={text}
            onChange={setText}
            max={max}
            disabled={blocked || choice === "none"}
            error={error}
            note={blocked ? EDGE_REASON[range.reason as Exclude<EdgeRange["reason"], "ok">] : `Longest possible: ${fmt(max)} s (${max >= MAX_EDGE - 1e-9 ? "the longest an edge transition can be" : `the clip is ${fmt(clipLength(clip))} s long${(edge === "in" ? clip.edgeOut : clip.edgeIn) ? ", less its other edge transition" : ""}`}). It runs inside the clip: nothing is trimmed or moved.`}
          />
        </div>
        <div className="grid content-start gap-3">
          {audio ? (
            <AudioLoopPreview edge={{ clip, edge }} type={choice === "none" || blocked ? "none" : (choice as AudioTransitionType)} duration={seconds} audioUrl={audioUrl} />
          ) : (
            <EdgeLoopPreview project={project} clip={clip} edge={edge} type={choice === "none" || blocked ? "none" : (choice as TransitionType)} duration={seconds} videoUrl={videoUrl} imageUrl={imageUrl} />
          )}
          <GuidePanel {...guide} />
        </div>
      </div>
    </Frame>
  )
}

const NONE_IN: TransitionGuide = {
  does: "No transition: the clip appears at full strength on its first frame, over whatever was showing before.",
  bestFor: "Cuts on the beat; a clip that should land with impact; most overlays that only need to be there.",
  avoid: "A title or a picture-in-picture that would pop in distractingly; music that would start with a click.",
}
const NONE_OUT: TransitionGuide = {
  does: "No transition: the clip disappears on its last frame, leaving whatever is underneath.",
  bestFor: "Hard endings on a beat; overlays that should vanish the moment they're done.",
  avoid: "Endings that need a moment to breathe; music that would stop with a click.",
}
