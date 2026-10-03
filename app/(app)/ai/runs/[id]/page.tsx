import fs from "fs/promises"
import path from "path"
import Link from "next/link"
import { TriangleAlert } from "lucide-react"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { cn } from "@/lib/utils"
import { isRootKey, mediaKind, ROOT_LABELS } from "@/lib/media"
import { rootPath } from "@/lib/library-server"
import { currentVersions } from "@/lib/ai/review-server"
import { pageWindow, scanFolderSegments } from "@/lib/ai/review"
import { AutoRefresh } from "@/components/ai/auto-refresh"
import { type ReviewPhoto } from "@/components/ai/review-group"
import { ReviewList } from "@/components/ai/review-list"
import { Pager } from "@/components/ai/pager"

const TABS = [
  { id: "review", label: "To review", statuses: ["ANALYZED"] },
  { id: "done", label: "Done", statuses: ["RESOLVED", "DISMISSED"] },
  { id: "failed", label: "Failed", statuses: ["FAILED"] },
] as const

// Groups per page. Each page stats only its own photos and requests only its
// own thumbnails, so a scan of a huge folder stays quick to open.
const PAGE_SIZE = 20

export default async function RunReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; page?: string }> }) {
  const session = await auth()
  if (!session) redirect("/login")
  const [{ id }, { tab, page: pageParam }] = await Promise.all([params, searchParams])
  const run = await prisma.aiRun.findUnique({ where: { id } })
  if (!run || !isRootKey(run.root)) notFound()
  const segs = scanFolderSegments(run.folder)
  if (!segs) notFound()
  const active = TABS.find((t) => t.id === tab) ?? TABS[0]

  const counts = await prisma.aiGroup.groupBy({ by: ["status"], where: { runId: id }, _count: true })
  const count = (statuses: readonly string[]) => counts.filter((c) => statuses.includes(c.status)).reduce((n, c) => n + c._count, 0)
  const { page, pages, skip, take } = pageWindow(count(active.statuses), pageParam, PAGE_SIZE)
  const groups = await prisma.aiGroup.findMany({
    where: { runId: id, status: { in: [...active.statuses] } },
    orderBy: [{ takenAt: "asc" }, { id: "asc" }],
    include: { photos: true },
    skip,
    take,
  })

  const allNames = [...new Set(groups.flatMap((g) => g.photos.map((p) => p.name)))]
  const versions = await currentVersions(run.root, run.folder, allNames)
  const dir = path.join(rootPath(run.root), ...segs)
  const stats = new Map(
    await Promise.all(allNames.map(async (n) => [n, await fs.stat(path.join(dir, n)).catch(() => null)] as const))
  )

  const running = run.status === "QUEUED" || run.status === "GROUPING" || run.status === "ANALYZING"
  const where = `${ROOT_LABELS[run.root]}${segs.length ? ` / ${segs.join(" / ")}` : ""}${run.includeDays ? " — all days" : ""}`

  return (
    <div className="max-w-6xl space-y-5">
      <div>
        <Link href="/ai" className="text-sm text-muted-foreground hover:text-foreground">← AI</Link>
        <h1 className="mt-1 font-heading text-2xl font-semibold">{where}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {run.groupCount} group{run.groupCount === 1 ? "" : "s"} from {run.photoCount} photos
          {run.model && ` · ${run.model}`}
        </p>
      </div>

      {running && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-amber-500/50 bg-amber-500/15 px-4 py-3">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-0.5 text-sm">
            <p className="font-semibold text-amber-800 dark:text-amber-300">
              Scan in progress{run.status === "ANALYZING" && run.groupCount > 0 ? ` — ${run.analyzedCount + run.failedCount} of ${run.groupCount} groups done` : run.status === "QUEUED" ? " — waiting its turn" : " — grouping photos"}
            </p>
            <p className="text-amber-900/80 dark:text-amber-200/80">
              You can look through results as they arrive, but the buttons stay locked until the scan finishes, so the folder doesn&apos;t change under it.
              To stop it, cancel the scan on the <Link href="/ai" className="font-medium underline underline-offset-2">AI page</Link>.
            </p>
          </div>
        </div>
      )}

      <nav className="flex gap-1 border-b">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/ai/runs/${id}?tab=${t.id}`}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", t.id === active.id ? "border-primary text-link" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t.label} <span className="text-xs text-muted-foreground">({count(t.statuses)})</span>
          </Link>
        ))}
      </nav>

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {active.id === "review" ? (running ? "Waiting for the AI…" : "All caught up.") : "Nothing here."}
        </p>
      ) : (
        <ReviewList
          acceptAll={active.id === "review" && !running}
          groups={groups.map((g) => ({
            id: g.id, root: run.root as "upload" | "dropoff", folder: segs, status: g.status, reason: g.reason, error: g.error, locked: running,
            photos: g.photos.map((p): ReviewPhoto => {
              const st = stats.get(p.name)
              const same = versions.get(p.name) === p.version
              return {
                name: p.name, rank: p.rank, note: p.note, suggested: p.suggested, decision: p.decision,
                current: same && st ? { name: p.name, kind: mediaKind(p.name) ?? "image", size: st.size, modified: st.mtimeMs, version: p.version } : null,
              }
            }),
          }))}
        />
      )}
      {pages > 1 && <Pager href={(n) => `/ai/runs/${id}?tab=${active.id}&page=${n}`} page={page} pages={pages} />}
      <AutoRefresh active={running} intervalMs={5000} />
    </div>
  )
}
