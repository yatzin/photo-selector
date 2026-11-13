/** True only for CC0 and the Public Domain Mark. Anything else (attribution licences, unknown, missing) is false. */
export function isOpenLicence(licence: unknown): boolean {
  if (typeof licence !== "string") return false
  const l = licence.trim().toLowerCase()
  return l === "cc0" || l === "pdm"
}
