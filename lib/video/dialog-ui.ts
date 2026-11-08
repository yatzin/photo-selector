// Pure maths behind the editor dialogs' shared controls (components/video/ui):
// moving through a grouped tile grid with the keyboard, filtering a chooser by
// a search, the value a scrub-on-drag label gives for a drag, and the one-line
// summaries shown beside a dialog's primary button.

/** Keys a tile grid moves on. */
export type GridKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End" | "PageUp" | "PageDown"

const GRID_KEYS = new Set<string>(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"])
export const isGridKey = (key: string): key is GridKey => GRID_KEYS.has(key)

/** Where flat item `index` sits: its group, row within the grid (rows restart in each group) and column. */
function locateInGrid(groups: number[], columns: number, index: number) {
  let base = 0
  let row = 0
  for (let g = 0; g < groups.length; g++) {
    const n = groups[g]
    if (index < base + n) {
      const k = index - base
      return { g, row: row + Math.floor(k / columns), col: k % columns }
    }
    base += n
    row += Math.ceil(n / columns)
  }
  return null
}

/** Every row of the grid as [first flat index, length]. */
function gridRows(groups: number[], columns: number): [number, number][] {
  const rows: [number, number][] = []
  let base = 0
  for (const n of groups) {
    for (let k = 0; k < n; k += columns) rows.push([base + k, Math.min(columns, n - k)])
    base += n
  }
  return rows
}

/**
 * The item a key moves to in a grid of groups (`groups`: each group's item
 * count, laid out `columns` across, each group starting a new row), from flat
 * item `index`: Left and Right step one item (wrapping at the ends), Up and
 * Down a row in the same column (the nearest item on a shorter row, staying
 * put at the top or bottom), Home and End the first and last items, PageUp
 * and PageDown the first item of the previous or next group. Null for any
 * other key, an empty grid or an index outside it.
 */
export function gridMove(groups: number[], columns: number, index: number, key: string): number | null {
  const count = groups.reduce((a, b) => a + b, 0)
  const cols = Math.max(1, Math.floor(columns))
  if (!isGridKey(key) || count === 0 || index < 0 || index >= count) return null
  if (key === "Home") return 0
  if (key === "End") return count - 1
  if (key === "ArrowRight") return (index + 1) % count
  if (key === "ArrowLeft") return (index - 1 + count) % count
  const at = locateInGrid(groups, cols, index)!
  if (key === "PageUp" || key === "PageDown") {
    const starts = groups.reduce<number[]>((a, n, i) => [...a, i === 0 ? 0 : a[i - 1] + groups[i - 1]], [])
    const nonEmpty = (g: number) => groups[g] > 0
    let g = at.g
    do g += key === "PageDown" ? 1 : -1
    while (g >= 0 && g < groups.length && !nonEmpty(g))
    if (g < 0 || g >= groups.length) return key === "PageUp" ? starts[at.g] : index
    return starts[g]
  }
  const rows = gridRows(groups, cols)
  const target = at.row + (key === "ArrowDown" ? 1 : -1)
  if (target < 0 || target >= rows.length) return index
  const [first, length] = rows[target]
  return first + Math.min(at.col, length - 1)
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()

/** True when every word of `query` appears in `text` (case and accents aside), or `query` is blank. */
export function matchesQuery(text: string, query: string): boolean {
  const hay = fold(text)
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((q) => hay.includes(q))
}

/**
 * The value a scrub-on-drag label gives: `start` moved `dx` px, one `step`
 * per `pxPerStep` px (a tenth of a step with `fine`), kept from `min` to `max`
 * and rounded to the step's decimals (one more with `fine`).
 */
export function scrubValue(start: number, dx: number, opts: { step: number; min?: number; max?: number; fine?: boolean; pxPerStep?: number }): number {
  const step = opts.fine ? opts.step / 10 : opts.step
  const px = opts.pxPerStep ?? 4
  const steps = Math.trunc(dx / px)
  const raw = start + steps * step
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))
  const kept = Math.min(opts.max ?? Infinity, Math.max(opts.min ?? -Infinity, raw))
  return Number(kept.toFixed(decimals))
}

/** Seconds for a summary: "0.4 s", "1.25 s" (at most two decimals, no trailing zeros). */
export const secondsText = (s: number) => `${Math.round(s * 100) / 100} s`

/**
 * What applying a cut will trim: "Trims 0.4 s from the end of Beach.mp4 and
 * 0.2 s from the start of Sunset.mp4; later clips move 0.6 s earlier", or null
 * when nothing is trimmed.
 */
export function trimSummary(trims: { outgoing: number; incoming: number; ripple: number }, names: { outgoing: string; incoming: string }, hasLater: boolean): string | null {
  if (trims.ripple <= 0) return null
  const parts = [
    ...(trims.outgoing > 0 ? [`${secondsText(trims.outgoing)} from the end of ${names.outgoing}`] : []),
    ...(trims.incoming > 0 ? [`${secondsText(trims.incoming)} from the start of ${names.incoming}`] : []),
  ]
  return `Trims ${parts.join(" and ")}${hasLater ? `; later clips move ${secondsText(trims.ripple)} earlier` : ""}`
}

/** What Edit length's Apply does, from the clip's start and length before and after: "3.2 s long (+0.8 s), starts at 1.5 s". Null when nothing changes. */
export function lengthSummary(before: { start: number; length: number }, after: { start: number; length: number }): string | null {
  const dl = Math.round((after.length - before.length) * 100) / 100
  const ds = Math.round((after.start - before.start) * 100) / 100
  if (dl === 0 && ds === 0) return null
  const parts: string[] = []
  if (dl !== 0) parts.push(`${secondsText(after.length)} long (${dl > 0 ? "+" : "−"}${secondsText(Math.abs(dl))})`)
  if (ds !== 0) parts.push(`starts at ${secondsText(after.start)}`)
  const text = parts.join(", ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** A gain in dB as the dialogs write it: "+3 dB", "−6.5 dB", "0 dB". */
export const dbText = (db: number) => `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db)} dB`

/** What Audio levels' Apply sets: "−3 dB, 2 effects", "As recorded" with nothing changed. */
export function levelsSummary(gainDb: number, effects: number): string {
  if (gainDb === 0 && effects === 0) return "As recorded"
  const parts = [...(gainDb !== 0 ? [dbText(gainDb)] : []), ...(effects > 0 ? [`${effects} effect${effects === 1 ? "" : "s"}`] : [])]
  return parts.join(", ")
}
