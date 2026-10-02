import { Loader2 } from "lucide-react"

export default function Loading() {
  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  )
}
