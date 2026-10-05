import { auth } from "@/auth"
import Link from "next/link"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { aiReady } from "@/lib/ai/config"
import { listScanFolders } from "@/lib/library-server"
import { isRootKey } from "@/lib/media"
import { cn } from "@/lib/utils"
import { NewScanForm } from "@/components/ai/new-scan-form"
import { QueueButtons } from "@/components/ai/queue-buttons"
import { minScanImages, pageWindow, type ScanKind } from "@/lib/ai/review"
import { Pager } from "@/components/ai/pager"
import { RunsTable, type RunRow } from "@/components/ai/runs-table"
import { AutoRefresh } from "@/components/ai/auto-refresh"

const RUNS_PER_PAGE = 25

const KINDS: { id: ScanKind; label: string; blurb: string }[] = [
  { id: "similar", label: "Find Similar", blurb: "Find bursts of similar photos and let AI suggest the best of each." },
  { id: "screenshots", label: "Find Screenshots", blurb: "Find screenshots and saved images mixed in with your photos." },
  { id: "quality", label: "Quality Checks", blurb: "Find blurry, dark and accidental photos nobody wants to keep." },
]

export default async function AiPage({ searchParams }: { searchParams: Promise<{ tab?: string; by?: string; page?: string }> }) {
  const session = await auth()
  if (!session) redirect("/login")
  const { tab, by, page: pageParam } = await searchParams
  const kind = KINDS.find((k) => k.id === tab) ?? KINDS[0]
  // Links keep the tab (Find Similar, the default, has none).
  const href = (params: { by?: string; page?: number }) => {
    const q = new URLSearchParams()
    if (kind.id !== "similar") q.set("tab", kind.id)
    if (params.by) q.set("by", params.by)
    if (params.page) q.set("page", String(params.page))
    return q.size ? `/ai?${q}` : "/ai"
  }

  // Filter buttons: everyone, then each person who has started a scan of this kind (you first).
  const starters = await prisma.user.findMany({ where: { aiRuns: { some: { kind: kind.id, closedAt: null } } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
  starters.sort((a, b) => Number(b.id === session.user.id) - Number(a.id === session.user.id))
  const filterBy = starters.some((u) => u.id === by) ? by : undefined

  // Oldest first, the order the queue runs in, so the next scan up is on top.
  // Closed scans (every result handled) are left out.
  const runFilter = { kind: kind.id, closedAt: null, ...(filterBy ? { createdById: filterBy } : {}) }
  const { page, pages, skip, take } = pageWindow(await prisma.aiRun.count({ where: runFilter }), pageParam, RUNS_PER_PAGE)

  const [ready, folders, runs, anyActive, scanned, queued] = await Promise.all([
    aiReady(),
    listScanFolders(),
    prisma.aiRun.findMany({
      where: runFilter,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip,
      take,
      include: {
        createdBy: { select: { name: true } },
        _count: { select: { groups: { where: { status: "ANALYZED" } }, shots: { where: { status: "FLAGGED" } } } },
      },
    }),
    // Keep refreshing while any scan runs, even one the filter hides.
    prisma.aiRun.count({ where: { status: { in: ["QUEUED", "GROUPING", "ANALYZING"] } } }),
    prisma.aiRun.findMany({ where: { kind: kind.id }, select: { root: true, folder: true } }),
    prisma.aiRun.count({ where: { kind: kind.id, status: "QUEUED" } }),
  ])
  const scannedKeys = new Set(scanned.map((r) => `${r.root}|${r.folder}`))
  const unscanned = folders.filter((f) => f.imageCount >= minScanImages(kind.id) && !scannedKeys.has(`${f.root}|${f.folder}`)).length

  const rows: RunRow[] = runs
    .filter((r) => isRootKey(r.root))
    .map((r) => ({
      id: r.id, kind: kind.id, root: r.root as RunRow["root"], folder: r.folder, includeDays: r.includeDays, status: r.status,
      photoCount: r.photoCount, groupCount: r.groupCount, analyzedCount: r.analyzedCount, failedCount: r.failedCount,
      toReview: kind.id === "similar" ? r._count.groups : r._count.shots, error: r.error, createdAt: r.createdAt.toISOString(), createdBy: r.createdBy?.name ?? null,
    }))

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold">AI</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{kind.blurb}</p>
        </div>
        <QueueButtons kind={kind.id} unscanned={unscanned} queued={queued} ready={ready} />
      </div>
      <nav aria-label="Scan type" className="flex gap-1 overflow-x-auto border-b">
        {KINDS.map((k) => (
          <Link
            key={k.id}
            href={k.id === "similar" ? "/ai" : `/ai?tab=${k.id}`}
            aria-current={k.id === kind.id ? "page" : undefined}
            className={cn(
              "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium",
              k.id === kind.id ? "border-primary text-link" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {k.label}
          </Link>
        ))}
      </nav>
      <NewScanForm key={kind.id} kind={kind.id} folders={folders} ready={ready} isAdmin={session.user.role === "ADMIN"} />
      <section className="space-y-3">
        <h2 className="font-semibold">Scans</h2>
        {starters.length > 0 && (
          <nav aria-label="Started by" className="flex flex-wrap items-center gap-1.5">
            {[{ id: undefined, name: "Everyone" }, ...starters.map((u) => ({ id: u.id, name: u.id === session.user.id ? `${u.name} (you)` : u.name }))].map((u) => (
              <Link
                key={u.id ?? "all"}
                href={href({ by: u.id })}
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
        {pages > 1 && <Pager href={(n) => href({ by: filterBy, page: n })} page={page} pages={pages} />}
      </section>
      <AutoRefresh active={anyActive > 0} />
    </div>
  )
}
