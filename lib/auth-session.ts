// Sessions are JWTs, so nothing server-side remembers them. To make a role
// change, a deleted account or a password change take effect at once, every
// session read re-checks the account (see the jwt callback in auth.ts).
// sessionVersion is bumped to end every session an account has.

export type SessionClaims = { role?: string; mustResetPassword?: boolean; sessionVersion?: number }
export type AccountState = { role: string; mustResetPassword: boolean; sessionVersion: number }

/** The token with role and reset flag taken from the account, or null when the session must end. */
export function refreshClaims<T extends SessionClaims>(token: T, account: AccountState | null): T | null {
  if (!account) return null
  // Tokens issued before versions existed carry none; they count as version 0.
  if ((token.sessionVersion ?? 0) !== account.sessionVersion) return null
  return { ...token, role: account.role, mustResetPassword: account.mustResetPassword }
}
