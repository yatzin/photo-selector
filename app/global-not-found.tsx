import type { Metadata } from "next"
import { openSans, poppins } from "./fonts"
import Link from "next/link"
import { Images, SearchX } from "lucide-react"
import "./globals.css"

export const metadata: Metadata = {
  title: "Not Found — Photo Selector",
  description: "The page you're looking for doesn't exist.",
}

export default function GlobalNotFound() {
  return (
    <html lang="en" className={`${openSans.variable} ${poppins.variable} h-full antialiased`}>
      <body className="min-h-full bg-muted/40 text-foreground">
        <div className="min-h-svh flex items-center justify-center p-4">
          <div className="w-full max-w-sm space-y-6 text-center">
            <div className="flex flex-col items-center gap-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Images className="h-5 w-5" />
              </div>
              <h1 className="font-heading text-2xl font-semibold tracking-tight">Photo Selector</h1>
            </div>
            <div className="rounded-lg border bg-card p-8">
              <SearchX className="h-8 w-8 mx-auto mb-3 text-muted-foreground/60" strokeWidth={1.5} />
              <p className="font-medium">Page not found</p>
              <p className="text-sm text-muted-foreground mt-1">
                The page you&apos;re looking for doesn&apos;t exist or may have been moved.
              </p>
              <Link href="/" className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/80 transition-colors mt-5">
                Back to Library
              </Link>
            </div>
          </div>
        </div>
      </body>
    </html>
  )
}
