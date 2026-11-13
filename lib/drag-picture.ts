// A small, opaque copy of a DOM element, to ride beside the pointer while the
// element is dragged (the browser's drag picture, or the timeline's own drag).

const MAX_W = 140
const MAX_H = 90
const MIN_SCALE = 0.35

/** A detached element showing `el` scaled down to at most 140 x 90 px (never below a third of its size, the rest cut off), with its width and height; null when `el` has no size. */
export function buildDragPicture(el: HTMLElement): { root: HTMLDivElement; w: number; h: number } | null {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return null
  const copy = el.cloneNode(true) as HTMLElement
  copy.removeAttribute("id")
  copy.removeAttribute("draggable")
  copy.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"))
  Object.assign(copy.style, { width: `${r.width}px`, height: `${r.height}px`, margin: "0", left: "0", top: "0", right: "auto", bottom: "auto", position: "relative", inset: "auto", transform: "none", opacity: "1", transition: "none" })

  const scale = Math.max(MIN_SCALE, Math.min(1, MAX_W / r.width, MAX_H / r.height))
  const w = Math.min(MAX_W, r.width * scale)
  const h = Math.min(MAX_H, r.height * scale)
  const inner = document.createElement("div")
  inner.style.cssText = `width:${r.width}px;height:${r.height}px;transform:scale(${scale});transform-origin:0 0`
  inner.appendChild(copy)

  const root = document.createElement("div")
  root.setAttribute("aria-hidden", "true")
  root.style.cssText = `overflow:hidden;border-radius:6px;opacity:1;width:${w}px;height:${h}px;box-shadow:0 0 0 1px rgba(0,0,0,.3)`
  root.appendChild(inner)
  return { root, w, h }
}

/** A round count badge for the corner of a picture that stands for several items. */
export function addCountBadge(root: HTMLElement, n: number): void {
  const badge = document.createElement("span")
  badge.textContent = String(n)
  badge.style.cssText = "position:absolute;right:4px;top:4px;min-width:20px;padding:1px 6px;border-radius:999px;background:#2563eb;color:#fff;font:600 12px/18px sans-serif;text-align:center;box-shadow:0 0 0 2px #fff"
  root.appendChild(badge)
}
