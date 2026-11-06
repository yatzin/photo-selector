"use client"

import { useEffect, useRef, useState } from "react"
import { saveProjectAction } from "@/lib/actions/video-projects"
import type { Project } from "@/lib/video/project"

export type SaveState = "saved" | "saving" | "error"

const DELAY_MS = 800

/**
 * Saves the project 800 ms after the last change, one save at a time, and
 * flushes a pending change when the editor closes. The first render (the
 * project as loaded) is not saved.
 */
export function useAutosave(folder: string, project: Project): SaveState {
  const [state, setState] = useState<SaveState>("saved")
  const latest = useRef(project)
  const saved = useRef(project)
  const chain = useRef<Promise<void>>(Promise.resolve())

  function flush() {
    const toSave = latest.current
    if (toSave === saved.current) return
    saved.current = toSave
    setState("saving")
    chain.current = chain.current.then(async () => {
      try {
        const r = await saveProjectAction(folder, toSave)
        if ("error" in r) setState("error")
        else if (latest.current === toSave) setState("saved")
      } catch {
        setState("error")
      }
    })
  }

  useEffect(() => {
    latest.current = project
    if (project === saved.current) return
    const t = setTimeout(flush, DELAY_MS)
    return () => clearTimeout(t)
    // flush only reads refs and `folder`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, folder])

  // Flush a pending change when the editor closes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => flush, [])

  return state
}
