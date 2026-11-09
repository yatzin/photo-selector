"use client"

import { useState } from "react"
import { ArrowRight, AudioLines, Blend, LogIn, LogOut, Type } from "lucide-react"
import { cn } from "@/lib/utils"
import { trimSummary } from "@/lib/video/dialog-ui"
import { FieldHelp } from "@/components/ui/field-help"
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
import { Tips } from "./ui/callout"
import { CancelButton, DialogFooter, DialogSection, EditorDialog, PrimaryButton, RemoveButton, useEditorDialog, type EditorDialogState } from "./ui/editor-dialog"
import { NumberField } from "./ui/number-field"
import { Segmented } from "./ui/segmented"
import { TileGrid } from "./ui/tile-grid"

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
// (TransitionDialog picks the mode). Every mode uses the shared dialog shell
// (components/video/ui): the loop is the hero on the left (on top on a narrow
// window) with the tips under it; the chooser, the duration and the audio
// overlap on the right; and the footer says what Apply will trim.

const KEYFRAME_PREFIX = "ps-tx"
const KEYFRAMES = TRANSITION_TYPES.map((t) => transitionKeyframes(t, KEYFRAME_PREFIX)).join("\n")
const LOOP = "2.4s linear infinite"

type Choice = TransitionType | "none"

const fmt = (n: number) => String(Math.floor(n * 10 + 1e-9) / 10)

/** The two columns: the loop and its tips, then the controls. */
const COLUMNS = "grid gap-x-6 gap-y-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]"
/** The chooser scrolls inside this height on a wide window. */
const GRID_HEIGHT = "min(21rem, 46dvh)"

/** Each type's copies, overlays and order (the same all through its sample). */
const PARTS = Object.fromEntries(TRANSITION_TYPES.map((t) => [t, lookParts(t)])) as Record<TransitionType, ReturnType<typeof lookParts>>

