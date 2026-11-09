"use client"

import { useMemo, useState, type KeyboardEvent, type MouseEvent } from "react"
import { Crosshair, Minus, Plus, Ruler } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LINKED, setClipTiming, type ClipTiming, type TimingMode } from "@/lib/video/clip-timing"
import { fxPreviewed } from "@/lib/video/audio-levels"
import { lengthSummary } from "@/lib/video/dialog-ui"
import { FieldHelp } from "@/components/ui/field-help"
import { assetKind, clipLength, hasSound, isMagnetic, isTextClip, MIN_CLIP, type Clip, type Project } from "@/lib/video/project"
import { formatSeconds, parseTime, playheadEdge, roundMs, stepTime, typedEdge, type EdgeResult } from "@/lib/video/source-precision"
import type { SourceSelection } from "@/lib/video/source-window"
import { cn } from "@/lib/utils"
import { SelectionPreview, spaceToggles } from "./selection-preview"
import { SourceStrip } from "./source-strip"
import { Callout } from "./ui/callout"
import { CancelButton, DialogFooter, DialogSection, EditorDialog, PrimaryButton, useEditorDialog } from "./ui/editor-dialog"
import { NumberField } from "./ui/number-field"
import { Segmented } from "./ui/segmented"
import { useSelectionPlayer } from "./use-selection-player"

// The clip menu's "Edit length...": Start, End and Length in seconds, kept in
// step (Length keeps Start and moves End, End changes Length, Start moves the
// clip and keeps Length; link icons say so), and what happens to other media
// on the same layer that the new range reaches. On a snapped layer 1 the start
// is fixed and the length always ripples. A clip with sound also gets the
// Source strip: the whole file's waveform (zoomable, focused on the selection)
// with the clip's [in, out) on it. Cropping there changes Length (and End) but
// not Start, sliding changes only in and out, and a typed Length moves the
// window's right edge. Under the strip, In and Out take typed source times
// (seconds or m:ss.mmm), steps (buttons, arrow keys) and the preview's
// playhead. Such a clip also gets a Preview, the dialog's hero, that plays
// exactly the selection, following it live. Apply is one edit (setClipTiming,
// with the in-point when the strip is shown); an In or Out you changed goes in
// on whole milliseconds. The footer says what Apply will do.

const fmt = (n: number) => n.toFixed(2)

/** What a time field holds while it's being typed in (null: it shows the value). */
type FieldText = { text: string; message: string | null } | null

