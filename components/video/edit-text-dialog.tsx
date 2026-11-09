"use client"

import { useEffect, useState } from "react"
import { ArrowRightFromLine, ArrowRightToLine, Pause, Play, Type } from "lucide-react"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { DEFAULT_FONT, fontById, fontFamily } from "@/lib/video/fonts"
import { fitAnims, MAX_TEXT, MIN_ANIM, normalizeText, type AnimType, type ClipText, type TextAnim, type TextOrientation } from "@/lib/video/text"
import { animationState, ANIM_GROUPS, demoLength, REST } from "@/lib/video/text-animation"
import { previewBackdrop } from "@/lib/video/text-colours"
import { cn } from "@/lib/utils"
import { FontPicker } from "./font-picker"
import { Callout } from "./ui/callout"
import { CancelButton, DialogFooter, DialogSection, EditorDialog, PrimaryButton, useEditorDialog } from "./ui/editor-dialog"
import { NumberField } from "./ui/number-field"
import { Segmented } from "./ui/segmented"

// A text clip's "Edit text...": the content (new lines where you press
// Enter; nothing wraps), its colour, whether the letters run across or
// stack down, and its font (components/video/font-picker: 50 fonts in mood
// groups, each name drawn in its font as it scrolls into view). The hero is
// the text itself, drawn large in the chosen font and colour on a dark or
// light backdrop by whichever shows that colour better (lib/video/text-colours).
// Beside Colour, a swatch for each colour other text clips in the project use
// (usedColours, most used first) sets it in one click. An Animation tab (the
// clip menu's "Animation..." opens on it) sets how the text comes in at the
// clip's start and goes out at its end, each a type and a length in seconds;
// in and out together longer than the clip are shortened to fit (lib/video/text
// fitAnims), as a note says. Save text (or Ctrl/Cmd+Enter) is one edit of all
// of it; Esc or Cancel leaves the text as it was. Its size is the canvas's
// corner handles, not set here.

export type TextSection = "text" | "animation"

const DEFAULT_ANIM_SECONDS = 1

const animLabel = (type: AnimType, kind: "in" | "out") => {
  for (const g of ANIM_GROUPS) for (const t of g.types) if (t.type === type) return kind === "out" ? (t.out ?? t.label) : t.label
  return type
}

/** One end's animation: a type (or none) and its length as typed. */
function AnimCard({ id, kind, type, seconds, max, error, onType, onSeconds }: {
  id: string
  kind: "in" | "out"
  type: AnimType | "none"
  seconds: string
  max: number
  error: string | null
  onType: (type: AnimType | "none") => void
  onSeconds: (seconds: string) => void
}) {
  const Icon = kind === "in" ? ArrowRightToLine : ArrowRightFromLine
  return (
    <fieldset className="grid content-start gap-3 rounded-xl border border-border p-3.5" data-anim={kind}>
      <legend className="sr-only">{kind === "in" ? "In" : "Out"}</legend>
      <div className="flex items-center gap-2.5" aria-hidden>
        <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-4" /></span>
        <div className="grid leading-tight">
          <span className="text-[13px] font-semibold">{kind === "in" ? "In" : "Out"}</span>
          <span className="text-xs text-muted-foreground">{kind === "in" ? "Plays from the clip's start" : "Plays up to the clip's end"}</span>
        </div>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-type`} className="field-label">Animation</label>
        <Select value={type} onValueChange={(v) => onType((v ?? "none") as AnimType | "none")}>
          <SelectTrigger id={`${id}-type`} className="h-9 w-full pointer-coarse:h-11" data-initial-focus={kind === "in" ? true : undefined}>
            <SelectValue>{(v: AnimType | "none") => (v === "none" ? "None" : animLabel(v, kind))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            {ANIM_GROUPS.map((g) => (
              <SelectGroup key={g.label}>
                <SelectLabel>{g.label}</SelectLabel>
                {g.types.map((t) => (
                  <SelectItem key={t.type} value={t.type}>{kind === "out" ? (t.out ?? t.label) : t.label}</SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
      <NumberField
        id={`${id}-seconds`}
        label="Length"
        unit="s"
        step={0.1}
        min={MIN_ANIM}
        max={max}
        value={seconds}
        onChange={onSeconds}
        disabled={type === "none"}
        disabledReason="Pick an animation to set its length."
        error={error}
        hint={`From ${MIN_ANIM} s up to the clip's ${max.toFixed(1)} s.`}
      />
    </fieldset>
  )
}

