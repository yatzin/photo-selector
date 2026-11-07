"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { DEFAULT_FONT, fontById, fontFamily } from "@/lib/video/fonts"
import { fitAnims, MAX_TEXT, MIN_ANIM, normalizeText, type AnimType, type ClipText, type TextAnim, type TextOrientation } from "@/lib/video/text"
import { ANIM_GROUPS } from "@/lib/video/text-animation"
import { cn } from "@/lib/utils"
import { FontPicker } from "./font-picker"

// A text clip's "Edit text...": the content (new lines where you press
// Enter; nothing wraps), its colour, whether the letters run across or
// stack down, and its font (components/video/font-picker: 50 fonts filtered
// by mood, each name drawn in its font as it scrolls into view; a sample
// above shows the text in the chosen font and colour). An Animation tab (the clip menu's
// "Animation..." opens on it) sets how the text comes in at the clip's start
// and goes out at its end, each a type and a length in seconds; in and out
// together longer than the clip are shortened to fit (lib/video/text
// fitAnims), as a note says. Apply (or Ctrl/Cmd+Enter) is one edit of all of
// it; Esc or Cancel leaves the text as it was. Its size is the canvas's
// corner handles, not set here.

export type TextSection = "text" | "animation"

const DEFAULT_ANIM_SECONDS = 1

