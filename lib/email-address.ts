import { z } from "zod"

// One address, nothing else. Mail libraries accept display names, groups and
// lists in a recipient string, so a loose "any text" field let an account add
// extra recipients to its own digest. Case is kept as typed: sign-in looks the
// address up exactly as stored.
export const emailAddress = z.string().trim().max(254).email("Enter a valid email address.")

export function isEmailAddress(value: string): boolean {
  return emailAddress.safeParse(value).success && value === value.trim()
}
