"use client"

import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { DEFAULT_FONT, fontById, fontFamily, FONTS } from "@/lib/video/fonts"
import { MAX_TEXT, normalizeText, type ClipText, type TextOrientation } from "@/lib/video/text"
import { cn } from "@/lib/utils"

// A text clip's "Edit text...": the content (new lines where you press
// Enter; nothing wraps), its colour, whether the letters run across or
// stack down, and its font (a scrolling list, each font's name drawn in it
// with its mood, arrow keys moving through it; a sample above shows the text
// in the chosen font and colour). Apply (or Ctrl/Cmd+Enter) is one edit;
// Esc or Cancel leaves the text as it was. Its size is the canvas's corner
// handles, not set here.

export function EditTextDialog({ text, onApply, onClose }: {
  text: ClipText
  onApply: (text: ClipText) => void
  onClose: () => void
}) {
  const [content, setContent] = useState(text.content)
  const [color, setColor] = useState(text.color)
  const [orientation, setOrientation] = useState<TextOrientation>(text.orientation)
  const [font, setFont] = useState(text.font ?? DEFAULT_FONT)
  const fontButtons = useRef<(HTMLButtonElement | null)[]>([])

  const next = normalizeText({ content, color, orientation, font })
  const error = content.trim() === "" ? "Enter some text." : content.length > MAX_TEXT ? `At most ${MAX_TEXT} characters.` : null

  function apply() {
    if (!next) return
    onApply(next)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl" finalFocus={false}>
        <DialogHeader>
          <DialogTitle>Edit text</DialogTitle>
          <DialogDescription>Press Enter for a new line. Resize it with the corner handles on the preview.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            apply()
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="edit-text-content">Text</Label>
            <Textarea
              id="edit-text-content"
              value={content}
              autoFocus
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
            <div
              role="radiogroup"
              aria-labelledby="edit-text-font-label"
              className="grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto rounded-lg border border-input p-1.5"
            >
              {FONTS.map((f, i) => {
                const on = f.id === font
                return (
                  <button
                    key={f.id}
                    ref={(el) => {
                      fontButtons.current[i] = el
                    }}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={`${f.name}, ${f.mood}`}
                    tabIndex={on ? 0 : -1}
                    onClick={() => setFont(f.id)}
                    onKeyDown={(e) => {
                      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]
                      const to = e.key === "Home" ? 0 : e.key === "End" ? FONTS.length - 1 : step ? (i + step + FONTS.length) % FONTS.length : -1
                      if (to < 0) return
                      e.preventDefault()
                      setFont(FONTS[to].id)
                      fontButtons.current[to]?.focus()
                    }}
                    className={cn(
                      "flex min-w-0 flex-col items-start gap-0.5 rounded-md border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted"
                    )}
                  >
                    <span className="w-full truncate text-base leading-normal text-foreground" style={{ fontFamily: `"${fontFamily(f)}"` }}>
                      {f.name}
                    </span>
                    <span className="text-xs text-muted-foreground">{f.mood}</span>
                  </button>
                )
              })}
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
