import Link from "next/link"
import { cn } from "@/lib/utils"

/** Previous / numbered / next links; long runs of pages collapse to an ellipsis. */
export function Pager({ href, page, pages }: { href: (n: number) => string; page: number; pages: number }) {
  const shown = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b)
  const item = "inline-flex h-8 min-w-8 items-center justify-center rounded-lg border px-2.5 text-sm"
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-center gap-1.5">
      {page > 1 ? <Link href={href(page - 1)} className={cn(item, "hover:bg-muted")}>Previous</Link> : <span className={cn(item, "opacity-40")}>Previous</span>}
      {shown.map((n, i) => (
        <span key={n} className="contents">
          {i > 0 && n - shown[i - 1] > 1 && <span className="px-1 text-muted-foreground">…</span>}
          {n === page ? (
            <span aria-current="page" className={cn(item, "border-primary bg-primary text-primary-foreground")}>{n}</span>
          ) : (
            <Link href={href(n)} className={cn(item, "hover:bg-muted")}>{n}</Link>
          )}
        </span>
      ))}
      {page < pages ? <Link href={href(page + 1)} className={cn(item, "hover:bg-muted")}>Next</Link> : <span className={cn(item, "opacity-40")}>Next</span>}
    </nav>
  )
}
