import type { StockSettingsInput } from "./settings-schema"

// Pure: decides which StockSettings columns an update touches.
// A column left out of the result keeps its stored value; null clears it.
// A clear flag wins over a supplied value. The Openverse client ID and secret
// are a credential pair, so clearing the secret also clears the ID.

export type StockUpdate = {
  pixabayKeyEnc?: string | null
  pexelsKeyEnc?: string | null
  openverseClientSecretEnc?: string | null
  openverseClientId?: string | null
}

export function resolveSecretUpdate(
  clear: boolean | undefined,
  value: string | undefined,
  encrypt: (plain: string) => string
): string | null | undefined {
  return clear ? null : value ? encrypt(value) : undefined
}

export function resolveStockUpdate(v: StockSettingsInput, encrypt: (plain: string) => string): StockUpdate {
  const fields: StockUpdate = {
    pixabayKeyEnc: resolveSecretUpdate(v.clearPixabayKey, v.pixabayKey, encrypt),
    pexelsKeyEnc: resolveSecretUpdate(v.clearPexelsKey, v.pexelsKey, encrypt),
    openverseClientSecretEnc: resolveSecretUpdate(v.clearOpenverseSecret, v.openverseClientSecret, encrypt),
    openverseClientId: v.clearOpenverseSecret ? null : v.openverseClientId,
  }
  return Object.fromEntries(Object.entries(fields).filter(([, x]) => x !== undefined)) as StockUpdate
}
