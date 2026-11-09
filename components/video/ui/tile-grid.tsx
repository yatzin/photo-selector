"use client"

import { useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { Ban, Check, Search, X } from "lucide-react"
import { gridMove, isGridKey, matchesQuery } from "@/lib/video/dialog-ui"
import { typeAhead } from "@/lib/video/fonts"
import { cn } from "@/lib/utils"

// TileGrid: the editor dialogs' chooser. Tiles in named groups (a sticky
// header over each), each with a picture of what it does and its name, a
// check and an accent ring on the chosen one, and None as a first-class tile
// when there is one. Long lists get a search field and chips that jump to a
// group. One tab stop: the arrow keys move through the grid as laid out
// (Up and Down by row, in the same column), Home and End go to the ends,
// PageUp and PageDown between groups, and typing a name's first letters jumps
// to it. Single choice is a radiogroup (moving picks, as radios do); several
// choices are toggle buttons (Space or Enter toggles).

export type TileGroup<T extends string> = { name: string; items: readonly T[] }

type Common<T extends string> = {
  label: string
  groups: TileGroup<T>[]
  nameOf: (item: T) => string
  /** The tile's picture (a live sample or a glyph). */
  glyph: (item: T) => ReactNode
  /** False: the glyph is the whole tile body (no 16:9 box, no name line). */
  glyphBox?: boolean
  /** More words the search matches. */
  keywordsOf?: (item: T) => string
  /** A small mark at the tile's top left (e.g. export only). */
  badge?: (item: T) => ReactNode
  /** Extra text read with the tile's name. */
  describe?: (item: T) => string | undefined
  /** The narrowest a tile gets (CSS length); as many columns as fit. */
  minTile?: string
  /** A search field (default: more than 12 items). */
  searchable?: boolean
  searchLabel?: string
  /** Jump chips over the grid (default: more than two groups). */
  jumpChips?: boolean
  /** From 640 px wide the grid scrolls inside this height (CSS length); none: it grows. */
  maxHeight?: string
  onFocusItem?: (item: T) => void
  /** data-* attributes per tile (e.g. data-fx, data-family). */
  tileData?: (item: T) => Record<string, string>
  scrollRef?: RefObject<HTMLDivElement | null>
  className?: string
  /** The dialog's first focus: the chosen tile (or the first). */
  initialFocus?: boolean
}

type Single<T extends string> = Common<T> & {
  mode?: "single"
  value: T | "none"
  onChange: (item: T | "none") => void
  /** A None tile first (value "none"). */
  none?: { label: string; glyph?: ReactNode } | false
}

type Multi<T extends string> = Common<T> & {
  mode: "multi"
  isOn: (item: T) => boolean
  onToggle: (item: T) => void
}

export function TileGrid<T extends string>(props: Single<T> | Multi<T>) {
  const { label, groups, nameOf, glyph, glyphBox = true, keywordsOf, badge, describe, minTile = "5.5rem", searchLabel, maxHeight, onFocusItem, tileData, className, initialFocus } = props
  const multi = props.mode === "multi"
  const none = !multi && props.none ? props.none : null
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  const searchable = props.searchable ?? total > 12
  const jumpChips = (props.jumpChips ?? groups.length > 2) && groups.length > 1
  const [query, setQuery] = useState("")
  const ownScroll = useRef<HTMLDivElement>(null)
  const scroll = props.scrollRef ?? ownScroll
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const typed = useRef({ text: "", at: 0 })
  const uid = useId()

  const shown = groups
    .map((g) => ({ name: g.name, items: g.items.filter((i) => matchesQuery(`${nameOf(i)} ${g.name} ${keywordsOf?.(i) ?? ""}`, query)) }))
    .filter((g) => g.items.length > 0)
  const withNone = none !== null && query.trim() === ""
  const flat: (T | "none")[] = [...(withNone ? (["none"] as const) : []), ...shown.flatMap((g) => g.items)]
  // None sits first in the first group's row.
  const sizes = shown.map((g, i) => g.items.length + (withNone && i === 0 ? 1 : 0))
  const on = (item: T | "none") => (multi ? item !== "none" && props.isOn(item) : props.value === item)
  const tabStop = flat.find((i) => on(i)) ?? flat[0]

  const columns = () => {
    const grid = scroll.current?.querySelector<HTMLElement>("[data-tile-row]")
    return grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length : 1
  }

  const focusItem = (item: T | "none") => {
    const el = buttons.current.get(item)
    el?.focus()
    el?.scrollIntoView({ block: "nearest" })
  }

  function onKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let to: number | null = null
    if (isGridKey(e.key)) to = gridMove(sizes, columns(), index, e.key)
    else if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const text = (e.timeStamp - typed.current.at < 700 ? typed.current.text : "") + e.key
      typed.current = { text, at: e.timeStamp }
      const k = typeAhead(flat.map((i) => ({ name: i === "none" ? (none?.label ?? "None") : nameOf(i) })), index, text)
      to = k < 0 ? null : k
    }
    if (to === null) return
    e.preventDefault()
    const item = flat[to]
    if (!multi) props.onChange(item)
    focusItem(item)
  }

  const jump = (name: string) => {
    const root = scroll.current
    const head = root?.querySelector<HTMLElement>(`[data-tile-group="${CSS.escape(name)}"]`)
    if (!root || !head) return
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
    // The grid's own box when it scrolls, else the dialog's body.
    if (root.scrollHeight > root.clientHeight + 1) root.scrollTo({ top: head.offsetTop, behavior })
    else head.scrollIntoView({ block: "start", behavior })
  }

  const tile = (item: T | "none", index: number) => {
    const isOn = on(item)
    const name = item === "none" ? (none?.label ?? "None") : nameOf(item)
    const extra = item === "none" ? undefined : describe?.(item)
    return (
      <button
        key={item}
        ref={(el) => {
          if (el) buttons.current.set(item, el)
          else buttons.current.delete(item)
        }}
        type="button"
        role={multi ? undefined : "radio"}
        aria-checked={multi ? undefined : isOn}
        aria-pressed={multi ? isOn : undefined}
        aria-label={extra ? `${name}, ${extra}` : name}
        tabIndex={item === tabStop ? 0 : -1}
        data-on={isOn || undefined}
        data-tile={item}
        data-initial-focus={initialFocus && item === tabStop ? true : undefined}
        {...(item === "none" ? {} : tileData?.(item))}
        onClick={() => (multi ? item !== "none" && props.onToggle(item) : props.onChange(item))}
        onFocus={() => item !== "none" && onFocusItem?.(item)}
        onMouseEnter={() => item !== "none" && onFocusItem?.(item)}
        onKeyDown={(e) => onKey(e, index)}
        className={cn(
          "tile group/tile relative flex min-w-0 scroll-mt-9 flex-col gap-1.5 rounded-xl p-1.5 text-left ring-1 ring-border outline-none touch-manipulation",
          "bg-card hover:bg-muted/60 hover:ring-foreground/25 dark:bg-white/[0.03] dark:hover:bg-white/[0.07]",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          "data-on:bg-editor-accent/10 data-on:ring-2 data-on:ring-editor-accent dark:data-on:bg-editor-accent/12",
          "forced-colors:data-on:outline-3 forced-colors:data-on:outline-[Highlight]",
          !glyphBox && "px-2.5 py-2"
        )}
      >
        {glyphBox ? (
          <>
            <span aria-hidden className="relative block aspect-video w-full overflow-hidden rounded-lg">
              {item === "none" ? (
                none?.glyph ?? <span className="flex size-full items-center justify-center bg-muted text-muted-foreground"><Ban className="size-4" /></span>
              ) : (
                glyph(item)
              )}
            </span>
            <span className="line-clamp-2 min-h-8 px-0.5 text-[12px] leading-4 font-medium">{name}</span>
          </>
        ) : item === "none" ? (
          <span className="text-sm font-medium">{name}</span>
        ) : (
          glyph(item)
        )}
        {item !== "none" && badge?.(item)}
        <span
          aria-hidden
          className={cn(
            "absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-editor-accent text-editor-accent-foreground shadow-sm ring-2 ring-popover",
            "scale-50 opacity-0 motion-safe:transition-[opacity,scale] motion-safe:duration-150 group-data-on/tile:scale-100 group-data-on/tile:opacity-100"
          )}
        >
          <Check className="size-3" strokeWidth={3} />
        </span>
      </button>
    )
  }

  const gridStyle = { gridTemplateColumns: `repeat(auto-fill, minmax(min(${minTile}, 100%), 1fr))` }
  let index = withNone ? 1 : 0
  const count = flat.length - (withNone ? 1 : 0)

  return (
    <div className={cn("grid min-w-0 gap-2.5", className)}>
      {(searchable || jumpChips) && (
        <div className="grid gap-2">
          {searchable && (
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                role="searchbox"
                name="search"
                aria-label={searchLabel ?? `Search ${label.toLowerCase()}`}
                aria-controls={`${uid}-grid`}
                placeholder={searchLabel ? `${searchLabel}…` : "Search…"}
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && query) {
                    e.preventDefault()
                    e.stopPropagation()
                    setQuery("")
                  } else if (e.key === "ArrowDown" && tabStop !== undefined) {
                    e.preventDefault()
                    focusItem(tabStop)
                  } else if (e.key === "Enter") {
                    // Picks the first match rather than applying the dialog.
                    e.preventDefault()
                    const first = flat.find((i) => i !== "none")
                    if (first !== undefined) {
                      if (multi) props.onToggle(first as T)
                      else props.onChange(first)
                      focusItem(first)
                    }
                  }
                }}
                className="h-9 w-full rounded-lg border border-input bg-card pr-8 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-input/30 pointer-coarse:h-11"
              />
              {query && (
                <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          )}
          {jumpChips && query.trim() === "" && (
            <div role="group" aria-label={`Jump to a group of ${label.toLowerCase()}`} className="-mx-0.5 flex gap-1 overflow-x-auto px-0.5 pb-0.5 [scrollbar-width:none]">
              {groups.map((g) => (
                <button
                  key={g.name}
                  type="button"
                  onClick={() => jump(g.name)}
                  className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground outline-none hover:border-foreground/25 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:py-2"
                >
                  {g.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <p className="sr-only" aria-live="polite">{query.trim() ? (count === 0 ? "No matches" : `${count} match${count === 1 ? "" : "es"}`) : ""}</p>
      <div
        ref={scroll}
        id={`${uid}-grid`}
        role={multi ? "group" : "radiogroup"}
        aria-label={label}
        // On a narrow screen the dialog's body is the one scroll; from 640 px the grid scrolls in its own box.
        className={cn("relative -mx-1 grid content-start gap-3 px-1 pb-1", maxHeight && "rounded-lg sm:max-h-(--tile-max) sm:overflow-y-auto sm:overscroll-contain")}
        style={maxHeight ? ({ "--tile-max": maxHeight } as CSSProperties) : undefined}
        data-transition-grid
      >
        {shown.map((g, gi) => (
          <div key={g.name} role="group" aria-label={g.name} className="grid gap-1.5">
            {groups.length > 1 && (
              <div data-tile-group={g.name} className="sticky top-0 z-[2] -mx-1 bg-popover/92 px-1 pt-1 pb-1 section-label backdrop-blur-sm">
                {g.name}
              </div>
            )}
            <div data-tile-row className="grid gap-2 pt-1.5 pr-1.5" style={gridStyle}>
              {withNone && gi === 0 && tile("none", 0)}
              {g.items.map((item) => tile(item, index++))}
            </div>
          </div>
        ))}
        {flat.length === 0 && (
          <div className="grid justify-items-center gap-2 rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
            <p>Nothing matches “{query.trim()}”.</p>
            <button type="button" onClick={() => setQuery("")} className="rounded-md px-2 py-1 font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              Clear search
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
