"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { encrypt } from "@/lib/secret-box"
import { STOCK_SETTINGS_ID } from "@/lib/stock/config"
import { resolveStockUpdate } from "@/lib/stock/settings-update"
import { parseStockSettings, type StockSettingsInput } from "@/lib/stock/settings-schema"

async function requireAdmin() {
  const session = await auth()
  if (!session) redirect("/login")
  if (session.user.role !== "ADMIN") redirect("/")
  return session
}

export async function updateStockSettings(data: StockSettingsInput): Promise<{ error: string } | { success: true }> {
  await requireAdmin()
  const parsed = parseStockSettings(data)
  if ("error" in parsed) return { error: parsed.error }
  const update = resolveStockUpdate(parsed.value, encrypt)

  await prisma.stockSettings.upsert({
    where: { id: STOCK_SETTINGS_ID },
    create: { id: STOCK_SETTINGS_ID, ...update },
    update,
  })
  revalidatePath("/", "layout")
  return { success: true }
}
