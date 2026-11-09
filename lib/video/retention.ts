// Video projects are temporary staging files: a project is deleted once it has
// gone unchanged for RETENTION_MONTHS. Pure date maths; the sweep itself is
// cleanExpiredProjects in projects-server.

export const RETENTION_MONTHS = 6

/** When a project last changed (epoch ms) becomes the moment it expires (epoch ms), calendar months on. */
export function expiresAt(modified: number): number {
  const d = new Date(modified)
  d.setMonth(d.getMonth() + RETENTION_MONTHS)
  return d.getTime()
}

export const isExpired = (modified: number, now: number) => now >= expiresAt(modified)

const DAY = 86_400_000

/** Whole days left before it expires (0 when due today or past). */
export const daysLeft = (modified: number, now: number) => Math.max(0, Math.ceil((expiresAt(modified) - now) / DAY))
