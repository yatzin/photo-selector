"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

/** Re-renders the page from the server every few seconds while something is running (paused while the tab is hidden). */
export function AutoRefresh({ active, intervalMs = 3000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter()
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => {
      if (!document.hidden) router.refresh()
    }, intervalMs)
    return () => clearInterval(t)
  }, [active, intervalMs, router])
  return null
}
