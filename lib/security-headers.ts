// Response headers that tell browsers how to treat Photo Selector: never inside
// another site's frame, HTTPS only, no guessing file types, and scripts only
// from this site. Applied from next.config.ts.
//
// Scripts and styles allow 'unsafe-inline' because Next.js inlines its own
// bootstrapping; nonces would force every page to render per request. See
// node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md.

export function contentSecurityPolicy(isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ")
}

type HeaderRule = { source: string; headers: { key: string; value: string }[] }

export function securityHeaderRules(isDev: boolean): HeaderRule[] {
  return [
    {
      source: "/:path*",
      headers: [
        // Ignored by browsers over plain HTTP, so a LAN address still works.
        { key: "Strict-Transport-Security", value: "max-age=15552000" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Content-Security-Policy", value: contentSecurityPolicy(isDev) },
      ],
    },
  ]
}
