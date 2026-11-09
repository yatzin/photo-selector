"use client"

import { useRef } from "react"
import { RotateCcw, TriangleAlert, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { TEMP_UPLOAD_ACCEPT, tempUploadRejection } from "@/lib/video/import"
import { useMediaImport } from "./use-media-import"

// Uploading photos and videos from the computer into a Personal Storage folder
// (app/api/temp-upload), several at a time, each with its progress. `pick`
// opens the file picker; `element` is the hidden input and the list of files
// uploading (with Cancel, Retry and Dismiss), to render once near the folder.
// `onUploaded` runs after each file is in.

export function useTempUpload(parent: string[], onUploaded: () => void) {
  const input = useRef<HTMLInputElement>(null)
  const importer = useMediaImport("", () => onUploaded(), { url: "/api/temp-upload", query: { folder: parent.join("/") }, reject: tempUploadRejection })
  const { items, announcement } = importer
  const busy = items.filter((i) => i.state === "queued" || i.state === "uploading").length

  const element = (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={TEMP_UPLOAD_ACCEPT}
        className="hidden"
        data-testid="temp-upload-input"
        onChange={(e) => {
          importer.add(Array.from(e.currentTarget.files ?? []))
          // The same file can be picked again later.
          e.currentTarget.value = ""
        }}
      />
      <span className="sr-only" aria-live="polite">{announcement.replace("Imported", "Uploaded")}</span>
      {items.length > 0 && (
        <ul aria-label="Uploads" className="space-y-0.5 rounded-lg bg-muted/40 p-1.5 text-xs">
          <li aria-hidden className="px-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{busy ? `Uploading ${busy} of ${items.length}` : "Uploads"}</li>
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
                  <Button type="button" size="icon-xs" variant="ghost" onClick={() => importer.retry(item.key)} title="Try again" aria-label={`Try uploading ${item.name} again`}>
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
                <div className={cn("mt-1 h-1 overflow-hidden rounded-full bg-muted", item.state === "uploading" && "shimmer")} role="progressbar" aria-label={`${item.name} upload`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}>
                  <div className="h-full rounded-full bg-editor-accent transition-[width]" style={{ width: `${item.progress * 100}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )

  return { pick: () => input.current?.click(), element, busy: busy > 0 }
}
