"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Download, FolderOutput, RotateCcw, RotateCw, Trash2, X } from "lucide-react"
import { formatBytes, mediaUrl } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { FileEntry } from "@/lib/library-server"

// Full-screen viewer. The cached thumbnail shows at once and the large
// preview replaces it when loaded; neighbours' previews are fetched ahead so
// arrowing through feels instant. Keys are handled by the parent grid.

type Props = {
  root: string
  folder: string[]
  items: FileEntry[]
  index: number
  canMove: boolean
  canEdit: boolean
  busy: boolean
  onIndex: (i: number) => void
  onClose: () => void
  onMove: (name: string) => void
  onDelete: (name: string) => void
  onRotate: (name: string, direction: "cw" | "ccw") => void
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40 disabled:pointer-events-none"
    >
      {children}
    </button>
  )
}

/**
 * Whether a click on an object-contain image/video landed on the picture
 * itself rather than the letterbox around it.
 */
function onContent(e: React.MouseEvent, el: HTMLElement, naturalW: number, naturalH: number): boolean {
  const box = el.getBoundingClientRect()
  if (!naturalW || !naturalH) return true
  const scale = Math.min(box.width / naturalW, box.height / naturalH)
  const w = naturalW * scale
  const h = naturalH * scale
  const left = box.left + (box.width - w) / 2
  const top = box.top + (box.height - h) / 2
  return e.clientX >= left && e.clientX <= left + w && e.clientY >= top && e.clientY <= top + h
}

function Picture({ root, folder, item, onBackdrop }: { root: string; folder: string[]; item: FileEntry; onBackdrop: () => void }) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const preview = mediaUrl(root, folder, item.name, "preview", item.version)
  return (
    <div
      // Shimmer over the blurred thumbnail until the full-size preview arrives.
      className={cn("relative h-full w-full", loadedSrc !== preview && "shimmer")}
      onClick={(e) => {
        const img = e.currentTarget.querySelector("img")
        if (img && !onContent(e, img, img.naturalWidth, img.naturalHeight)) onBackdrop()
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- served from our own cache, already sized */}
      <img
        src={mediaUrl(root, folder, item.name, "thumb", item.version)}
        alt=""
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-contain blur-[2px]"
        style={{ opacity: loadedSrc === preview ? 0 : 1 }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={preview}
        alt={item.name}
        onLoad={() => setLoadedSrc(preview)}
        className="absolute inset-0 h-full w-full object-contain"
        style={{ opacity: loadedSrc === preview ? 1 : 0 }}
      />
    </div>
  )
}

export function Lightbox({ root, folder, items, index, canMove, canEdit, busy, onIndex, onClose, onMove, onDelete, onRotate }: Props) {
  const item = items[index]
  const touchX = useRef<number | null>(null)

  // Warm the browser cache with the previews either side.
  useEffect(() => {
    for (const i of [index + 1, index - 1, index + 2]) {
      const n = items[i]
      if (n && n.kind === "image") new Image().src = mediaUrl(root, folder, n.name, "preview", n.version)
    }
  }, [index, items, root, folder])

  if (!item) return null
  const hasPrev = index > 0
  const hasNext = index < items.length - 1

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      className="fixed inset-0 z-50 flex flex-col bg-black/95 text-white"
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current === null) return
        const dx = e.changedTouches[0].clientX - touchX.current
        touchX.current = null
        if (dx > 60 && hasPrev) onIndex(index - 1)
        if (dx < -60 && hasNext) onIndex(index + 1)
      }}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{item.name}</div>
          <div className="text-xs text-white/60 tabular-nums">
            {index + 1} of {items.length} &middot; {formatBytes(item.size)} &middot;{" "}
            {new Date(item.modified).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          </div>
        </div>
        {item.kind === "image" && canEdit && (
          <>
            <IconButton label="Rotate left (Shift+R)" onClick={() => onRotate(item.name, "ccw")} disabled={busy}><RotateCcw className="h-4 w-4" /></IconButton>
            <IconButton label="Rotate right (R)" onClick={() => onRotate(item.name, "cw")} disabled={busy}><RotateCw className="h-4 w-4" /></IconButton>
          </>
        )}
        {canMove && (
          <IconButton label="Move to Sort Dropoff (M)" onClick={() => onMove(item.name)} disabled={busy}><FolderOutput className="h-4 w-4" /></IconButton>
        )}
        {canEdit && (
          <IconButton label="Delete (Del)" onClick={() => onDelete(item.name)} disabled={busy}><Trash2 className="h-4 w-4" /></IconButton>
        )}
        <a
          href={mediaUrl(root, folder, item.name, "original", item.version)}
          download={item.name}
          title="Download original"
          aria-label="Download original"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/10 hover:text-white"
        >
          <Download className="h-4 w-4" />
        </a>
        <IconButton label="Close (Esc)" onClick={onClose}><X className="h-5 w-5" /></IconButton>
      </div>

      <div
        className="relative min-h-0 flex-1 px-2 pb-2 sm:px-14"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        {item.kind === "video" ? (
          <video
            key={item.name + item.version}
            src={mediaUrl(root, folder, item.name, "original", item.version)}
            poster={mediaUrl(root, folder, item.name, "preview", item.version)}
            controls
            autoPlay
            playsInline
            onClick={(e) => {
              const v = e.currentTarget
              if (!onContent(e, v, v.videoWidth, v.videoHeight)) {
                e.preventDefault()
                onClose()
              }
            }}
            className="h-full w-full object-contain"
          />
        ) : (
          <Picture key={item.name + item.version} root={root} folder={folder} item={item} onBackdrop={onClose} />
        )}
        {hasPrev && (
          <button
            type="button"
            onClick={() => onIndex(index - 1)}
            aria-label="Previous (←)"
            className="absolute left-1 top-1/2 hidden -translate-y-1/2 rounded-full p-2 text-white/70 hover:bg-white/10 hover:text-white sm:block"
          >
            <ChevronLeft className="h-7 w-7" />
          </button>
        )}
        {hasNext && (
          <button
            type="button"
            onClick={() => onIndex(index + 1)}
            aria-label="Next (→)"
            className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded-full p-2 text-white/70 hover:bg-white/10 hover:text-white sm:block"
          >
            <ChevronRight className="h-7 w-7" />
          </button>
        )}
      </div>
    </div>
  )
}
