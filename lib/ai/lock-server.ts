import "server-only"
import { prisma } from "@/lib/prisma"
import { isFolderLocked, type ActiveScan } from "@/lib/ai/lock"

const ACTIVE = ["QUEUED", "GROUPING", "ANALYZING"] as const

export function activeScans(): Promise<ActiveScan[]> {
  return prisma.aiRun.findMany({ where: { status: { in: [...ACTIVE] } }, select: { root: true, folder: true, includeDays: true } })
}

export async function folderLocked(root: string, segments: string[]): Promise<boolean> {
  return isFolderLocked(await activeScans(), root, segments)
}
