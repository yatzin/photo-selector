/** 83.4 -> "1:23.4" (m:ss.t); under a minute stays "0:05.0". */
export function formatTimecode(seconds: number): string {
  const s = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const tenths = Math.floor(s * 10)
  const m = Math.floor(tenths / 600)
  const sec = Math.floor((tenths % 600) / 10)
  return `${m}:${String(sec).padStart(2, "0")}.${tenths % 10}`
}
