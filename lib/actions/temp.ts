"use server"

import path from "path"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { moveWithin, sendToTemp, type ActionResult } from "@/lib/file-ops-server"
import { isNoteRoot, isPlainName, isPlainPath, isReadOnlyRoot, isRootKey, READ_ONLY_ROOT_MESSAGE, ROOT_LABELS, safeSegments, tempFolderName } from "@/lib/media"
import { folderLocked } from "@/lib/ai/lock-server"
import { SCAN_LOCK_MESSAGE } from "@/lib/ai/lock"
import { dropTempNotes } from "@/lib/temp-notes-server"
import { listTempFolderPaths, listTempTrash, moveFromTrash, restoreTrash } from "@/lib/temp-trash-server"
import type { TrashBatch } from "@/lib/temp-trash"
import { createTempFolder, moveTempFolder, renameTempFile, renameTempFolder, trashTempFolder } from "@/lib/temp-folders-server"
import { clearRootCounts } from "@/lib/library-server"

// Personal Storage: a staging folder per user. Photos and videos are moved or
// copied there from anywhere in the library, each with a note for that user.

export type TempUser = { id: string; name: string; folder: string }

const MAX_BATCH = 2000
const MAX_NOTE = 4000

async function requireUser() {
  const session = await auth()
  if (!session) redirect("/login")
  return session
}

/** Everyone on the site, with the folder their photos go to. */
export async function listTempUsersAction(): Promise<TempUser[]> {
  await requireUser()
  const users = await prisma.user.findMany({ select: { id: true, name: true, email: true }, orderBy: { name: "asc" } })
  return users.map((u) => ({ id: u.id, name: u.name, folder: tempFolderName(u.name, u.email) }))
}

const input = z.object({
  root: z.string().refine(isRootKey),
  folder: z.array(z.string()).max(64),
  // May sit in a day folder of a month scan ("18/IMG_1.jpg").
  names: z.array(z.string().refine(isPlainPath)).min(1).max(MAX_BATCH),
  userId: z.string().min(1),
  mode: z.enum(["move", "copy"]),
  note: z.string().max(MAX_NOTE),
})

export async function sendToTempAction(data: {
  root: string
  folder: string[]
  names: string[]
  userId: string
  mode: "move" | "copy"
  note: string
}): Promise<(ActionResult & { to: string; dest: string }) | { error: string }> {
  const session = await requireUser()
  const parsed = input.safeParse(data)
  if (!parsed.success) return { error: "Invalid request." }
  const { root, names, userId, mode } = parsed.data
  const dest = "temp"
  const folder = safeSegments(parsed.data.folder)
  if (!folder || !isRootKey(root)) return { error: "Invalid folder." }
  // A copy leaves the source alone, so it's allowed from a read-only root.
  if (mode === "move" && isReadOnlyRoot(root)) return { error: READ_ONLY_ROOT_MESSAGE }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } })
  if (!user) return { error: "That user no longer exists." }
  const userFolder = tempFolderName(user.name, user.email)
  if (root === dest && folder.join("/") === userFolder) return { error: `These are already in ${user.name}'s folder.` }
  // Copying leaves the source alone, so only a move waits for a scan to finish.
  if (mode === "move" && (await folderLocked(root, folder))) return { error: SCAN_LOCK_MESSAGE }

  const result = await sendToTemp(root, folder, names, userFolder, mode, dest)
  const note = parsed.data.note.trim()
  await prisma.$transaction(
    result.ok.map((name) =>
      prisma.tempNote.upsert({
        where: { root_folder_name: { root: dest, folder: userFolder, name: path.basename(name) } },
        create: { root: dest, folder: userFolder, name: path.basename(name), note, forUserId: user.id, createdById: session.user.id },
        update: { note, forUserId: user.id, createdById: session.user.id },
      })
    )
  )
  // Moved out of a user's folder: its old note goes with it (replaced by the new one).
  if (isNoteRoot(root) && mode === "move") await dropTempNotes(root, folder, result.ok)

  clearRootCounts()
  revalidatePath("/library", "layout")
  revalidatePath("/ai", "layout")
  return { ...result, to: user.name, dest: ROOT_LABELS[dest] }
}

const folderPath = z.array(z.string()).max(16)

/** Makes a subfolder inside a folder of Personal Storage (below a user's own folder). */
export async function createTempFolderAction(parent: string[], name: string): Promise<{ name: string } | { error: string }> {
  await requireUser()
  const p = folderPath.safeParse(parent)
  const segments = p.success ? safeSegments(p.data) : null
  if (!segments || typeof name !== "string" || name.length > 200) return { error: "Invalid request." }
  const result = await createTempFolder(segments, name)
  if (!("error" in result)) refresh()
  return result
}

/** Deletes a subfolder and what's in it (to the trash). */
export async function deleteTempFolderAction(parent: string[], name: string): Promise<{ ok: true } | { error: string }> {
  await requireUser()
  const p = folderPath.safeParse(parent)
  const segments = p.success ? safeSegments(p.data) : null
  if (!segments || typeof name !== "string" || !isPlainPath(name) || name.includes("/")) return { error: "Invalid request." }
  const result = await trashTempFolder(segments, name)
  if (!("error" in result)) refresh()
  return result
}

