import "server-only"
import { prisma } from "@/lib/prisma"
import { decrypt } from "@/lib/secret-box"
import { AI_DEFAULTS, isAiReady, parseExtraBody, type ParsedAiSettings, type Similarity } from "@/lib/ai/settings-schema"
import type { AiClientConfig } from "@/lib/ai/client"

export const AI_SETTINGS_ID = "singleton"

export type AiConfig = ParsedAiSettings & {
  apiKey: string | null
  hasStoredKey: boolean
  /** A key is stored but AUTH_SECRET can no longer decrypt it. */
  keyUnreadable: boolean
}

export async function loadAiConfig(): Promise<AiConfig> {
  const row = await prisma.aiSettings.findUnique({ where: { id: AI_SETTINGS_ID } })
  const apiKey = row?.apiKeyEnc ? decrypt(row.apiKeyEnc) : null
  return {
    enabled: row?.enabled ?? false,
    baseUrl: row?.baseUrl ?? null,
    model: row?.model ?? null,
    temperature: row?.temperature ?? null,
    maxTokens: row?.maxTokens ?? null,
    timeoutSeconds: row?.timeoutSeconds ?? null,
    extraBody: row?.extraBody ?? null,
    instructions: row?.instructions ?? null,
    screenshotInstructions: row?.screenshotInstructions ?? null,
    groupWindowSeconds: row?.groupWindowSeconds ?? AI_DEFAULTS.groupWindowSeconds,
    similarity: (row?.similarity as Similarity | undefined) ?? AI_DEFAULTS.similarity,
    imageMaxPx: row?.imageMaxPx ?? AI_DEFAULTS.imageMaxPx,
    maxGroupSize: row?.maxGroupSize ?? AI_DEFAULTS.maxGroupSize,
    apiKey,
    hasStoredKey: Boolean(row?.apiKeyEnc),
    keyUnreadable: Boolean(row?.apiKeyEnc) && apiKey === null,
  }
}

export function clientConfig(c: AiConfig): AiClientConfig {
  if (!c.baseUrl || !c.model) throw new Error("AI is not set up.")
  return {
    baseUrl: c.baseUrl,
    apiKey: c.apiKey,
    model: c.model,
    temperature: c.temperature,
    maxTokens: c.maxTokens,
    timeoutSeconds: c.timeoutSeconds ?? AI_DEFAULTS.timeoutSeconds,
    extraBody: parseExtraBody(c.extraBody),
  }
}

/** Cheap check for pages (no decryption). */
export async function aiReady(): Promise<boolean> {
  const row = await prisma.aiSettings.findUnique({ where: { id: AI_SETTINGS_ID }, select: { enabled: true, baseUrl: true, model: true } })
  return isAiReady({ enabled: row?.enabled ?? false, baseUrl: row?.baseUrl ?? null, model: row?.model ?? null, keyUnreadable: false })
}
