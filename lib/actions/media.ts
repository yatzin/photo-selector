"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"
import { auth } from "@/auth"
import { moveToDropoff, restoreBatch, rotateFiles, trashFiles, type ActionResult } from "@/lib/file-ops-server"
import { isNoteRoot, isPlainName, isReadOnlyRoot, isRootKey, READ_ONLY_ROOT_MESSAGE, safeSegments, type RootKey } from "@/lib/media"
import { folderLocked } from "@/lib/ai/lock-server"
import { SCAN_LOCK_MESSAGE } from "@/lib/ai/lock"
import { dropTempNotes } from "@/lib/temp-notes-server"
import { clearRootCounts } from "@/lib/library-server"
import { videoDurations } from "@/lib/duration-server"

const MAX_BATCH = 2000

const target = z.object({
  root: z.string().refine(isRootKey),
  folder: z.array(z.string()).max(64),
  names: z.array(z.string().refine(isPlainName)).min(1).max(MAX_BATCH),
})

type Target = { root: Exclude<RootKey, "video-projects">; folder: string[]; names: string[] }

async function parse(input: unknown): Promise<Target | { error: string }> {
  const session = await auth()
  if (!session) redirect("/login")
  const parsed = target.safeParse(input)
  if (!parsed.success) return { error: "Invalid request." }
  const folder = safeSegments(parsed.data.folder)
  if (!folder) return { error: "Invalid folder." }
  const root = parsed.data.root as RootKey
  // Move, delete and rotate all change the source; the editor owns project files.
  if (isReadOnlyRoot(root)) return { error: READ_ONLY_ROOT_MESSAGE }
  if (await folderLocked(root, folder)) return { error: SCAN_LOCK_MESSAGE }
  return { root, folder, names: parsed.data.names }
}

/** The length in seconds of each video named (in a library folder), for the badge on its thumbnail; one it can't read is left out. */
export async function videoDurationsAction(input: { root: string; folder: string[]; names: string[] }): Promise<Record<string, number>> {
  const session = await auth()
  if (!session) redirect("/login")
  const parsed = z
    .object({ root: z.string().refine(isRootKey), folder: z.array(z.string()).max(64), names: z.array(z.string().max(400)).min(1).max(40) })
    .safeParse(input)
  const folder = parsed.success ? safeSegments(parsed.data.folder) : null
  if (!parsed.success || !folder) return {}
  return videoDurations(parsed.data.root as RootKey, folder, parsed.data.names)
}

function done<T extends ActionResult>(result: T): T {
  clearRootCounts()
  revalidatePath("/library", "layout")
  return result
}

export async function moveToDropoffAction(input: { root: string; folder: string[]; names: string[] }) {
  const t = await parse(input)
  if ("error" in t) return t
  if (t.root === "dropoff") return { error: "Only files in Mobile Upload or Personal Storage can be moved to the drop-off." }
  const result = await moveToDropoff(t.root, t.folder, t.names)
  if (isNoteRoot(t.root)) await dropTempNotes(t.root, t.folder, result.ok)
  return done(result)
}

export async function deleteAction(input: { root: string; folder: string[]; names: string[] }) {
  const t = await parse(input)
  if ("error" in t) return t
  return done(await trashFiles(t.root, t.folder, t.names))
}

export async function undoDeleteAction(root: string, batchId: string, folder: string[]) {
  const session = await auth()
  if (!session) redirect("/login")
  const segs = Array.isArray(folder) ? safeSegments(folder) : null
  if (!isRootKey(root) || typeof batchId !== "string" || !segs) return { error: "Invalid request." }
  // Undo puts files back into the folder they were deleted from.
  if (await folderLocked(root, segs)) return { error: SCAN_LOCK_MESSAGE }
  return done(await restoreBatch(root, batchId))
}

export async function rotateAction(input: { root: string; folder: string[]; names: string[]; direction: string }) {
  const t = await parse(input)
  if ("error" in t) return t
  const direction = input.direction === "ccw" ? "ccw" : "cw"
  return done(await rotateFiles(t.root, t.folder, t.names, direction))
}