/** A source In or Out: typed seconds or m:ss.mmm, steppers and arrow keys (0.01 s, Shift 0.1, Alt 0.001), and "Set to playhead". */
function SourceTimeField({ side, value, onTry, onPlayhead }: {
  side: "in" | "out"
  value: number
  /** Tries a new value: applied when ok; with `commit`, the clamped one is applied when it isn't. */
  onTry: (value: number, commit: boolean) => EdgeResult
  onPlayhead: () => void
}) {
  const [edit, setEdit] = useState<FieldText>(null)
  const label = side === "in" ? "In" : "Out"
  const id = `edit-length-src-${side}`
  const message = edit?.message ?? null

  function step(dir: 1 | -1, keys: { shift?: boolean; alt?: boolean }) {
    const base = (edit && parseTime(edit.text)) ?? value
    onTry(stepTime(base, dir, keys), true)
    setEdit(null)
  }

  function commit() {
    if (!edit) return
    const n = parseTime(edit.text)
    if (n !== null) onTry(n, true)
    setEdit(null)
  }

  function key(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault()
      step(e.key === "ArrowUp" ? 1 : -1, { shift: e.shiftKey, alt: e.altKey })
    } else if (e.key === "Enter") {
      // Takes the field's value; Apply is its own button.
      e.preventDefault()
      commit()
    } else if (e.key === "Escape" && edit) {
      e.preventDefault()
      e.stopPropagation()
      setEdit(null)
    }
  }

  const nudge = (dir: 1 | -1) => (e: MouseEvent<HTMLButtonElement>) => step(dir, { shift: e.shiftKey })
  const stepper = "flex w-8 shrink-0 items-center justify-center text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground pointer-coarse:w-11"

  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <div className="flex min-h-5 items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <label htmlFor={id} className="field-label">{label}</label>
          {side === "in" ? <FieldHelp id="length.in" /> : <FieldHelp id="length.out" />}
        </span>
        <Button type="button" size="xs" variant="ghost" className="-mr-1.5 text-muted-foreground hover:text-foreground" data-set-to-playhead={side} onClick={onPlayhead} title={`Set ${label} to the preview's playhead`}>
          <Crosshair />
          Set {label} to playhead
        </Button>
      </div>
      <div
        className={cn(
          "flex h-9 min-w-0 items-stretch overflow-hidden rounded-lg border border-input bg-card focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40 dark:bg-input/30 pointer-coarse:h-11",
          message && "border-destructive focus-within:border-destructive focus-within:ring-destructive/25"
        )}
      >
        <button type="button" className={stepper} aria-label={`${label} -0.01 s (Shift: -0.1 s)`} title="-0.01 s (Shift-click: -0.1 s)" data-nudge={`${side}-down`} onClick={nudge(-1)}>
          <Minus className="size-3.5" />
        </button>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={edit?.text ?? formatSeconds(value)}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? `${id}-error` : `${id}-hint`}
          onChange={(e) => {
            const text = e.target.value
            const n = parseTime(text)
            const r = n === null ? null : onTry(n, false)
            setEdit({ text, message: n === null ? "Enter seconds (1.25) or m:ss.mmm (1:02.350)." : r && !r.ok ? r.message : null })
          }}
          onBlur={commit}
          onKeyDown={key}
          className="min-w-0 flex-1 border-x border-input bg-transparent px-2 text-center text-sm font-medium tabular-nums outline-none"
        />
        <button type="button" className={stepper} aria-label={`${label} +0.01 s (Shift: +0.1 s)`} title="+0.01 s (Shift-click: +0.1 s)" data-nudge={`${side}-up`} onClick={nudge(1)}>
          <Plus className="size-3.5" />
        </button>
      </div>
      {message ? (
        <p id={`${id}-error`} className="text-xs text-destructive">{message}</p>
      ) : (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          <span className="sr-only">Seconds or m:ss.mmm. </span>Up and Down step 0.01 s, Shift 0.1 s, Alt 0.001 s.
        </p>
      )}
    </div>
  )
}

