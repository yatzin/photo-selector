// Caps failed sign-ins so passwords can't be guessed at machine speed. Counts
// live in memory: Photo Selector is one container, and a restart forgetting them
// only gives an attacker one more short window, not unlimited tries.
//
// Two counters, because each stops a different attack: per email stops many
// guesses at one account from many addresses, per address stops one machine
// trying many accounts.

export const LOGIN_LIMITS = { perEmail: 10, perIp: 30, windowMs: 15 * 60_000 }

type Counter = { count: number; resetAt: number }

// Bounds memory if someone sprays random emails; the oldest entries go first.
const MAX_ENTRIES = 10_000

export type LoginThrottle = {
  isBlocked(email: string, ip: string): boolean
  recordFailure(email: string, ip: string): void
  recordSuccess(email: string): void
}

export function createLoginThrottle(opts: Partial<typeof LOGIN_LIMITS> & { now?: () => number } = {}): LoginThrottle {
  const { perEmail, perIp, windowMs } = { ...LOGIN_LIMITS, ...opts }
  const now = opts.now ?? Date.now
  const counters = new Map<string, Counter>()

  const emailKey = (email: string) => `e:${email.trim().toLowerCase()}`
  const ipKey = (ip: string) => `i:${ip}`

  function current(key: string): number {
    const c = counters.get(key)
    if (!c) return 0
    if (c.resetAt <= now()) {
      counters.delete(key)
      return 0
    }
    return c.count
  }

  function bump(key: string) {
    const count = current(key)
    const existing = counters.get(key)
    if (existing) existing.count = count + 1
    else {
      if (counters.size >= MAX_ENTRIES) counters.delete(counters.keys().next().value!)
      counters.set(key, { count: 1, resetAt: now() + windowMs })
    }
  }

  return {
    isBlocked: (email, ip) => current(emailKey(email)) >= perEmail || current(ipKey(ip)) >= perIp,
    recordFailure(email, ip) {
      bump(emailKey(email))
      bump(ipKey(ip))
    },
    recordSuccess: (email) => void counters.delete(emailKey(email)),
  }
}

/**
 * The visitor's address as the reverse proxy saw it. A client can write any
 * X-Forwarded-For it likes; the proxy appends the real peer, so only the last
 * entry is trustworthy. Reached directly (no proxy) the header is fully
 * spoofable — the per-email limit still holds then.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")
  const last = forwarded?.split(",").map((s) => s.trim()).filter(Boolean).at(-1)
  return last || headers.get("x-real-ip")?.trim() || "unknown"
}
