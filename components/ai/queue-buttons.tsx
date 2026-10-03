"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ListPlus, ListX, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { clearQueueAction, queueUnscannedAction } from "@/lib/actions/ai"

/** "Scan all unscanned" queues one scan per never-scanned folder; "Clear queue" takes waiting scans back out. */
export function QueueButtons({ unscanned, queued, ready }: { unscanned: number; queued: number; ready: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState<"scan" | "clear" | null>(null)

  async function scanAll() {
    if (!confirm(`Queue ${unscanned} scan${unscanned === 1 ? "" : "s"}, one for each folder that hasn't been scanned yet? They run one at a time.`)) return
    setBusy("scan")
    const r = await queueUnscannedAction()
    setBusy(null)
    if ("error" in r) toast.error(r.error)
    else toast.success(r.queued ? `Queued ${r.queued} scan${r.queued === 1 ? "" : "s"}.` : "Nothing new to scan.")
    router.refresh()
  }

  async function clear() {
    if (!confirm(`Remove ${queued} waiting scan${queued === 1 ? "" : "s"} from the queue? A scan that's already running keeps going.`)) return
    setBusy("clear")
    const r = await clearQueueAction()
    setBusy(null)
    toast.success(`Removed ${r.removed} from the queue.`)
    router.refresh()
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={!ready || unscanned === 0 || busy !== null} onClick={scanAll}>
        {busy === "scan" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListPlus className="h-4 w-4" />} Scan all unscanned ({unscanned})
      </Button>
      <Button size="sm" variant="outline" disabled={queued === 0 || busy !== null} onClick={clear}>
        {busy === "clear" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListX className="h-4 w-4" />} Clear queue ({queued})
      </Button>
    </div>
  )
}
