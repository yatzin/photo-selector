import "server-only"
import { prisma } from "@/lib/prisma"
import { decrypt } from "@/lib/secret-box"

export const STOCK_SETTINGS_ID = "singleton"

export type StockConfig = {
  pixabayKey: string | null
  pexelsKey: string | null
  openverseClientId: string | null
  openverseClientSecret: string | null
  hasPixabayKey: boolean
  hasPexelsKey: boolean
  hasOpenverseSecret: boolean
  /** A key is stored but AUTH_SECRET can no longer decrypt it. */
  unreadable: boolean
}

export async function loadStockConfig(): Promise<StockConfig> {
  const row = await prisma.stockSettings.findUnique({ where: { id: STOCK_SETTINGS_ID } })
  const pixabayKey = row?.pixabayKeyEnc ? decrypt(row.pixabayKeyEnc) : null
  const pexelsKey = row?.pexelsKeyEnc ? decrypt(row.pexelsKeyEnc) : null
  const openverseClientSecret = row?.openverseClientSecretEnc ? decrypt(row.openverseClientSecretEnc) : null
  const unreadable =
    (Boolean(row?.pixabayKeyEnc) && pixabayKey === null) ||
    (Boolean(row?.pexelsKeyEnc) && pexelsKey === null) ||
    (Boolean(row?.openverseClientSecretEnc) && openverseClientSecret === null)
  return {
    pixabayKey,
    pexelsKey,
    openverseClientId: row?.openverseClientId ?? null,
    openverseClientSecret,
    hasPixabayKey: Boolean(row?.pixabayKeyEnc),
    hasPexelsKey: Boolean(row?.pexelsKeyEnc),
    hasOpenverseSecret: Boolean(row?.openverseClientSecretEnc),
    unreadable,
  }
}
