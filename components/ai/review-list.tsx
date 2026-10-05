"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CheckCheck, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { acceptAllPlan } from "@/lib/ai/review"
import { resolveGroupsAction } from "@/lib/actions/ai"
import { ReviewGroup, suggestedKeep, type ReviewGroupProps } from "@/components/ai/review-group"

// The groups on one review page. Picks live here rather than in each group so
// "Accept all selections" can settle the whole page at once.

export function ReviewList({ groups, acceptAll }: { groups: ReviewGroupProps[]; acceptAll: boolean }) {
  const router = useRouter()
  // Only groups whose picks were changed are stored; the rest use the AI's suggestion.
  const [picked, setPicked] = useState<Record<string, Set<string>>>({})
  const [bulk, setBulk] = useState<number | null>(null)
  const [refreshing, startRefresh] = useTransition()
  const working = bulk !== null || refreshing

  const keepOf = (g: ReviewGroupProps) => picked[g.id] ?? suggestedKeep(g.photos)
  const toggle = (g: ReviewGroupProps, name: string) =>
    setPicked((prev) => {
      const next = new Set(keepOf(g))
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return { ...prev, [g.id]: next }
    })

  const actionable = groups.filter((g) => g.status === "ANALYZED" && !g.locked)
  const plan = acceptAllPlan(actionable.map((g) => ({ id: g.id, present: g.photos.filter((p) => p.current).map((p) => p.name), keep: [...keepOf(g)] })))
  const root = groups[0]?.root ?? "upload"

  async function acceptAllSelections() {
    setBulk(plan.items.length)
    const r = await resolveGroupsAction(plan.items)
    setBulk(null)
    if ("error" in r) toast.error(r.error)
    else {
      const what = root === "upload" ? `moved ${r.moved} to Dropoff` : `kept ${r.moved}`
      toast.success(`Sorted ${r.groups} group${r.groups === 1 ? "" : "s"}: ${what}, trashed ${r.trashed}.`)
      if (r.failed) toast.error(`${r.failed} group${r.failed === 1 ? "" : "s"} couldn't be sorted; they're still here.`)
      if (plan.skipped) toast.info(`${plan.skipped} group${plan.skipped === 1 ? "" : "s"} with nothing picked were left for you.`)
    }
    setPicked({})
    if (!("error" in r) && r.closed) {
      toast.success("Review finished.")
      startRefresh(() => router.push("/ai"))
      return
    }
    document.querySelector("main")?.scrollTo({ top: 0 })
    startRefresh(() => router.refresh())
  }

  return (
    <>
      <div>
        {groups.map((g) => (
          <ReviewGroup key={g.id} {...g} keep={keepOf(g)} onToggle={(name) => toggle(g, name)} disabled={working} />
        ))}
      </div>
      {acceptAll && plan.items.length > 0 && (
        <div className="flex justify-end">
          <Button disabled={working} onClick={acceptAllSelections}>
            <CheckCheck className="h-4 w-4" /> Accept all selections ({plan.items.length} group{plan.items.length === 1 ? "" : "s"})
          </Button>
        </div>
      )}
      {working && (
        <div role="status" aria-live="polite" className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-[2px]">
          <div className="flex items-center gap-3 rounded-lg border bg-card px-5 py-4 text-sm shadow-lg">
            <Loader2 className="h-5 w-5 animate-spin text-link" />
            {bulk !== null ? `Sorting ${bulk} group${bulk === 1 ? "" : "s"}…` : "Loading the next groups…"}
          </div>
        </div>
      )}
    </>
  )
}
