import { z } from "zod"
import type { ChatMessage, ContentPart } from "@/lib/ai/client"
import { extractJson } from "@/lib/ai/prompt"

// Find Screenshots: a few images per request, a yes/no for each. As with
// Find Similar, the instructions can be replaced under Settings → AI but the
// reply format can't: it is always appended last.

export const DEFAULT_SCREENSHOT_INSTRUCTIONS = `You help a family clean up their photo library by finding images that are not real photos.
Answer yes (screenshot) for:
- Screenshots of a phone, tablet or computer screen: apps, chats, social media, web pages, maps, games, receipts, settings.
- Saved or forwarded images: memes, downloaded pictures, graphics with added text, stickers, wallpapers, greeting cards.
Answer no for real photos taken with a camera, even of a screen, a document or a whiteboard, and even with filters or edits.
When unsure, answer no.`

export const SCREENSHOT_REPLY_FORMAT = `Reply with JSON only, no other text, in exactly this shape:
{"results":[{"photo":<number>,"screenshot":<true or false>,"note":"<what it is, under 8 words>"}]}
"results" must include every image number exactly once.`

/** Images per AI request. */
export const SHOTS_PER_REQUEST = 4

export function buildScreenshotMessages(images: string[], instructions: string | null, previousError?: string): ChatMessage[] {
  const system = `${instructions ?? DEFAULT_SCREENSHOT_INSTRUCTIONS}\n\n${SCREENSHOT_REPLY_FORMAT}`
  const parts: ContentPart[] = [{ type: "text", text: `Here are ${images.length} unrelated image${images.length === 1 ? "" : "s"}, numbered 1 to ${images.length}. Judge each on its own.` }]
  images.forEach((url, i) => {
    parts.push({ type: "text", text: `Image ${i + 1}:` })
    parts.push({ type: "image_url", image_url: { url } })
  })
  if (previousError) parts.push({ type: "text", text: `Your previous reply could not be used (${previousError}). Reply again with valid JSON only.` })
  return [{ role: "system", content: system }, { role: "user", content: parts }]
}

export type ShotVerdict = { photo: number; screenshot: boolean; note: string }[]

const yesNo = z.union([z.boolean(), z.enum(["true", "false", "yes", "no", "TRUE", "FALSE", "Yes", "No"]).transform((v) => v === "true" || v === "yes" || v === "TRUE" || v === "Yes")])

const replySchema = z.object({
  results: z.array(z.object({ photo: z.coerce.number().int(), screenshot: yesNo, note: z.string().optional().nullable() })).min(1),
})

/** The AI's answer for images 1..n, in that order; every image must be answered. */
export function parseShotVerdict(text: string, n: number): { ok: true; value: ShotVerdict } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = extractJson(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" }
  }
  const parsed = replySchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: "the JSON doesn't match the requested shape" }
  const byPhoto = new Map<number, ShotVerdict[number]>()
  for (const r of parsed.data.results) {
    if (r.photo < 1 || r.photo > n) return { ok: false, error: `image ${r.photo} doesn't exist (there are ${n})` }
    if (!byPhoto.has(r.photo)) byPhoto.set(r.photo, { photo: r.photo, screenshot: r.screenshot, note: (r.note ?? "").slice(0, 200) })
  }
  const missing = Array.from({ length: n }, (_, i) => i + 1).filter((i) => !byPhoto.has(i))
  if (missing.length) return { ok: false, error: `no answer for image ${missing.join(", ")}` }
  return { ok: true, value: Array.from({ length: n }, (_, i) => byPhoto.get(i + 1)!) }
}
