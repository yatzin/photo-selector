// Row/column maths for the virtualized photo grid: as many columns as fit at
// the minimum tile size, tiles stretched to fill the row, square tiles, with
// optional room for a caption under each.

export type GridLayout = {
  columns: number
  tileSize: number
  /** Tile plus caption plus the gap below it — the virtualizer's row height. */
  rowHeight: number
  rows: number
  rowOf(index: number): number
}

export function gridLayout({ width, minTile, gap, count, caption = 0 }: { width: number; minTile: number; gap: number; count: number; caption?: number }): GridLayout {
  const columns = Math.max(1, Math.floor((width + gap) / (minTile + gap)))
  const tileSize = width > 0 ? Math.max(0, (width - gap * (columns - 1)) / columns) : 0
  return {
    columns,
    tileSize,
    rowHeight: tileSize + caption + gap,
    rows: width > 0 && count > 0 ? Math.ceil(count / columns) : 0,
    rowOf: (index) => Math.floor(index / columns),
  }
}
