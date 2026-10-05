"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { startRunAction } from "@/lib/actions/ai"
import { ROOT_LABELS, type RootKey } from "@/lib/media"
import { minScanImages, type ScanKind } from "@/lib/ai/review"

type Folder = { root: RootKey; folder: string; imageCount: number; includeDays: boolean }

export function NewScanForm({ kind, folders, ready, isAdmin }: { kind: ScanKind; folders: Folder[]; ready: boolean; isAdmin: boolean }) {
  const router = useRouter()
  const options = folders.filter((f) => f.imageCount >= minScanImages(kind))
  const [value, setValue] = useState(options[0] ? `${options[0].root}|${options[0].folder}` : "")
  const [fresh, setFresh] = useState(false)
  const [busy, setBusy] = useState(false)

  async function run() {
    const [root, ...rest] = value.split("|")
    setBusy(true)
    const r = await startRunAction({ root, folder: rest.join("|"), fresh, kind })
    setBusy(false)
    if ("error" in r) toast.error(r.error)
    else {
      toast.success("Scan started. You can leave this page.")
      setFresh(false)
      router.refresh()
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <h2 className="font-semibold">{kind === "screenshots" ? "Find screenshots" : kind === "quality" ? "Check photo quality" : "Find similar"}</h2>
      {!ready && (
        <p className="text-sm text-muted-foreground">
          AI isn&apos;t set up yet.{" "}
          {isAdmin ? <Link href="/settings?tab=ai" className="text-link underline-offset-2 hover:underline">Open Settings → AI</Link> : "Ask an admin to set it up."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Folder to scan"
          className="h-8 min-w-64 max-w-full rounded-lg border border-input bg-background text-foreground px-2 text-sm"
        >
          {options.map((f) => (
            <option key={`${f.root}|${f.folder}`} value={`${f.root}|${f.folder}`}>
              {ROOT_LABELS[f.root]}{f.folder ? ` / ${f.folder.split("/").join(" / ")}` : ""}{f.includeDays ? " — all days" : ""} ({f.imageCount})
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} /> Start fresh
        </label>
        <Button onClick={run} disabled={!ready || !value || busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Run
        </Button>
      </div>
      {kind === "quality" ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            Finds technically bad photos — motion blur, out of focus, closed eyes, far too dark or bright, pocket and
            other accidental shots, a finger over the lens — so you can delete them. Every photo goes to the AI, a few at a time.
          </p>
          <p>
            Scans one folder, not its subfolders; a year/month folder of day folders (&ldquo;all days&rdquo;) scans every
            day in it. The folder stays unlocked while it runs. Photos already checked are skipped unless you start fresh.
          </p>
        </div>
      ) : kind === "screenshots" ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            Finds screenshots and saved images (memes, downloads, forwarded pictures) so you can delete them or move
            them to Sort Dropoff. Photos with camera details and HEIC files are skipped; the rest go to the AI a few at a time.
          </p>
          <p>
            Scans one folder, not its subfolders; a year/month folder of day folders (&ldquo;all days&rdquo;) scans every
            day in it. The folder stays unlocked while it runs. Images already checked are skipped unless you start fresh.
          </p>
        </div>
      ) : (
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          Finds bursts of near-identical shots — photos taken moments apart that look alike — and has
          the AI rank each burst so you can keep the best and trash the rest. Photos with nothing similar are left alone.
        </p>
        <p>
          Scans one folder, not its subfolders; a year/month folder of day folders (&ldquo;all days&rdquo;) scans every
          day in it. The folder is locked while the scan runs. Photos you&apos;ve already reviewed are skipped unless you
          start fresh.
        </p>
      </div>
      )}
    </div>
  )
}
