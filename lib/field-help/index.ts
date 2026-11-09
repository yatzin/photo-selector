import type { FieldHelpMap } from "./types"
import { AI_HELP } from "./ai"
import { LIBRARY_HELP } from "./library"
import { VIDEO_HELP } from "./video"

export type { FieldHelpEntry, FieldHelpMap } from "./types"

/** Every field's help, by "area.field" id. One file per area; see types.ts for the writing rules. */
export const FIELD_HELP: FieldHelpMap = {
  ...VIDEO_HELP,
  ...AI_HELP,
  ...LIBRARY_HELP,
}
