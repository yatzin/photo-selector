import { z } from "zod"

// Pure validation for Settings → Stock media. No database access here.

const MAX_KEY = 200

// Empty = keep the stored value; the browser never sees stored keys.
const key = z
  .string()
  .trim()
  .max(MAX_KEY)
  .optional()
  .transform((s) => (s ? s : undefined))

const schema = z.object({
  pixabayKey: key,
  pexelsKey: key,
  freesoundKey: key,
  openverseClientId: key,
  openverseClientSecret: key,
  clearPixabayKey: z.boolean().optional(),
  clearPexelsKey: z.boolean().optional(),
  clearFreesoundKey: z.boolean().optional(),
  clearOpenverseSecret: z.boolean().optional(),
})

export type StockSettingsInput = {
  pixabayKey?: string
  pexelsKey?: string
  freesoundKey?: string
  openverseClientId?: string
  openverseClientSecret?: string
  clearPixabayKey?: boolean
  clearPexelsKey?: boolean
  clearFreesoundKey?: boolean
  clearOpenverseSecret?: boolean
}

export function parseStockSettings(data: unknown): { error: string } | { value: StockSettingsInput } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "Invalid input." }
  const parsed = schema.safeParse(data)
  if (!parsed.success) return { error: `Keys are limited to ${MAX_KEY} characters.` }
  const value: StockSettingsInput = {}
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) (value as Record<string, unknown>)[k] = v
  }
  return { value }
}
