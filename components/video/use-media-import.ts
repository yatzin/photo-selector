"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { IMPORT_CHUNK_BYTES, importRejection } from "@/lib/video/import"
import type { Asset } from "@/lib/video/project"

// Import: files from the user's computer upload into the project's media
// (app/api/video-projects/[project]/import), two at a time, each in pieces
// with XMLHttpRequest so its progress shows. One file failing never stops the
// others. Each file lands in Project media as soon as it's done (onImported).

export type ImportItem = {
  key: string
  name: string
  /** 0..1 of the bytes sent. */
  progress: number
  state: "queued" | "uploading" | "done" | "failed"
  error?: string
  /** Refused before sending (its type, empty, over 4 GB): sending it again can't help. */
  local?: true
}

const CONCURRENCY = 2

type Job = { item: ImportItem; file: File; xhr: XMLHttpRequest | null; upload: string | null; cancelled: boolean }

let nextKey = 0

/** POSTs one piece; the parsed JSON answer (an `error` field on failure), or null when it was aborted. */
function sendPiece(job: Job, url: string, piece: Blob, onProgress: (sent: number) => void): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    job.xhr = xhr
    xhr.open("POST", url)
    xhr.setRequestHeader("Content-Type", "application/octet-stream")
    xhr.upload.onprogress = (e) => onProgress(e.loaded)
    xhr.onload = () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(xhr.responseText) as Record<string, unknown>
      } catch {
        body = { error: xhr.status === 401 ? "Sign in again to import." : `The server answered ${xhr.status}.` }
      }
      resolve(xhr.status >= 200 && xhr.status < 300 ? body : { error: typeof body.error === "string" ? body.error : `The server answered ${xhr.status}.`, ...body })
    }
    xhr.onerror = () => resolve({ error: "The connection was lost." })
    xhr.onabort = () => resolve(null)
    xhr.send(piece)
  })
}

export function useMediaImport(folder: string, onImported: (id: string, asset: Asset) => void) {
  const [items, setItems] = useState<ImportItem[]>([])
  const [announcement, setAnnouncement] = useState("")
  const jobs = useRef(new Map<string, Job>())
  const running = useRef(0)
  // The batch being announced: how many finished and failed since the queue was last idle.
  const batch = useRef({ done: 0, failed: 0 })
  const onImportedRef = useRef(onImported)
  useEffect(() => {
    onImportedRef.current = onImported
  })

  const update = useCallback((key: string, patch: Partial<ImportItem>) => {
    const job = jobs.current.get(key)
    if (job) job.item = { ...job.item, ...patch }
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)))
  }, [])

  const pump = useCallback(() => {
    const base = `/api/video-projects/${encodeURIComponent(folder)}/import`
    for (const job of jobs.current.values()) {
      if (running.current >= CONCURRENCY) break
      if (job.item.state !== "queued") continue
      running.current++
      update(job.item.key, { state: "uploading", progress: 0, error: undefined })
      void (async () => {
        const { file } = job
        let error: string | null = null
        job.upload = null
        for (let at = 0; at < file.size && !job.cancelled; ) {
          const piece = file.slice(at, Math.min(file.size, at + IMPORT_CHUNK_BYTES))
          const q = new URLSearchParams({ name: file.name, size: String(file.size), offset: String(at), ...(job.upload ? { upload: job.upload } : {}) })
          const r = await sendPiece(job, `${base}?${q}`, piece, (sent) => update(job.item.key, { progress: (at + sent) / file.size }))
          if (!r) break
          if (typeof r.error === "string") {
            error = r.error
            break
          }
          if (typeof r.upload === "string") job.upload = r.upload
          if (r.done === true && typeof r.id === "string" && r.asset) {
            onImportedRef.current(r.id, r.asset as Asset)
            at = file.size
            break
          }
          at = typeof r.received === "number" ? r.received : at + piece.size
        }
        job.xhr = null
        running.current--
        if (job.cancelled) {
          // The server keeps nothing of a cancelled upload.
          if (job.upload) void fetch(`${base}?${new URLSearchParams({ upload: job.upload, name: file.name })}`, { method: "DELETE" }).catch(() => {})
        } else if (error) {
          batch.current.failed++
          update(job.item.key, { state: "failed", error })
        } else {
          batch.current.done++
          update(job.item.key, { state: "done", progress: 1 })
          // A finished file leaves the list after a moment; failures stay until dismissed.
          setTimeout(() => {
            jobs.current.delete(job.item.key)
            setItems((list) => list.filter((i) => i.key !== job.item.key))
          }, 2500)
        }
        finishBatch()
        pump()
      })()
    }
  }, [folder, update])

  /** Says how the batch went once nothing is queued or uploading. */
  function finishBatch() {
    const busy = [...jobs.current.values()].some((j) => j.item.state === "queued" || j.item.state === "uploading")
    if (busy) return
    const { done, failed } = batch.current
    batch.current = { done: 0, failed: 0 }
    if (done + failed === 0) return
    const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`
    setAnnouncement(failed > 0 ? `Imported ${files(done)}, ${failed} failed` : `Imported ${files(done)}`)
  }

  /** Queues files for upload; one Import can't take (its type, empty, over 4 GB) shows its reason straight away. */
  const add = useCallback(
    (files: File[]) => {
      if (files.length === 0) return
      const added: ImportItem[] = []
      for (const file of files) {
        const key = `i${nextKey++}`
        const rejected = importRejection(file.name, file.size)
        const item: ImportItem = { key, name: file.name, progress: 0, state: rejected ? "failed" : "queued", ...(rejected ? { error: rejected, local: true as const } : {}) }
        if (rejected) batch.current.failed++
        jobs.current.set(key, { item, file, xhr: null, upload: null, cancelled: false })
        added.push(item)
      }
      setAnnouncement("")
      setItems((list) => [...list, ...added])
      pump()
      finishBatch()
    },
    [pump]
  )

  /** Stops a queued or uploading file and takes it off the list. */
  const cancel = useCallback((key: string) => {
    const job = jobs.current.get(key)
    if (!job) return
    job.cancelled = true
    job.xhr?.abort()
    jobs.current.delete(key)
    setItems((list) => list.filter((i) => i.key !== key))
  }, [])

  /** Sends a failed file again. */
  const retry = useCallback(
    (key: string) => {
      const job = jobs.current.get(key)
      if (!job || job.item.state !== "failed" || importRejection(job.file.name, job.file.size)) return
      job.cancelled = false
      update(key, { state: "queued", progress: 0, error: undefined })
      pump()
    },
    [pump, update]
  )

  /** Takes a failed file off the list. */
  const dismiss = useCallback((key: string) => {
    jobs.current.delete(key)
    setItems((list) => list.filter((i) => i.key !== key))
  }, [])

  // Leaving the editor stops what's still uploading.
  useEffect(() => {
    const all = jobs.current
    return () => {
      for (const job of all.values()) {
        job.cancelled = true
        job.xhr?.abort()
      }
    }
  }, [])

  return { items, announcement, add, cancel, retry, dismiss }
}

export type MediaImport = ReturnType<typeof useMediaImport>