/** A typed number, or null when the field isn't one. */
function parse(text: string): number | null {
  if (text.trim() === "") return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

export function EditLengthDialog({ project, folder, clip, track, mediaUrl, onApply, onUnlink, onClose, returnFocus }: {
  project: Project
  /** The project's folder, for the source strip's peaks. */
  folder: string
  clip: Clip
  /** The clip's media file, for the Preview column. */
  mediaUrl: string
  track: number
  onApply: (timing: ClipTiming, mode: TimingMode) => void
  /** Takes the clip's transitions off (offered when the change would part linked clips). */
  onUnlink: () => void
  onClose: () => void
  /** Where the focus goes on close when what opened the dialog is gone (the clip). */
  returnFocus?: () => HTMLElement | null
}) {
  const dialog = useEditorDialog(onClose)
  const snapped = track === 0 && isMagnetic(project)
  // The exact values: a field you don't edit keeps the clip's own (unrounded) number.
  const [start, setStart] = useState(clip.start)
  const [length, setLength] = useState(clipLength(clip))
  const [text, setText] = useState({ start: fmt(clip.start), end: fmt(clip.start + clipLength(clip)), length: fmt(clipLength(clip)) })
  const [mode, setMode] = useState<TimingMode>("push")
  // A clip with sound (an audio clip, or a video whose file has sound) shows its source window.
  const source = hasSound(project, clip) ? project.assets[clip.asset] : undefined
  const [srcIn, setSrcIn] = useState(clip.in)
  const selection: SourceSelection = useMemo(() => ({ in: srcIn, out: srcIn + length }), [srcIn, length])
  // An In or Out you changed goes in on whole milliseconds (one you didn't keeps the clip's own number).
  const applyIn = srcIn === clip.in ? clip.in : roundMs(srcIn)
  const applyOut = srcIn + length === clip.out ? clip.out : roundMs(srcIn + length)
  const timing: ClipTiming = source ? { start, length: applyOut - applyIn, in: applyIn } : { start, length }
  const { attach: mediaRef, ...player } = useSelectionPlayer(selection, clip.audio)

  const typed = { start: parse(text.start), end: parse(text.end), length: parse(text.length) }
  const errors: { start?: string; end?: string; length?: string } = {}
  if (typed.start === null) errors.start = "Enter a number."
  else if (typed.start < 0) errors.start = "Start can't be before 0."
  if (typed.end === null) errors.end = "Enter a number."
  else if (typed.start !== null && typed.end <= typed.start) errors.end = "End must be after Start."
  if (typed.length === null) errors.length = "Enter a number."
  // A length made negative by an End before Start shows only End's message.
  else if (typed.length < MIN_CLIP - 1e-9 && !errors.end) errors.length = `At least ${MIN_CLIP} s.`
  const fieldsOk = !errors.start && !errors.end && !errors.length && length >= MIN_CLIP - 1e-9
  // Memoised: the preview re-renders the dialog every frame while it plays.
  const { start: tStart, length: tLength, in: tIn } = timing
  const result = useMemo(
    () => (fieldsOk ? setClipTiming(project, clip.id, { start: tStart, length: tLength, ...(tIn === undefined ? {} : { in: tIn }) }, mode, () => "check") : null),
    [fieldsOk, project, clip.id, tStart, tLength, tIn, mode]
  )
  const problem = result && !result.ok ? result.error : null
  const canApply = result !== null && result.ok

  function edit(field: "start" | "end" | "length", value: string) {
    const n = parse(value)
    const next = { ...text, [field]: value }
    if (n !== null) {
      if (field === "length") {
        setLength(n)
        next.end = fmt(start + n)
      } else if (field === "end") {
        setLength(n - start)
        next.length = fmt(n - start)
      } else {
        setStart(n)
        next.end = fmt(n + length)
      }
    }
    setText(next)
  }

  // From the strip: Start stays, Length and End follow the window.
  function crop(sel: { in: number; out: number }) {
    const n = sel.out - sel.in
    setSrcIn(sel.in)
    setLength(n)
    setText({ ...text, end: fmt(start + n), length: fmt(n) })
  }

  /** A typed or stepped In or Out (see SourceTimeField). */
  function tryEdge(side: "in" | "out", value: number, commit: boolean): EdgeResult {
    if (!source) return { ok: true, selection }
    const r = typedEdge(selection, side, value, source.duration, MIN_CLIP)
    if (r.ok || commit) crop(r.selection)
    return r
  }

  const unpreviewed = (clip.audio?.fx ?? []).some((f) => !fxPreviewed(f.type))
  const previewNote = clip.audio
    ? `Plays the selection with the clip's audio levels${unpreviewed ? "; export-only filters aren't heard here" : ""}.`
    : "Plays the selection from the clip's own file."

  function apply() {
    if (!canApply) return
    dialog.close(() => onApply(timing, mode))
  }

  const name = isTextClip(clip) ? `Text “${clip.text.content.replace(/\s+/g, " ").slice(0, 40)}”` : (project.assets[clip.asset]?.file ?? "Missing file")
  const changed = fieldsOk ? lengthSummary({ start: clip.start, length: clipLength(clip) }, { start, length }) : null
  const summary = changed && `${changed}${mode === "overwrite" ? ", overwriting what it covers" : ""}.`
  const blocked = canApply ? null : errors.start ? `Start: ${errors.start}` : errors.end ? `End: ${errors.end}` : errors.length ? `Length: ${errors.length}` : (problem ?? "Check the times first.")

  const timingFields = (
    <DialogSection title="Timing" id="edit-length-timing">
      <div className="grid grid-cols-1 gap-x-3 gap-y-3 min-[480px]:grid-cols-3">
        <NumberField
          id="edit-length-start"
          label="Start"
          help="length.start"
          unit="s"
          step={0.1}
          min={0}
          value={text.start}
          onChange={(v) => edit("start", v)}
          disabled={snapped}
          disabledReason="Layer 1 is snapped: it follows the clips before it."
          error={errors.start}
          hint="Moves the clip."
        />
        <NumberField
          id="edit-length-end"
          label="End"
          help="length.end"
          unit="s"
          step={0.1}
          min={0}
          value={text.end}
          onChange={(v) => edit("end", v)}
          error={errors.end}
          linked="End follows Start and Length"
          hint="Changes Length."
        />
        <NumberField
          id="edit-length-length"
          label="Length"
          help="length.length"
          unit="s"
          step={0.1}
          min={MIN_CLIP}
          value={text.length}
          onChange={(v) => edit("length", v)}
          error={errors.length}
          linked="Changing Length keeps Start and moves End"
          hint="Keeps Start."
          initialFocus
        />
      </div>
      {problem && (
        <Callout tone="danger" live action={problem === LINKED && <Button type="button" size="sm" variant="outline" onClick={onUnlink}>Unlink this clip</Button>}>
          <p role="alert">{problem}</p>
        </Callout>
      )}
    </DialogSection>
  )

  const overlap = (
    <DialogSection title="When it overlaps other media" id="edit-length-mode" help="length.mode">
      <Segmented
        label="When it overlaps other media"
        value={mode}
        onChange={setMode}
        options={[
          { value: "push", label: "Push later media" },
          { value: "overwrite", label: "Overwrite", disabledReason: snapped ? "Layer 1 is snapped: the clips after it always move with the length." : undefined },
        ]}
        className="w-full"
      />
      <p className="text-xs leading-snug text-muted-foreground">
        {snapped ? "Layer 1 is snapped: the start follows the clips before it, and the clips after it move with the length." : mode === "push" ? "Later clips on this layer move to make room. Only this layer changes." : "The clip covers what's under its new range. Only this layer changes."}
      </p>
    </DialogSection>
  )

  return (
    <EditorDialog
      state={dialog}
      icon={Ruler}
      title="Edit length"
      subtitle={name}
      size={source ? "xl" : "md"}
      onSubmit={apply}
      returnFocus={returnFocus}
      footer={
        <DialogFooter summary={summary}>
          <CancelButton state={dialog} />
          <PrimaryButton disabledReason={blocked}>Apply length</PrimaryButton>
        </DialogFooter>
      }
    >
      {source ? (
        <div className="grid gap-6" data-edit-length-columns>
          <div className="grid gap-x-6 gap-y-5 min-[720px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <section aria-labelledby="edit-length-preview" className="grid min-w-0 content-start gap-2.5">
              <h3 id="edit-length-preview" className="section-label">Preview</h3>
              <SelectionPreview
                kind={assetKind(source) === "audio" ? "audio" : "video"}
                src={mediaUrl}
                folder={folder}
                assetId={clip.asset}
                selection={selection}
                mediaRef={mediaRef}
                player={player}
                muted={clip.muted === true}
                note={previewNote}
              />
            </section>
            <div className="grid min-w-0 content-start gap-5">
              {timingFields}
              {overlap}
            </div>
          </div>
          <DialogSection title="Source" id="edit-length-source" help="length.source">
            <p className="-mt-1 text-xs leading-snug text-muted-foreground">Drag an edge to crop, or the selection to slide it. Double-click for the whole file. Click the top row to move the preview; zoom with the buttons, + and −, or Ctrl + wheel.</p>
            <div role="group" aria-labelledby="edit-length-source-label" onKeyDown={(e) => spaceToggles(e, player.toggle)}>
              <SourceStrip
                folder={folder}
                assetId={clip.asset}
                duration={source.duration}
                selection={selection}
                minLength={MIN_CLIP}
                muted={clip.muted === true}
                onChange={crop}
                playhead={player.position}
                onSeek={player.seek}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2" data-source-fields>
              <SourceTimeField side="in" value={selection.in} onTry={(v, c) => tryEdge("in", v, c)} onPlayhead={() => crop(playheadEdge(selection, "in", player.position, source.duration, MIN_CLIP))} />
              <SourceTimeField side="out" value={selection.out} onTry={(v, c) => tryEdge("out", v, c)} onPlayhead={() => crop(playheadEdge(selection, "out", player.position, source.duration, MIN_CLIP))} />
            </div>
          </DialogSection>
        </div>
      ) : (
        <div className="grid gap-5" data-edit-length-columns>
          {timingFields}
          {overlap}
        </div>
      )}
    </EditorDialog>
  )
}
