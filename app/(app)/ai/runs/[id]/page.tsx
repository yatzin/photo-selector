import fs from "fs/promises"
import path from "path"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { cn } from "@/lib/utils"
import { isRootKey, mediaKind, ROOT_LABELS } from "@/lib/media"
import { rootPath } from "@/lib/library-server"
import { currentVersions } from "@/lib/ai/review-server"
import { scanFolderSegments } from "@/lib/ai/review"
import { AutoRefresh } from "@/components/ai/auto-refresh"
import { ReviewGroup, type ReviewPhoto } from "@/components/ai/review-group"

const TABS = [
  { id: "review", label: "To review", statuses: ["ANALYZED"] },
  { id: "done", label: "Done", statuses: ["RESOLVED", "DISMISSED"] },
  { id: "failed", label: "Failed", statuses: ["FAILED"] },
] as const

export default async function RunReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const session = await auth()
  if (!session) redirect("/login")
  const [{ id }, { tab }] = await Promise.all([params, searchParams])
  const run = await prisma.aiRun.findUnique({ where: { id } })
  if (!run || !isRootKey(run.root)) notFound()
  const segs = scanFolderSegments(run.folder)
  if (!segs) notFound()
  const active = TABS.find((t) => t.id === tab) ?? TABS[0]

  const [groups, counts] = await Promise.all([
    prisma.aiGroup.findMany({ where: { runId: id, status: { in: [...active.statuses] } }, orderBy: { takenAt: "asc" }, include: { photos: true } }),
    prisma.aiGroup.groupBy({ by: ["status"], where: { runId: id }, _count: true }),
  ])
  const count = (statuses: readonly string[]) => counts.filter((c) => statuses.includes(c.status)).reduce((n, c) => n + c._count, 0)

  const allNames = [...new Set(groups.flatMap((g) => g.photos.map((p) => p.name)))]
  const versions = await currentVersions(run.root, run.folder, allNames)
  const dir = path.join(rootPath(run.root), ...segs)
  const stats = new Map(
    await Promise.all(allNames.map(async (n) => [n, await fs.stat(path.join(dir, n)).catch(() => null)] as const))
  )

  const running = run.status === "QUEUED" || run.status === "GROUPING" || run.status === "ANALYZING"
  const where = `${ROOT_LABELS[run.root]}${segs.length ? ` / ${segs.join(" / ")}` : ""}`

  return (
    <div className="max-w-6xl space-y-5">
      <div>
        <Link href="/ai" className="text-sm text-muted-foreground hover:text-foreground">← AI</Link>
        <h1 className="mt-1 font-heading text-2xl font-semibold">{where}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {run.groupCount} group{run.groupCount === 1 ? "" : "s"} from {run.photoCount} photos
          {running && " · still scanning — review actions unlock when it finishes (the folder is locked while it runs)"}
          {run.model && ` · ${run.model}`}
        </p>
      </div>

      <nav className="flex gap-1 border-b">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/ai/runs/${id}?tab=${t.id}`}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", t.id === active.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
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
        <div className="space-y-4">
          {groups.map((g) => {
            const photos: ReviewPhoto[] = g.photos.map((p) => {
              const st = stats.get(p.name)
              const same = versions.get(p.name) === p.version
              return {
                name: p.name, rank: p.rank, note: p.note, suggested: p.suggested, decision: p.decision,
                current: same && st ? { name: p.name, kind: mediaKind(p.name) ?? "image", size: st.size, modified: st.mtimeMs, version: p.version } : null,
              }
            })
            return <ReviewGroup key={g.id} id={g.id} root={run.root as "upload" | "dropoff"} folder={segs} status={g.status} reason={g.reason} error={g.error} photos={photos} locked={running} />
          })}
        </div>
      )}
      <AutoRefresh active={running} intervalMs={5000} />
    </div>
  )
}
