// Drag-to-select maths for the photo grid (which photo is under the pointer
// lives in month-groups.ts).

/**
 * The selection while dragging from `from` to `to`: everything that was
 * selected when the drag began (`base`), plus — or minus, when the drag
 * started on a selected photo — the photos in between.
 */
export function dragSelection(base: Set<string>, names: string[], from: number, to: number, mode: "add" | "remove"): Set<string> {
  const next = new Set(base)
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    if (mode === "add") next.add(names[i])
    else next.delete(names[i])
  }
  return next
}

const EDGE_ZONE = 72
const MAX_SPEED = 28

/** Pixels to scroll per frame while dragging at height y in a scroll area spanning [top, bottom]: up near the top, down near the bottom. */
export function edgeScrollSpeed(y: number, top: number, bottom: number): number {
  if (y > bottom - EDGE_ZONE) return Math.round(MAX_SPEED * Math.min(1, (y - (bottom - EDGE_ZONE)) / EDGE_ZONE))
  if (y < top + EDGE_ZONE) return -Math.round(MAX_SPEED * Math.min(1, (top + EDGE_ZONE - y) / EDGE_ZONE))
  return 0
}
