import { adjoins, clipLength, type Clip, type Project, type Track } from "./project"
import { isZoomFullTransition } from "./transition-types"

// A zoom cut is stored like any transition (Clip.transition on the incoming
// clip, type "zoomfromfull" or "zoomtofull"), but it has no overlap: nothing
// plays twice and no footage past a clip's ends is used. The preview and the
// export therefore never see it as a transition. expandZoomCuts turns it into
// a plain cut and a zoom inside one clip (lib/video/zoom-fullscreen): "from"
// is the incoming clip's zoomIn, "to" the outgoing clip's zoomOut.

/** The project with every zoom cut turned into a hard cut and a zoomIn or zoomOut (derived, never stored); the same project when it has none. */
export function expandZoomCuts(p: Project): Project {
  let changed = false
  const fix = (t: Track): Track => {
    if (!t.clips.some((c) => c.transition && isZoomFullTransition(c.transition.type))) return t
    changed = true
    const clips: Clip[] = t.clips.map((c) => ({ ...c }))
    clips.forEach((c, i) => {
      const tr = c.transition
      if (!tr || !isZoomFullTransition(tr.type)) return
      delete c.transition
      const prev = clips[i - 1]
      if (!prev || !adjoins(prev, c)) return
      if (tr.type === "zoomfromfull") c.zoomIn = { duration: Math.min(tr.duration, clipLength(c)) }
      else prev.zoomOut = { duration: Math.min(tr.duration, clipLength(prev)) }
    })
    return { ...t, clips }
  }
  const tracks = p.tracks.map(fix)
  return changed ? { ...p, tracks } : p
}
