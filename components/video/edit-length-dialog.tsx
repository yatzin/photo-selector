"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { LINKED, setClipTiming, type ClipTiming, type TimingMode } from "@/lib/video/clip-timing"
import { clipLength, hasSound, isMagnetic, MIN_CLIP, type Clip, type Project } from "@/lib/video/project"
import { SourceStrip } from "./source-strip"

// The clip menu's "Edit length...": Start, End and Length in seconds, kept in
// step (Length keeps Start and moves End, End changes Length, Start moves the
// clip and keeps Length), and what happens to other media on the same layer
// that the new range reaches. On a snapped layer 1 the start is fixed and the
// length always ripples. A clip with sound also gets the Source strip: the
// whole file's waveform with the clip's [in, out) on it. Cropping there
// changes Length (and End) but not Start, sliding changes only in and out,
// and a typed Length moves the window's right edge. Apply is one edit
// (setClipTiming, with the in-point when the strip is shown).

const fmt = (n: number) => n.toFixed(2)

/** A typed number, or null when the field isn't one. */
function parse(text: string): number | null {
  if (text.trim() === "") return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

export function EditLengthDialog({ project, folder, clip, track, onApply, onUnlink, onClose }: {
  project: Project
  /** The project's folder, for the source strip's peaks. */
  folder: string
  clip: Clip
  track: number
  onApply: (timing: ClipTiming, mode: TimingMode) => void
  /** Takes the clip's transitions off (offered when the change would part linked clips). */
  onUnlink: () => void
  onClose: () => void
}) {
  const snapped = track === 0 && isMagnetic(project)
  // The exact values: a field you don't edit keeps the clip's own (unrounded) number.
  const [start, setStart] = useState(clip.start)
  const [length, setLength] = useState(clipLength(clip))
  const [text, setText] = useState({ start: fmt(clip.start), end: fmt(clip.start + clipLength(clip)), length: fmt(clipLength(clip)) })
  const [mode, setMode] = useState<TimingMode>("push")
  // A clip with sound (an audio clip, or a video whose file has sound) shows its source window.
  const source = hasSound(project, clip) ? project.assets[clip.asset] : undefined
  const [srcIn, setSrcIn] = useState(clip.in)
  const timing: ClipTiming = source ? { start, length, in: srcIn } : { start, length }

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
  const result = fieldsOk ? setClipTiming(project, clip.id, timing, mode, () => "check") : null
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

  function apply() {
    if (!canApply) return
    onApply(timing, mode)
    onClose()
  }

  const field = (key: "start" | "end" | "length", label: string, readOnly = false) => (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={`edit-length-${key}`}>{label}</Label>
      <Input
        id={`edit-length-${key}`}
        type="number"
        inputMode="decimal"
        step={0.01}
        min={0}
        value={text[key]}
        readOnly={readOnly}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `edit-length-${key}-error` : undefined}
        onChange={(e) => edit(key, e.target.value)}
        className={readOnly ? "bg-muted text-muted-foreground" : undefined}
      />
      {errors[key] && <p id={`edit-length-${key}-error`} className="text-xs text-destructive">{errors[key]}</p>}
    </div>
  )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={source ? "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[min(42rem,calc(100%-2rem))]" : "sm:max-w-md"} finalFocus={false}>
        <DialogHeader>
          <DialogTitle>Edit length</DialogTitle>
          <DialogDescription>Times in seconds. Changing Length keeps Start and moves End.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            apply()
          }}
        >
          <div className="grid grid-cols-3 gap-3">
            {field("start", "Start", snapped)}
            {field("end", "End")}
            {field("length", "Length")}
          </div>
          {source && (
            <div className="grid gap-1.5">
              <Label id="edit-length-source">Source</Label>
              <p className="text-xs text-muted-foreground">Drag an edge to crop, or the selection to slide it along the file. Double-click for the whole file.</p>
              <div role="group" aria-labelledby="edit-length-source">
                <SourceStrip
                  folder={folder}
                  assetId={clip.asset}
                  duration={source.duration}
                  selection={{ in: srcIn, out: srcIn + length }}
                  minLength={MIN_CLIP}
                  muted={clip.muted === true}
                  onChange={crop}
                />
              </div>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="edit-length-mode">When it overlaps other media</Label>
            <select
              id="edit-length-mode"
              value={mode}
              disabled={snapped}
              onChange={(e) => setMode(e.target.value as TimingMode)}
              className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground disabled:opacity-50"
            >
              <option value="push">Push later media</option>
              <option value="overwrite">Overwrite media</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {snapped ? "Layer 1 is snapped: the start follows the clips before it, and the clips after it move with the length." : "Only this layer changes."}
            </p>
          </div>
          {problem && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-xs text-destructive">{problem}</p>
              {problem === LINKED && (
                <Button type="button" size="sm" variant="outline" onClick={onUnlink}>Unlink this clip</Button>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!canApply}>Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
