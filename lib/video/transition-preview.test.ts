import { describe, expect, it } from "vitest"
import { TRANSITION_TYPES } from "./transition-types"
import { cssText, loopFrame, loopPlan, transitionKeyframes, transitionLook } from "./transition-preview"

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
    for (const type of TRANSITION_TYPES) {
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