/** One end's animation: a type (or none) and its length as typed. */
function AnimField({ id, label, kind, type, seconds, max, autoFocus, onType, onSeconds }: {
  id: string
  label: string
  kind: "in" | "out"
  type: AnimType | "none"
  seconds: string
  max: number
  autoFocus?: boolean
  onType: (type: AnimType | "none") => void
  onSeconds: (seconds: string) => void
}) {
  return (
    <fieldset className="grid gap-2 rounded-lg border border-input p-3">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      <div className="grid grid-cols-[1fr_7rem] gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-type`}>Animation</Label>
          <select
            id={`${id}-type`}
            value={type}
            autoFocus={autoFocus}
            onChange={(e) => onType(e.target.value as AnimType | "none")}
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
          >
            <option value="none">None</option>
            {ANIM_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.types.map((t) => (
                  <option key={t.type} value={t.type}>{kind === "out" ? (t.out ?? t.label) : t.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-seconds`}>Seconds</Label>
          <input
            id={`${id}-seconds`}
            type="number"
            inputMode="decimal"
            min={MIN_ANIM}
            max={max}
            step={0.1}
            value={seconds}
            disabled={type === "none"}
            onChange={(e) => onSeconds(e.target.value)}
            className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground disabled:opacity-50"
          />
        </div>
      </div>
    </fieldset>
  )
}

export function EditTextDialog({ text, length, section = "text", onApply, onClose }: {
  text: ClipText
  /** The clip's length (seconds): the longest an animation may be. */
  length: number
  /** The tab it opens on. */
  section?: TextSection
  onApply: (text: ClipText) => void
  onClose: () => void
}) {
  const [content, setContent] = useState(text.content)
  const [color, setColor] = useState(text.color)
  const [orientation, setOrientation] = useState<TextOrientation>(text.orientation)
  const [font, setFont] = useState(text.font ?? DEFAULT_FONT)
  const [tab, setTab] = useState<TextSection>(section)
  const [inType, setInType] = useState<AnimType | "none">(text.animIn?.type ?? "none")
  const [inSeconds, setInSeconds] = useState(String(text.animIn?.duration ?? DEFAULT_ANIM_SECONDS))
  const [outType, setOutType] = useState<AnimType | "none">(text.animOut?.type ?? "none")
  const [outSeconds, setOutSeconds] = useState(String(text.animOut?.duration ?? DEFAULT_ANIM_SECONDS))

  /** One end's animation as typed, its length kept from MIN_ANIM to the clip's; null when the length isn't a number. */
  const animOf = (type: AnimType | "none", seconds: string): TextAnim | undefined | null => {
    if (type === "none") return undefined
    const s = Number(seconds)
    if (seconds.trim() === "" || !Number.isFinite(s)) return null
    return { type, duration: Math.round(Math.max(MIN_ANIM, Math.min(length, s)) * 1000) / 1000 }
  }
  const animIn = animOf(inType, inSeconds)
  const animOut = animOf(outType, outSeconds)
  const typed = animIn !== null && animOut !== null ? normalizeText({ content, color, orientation, font, animIn, animOut }) : null
  const next = typed && fitAnims(typed, length)
  const error = content.trim() === "" ? "Enter some text." : content.length > MAX_TEXT ? `At most ${MAX_TEXT} characters.` : null
  const animError = animIn === null || animOut === null ? "Enter each length in seconds." : null
  // Longer than the clip, or in and out together longer: what they'll be shortened to.
  const tooLong = (type: AnimType | "none", seconds: string) => type !== "none" && Number(seconds) > length
  const fitNote = !next
    ? null
    : next !== typed && next.animIn && next.animOut
      ? `In and out together run past the clip's ${length.toFixed(1)} s, so they'll be ${next.animIn.duration} s and ${next.animOut.duration} s.`
      : tooLong(inType, inSeconds) || tooLong(outType, outSeconds)
        ? `An animation runs at most the clip's ${length.toFixed(1)} s.`
        : null

  function apply() {
    if (!next) return
    onApply(next)
    onClose()
  }

  const tabButton = (id: TextSection, label: string) => (
    <button
      type="button"
      role="tab"
      id={`edit-text-tab-${id}`}
      aria-selected={tab === id}
      aria-controls={`edit-text-panel-${id}`}
      tabIndex={tab === id ? 0 : -1}
      onClick={() => setTab(id)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
        e.preventDefault()
        const to = id === "text" ? "animation" : "text"
        setTab(to)
        document.getElementById(`edit-text-tab-${to}`)?.focus()
      }}
      className={cn(
        "rounded-md px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tab === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
      {id === "animation" && (inType !== "none" || outType !== "none") && <span aria-hidden className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-editor-accent align-middle" />}
    </button>
  )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl" finalFocus={false}>
        <DialogHeader>
          <DialogTitle>Edit text</DialogTitle>
          <DialogDescription>
            {tab === "text"
              ? "Press Enter for a new line. Resize it with the corner handles on the preview."
              : "In plays from the clip's start, out up to its end. Move the playhead to see them."}
          </DialogDescription>
        </DialogHeader>
        <div role="tablist" aria-label="Edit text" className="flex w-fit gap-1 rounded-lg bg-muted p-1">
          {tabButton("text", "Text")}
          {tabButton("animation", "Animation")}
        </div>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            apply()
          }}
        >
          <div role="tabpanel" id="edit-text-panel-animation" aria-labelledby="edit-text-tab-animation" hidden={tab !== "animation"} className="grid gap-3">
            <AnimField
              id="edit-text-in"
              label="In"
              kind="in"
              type={inType}
              seconds={inSeconds}
              max={length}
              autoFocus={section === "animation"}
              onType={setInType}
              onSeconds={setInSeconds}
            />
            <AnimField
              id="edit-text-out"
              label="Out"
              kind="out"
              type={outType}
              seconds={outSeconds}
              max={length}
              onType={setOutType}
              onSeconds={setOutSeconds}
            />
            {animError && <p className="text-xs text-destructive">{animError}</p>}
            {fitNote && <p role="status" className="text-xs text-muted-foreground">{fitNote}</p>}
          </div>
          <div role="tabpanel" id="edit-text-panel-text" aria-labelledby="edit-text-tab-text" hidden={tab !== "text"} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="edit-text-content">Text</Label>
              <Textarea
                id="edit-text-content"
                value={content}
                autoFocus={section === "text"}
                rows={3}
                maxLength={MAX_TEXT}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "edit-text-content-error" : undefined}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    apply()
                  }
                }}
                className="max-h-48"
              />
              {error && <p id="edit-text-content-error" className="text-xs text-destructive">{error}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="edit-text-color">Colour</Label>
                <input
                  id="edit-text-color"
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-9 w-full cursor-pointer rounded-lg border border-input bg-background px-1"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="edit-text-orientation">Direction</Label>
                <select
                  id="edit-text-orientation"
                  value={orientation}
                  onChange={(e) => setOrientation(e.target.value as TextOrientation)}
                  className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
                >
                  <option value="horizontal">Horizontal</option>
                  <option value="vertical">Vertical (stacked letters)</option>
                </select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label id="edit-text-font-label">Font</Label>
              <div
                aria-hidden
                className="flex h-16 items-center justify-center overflow-hidden rounded-lg bg-neutral-500 px-3 text-[32px] leading-none whitespace-pre"
                style={{ fontFamily: `"${fontFamily(fontById(font))}"`, color }}
              >
                {content.split("\n")[0] || " "}
              </div>
              <FontPicker font={font} labelledBy="edit-text-font-label" onChange={setFont} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!next}>Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
