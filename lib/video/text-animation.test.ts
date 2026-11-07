import { describe, expect, it } from "vitest"
import {
  alphaWindow, animationExprs, animationState, ANIM_GROUPS, MAX_TYPE_STEPS, printExpr, REST, typeChars, typewriterBoxes, typewriterCuts, typewriterHidden,
  type AnimGeometry, type E,
} from "./text-animation"
import { ANIM_TYPES, type AnimType, type ClipText } from "./text"

const geo: AnimGeometry = { bounds: { x: 0.4, y: 0.45, w: 0.2, h: 0.1 }, units: 10 }
const inOnly = (type: AnimType, duration = 2) => ({ animIn: { type, duration } })
const outOnly = (type: AnimType, duration = 1) => ({ animOut: { type, duration } })
const at = (text: Partial<ClipText>, t: number, g = geo) => animationState(text, t, 5, g)

describe("animationState", () => {
  it("rests with no animation, and between in and out", () => {
    expect(at({}, 0)).toEqual(REST)
    expect(at({ ...inOnly("fade"), ...outOnly("fade") }, 2.5)).toEqual(REST)
  })

  it("fades in with ease-out and out with ease-in", () => {
    expect(at(inOnly("fade"), 0).opacity).toBe(0)
    expect(at(inOnly("fade"), 1).opacity).toBeCloseTo(0.875)
    expect(at(inOnly("fade"), 1.999).opacity).toBeCloseTo(1, 5)
    expect(at(inOnly("fade"), 2)).toEqual(REST)
    // Out: 4 to 5. Halfway it's where in is halfway (the same curve backwards), at the end gone.
    expect(at(outOnly("fade"), 4)).toEqual(REST)
    expect(at(outOnly("fade"), 4.5).opacity).toBeCloseTo(0.875)
    expect(at(outOnly("fade"), 4.9).opacity).toBeCloseTo(1 - 0.9 ** 3)
    expect(at(outOnly("fade"), 5).opacity).toBe(0)
  })

  it("slides from just past a canvas edge to rest, and out past it", () => {
    // Bounds x 0.4 to 0.6, y 0.45 to 0.55.
    expect(at(inOnly("slide-left"), 0).offsetX).toBeCloseTo(-0.6)
    expect(at(inOnly("slide-left"), 1).offsetX).toBeCloseTo(-0.6 * 0.125)
    expect(at(inOnly("slide-right"), 0).offsetX).toBeCloseTo(0.6)
    expect(at(inOnly("slide-up"), 0).offsetY).toBeCloseTo(-0.55)
    expect(at(inOnly("slide-down"), 0).offsetY).toBeCloseTo(0.55)
    expect(at(outOnly("slide-left"), 5).offsetX).toBeCloseTo(-0.6)
    expect(at(outOnly("slide-down"), 4.5).offsetY).toBeCloseTo(0.55 * 0.125)
    expect(at(inOnly("slide-left"), 0).opacity).toBe(1)
  })

  it("sweeps inside the box from a side", () => {
    expect(at(inOnly("sweep-left"), 0).reveal).toEqual({ dir: "left", fraction: 0 })
    expect(at(inOnly("sweep-up"), 1).reveal?.fraction).toBeCloseTo(0.875)
    expect(at(inOnly("sweep-up"), 1).reveal?.dir).toBe("up")
    expect(at(outOnly("sweep-right"), 5).reveal).toEqual({ dir: "right", fraction: 0 })
    expect(at(inOnly("sweep-left"), 2).reveal).toBeNull()
  })

  it("explodes, implodes, pops and spins about the centre", () => {
    expect(at(inOnly("explode"), 0)).toMatchObject({ scale: 2, opacity: 0 })
    expect(at(inOnly("explode"), 1).scale).toBeCloseTo(1.125)
    expect(at(outOnly("explode"), 5)).toMatchObject({ scale: 2, opacity: 0 })
    expect(at(inOnly("implode"), 0)).toMatchObject({ scale: 0, opacity: 0 })
    expect(at(outOnly("implode"), 4.5).scale).toBeCloseTo(0.875)
    expect(at(inOnly("pop"), 0).scale).toBeCloseTo(0)
    expect(at(inOnly("pop"), 1).scale).toBeCloseTo(1 - 2.70158 / 8 + 1.70158 / 4)
    // Overshoots before it settles.
    expect(Math.max(...[1.4, 1.6, 1.8].map((t) => at(inOnly("pop"), t).scale))).toBeGreaterThan(1.05)
    expect(at(inOnly("spin"), 0)).toMatchObject({ rotationDeg: -360, scale: 0 })
    expect(at(inOnly("spin"), 1).rotationDeg).toBeCloseTo(-45)
  })

  it("bounces in from above and out off the bottom", () => {
    expect(at(inOnly("bounce"), 0).offsetY).toBeCloseTo(-0.55)
    expect(at(outOnly("bounce"), 5).offsetY).toBeCloseTo(0.55)
    expect(at(inOnly("bounce"), 1.999).offsetY).toBeCloseTo(0, 3)
    // It touches down (rest) before the end, then rises again: a bounce.
    const ys = Array.from({ length: 200 }, (_, i) => at(inOnly("bounce"), (i / 200) * 2).offsetY)
    const firstTouch = ys.findIndex((y) => y > -0.02)
    expect(firstTouch).toBeGreaterThan(0)
    expect(Math.min(...ys.slice(firstTouch + 2))).toBeLessThan(-0.05)
  })

  it("types characters in equal steps, and takes them away from the end", () => {
    expect(at(inOnly("typewriter"), 0).chars).toBe(0)
    expect(at(inOnly("typewriter"), 1).chars).toBe(5)
    expect(at(inOnly("typewriter"), 1.999).chars).toBe(9)
    expect(at(inOnly("typewriter"), 2).chars).toBeNull()
    expect(at(outOnly("typewriter"), 4.55).chars).toBe(4)
    expect(at(outOnly("typewriter"), 5).chars).toBe(0)
    expect(typeChars(1, 7)).toBe(7)
    // Past MAX_TYPE_STEPS characters it steps by blocks: 250 in 84 steps of 3.
    expect(typeChars(0.5, 250)).toBe(126)
    expect(typeChars(1, 250)).toBe(250)
    expect(new Set(Array.from({ length: 1000 }, (_, i) => typeChars(i / 1000, 250))).size).toBeLessThanOrEqual(MAX_TYPE_STEPS)
  })

  it("plays in, rests, then plays out, with different types and lengths", () => {
    const text = { animIn: { type: "sweep-left" as const, duration: 2 }, animOut: { type: "fade" as const, duration: 1 } }
    expect(at(text, 1).reveal?.fraction).toBeCloseTo(0.875)
    expect(at(text, 1).opacity).toBe(1)
    expect(at(text, 3)).toEqual(REST)
    expect(at(text, 4.5)).toMatchObject({ reveal: null, opacity: expect.closeTo(0.875) })
    // In and out that fill the clip meet at rest.
    const full = { animIn: { type: "fade" as const, duration: 3 }, animOut: { type: "fade" as const, duration: 2 } }
    expect(at(full, 3)).toEqual(REST)
    expect(at(full, 2.9).opacity).toBeLessThan(1)
    expect(at(full, 3.1).opacity).toBeLessThan(1)
  })

  it("names every type once in the dialog's groups", () => {
    expect(ANIM_GROUPS.flatMap((g) => g.types.map((t) => t.type)).sort()).toEqual([...ANIM_TYPES].sort())
    expect(ANIM_GROUPS.map((g) => g.label)).toEqual(["Fade", "Slide", "Sweep", "Scale", "Text"])
  })
})

