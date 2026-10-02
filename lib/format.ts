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

/** Library URL for a root and folder path, each segment encoded once. */
export function libraryHref(root: string, segments: string[]): string {
  return ["/library", root, ...segments.map(encodeURIComponent)].join("/")
}

export type MediaVariant = "thumb" | "preview" | "original"

/** Image/video URL for a file; `version` makes it safe to cache forever. */
export function mediaUrl(root: string, folder: string[], name: string, variant: MediaVariant, version: string): string {
  const p = [...folder, name].map(encodeURIComponent).join("/")
  return `/api/media/${root}/${p}?v=${variant}&k=${encodeURIComponent(version)}`
}
