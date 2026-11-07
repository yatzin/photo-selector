"use client"

import { useEffect, useState } from "react"
import { saveProjectAction } from "@/lib/actions/video-projects"
import type { Project } from "@/lib/video/project"
import { createSaveQueue, type SaveState } from "@/lib/video/save-queue"

export type { SaveState }

const SLOW_SAVE = 400 // ms before a running save shows as "saving"

/** The server keeps its own assets, name and settings and takes only the clips (see mergeClientProject). */
const sameClips = (a: Project, b: Project) => a.clips === b.clips

/**
 * Saves the project after 1.5 s without changes (at least every 5 s during a
 * long burst), one save at a time, and flushes a pending change when the
 * editor closes. The first render (the project as loaded) is not saved, and
 * neither is a change back to the clips last sent. `flush` saves any pending
 * change now and resolves true only when the latest project is stored;
 * `isDirty` is true while a change isn't stored yet. `state` only turns to
 * "saving" once a save has taken 400 ms, so quick saves don't flicker.
 */
export function useAutosave(folder: string, project: Project): { state: SaveState; flush: () => Promise<boolean>; isDirty: () => boolean } {
  const [state, setState] = useState<SaveState>("saved")
  const [queue] = useState(() => {
    let slow: ReturnType<typeof setTimeout> | null = null
    const q = createSaveQueue(
      async (p) => {
        const r = await saveProjectAction(folder, p)
        return !("error" in r)
      },
      project,
      (s) => {
        if (slow) clearTimeout(slow)
        slow = null
        if (s === "saving") slow = setTimeout(() => setState("saving"), SLOW_SAVE)
        else setState(s)
      },
      undefined,
      undefined,
      sameClips
    )
    return {
      ...q,
      close() {
        q.close()
        if (slow) clearTimeout(slow)
      },
    }
  })

  useEffect(() => {
    queue.update(project)
  }, [queue, project])

  // Flush a pending change when the editor closes.
  useEffect(() => () => queue.close(), [queue])

  return { state, flush: queue.flush, isDirty: queue.isDirty }
}
