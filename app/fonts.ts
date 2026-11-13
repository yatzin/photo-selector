import localFont from "next/font/local"

// Self-hosted (fontsource packages), so building needs no network access to Google Fonts.

export const openSans = localFont({
  src: [{ path: "../node_modules/@fontsource-variable/open-sans/files/open-sans-latin-wght-normal.woff2", style: "normal", weight: "300 800" }],
  variable: "--font-open-sans",
  display: "swap",
})

export const poppins = localFont({
  src: [
    { path: "../node_modules/@fontsource/poppins/files/poppins-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../node_modules/@fontsource/poppins/files/poppins-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../node_modules/@fontsource/poppins/files/poppins-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-poppins",
  display: "swap",
})

export const geistMono = localFont({
  src: [{ path: "../node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2", style: "normal", weight: "100 900" }],
  variable: "--font-geist-mono",
  display: "swap",
})
