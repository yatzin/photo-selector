"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { cancelRunAction, removeRunAction, retryRunAction } from "@/lib/actions/ai"
import { ROOT_LABELS, type RootKey } from "@/lib/media"

export type RunRow = {
  id: string
  root: RootKey
  folder: string
  status: "QUEUED" | "GROUPING" | "ANALYZING" | "DONE" | "FAILED" | "CANCELLED"
  groupCount: number
  analyzedCount: number
  failedCount: number
  toReview: number
  error: string | null
  createdAt: string
  createdBy: string | null
}

const LABEL: Record<RunRow["status"], string> = {
  QUEUED: "Waiting", GROUPING: "Grouping photos", ANALYZING: "Asking the AI", DONE: "Done", FAILED: "Stopped", CANCELLED: "Cancelled",
}

export function RunsTable({ runs }: { runs: RunRow[] }) {
  const router = useRouter()
  if (runs.length === 0) return <p className="text-sm text-muted-foreground">No scans yet.</p>

  async function act(fn: () => Promise<unknown>, done: string) {
    const r = (await fn()) as { error?: string }
    if (r?.error) toast.error(r.error)
    else toast.success(done)
    router.refresh()
  }

  return (
    <div className="rounded-lg border overflow-hidden bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th className="text-left font-medium px-4 py-2.5">Folder</th>
            <th className="text-left font-medium px-4 py-2.5 hidden md:table-cell">Started</th>
            <th className="text-left font-medium px-4 py-2.5">Status</th>
            <th className="text-right font-medium px-4 py-2.5">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {runs.map((r) => {
            const active = r.status === "QUEUED" || r.status === "GROUPING" || r.status === "ANALYZING"
            const pct = r.groupCount ? Math.round(((r.analyzedCount + r.failedCount) / r.groupCount) * 100) : 0
            return (
              <tr key={r.id}>
                <td className="px-4 py-3">
                  <div className="font-medium">{ROOT_LABELS[r.root]}{r.folder ? ` / ${r.folder.split("/").join(" / ")}` : ""}</div>
                  {r.toReview > 0 && <div className="text-xs text-primary">{r.toReview} group{r.toReview === 1 ? "" : "s"} to review</div>}
                </td>
                <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                  {new Date(r.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                  {r.createdBy && <span> · {r.createdBy}</span>}
                </td>
                <td className="px-4 py-3">
                  <div>{LABEL[r.status]}{r.status === "ANALYZING" && r.groupCount > 0 && <> — {r.analyzedCount + r.failedCount} of {r.groupCount}</>}</div>
                  {r.status === "ANALYZING" && <div className="mt-1 h-1.5 w-40 rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} /></div>}
                  {r.status === "DONE" && <div className="text-xs text-muted-foreground">{r.groupCount} group{r.groupCount === 1 ? "" : "s"}{r.failedCount > 0 && `, ${r.failedCount} failed`}</div>}
                  {r.error && <div className="text-xs text-destructive">{r.error}</div>}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1.5">
                    {r.groupCount > 0 && <Link href={`/ai/runs/${r.id}`} className="inline-flex h-7 items-center rounded-lg border px-2.5 text-[0.8rem] font-medium hover:bg-muted">Review</Link>}
                    {active && <Button variant="ghost" size="sm" onClick={() => act(() => cancelRunAction(r.id), "Scan cancelled.")}>Cancel</Button>}
                    {!active && (r.failedCount > 0 || r.status === "CANCELLED" || r.status === "FAILED") && (
                      <Button variant="ghost" size="sm" onClick={() => act(() => retryRunAction(r.id), "Scan queued again.")}>{r.status === "CANCELLED" ? "Resume" : "Retry failed"}</Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => confirm("Remove this scan's saved results? Photos are not touched.") && act(() => removeRunAction(r.id), "Scan removed.")}
                    >
                      Remove
                    </Button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
