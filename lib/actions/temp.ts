"use server"

import path from "path"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { sendToTemp, type ActionResult } from "@/lib/file-ops-server"
import { isNoteRoot, isPlainPath, isReadOnlyRoot, isRootKey, NOTE_ROOT_KEYS, READ_ONLY_ROOT_MESSAGE, ROOT_LABELS, safeSegments, tempFolderName } from "@/lib/media"
import { folderLocked } from "@/lib/ai/lock-server"
import { SCAN_LOCK_MESSAGE } from "@/lib/ai/lock"
import { dropTempNotes } from "@/lib/temp-notes-server"
import { clearRootCounts } from "@/lib/library-server"

// User Temp Storage and Video Editing Inbox: a staging folder per user. Photos
// and videos are moved or copied there from anywhere in the library, each with
// a note for that user.

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
  /** Where they go. */
  dest: z.enum(NOTE_ROOT_KEYS).default("temp"),
  folder: z.array(z.string()).max(64),
  // May sit in a day folder of a month scan ("18/IMG_1.jpg").
  names: z.array(z.string().refine(isPlainPath)).min(1).max(MAX_BATCH),
  userId: z.string().min(1),
  mode: z.enum(["move", "copy"]),
  note: z.string().max(MAX_NOTE),
})

export async function sendToTempAction(data: {
  root: string
  dest?: string
  folder: string[]
  names: string[]
  userId: string
  mode: "move" | "copy"
  note: string
}): Promise<(ActionResult & { to: string; dest: string }) | { error: string }> {
  const session = await requireUser()
  const parsed = input.safeParse(data)
  if (!parsed.success) return { error: "Invalid request." }
  const { root, dest, names, userId, mode } = parsed.data
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
