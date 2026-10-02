"use client"

import { Button } from "@/components/ui/button"
import { Images, TriangleAlert } from "lucide-react"

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="min-h-svh flex items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Images className="h-5 w-5" />
          </div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Photo Selector</h1>
        </div>
        <div className="rounded-lg border bg-card p-8">
          <TriangleAlert className="h-8 w-8 mx-auto mb-3 text-destructive" strokeWidth={1.5} />
          <p className="font-medium">Something went wrong</p>
          <p className="text-sm text-muted-foreground mt-1">
            An unexpected error occurred. You can try again, or head back to the library.
          </p>
          <Button onClick={reset} className="mt-5">Try Again</Button>
        </div>
      </div>
    </div>
  )
}