/** Renames a subfolder (not a user's own folder). */
export async function renameTempFolderAction(parent: string[], name: string, newName: string): Promise<{ name: string } | { error: string }> {
  await requireUser()
  const p = folderPath.safeParse(parent)
  const segments = p.success ? safeSegments(p.data) : null
  if (!segments || !isPlainName(name) || typeof newName !== "string" || newName.length > 200) return { error: "Invalid request." }
  const result = await renameTempFolder(segments, name, newName)
  if (!("error" in result)) refresh()
  return result
}

/** Moves a subfolder, with what's in it, into another folder of Personal Storage (a user's folder or below). */
export async function moveTempFolderAction(parent: string[], name: string, destination: string[]): Promise<{ name: string; to: string } | { error: string }> {
  await requireUser()
  const p = folderPath.safeParse(parent)
  const d = folderPath.safeParse(destination)
  const source = p.success ? safeSegments(p.data) : null
  const target = d.success ? safeSegments(d.data) : null
  if (!source || !target || !isPlainName(name)) return { error: "Invalid request." }
  // A running AI scan is reading these folders: nothing moves in or out of them meanwhile.
  if ((await folderLocked("temp", [...source, name])) || (await folderLocked("temp", target))) return { error: SCAN_LOCK_MESSAGE }
  const result = await moveTempFolder(source, name, target)
  if (!("error" in result)) refresh()
  return result
}

/** Renames a photo or video, keeping its extension; its note, if it has one, moves with it. */
export async function renameTempFileAction(parent: string[], name: string, newStem: string): Promise<{ name: string } | { error: string }> {
  await requireUser()
  const p = folderPath.safeParse(parent)
  const segments = p.success ? safeSegments(p.data) : null
  if (!segments || !isPlainName(name) || typeof newStem !== "string" || newStem.length > 200) return { error: "Invalid request." }
  const result = await renameTempFile(segments, name, newStem)
  if ("error" in result) return result
  // Notes are kept for files directly in a user's folder, by name.
  if (segments.length === 1 && result.name !== name) {
    await prisma.tempNote.updateMany({ where: { root: "temp", folder: segments[0], name }, data: { name: result.name } })
  }
  refresh()
  return result
}

/** Moves photos and videos from one Personal Storage folder into another (a user's folder or below). A file there with the same name is kept: the moved one gets a number. */
export async function moveTempFilesAction(from: string[], names: string[], destination: string[]): Promise<(ActionResult & { to: string }) | { error: string }> {
  await requireUser()
  const parsed = z.object({ from: folderPath, destination: folderPath, names: z.array(z.string().refine(isPlainName)).min(1).max(MAX_BATCH) }).safeParse({ from, destination, names })
  const source = parsed.success ? safeSegments(parsed.data.from) : null
  const target = parsed.success ? safeSegments(parsed.data.destination) : null
  if (!parsed.success || !source || !target || source.length === 0 || target.length === 0) return { error: "Invalid request." }
  // A running AI scan is reading these folders: nothing moves in or out of them meanwhile.
  if ((await folderLocked("temp", source)) || (await folderLocked("temp", target))) return { error: SCAN_LOCK_MESSAGE }
  const result = await moveWithin("temp", source, parsed.data.names, target)
  // Notes sit on files directly in a user's folder, by name: a moved file's note stays behind.
  if (source.length === 1) await dropTempNotes("temp", source, result.ok)
  clearRootCounts()
  refresh()
  return { ...result, to: target[target.length - 1] }
}

const trashRef = z.object({ folder: z.array(z.string()).max(16), name: z.string().refine(isPlainName) })
const batchId = z.string().regex(/^\d{13}-[a-z0-9]{1,8}$/i)

/** Everything in the Personal Storage trash, newest delete first. */
export async function listTempTrashAction(): Promise<TrashBatch[]> {
  await requireUser()
  return listTempTrash()
}

/** Every Personal Storage folder, for choosing where to move a file from the trash. */
export async function listTempFoldersAction(): Promise<string[]> {
  await requireUser()
  return listTempFolderPaths()
}

/** Puts files of one trash batch back where they were deleted from (all of them when `files` is null). */
export async function restoreTrashAction(id: string, files: { folder: string[]; name: string }[] | null): Promise<{ restored: number; failed: { name: string; error: string }[] } | { error: string }> {
  await requireUser()
  const b = batchId.safeParse(id)
  const refs = files === null ? null : z.array(trashRef).max(5000).safeParse(files)
  if (!b.success || (refs && !refs.success)) return { error: "Invalid request." }
  const checked = refs && refs.success ? refs.data.map((r) => ({ name: r.name, folder: safeSegments(r.folder) })) : null
  if (checked?.some((r) => !r.folder)) return { error: "Invalid request." }
  const result = await restoreTrash(b.data, checked ? checked.map((r) => ({ name: r.name, folder: r.folder! })) : null)
  refresh()
  return result
}

/** Moves one file out of the trash into another Personal Storage folder. */
export async function moveTrashAction(id: string, file: { folder: string[]; name: string }, destination: string[]): Promise<{ name: string } | { error: string }> {
  await requireUser()
  const b = batchId.safeParse(id)
  const f = trashRef.safeParse(file)
  const from = f.success ? safeSegments(f.data.folder) : null
  const to = folderPath.safeParse(destination)
  if (!b.success || !f.success || !from || !to.success) return { error: "Invalid request." }
  const result = await moveFromTrash(b.data, { folder: from, name: f.data.name }, to.data)
  if (!("error" in result)) refresh()
  return result
}

function refresh() {
  clearRootCounts()
  revalidatePath("/library", "layout")
}
