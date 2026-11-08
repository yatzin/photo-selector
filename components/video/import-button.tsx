"use client"

import { useRef } from "react"
import { Loader2, RotateCcw, TriangleAlert, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IMPORT_ACCEPT } from "@/lib/video/import"
import type { MediaImport } from "./use-media-import"

// The editor bar's Import button: the system file picker for videos, images
// and sound files (several at once), and under it the files uploading, each
// with its progress and a cancel button, or why it failed with Retry and
// Dismiss. The outcome of a batch is announced to screen readers. The label
// folds to the icon on narrow screens.

export function ImportButton({ importer }: { importer: MediaImport }) {
  const input = useRef<HTMLInputElement>(null)
  const { items, announcement } = importer
  const busy = items.some((i) => i.state === "queued" || i.state === "uploading")
  return (
    <div className="relative shrink-0">
      <Button type="button" size="sm" variant="outline" onClick={() => input.current?.click()} title="Import media from your computer" aria-label="Import media">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        <span className="hidden sm:inline">Import</span>
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        accept={IMPORT_ACCEPT}
        className="hidden"
        data-testid="import-input"
        onChange={(e) => {
          importer.add(Array.from(e.currentTarget.files ?? []))
          // The same file can be picked again later.
          e.currentTarget.value = ""
        }}
      />
      <span className="sr-only" aria-live="polite">{announcement}</span>
      {items.length > 0 && (
        <ul
          aria-label="Imports"
          className="absolute left-0 top-full z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] space-y-1 rounded-lg border bg-popover p-2 text-xs text-popover-foreground shadow-lg"
        >
          {items.map((item) => (
            <li key={item.key} className="rounded-md px-1.5 py-1">
              <div className="flex items-center gap-2">
                {item.state === "failed" && <TriangleAlert aria-hidden className="h-3.5 w-3.5 shrink-0 text-destructive" />}
                <span className="min-w-0 flex-1 truncate" title={item.name}>{item.name}</span>
                {item.state !== "failed" && (
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {item.state === "queued" ? "Waiting" : item.state === "done" ? "Done" : `${Math.round(item.progress * 100)}%`}
                  </span>
                )}
                {item.state === "failed" && !item.local && (
                  <Button type="button" size="icon-xs" variant="ghost" onClick={() => importer.retry(item.key)} title="Try again" aria-label={`Try importing ${item.name} again`}>
                    <RotateCcw className="h-3 w-3" />
                  </Button>
                )}
                {item.state !== "done" && (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => (item.state === "failed" ? importer.dismiss(item.key) : importer.cancel(item.key))}
                    title={item.state === "failed" ? "Dismiss" : "Cancel"}
                    aria-label={`${item.state === "failed" ? "Dismiss" : "Cancel"} ${item.name}`}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
              {item.state === "failed" ? (
                <p className="mt-0.5 break-words text-destructive">{item.error}</p>
              ) : (
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${item.name} upload`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}>
                  <div className="h-full rounded-full bg-editor-accent transition-[width]" style={{ width: `${item.progress * 100}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
