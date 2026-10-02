import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { aiReady } from "@/lib/ai/config"
import { listScanFolders } from "@/lib/library-server"
import { isRootKey } from "@/lib/media"
import { NewScanForm } from "@/components/ai/new-scan-form"
import { RunsTable, type RunRow } from "@/components/ai/runs-table"
import { AutoRefresh } from "@/components/ai/auto-refresh"

export default async function AiPage() {
  const session = await auth()
  if (!session) redirect("/login")

  const [ready, folders, runs] = await Promise.all([
    aiReady(),
    listScanFolders(),
    prisma.aiRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { createdBy: { select: { name: true } }, _count: { select: { groups: { where: { status: "ANALYZED" } } } } },
    }),
  ])

  const rows: RunRow[] = runs
    .filter((r) => isRootKey(r.root))
    .map((r) => ({
      id: r.id, root: r.root as RunRow["root"], folder: r.folder, status: r.status,
      groupCount: r.groupCount, analyzedCount: r.analyzedCount, failedCount: r.failedCount,
      toReview: r._count.groups, error: r.error, createdAt: r.createdAt.toISOString(), createdBy: r.createdBy?.name ?? null,
    }))
  const active = rows.some((r) => r.status === "QUEUED" || r.status === "GROUPING" || r.status === "ANALYZING")

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold">AI</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Find bursts of similar photos and let AI suggest the best of each.</p>
      </div>
      <NewScanForm folders={folders} ready={ready} isAdmin={session.user.role === "ADMIN"} />
      <section className="space-y-3">
        <h2 className="font-semibold">Scans</h2>
        <RunsTable runs={rows} />
      </section>
      <AutoRefresh active={active} />
    </div>
  )
}
