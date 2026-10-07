import "server-only"
import { prisma } from "@/lib/prisma"

// Notes left with photos put in User Temp Storage (see lib/actions/temp.ts).
// Keyed by the user's folder and the file's name there.

export type TempNoteView = { note: string; by: string | null; at: number }

/** The notes for files in one User Temp Storage folder, by file name. */
export async function tempNotes(folder: string[], names: string[]): Promise<Record<string, TempNoteView>> {
  if (!names.length) return {}
  const rows = await prisma.tempNote.findMany({
    where: { folder: folder.join("/"), name: { in: names } },
    select: { name: true, note: true, updatedAt: true, createdBy: { select: { name: true } } },
  })
  return Object.fromEntries(rows.map((r) => [r.name, { note: r.note, by: r.createdBy?.name ?? null, at: r.updatedAt.getTime() }]))
}

/** Forgets the notes of files that left a User Temp Storage folder. */
export async function dropTempNotes(folder: string[], names: string[]): Promise<void> {
  if (names.length) await prisma.tempNote.deleteMany({ where: { folder: folder.join("/"), name: { in: names } } })
}
