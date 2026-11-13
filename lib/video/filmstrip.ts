// A clip's filmstrip: snapshots of its source at fixed moments, laid along the
// clip. A tile belongs to a moment of the source, not to the clip, so trimming
// an edge crops the strip (the pictures stay where they are) instead of
// squeezing or sliding them.

export type FilmTile = {
  /** The source moment the tile's picture is taken at (s): the middle of its span. */
  at: number
  /** Left edge from the clip's left edge (px); negative for a tile cropped by the in point. */
  x: number
  /** Width (px). */
  width: number
}

/**
 * The tiles covering source `[inSec, outSec)` at `zoom` px per second, each
 * `tileWidth` px wide when whole. Tiles sit on a fixed grid of the source, so
 * the same moment gets the same tile whatever the clip's trim. With `view`, only
 * the tiles in that window are returned (so a long clip isn't cut off at some count).
 */
export function filmstripTiles(o: { inSec: number; outSec: number; zoom: number; tileWidth: number; duration: number; view?: { from: number; to: number } }): FilmTile[] {
  const { inSec, outSec, zoom, duration } = o
  if (!(zoom > 0) || !(o.tileWidth > 0) || !(outSec > inSec)) return []
  const step = o.tileWidth / zoom
  let first = Math.floor(inSec / step + 1e-9)
  let last = Math.ceil(outSec / step - 1e-9)
  // Only the tiles reaching into `view` (px from the clip's left edge) are made, so a long clip never has more than a screenful.
  if (o.view) {
    first = Math.max(first, Math.floor((inSec + o.view.from / zoom) / step + 1e-9))
    last = Math.min(last, Math.ceil((inSec + o.view.to / zoom) / step - 1e-9))
  }
  const tiles: FilmTile[] = []
  for (let k = first; k < last && tiles.length < 400; k++) {
    const from = k * step
    const at = Math.min(Math.max(0, from + step / 2), Math.max(0, duration - 0.05))
    tiles.push({ at, x: (from - inSec) * zoom, width: o.tileWidth })
  }
  return tiles
}
