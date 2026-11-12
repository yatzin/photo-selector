"use client"

import { useState } from "react"
import { Gauge, Loader2, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MAX_REVERSE_SECONDS, PREVIEW_SECONDS, MAX_SPEED, MIN_SPEED, retimedLength, retimeError, sourceWindow, speedText, SPEED_PRESETS, type Retime } from "@/lib/video/retime"
import { formatTimecode } from "@/lib/video/time"
import { CancelButton, DialogFooter, DialogSection, EditorDialog, PrimaryButton, RemoveButton, useEditorDialog } from "./ui/editor-dialog"
import { Segmented } from "./ui/segmented"

// The Speed / Reverse dialog for a video or sound clip: a preset or typed speed (1× is
// normal, 0.5× slow motion, 2× fast forward) and Reverse. Apply makes a copy of
// the part of the file the clip plays at that speed (the original is never
// changed and is always what the copy is made from) and points the clip at it,
// one undo step; Reset puts the clip back on the original at normal speed.

export function SpeedDialog({ assetId, asset, trimIn, trimOut, name, onApply, onPreview, onClose, returnFocus }: {
  assetId: string
  asset: { retime?: Retime }
  /** The clip's trim of `asset` (s). */
  trimIn: number
  trimOut: number
  name: string
  /** Makes the retimed copy and points the clip at it; resolves to an error message, or null when it worked (the dialog then closes). */
  onApply: (speed: number, reverse: boolean) => Promise<string | null>
  /** Makes a short sample from the middle of the clip's media at that speed and direction to listen to; nothing is stored. */
  onPreview: (speed: number, reverse: boolean) => Promise<{ dataUrl: string; audioOnly: boolean } | { error: string }>
  onClose: () => void
  returnFocus?: () => HTMLElement | null
}) {
  const dialog = useEditorDialog(onClose)
  const retime = asset.retime
  const [speed, setSpeed] = useState(retime?.speed ?? 1)
  const [text, setText] = useState(String(retime?.speed ?? 1))
  const [reverse, setReverse] = useState(retime?.reverse ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The sample being listened to (made for one speed and direction), and whether one is being made.
  const [sample, setSample] = useState<{ dataUrl: string; audioOnly: boolean } | null>(null)
  const [previewing, setPreviewing] = useState(false)

  // The part of the original the clip shows: the length it plays for at this speed.
  const win = sourceWindow(assetId, asset, trimIn, trimOut)
  const typed = Number(text)
  const speedValid = text.trim() !== "" && Number.isFinite(typed) && typed >= MIN_SPEED && typed <= MAX_SPEED
  const problem = !speedValid ? `Enter a speed from ${MIN_SPEED} to ${MAX_SPEED}.` : retimeError(typed, reverse, win.from, win.to)
  const unchanged = speedValid && typed === (retime?.speed ?? 1) && reverse === (retime?.reverse ?? false)
  const length = speedValid ? retimedLength(win.from, win.to, typed) : null

  function choose(value: number) {
    setSpeed(value)
    setText(String(value))
    setSample(null)
  }

  async function preview() {
    if (previewing || busy || problem) return
    setPreviewing(true)
    setError(null)
    setSample(null)
    const r = await onPreview(typed, reverse)
    setPreviewing(false)
    if ("error" in r) setError(r.error)
    else setSample(r)
  }

  async function apply(toSpeed: number, toReverse: boolean) {
    if (busy) return
    setBusy(true)
    setError(null)
    const failed = await onApply(toSpeed, toReverse)
    setBusy(false)
    if (failed) setError(failed)
    else dialog.close()
  }

  const preset = SPEED_PRESETS.find((p) => p === speed && String(p) === text)

  return (
    <EditorDialog
      state={dialog}
      icon={Gauge}
      title="Speed / Reverse"
      subtitle={name}
      size="md"
      onSubmit={() => void apply(typed, reverse)}
      returnFocus={returnFocus}
      footer={
        <DialogFooter
          summary={error ?? (length !== null ? `Plays for ${formatTimecode(length)} (was ${formatTimecode(win.to - win.from)} at normal speed).` : undefined)}
          start={retime ? <RemoveButton onClick={() => void apply(1, false)}>Reset to normal</RemoveButton> : undefined}
        >
          <CancelButton state={dialog} disabled={busy} />
          <PrimaryButton busy={busy} disabledReason={problem ?? (unchanged ? "Nothing changed." : null)}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {busy ? "Making it…" : "Apply"}
          </PrimaryButton>
        </DialogFooter>
      }
    >
      <div className="grid gap-4">
        <DialogSection title="Speed">
          <div className="grid gap-3">
            <Segmented
              label="Speed"
              size="sm"
              value={preset !== undefined ? String(preset) : ""}
              options={SPEED_PRESETS.map((p) => ({ value: String(p), label: speedText(p) }))}
              onChange={(v) => choose(Number(v))}
            />
            <label className="flex items-center gap-2 text-sm">
              <span>Custom</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                aria-label="Speed"
                value={text}
                onChange={(e) => {
                  setSample(null)
                  setText(e.target.value)
                  const n = Number(e.target.value)
                  if (Number.isFinite(n) && n > 0) setSpeed(n)
                }}
                className="h-9 w-24 rounded-lg border border-input bg-card px-2 text-center text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <span className="text-muted-foreground">× (1 is normal, 0.5 slow motion, 2 fast forward)</span>
            </label>
          </div>
        </DialogSection>
        <DialogSection title="Direction">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={reverse} onChange={(e) => {
                setReverse(e.target.checked)
                setSample(null)
              }} className="mt-0.5" />
            <span>
              Reverse
              <span className="block text-xs text-muted-foreground">Plays the clip backwards (a video with its sound). Up to {MAX_REVERSE_SECONDS} s at a time, so trim a long clip first.</span>
            </span>
          </label>
        </DialogSection>
        <DialogSection title="Preview">
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" onClick={() => void preview()} disabled={previewing || busy || Boolean(problem)}>
                {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} {previewing ? "Making a sample…" : "Preview"}
              </Button>
              <span className="text-xs text-muted-foreground">About {PREVIEW_SECONDS} seconds from the middle of the clip, at this speed{reverse ? ", backwards" : ""}.</span>
            </div>
            {sample && (sample.audioOnly ? (
              <audio key={sample.dataUrl} src={sample.dataUrl} controls autoPlay className="w-full" />
            ) : (
              <video key={sample.dataUrl} src={sample.dataUrl} controls autoPlay playsInline className="max-h-56 w-full rounded-lg bg-black" />
            ))}
          </div>
        </DialogSection>
        <p className="text-xs text-muted-foreground">Making the new speed re-encodes the part of the file the clip uses, so a long or large clip takes a moment. The original file is never changed.</p>
      </div>
    </EditorDialog>
  )
}
