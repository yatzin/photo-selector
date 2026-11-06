// crypto.randomUUID only exists in a secure context (HTTPS or localhost), and
// the app is served over plain HTTP on the NAS; getRandomValues works anywhere.

/** 128 random bits as 32 hex characters. */
export function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")
}
