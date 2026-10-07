import "server-only"
import fs from "fs"
import path from "path"
import { rootPath } from "@/lib/library-server"
import { isSkippedDir, mediaKind, ROOT_KEYS, type RootKey } from "@/lib/media"
import { cacheKey, ensureVariant, isCached, sweepCache, type Variant } from "@/lib/thumbs-server"
import { purgeTrash } from "@/lib/file-ops-server"

// Keeps thumbnails ready before anyone opens the page. Scans both library
// roots on start, every SCAN_INTERVAL, and shortly after anything changes in
// Mobile Upload (a phone backup landing). New files are queued at low
// priority, so someone browsing always goes first.
//
// Mobile Upload and User Temp Storage get previews too (that's where photos
// are looked at one by one); Sort Dropoff only thumbnails, with previews made
// when opened.

const SCAN_INTERVAL_MS = 15 * 60_000
const CHANGE_DEBOUNCE_MS = 15_000
const FIRST_SCAN_DELAY_MS = 5_000
// Cache files younger than this survive a sweep even if no scan saw them.
const SWEEP_MIN_AGE_MS = 60 * 60_000

const PREPARE: Record<RootKey, Variant[]> = { upload: ["thumb", "preview"], dropoff: ["thumb"], temp: ["thumb", "preview"] }

export type WorkerStatus = {
  started: boolean
  scanning: boolean
  lastScanAt: number | null
  lastScanMs: number | null
  files: number
  queued: number
  done: number
  failed: number
  watching: boolean
  lastError: string | null
}

type State = WorkerStatus & { rescan: boolean; timer: NodeJS.Timeout | null; debounce: NodeJS.Timeout | null; watcher: fs.FSWatcher | null }

const g = globalThis as unknown as { __psWorker?: State }
const state: State = (g.__psWorker ??= {
  started: false, scanning: false, lastScanAt: null, lastScanMs: null, files: 0, queued: 0, done: 0, failed: 0,
  watching: false, lastError: null, rescan: false, timer: null, debounce: null, watcher: null,
})

export function workerStatus(): WorkerStatus {
  const { rescan: _r, timer: _t, debounce: _d, watcher: _w, ...status } = state
  void _r; void _t; void _d; void _w
  return { ...status }
}

type Found = { root: RootKey; rel: string; file: string; key: string; mtimeMs: number }

async function walk(root: RootKey, dir: string, out: Found[]): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!isSkippedDir(e.name)) await walk(root, p, out)
    } else if (e.isFile() && mediaKind(e.name)) {
      try {
        const st = await fs.promises.stat(p)
        const rel = path.relative(rootPath(root), p).split(path.sep).join("/")
        out.push({ root, rel, file: p, key: cacheKey(root, rel, st), mtimeMs: st.mtimeMs })
      } catch {
        // removed mid-scan
      }
    }
  }
}

export async function scanNow(): Promise<void> {
  if (state.scanning) {
    state.rescan = true
    return
  }
  state.scanning = true
  const started = Date.now()
  try {
    const found: Found[] = []
    const scanned: RootKey[] = []
    for (const root of ROOT_KEYS) {
      try {
        await fs.promises.access(rootPath(root))
      } catch {
        continue // not mounted
      }
      await walk(root, rootPath(root), found)
      scanned.push(root)
      await purgeTrash(root).catch(() => 0)
    }
    state.files = found.length

    // Only sweep when every root was readable; otherwise a missing mount
    // would look like every photo was deleted.
    if (scanned.length === ROOT_KEYS.length) {
      await sweepCache(new Set(found.map((f) => f.key)), SWEEP_MIN_AGE_MS)
    }

    const todo: Found[] = []
    for (const f of found) if (!(await isCached(f.key, PREPARE[f.root]))) todo.push(f)
    // Newest first: today's uploads are the ones about to be sorted.
    todo.sort((a, b) => b.mtimeMs - a.mtimeMs)
    state.lastScanAt = Date.now()
    state.lastScanMs = state.lastScanAt - started
    state.lastError = null

    for (const f of todo) {
      for (const variant of PREPARE[f.root]) {
        state.queued++
        ensureVariant(f.root, f.rel, f.file, variant, "low")
          .then((r) => ("failed" in r ? state.failed++ : state.done++))
          .catch(() => state.failed++)
          .finally(() => state.queued--)
      }
    }
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error)
    console.error("[worker] scan failed:", error)
  } finally {
    state.scanning = false
    if (state.rescan) {
      state.rescan = false
      void scanNow()
    }
  }
}

function scheduleScan() {
  if (state.debounce) clearTimeout(state.debounce)
  state.debounce = setTimeout(() => void scanNow(), CHANGE_DEBOUNCE_MS)
}

function watchUploads() {
  try {
    // Recursive watching uses inotify on Linux (Node 20+). Changes made over
    // SMB happen on the NAS itself, so they're seen too.
    state.watcher = fs.watch(rootPath("upload"), { recursive: true }, (_event, name) => {
      if (name && !String(name).split(/[\\/]/).some(isSkippedDir)) scheduleScan()
    })
    state.watcher.on("error", () => {
      state.watching = false
      state.watcher?.close()
      state.watcher = null
    })
    state.watching = true
  } catch {
    state.watching = false // the periodic scan still runs
  }
}

export function startWorker() {
  if (state.started || process.env.THUMB_WORKER === "off") return
  state.started = true
  setTimeout(() => void scanNow(), FIRST_SCAN_DELAY_MS)
  state.timer = setInterval(() => void scanNow(), SCAN_INTERVAL_MS)
  state.timer.unref()
  watchUploads()
}
