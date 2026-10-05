import { AiError, type ChatMessage } from "@/lib/ai/client"
import { buildShotMessages, parseShotVerdict, type ShotPrompt } from "@/lib/ai/shot-prompt"
import { UNREACHABLE_AFTER } from "@/lib/ai/analysis-loop"

// Find Screenshots and Quality Checks: sends images to the AI a few at a time and reports each
// answer through callbacks. Same rules as analysis-loop.ts: retry once on a
// bad reply, stop on a bad key or model, stop after repeated connection
// failures, honour cancel. An image that can't be prepared fails alone.

export type ShotDeps = {
  /** A data: URL, or null when the image is gone and should be dropped quietly. */
  prepareImage(id: string): Promise<string | null>
  callAi(messages: ChatMessage[]): Promise<string>
  onResults(results: { id: string; flagged: boolean; note: string }[]): Promise<void>
  onFailed(ids: string[], error: string): Promise<void>
  onGone(ids: string[]): Promise<void>
  isCancelled(): Promise<boolean>
  prompt: ShotPrompt
  instructions: string | null
  batchSize: number
}

export type ShotOutcome = { status: "done" } | { status: "cancelled" } | { status: "failed"; error: string }

export async function analyzeShots(ids: string[], deps: ShotDeps): Promise<ShotOutcome> {
  let unreachable = 0
  for (let i = 0; i < ids.length; i += deps.batchSize) {
    if (await deps.isCancelled()) return { status: "cancelled" }

    const batch: { id: string; url: string }[] = []
    for (const id of ids.slice(i, i + deps.batchSize)) {
      try {
        const url = await deps.prepareImage(id)
        if (url) batch.push({ id, url })
        else await deps.onGone([id])
      } catch (error) {
        await deps.onFailed([id], error instanceof Error ? error.message : String(error))
      }
    }
    if (!batch.length) continue
    const images = batch.map((b) => b.url)
    const batchIds = batch.map((b) => b.id)

    try {
      const ask = async (previousError?: string) =>
        parseShotVerdict(deps.prompt, await deps.callAi(buildShotMessages(deps.prompt, images, deps.instructions, previousError)), images.length)
      let verdict = await ask()
      if (!verdict.ok) verdict = await ask(verdict.error)
      if (verdict.ok) await deps.onResults(verdict.value.map((v, j) => ({ id: batchIds[j], flagged: v.flagged, note: v.note })))
      else await deps.onFailed(batchIds, `The AI's reply couldn't be used: ${verdict.error}.`)
      unreachable = 0
    } catch (error) {
      if (!(error instanceof AiError)) {
        await deps.onFailed(batchIds, error instanceof Error ? error.message : String(error))
        continue
      }
      if (error.kind === "cancelled") return { status: "cancelled" }
      if (error.kind === "auth" || error.kind === "model") return { status: "failed", error: error.message }
      await deps.onFailed(batchIds, error.message)
      if (error.kind === "network" || error.kind === "timeout") {
        if (++unreachable >= UNREACHABLE_AFTER) return { status: "failed", error: `AI server unreachable: ${error.message}` }
      } else {
        unreachable = 0
      }
    }
  }
  return { status: "done" }
}
