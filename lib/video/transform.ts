// Where a clip's picture sits on the canvas (the project's width x height).
// The picture is first fit inside the canvas keeping its aspect ratio (the
// letterbox), then `scale` multiplies that size about its centre, `x` and `y`
// move the centre away from the canvas centre as fractions of the canvas width
// and height (+x right, +y down), `cropTop`/`cropBottom` cut fractions of the
// scaled height off the top and bottom and `cropLeft`/`cropRight` fractions of
// the scaled width off the left and right, without moving what's left. The
// preview, its handles and the export all use clipRect, so they agree.
//
// The canonical order, which the preview and the export both follow:
// 1. fit inside the canvas (letterbox), 2. scale about the picture's centre,
// 3. flip (`flipH`/`flipV` mirror the picture about its centre), 4. crop (the
// fractions are screen-axis: they cut what the user sees, flipped or not),
// 5. rotate (`rotation` degrees, clockwise, about the CONTENT centre: the
// centre of the whole scaled picture, so cropping never moves the pivot),
// 6. place the content centre at (W/2 + x*W, H/2 + y*H). clipRect gives the
// unrotated rects; rotatedCorners turns the visible one on screen.
//
// A text clip has no picture to fit: its content box is a fixed size worked
// out from its text (lib/video/text: textSize, a font a tenth of the canvas
// height), passed as `{ w, h }` instead of an aspect. Step 1 then keeps that
// size as it is (no fit), and every later step is the same. The preview draws
// the text in that box and the export rasterises it at that box's size, so
// the handles, hit-testing and the export all agree for text too.

/**
 * `cropLeft` and `cropRight` are optional: absent means 0 (projects from before
 * they existed), and normalizeTransform leaves them out when they are 0, so an
 * old transform keeps its exact shape.
 */
export type Transform = {
  x: number
  y: number
  scale: number
  cropTop: number
  cropBottom: number
  cropLeft?: number
  cropRight?: number
  /** Degrees clockwise in (-180, 180]; absent is 0. */
  rotation?: number
  /** Mirrored left/right, up/down; absent is false. */
  flipH?: boolean
  flipV?: boolean
}
export type Rect = { x: number; y: number; w: number; h: number }
/** What clipRect places: a picture's aspect (width over height), fit inside the canvas, or a text's content box in canvas px, kept as it is. */
export type Content = number | { w: number; h: number }
export type Corner = "tl" | "tr" | "bl" | "br"
/** Canvas lines (px) a snapped edge or centre sits on: vertical lines at `x`, horizontal ones at `y`. */
export type Guides = { x: number[]; y: number[] }

export const IDENTITY: Transform = { x: 0, y: 0, scale: 1, cropTop: 0, cropBottom: 0 }
export const MIN_SCALE = 0.1
export const MAX_SCALE = 5
export const MAX_OFFSET = 2
export const MAX_CROP = 0.9
export const MAX_CROP_SUM = 0.95
const EPS = 1e-9

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** The left and right crop, 0 when absent. */
export const cropLeftOf = (t: Transform) => t.cropLeft ?? 0
export const cropRightOf = (t: Transform) => t.cropRight ?? 0
/** The rotation in degrees, 0 when absent. */
export const rotationOf = (t: Transform) => t.rotation ?? 0

/** `deg` brought into (-180, 180]; 0 for anything not finite. */
export function normalizeAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 0
  const r = deg - 360 * Math.floor((deg + 180) / 360)
  const a = r === -180 ? 180 : r
  // No -0.
  return a === 0 ? 0 : a
}

/** True for no transform or one that leaves the picture as fit. */
export function isIdentity(t: Transform | undefined): boolean {
  return (
    !t ||
    (t.x === 0 && t.y === 0 && t.scale === 1 && t.cropTop === 0 && t.cropBottom === 0 && cropLeftOf(t) === 0 && cropRightOf(t) === 0 &&
      rotationOf(t) === 0 && !t.flipH && !t.flipV)
  )
}

const validCrops = (a: number, b: number) => a >= 0 && a <= MAX_CROP && b >= 0 && b <= MAX_CROP && a + b <= MAX_CROP_SUM + EPS

/**
 * A transform with every field present (cropLeft, cropRight, rotation and the
 * flips may be absent), finite and inside its limits (nothing clamped): a
 * rotation in (-180, 180], flips booleans.
 */
