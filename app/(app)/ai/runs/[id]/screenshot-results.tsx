import fs from "fs/promises"
import path from "path"
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { cn } from "@/lib/utils"
import { mediaKind, ROOT_LABELS, type RootKey } from "@/lib/media"
import { rootPath } from "@/lib/library-server"
import { currentVersions } from "@/lib/ai/review-server"
import { pageWindow } from "@/lib/ai/review"
import { folderLocked } from "@/lib/ai/lock-server"
import { AutoRefresh } from "@/components/ai/auto-refresh"
import { Pager } from "@/components/ai/pager"
import { ShotGrid, type ShotItem } from "@/components/ai/shot-grid"
import type { AiRun } from "@/app/generated/prisma/client"

// Results of a Find Screenshots scan: what the AI flagged, what you said
// isn't a screenshot, and what failed. Images deleted, moved or changed
// elsewhere drop out of the lists as they're found.

const TABS = [
  { id: "found", label: "Screenshots", statuses: ["SCREENSHOT"] },
  { id: "kept", label: "Not screenshots", statuses: ["KEPT"] },
  { id: "failed", label: "Failed", statuses: ["FAILED"] },
] as const

const PAGE_SIZE = 120

export async function ScreenshotResults({ run, root, segs, tab, pageParam }: { run: AiRun; root: RootKey; segs: string[]; tab?: string; pageParam?: string }) {
  const active = TABS.find((t) => t.id === tab) ?? TABS[0]
  const dir = path.join(rootPath(root), ...segs)
  const where = { runId: run.id, status: { in: [...active.statuses] } }

  // This page's images, minus any no longer as scanned (marked REMOVED, so they don't come back).
  const load = async () => {
    const counts = await prisma.aiShot.groupBy({ by: ["status"], where: { runId: run.id }, _count: true })
    const count = (statuses: readonly string[]) => counts.filter((c) => statuses.includes(c.status)).reduce((n, c) => n + c._count, 0)
    const win = pageWindow(count(active.statuses), pageParam, PAGE_SIZE)
    const rows = await prisma.aiShot.findMany({ where, orderBy: [{ takenAt: "asc" }, { name: "asc" }], skip: win.skip, take: win.take })
    return { count, win, rows }
  }
  let { count, win, rows } = await load()
  if (active.id !== "failed") {
    const versions = await currentVersions(root, run.folder, rows.map((r) => r.name))
    const gone = rows.filter((r) => versions.get(r.name) !== r.version).map((r) => r.id)
    if (gone.length) {
      await prisma.aiShot.updateMany({ where: { id: { in: gone } }, data: { status: "REMOVED" } })
      ;({ count, win, rows } = await load())
    }
  }

  const stats = new Map(await Promise.all(rows.map(async (r) => [r.name, await fs.stat(path.join(dir, r.name)).catch(() => null)] as const)))
  const items: ShotItem[] = rows.map((r) => {
    const st = stats.get(r.name)
    return {
      id: r.id, name: r.name, note: r.note, error: r.error,
      file: st ? { name: r.name, kind: mediaKind(r.name) ?? "image", size: st.size, modified: st.mtimeMs, version: r.version } : null,
    }
  })

  const running = run.status === "QUEUED" || run.status === "GROUPING" || run.status === "ANALYZING"
  const locked = await folderLocked(root, segs)
  const title = `${ROOT_LABELS[root]}${segs.length ? ` / ${segs.join(" / ")}` : ""}${run.includeDays ? " — all days" : ""}`
  const progress =
    run.status === "GROUPING" ? "Reading photo details…"
    : run.status === "QUEUED" ? "Waiting its turn…"
    : run.status === "ANALYZING" ? `Asking the AI — ${run.analyzedCount + run.failedCount} of ${run.groupCount} images`
    : null

  return (
    <div className="max-w-6xl space-y-5">
      <div>
        <Link href="/ai?tab=screenshots" className="text-sm text-muted-foreground hover:text-foreground">← Find Screenshots</Link>
        <h1 className="mt-1 font-heading text-2xl font-semibold">{title}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {run.photoCount} photo{run.photoCount === 1 ? "" : "s"} checked, {run.groupCount} without camera details asked the AI
          {run.model && ` · ${run.model}`}
        </p>
        {progress && <p className="mt-1 text-sm font-medium text-link">{progress} New results appear as they come in.</p>}
      </div>

      <nav className="flex gap-1 overflow-x-auto border-b">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/ai/runs/${run.id}?tab=${t.id}`}
            className={cn("-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium", t.id === active.id ? "border-primary text-link" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t.label} <span className="text-xs text-muted-foreground">({count(t.statuses)})</span>
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {active.id === "found" ? (running ? "Waiting for the AI…" : "No screenshots left to review.") : "Nothing here."}
        </p>
      ) : (
        <ShotGrid
          key={`${active.id}-${win.page}`}
          runId={run.id}
          root={root}
          rootDir={rootPath(root)}
          folder={segs}
          mode={active.id}
          items={items}
          canMove={root === "upload"}
          locked={locked}
        />
      )}
      {win.pages > 1 && <Pager href={(n) => `/ai/runs/${run.id}?tab=${active.id}&page=${n}`} page={win.page} pages={win.pages} />}
      <AutoRefresh active={running} intervalMs={5000} />
    </div>
  )
}
