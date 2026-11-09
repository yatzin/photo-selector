// Sorting and small formatters for the Video Editing project list.

export type SortKey = "name" | "modified" | "clips" | "duration" | "size"
export type SortDir = "asc" | "desc"

type Sortable = { name: string; modified: number; clips: number; duration: number; bytes: number }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** A sorted copy; ties fall back to the name so the order is stable. A name sorts in natural order ("Trip 2" before "Trip 10"). */
export function sortProjects<T extends Sortable>(list: T[], key: SortKey, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1
  const value = (p: T) => (key === "size" ? p.bytes : key === "name" ? 0 : p[key])
  return [...list].sort((a, b) => {
    const by = key === "name" ? collator.compare(a.name, b.name) : value(a) - value(b)
    return by !== 0 ? sign * by : collator.compare(a.name, b.name)
  })
}

/** The direction a column starts in when first chosen: names A to Z, the rest biggest or newest first. */
export const firstDir = (key: SortKey): SortDir => (key === "name" ? "asc" : "desc")

/** 75 -> "1:15", 3725 -> "1:02:05". */
export function formatLength(seconds: number): string {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
}