export function isValidTransform(v: unknown): v is Transform {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false
  const { x, y, scale, cropTop, cropBottom, cropLeft = 0, cropRight = 0, rotation = 0, flipH = false, flipV = false } = v as Record<string, unknown>
  if (!finite(x) || !finite(y) || !finite(scale) || !finite(cropTop) || !finite(cropBottom) || !finite(cropLeft) || !finite(cropRight)) return false
  if (!finite(rotation) || rotation <= -180 || rotation > 180 || typeof flipH !== "boolean" || typeof flipV !== "boolean") return false
  return (
    Math.abs(x) <= MAX_OFFSET && Math.abs(y) <= MAX_OFFSET && scale >= MIN_SCALE && scale <= MAX_SCALE &&
    validCrops(cropTop, cropBottom) && validCrops(cropLeft, cropRight)
  )
}

/**
 * Clamps every field into its limits (a crop sum over the limit comes off the
 * bottom, or the right); a non-finite field becomes the identity's. The
 * rotation is brought into (-180, 180]. A zero cropLeft, cropRight or rotation
 * and a false flip are left out.
 */
export function normalizeTransform(t: Transform): Transform {
  const pick = (v: number | undefined, fallback: number) => (v !== undefined && Number.isFinite(v) ? v : fallback)
  const cropTop = clamp(pick(t.cropTop, 0), 0, MAX_CROP)
  let cropBottom = clamp(pick(t.cropBottom, 0), 0, MAX_CROP)
  if (cropTop + cropBottom > MAX_CROP_SUM) cropBottom = MAX_CROP_SUM - cropTop
  const cropLeft = clamp(pick(t.cropLeft, 0), 0, MAX_CROP)
  let cropRight = clamp(pick(t.cropRight, 0), 0, MAX_CROP)
  if (cropLeft + cropRight > MAX_CROP_SUM) cropRight = MAX_CROP_SUM - cropLeft
  const rotation = normalizeAngle(pick(t.rotation, 0))
  return {
    x: clamp(pick(t.x, 0), -MAX_OFFSET, MAX_OFFSET),
    y: clamp(pick(t.y, 0), -MAX_OFFSET, MAX_OFFSET),
    scale: clamp(pick(t.scale, 1), MIN_SCALE, MAX_SCALE),
    cropTop,
    cropBottom,
    ...(cropLeft > 0 ? { cropLeft } : {}),
    ...(cropRight > 0 ? { cropRight } : {}),
    ...(rotation !== 0 ? { rotation } : {}),
    ...(t.flipH === true ? { flipH: true } : {}),
    ...(t.flipV === true ? { flipV: true } : {}),
  }
}

/**
 * The full scaled picture's rect on a `canvasW` x `canvasH` canvas (px) and
 * `visible`, the strip left after the crop. `contentAspect` is the picture's
 * width over height; an unknown one (0, NaN) counts as the canvas's. A
 * `{ w, h }` box (a text's) is used at that size instead of being fit.
 */
export function clipRect(contentAspect: Content, canvasW: number, canvasH: number, t: Transform = IDENTITY): Rect & { visible: Rect } {
  const canvasAspect = canvasW / canvasH
  const box = typeof contentAspect === "object" && contentAspect.w > 0 && contentAspect.h > 0 ? contentAspect : null
  const aspect = typeof contentAspect === "number" && contentAspect > 0 && Number.isFinite(contentAspect) ? contentAspect : canvasAspect
  let cw = box ? box.w : canvasW
  let ch = box ? box.h : canvasH
  if (!box && Math.abs(aspect - canvasAspect) > EPS * canvasAspect) {
    if (aspect > canvasAspect) ch = canvasW / aspect
    else cw = canvasH * aspect
  }
  const w = cw * t.scale
  const h = ch * t.scale
  const x = canvasW / 2 + t.x * canvasW - w / 2
  const y = canvasH / 2 + t.y * canvasH - h / 2
  const cl = cropLeftOf(t)
  return { x, y, w, h, visible: { x: x + cl * w, y: y + t.cropTop * h, w: w * (1 - cl - cropRightOf(t)), h: h * (1 - t.cropTop - t.cropBottom) } }
}

export type Point = { x: number; y: number }

/** The content centre (canvas px): the middle of the whole scaled picture, the pivot rotation turns about. */
export function contentCentre(canvasW: number, canvasH: number, t: Transform): Point {
  return { x: canvasW / 2 + t.x * canvasW, y: canvasH / 2 + t.y * canvasH }
}

