import { TRASH_RETENTION_DAYS } from "@/lib/media"

// What the Personal Storage trash view shows (see lib/temp-trash-server): each
// delete is a batch, with the files it took and where they were.

export type TrashFile = {
  name: string
  /** Where it was, below Personal Storage ("Mike/Trips"); the path inside the batch. */
  folder: string[]
  size: number
  kind: "image" | "video"
}

export type TrashBatch = {
  id: string
  /** When it was deleted (epoch ms). */
  deletedAt: number
  /** When the app removes it for good (epoch ms). */
  expiresAt: number
  files: TrashFile[]
}

/** When a batch deleted at `deletedAt` goes for good. */
export const trashExpiry = (deletedAt: number) => deletedAt + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000

/** Whole days until `expiresAt` (at least 0): "28 days", counted up so the last day says 1. */
export function trashDaysLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)))
}
