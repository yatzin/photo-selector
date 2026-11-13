export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

/** A video's length for a thumbnail: m:ss, or h:mm:ss from an hour up. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const two = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`
}

/** The first `max` characters of `text` on one line, with "…" when there was more. */
export function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat
}

/** Library URL for a root and folder path, each segment encoded once. */
export function libraryHref(root: string, segments: string[]): string {
  return ["/library", root, ...segments.map(encodeURIComponent)].join("/")
}

export type MediaVariant = "thumb" | "preview" | "original"

/** Image/video URL for a file; `version` makes it safe to cache forever. */
export function mediaUrl(root: string, folder: string[], name: string, variant: MediaVariant, version: string): string {
  // `name` may include a subfolder ("18/IMG_1.jpg", from a month scan).
  const p = [...folder, ...name.split("/")].map(encodeURIComponent).join("/")
  return `/api/media/${root}/${p}?v=${variant}&k=${encodeURIComponent(version)}`
}
