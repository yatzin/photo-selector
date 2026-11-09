import "server-only"
import { prisma } from "@/lib/prisma"
import type { NoteRootKey } from "@/lib/media"

// Notes left with photos put in Personal Storage
// (see lib/actions/temp.ts). Keyed by root, the user's folder and the file's name there.

export type TempNoteView = { note: string; by: string | null; at: number }

/** The notes for files in one user folder of a notes root, by file name. */
export async function tempNotes(root: NoteRootKey, folder: string[], names: string[]): Promise<Record<string, TempNoteView>> {
  if (!names.length) return {}
  const rows = await prisma.tempNote.findMany({
    where: { root, folder: folder.join("/"), name: { in: names } },
    select: { name: true, note: true, updatedAt: true, createdBy: { select: { name: true } } },
  })
  return Object.fromEntries(rows.map((r) => [r.name, { note: r.note, by: r.createdBy?.name ?? null, at: r.updatedAt.getTime() }]))
}

/** Forgets the notes of files that left a user folder of a notes root. */
export async function dropTempNotes(root: NoteRootKey, folder: string[], names: string[]): Promise<void> {
  if (names.length) await prisma.tempNote.deleteMany({ where: { root, folder: folder.join("/"), name: { in: names } } })
}
