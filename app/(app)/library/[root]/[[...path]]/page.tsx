import Link from "next/link"
import { notFound } from "next/navigation"
import { ChevronRight, Folder, FolderX, Lock } from "lucide-react"
import { isRootKey, ROOT_LABELS } from "@/lib/media"
import { listDirectory, rootStatus } from "@/lib/library-server"
import { formatBytes, libraryHref } from "@/lib/format"
import { MediaGrid } from "@/components/library/media-grid"
import { AutoRefresh } from "@/components/ai/auto-refresh"
import { folderLocked } from "@/lib/ai/lock-server"

// A library folder: subfolders as cards, then its photos and videos as a
// sortable thumbnail grid.

export default async function LibraryPage({
  params,
}: {
  params: Promise<{ root: string; path?: string[] }>
}) {
  const { root, path = [] } = await params
  if (!isRootKey(root)) notFound()
  const segments = path.map((s) => decodeURIComponent(s))

  const status = await rootStatus(root)
  if (!status.readable) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-16 text-center">
        <FolderX className="h-8 w-8 mb-3 text-muted-foreground/60" strokeWidth={1.5} />
        <p className="font-medium">{ROOT_LABELS[root]} isn&apos;t available</p>
        <p className="text-sm text-muted-foreground mt-1 max-w-md">
          The app can&apos;t read <code className="font-mono">{status.path}</code>. Check the volume mapping in
          docker-compose.yml, or set <code className="font-mono">{status.envName}</code>.
        </p>
      </div>
    )
  }

  const [listing, locked] = await Promise.all([listDirectory(root, segments), folderLocked(root, segments)])
  if (!listing) notFound()

  const totalBytes = listing.files.reduce((sum, f) => sum + f.size, 0)

  return (
    <div className="space-y-6">
      <div>
        <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <Link href={libraryHref(root, [])} className="hover:text-foreground">{ROOT_LABELS[root]}</Link>
          {segments.map((name, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5" />
              <Link href={libraryHref(root, segments.slice(0, i + 1))} className="hover:text-foreground">{name}</Link>
            </span>
          ))}
        </nav>
        <h1 className="mt-1 font-heading text-2xl font-semibold">{segments.at(-1) ?? ROOT_LABELS[root]}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {listing.files.length.toLocaleString()} item{listing.files.length === 1 ? "" : "s"} in this folder
          {listing.files.length > 0 && <> &middot; {formatBytes(totalBytes)}</>}
          {!status.writable && <> &middot; <span className="text-destructive">read-only</span></>}
        </p>
      </div>

      {locked && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <Lock className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>
            An AI scan is reading this folder, so moving, deleting and rotating are paused until it finishes.{" "}
            <Link href="/ai" className="font-medium text-primary underline-offset-2 hover:underline">View scan</Link>
          </span>
        </div>
      )}
      <AutoRefresh active={locked} intervalMs={5000} />

      {listing.folders.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {listing.folders.map((f) => (
            <Link
              key={f.name}
              href={libraryHref(root, [...segments, f.name])}
              className="flex items-center gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/40"
            >
              <Folder className="h-5 w-5 shrink-0 text-primary" strokeWidth={1.5} />
              <div className="min-w-0">
                <div className="truncate font-medium">{f.name}</div>
                <div className="text-xs text-muted-foreground">{f.mediaCount.toLocaleString()} items</div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {listing.files.length > 0 ? (
        <MediaGrid
          root={root}
          folder={segments}
          files={listing.files}
          canMove={root === "upload" && status.writable && !locked}
          canEdit={status.writable && !locked}
        />
      ) : (
        listing.folders.length === 0 && (
          <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
            Nothing here yet.
          </div>
        )
      )}
    </div>
  )
}
