import { describe, expect, it } from "vitest"
import { CUSTOM_TRANSITIONS, isCustomTransition, TRANSITION_TYPES } from "./transition-types"
import { heartCover, heartF, heartOutline } from "./transition-fx"
import { cssText, lookParts, loopFrame, loopPlan, loopSound, transitionKeyframes, transitionLook } from "./transition-preview"

describe("transitionLook", () => {
  it("draws a crossfade, a wipe and a slide as xfade does", () => {
    expect(transitionLook("fade", 0.25)).toEqual({ from: {}, to: { opacity: 0.25 } })
    // wipeleft: the incoming picture comes in from the right.
    expect(transitionLook("wipeleft", 0.25).to.clipPath).toBe("inset(0 0 0 75%)")
    // slideleft: the outgoing one leaves to the left, the incoming one follows from the right.
    expect(transitionLook("slideleft", 0.5)).toEqual({ from: { transform: "translateX(-50%)" }, to: { transform: "translateX(50%)" } })
  })

  it("dips to black or white at the middle", () => {
    expect(transitionLook("fadeblack", 0.5).tint).toEqual({ color: "#000", opacity: 1 })
    expect(transitionLook("fadewhite", 0).tint?.opacity).toBe(0)
  })

  it("shows the outgoing picture at 0 and the incoming one at 1 for every type", () => {
    for (const type of TRANSITION_TYPES.filter((t) => !isCustomTransition(t))) {
      const start = transitionLook(type, 0)
      const end = transitionLook(type, 1)
      expect(start.to.opacity === 0 || start.to.clipPath?.includes("100%") || start.to.transform?.includes("100%") || start.to.maskImage !== undefined).toBe(true)
      expect(end.to.opacity ?? 1).toBe(1)
      expect(end.tint?.opacity ?? 0).toBe(0)
    }
  })
})

describe("transitionKeyframes", () => {
  it("names three keyframe blocks and writes masks with their -webkit- twin", () => {
    const css = transitionKeyframes("circleopen", "tx")
    expect(css).toContain("@keyframes tx-circleopen-from{")
    expect(css).toContain("@keyframes tx-circleopen-to{0%,25%{")
    expect(css).toContain("@keyframes tx-circleopen-tint{")
    expect(cssText({ maskImage: "x", clipPath: "y" })).toBe("-webkit-mask-image:x;mask-image:x;clip-path:y")
  })
})

describe("loopPlan and loopFrame", () => {
  it("leads in and out by up to 2 s, as much as each clip has outside the transition", () => {
    expect(loopPlan(6, 6, 1)).toEqual({ lead: 2, tail: 2, cut: 2.5, total: 5, duration: 1 })
    expect(loopPlan(1.5, 3, 1)).toEqual({ lead: 1, tail: 2, cut: 1.5, total: 4, duration: 1 })
    expect(loopPlan(4, 4, 0)).toEqual({ lead: 2, tail: 2, cut: 2, total: 4, duration: 0 })
  })

  it("shows the outgoing picture first, both through the transition, then the incoming one", () => {
    const plan = loopPlan(6, 6, 1)
    expect(loopFrame(plan, 1)).toEqual({ from: true, to: false, progress: null })
    expect(loopFrame(plan, 2.5)).toEqual({ from: true, to: true, progress: 0.5 })
    expect(loopFrame(plan, 4)).toEqual({ from: false, to: true, progress: null })
    const cut = loopPlan(6, 6, 0)
    expect(loopFrame(cut, 1.99)).toEqual({ from: true, to: false, progress: null })
    expect(loopFrame(cut, 2)).toEqual({ from: false, to: true, progress: null })
  })
})

describe("loopSound", () => {
  it("plays the outgoing sound before the cut and the incoming one after, crossfading through a transition", () => {
    const plan = loopPlan(5, 5, 1)
    expect(loopSound(plan, 0, null)).toEqual({ from: { plays: true, gain: 1 }, to: { plays: false, gain: 0 } })
    const mid = loopSound(plan, plan.cut, null)
    expect(mid.from.gain).toBeCloseTo(Math.SQRT1_2)
    expect(mid.to.gain).toBeCloseTo(Math.SQRT1_2)
    expect(loopSound(plan, plan.cut + 0.6, null)).toEqual({ from: { plays: false, gain: 0 }, to: { plays: true, gain: 1 } })
  })

  it("cuts the sound at a hard cut", () => {
    const plan = loopPlan(5, 5, 0)
    expect(loopSound(plan, plan.cut - 0.01, null).from.gain).toBe(1)
    expect(loopSound(plan, plan.cut, null)).toEqual({ from: { plays: false, gain: 0 }, to: { plays: true, gain: 1 } })
  })

  it("starts the incoming sound early for a J-cut and runs the outgoing one on for an L-cut", () => {
    const plan = loopPlan(5, 5, 0)
    const j = { mode: "j" as const, duration: 1 }
    expect(loopSound(plan, plan.cut - 1.1, j).to.plays).toBe(false)
    expect(loopSound(plan, plan.cut - 0.5, j)).toEqual({ from: { plays: true, gain: 1 }, to: { plays: true, gain: 1 } })
    const l = { mode: "l" as const, duration: 1 }
    expect(loopSound(plan, plan.cut + 0.5, l)).toEqual({ from: { plays: true, gain: 1 }, to: { plays: true, gain: 1 } })
    expect(loopSound(plan, plan.cut + 1.01, l).from.plays).toBe(false)
  })
})

