import { CircleCheck, CircleX } from "lucide-react"
import { ROOT_LABELS, TRASH_DIR, TRASH_RETENTION_DAYS } from "@/lib/media"
import type { RootStatus } from "@/lib/library-server"
import type { WorkerStatus } from "@/lib/worker-server"
import { rescanAction } from "@/lib/actions/worker"
import { Button } from "@/components/ui/button"

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={ok ? "inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400" : "inline-flex items-center gap-1 text-destructive"}>
      {ok ? <CircleCheck className="h-4 w-4" /> : <CircleX className="h-4 w-4" />}
      {label}
    </span>
  )
}

export function StorageStatus({ roots, worker }: { roots: RootStatus[]; worker: WorkerStatus }) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Storage</h2>
      <div className="rounded-lg border overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">Folder</th>
              <th className="text-left font-medium px-4 py-2.5">Path in container</th>
              <th className="text-left font-medium px-4 py-2.5">Access</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {roots.map((r) => (
              <tr key={r.key}>
                <td className="px-4 py-3 font-medium">{ROOT_LABELS[r.key]}</td>
                <td className="px-4 py-3 font-mono text-xs break-all">{r.path}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-3">
                    <Check ok={r.readable} label="Read" />
                    <Check ok={r.writable} label="Write" />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted-foreground">
        Paths come from the volume mappings in docker-compose.yml, or from <code className="font-mono">PHOTOS_UPLOAD_DIR</code> and{" "}
        <code className="font-mono">PHOTOS_DROPOFF_DIR</code>. Both need write access: sorting moves files out of
        Mobile Upload and into Sort Dropoff.
      </p>

      <h2 className="pt-4 text-lg font-semibold">Thumbnails</h2>
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Background worker</dt>
          <dd>{!worker.started ? "Off" : worker.scanning ? "Scanning…" : worker.queued > 0 ? `Working — ${worker.queued.toLocaleString()} to go` : "Idle"}</dd>
          <dt className="text-muted-foreground">Photos and videos</dt>
          <dd className="tabular-nums">{worker.files.toLocaleString()}</dd>
          <dt className="text-muted-foreground">Made since start</dt>
          <dd className="tabular-nums">
            {worker.done.toLocaleString()}
            {worker.failed > 0 && <span className="text-destructive"> &middot; {worker.failed.toLocaleString()} unreadable</span>}
          </dd>
          <dt className="text-muted-foreground">Last scan</dt>
          <dd>
            {worker.lastScanAt ? `${new Date(worker.lastScanAt).toLocaleString("en-US")} (${((worker.lastScanMs ?? 0) / 1000).toFixed(1)}s)` : "Not yet"}
          </dd>
          <dt className="text-muted-foreground">Watching for uploads</dt>
          <dd>{worker.watching ? "Yes" : "No — new files are found by the scan every 15 minutes"}</dd>
          {worker.lastError && (
            <>
              <dt className="text-muted-foreground">Last error</dt>
              <dd className="text-destructive">{worker.lastError}</dd>
            </>
          )}
        </dl>
        <form action={rescanAction}>
          <Button type="submit" variant="outline" size="sm">Scan now</Button>
        </form>
      </div>
      <p className="text-sm text-muted-foreground">
        Deleted items go to a hidden <code className="font-mono">{TRASH_DIR}</code> folder in the same share and are
        removed for good after {TRASH_RETENTION_DAYS} days.
      </p>
    </div>
  )
}
