import "server-only"
import { prisma } from "@/lib/prisma"
import { isFolderLocked, type ActiveScan } from "@/lib/ai/lock"

// Only scans actually reading a folder lock it. A scan waiting in the queue
// takes its snapshot of the folder when it starts (and checks every photo's
// version before analyzing it), so the folder can change freely until then —
// otherwise queuing every folder would lock the whole library. Find
// Screenshots scans never lock: they check each image as they go.
const WORKING = ["GROUPING", "ANALYZING"] as const

export function activeScans(): Promise<ActiveScan[]> {
  return prisma.aiRun.findMany({ where: { kind: "similar", status: { in: [...WORKING] } }, select: { root: true, folder: true, includeDays: true } })
}

export async function folderLocked(root: string, segments: string[]): Promise<boolean> {
  return isFolderLocked(await activeScans(), root, segments)
}
