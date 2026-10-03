import { auth } from "@/auth"
import Link from "next/link"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { aiReady } from "@/lib/ai/config"
import { listScanFolders } from "@/lib/library-server"
import { isRootKey } from "@/lib/media"
import { cn } from "@/lib/utils"
import { NewScanForm } from "@/components/ai/new-scan-form"
import { RunsTable, type RunRow } from "@/components/ai/runs-table"
import { AutoRefresh } from "@/components/ai/auto-refresh"

export default async function AiPage({ searchParams }: { searchParams: Promise<{ by?: string }> }) {
  const session = await auth()
  if (!session) redirect("/login")
  const { by } = await searchParams

  // Filter buttons: everyone, then each person who has started a scan (you first).
  const starters = await prisma.user.findMany({ where: { aiRuns: { some: {} } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
  starters.sort((a, b) => Number(b.id === session.user.id) - Number(a.id === session.user.id))
  const filterBy = starters.some((u) => u.id === by) ? by : undefined

  const [ready, folders, runs, anyActive] = await Promise.all([
    aiReady(),
    listScanFolders(),
    prisma.aiRun.findMany({
      where: filterBy ? { createdById: filterBy } : {},
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { createdBy: { select: { name: true } }, _count: { select: { groups: { where: { status: "ANALYZED" } } } } },
    }),
    // Keep refreshing while any scan runs, even one the filter hides.
    prisma.aiRun.count({ where: { status: { in: ["QUEUED", "GROUPING", "ANALYZING"] } } }),
  ])

  const rows: RunRow[] = runs
    .filter((r) => isRootKey(r.root))
    .map((r) => ({
      id: r.id, root: r.root as RunRow["root"], folder: r.folder, includeDays: r.includeDays, status: r.status,
      groupCount: r.groupCount, analyzedCount: r.analyzedCount, failedCount: r.failedCount,
      toReview: r._count.groups, error: r.error, createdAt: r.createdAt.toISOString(), createdBy: r.createdBy?.name ?? null,
    }))

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold">AI</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Find bursts of similar photos and let AI suggest the best of each.</p>
      </div>
      <NewScanForm folders={folders} ready={ready} isAdmin={session.user.role === "ADMIN"} />
      <section className="space-y-3">
        <h2 className="font-semibold">Scans</h2>
        {starters.length > 1 && (
          <nav aria-label="Started by" className="flex flex-wrap items-center gap-1.5">
            {[{ id: undefined, name: "Everyone" }, ...starters.map((u) => ({ id: u.id, name: u.id === session.user.id ? `${u.name} (you)` : u.name }))].map((u) => (
              <Link
                key={u.id ?? "all"}
                href={u.id ? `/ai?by=${u.id}` : "/ai"}
                aria-current={filterBy === u.id ? "page" : undefined}
                className={cn(
                  "inline-flex h-7 items-center rounded-lg border px-2.5 text-[0.8rem] font-medium",
                  filterBy === u.id ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"
                )}
              >
                {u.name}
              </Link>
            ))}
          </nav>
        )}
        <RunsTable runs={rows} />
      </section>
      <AutoRefresh active={anyActive > 0} />
    </div>
  )
}
