"use client"

import { useState } from "react"
import { Layers, Loader2, Lock, Music, Replace, Type, ZoomIn, ZoomOut } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { assetLabel, clipLength, totalLength, type Project } from "@/lib/video/project"
import { MAX_SLOT_LABEL, MAX_TEMPLATE_DESCRIPTION, type TemplateInfo } from "@/lib/video/template"
import { slotCandidates } from "@/lib/video/template-slots"
import { formatTimecode } from "@/lib/video/time"
import { cn } from "@/lib/utils"
import { Thumb } from "./thumb"
import { CancelButton, DialogFooter, DialogSection, EditorDialog, PrimaryButton, useEditorDialog } from "./ui/editor-dialog"

// Create template, and Slots for a template: every clip with media (and every
// text) in the project, each Fixed (stays as it is in every project made from
// it) or Replaceable (a slot, with the label its filler sees). Pictures and
// videos start replaceable, sounds and text fixed. Clicking a row selects the
// clip on the timeline behind. Create saves a copy of the project as a template
// (the project itself is untouched); Slots changes an existing template.

const LABEL_W = 64 // px, the layer names column
const ROW_H = 52 // px per layer
const MIN_PPS = 4
const MAX_PPS = 160

export function TemplateSetupDialog({ mode, project, initial, defaultName, thumbUrl, onSelectClip, onSave, onClose }: {
  mode: "create" | "edit"
  project: Project
  /** The template's current slots and description (edit). */
  initial?: TemplateInfo
  defaultName?: string
  thumbUrl: (assetId: string) => string
  onSelectClip: (clipId: string) => void
  /** Saves; resolves to an error message, or null when it worked (the dialog then closes). */
  onSave: (input: { name: string; description: string; slots: Record<string, string> }) => Promise<string | null>
  onClose: () => void
}) {
  const dialog = useEditorDialog(onClose)
  const rows = slotCandidates(project)
  const [marks, setMarks] = useState<Record<string, { on: boolean; label: string }>>(() =>
    Object.fromEntries(rows.map((r) => [r.clip.id, initial ? { on: initial.slots[r.clip.id] !== undefined, label: initial.slots[r.clip.id]?.label ?? r.defaultLabel } : { on: r.defaultReplaceable, label: r.defaultLabel }]))
  )
  const [name, setName] = useState(defaultName ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The timeline view: px per second (the whole project fits the dialog to begin with), a lane per layer from the top down, the audio layer last.
  const total = Math.max(1, totalLength(project))
  const [pps, setPps] = useState(() => Math.min(MAX_PPS, Math.max(MIN_PPS, 560 / total)))
  const width = Math.ceil(total * pps) + 16
  const lanes = [...project.tracks.map((_, track) => track).reverse(), ...(project.audioTrack?.clips.length ? [-1] : [])]
    .map((track) => ({ track, rows: rows.filter((r) => r.track === track) }))
    .filter((l) => l.rows.length > 0)
  const tickEvery = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((n) => n * pps >= 56) ?? 600
  const ticks = Array.from({ length: Math.floor(total / tickEvery) + 1 }, (_, i) => i * tickEvery)
  const replaceable = rows.filter((r) => marks[r.clip.id]?.on)
  const setAll = (on: boolean) => setMarks((s) => Object.fromEntries(Object.entries(s).map(([id, m]) => [id, { ...m, on: on && rows.find((r) => r.clip.id === id)?.kind === "visual" }])))

  const count = Object.values(marks).filter((m) => m.on).length
  const problem = mode === "create" && !name.trim() ? "Name the template first." : count === 0 ? "Mark at least one clip as replaceable." : null

  async function save() {
    if (busy || problem) return
    setBusy(true)
    setError(null)
    const slots = Object.fromEntries(Object.entries(marks).filter(([, m]) => m.on).map(([id, m]) => [id, m.label]))
    const failed = await onSave({ name: name.trim(), description: description.trim(), slots })
    setBusy(false)
    if (failed) setError(failed)
    else dialog.close()
  }

  return (
    <EditorDialog
      state={dialog}
      icon={Layers}
      title={mode === "create" ? "Create template" : "Template slots"}
      subtitle={mode === "create" ? "Choose what stays and what can be replaced" : project.name}
      size="lg"
      dismissible={!busy}
      onSubmit={() => void save()}
      footer={
        <DialogFooter summary={error ?? `${count} replaceable, ${rows.length - count} fixed.`}>
          <CancelButton state={dialog} disabled={busy} />
          <PrimaryButton busy={busy} disabledReason={problem}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {mode === "create" ? "Save template" : "Save slots"}
          </PrimaryButton>
        </DialogFooter>
      }
    >
      <div className="grid gap-4">
        {mode === "create" && (
          <div className="grid gap-1.5">
            <label htmlFor="template-name" className="field-label">Template name</label>
            <Input id="template-name" data-initial-focus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Birthday reel" autoComplete="off" className="h-9" />
          </div>
        )}
        <div className="grid gap-1.5">
          <label htmlFor="template-description" className="field-label">Description (optional)</label>
          <Input id="template-description" value={description} maxLength={MAX_TEMPLATE_DESCRIPTION} onChange={(e) => setDescription(e.target.value)} placeholder="A 30 second intro with a logo sting" autoComplete="off" className="h-9" />
        </div>
        <DialogSection
          title="Timeline"
          action={
            <span className="flex items-center gap-1">
              <Button type="button" size="xs" variant="ghost" onClick={() => setAll(true)} title="Make every picture and video replaceable">All media</Button>
              <Button type="button" size="xs" variant="ghost" onClick={() => setAll(false)} title="Make every clip fixed">None</Button>
              <Button type="button" size="icon-xs" variant="ghost" onClick={() => setPps((z) => Math.max(MIN_PPS, z / 1.5))} disabled={pps <= MIN_PPS} aria-label="Zoom out"><ZoomOut className="h-3.5 w-3.5" /></Button>
              <Button type="button" size="icon-xs" variant="ghost" onClick={() => setPps((z) => Math.min(MAX_PPS, z * 1.5))} disabled={pps >= MAX_PPS} aria-label="Zoom in"><ZoomIn className="h-3.5 w-3.5" /></Button>
            </span>
          }
        >
          <p className="mb-2 text-xs text-muted-foreground">Click a clip to switch it between fixed and replaceable. Fixed clips stay as they are in every project made from the template. Replaceable ones become slots that show a placeholder with their label; their media is not kept in the template, and neither is any other Project media a fixed clip does not use. A slot keeps its position, size, effects and transitions.</p>
          <div className="overflow-x-auto rounded-lg border bg-muted/30" data-template-timeline>
            <div className="relative" style={{ width: LABEL_W + width }}>
              <div className="flex h-5 border-b text-[10px] text-muted-foreground">
                <div className="sticky left-0 z-10 shrink-0 border-r bg-card" style={{ width: LABEL_W }} />
                <div className="relative flex-1">
                  {ticks.map((t) => (
                    <span key={t} className="absolute top-0 h-full border-l pl-1 leading-5" style={{ left: t * pps }}>{formatTimecode(t)}</span>
                  ))}
                </div>
              </div>
              {lanes.map((lane) => (
                <div key={lane.track} className="flex border-b last:border-b-0" style={{ height: ROW_H }}>
                  <div className="sticky left-0 z-10 flex shrink-0 items-center border-r bg-card px-2 text-[11px] font-medium text-muted-foreground" style={{ width: LABEL_W }}>
                    {lane.track < 0 ? "Audio" : `Layer ${lane.track + 1}`}
                  </div>
                  <div className="relative flex-1">
                    {lane.rows.map((r) => {
                      const m = marks[r.clip.id]
                      const asset = r.kind === "text" ? undefined : project.assets[r.clip.asset]
                      const w = Math.max(clipLength(r.clip) * pps - 2, 10)
                      const name = r.kind === "text" ? `“${r.clip.text?.content ?? ""}”` : asset ? assetLabel(asset) : "Missing file"
                      return (
                        <button
                          key={r.clip.id}
                          type="button"
                          aria-pressed={m.on}
                          aria-label={`${name}, ${r.what}, ${formatTimecode(clipLength(r.clip))}: ${m.on ? `replaceable as ${m.label}` : "fixed"}`}
                          title={`${name} (${r.what}, ${formatTimecode(clipLength(r.clip))}). Click to make it ${m.on ? "fixed" : "replaceable"}.`}
                          onClick={() => {
                            setMarks((s) => ({ ...s, [r.clip.id]: { ...s[r.clip.id], on: !s[r.clip.id].on } }))
                            onSelectClip(r.clip.id)
                          }}
                          className={cn(
                            "group absolute top-1 bottom-1 flex items-center gap-1 overflow-hidden rounded-md border text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                            r.kind === "audio" ? "bg-teal-500/20" : r.kind === "text" ? "bg-violet-500/20" : "bg-sky-500/15",
                            m.on ? "border-2 border-editor-accent" : "border-border opacity-60 hover:opacity-100"
                          )}
                          style={{ left: r.clip.start * pps, width: w }}
                        >
                          {r.kind === "visual" && <Thumb src={thumbUrl(r.clip.asset)} className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-70" />}
                          <span className={cn("relative z-[1] ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full", m.on ? "bg-editor-accent text-editor-accent-foreground" : "bg-background/80 text-muted-foreground")}>
                            {m.on ? <Replace className="h-3 w-3" aria-hidden /> : <Lock className="h-3 w-3" aria-hidden />}
                          </span>
                          {w > 90 && (
                            <span className="relative z-[1] min-w-0 truncate rounded bg-background/75 px-1 text-[10px] font-medium">
                              {r.kind === "text" ? <Type className="mr-0.5 inline h-3 w-3" aria-hidden /> : r.kind === "audio" ? <Music className="mr-0.5 inline h-3 w-3" aria-hidden /> : null}
                              {m.on ? m.label : name}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            <Replace className="mr-0.5 inline h-3 w-3 text-editor-accent" aria-hidden /> replaceable &nbsp; <Lock className="mr-0.5 inline h-3 w-3" aria-hidden /> fixed
          </p>
        </DialogSection>
        {replaceable.length > 0 && (
          <DialogSection title="Slot labels">
            <p className="mb-2 text-xs text-muted-foreground">What the person filling the template sees for each slot.</p>
            <ul className="grid gap-1.5">
              {replaceable.map((r) => (
                <li key={r.clip.id} className="flex items-center gap-2">
                  <span className="flex h-8 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted text-muted-foreground">
                    {r.kind === "text" ? <Type className="h-4 w-4" /> : r.kind === "audio" ? <Music className="h-4 w-4" /> : <Thumb src={thumbUrl(r.clip.asset)} className="h-full w-full object-cover" />}
                  </span>
                  <Input
                    aria-label={`Label for ${r.defaultLabel}`}
                    value={marks[r.clip.id].label}
                    maxLength={MAX_SLOT_LABEL}
                    onChange={(e) => setMarks((s) => ({ ...s, [r.clip.id]: { ...s[r.clip.id], label: e.target.value } }))}
                    onFocus={() => onSelectClip(r.clip.id)}
                    placeholder="What goes here: Main video, Photo 1…"
                    autoComplete="off"
                    className="h-8 flex-1 text-sm"
                  />
                  <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">{r.what} · {formatTimecode(clipLength(r.clip))}</span>
                </li>
              ))}
            </ul>
          </DialogSection>
        )}
      </div>
    </EditorDialog>
  )
}
