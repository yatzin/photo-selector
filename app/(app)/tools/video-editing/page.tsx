import { listDirectory } from "@/lib/library-server"
import { listProjects } from "@/lib/video/projects-server"
import { currentUserFolder } from "@/lib/video/user-folder-server"
import { ProjectList } from "@/components/video/project-list"

export const dynamic = "force-dynamic"

export default async function VideoEditingPage() {
  const [projects, inbox] = await Promise.all([listProjects(await currentUserFolder()), listDirectory("video-inbox", [])])
  // Everyone's inbox folder, for the Manage inbox menu.
  return <ProjectList projects={projects} inboxUsers={(inbox?.folders ?? []).map((f) => ({ name: f.name, files: f.mediaCount }))} />
}
