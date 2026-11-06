import { listProjects } from "@/lib/video/projects-server"
import { currentUserFolder } from "@/lib/video/user-folder-server"
import { ProjectList } from "@/components/video/project-list"

export const dynamic = "force-dynamic"

export default async function VideoEditingPage() {
  const projects = await listProjects(await currentUserFolder())
  projects.sort((a, b) => b.modified - a.modified)
  return <ProjectList projects={projects} />
}
