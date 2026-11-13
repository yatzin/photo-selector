// Filmstrip snapshots for the timeline. The server takes one small picture of a
// video every `filmInterval` seconds in a single ffmpeg pass and keeps them in
// a dot-folder beside the asset (`.<file>.film/00000.jpg, 00001.jpg, ...`). The
// browser then shows the nearest picture for each tile instead of seeking the
// video itself. No Node APIs here, so the browser can use it too.

/** A snapshot's width (px); the height follows the video's shape. */
export const FILM_WIDTH = 160
/** A video gets at most this many snapshots, however long it is. */
export const FILM_MAX_FRAMES = 1500
/** A snapshot at least this many seconds apart. */
export const FILM_MIN_INTERVAL = 0.5

/** Seconds between snapshots of a video `duration` seconds long. */
export const filmInterval = (duration: number): number => Math.max(FILM_MIN_INTERVAL, duration / FILM_MAX_FRAMES)

/** The folder's name in assets/ for an asset file: a dot-folder, so it never looks like media. */
export const filmDirName = (file: string): string => `.${file}.film`

/** A snapshot's file name, by its number from 0. */
export const filmFrameName = (index: number): string => `${String(index).padStart(5, "0")}.jpg`

/** The number of the snapshot nearest source time `at` (s), of `count` taken `interval` s apart. */
export function filmFrameIndex(at: number, interval: number, count: number): number {
  if (!(count > 0) || !(interval > 0) || !Number.isFinite(at)) return 0
  return Math.min(count - 1, Math.max(0, Math.round(at / interval)))
}
