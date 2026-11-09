// The video inbox is temporary staging: a file is deleted once it has been there
// RETENTION_MONTHS. Projects are never deleted. Pure date maths; the sweep is
// cleanExpiredInbox in inbox-cleanup-server.

export const RETENTION_MONTHS = 6

/** When a file arrived (epoch ms) becomes the moment it expires (epoch ms), calendar months on. */
export function expiresAt(modified: number): number {
  const d = new Date(modified)
  d.setMonth(d.getMonth() + RETENTION_MONTHS)
  return d.getTime()
}

export const isExpired = (modified: number, now: number) => now >= expiresAt(modified)

const DAY = 86_400_000

/** Whole days left before it expires (0 when due today or past). */
export const daysLeft = (modified: number, now: number) => Math.max(0, Math.ceil((expiresAt(modified) - now) / DAY))
