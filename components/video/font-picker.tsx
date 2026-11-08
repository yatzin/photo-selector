"use client"

import { useEffect, useRef, useState } from "react"
import { fontById, fontFamily, FONT_MOODS, fontsForMood } from "@/lib/video/fonts"
import { cn } from "@/lib/utils"
import { TileGrid } from "./ui/tile-grid"

// Edit text's font chooser: the 50 fonts as tiles grouped by mood (sticky
// mood headers, chips that jump to a mood, a search over names, moods and
// styles), each font's name drawn in it with its style under it. It's the
// dialogs' shared TileGrid, so the arrow keys move by row and column, Home
// and End go to the ends, PageUp and PageDown between moods, and typing a
// name's first letters jumps to it. A font's file is fetched only when its
// tile scrolls into view; until then, and while it loads, the name shows in
// the app's font in a line of the same height, so nothing jumps. The chosen
// font is scrolled into view on open.

/** CSS families already loaded (or failed: their name then shows in a fallback), kept while the page is open. */
const loaded = new Set<string>()

const GROUPS = FONT_MOODS.map((m) => ({ name: m, items: fontsForMood(m).map((f) => f.id) }))

export function FontPicker({ font, onChange }: { font: string; onChange: (font: string) => void }) {
  const [ready, setReady] = useState<ReadonlySet<string>>(() => new Set(loaded))
  const scroll = useRef<HTMLDivElement>(null)
  const observer = useRef<IntersectionObserver | null>(null)
  const watched = useRef(new WeakSet<Element>())

  // Load each tile's font as it comes into view; tiles a search brings back are watched as they mount.
  useEffect(() => {
    const root = scroll.current
    if (!root) return
    if (!observer.current) {
      observer.current = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue
            observer.current?.unobserve(e.target)
            const family = (e.target as HTMLElement).dataset.family!
            if (loaded.has(family)) continue
            const done = () => {
              loaded.add(family)
              setReady((r) => new Set(r).add(family))
            }
            document.fonts.load(`16px "${family}"`).then(done, done)
          }
        },
        { root, rootMargin: "64px 0px" }
      )
    }
    for (const el of root.querySelectorAll<HTMLElement>("[data-family]")) {
      if (watched.current.has(el) || loaded.has(el.dataset.family!)) continue
      watched.current.add(el)
      observer.current.observe(el)
    }
  })
  useEffect(() => () => observer.current?.disconnect(), [])

  // The chosen font in view on open (the list scrolled, not the page).
  useEffect(() => {
    const root = scroll.current
    const el = root?.querySelector<HTMLElement>(`[data-tile="${CSS.escape(font)}"]`)
    if (root && el) root.scrollTop = el.offsetTop - (root.clientHeight - el.offsetHeight) / 2
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <TileGrid
      label="Font"
      groups={GROUPS}
      value={font}
      onChange={(id) => id !== "none" && onChange(id)}
      nameOf={(id) => fontById(id).name}
      keywordsOf={(id) => `${fontById(id).style} ${fontById(id).mood}`}
      describe={(id) => fontById(id).style}
      glyphBox={false}
      minTile="9.5rem"
      searchLabel="Search fonts"
      jumpChips
      searchable
      maxHeight="min(17rem, 40dvh)"
      scrollRef={scroll}
      tileData={(id) => ({ "data-family": fontFamily(fontById(id)) })}
      glyph={(id) => {
        const f = fontById(id)
        const family = fontFamily(f)
        const has = ready.has(family)
        return (
          <span className="grid min-w-0 gap-0.5">
            <span className={cn("block h-7 truncate text-[17px] leading-7", has ? "text-foreground" : "text-muted-foreground")} style={has ? { fontFamily: `"${family}"` } : undefined}>
              {f.name}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">{f.style}</span>
          </span>
        )
      }}
    />
  )
}
