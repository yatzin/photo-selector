"use client"

import { useEffect, useState } from "react"
import { saveProjectAction } from "@/lib/actions/video-projects"
import type { Project } from "@/lib/video/project"
import { createSaveQueue, type SaveState } from "@/lib/video/save-queue"

export type { SaveState }

/**
 * Saves the project 800 ms after the last change, one save at a time, and
 * flushes a pending change when the editor closes. The first render (the
 * project as loaded) is not saved. `flush` saves any pending change now and
 * resolves true only when the latest project is stored.
 */
export function useAutosave(folder: string, project: Project): { state: SaveState; flush: () => Promise<boolean> } {
  const [state, setState] = useState<SaveState>("saved")
  const [queue] = useState(() =>
    createSaveQueue(
      async (p) => {
        const r = await saveProjectAction(folder, p)
        return !("error" in r)
      },
      project,
      setState
    )
  )

  useEffect(() => {
    queue.update(project)
  }, [queue, project])

  // Flush a pending change when the editor closes.
  useEffect(() => () => queue.close(), [queue])

  return { state, flush: queue.flush }
}