/** Runs a printed ffmpeg expression in JS (ffmpeg's functions, the variables given). */
function run(expr: string, vars: Record<string, number>): number {
  const fns = {
    _if: (c: number, a: number, b: number) => (c !== 0 ? a : b), _lt: (a: number, b: number) => +(a < b), _gt: (a: number, b: number) => +(a > b),
    _gte: (a: number, b: number) => +(a >= b), _clip: (x: number, a: number, b: number) => Math.max(a, Math.min(b, x)), _pow: Math.pow, _max: Math.max, _min: Math.min,
    _floor: Math.floor,
  }
  const js = expr.replace(/\b(if|lt|gte|gt|clip|pow|max|min|floor)\(/g, "_$1(")
  const names = [...Object.keys(fns), ...Object.keys(vars)]
  return new Function(...names, `return ${js}`)(...Object.values(fns), ...Object.values(vars)) as number
}

describe("animationExprs (the export's maths)", () => {
  const print = (e: E | null) => (e === null ? null : printExpr(e, { t: "t" }))

  it("prints the same values animationState gives, for every type in and out", () => {
    for (const type of ANIM_TYPES) {
      const text = { animIn: { type, duration: 1.5 }, animOut: { type, duration: 2 } }
      const x = animationExprs(text, 5, geo)
      for (let t = 0; t <= 5; t += 0.05) {
        const s = animationState(text, t, 5, geo)
        const val = (e: E | null, rest: number) => (e === null ? rest : run(print(e)!, { t }))
        expect(val(x.offsetX, 0)).toBeCloseTo(s.offsetX, 5)
        expect(val(x.offsetY, 0)).toBeCloseTo(s.offsetY, 5)
        expect(val(x.scale, 1)).toBeCloseTo(s.scale, 5)
        expect(val(x.rotationDeg, 0)).toBeCloseTo(s.rotationDeg, 4)
        if (x.alpha !== null) {
          // The alpha at a pixel a third of the way across and down a 300 x 90 box: the opacity times the sweep's mask.
          const X = 100, Y = 30
          const a = run(printExpr(x.alpha, { t: "t" }), { t, X, Y, W: 300, H: 90 })
          const r = s.reveal
          const shown = !r ? 1 : r.dir === "left" ? +(X + 0.5 < 300 * r.fraction) : r.dir === "right" ? +(X + 0.5 >= 300 * (1 - r.fraction)) : r.dir === "up" ? +(Y + 0.5 < 90 * r.fraction) : +(Y + 0.5 >= 90 * (1 - r.fraction))
          expect(a).toBeCloseTo(s.opacity * shown, 5)
        }
      }
    }
  })

  it("leaves a channel no animation moves out (null)", () => {
    const x = animationExprs({ animIn: { type: "fade", duration: 1 } }, 5, geo)
    expect(x.offsetX).toBeNull()
    expect(x.scale).toBeNull()
    expect(x.alpha).not.toBeNull()
    expect(alphaWindow({ animIn: { type: "fade", duration: 1 } }, 5)).toBe("lt(t,1)")
    expect(alphaWindow({ animIn: { type: "pop", duration: 1 }, animOut: { type: "sweep-up", duration: 0.5 } }, 5)).toBe("gt(t,4.5)")
    expect(alphaWindow({ animIn: { type: "slide-left", duration: 1 } }, 5)).toBeNull()
  })
})

describe("typewriter geometry", () => {
  it("cuts a horizontal text at each character's advance, line by line", () => {
    // Mono: 0.6 a character, "AB" is 1.2 of 1.7 font sizes wide (0.25 padding each side).
    const cuts = typewriterCuts({ content: "AB\nC", orientation: "horizontal" })
    expect(cuts).toHaveLength(3)
    expect(cuts[0]).toMatchObject({ x: 0, top: 0 })
    expect(cuts[1].x).toBeCloseTo((0.25 + 0.6) / 1.7)
    expect(cuts[1].bottom).toBeCloseTo((0.25 + 1.3) / (2.6 + 0.5))
    expect(cuts[2]).toMatchObject({ x: 0, bottom: 1 })
  })

  it("cuts vertical text row by row, a blank row counting", () => {
    const cuts = typewriterCuts({ content: "A B", orientation: "vertical" })
    expect(cuts.map((c) => c.x)).toEqual([0, 0, 0])
    expect(cuts[2].bottom).toBe(1)
  })

  it("hides the rest of the row and the rows below", () => {
    const cuts = typewriterCuts({ content: "AB\nC", orientation: "horizontal" })
    expect(typewriterHidden(cuts, 3)).toEqual([])
    const h = typewriterHidden(cuts, 1)
    expect(h).toHaveLength(2)
    expect(h[0].x).toBeCloseTo(cuts[1].x)
    expect(h[1]).toMatchObject({ x: 0, w: 1 })
    expect(typewriterHidden(cuts, 2)).toHaveLength(1)
  })

  it("clears each step's region with a drawbox enabled until its time, in and out", () => {
    const text: ClipText = { content: "AB", color: "#ffffff", orientation: "horizontal", animIn: { type: "typewriter", duration: 2 }, animOut: { type: "typewriter", duration: 1 } }
    const boxes = typewriterBoxes(text, 5)
    expect(boxes).toHaveLength(2)
    expect(boxes[0]).toBe("drawbox=x=round(iw*0):y=round(ih*0):w=iw-round(iw*0):h=ih-round(ih*0):color=black@0:t=fill:replace=1:enable='lt(t,1)+gt(t,4.5)'")
    expect(boxes[1]).toContain(":enable='lt(t,2)+gt(t,4)'")
    expect(typewriterBoxes({ ...text, animIn: { type: "fade", duration: 1 }, animOut: undefined }, 5)).toEqual([])
    // A long text: at most MAX_TYPE_STEPS steps, two boxes each at most.
    expect(typewriterBoxes({ ...text, content: "x".repeat(450) }, 5).length).toBeLessThanOrEqual(2 * MAX_TYPE_STEPS)
  })
})