/** The tile's sample: an "A" picture turning into a "B" one with the effect, looping (with any copies and overlays the effect draws). */
function Sample({ type }: { type: TransitionType }) {
  const layer = "absolute inset-0 flex items-center justify-center text-[13px] font-bold"
  const parts = PARTS[type]
  const anim = (name: string) => `${KEYFRAME_PREFIX}-${type}-${name} ${LOOP}`
  // Blend modes and transform origins don't change over a sample: set once.
  const fixed = (s: { mixBlendMode?: "plus-lighter"; transformOrigin?: string }) => ({ mixBlendMode: s.mixBlendMode, transformOrigin: s.transformOrigin })
  const a = cn(layer, "bg-sky-500 text-white")
  const b = cn(layer, "bg-amber-400 text-neutral-900")
  const fromZ = parts.fromOnTop ? 3 : 1
  return (
    <span aria-hidden className="relative isolate block size-full overflow-hidden bg-black">
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
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {isTextClip(clip) ? (
        <span className="flex h-7 w-11 shrink-0 items-center justify-center rounded-md bg-violet-500/25 text-violet-950 dark:text-violet-50"><Type className="size-3.5" /></span>
      ) : (
        <Thumb src={thumbUrl(clip.asset)} className="h-7 w-11 shrink-0 rounded-md object-cover ring-1 ring-border" />
      )}
      <div className="min-w-0 leading-tight">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="truncate text-xs font-medium" title={name}>{name}</div>
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
  const dialog = useEditorDialog(onClose)
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
    const spec = {
      transition: choice === "none" ? null : { type: choice, duration: seconds },
      cutAudio: audioMode === "none" ? null : { mode: audioMode, duration: audioSeconds },
    }
    dialog.close(() => onApply(spec))
  }

  /** Picks an audio overlap mode, its duration brought within what this cut allows. */
  function pickAudio(mode: AudioChoice) {
    setAudioMode(mode)
    if (mode === "none") return
    const most = audioLimits[mode].max
    const n = Number(audioText)
    if (!Number.isFinite(n) || n > most) setAudioText(fmt(Math.min(most, DEFAULT_CUT_AUDIO)))
  }

  if (!clip || !before) return null
  const guide = transitionGuide(choice)
  const trimNote = (() => {
    const t = trimSummary(trims, { outgoing: clipName(project, before), incoming: clipName(project, clip) }, hasLater)
    if (!t) return shorter ? "Trims made for a longer one are kept." : null
    return `${t}.${shorter ? " Trims are kept." : ""}`
  })()
  const audioReason = (mode: CutAudio["mode"]) => {
    const r = audioLimits[mode].reason
    return r === "ok" ? undefined : AUDIO_REASON[mode][r]
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
  const blocked = canApply
    ? null
    : choice !== "none" && noFootage
      ? "These clips are too short for a transition."
      : choice !== "none" && durationError
        ? `Duration: ${durationError}`
        : audioError
          ? `Overlap: ${audioError}`
          : "Pick a transition or an audio overlap first."
  return (
    <EditorDialog
      state={dialog}
      icon={Blend}
      title="Transition"
      subtitle={`Between ${clipName(project, before)} and ${clipName(project, clip)}`}
      size="xl"
      onSubmit={apply}
      footer={
        <DialogFooter
          start={(current || currentAudio) && <RemoveButton onClick={() => dialog.close(() => onApply({ transition: null, cutAudio: null }))}>Remove</RemoveButton>}
          summary={trimNote && <span data-trim-note>{trimNote}</span>}
        >
          <CancelButton state={dialog} />
          <PrimaryButton disabledReason={blocked}>{choice === "none" && audioMode === "none" ? "Apply hard cut" : "Apply transition"}</PrimaryButton>
        </DialogFooter>
      }
    >
      <style>{`${KEYFRAMES}\n@media (prefers-reduced-motion: reduce){[data-transition-grid] span{animation-play-state:paused!important}}`}</style>
      <TransitionFxDefs />
      <div className={COLUMNS}>
        <div className="grid min-w-0 content-start gap-3">
          <div className="flex items-center gap-2 rounded-xl border border-border px-2.5 py-2">
            <ClipChip project={project} clip={before} thumbUrl={thumbUrl} label="From" />
            <ArrowRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <ClipChip project={project} clip={clip} thumbUrl={thumbUrl} label="To" />
          </div>
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
          <Tips name={choice === "none" ? "None (hard cut)" : TRANSITION_INFO[choice].name} {...guide} />
        </div>
        <div className="grid min-w-0 content-start gap-5">
          <DialogSection title="Transition" id="transition-type" help="transition.type">
            <TileGrid
              label="Transition"
              groups={TRANSITION_GROUPS.map((g) => ({ name: g, items: TRANSITION_TYPES.filter((t) => TRANSITION_INFO[t].group === g) }))}
              value={choice}
              onChange={setChoice}
              none={{ label: "None" }}
              nameOf={(t) => TRANSITION_INFO[t].name}
              glyph={(t) => <Sample type={t} />}
              searchLabel="Search transitions"
              maxHeight={GRID_HEIGHT}
              initialFocus
            />
          </DialogSection>
          <DialogSection title="Timing" id="transition-timing">
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                id="transition-duration"
                label="Duration"
                help="transition.duration"
                unit="s"
                step={0.1}
                min={MIN_TRANSITION}
                max={noFootage ? undefined : max}
                value={text}
                onChange={setText}
                disabled={noFootage || choice === "none"}
                disabledReason={noFootage ? "These clips are too short for a transition: each needs half of it, and 0.2 s of its own." : "A hard cut has no duration."}
                error={choice !== "none" && !noFootage ? durationError : null}
                hint={`Up to ${fmt(max)} s ${limitNote(range, "a transition")}. Half plays each side of the cut.`}
              />
              <div className="grid content-start gap-1.5">
                <span className="field-label flex min-h-5 items-center gap-1.5">Audio overlap<FieldHelp id="transition.audio-overlap" /></span>
                <Segmented
                  label="Audio overlap"
                  value={audioMode}
                  onChange={pickAudio}
                  options={[
                    { value: "none", label: "None" },
                    { value: "j", label: "J-cut", disabledReason: audioReason("j") },
                    { value: "l", label: "L-cut", disabledReason: audioReason("l") },
                  ]}
                  className="w-full"
                />
                <p className="text-xs leading-snug text-muted-foreground">J-cut: the next sound comes in early. L-cut: the sound carries on.</p>
              </div>
              {audioMode !== "none" && (
                <NumberField
                  id="cut-audio-duration"
                  label="Overlap"
                  help="transition.overlap"
                  unit="s"
                  step={0.1}
                  min={MIN_CUT_AUDIO}
                  max={audioMax}
                  value={audioText}
                  onChange={setAudioText}
                  error={audioError}
                  hint={audioLimits[audioMode].reason === "ok" ? `Up to ${fmt(audioMax)} s ${limitNote(audioLimits[audioMode], "an overlap")}.` : undefined}
                />
              )}
            </div>
          </DialogSection>
          <p id="cut-audio-note" className="flex gap-2 rounded-xl bg-muted/60 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground dark:bg-white/[0.04]" data-cut-audio-note>
            <AudioLines aria-hidden className="mt-0.5 size-3.5 shrink-0 text-foreground/70" />
            <span>
              {audioExplain}
              {audioMode !== "none" && choice !== "none" && " It replaces the transition's sound crossfade."}
            </span>
          </p>
        </div>
      </div>
    </EditorDialog>
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

/** An audio tile: each sound's gain across the transition (outgoing sky, incoming amber), or an edge fade's one line. */
function AudioSample({ type, edge }: { type: AudioTransitionType; edge?: Edge }) {
  const N = 24
  const line = (gain: (x: number) => number) => Array.from({ length: N + 1 }, (_, k) => `${(k / N) * 64},${33 - gain(k / N) * 28}`).join(" ")
  return (
    <svg aria-hidden viewBox="0 0 64 36" preserveAspectRatio="none" className="block size-full bg-muted dark:bg-white/[0.06]">
      {edge ? (
        <polyline points={line((x) => audioEdgeState(type, edge, x).gain)} fill="none" strokeWidth={2} vectorEffect="non-scaling-stroke" className="stroke-teal-600 dark:stroke-teal-300" />
      ) : (
        <>
          <polyline points={line((x) => audioCutState(type, "out", x).gain)} fill="none" strokeWidth={2} vectorEffect="non-scaling-stroke" className="stroke-sky-600 dark:stroke-sky-300" />
          <polyline points={line((x) => audioCutState(type, "in", x).gain)} fill="none" strokeWidth={2} vectorEffect="non-scaling-stroke" className="stroke-amber-600 dark:stroke-amber-300" />
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
  const layer = cn("absolute inset-0 flex items-center justify-center text-[13px] font-bold", edge === "in" ? "bg-amber-400 text-neutral-900" : "bg-sky-500 text-white")
  const letter = edge === "in" ? "B" : "A"
  return (
    <span aria-hidden className="relative isolate block size-full overflow-hidden" style={CHECKER_TILE}>
      <span className={layer} style={{ zIndex: 2, animation: anim("to") }}>{letter}</span>
      {parts?.toCopies?.map((s, i) => <span key={i} className={layer} style={{ zIndex: 2, mixBlendMode: s.mixBlendMode, transformOrigin: s.transformOrigin, animation: anim(`to-c${i}`) }}>{letter}</span>)}
      {parts?.overlays?.map((_, i) => <span key={`o${i}`} className="absolute" style={{ zIndex: 4, animation: anim(`ov${i}`) }} />)}
    </span>
  )
}

/** The dialog's frame for the audio cut and edge modes: the shared shell with Remove, Cancel and Apply. */
function Frame({ dialog, icon, subtitle, onSubmit, onRemove, blocked, applyLabel, summary, children }: {
  dialog: EditorDialogState
  icon: typeof Blend
  subtitle: string
  onSubmit: () => void
  onRemove?: () => void
  /** Why Apply can't run now (null: it can). */
  blocked: string | null
  applyLabel: string
  summary?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <EditorDialog
      state={dialog}
      icon={icon}
      title="Transition"
      subtitle={subtitle}
      size="xl"
      onSubmit={onSubmit}
      footer={
        <DialogFooter start={onRemove && <RemoveButton onClick={onRemove}>Remove</RemoveButton>} summary={summary}>
          <CancelButton state={dialog} />
          <PrimaryButton disabledReason={blocked}>{applyLabel}</PrimaryButton>
        </DialogFooter>
      }
    >
      {children}
    </EditorDialog>
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
  const dialog = useEditorDialog(onClose)
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
    const spec = { transition: choice === "none" ? null : { type: choice, duration: Number(text) }, cutAudio: null }
    dialog.close(() => onApply(spec))
  }
  const trimNote = trimSummary(trims, { outgoing: clipName(project, before), incoming: clipName(project, clip) }, index < (track?.clips.length ?? 0) - 1)
  const blocked = canApply ? null : choice === "none" ? "There's no audio transition here to remove." : noFootage ? "These clips are too short for a transition." : `Duration: ${error}`
  return (
    <Frame
      dialog={dialog}
      icon={AudioLines}
      subtitle={`Between ${clipName(project, before)} and ${clipName(project, clip)}`}
      onSubmit={apply}
      blocked={blocked}
      applyLabel={choice === "none" ? "Apply hard cut" : "Apply transition"}
      summary={trimNote && <span data-trim-note>{trimNote}.</span>}
      onRemove={current ? () => dialog.close(() => onApply({ transition: null, cutAudio: null })) : undefined}
    >
      <div className={COLUMNS}>
        <div className="grid min-w-0 content-start gap-3">
          <AudioLoopPreview cut={{ from: before, to: clip }} type={noFootage ? "none" : choice} duration={noFootage ? 0 : previewSeconds(text, MIN_TRANSITION, max)} audioUrl={audioUrl} />
          <Tips name={choice === "none" ? "None (hard cut)" : AUDIO_TRANSITION_INFO[choice].name} {...(choice === "none" ? transitionGuide("none") : AUDIO_TRANSITION_GUIDES[choice])} />
        </div>
        <div className="grid min-w-0 content-start gap-5">
          <DialogSection title="Audio transition" id="audio-transition-type" help="transition.audio-type">
            <TileGrid
              label="Audio transition"
              groups={AUDIO_TRANSITION_GROUPS.map((g) => ({ name: g, items: AUDIO_TRANSITION_TYPES.filter((t) => AUDIO_TRANSITION_INFO[t].group === g) }))}
              value={choice}
              onChange={setChoice}
              none={{ label: "None" }}
              nameOf={(t) => AUDIO_TRANSITION_INFO[t].name}
              glyph={(t) => <AudioSample type={t} />}
              searchLabel="Search audio transitions"
              maxHeight={GRID_HEIGHT}
              initialFocus
            />
          </DialogSection>
          <DialogSection title="Timing" id="audio-transition-timing">
            <NumberField
              id="transition-duration"
              label="Duration"
                help="transition.duration"
              unit="s"
              step={0.1}
              min={MIN_TRANSITION}
              max={max}
              value={text}
              onChange={setText}
              disabled={noFootage || choice === "none"}
              disabledReason={noFootage ? "These clips are too short for a transition: each needs half of it, and 0.2 s of its own." : "A hard cut has no duration."}
              error={error}
              hint={`Up to ${fmt(max)} s ${limitNote(range, "a transition")}. Half plays each side of the cut.`}
              className="sm:max-w-[calc(50%-0.5rem)]"
            />
          </DialogSection>
        </div>
      </div>
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
  const dialog = useEditorDialog(onClose)
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
    const spec = choice === "none" ? null : { type: choice, duration: Number(text) }
    dialog.close(() => onApplyEdge(spec))
  }
  const guide = choice === "none"
    ? { name: edge === "in" ? "None (the clip just starts)" : "None (the clip just ends)", ...(edge === "in" ? NONE_IN : NONE_OUT) }
    : audio
      ? { name: edgeTransitionName(choice, edge), ...AUDIO_EDGE_GUIDES[choice as AudioEdgeType] }
      : { name: transitionName(choice), ...transitionGuide(choice as TransitionType), note: `At ${edge === "in" ? "its start" : "its end"} the other picture is nothing: whatever is on the layers below shows, or black.` }
  const why = canApply ? null : choice === "none" ? "There's no edge transition here to remove." : blocked ? EDGE_REASON[range.reason as Exclude<EdgeRange["reason"], "ok">] : `Duration: ${error}`
  return (
    <Frame
      dialog={dialog}
      icon={edge === "in" ? LogIn : LogOut}
      subtitle={edge === "in" ? `In: start of ${name}` : `Out: end of ${name}`}
      onSubmit={apply}
      blocked={why}
      applyLabel={choice === "none" ? (edge === "in" ? "Apply plain start" : "Apply plain end") : edge === "in" ? "Apply transition in" : "Apply transition out"}
      summary={choice !== "none" && !blocked ? "Runs inside the clip: nothing is trimmed or moved." : undefined}
      onRemove={current ? () => dialog.close(() => onApplyEdge(null)) : undefined}
    >
      {!audio && <style>{`${EDGE_KEYFRAMES}\n@media (prefers-reduced-motion: reduce){[data-transition-grid] span{animation-play-state:paused!important}}`}</style>}
      {!audio && <TransitionFxDefs />}
      <div className={COLUMNS}>
        <div className="grid min-w-0 content-start gap-3">
          {audio ? (
            <AudioLoopPreview edge={{ clip, edge }} type={choice === "none" || blocked ? "none" : (choice as AudioTransitionType)} duration={seconds} audioUrl={audioUrl} />
          ) : (
            <EdgeLoopPreview project={project} clip={clip} edge={edge} type={choice === "none" || blocked ? "none" : (choice as TransitionType)} duration={seconds} videoUrl={videoUrl} imageUrl={imageUrl} />
          )}
          <Tips {...guide} />
        </div>
        <div className="grid min-w-0 content-start gap-5">
          <DialogSection title={audio ? (edge === "in" ? "Fade in" : "Fade out") : edge === "in" ? "Transition in" : "Transition out"} id="edge-type" help="transition.edge">
            {audio ? (
              <TileGrid
                label={edge === "in" ? "Fade in" : "Fade out"}
                groups={[
                  { name: edge === "in" ? "Fade in curves" : "Fade out curves", items: AUDIO_CURVES },
                  { name: "Creative", items: EDGE_AUDIO_TYPES[edge].filter((t) => !(AUDIO_CURVES as readonly string[]).includes(t)) },
                ]}
                value={choice as AudioTransitionType | "none"}
                onChange={setChoice}
                none={{ label: "None" }}
                nameOf={(t) => (isAudioCurve(t) ? AUDIO_TRANSITION_INFO[t].name : edgeTransitionName(t, edge))}
                glyph={(t) => <AudioSample type={t} edge={edge} />}
                maxHeight={GRID_HEIGHT}
                initialFocus
              />
            ) : (
              <TileGrid
                label={edge === "in" ? "Transition in" : "Transition out"}
                groups={TRANSITION_GROUPS.map((g) => ({ name: g, items: EDGE_PICTURE_TYPES[edge].filter((t) => TRANSITION_INFO[t].group === g) })).filter((g) => g.items.length > 0)}
                value={choice as TransitionType | "none"}
                onChange={setChoice}
                none={{ label: "None" }}
                nameOf={(t) => TRANSITION_INFO[t].name}
                glyph={(t) => <EdgeSample type={t} edge={edge} />}
                searchLabel="Search transitions"
                maxHeight={GRID_HEIGHT}
                initialFocus
              />
            )}
          </DialogSection>
          <DialogSection title="Timing" id="edge-timing">
            <NumberField
              id="edge-duration"
              label="Duration"
                help="transition.duration"
              unit="s"
              step={0.1}
              min={MIN_EDGE}
              max={max > 0 ? max : undefined}
              value={text}
              onChange={setText}
              disabled={blocked || choice === "none"}
              disabledReason={blocked ? EDGE_REASON[range.reason as Exclude<EdgeRange["reason"], "ok">] : edge === "in" ? "The clip just starts: no duration." : "The clip just ends: no duration."}
              error={error}
              hint={`Up to ${fmt(max)} s (${max >= MAX_EDGE - 1e-9 ? "the longest an edge transition can be" : `the clip is ${fmt(clipLength(clip))} s long${(edge === "in" ? clip.edgeOut : clip.edgeIn) ? ", less its other edge transition" : ""}`}). It runs inside the clip: nothing is trimmed or moved.`}
              className="sm:max-w-[calc(50%-0.5rem)]"
            />
          </DialogSection>
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
