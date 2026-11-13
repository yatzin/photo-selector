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

/** A folder dragged onto another folder in a Personal Storage tree moves it there. */
export const TEMP_FOLDER_DRAG = "application/x-ps-temp-folder"

export type TempFolderDrag = { parent: string[]; name: string }

/** What a folder drag carries, or null when it isn't a valid TEMP_FOLDER_DRAG payload. */
export function parseTempFolderDrag(raw: string): TempFolderDrag | null {
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== "object" || v === null) return null
    const { parent, name } = v as Record<string, unknown>
    const ok = Array.isArray(parent) && parent.length > 0 && parent.every((x) => typeof x === "string") && typeof name === "string" && name !== ""
    return ok ? { parent: parent as string[], name } : null
  } catch {
    return null
  }
}

/**
 * The folder being dragged right now. A drag's data can't be read while it is over a target (only
 * on drop), so the tree keeps it here to decide which folders can take it.
 */
export const folderDrag: { current: TempFolderDrag | null } = { current: null }

/** Whether `drag` may be dropped into the folder `destination`: not into itself or anything inside it, and not where it already is. */
export function canDropFolder(drag: TempFolderDrag, destination: string[]): boolean {
  if (destination.length === 0) return false
  const from = [...drag.parent, drag.name]
  if (destination.length >= from.length && from.every((s, i) => destination[i] === s)) return false
  if (destination.length === drag.parent.length && drag.parent.every((s, i) => destination[i] === s)) return false
  return true
}
