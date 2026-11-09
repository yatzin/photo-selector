import { RETENTION_MONTHS } from "@/lib/video/retention"
import { Callout } from "./ui/callout"

/** The note that the Video Editing inbox is temporary staging. */
export function RetentionNote() {
  return (
    <Callout tone="info">
      <p>
        These files are temporary staging files for video projects. Anything that has been in the inbox for {RETENTION_MONTHS} months is deleted automatically. Projects are never deleted.
      </p>
    </Callout>
  )
}
