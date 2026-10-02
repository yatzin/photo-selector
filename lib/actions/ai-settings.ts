"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import sharp from "sharp"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { encrypt } from "@/lib/secret-box"
import { AI_SETTINGS_ID, loadAiConfig } from "@/lib/ai/config"
import { AI_DEFAULTS, originChanged, parseAiSettings, parseExtraBody, type AiSettingsInput } from "@/lib/ai/settings-schema"
import { AiError, chatOnce } from "@/lib/ai/client"

async function requireAdmin() {
  const session = await auth()
  if (!session) redirect("/login")
  if (session.user.role !== "ADMIN") redirect("/")
  return session
}

export async function updateAiSettings(data: AiSettingsInput): Promise<{ error: string } | { success: true }> {
  await requireAdmin()
  const result = parseAiSettings(data)
  if (!result.ok) return { error: result.error }

  const saved = await prisma.aiSettings.findUnique({ where: { id: AI_SETTINGS_ID }, select: { baseUrl: true } })
  // A stored key never follows the settings to a different server.
  const serverChanged = originChanged(saved?.baseUrl ?? null, result.value.baseUrl)
  const apiKeyEnc = data.clearApiKey ? null : data.apiKey ? encrypt(data.apiKey) : serverChanged ? null : undefined

  await prisma.aiSettings.upsert({
    where: { id: AI_SETTINGS_ID },
    create: { id: AI_SETTINGS_ID, ...result.value, apiKeyEnc: apiKeyEnc ?? null },
    update: { ...result.value, ...(apiKeyEnc === undefined ? {} : { apiKeyEnc }) },
  })
  revalidatePath("/", "layout")
  return { success: true }
}

export type AiTestResult = { error: string } | { success: true; model: string; seesImages: boolean; detail: string }

/**
 * Sends a tiny solid-red image and asks for its colour. Tests what's on
 * screen, falling back to saved values; a saved key only goes to its own server.
 */
export async function testAiConnection(data: AiSettingsInput): Promise<AiTestResult> {
  await requireAdmin()
  const parsed = parseAiSettings(data, { requireComplete: false })
  if (!parsed.ok) return { error: parsed.error }

  const saved = await loadAiConfig()
  const baseUrl = parsed.value.baseUrl ?? saved.baseUrl
  const model = parsed.value.model ?? saved.model
  if (!baseUrl || !model) return { error: "Enter a base URL and model first." }
  const savedKey = originChanged(saved.baseUrl, baseUrl) ? null : saved.apiKey
  const apiKey = data.clearApiKey ? null : data.apiKey || savedKey

  const red = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ff0000" } }).jpeg().toBuffer()
  try {
    const text = await chatOnce(
      {
        baseUrl, apiKey, model,
        temperature: 0,
        maxTokens: parsed.value.maxTokens,
        timeoutSeconds: parsed.value.timeoutSeconds ?? AI_DEFAULTS.timeoutSeconds,
        extraBody: parseExtraBody(parsed.value.extraBody),
      },
      [
        {
          role: "user",
          content: [
            { type: "text", text: 'What single colour fills this image? Reply only with JSON like {"color":"blue"}.' },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${red.toString("base64")}` } },
          ],
        },
      ]
    )
    const seesImages = /red/i.test(text)
    return {
      success: true,
      model,
      seesImages,
      detail: seesImages ? "Connected — the model can see images." : `Connected, but the model didn't recognise the test image. It replied: ${text.slice(0, 200)}`,
    }
  } catch (error) {
    if (error instanceof AiError && error.kind === "bad-request") {
      return { error: `Connected, but this model doesn't accept images — choose a vision model. (${error.message})` }
    }
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
