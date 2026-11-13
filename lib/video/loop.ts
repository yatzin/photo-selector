/** What playback does at time `t` of a timeline `total` seconds long: keep going, stop at the end, or jump back to 0 (loop on). */
export function endAction(t: number, total: number, margin: number, loop: boolean): "continue" | "stop" | "restart" {
  if (t < total - margin) return "continue"
  return loop && total > 0 ? "restart" : "stop"
}
