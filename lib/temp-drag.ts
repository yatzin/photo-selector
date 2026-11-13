// Dragging photos and videos from a Personal Storage page onto a folder in its
// side navigation moves them there. The drag carries where they are and their names.

export const TEMP_MEDIA_DRAG = "application/x-ps-temp-media"

export type TempMediaDrag = { folder: string[]; names: string[] }

/** What a drag carries, or null when it isn't a valid TEMP_MEDIA_DRAG payload. */
export function parseTempMediaDrag(raw: string): TempMediaDrag | null {
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== "object" || v === null) return null
    const { folder, names } = v as Record<string, unknown>
    const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === "string")
    return strings(folder) && strings(names) && names.length > 0 ? { folder, names } : null
  } catch {
    return null
  }
}

/** Dispatched on window after files moved: the grid showing `folder` drops `names` from view. */
export const TEMP_MOVED_EVENT = "ps-temp-moved"
