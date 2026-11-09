/**
 * One help entry per form field, shown in the "?" popover next to the label.
 *
 * Ids are "area.field", lowercase, e.g. "reminder.repeat". A field points at its entry
 * with a literal `help="reminder.repeat"` (or `help: "reminder.repeat"` in a FieldConfig).
 * A test checks that every literal id has an entry and every entry is used.
 *
 * Writing rules. The reader is the person using the app at home.
 * - Short, plain sentences. Everyday words. No filler, no marketing tone.
 * - `what`: what the field is, in one or two sentences. Use the same name the label shows.
 * - `use`: what Photo Selector does with it (where it shows up, what it drives). Skip it when `what` already says so.
 * - `values`: only when the choices behave differently. One line each: what you pick, what happens.
 * - No em dashes, no "allows you to", "helps you", "ensures", "seamless", "robust" or similar.
 * - Check each claim against the code. If you can't tell what a field does, read where it's used.
 */
export type FieldHelpEntry = {
  /** The field's name as the label shows it, without the asterisk. */
  title: string
  what: string
  use?: string
  values?: { label: string; effect: string }[]
}

export type FieldHelpMap = Record<string, FieldHelpEntry>

/** Length limits the test enforces, so the popover stays quick to read. */
export const HELP_LIMITS = { title: 60, what: 220, use: 260, valueLabel: 40, valueEffect: 140, values: 8 } as const
