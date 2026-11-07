"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { MAX_TEXT, normalizeText, type ClipText, type TextOrientation } from "@/lib/video/text"

// A text clip's "Edit text...": the content (new lines where you press
// Enter; nothing wraps), its colour and whether the letters run across or
// stack down. Apply (or Ctrl/Cmd+Enter) is one edit; Esc or Cancel leaves the
// text as it was. Its size is the canvas's corner handles, not set here.

export function EditTextDialog({ text, onApply, onClose }: {
  text: ClipText
  onApply: (text: ClipText) => void
  onClose: () => void
}) {
  const [content, setContent] = useState(text.content)
  const [color, setColor] = useState(text.color)
  const [orientation, setOrientation] = useState<TextOrientation>(text.orientation)

  const next = normalizeText({ content, color, orientation })
  const error = content.trim() === "" ? "Enter some text." : content.length > MAX_TEXT ? `At most ${MAX_TEXT} characters.` : null

  function apply() {
    if (!next) return
    onApply(next)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" finalFocus={false}>
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
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!next}>Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
