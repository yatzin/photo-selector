"use server"

import { z } from "zod"
import { redirect } from "next/navigation"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { isPlainName, tempFolderName } from "@/lib/media"
import type { StockRef } from "@/lib/stock/types"
import type { Asset } from "@/lib/video/project"
import { importStock } from "@/lib/video/stock-import-server"

// Server action for the Stock tab. The user's folder always comes from the
// session; the browser sends only the project and { source, id, kind } (never
// a URL: the provider's API says what to download). The lock, the dedupe on
// the result's stock key and the project write are in importStock.

const plainName = z.string().refine(isPlainName)

async function requireUserFolder(): Promise<{ userFolder: string } | { error: string }> {
  const session = await auth()
  if (!session) redirect("/login")
  if (session.user.mustResetPassword) return { error: "Change your password first." }
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true } })
  if (!user) redirect("/login")
  return { userFolder: tempFolderName(user.name, user.email) }
}

/** Downloads stock result `ref` into project `folder` as a new asset, or reuses the asset already made from it. */
export async function importStockAction(
  folder: string,
  ref: StockRef
): Promise<{ id: string; asset: Asset; reused?: true; format?: { width: number; height: number } } | { error: string }> {
  const who = await requireUserFolder()
  if ("error" in who) return who
  const f = plainName.safeParse(folder)
  if (!f.success) return { error: "Invalid request." }
  try {
    return await importStock(who.userFolder, f.data, ref)
  } catch {
    // importStock returns its own failures as { error }; anything else may name server paths.
    return { error: "The stock import failed." }
  }
}
