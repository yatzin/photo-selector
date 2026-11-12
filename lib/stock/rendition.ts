const TARGET = 1080

/** A file's resolution as "1080p" counts it: its shorter side (1920x1080 and 1080x1920 are both 1080). */
const measure = (f: { width: number; height: number }) => Math.min(f.width, f.height)

/**
 * Pick the video file closest to 1080p without exceeding it, measuring each by
 * its shorter side (so a portrait 1080x1920 file is the 1080p one). If every
 * file is above 1080, take the smallest one. Files with a zero, negative or
 * non-numeric dimension are ignored; of two the same, the first wins. Null
 * when no file is left.
 */
export function pickVideoFile(files: { width: number; height: number; url: string }[]): { url: string } | null {
  const valid = files.filter((f) => f.width > 0 && f.height > 0 && Number.isFinite(measure(f)))
  if (valid.length === 0) return null
  const within = valid.filter((f) => measure(f) <= TARGET)
  const best = within.length > 0
    ? within.reduce((a, b) => (measure(b) > measure(a) ? b : a))
    : valid.reduce((a, b) => (measure(b) < measure(a) ? b : a))
  return { url: best.url }
}
