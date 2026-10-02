import Link from "next/link"
import { buttonVariants } from "@/components/ui/button"
import { SearchX } from "lucide-react"

export default function AppNotFound() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-16 text-center">
      <SearchX className="h-8 w-8 mb-3 text-muted-foreground/60" strokeWidth={1.5} />
      <p className="font-medium">Not found</p>
      <p className="text-sm text-muted-foreground mt-1">
        This item doesn&apos;t exist or may have been deleted.
      </p>
      <Link href="/" className={buttonVariants({ variant: "outline", className: "mt-5" })}>
        Back to Library
      </Link>
    </div>
  )
}
