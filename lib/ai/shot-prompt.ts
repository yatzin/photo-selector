import { z } from "zod"
import type { ChatMessage, ContentPart } from "@/lib/ai/client"
import { extractJson } from "@/lib/ai/prompt"
import type { ShotKind } from "@/lib/ai/review"

// Find Screenshots and Quality Checks: a few images per request, a yes/no for
// each. As with Find Similar, the instructions can be replaced under
// Settings → AI but the reply format can't: it is always appended last.

export const DEFAULT_SCREENSHOT_INSTRUCTIONS = `You help a family clean up their photo library by finding images that are not real photos.
Answer yes (screenshot) for:
- Screenshots of a phone, tablet or computer screen: apps, chats, social media, web pages, maps, games, receipts, settings.
- Saved or forwarded images: memes, downloaded pictures, graphics with added text, stickers, wallpapers, greeting cards.
Answer no for real photos taken with a camera, even of a screen, a document or a whiteboard, and even with filters or edits.
When unsure, answer no.`

export const SCREENSHOT_REPLY_FORMAT = `Reply with JSON only, no other text, in exactly this shape:
{"results":[{"photo":<number>,"screenshot":<true or false>,"note":"<what it is, under 8 words>"}]}
"results" must include every image number exactly once.`

export const DEFAULT_QUALITY_INSTRUCTIONS = `You help a family clean up their photo library by finding technically bad photos that nobody would want to keep.
Answer yes (bad) for:
- Motion blur or severe camera shake.
- Out of focus: the subject is clearly blurry.
- Closed eyes: the main person in the photo has their eyes closed.
- Extreme under- or overexposure: almost completely black or white, or the subject can't be made out.
- Accidental shots: the inside of a pocket or bag, the floor, the ceiling, a random wall, a car dashboard, someone's leg or feet, the camera opened by mistake.
- A finger or something else covering the lens.
- Extremely close accidental shots where nothing can be recognised.
- Extremely low quality: heavy noise, heavy compression, smeared or tiny.
Answer no for photos that are only a little soft, dark or noisy, deliberate effects (intentional blur, silhouettes, night shots), screenshots and saved images, and anything someone could plausibly want to keep.
When unsure, answer no.`

export const QUALITY_REPLY_FORMAT = `Reply with JSON only, no other text, in exactly this shape:
{"results":[{"photo":<number>,"bad":<true or false>,"note":"<what is wrong, under 6 words, or empty>"}]}
"results" must include every image number exactly once.`

export type ShotPrompt = {
  defaultInstructions: string
  replyFormat: string
  /** The yes/no field in the reply. */
  flag: string
}

export const SHOT_PROMPTS: Record<ShotKind, ShotPrompt> = {
  screenshots: { defaultInstructions: DEFAULT_SCREENSHOT_INSTRUCTIONS, replyFormat: SCREENSHOT_REPLY_FORMAT, flag: "screenshot" },
  quality: { defaultInstructions: DEFAULT_QUALITY_INSTRUCTIONS, replyFormat: QUALITY_REPLY_FORMAT, flag: "bad" },
}

/** Images per AI request. */
export const SHOTS_PER_REQUEST = 4

export function buildShotMessages(prompt: ShotPrompt, images: string[], instructions: string | null, previousError?: string): ChatMessage[] {
  const system = `${instructions ?? prompt.defaultInstructions}\n\n${prompt.replyFormat}`
  const parts: ContentPart[] = [{ type: "text", text: `Here are ${images.length} unrelated image${images.length === 1 ? "" : "s"}, numbered 1 to ${images.length}. Judge each on its own.` }]
  images.forEach((url, i) => {
    parts.push({ type: "text", text: `Image ${i + 1}:` })
    parts.push({ type: "image_url", image_url: { url } })
  })
  if (previousError) parts.push({ type: "text", text: `Your previous reply could not be used (${previousError}). Reply again with valid JSON only.` })
  return [{ role: "system", content: system }, { role: "user", content: parts }]
}

export type ShotVerdict = { photo: number; flagged: boolean; note: string }[]

const yesNo = z.union([z.boolean(), z.enum(["true", "false", "yes", "no", "TRUE", "FALSE", "Yes", "No"]).transform((v) => v === "true" || v === "yes" || v === "TRUE" || v === "Yes")])

/** The AI's answer for images 1..n, in that order; every image must be answered. */
export function parseShotVerdict(prompt: ShotPrompt, text: string, n: number): { ok: true; value: ShotVerdict } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = extractJson(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" }
  }
  const replySchema = z.object({
    results: z.array(z.object({ photo: z.coerce.number().int(), [prompt.flag]: yesNo, note: z.string().optional().nullable() })).min(1),
  })
  const parsed = replySchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: "the JSON doesn't match the requested shape" }
  const byPhoto = new Map<number, ShotVerdict[number]>()
  for (const r of parsed.data.results as { photo: number; note?: string | null; [flag: string]: unknown }[]) {
    if (r.photo < 1 || r.photo > n) return { ok: false, error: `image ${r.photo} doesn't exist (there are ${n})` }
    if (!byPhoto.has(r.photo)) byPhoto.set(r.photo, { photo: r.photo, flagged: r[prompt.flag] === true, note: (r.note ?? "").slice(0, 200) })
  }
  const missing = Array.from({ length: n }, (_, i) => i + 1).filter((i) => !byPhoto.has(i))
  if (missing.length) return { ok: false, error: `no answer for image ${missing.join(", ")}` }
  return { ok: true, value: Array.from({ length: n }, (_, i) => byPhoto.get(i + 1)!) }
}
