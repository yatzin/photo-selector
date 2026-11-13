// Templates. A template is a project saved with some of its clips marked as
// slots: the clips someone fills with their own media (or text) when they start
// a project from it. Everything else in it stays as it is: a logo, an intro,
// the music, the titles, the transitions, every setting on the slot clips.
//
// A template is a project folder with `template.master` set; a project started
// from one has the same `template` without it, and its slots show what is left
// to fill. A slot remembers what it holds in the template (`asset` or `text`),
// so "filled" is simply "no longer that": undo-safe, nothing to keep in step.
// Like the assets, `template` belongs to the server: saves never change it.

export type TemplateSlot = {
  /** What the person filling it sees: "Main video", "Photo 1". */
  label: string
  /** The placeholder's media (asset id), for a picture or sound slot. */
  asset?: string
  /** The placeholder's text, for a text slot. */
  text?: string
}

export type TemplateInfo = {
  /** This project is a template (it is listed under Templates). Absent on a project made from one. */
  master?: true
  description?: string
  /** Slots by clip id. */
  slots: Record<string, TemplateSlot>
}

export const MAX_SLOTS = 100
export const MAX_SLOT_LABEL = 60
export const MAX_TEMPLATE_DESCRIPTION = 300

const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max)

/** A stored template in its canonical form, or null when it isn't valid. A slot with an unusable label gets a default. */
export function normalizeTemplate(v: unknown): TemplateInfo | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null
  const t = v as Record<string, unknown>
  if (t.master !== undefined && t.master !== true) return null
  if (t.description !== undefined && typeof t.description !== "string") return null
  if (typeof t.slots !== "object" || t.slots === null || Array.isArray(t.slots)) return null
  const entries = Object.entries(t.slots as Record<string, unknown>)
  if (entries.length > MAX_SLOTS) return null
  const slots: Record<string, TemplateSlot> = {}
  for (const [id, raw] of entries) {
    if (id === "__proto__" || id.length === 0 || id.length > 100) return null
    if (typeof raw !== "object" || raw === null) return null
    const s = raw as Record<string, unknown>
    if (typeof s.label !== "string") return null
    if (s.asset !== undefined && (typeof s.asset !== "string" || s.asset.length > 100)) return null
    if (s.text !== undefined && typeof s.text !== "string") return null
    const slot: TemplateSlot = { label: clean(s.label, MAX_SLOT_LABEL) || "Slot" }
    if (s.asset !== undefined) slot.asset = s.asset
    if (s.text !== undefined) slot.text = s.text.slice(0, 2000)
    slots[id] = slot
  }
  const description = typeof t.description === "string" ? clean(t.description, MAX_TEMPLATE_DESCRIPTION) : ""
  return { ...(t.master === true ? { master: true as const } : {}), ...(description ? { description } : {}), slots }
}

/** `t` without the slots whose clip is gone (`has` says which clip ids exist); undefined when none are left and it isn't a template itself. */
export function pruneTemplate(t: TemplateInfo, has: (clipId: string) => boolean): TemplateInfo | undefined {
  const slots = Object.fromEntries(Object.entries(t.slots).filter(([id]) => has(id)))
  const next: TemplateInfo = { ...t, slots }
  return Object.keys(slots).length === 0 && !t.master ? undefined : next
}
