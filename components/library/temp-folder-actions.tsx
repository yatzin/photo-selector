"use client"

import { createContext, useContext, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ExternalLink, Folder, FolderPlus, Pencil, Trash2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useMenuState } from "@/components/video/popup-menu"
import { DeleteTempDialog, NewFolderDialog, RenameDialog } from "@/components/video/temp-dialogs"
import { useTempUpload } from "@/components/video/use-temp-upload"

// Personal Storage folder pages: New folder and Upload media in the page
// header and in the right-click menu on the page's empty space, and folder
// cards with their own right-click menu (Open, Rename, Delete; not on a user's
// own folder, the first level). A new folder shows up on the page where you are. Folders can be made and opened as deep as you
// like. Photos and videos can be uploaded straight in.

type Actions = { newFolder: () => void; upload: () => void; uploading: boolean }
const Context = createContext<Actions | null>(null)

/**
 * Wraps a Personal Storage folder page (below a user's own folder level, where
 * `enabled`): holds the New folder dialog and the upload, and opens the
 * right-click menu on the page's empty space. Anything else on the page that
 * has a context menu of its own (a photo, a folder card) is left alone.
 */
export function TempBrowser({ parent, enabled, children }: { parent: string[]; enabled: boolean; children: React.ReactNode }) {
  const router = useRouter()
  const [newFolder, setNewFolder] = useState(false)
  const upload = useTempUpload(parent, () => router.refresh())
  const actions: Actions = { newFolder: () => setNewFolder(true), upload: upload.pick, uploading: upload.busy }
  const menu = useMenuState(
    () => [
      { label: "New folder…", icon: FolderPlus, onSelect: actions.newFolder },
      { label: "Upload media…", icon: Upload, onSelect: actions.upload },
    ],
    "Folder actions"
  )
  if (!enabled) return <div className="space-y-6">{children}</div>
  return (
    <Context.Provider value={actions}>
      <div
        className="min-h-[60vh] space-y-6"
        onContextMenu={(e) => {
          // A photo or card already opened its own menu; dialogs and fields keep the browser's.
          if (e.defaultPrevented || (e.target as HTMLElement).closest("[role=dialog], [data-editor-dialog], input, textarea, video")) return
          menu.onContextMenu(e)
        }}
      >
        {children}
        {upload.element}
        {menu.menu}
        {newFolder && (
          <NewFolderDialog
            parent={parent}
            onClose={() => setNewFolder(false)}
            onDone={() => router.refresh()}
          />
        )}
      </div>
    </Context.Provider>
  )
}

/** "New folder" in the page header. */
export function NewTempFolderButton({ className }: { className?: string }) {
  const actions = useContext(Context)
  if (!actions) return null
  return (
    <Button variant="outline" size="sm" onClick={actions.newFolder} className={className}>
      <FolderPlus className="h-4 w-4" />
      New folder
    </Button>
  )
}

/** "Upload media" in the page header: photos and videos from this computer into the folder. */
export function UploadMediaButton() {
  const actions = useContext(Context)
  if (!actions) return null
  return (
    <Button variant="outline" size="sm" onClick={actions.upload} title="Upload photos and videos from your computer into this folder">
      <Upload className="h-4 w-4" />
      Upload media
    </Button>
  )
}

/** A subfolder card: a link into it; right-click for Open, Rename and Delete (with a warning) when `editable`. */
export function TempFolderCard({ parent, name, count, href, editable }: { parent: string[]; name: string; count: number; href: string; editable: boolean }) {
  const router = useRouter()
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null)
  const menu = useMenuState(
    () => [
      { label: "Open", icon: ExternalLink, onSelect: () => router.push(href) },
      { label: "Rename…", icon: Pencil, onSelect: () => setDialog("rename") },
      { label: "Delete…", icon: Trash2, onSelect: () => setDialog("delete"), danger: true },
    ],
    `${name} actions`
  )
  return (
    <div onContextMenu={editable ? menu.onContextMenu : undefined}>
      <Link href={href} className="flex items-center gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/40">
        <Folder className="h-5 w-5 shrink-0 text-link" strokeWidth={1.5} />
        <div className="min-w-0">
          <div className="truncate font-medium">{name}</div>
          <div className="text-xs text-muted-foreground">{count.toLocaleString()} items</div>
        </div>
      </Link>
      {menu.menu}
      {dialog === "rename" && <RenameDialog kind="folder" parent={parent} name={name} onClose={() => setDialog(null)} onDone={() => router.refresh()} />}
      {dialog === "delete" && <DeleteTempDialog target={{ kind: "folder", parent, name, count }} onClose={() => setDialog(null)} onDone={() => router.refresh()} />}
    </div>
  )
}
