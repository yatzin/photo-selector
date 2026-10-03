// Rows for the photo grid: a header for each month, then that month's photos
// in rows of `columns`. Positions are worked out from the rows, so drag
// selection and scrolling reach rows the virtualized grid hasn't drawn.

export type GridRow =
  | { kind: "header"; key: string; label: string; start: number; end: number }
  | { kind: "tiles"; start: number; end: number }

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
const monthLabel = (d: Date) => d.toLocaleString("en-US", { month: "long", year: "numeric" })

/** Header + photo rows (`start`/`end` are item indices, end exclusive). Without grouping, just photo rows. */
export function buildRows(items: { modified: number }[], columns: number, grouped: boolean): GridRow[] {
  const rows: GridRow[] = []
  const tiles = (start: number, end: number) => {
    for (let i = start; i < end; i += columns) rows.push({ kind: "tiles", start: i, end: Math.min(i + columns, end) })
  }
  if (!grouped) {
    tiles(0, items.length)
    return rows
  }
  let start = 0
  while (start < items.length) {
    const first = new Date(items[start].modified)
    const key = monthKey(first)
    let end = start + 1
    while (end < items.length && monthKey(new Date(items[end].modified)) === key) end++
    rows.push({ kind: "header", key, label: monthLabel(first), start, end })
    tiles(start, end)
    start = end
  }
  return rows
}

/** The top of each row, given each row's height, followed by the total height. */
export function rowTops(rows: GridRow[], size: (row: GridRow) => number): number[] {
  const tops: number[] = []
  let y = 0
  for (const r of rows) {
    tops.push(y)
    y += size(r)
  }
  tops.push(y)
  return tops
}

/** The photo under (x, y) from the grid's top-left, or -1 over a month header. Points above or below the grid snap to the first or last photo. */
export function itemAt(x: number, y: number, rows: GridRow[], tops: number[], grid: { columns: number; tileSize: number; gap: number }): number {
  if (!rows.length) return -1
  if (y < 0) return 0
  if (y >= tops[rows.length]) return rows[rows.length - 1].end - 1
  let lo = 0
  let hi = rows.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (tops[mid] <= y) lo = mid
    else hi = mid - 1
  }
  const row = rows[lo]
  if (row.kind === "header") return -1
  const col = Math.min(grid.columns - 1, Math.max(0, Math.floor(x / (grid.tileSize + grid.gap))))
  return Math.min(row.start + col, row.end - 1)
}

/** The row holding photo `index`. */
export function rowOfItem(rows: GridRow[], index: number): number {
  return rows.findIndex((r) => r.kind === "tiles" && index >= r.start && index < r.end)
}
