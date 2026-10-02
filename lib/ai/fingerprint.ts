import sharp from "sharp"

// Cheap visual fingerprints for grouping near-identical shots — no AI.
// dHash captures shapes and layout; a 4×4 colour grid stops two different
// scenes with similar shapes from matching.

export type Fingerprint = { hash: bigint; colors: number[] }

/** Difference hash of a 9×8 grayscale image (row-major): 64 bits, 1 where a pixel is brighter than its right neighbour. */
export function dHash(gray: Uint8Array): bigint {
  let hash = 0n
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      hash = (hash << 1n) | (gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1n : 0n)
    }
  }
  return hash
}

export function hamming(a: bigint, b: bigint): number {
  let v = a ^ b
  let count = 0
  while (v) {
    count += Number(v & 1n)
    v >>= 1n
  }
  return count
}

/** Mean absolute difference between two equal-length colour lists, 0–255. */
export function colorDistance(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

export async function fingerprintImage(input: string | Buffer): Promise<Fingerprint> {
  const [gray, color] = await Promise.all([
    sharp(input).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer(),
    sharp(input).removeAlpha().toColourspace("srgb").resize(4, 4, { fit: "fill" }).raw().toBuffer(),
  ])
  return { hash: dHash(new Uint8Array(gray)), colors: Array.from(color) }
}
