"use client"

import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { fontFamily, FONT_MOODS, fontsForMood, typeAhead, type FontMood, type TextFont } from "@/lib/video/fonts"
import { cn } from "@/lib/utils"

// Edit text's font list: a row of mood chips (All or one mood) over a
// scrolling radiogroup, each font's name drawn in it with its style. A font's
// file is fetched only when its option scrolls into view (an
// IntersectionObserver on the list); until then, and while it loads, the name
// shows in the app's own font in a line of the same height, so nothing jumps.
// Arrow keys move through the fonts shown, Home and End go to the first and
// last, and typing a name's first letters jumps to it. The chosen font is
// scrolled into view on open.

/** CSS families already loaded (or failed: their name then shows in a fallback), kept while the page is open. */
const loaded = new Set<string>()

const TYPE_AHEAD_MS = 700

export function FontPicker({ font, labelledBy, onChange }: { font: string; labelledBy: string; onChange: (font: string) => void }) {
  const [mood, setMood] = useState<FontMood | "All">("All")
  const [ready, setReady] = useState<ReadonlySet<string>>(() => new Set(loaded))
  const list = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const typed = useRef({ text: "", at: 0 })
  const opened = useRef(font)
  const shown = fontsForMood(mood)
  const focusable = shown.some((f) => f.id === font) ? font : shown[0]?.id

  // Load each option's font as it comes into view.
  useEffect(() => {
    const root = list.current
    if (!root) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          observer.unobserve(e.target)
          const family = (e.target as HTMLElement).dataset.family!
          if (loaded.has(family)) continue
          const done = () => {
            loaded.add(family)
            setReady((r) => new Set(r).add(family))
          }
          document.fonts.load(`16px "${family}"`).then(done, done)
        }
      },
      { root, rootMargin: "48px 0px" }
    )
    for (const el of buttons.current.values()) if (!loaded.has(el.dataset.family!)) observer.observe(el)
    return () => observer.disconnect()
  }, [mood])

  // The chosen font in view on open (the list scrolled, not the page).
  useEffect(() => {
    const root = list.current
    const el = buttons.current.get(opened.current)
    if (root && el) root.scrollTop = el.offsetTop - root.offsetTop - (root.clientHeight - el.offsetHeight) / 2
  }, [])

  const choose = (f: TextFont) => {
    onChange(f.id)
    const el = buttons.current.get(f.id)
    el?.focus()
    el?.scrollIntoView({ block: "nearest" })
  }

  function onKeyDown(e: KeyboardEvent, i: number) {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]
    let to = e.key === "Home" ? 0 : e.key === "End" ? shown.length - 1 : step ? (i + step + shown.length) % shown.length : -1
    if (to < 0 && e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-ahead: letters typed in quick succession make a prefix.
      const text = (e.timeStamp - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : "") + e.key
      typed.current = { text, at: e.timeStamp }
      to = typeAhead(shown, i, text)
    }
    if (to < 0) return
    e.preventDefault()
    choose(shown[to])
  }

  return (
    <div className="grid gap-1.5">
      <div role="group" aria-label="Font moods" className="flex flex-wrap gap-1">
        {(["All", ...FONT_MOODS] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mood === m}
            onClick={() => {
              setMood(m)
              if (list.current) list.current.scrollTop = 0
            }}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
              mood === m ? "border-primary bg-primary text-primary-foreground" : "border-input text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {m}
          </button>
        ))}
      </div>
      <div
        ref={list}
        role="radiogroup"
        aria-labelledby={labelledBy}
        className="grid max-h-56 grid-cols-2 content-start gap-1.5 overflow-y-auto rounded-lg border border-input p-1.5"
      >
        {shown.map((f, i) => {
          const on = f.id === font
          const family = fontFamily(f)
          const has = ready.has(family)
          return (
            <button
              key={f.id}
              ref={(el) => {
                if (el) buttons.current.set(f.id, el)
                else buttons.current.delete(f.id)
              }}
              data-family={family}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${f.name}, ${f.style}`}
              tabIndex={f.id === focusable ? 0 : -1}
              onClick={() => onChange(f.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                "flex min-w-0 flex-col items-start gap-0.5 rounded-md border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted"
              )}
            >
              <span
                className={cn("block h-7 w-full truncate text-base leading-7", has ? "text-foreground" : "text-muted-foreground")}
                style={has ? { fontFamily: `"${family}"` } : undefined}
              >
                {f.name}
              </span>
              <span className="text-xs text-muted-foreground">{f.style}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