export function EditTextDialog({ text, length, section = "text", usedColours = [], onApply, onClose }: {
  text: ClipText
  /** The clip's length (seconds): the longest an animation may be. */
  length: number
  /** The tab it opens on. */
  section?: TextSection
  /** Colours (#rrggbb) other text clips in the project use, shown as swatches. */
  usedColours?: string[]
  onApply: (text: ClipText) => void
  onClose: () => void
}) {
  const dialog = useEditorDialog(onClose)
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
  // Longer than the clip, or in and out together longer: what they'll be shortened to.
  const tooLong = (type: AnimType | "none", seconds: string) => type !== "none" && Number(seconds) > length
  const fitNote = !next
    ? null
    : next !== typed && next.animIn && next.animOut
      ? `In and out together run past the clip's ${length.toFixed(1)} s, so they'll be ${next.animIn.duration} s and ${next.animOut.duration} s.`
      : tooLong(inType, inSeconds) || tooLong(outType, outSeconds)
        ? `An animation runs at most the clip's ${length.toFixed(1)} s.`
        : null

  // On the Animation tab the hero loops the animations: in, a rest, out.
  const demoText = { animIn: next ? next.animIn : animIn ?? undefined, animOut: next ? next.animOut : animOut ?? undefined }
  const demo = tab === "animation" ? demoLength(demoText) : null
  const [playing, setPlaying] = useState(() => typeof window === "undefined" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  const [demoAt, setDemoAt] = useState(0)
  useEffect(() => {
    if (demo === null || !playing) return
    const start = performance.now()
    let raf = requestAnimationFrame(function tick(now) {
      setDemoAt(((now - start) / 1000) % demo)
      raf = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(raf)
  }, [demo, playing])
  const typedCount = content.replaceAll("\n", "").length
  const shown = demo === null ? REST : animationState(demoText, Math.min(demoAt, demo), demo, { bounds: { x: 0.2, y: 0.3, w: 0.6, h: 0.4 }, units: typedCount })
  const reveal = shown.reveal
    ? `inset(${shown.reveal.dir === "down" ? 100 - shown.reveal.fraction * 100 : 0}% ${shown.reveal.dir === "right" ? 100 - shown.reveal.fraction * 100 : 0}% ${shown.reveal.dir === "up" ? 100 - shown.reveal.fraction * 100 : 0}% ${shown.reveal.dir === "left" ? 100 - shown.reveal.fraction * 100 : 0}%)`
    : undefined
  const visibleChars = shown.chars
  let seen = 0

  const backdrop = previewBackdrop(color)
  const fontName = fontById(font).name

  function apply() {
    if (!next) return
    dialog.close(() => onApply(next))
  }

  const blocked = next ? null : error ? (tab === "text" ? error : `Text: ${error}`) : "Enter each animation's length in seconds."
  const summary = (() => {
    const parts = [
      ...(inType !== "none" && animIn ? [`in with ${animLabel(inType, "in")} (${animIn.duration} s)`] : []),
      ...(outType !== "none" && animOut ? [`out with ${animLabel(outType, "out")} (${animOut.duration} s)`] : []),
    ]
    return parts.length ? `Comes ${parts.join(", goes ")}` : null
  })()
  const lines = content.split("\n")

  return (
    <EditorDialog
      state={dialog}
      icon={Type}
      title="Edit text"
      subtitle={`“${text.content.replace(/\s+/g, " ").slice(0, 60)}”, a ${length.toFixed(1)} s text clip`}
      size="lg"
      onSubmit={apply}
      footer={
        <DialogFooter summary={summary}>
          <CancelButton state={dialog} />
          <PrimaryButton disabledReason={blocked}>Save text</PrimaryButton>
        </DialogFooter>
      }
    >
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented
            label="Edit text"
            tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: "text", label: "Text", id: "edit-text-tab-text", controls: "edit-text-panel-text" },
              { value: "animation", label: "Animation", id: "edit-text-tab-animation", controls: "edit-text-panel-animation", marker: inType !== "none" || outType !== "none" },
            ]}
          />
          {tab === "text" && <p className="text-xs text-muted-foreground">Resize it with the corner handles on the canvas.</p>}
        </div>
        {/* The hero: the text as it will look. */}
        <div
          className="relative flex h-36 items-center justify-center overflow-hidden rounded-xl px-6 ring-1 ring-black/10 ring-inset motion-safe:transition-colors motion-safe:duration-200 dark:ring-white/10 sm:h-44"
          style={{ backgroundColor: backdrop.background }}
          data-text-sample
        >
          <div
            aria-hidden
            className="absolute inset-0 flex items-center justify-center px-6"
            style={{ opacity: shown.opacity, transform: `translate(${shown.offsetX * 100}%, ${shown.offsetY * 100}%) rotate(${shown.rotationDeg}deg) scale(${shown.scale})` }}
          >
            <div
              className={cn("max-w-full text-center leading-[1.05] whitespace-pre", orientation === "vertical" && "[writing-mode:vertical-rl] [text-orientation:upright]")}
              style={{ fontFamily: `"${fontFamily(fontById(font))}"`, color, clipPath: reveal, fontSize: `clamp(20px, ${Math.max(18, 44 - Math.max(0, Math.max(...lines.map((l) => l.length)) - 12) * 1.2)}px, 44px)` }}
            >
              {visibleChars === null
                ? content || " "
                : Array.from(content || " ").map((ch, i) => {
                    if (ch === "\n") return ch
                    return <span key={i} className={seen++ < visibleChars ? undefined : "opacity-0"}>{ch}</span>
                  })}
            </div>
          </div>
          {demo !== null && (
            <button
              type="button"
              aria-label={playing ? "Pause the preview" : "Play the preview"}
              onClick={() => setPlaying((v) => !v)}
              className="absolute right-2 bottom-2 flex size-8 items-center justify-center rounded-md bg-black/45 text-white/90 backdrop-blur-sm outline-none hover:bg-black/60 focus-visible:outline-2 focus-visible:outline-white pointer-coarse:size-11"
            >
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </button>
          )}
          <span aria-hidden className="absolute bottom-2 left-3 rounded-md bg-black/45 px-1.5 py-0.5 text-[11px] text-white/90 backdrop-blur-sm">{fontName}</span>
        </div>

        <div role="tabpanel" id="edit-text-panel-text" aria-labelledby="edit-text-tab-text" hidden={tab !== "text"} className="grid gap-5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="grid content-start gap-5">
            <DialogSection title="Words" id="edit-text-words">
              <div className="grid gap-1.5">
                <label htmlFor="edit-text-content" className="sr-only">Text</label>
                <Textarea
                  id="edit-text-content"
                  value={content}
                  data-initial-focus={section === "text" ? true : undefined}
                  rows={3}
                  maxLength={MAX_TEXT}
                  aria-invalid={error ? true : undefined}
                  aria-describedby="edit-text-content-note"
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setContent(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault()
                      apply()
                    }
                  }}
                  className="max-h-40 min-h-20 resize-y text-[15px]"
                />
                <p id="edit-text-content-note" className={cn("flex justify-between gap-2 text-xs", error ? "text-destructive" : "text-muted-foreground")}>
                  <span>{error ?? "Enter starts a new line; Ctrl+Enter saves."}</span>
                  <span className="tabular-nums">{content.length}/{MAX_TEXT}</span>
                </p>
              </div>
            </DialogSection>
            <DialogSection title="Colour" id="edit-text-colour">
              <div className="flex flex-wrap items-center gap-3">
                <label className="relative flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-input bg-card pr-3 pl-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40 dark:bg-input/30 pointer-coarse:h-11">
                  <span aria-hidden className="size-7 rounded-md ring-1 ring-black/15 ring-inset dark:ring-white/20" style={{ backgroundColor: color }} />
                  <span className="text-sm font-medium tabular-nums uppercase">{color}</span>
                  <input id="edit-text-color" type="color" aria-label="Text colour" value={color} onChange={(e) => setColor(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
                </label>
                {usedColours.length > 0 && (
                  <div role="group" aria-label="Colours in other texts" className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-0.5 text-xs text-muted-foreground">In other texts</span>
                    {usedColours.map((c) => {
                      const hex = c.toUpperCase()
                      const on = color.toLowerCase() === c.toLowerCase()
                      return (
                        <button
                          key={c}
                          type="button"
                          title={hex}
                          aria-label={`Use colour ${hex}`}
                          aria-pressed={on}
                          onClick={() => setColor(c.toLowerCase())}
                          className={cn(
                            "size-7 rounded-full ring-1 ring-black/20 ring-inset outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:ring-white/25 pointer-coarse:size-11",
                            on && "outline-2 outline-offset-2 outline-editor-accent"
                          )}
                          style={{ backgroundColor: c }}
                        />
                      )
                    })}
                  </div>
                )}
              </div>
            </DialogSection>
            <DialogSection title="Direction" id="edit-text-direction">
              <Segmented
                label="Direction"
                value={orientation}
                onChange={setOrientation}
                options={[
                  { value: "horizontal", label: "Horizontal" },
                  { value: "vertical", label: "Vertical (stacked)" },
                ]}
                className="w-full sm:w-auto"
              />
            </DialogSection>
          </div>
          <DialogSection title="Font" id="edit-text-font">
            <FontPicker font={font} onChange={setFont} />
          </DialogSection>
        </div>

        <div role="tabpanel" id="edit-text-panel-animation" aria-labelledby="edit-text-tab-animation" hidden={tab !== "animation"} className="grid gap-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200">
          <p className="text-xs text-muted-foreground">In plays from the clip&apos;s start, Out up to its end. Move the playhead over the clip to see them.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <AnimCard id="edit-text-in" kind="in" type={inType} seconds={inSeconds} max={length} error={animIn === null ? "Enter a length in seconds." : null} onType={setInType} onSeconds={setInSeconds} />
            <AnimCard id="edit-text-out" kind="out" type={outType} seconds={outSeconds} max={length} error={animOut === null ? "Enter a length in seconds." : null} onType={setOutType} onSeconds={setOutSeconds} />
          </div>
          {fitNote && <Callout tone="info" live>{fitNote}</Callout>}
        </div>
      </div>
    </EditorDialog>
  )
}