/** `p` turned `deg` degrees clockwise (y down) about `about`. */
export function rotatePoint(p: Point, about: Point, deg: number): Point {
  if (deg === 0) return { x: p.x, y: p.y }
  const a = (deg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const dx = p.x - about.x
  const dy = p.y - about.y
  return { x: about.x + dx * cos - dy * sin, y: about.y + dx * sin + dy * cos }
}

/** A screen-axis vector (a pointer drag) in the axes of a picture turned `deg` degrees: the inverse rotation. */
export function toLocal(dx: number, dy: number, deg: number): Point {
  return rotatePoint({ x: dx, y: dy }, { x: 0, y: 0 }, -deg)
}

/** `rect`'s corners turned `deg` degrees about `centre`, in the order top left, top right, bottom right, bottom left (of the unturned rect). */
export function rotatedCorners(rect: Rect, centre: Point, deg: number): [Point, Point, Point, Point] {
  const r = (x: number, y: number) => rotatePoint({ x, y }, centre, deg)
  return [r(rect.x, rect.y), r(rect.x + rect.w, rect.y), r(rect.x + rect.w, rect.y + rect.h), r(rect.x, rect.y + rect.h)]
}

/** The visible strip's bounding box on the canvas once turned (the strip itself when not rotated). */
export function rotatedBounds(contentAspect: Content, canvasW: number, canvasH: number, t: Transform): Rect {
  const v = clipRect(contentAspect, canvasW, canvasH, t).visible
  if (rotationOf(t) === 0) return v
  const pts = rotatedCorners(v, contentCentre(canvasW, canvasH, t), rotationOf(t))
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** True when canvas point `x`, `y` is on the visible strip as it shows (turned with the picture). */
export function containsPoint(contentAspect: Content, canvasW: number, canvasH: number, t: Transform, x: number, y: number): boolean {
  const v = clipRect(contentAspect, canvasW, canvasH, t).visible
  const p = rotatePoint({ x, y }, contentCentre(canvasW, canvasH, t), -rotationOf(t))
  return p.x >= v.x && p.x <= v.x + v.w && p.y >= v.y && p.y <= v.y + v.h
}

/** The angle (degrees, clockwise) of `p` seen from `centre`. */
export function angleFrom(centre: Point, p: Point): number {
  return (Math.atan2(p.y - centre.y, p.x - centre.x) * 180) / Math.PI
}

/** `deg` pulled onto the nearest multiple of `step` within `within` degrees (0 and the right angles included); normalised. */
export function snapAngle(deg: number, step = 15, within = 3): number {
  const nearest = Math.round(deg / step) * step
  return normalizeAngle(Math.abs(nearest - deg) <= within ? nearest : deg)
}

/** `t` turned to `deg` degrees (normalised) about its content centre; the crop and placement stay. */
export function withRotation(t: Transform, deg: number): Transform {
  return normalizeTransform({ ...t, rotation: deg })
}

/** `t` mirrored left/right ("h") or up/down ("v") once more, in place: the crop window stays where it is on screen. */
export function toggleFlip(t: Transform, axis: "h" | "v"): Transform {
  return normalizeTransform(axis === "h" ? { ...t, flipH: !t.flipH } : { ...t, flipV: !t.flipV })
}

/** Moves the picture by fractions of the canvas. */
export function dragMove(t0: Transform, dxFrac: number, dyFrac: number): Transform {
  return normalizeTransform({ ...t0, x: t0.x + dxFrac, y: t0.y + dyFrac })
}

const OPPOSITE: Record<Corner, Corner> = { tl: "br", tr: "bl", bl: "tr", br: "tl" }

function cornerOf(r: Rect, c: Corner): { x: number; y: number } {
  return { x: c.endsWith("l") ? r.x : r.x + r.w, y: c.startsWith("t") ? r.y : r.y + r.h }
}

/**
 * `t0` scaled by `k` (the result clamped) about the visible strip's corner
 * opposite `corner`, which stays where it was on screen (turned with the
 * picture when it's rotated).
 */
export function scaleAbout(t0: Transform, contentAspect: Content, canvasW: number, canvasH: number, corner: Corner, k: number): Transform {
  const { x: cx, y: cy } = contentCentre(canvasW, canvasH, t0)
  // The anchor where it shows: scaling about that point keeps it there whatever the rotation.
  const anchor = rotatePoint(cornerOf(clipRect(contentAspect, canvasW, canvasH, t0).visible, OPPOSITE[corner]), { x: cx, y: cy }, rotationOf(t0))
  const scale = clamp(Number.isFinite(k) ? t0.scale * k : t0.scale, MIN_SCALE, MAX_SCALE)
  const f = scale / t0.scale
  // Every point of the picture, the centre too, moves away from the anchor by the factor.
  const nx = anchor.x + f * (cx - anchor.x)
  const ny = anchor.y + f * (cy - anchor.y)
  return normalizeTransform({ ...t0, scale, x: (nx - canvasW / 2) / canvasW, y: (ny - canvasH / 2) / canvasH })
}

/**
 * A corner handle dragged by `dx`, `dy` (canvas px): a uniform scale about the
 * opposite corner of the visible strip, by the drag projected on the diagonal
 * (so the aspect ratio stays and the opposite corner stays put). The opposite
 * corner is the only anchor there is; `options` names it for the reader. On a
 * rotated picture the drag is taken in the picture's own axes.
 */
export function dragCorner(
  t0: Transform, corner: Corner, contentAspect: Content, canvasW: number, canvasH: number, sdx: number, sdy: number,
  options: { anchor: "opposite" } = { anchor: "opposite" }
): Transform {
  void options
  const { x: dx, y: dy } = toLocal(sdx, sdy, rotationOf(t0))
  const v = clipRect(contentAspect, canvasW, canvasH, t0).visible
  const a = cornerOf(v, OPPOSITE[corner])
  const c = cornerOf(v, corner)
  const d0 = { x: c.x - a.x, y: c.y - a.y }
  const len = d0.x * d0.x + d0.y * d0.y
  if (!(len > 0)) return t0
  const k = ((d0.x + dx) * d0.x + (d0.y + dy) * d0.y) / len
  return scaleAbout(t0, contentAspect, canvasW, canvasH, corner, k)
}

export type Edge = "top" | "bottom" | "left" | "right"

/**
 * An edge handle dragged by `d` canvas px: `dy` for top and bottom, `dx` for
 * left and right (+ is down or right). Inward crops, outward un-crops down to
 * 0; only that edge's crop changes.
 */
export function dragEdge(t0: Transform, edge: Edge, contentAspect: Content, canvasW: number, canvasH: number, d: number): Transform {
  const r = clipRect(contentAspect, canvasW, canvasH, t0)
  if (edge === "left" || edge === "right") {
    if (!(r.w > 0)) return t0
    if (edge === "left") {
      const cropLeft = clamp(cropLeftOf(t0) + d / r.w, 0, Math.min(MAX_CROP, MAX_CROP_SUM - cropRightOf(t0)))
      return normalizeTransform({ ...t0, cropLeft })
    }
    const cropRight = clamp(cropRightOf(t0) - d / r.w, 0, Math.min(MAX_CROP, MAX_CROP_SUM - cropLeftOf(t0)))
    return normalizeTransform({ ...t0, cropRight })
  }
  if (!(r.h > 0)) return t0
  if (edge === "top") {
    const cropTop = clamp(t0.cropTop + d / r.h, 0, Math.min(MAX_CROP, MAX_CROP_SUM - t0.cropBottom))
    return normalizeTransform({ ...t0, cropTop })
  }
  const cropBottom = clamp(t0.cropBottom - d / r.h, 0, Math.min(MAX_CROP, MAX_CROP_SUM - t0.cropTop))
  return normalizeTransform({ ...t0, cropBottom })
}

/** The nearest of `lines` to any of `values` within `threshold`: the offset to it and the line, or null. */
function nearest(values: number[], lines: number[], threshold: number): { d: number; line: number } | null {
  let best: { d: number; line: number } | null = null
  for (const v of values) for (const line of lines) {
    const d = line - v
    if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line }
  }
  return best
}

/** The lines (of `lines`) that one of `values` sits on, within half a pixel. */
const linesUnder = (values: number[], lines: number[]) => lines.filter((l) => values.some((v) => Math.abs(v - l) < 0.5))

/**
 * How far to shift `rect` (canvas px) so its nearest edge or centre lands on
 * the canvas's edge or centre line, per axis, when within `thresholdPx`; and
 * every line the shifted rect then sits on, to draw (a picture as wide as the
 * canvas sits on the left edge, the centre and the right edge at once).
 */
export function snapToCanvas(rect: Rect, canvasW: number, canvasH: number, thresholdPx: number): { dx: number; dy: number; guides: Guides } {
  const xs = [0, canvasW / 2, canvasW]
  const ys = [0, canvasH / 2, canvasH]
  const sx = nearest([rect.x, rect.x + rect.w / 2, rect.x + rect.w], xs, thresholdPx)
  const sy = nearest([rect.y, rect.y + rect.h / 2, rect.y + rect.h], ys, thresholdPx)
  const dx = sx ? sx.d : 0
  const dy = sy ? sy.d : 0
  return {
    dx,
    dy,
    guides: {
      x: sx ? linesUnder([rect.x + dx, rect.x + dx + rect.w / 2, rect.x + dx + rect.w], xs) : [],
      y: sy ? linesUnder([rect.y + dy, rect.y + dy + rect.h / 2, rect.y + dy + rect.h], ys) : [],
    },
  }
}

/** Where `edge` of a visible strip is (canvas px, x for left/right, y for top/bottom). */
function edgeOf(v: Rect, edge: Edge): number {
  if (edge === "left") return v.x
  if (edge === "right") return v.x + v.w
  if (edge === "top") return v.y
  return v.y + v.h
}

/**
 * An edge handle dragged by `d` canvas px (see dragEdge), with the cropped
 * edge pulled onto the nearest canvas edge or centre line within
 * `thresholdPx`; and the line it then sits on (none when the crop limits kept
 * it off the line).
 */
export function snapEdge(
  t0: Transform, edge: Edge, contentAspect: Content, canvasW: number, canvasH: number, d: number, thresholdPx: number
): { t: Transform; guides: Guides } {
  const vertical = edge === "left" || edge === "right"
  const lines = vertical ? [0, canvasW / 2, canvasW] : [0, canvasH / 2, canvasH]
  const from = edgeOf(clipRect(contentAspect, canvasW, canvasH, t0).visible, edge)
  const s = nearest([from + d], lines, thresholdPx)
  const t = dragEdge(t0, edge, contentAspect, canvasW, canvasH, s ? d + s.d : d)
  if (!s) return { t, guides: { x: [], y: [] } }
  const on = linesUnder([edgeOf(clipRect(contentAspect, canvasW, canvasH, t).visible, edge)], lines)
  return { t, guides: vertical ? { x: on, y: [] } : { x: [], y: on } }
}

/**
 * `t1` (a corner drag of `t0`) adjusted so the dragged corner lands on the
 * nearest canvas edge or centre line within `thresholdPx`, still scaled about
 * the opposite corner; and the lines the corner sits on.
 */
export function snapCorner(
  t0: Transform, corner: Corner, contentAspect: Content, canvasW: number, canvasH: number, t1: Transform, thresholdPx: number
): { t: Transform; guides: Guides } {
  const v0 = clipRect(contentAspect, canvasW, canvasH, t0).visible
  const anchor = cornerOf(v0, OPPOSITE[corner])
  const q = cornerOf(clipRect(contentAspect, canvasW, canvasH, t1).visible, corner)
  const xs = [0, canvasW / 2, canvasW]
  const ys = [0, canvasH / 2, canvasH]
  // A line counts only on the dragged corner's side of the anchor.
  const sx = nearest([q.x], xs.filter((l) => (l - anchor.x) * (q.x - anchor.x) > 0), thresholdPx)
  const sy = nearest([q.y], ys.filter((l) => (l - anchor.y) * (q.y - anchor.y) > 0), thresholdPx)
  let t = t1
  if (sx && (!sy || Math.abs(sx.d) <= Math.abs(sy.d))) t = scaleAbout(t0, contentAspect, canvasW, canvasH, corner, Math.abs(sx.line - anchor.x) / v0.w)
  else if (sy && v0.h > 0) t = scaleAbout(t0, contentAspect, canvasW, canvasH, corner, Math.abs(sy.line - anchor.y) / v0.h)
  else return { t: t1, guides: { x: [], y: [] } }
  const p = cornerOf(clipRect(contentAspect, canvasW, canvasH, t).visible, corner)
  return { t, guides: { x: xs.filter((l) => Math.abs(l - p.x) < 0.5), y: ys.filter((l) => Math.abs(l - p.y) < 0.5) } }
}