describe("the app's own transitions in the preview", () => {
  it("keep the same copies and overlays all through, so their samples' keyframes line up", () => {
    for (const type of CUSTOM_TRANSITIONS) {
      const parts = lookParts(type)
      for (const p of [0, 0.3, 0.5, 0.8, 1]) {
        const look = transitionLook(type, p)
        expect(look.fromCopies?.length ?? 0).toBe(parts.fromCopies.length)
        expect(look.toCopies?.length ?? 0).toBe(parts.toCopies.length)
        expect(look.overlays?.length ?? 0).toBe(parts.overlays.length)
      }
      const css = transitionKeyframes(type, "k")
      parts.fromCopies.forEach((_, i) => expect(css).toContain(`@keyframes k-${type}-from-c${i}{`))
      parts.overlays.forEach((_, i) => expect(css).toContain(`@keyframes k-${type}-ov${i}{`))
    }
  })

  it("start on the outgoing picture and end on the incoming one", () => {
    // Collage: every square whole at 0 and gone at 1, 5 x 3 on a 16:9 frame.
    const c0 = transitionLook("collage", 0)
    expect(1 + (c0.fromCopies?.length ?? 0)).toBe(15)
    expect([c0.from, ...c0.fromCopies!].every((s) => s.transform === "translateX(0%) scale(1)")).toBe(true)
    expect(transitionLook("collage", 1).fromCopies!.every((s) => s.transform!.endsWith("scale(0)"))).toBe(true)
    expect(transitionLook("exchange", 0)).toMatchObject({ from: { transform: "translateX(0%) scale(1)" }, to: { transform: "translateX(100%) scale(0.6)" } })
    expect(transitionLook("exchange", 1)).toMatchObject({ from: { transform: "translateX(-100%) scale(0.6)" }, to: { transform: "translateX(0%) scale(1)" } })
    expect(transitionLook("reveal", 1)).toMatchObject({ from: { transform: "translateX(-50%)" }, fromCopies: [{ transform: "translateX(50%)" }] })
    expect(transitionLook("pageturn", 0).from.clipPath).toBe("inset(0% 0% 0% 0%)")
    expect(transitionLook("pageturn", 1).overlays![0]).toMatchObject({ x: -0.5, w: 0.5 })
    expect(transitionLook("heart", 0).to.maskSize).toBe("0% 0%")
    expect(transitionLook("whip-left", 0)).toMatchObject({ from: { transform: "translateX(0%)" }, to: { transform: "translateX(100%)" } })
    expect(transitionLook("whip-up", 1)).toMatchObject({ from: { transform: "translate(0%, -100%)" }, to: { transform: "translateX(0%)" } })
    expect(transitionLook("whip-up", 0).from.filter).toBeUndefined()
    expect(transitionLook("whip-up", 0.5).from.filter).toBe("url(#ps-fx-v3)")
  })

  it("glitch: switches pictures at the middle, damage peaking there", () => {
    const before = transitionLook("glitch", 0.45)
    expect(before.to.opacity).toBe(0)
    expect(before.from.opacity).toBeUndefined()
    expect(before.fromCopies![0]).toMatchObject({ filter: "url(#ps-fx-r)", mixBlendMode: "plus-lighter" })
    expect(transitionLook("glitch", 0.55).from.opacity).toBe(0)
    expect(transitionLook("glitch", 0).overlays!.every((o) => o.opacity === 0)).toBe(true)
    expect(transitionLook("glitch", 0.5).overlays!.every((o) => o.opacity === 1)).toBe(true)
  })

  it("glitch reveal: no strip of the incoming picture at 0, all of them at 1", () => {
    expect(transitionLook("glitchreveal", 0).to.maskImage).not.toContain("#000")
    expect(transitionLook("glitchreveal", 1).to.maskImage).not.toContain("transparent")
  })

  it("the heart's outline is on the curve, and at full size it covers the frame's corners and edges", () => {
    for (const [x, y] of heartOutline()) expect(Math.abs(heartF(x, y))).toBeLessThan(1e-6)
    for (const aspect of [16 / 9, 9 / 16, 1]) {
      const s = heartCover(aspect)
      for (const [x, y] of [[aspect, 1], [-aspect, 1], [aspect, -1], [-aspect, -1], [0, 1], [0, -1]]) expect(heartF(x / s, y / s)).toBeLessThan(0)
    }
  })
})
