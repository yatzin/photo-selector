import { AiError, type ChatMessage } from "@/lib/ai/client"
import { buildMessages, parseVerdict, type AiVerdict } from "@/lib/ai/prompt"

// Sends groups to the AI one at a time and reports each result through
// callbacks, so the rules (retry once on a bad reply, stop on a bad key,
// stop after repeated connection failures, honour cancel) are testable
// without a database.

export const UNREACHABLE_AFTER = 3

export type PendingGroup = { id: string; photoCount: number }

export type LoopDeps = {
  prepareImages(groupId: string): Promise<string[]>
  callAi(messages: ChatMessage[]): Promise<string>
  onAnalyzed(groupId: string, verdict: AiVerdict): Promise<void>
  onFailed(groupId: string, error: string): Promise<void>
  isCancelled(): Promise<boolean>
  customPrompt: string | null
}

export type LoopOutcome = { status: "done" } | { status: "cancelled" } | { status: "failed"; error: string }

export async function analyzeGroups(groups: PendingGroup[], deps: LoopDeps): Promise<LoopOutcome> {
  let unreachable = 0

  for (const group of groups) {
    if (await deps.isCancelled()) return { status: "cancelled" }

    let images: string[]
    try {
      images = await deps.prepareImages(group.id)
    } catch (error) {
      await deps.onFailed(group.id, error instanceof Error ? error.message : String(error))
      continue
    }

    try {
      let text = await deps.callAi(buildMessages(images, deps.customPrompt))
      let verdict = parseVerdict(text, images.length)
      if (!verdict.ok) {
        text = await deps.callAi(buildMessages(images, deps.customPrompt, verdict.error))
        verdict = parseVerdict(text, images.length)
      }
      if (verdict.ok) await deps.onAnalyzed(group.id, verdict.value)
      else await deps.onFailed(group.id, `The AI's reply couldn't be used: ${verdict.error}.`)
      unreachable = 0
    } catch (error) {
      if (!(error instanceof AiError)) {
        await deps.onFailed(group.id, error instanceof Error ? error.message : String(error))
        continue
      }
      if (error.kind === "cancelled") return { status: "cancelled" }
      if (error.kind === "auth" || error.kind === "model") return { status: "failed", error: error.message }
      await deps.onFailed(group.id, error.message)
      if (error.kind === "network" || error.kind === "timeout") {
        if (++unreachable >= UNREACHABLE_AFTER) return { status: "failed", error: `AI server unreachable: ${error.message}` }
      } else {
        unreachable = 0
      }
    }
  }
  return { status: "done" }
}
