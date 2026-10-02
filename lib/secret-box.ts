import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto"

// AES-256-GCM for the few secrets kept in the database (the AI API key). The
// database file is copied into NAS snapshots and backups far more casually
// than the compose file, so a stored key shouldn't be readable from one.
//
// The key derives from AUTH_SECRET. Rotating AUTH_SECRET makes existing
// ciphertext unreadable: decrypt() returns null so callers can ask for the
// value again.

const VERSION = "v1"
const SALT = "photo-selector.secret-box"

function key() {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error("AUTH_SECRET is not set — cannot encrypt stored secrets")
  return scryptSync(secret, SALT, 32)
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":")
}

/** Null when the value can't be decrypted — usually a rotated AUTH_SECRET. */
export function decrypt(payload: string): string | null {
  try {
    const [version, iv, tag, data] = payload.split(":")
    if (version !== VERSION || !iv || !tag || !data) return null
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"))
    decipher.setAuthTag(Buffer.from(tag, "base64"))
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8")
  } catch {
    return null
  }
}
