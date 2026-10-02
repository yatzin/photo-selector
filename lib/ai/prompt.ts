import { z } from "zod"
import type { ChatMessage, ContentPart } from "@/lib/ai/client"

export const BUILTIN_INSTRUCTION = `You help a family choose the best photo from a burst of near-identical takes of the same moment.
Judge the main subjects only (the people the photo is clearly about); ignore people in the background.
Rank every photo from best to worst using, in order of importance:
1. Main subjects' eyes are open (no blinks, no half-closed eyes).
2. Main subjects are looking at the camera.
3. Natural smiles and pleasant expressions.
4. Sharp focus on faces, no motion blur.
5. Good exposure; nobody important cut off at the edges.
If there are no people, judge sharpness, exposure and composition.
Reply with JSON only, no other text, in exactly this shape:
{"ranking":[{"photo":<number>,"note":"<short reason, under 15 words>"}],"best":[<photo number>],"reason":"<one or two sentences on why the best photo wins>"}
"ranking" must include every photo number exactly once. "best" is usually one photo; list two only if they are equally good.`

export function buildMessages(images: string[], customPrompt: string | null, previousError?: string): ChatMessage[] {
  const system = customPrompt ? `${BUILTIN_INSTRUCTION}\n\nAdditional instructions from the family:\n${customPrompt}` : BUILTIN_INSTRUCTION
  const parts: ContentPart[] = [{ type: "text", text: `Here are ${images.length} photos of the same moment, numbered 1 to ${images.length}.` }]
  images.forEach((url, i) => {
    parts.push({ type: "text", text: `Photo ${i + 1}:` })
    parts.push({ type: "image_url", image_url: { url } })
  })
  if (previousError) parts.push({ type: "text", text: `Your previous reply could not be used (${previousError}). Reply again with valid JSON only.` })
  return [{ role: "system", content: system }, { role: "user", content: parts }]
}

export type AiVerdict = { ranking: { photo: number; note: string }[]; best: number[]; reason: string }

const replySchema = z.object({
  ranking: z.array(z.object({ photo: z.coerce.number().int(), note: z.string().optional().nullable() })).min(1),
  best: z.union([z.coerce.number().int(), z.array(z.coerce.number().int())]).optional(),
  reason: z.string().optional().nullable(),
})

function extractJson(text: string): unknown {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("no JSON object in the reply")
  return JSON.parse(text.slice(start, end + 1))
}

export function parseVerdict(text: string, n: number): { ok: true; value: AiVerdict } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = extractJson(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" }
  }
  const parsed = replySchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: "the JSON doesn't match the requested shape" }

  const inRange = (x: number) => x >= 1 && x <= n
  const seen = new Set<number>()
  const ranking: AiVerdict["ranking"] = []
  for (const r of parsed.data.ranking) {
    if (!inRange(r.photo)) return { ok: false, error: `photo ${r.photo} doesn't exist (there are ${n})` }
    if (seen.has(r.photo)) continue
    seen.add(r.photo)
    ranking.push({ photo: r.photo, note: (r.note ?? "").slice(0, 200) })
  }
  for (let i = 1; i <= n; i++) if (!seen.has(i)) ranking.push({ photo: i, note: "" })

  const bestRaw = parsed.data.best
  const best = bestRaw === undefined ? [ranking[0].photo] : [...new Set(Array.isArray(bestRaw) ? bestRaw : [bestRaw])]
  if (best.length === 0 || !best.every(inRange)) return { ok: false, error: "best must name existing photos" }

  return { ok: true, value: { ranking, best, reason: (parsed.data.reason ?? "").slice(0, 1000) } }
}
