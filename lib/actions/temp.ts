"use server"

import path from "path"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { sendToTemp, type ActionResult } from "@/lib/file-ops-server"
import { isPlainPath, isRootKey, safeSegments, tempFolderName } from "@/lib/media"
import { folderLocked } from "@/lib/ai/lock-server"
import { SCAN_LOCK_MESSAGE } from "@/lib/ai/lock"
import { dropTempNotes } from "@/lib/temp-notes-server"
import { clearRootCounts } from "@/lib/library-server"

// User Temp Storage: a staging folder per user. Photos and videos are moved or
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
}): Promise<(ActionResult & { to: string }) | { error: string }> {
  const session = await requireUser()
  const parsed = input.safeParse(data)
  if (!parsed.success) return { error: "Invalid request." }
  const { root, names, userId, mode } = parsed.data
  const folder = safeSegments(parsed.data.folder)
  if (!folder || !isRootKey(root)) return { error: "Invalid folder." }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } })
  if (!user) return { error: "That user no longer exists." }
  const userFolder = tempFolderName(user.name, user.email)
  if (root === "temp" && folder.join("/") === userFolder) return { error: `These are already in ${user.name}'s folder.` }
  // Copying leaves the source alone, so only a move waits for a scan to finish.
  if (mode === "move" && (await folderLocked(root, folder))) return { error: SCAN_LOCK_MESSAGE }

  const result = await sendToTemp(root, folder, names, userFolder, mode)
  const note = parsed.data.note.trim()
  await prisma.$transaction(
    result.ok.map((name) =>
      prisma.tempNote.upsert({
        where: { folder_name: { folder: userFolder, name: path.basename(name) } },
        create: { folder: userFolder, name: path.basename(name), note, forUserId: user.id, createdById: session.user.id },
        update: { note, forUserId: user.id, createdById: session.user.id },
      })
    )
  )
  // Moved out of another user's folder: its old note goes with it (replaced by the new one).
  if (root === "temp" && mode === "move") await dropTempNotes(folder, result.ok)

  clearRootCounts()
  revalidatePath("/library", "layout")
  revalidatePath("/ai", "layout")
  return { ...result, to: user.name }
}
