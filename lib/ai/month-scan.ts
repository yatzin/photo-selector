import { mediaKind } from "@/lib/media"

// Phones and photo apps often file uploads as year/month/day. A day holds a
// handful of photos, and a burst can cross midnight, so a month folder with
// no photos of its own is scanned as one: every photo in its day folders.

const YEAR = /^\d{4}$/
const MONTH = /^(0[1-9]|1[0-2])$/
const DAY = /^(0[1-9]|[12]\d|3[01])$/

type Entry = { name: string; isDirectory(): boolean; isFile(): boolean }

/** The day folders a month scan of `segments` covers (sorted), or null if it isn't a month-of-days folder. */
export function monthScanDays(segments: string[], entries: Entry[]): string[] | null {
  if (segments.length < 2) return null
  if (!YEAR.test(segments[segments.length - 2]) || !MONTH.test(segments[segments.length - 1])) return null
  if (entries.some((e) => e.isFile() && mediaKind(e.name) === "image")) return null
  const days = dayFolderNames(entries)
  return days.length ? days : null
}

/** The day-named folders among `entries`, sorted. */
export function dayFolderNames(entries: Entry[]): string[] {
  return entries.filter((e) => e.isDirectory() && DAY.test(e.name)).map((e) => e.name).sort()
}

/** For a year/month/day folder, the month folder that would scan it (whether or not that month qualifies). */
export function coveredByMonthScan(segments: string[]): string[] | null {
  if (segments.length < 3) return null
  const [y, m, d] = segments.slice(-3)
  return YEAR.test(y) && MONTH.test(m) && DAY.test(d) ? segments.slice(0, -1) : null
}
