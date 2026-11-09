import { notFound } from "next/navigation"
import { isPlainName } from "@/lib/media"
import { readProject } from "@/lib/video/projects-server"
import { currentUserFolder } from "@/lib/video/user-folder-server"
import { listTempFolderAction } from "@/lib/actions/video-projects"
import { Editor } from "@/components/video/editor"

export const dynamic = "force-dynamic"

export default async function VideoProjectPage({ params }: { params: Promise<{ project: string }> }) {
  const folder = decodeURIComponent((await params).project)
  if (!isPlainName(folder)) notFound()
  const userFolder = await currentUserFolder()
  const project = await readProject(userFolder, folder)
  if (!project) notFound()
  const listing = await listTempFolderAction([])
  return <Editor folder={folder} userFolder={userFolder} initial={project} temp={"error" in listing ? [] : listing.folders} />
}
