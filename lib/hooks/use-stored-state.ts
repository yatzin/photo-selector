"use client"

import { useCallback, useSyncExternalStore } from "react"

// A per-browser preference kept in localStorage (tile size, sort order).
// The server render and first paint use the fallback; the stored value takes
// over on hydration without a setState-in-effect round trip.

const EVENT = "ps-stored-state"

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null // private mode / storage blocked
  }
}

export function useStoredState<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const subscribe = useCallback((onChange: () => void) => {
    const handler = (e: Event) => {
      if (!(e instanceof CustomEvent) || e.detail === key) onChange()
    }
    window.addEventListener("storage", handler)
    window.addEventListener(EVENT, handler)
    return () => {
      window.removeEventListener("storage", handler)
      window.removeEventListener(EVENT, handler)
    }
  }, [key])

  const raw = useSyncExternalStore(subscribe, () => read(key), () => null)
  const value = raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback

  const set = useCallback((next: T) => {
    try {
      window.localStorage.setItem(key, next)
    } catch {
      // not persisted; still fine for this page view
    }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: key }))
  }, [key])

  return [value, set]
}
