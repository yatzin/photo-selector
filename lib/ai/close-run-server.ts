import "server-only"
import { prisma } from "@/lib/prisma"

// A finished scan whose results have all been handled is closed: it drops off
// the AI page but stays on record, so "Scan all unscanned" and re-scans still
// know what it covered and answered. Anything that brings a result back
// (Undo, "Is a screenshot") reopens it.

/** Closes the run when it's done and nothing in it needs the user any more, or reopens it when something does. Returns true if it's closed. */
export async function syncRunClosed(runId: string): Promise<boolean> {
  const run = await prisma.aiRun.findUnique({ where: { id: runId }, select: { status: true, closedAt: true } })
  if (!run || run.status !== "DONE") return false
  const [groups, shots] = await Promise.all([
    prisma.aiGroup.count({ where: { runId, status: { in: ["PENDING", "ANALYZED", "FAILED"] } } }),
    prisma.aiShot.count({ where: { runId, status: { in: ["PENDING", "FLAGGED", "FAILED"] } } }),
  ])
  const handled = groups + shots === 0
  if (handled !== !!run.closedAt) await prisma.aiRun.update({ where: { id: runId }, data: { closedAt: handled ? new Date() : null } })
  return handled
}
