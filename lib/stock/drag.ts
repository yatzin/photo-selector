import type { StockKind, StockRef, StockSource } from "./types"

// Reads the Stock tab's drag payload (dragPayload in panel-state) back on the
// drop side. Drag data can come from any page, so everything is checked and
// only { source, id, kind, duration? } survives. Client-safe: no server imports.

const SOURCES: readonly StockSource[] = ["openverse", "pixabay", "pexels"]
const KINDS: readonly StockKind[] = ["image", "gif", "video", "audio"]
const ID = /^[A-Za-z0-9_-]{1,64}$/

/** The asset `source` a stock result is imported under (the same as stockSourceKey on the server); the editor's `importing` key while it downloads. */
export const stockKey = (ref: StockRef): string => `stock:${ref.source}:${ref.id}`

/** True for an `importing` key made by stockKey (a Personal Storage key is "folder/name", never "stock:..."). */
export const isStockKey = (key: string | null): boolean => key !== null && key.startsWith("stock:")

export function parseStockDrag(raw: string): (StockRef & { duration?: number }) | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const { source, id, kind, duration } = o
  if (typeof source !== "string" || !(SOURCES as readonly string[]).includes(source)) return null
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) return null
  if (typeof id !== "string" || !ID.test(id)) return null
  const ref = { source: source as StockSource, id, kind: kind as StockKind }
  if (duration === undefined) return ref
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return null
  return { ...ref, duration }
}
