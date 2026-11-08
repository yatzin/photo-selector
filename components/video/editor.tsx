"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, AudioWaveform, Blend, Check, Download, Loader2, Pause, Play, Redo2, RotateCcw, SquareSplitHorizontal, Trash2, TriangleAlert, Type, Undo2 } from "lucide-react"
import { toast } from "sonner"
import { Button, buttonVariants } from "@/components/ui/button"
import { useStoredValue } from "@/lib/hooks/use-stored-state"
import { deleteAssetAction, exportStatusAction, importAssetAction, startExportAction } from "@/lib/actions/video-projects"
import { mediaUrl } from "@/lib/format"
import { cn } from "@/lib/utils"
import { newId } from "@/lib/video/ids"
import { canRedo, canUndo, commit, createHistory, redo, undo, type History } from "@/lib/video/history"
import {
  addClip, addTextClip, allClips, assetKind, AUDIO_TRACK, baseInsertion, clipEnd, clipLength, clipsAt, DEFAULT_IMAGE, editOf, freeTrackFor, isAudioClip, isMagnetic, isTextClip, MAX_TRACKS, removeAsset,
  removeClip, resolveStart, setClipMuted, setClipText, setTransform, splitClip, totalLength, trackAt, trackEnd, type Asset, type Clip, type Edit, type Project,
} from "@/lib/video/project"
import { DEFAULT_TEXT } from "@/lib/video/text"
import { usedTextColours } from "@/lib/video/text-colours"
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM } from "@/lib/video/timeline-math"
import { dragMove, IDENTITY, isIdentity } from "@/lib/video/transform"
import { formatTimecode } from "@/lib/video/time"
import { applyCut, cutsOf, edgeTransitionName, setEdgeTransition } from "@/lib/video/transitions"
import type { Edge } from "@/lib/video/transition-types"
import { EditTextDialog, type TextSection } from "./edit-text-dialog"
import { FileTree, type InboxFolder } from "./file-tree"
import { ImportButton } from "./import-button"
import { Preview, type MediaDrop } from "./preview"
import { ResizeHandle } from "./resize-handle"
import { usePreviewPlayer } from "./use-preview-player"
import { Timeline, type DropTarget } from "./timeline"
import { TransitionDialog, type TransitionTarget } from "./transition-dialog"
import { useAutosave } from "./use-autosave"
import { useMediaImport } from "./use-media-import"

// The editor: file tree on the left, preview in the middle, timeline below.
// Slice 1 shell: import, add to timeline and autosave; drag/trim/split come
// with the timeline interactions, playback with the preview player.

const MIN_PREVIEW = 120 // px
const MIN_TIMELINE = 160 // px
const HANDLE = 8 // px, the resize handle's height
/** Arrow keys' nudge direction. */
const ARROWS: Record<string, [number, number] | undefined> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }

/** Where addClip puts a clip `length` long asked for at `start` on `track`: the snapped V1's slot boundary, else slid clear of overlaps. */
function landing(p: Project, track: number, length: number, start: number, id: string): number {
  const clips: Clip[] = p.tracks[track]?.clips ?? []
  return track === 0 && isMagnetic(p) ? baseInsertion(clips, start, id).start : resolveStart(clips, length, start, id)
}

/**
 * Server-owned fields (assets, name, settings) and the undoable edit, in one
 * state so an edit queued right after an import sees the new asset.
 */
type EditorState = { meta: Omit<Project, keyof Edit>; history: History<Edit> }

/** A project split into its server-owned part and its undoable edit (editOf: the tracks and the audio layer). */
function splitProject(p: Project): EditorState["meta"] {
  const meta: Partial<Project> = { ...p }
  delete meta.tracks
  delete meta.audioTrack
  return meta as EditorState["meta"]
}

function initialState(p: Project): EditorState {
  return { meta: splitProject(p), history: createHistory<Edit>(editOf(p)) }
}

export function Editor({
  folder, userFolder, initial, inbox,
}: {
  folder: string
  userFolder: string
  initial: Project
  inbox: InboxFolder[]
}) {
  const [editor, setEditor] = useState(() => initialState(initial))
  const project = useMemo<Project>(() => ({ ...editor.meta, ...editor.history.present }), [editor.meta, editor.history.present])
  // The latest project for code that runs after an await, which outlives the render that started it.
  const latest = useRef(project)
  useEffect(() => {
    latest.current = project
  })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Undo can take away the selected clip: drop a selection that no longer exists.
  if (selectedId !== null && !allClips(project).some((c) => c.id === selectedId)) setSelectedId(null)
  // The text clip whose Edit text dialog is open.
  const [textFor, setTextFor] = useState<string | null>(null)
  const [textSection, setTextSection] = useState<TextSection>("text")
  const textClip = textFor ? allClips(project).find((c) => c.id === textFor) : undefined
  // What the open Transition dialog is for: the cut into a clip (the clip after it holds the transition), or a clip's free edge.
  const [transitionTarget, setTransitionTarget] = useState<TransitionTarget | null>(null)
  // The clip after the cut whose dialog is open, for the timeline (opening it locks the group around that cut).
  const transitionFor = transitionTarget && !transitionTarget.edge ? transitionTarget.clipId : null
  // The selected clip's cuts with an adjoining neighbour, for the toolbar's Transition before / after (a free edge: Transition in / out).
  const selectedCuts = selectedId ? cutsOf(project, selectedId) : null
  const selectedClip = selectedId ? allClips(project).find((c) => c.id === selectedId) : undefined

  /** Opens a text clip's Edit text dialog on its Text tab, or on its Animation tab. */
  const openText = useCallback((id: string, section: TextSection = "text") => {
    setTextSection(section)
    setTextFor(id)
  }, [])

  /**
   * One user gesture: one undo step. Repeats with the same `group` in quick
   * succession make one step together. An edit that takes away an edge
   * transition because a clip now touches that edge says so (not the
   * Transition dialog's own Remove, `quiet`).
   */
  const edit = useCallback((change: (p: Project) => Project, group?: string, quiet = false) => {
    if (!quiet) {
      const before = latest.current
      const lost = lostEdges(before, change(before))
      if (lost > 0) toast.info("Edge transition removed: the clip now has a neighbour")
    }
    setEditor((s) => {
      const next = change({ ...s.meta, ...s.history.present })
      const history = commit(s.history, editOf(next), group)
      return history === s.history ? s : { ...s, history }
    })
  }, [])
  // Px per second: the slider, or the wheel over the ruler (which may land between the slider's steps).
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  // Audio waveforms on the timeline: on unless turned off in this browser (the server and first paint show them on).
  const [storedWaveforms, setStoredWaveforms] = useStoredValue("ps.video.waveforms")
  const waveforms = storedWaveforms !== "0"
  const [importing, setImporting] = useState<string | null>(null)
  // The guard against a second import: a ref, so two quick drops in one render can't both start.
  const importingRef = useRef(false)
  const { state: save, flush, isDirty } = useAutosave(folder, project)
  const [exportProgress, setExportProgress] = useState<number | null>(null)
  const exportTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const resumeAfterScrub = useRef(false)

  // Preview height: none stored (the default) lets the preview take what the timeline leaves.
  // The server and first paint use the default; a stored height takes over on hydration.
  const [storedHeight, setStoredHeight] = useStoredValue("ps.video.previewHeight")
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const parsedHeight = storedHeight ? Number(storedHeight) : NaN
  const previewHeight = dragHeight ?? (parsedHeight >= MIN_PREVIEW ? parsedHeight : null)
  const column = useRef<HTMLDivElement>(null)
  const previewBox = useRef<HTMLDivElement>(null)
  const [sizes, setSizes] = useState({ preview: 0, column: 0 })
  useEffect(() => {
    const col = column.current
    const pre = previewBox.current
    if (!col || !pre) return
    const ro = new ResizeObserver(() => setSizes({ preview: Math.round(pre.offsetHeight), column: col.clientHeight }))
    ro.observe(col)
    ro.observe(pre)
    return () => ro.disconnect()
  }, [])
  const maxPreview = Math.max(MIN_PREVIEW, sizes.column - HANDLE - MIN_TIMELINE)

  useEffect(() => () => {
    if (exportTimer.current) clearInterval(exportTimer.current)
  }, [])

  // Closing the tab with an unsaved edit asks first.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirty()) return
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [isDirty])

  // The asset id is the cache key: the media route caches for a year, and a
  // file name can come back with different content after a re-import.
  const thumbUrl = useCallback(
    (assetId: string) => {
      const file = project.assets[assetId]?.file
      return file ? mediaUrl("video-projects", [userFolder, folder, "assets"], file, "thumb", assetId) : ""
    },
    [project.assets, userFolder, folder]
  )

  const videoUrl = useCallback(
    (assetId: string) => {
      const asset = project.assets[assetId]
      return asset && assetKind(asset) === "video" ? mediaUrl("video-projects", [userFolder, folder, "assets"], asset.file, "original", assetId) : ""
    },
    [project.assets, userFolder, folder]
  )

  /** A still shown in the preview while an image clip is current (the converted preview, so HEIC and DNG show too). */
  const imageUrl = useCallback(
    (assetId: string) => {
      const asset = project.assets[assetId]
      return asset && assetKind(asset) === "image" ? mediaUrl("video-projects", [userFolder, folder, "assets"], asset.file, "preview", assetId) : ""
    },
    [project.assets, userFolder, folder]
  )
  /** A sound file's URL, for the preview's audio elements. */
  const audioUrl = useCallback(
    (assetId: string) => {
      const asset = project.assets[assetId]
      return asset && assetKind(asset) === "audio" ? mediaUrl("video-projects", [userFolder, folder, "assets"], asset.file, "original", assetId) : ""
    },
    [project.assets, userFolder, folder]
  )
  const player = usePreviewPlayer(project, videoUrl, audioUrl)
  // Import: files from the computer land in Project media as each one finishes (the server owns assets: take the new one from its reply).
  const importer = useMediaImport(folder, (id, asset) => setEditor((s) => ({ ...s, meta: { ...s.meta, assets: { ...s.meta.assets, [id]: asset } } })))
  const playhead = player.time
  const { toggle } = player

  /** Opens the Transition / audio overlap dialog for the cut before clip `id`; the player pauses (all its videos stop, so it is silent) and only the dialog's loop plays, with its sound. */
  const openTransition = (id: string) => {
    player.pause()
    setTransitionTarget({ clipId: id })
  }

  /** Opens the Transition dialog for a clip's free edge; a text clip's In and Out are its animations, so its Edit text dialog opens on the Animation tab instead. */
  const openEdge = (id: string, edge: Edge) => {
    const clip = allClips(project).find((c) => c.id === id)
    if (!clip) return
    if (isTextClip(clip)) return openText(id, "animation")
    player.pause()
    setTransitionTarget({ clipId: id, edge })
  }

  /** Playback pauses while the ruler is scrubbed and picks up again after. */
  function scrub(active: boolean) {
    if (active) {
      resumeAfterScrub.current = player.playing
      player.pause()
    } else if (resumeAfterScrub.current) {
      resumeAfterScrub.current = false
      player.play()
    }
  }

  /** Copies an Inbox file into Project media (or finds the copy already there); its asset id and asset, or null when it failed. */
  async function importFile(inboxFolder: string, name: string): Promise<{ id: string; asset: Asset } | null> {
    if (importingRef.current) {
      toast.info("Wait for the current import to finish.")
      return null
    }
    importingRef.current = true
    setImporting(`${inboxFolder}/${name}`)
    try {
      const r = await importAssetAction(folder, [inboxFolder], name)
      if ("error" in r) {
        toast.error(r.error)
        return null
      }
      // The server owns assets: take the new one from its reply.
      setEditor((s) => ({ ...s, meta: { ...s.meta, assets: { ...s.meta.assets, [r.id]: r.asset } } }))
      return { id: r.id, asset: r.asset }
    } catch {
      toast.error("Something went wrong importing that file.")
      return null
    } finally {
      importingRef.current = false
      setImporting(null)
    }
  }

  /** An Inbox file dropped on the timeline: import it, then put it where it was dropped. */
  async function dropFromInbox(inboxFolder: string, name: string, target: DropTarget) {
    const imported = await importFile(inboxFolder, name)
    if (!imported) return
    const id = newId()
    // Clips may have changed while importing; addClip slides the clip clear of the others, and a layer
    // removed meanwhile makes the clip a new top layer rather than dropping it.
    edit((p) => addClip(p, imported.id, Math.min(target.track, p.tracks.length), target, id))
    // The ghost had a guessed length before the import: say so when the real length slid the clip along.
    const p = latest.current
    const track = Math.min(target.track, p.tracks.length)
    const length = assetKind(imported.asset) === "image" ? DEFAULT_IMAGE : imported.asset.duration
    const start = landing(p, track, length, target.start, id)
    if (Math.abs(start - target.start) > 0.05) toast.info(`Placed at ${formatTimecode(start)} to avoid overlap`)
  }

  /**
   * A file dropped on the player: a clip at the playhead (as it was at the
   * drop) on the lowest layer free for its whole length there, a new layer when
   * none is (up to MAX_TRACKS), selected so its frame shows. An Inbox file is
   * imported first and placed in the project as it is then. One undo step.
   */
  async function dropOnPlayer(drop: MediaDrop) {
    const at = playhead
    let assetId: string
    let asset: Asset
    if (drop.kind === "asset") {
      const known = latest.current.assets[drop.id]
      if (!known) return
      assetId = drop.id
      asset = known
    } else {
      const imported = await importFile(drop.folder, drop.name)
      if (!imported) return
      assetId = imported.id
      asset = imported.asset
    }
    const length = assetKind(asset) === "image" ? DEFAULT_IMAGE : asset.duration
    if (assetKind(asset) === "audio") {
      // A sound file goes on the audio layer at the playhead (slid clear of its clips there).
      const id = newId()
      edit((p) => addClip(p, assetId, AUDIO_TRACK, { start: at }, id))
      setSelectedId(id)
      const start = resolveStart(trackAt(latest.current, AUDIO_TRACK)!.clips, length, at, id)
      if (Math.abs(start - at) > 0.05) toast.info(`Placed at ${formatTimecode(start)} to avoid overlap`)
      return
    }
    const track = freeTrackFor(latest.current, at, length)
    if (track === null) {
      toast.info("No free layer at the playhead. Move the playhead or remove a layer.")
      return
    }
    const id = newId()
    // Placed on the layer free in the project the edit applies to (it may be newer than `latest`).
    edit((p) => {
      const free = freeTrackFor(p, at, length)
      return free === null ? p : addClip(p, assetId, free, { start: at }, id)
    })
    setSelectedId(id)
    // A free layer takes it at the playhead; only the timeline's end limit could move it.
    const start = landing(latest.current, track, length, at, id)
    if (Math.abs(start - at) > 0.05) toast.info(`Placed at ${formatTimecode(start)} ${track === 0 && isMagnetic(latest.current) ? "(V1 snaps clips together)" : "to avoid overlap"}`)
  }

  /**
   * Deletes a media item on the server, then the same here: the item and its
   * clips go, and the undo history starts afresh (an older step could bring
   * back clips of a file that's gone, and the server would refuse to save it).
   * The selection goes with its clip (the check during render). True on success.
   */
  async function deleteMedia(assetId: string): Promise<boolean> {
    const before = latest.current
    const file = before.assets[assetId]?.file ?? "the file"
    try {
      const r = await deleteAssetAction(folder, assetId)
      if ("error" in r) {
        toast.error(r.error)
        return false
      }
    } catch {
      toast.error("Something went wrong deleting that file.")
      return false
    }
    const n = removeAsset(latest.current, assetId).removedClips
    setEditor((s) => {
      const { project: next } = removeAsset({ ...s.meta, ...s.history.present }, assetId)
      return initialState(next)
    })
    toast.success(n > 0 ? `Removed ${file} and ${n} clip${n === 1 ? "" : "s"}` : `Removed ${file}`)
    return true
  }

  /** A finished export: the browser downloads the kept copy (the route serves it by project, so no name is needed). */
  function finished(reused: boolean, output?: string) {
    const a = document.createElement("a")
    a.href = `/api/video-projects/${encodeURIComponent(folder)}/download`
    a.download = ""
    a.hidden = true
    document.body.appendChild(a)
    a.click()
    a.remove()
    if (reused) toast.success("No changes since the last export. Downloading the existing copy.")
    else toast.success(`Exported ${output}`)
  }

  async function startExport() {
    if (exportProgress !== null) return
    setExportProgress(0)
    const stop = () => {
      if (exportTimer.current) clearInterval(exportTimer.current)
      exportTimer.current = null
      setExportProgress(null)
    }
    try {
      // The server exports what's stored, so store any pending edit first.
      if (!(await flush())) {
        toast.error("Couldn't save the project, so it wasn't exported.")
        stop()
        return
      }
      const started = await startExportAction(folder)
      if ("error" in started) {
        toast.error(started.error)
        stop()
        return
      }
      // Nothing changed since the kept copy: the job is already done, so no polling.
      if (started.reused) {
        stop()
        finished(true, started.output)
        return
      }
      let polling = false
      exportTimer.current = setInterval(async () => {
        if (polling) return
        polling = true
        try {
          const s = await exportStatusAction(started.jobId)
          if (s.state === "running") {
            setExportProgress(s.progress)
          } else {
            stop()
            if (s.state === "done") finished(s.reused === true, s.output)
            else toast.error(s.error ?? "Export failed.")
          }
        } catch {
          stop()
          toast.error("Lost contact with the export.")
        } finally {
          polling = false
        }
      }, 1000)
    } catch {
      stop()
      toast.error("Something went wrong starting the export.")
    }
  }

  /**
   * Add text (the toolbar): a "Text" clip DEFAULT_IMAGE long at the playhead,
   * white, centred, selected, with its Edit text dialog open. It goes on the
   * selected clip's layer when that's free at the playhead for its length (not
   * a snapped layer 1); else on the lowest layer above the base free there, a
   * new layer when none is, else on the base (appended when it's snapped, else
   * slid clear). So it lands at the playhead over the picture. One undo step.
   */
  function addText() {
    const at = playhead
    const id = newId()
    edit((p) => {
      const freeAt = (i: number) => resolveStart(p.tracks[i].clips, DEFAULT_IMAGE, at) === at
      const selected = selectedId ? p.tracks.findIndex((t) => t.clips.some((c) => c.id === selectedId)) : -1
      if (selected >= 0 && !(selected === 0 && isMagnetic(p)) && freeAt(selected)) return addTextClip(p, DEFAULT_TEXT, selected, { start: at }, id)
      const free = p.tracks.findIndex((_, i) => i > 0 && freeAt(i))
      if (free > 0) return addTextClip(p, DEFAULT_TEXT, free, { start: at }, id)
      if (p.tracks.length < MAX_TRACKS) return addTextClip(p, DEFAULT_TEXT, p.tracks.length, { start: at }, id)
      return addTextClip(p, DEFAULT_TEXT, 0, { start: isMagnetic(p) ? trackEnd(p.tracks[0]) : at }, id)
    })
    setSelectedId(id)
    openText(id)
  }

  function addToTimeline(assetId: string) {
    const id = newId()
    // After the base track's last clip (a sound file: after the audio layer's).
    edit((p) => addClip(p, assetId, 0, { start: trackEnd(p.assets[assetId]?.kind === "audio" ? trackAt(p, AUDIO_TRACK)! : p.tracks[0]) }, id))
  }

  const { pause } = player
  /** Undo or redo one step. Playback stops; the player shows the frame at the playhead in the new timeline. */
  const step = useCallback(
    (dir: "undo" | "redo") => {
      pause()
      setEditor((s) => {
        const history = dir === "undo" ? undo(s.history) : redo(s.history)
        return history === s.history ? s : { ...s, history }
      })
    },
    [pause]
  )

  // What S and the Split button cut: the selected clip when something is selected (and only when the playhead
  // is over it, never another clip), else the topmost clip under the playhead.
  const playheadHits = clipsAt(project, playhead)
  // The audio layer isn't among the picture layers clipsAt sees: a selected audio clip under the playhead splits too.
  const selectedAudio = selectedId ? project.audioTrack?.clips.find((c) => c.id === selectedId) : undefined
  const splitTarget = selectedId
    ? (playheadHits.tracks.find((h) => h?.clip.id === selectedId)?.clip.id ?? (selectedAudio && playhead >= selectedAudio.start && playhead < clipEnd(selectedAudio) ? selectedAudio.id : null))
    : (playheadHits.top?.clip.id ?? null)

  /** Splits at the playhead (S, or the toolbar); false when there's no clip under it. One undo step. */
  function splitAtPlayhead(): boolean {
    if (!splitTarget) return false
    const id = splitTarget
    const at = playhead
    const splitId = newId()
    edit((p) => splitClip(p, id, at, splitId))
    return true
  }

  /** Removes the selected clip (Delete, or the toolbar); false with no selection. One undo step. */
  function deleteSelected(): boolean {
    if (!selectedId) return false
    const id = selectedId
    edit((p) => removeClip(p, id))
    setSelectedId(null)
    return true
  }

  // The selected clip when it shows at the playhead (the preview draws its frame), and whether it's moved, scaled or cropped.
  // At the end the preview still shows the last frame, so look just before it, as the preview does.
  const shownTotal = totalLength(project)
  const shownHits = playhead >= shownTotal ? clipsAt(project, Math.max(0, shownTotal - 0.001)) : playheadHits
  const canvasSelected = shownHits.tracks.some((h) => h !== null && h.clip.id === selectedId) ? selectedId : null
  const transformed = selectedId !== null && allClips(project).some((c) => c.id === selectedId && !isIdentity(c.transform))

  /** Mutes or unmutes the selected clip (M); false when nothing is selected or it has no sound. One undo step. */
  function toggleMuteSelected(): boolean {
    const clip = selectedId ? allClips(project).find((c) => c.id === selectedId) : undefined
    const asset = clip && project.assets[clip.asset]
    if (!clip || !asset || assetKind(asset) === "image" || !asset.hasAudio) return false
    const id = clip.id
    const muted = !clip.muted
    edit((p) => setClipMuted(p, id, muted))
    return true
  }

  /** Puts the selected clip's picture back as fit, unturned and unflipped (the toolbar's Reset). One undo step. */
  function resetTransform() {
    if (!selectedId) return
    const id = selectedId
    edit((p) => setTransform(p, id, IDENTITY))
  }

  /** Moves the clip selected on the canvas by fractions of the canvas (arrow keys); quick repeats make one undo step. */
  function nudge(dx: number, dy: number): boolean {
    if (!canvasSelected) return false
    const id = canvasSelected
    edit((p) => {
      const clip = allClips(p).find((c) => c.id === id)
      return clip ? setTransform(p, id, dragMove(clip.transform ?? IDENTITY, dx, dy)) : p
    }, `nudge-${id}`)
    return true
  }

  // Keyboard: Space plays, S splits the selected clip under the playhead (else the topmost one there),
  // Delete removes the selection, M mutes or unmutes it, Esc clears it, Cmd/Ctrl+Z undoes, Cmd/Ctrl+Shift+Z and Ctrl+Y redo,
  // the arrows nudge the clip selected on the canvas by 1% (Shift: 5%).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null
      // A handler that already acted (a clip's own Enter/Space select) prevents the default.
      if (e.defaultPrevented) return
      if (t?.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]")) return
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const key = e.key.toLowerCase()
        if (key === "z" || (key === "y" && e.ctrlKey && !e.shiftKey)) {
          e.preventDefault()
          step(key === "z" && !e.shiftKey ? "undo" : "redo")
        }
        return
      }
      const arrow = ARROWS[e.key]
      if (arrow && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // A focused slider or resize handle takes its own arrows.
        if (t?.closest("[role=slider], [role=separator]")) return
        const by = e.shiftKey ? 0.05 : 0.01
        if (nudge(arrow[0] * by, arrow[1] * by)) e.preventDefault()
        return
      }
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === " ") {
        // Space already activates a focused button, link or slider.
        if (t?.closest("button, a, [role=button], [role=menuitem], [role=slider]")) return
        e.preventDefault()
        toggle()
      } else if (e.key === "s" || e.key === "S") {
        if (splitAtPlayhead()) e.preventDefault()
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (deleteSelected()) e.preventDefault()
      } else if (e.key === "m" || e.key === "M") {
        if (toggleMuteSelected()) e.preventDefault()
      } else if (e.key === "Escape" && selectedId) {
        setSelectedId(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // No dependency list: the handler shares splitAtPlayhead and deleteSelected with the toolbar, which see this render's state.
  })

  return (
    <div className="-m-6 flex h-[calc(100%+3rem)] flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-4">
        <Link href="/tools/video-editing" title="All projects" className={buttonVariants({ variant: "ghost", size: "icon-sm" })}>
          <ArrowLeft className="h-4 w-4" />
          <span className="sr-only">All projects</span>
        </Link>
        <h1 className="min-w-0 truncate font-heading text-base font-semibold">{project.name}</h1>
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          {save === "saving" && <><Loader2 className="h-3 w-3 animate-spin" /> Saving…</>}
          {save === "saved" && <><Check className="h-3 w-3" /> Saved</>}
          {/* Only a failure is announced; Saving/Saved after every edit would be noise. */}
          <span aria-live="polite">
            {save === "error" && <span className="flex items-center gap-1 text-destructive"><TriangleAlert className="h-3 w-3" /> Couldn&apos;t save</span>}
          </span>
        </span>
        <ImportButton importer={importer} />
        <div className="flex-1" />
        <Button type="button" size="sm" onClick={startExport} disabled={allClips(project).length === 0 || exportProgress !== null}>
          {exportProgress === null ? <Download className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
          {exportProgress === null ? "Export" : `Exporting ${Math.round(exportProgress * 100)}%`}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 border-r border-border/60 md:block">
          <FileTree inbox={inbox} project={project} thumbUrl={thumbUrl} importing={importing} onAdd={addToTimeline} onDelete={deleteMedia} onImportFiles={importer.add} />
        </aside>
        <div ref={column} className="flex min-w-0 flex-1 flex-col">
          {/* With a set height the preview gives way first (flex-shrink) and the timeline grows; CSS keeps both minimums. */}
          <div
            ref={previewBox}
            className={cn("flex min-h-[120px] flex-col", previewHeight === null && "flex-1")}
            style={previewHeight === null ? undefined : { flex: `0 1 ${previewHeight}px` }}
          >
            <Preview player={player} project={project} imageUrl={imageUrl} selectedId={selectedId} onSelect={setSelectedId} onChange={edit} onDrop={(d) => void dropOnPlayer(d)} onEditText={openText} />
          </div>
          <ResizeHandle
            label="Resize preview"
            value={Math.min(maxPreview, Math.max(MIN_PREVIEW, sizes.preview))}
            min={MIN_PREVIEW}
            max={maxPreview}
            onResize={(px, done) => {
              if (!done) return setDragHeight(px)
              setStoredHeight(String(px))
              setDragHeight(null)
            }}
            onReset={() => {
              setStoredHeight("")
              setDragHeight(null)
            }}
          />
          {/* The tracks scroll inside the timeline (vertically too, with several layers); the bar above stays put. */}
          <div className={cn("flex flex-col bg-card", previewHeight === null ? "max-h-[60%] shrink-0" : "min-h-[160px] flex-1")}>
            {/* Three parts: the edit tools, Play/Pause in the middle of the bar whatever the sides hold, the view settings. */}
            <div
              role="toolbar"
              aria-label="Timeline tools"
              className="grid h-9 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-border/60 px-3 text-xs text-muted-foreground"
            >
              <div className="flex h-full min-w-0 items-center gap-1 overflow-hidden px-0.5">
                <span className="shrink-0 tabular-nums">{formatTimecode(playhead)} / {formatTimecode(totalLength(project))}</span>
                <div aria-hidden className="mx-2 h-5 w-px bg-border" />
                <Button type="button" size="icon-sm" variant="ghost" onClick={() => step("undo")} disabled={!canUndo(editor.history)} title="Undo (Ctrl+Z / ⌘Z)" aria-label="Undo">
                  <Undo2 className="h-4 w-4" />
                </Button>
                <Button type="button" size="icon-sm" variant="ghost" onClick={() => step("redo")} disabled={!canRedo(editor.history)} title="Redo (Ctrl+Shift+Z / ⌘⇧Z or Ctrl+Y)" aria-label="Redo">
                  <Redo2 className="h-4 w-4" />
                </Button>
                <Button type="button" size="icon-sm" variant="ghost" onClick={splitAtPlayhead} disabled={!splitTarget} title={selectedId && !splitTarget ? "Move the playhead over the selected clip to split it" : "Split at playhead (S)"} aria-label="Split at playhead">
                  <SquareSplitHorizontal className="h-4 w-4" />
                </Button>
                <Button type="button" size="icon-sm" variant="ghost" onClick={deleteSelected} disabled={!selectedId} title="Delete selected clip (Delete)" aria-label="Delete selected clip">
                  <Trash2 className="h-4 w-4" />
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={addText} title="Add a text clip at the playhead">
                  <Type className="h-4 w-4" /> Add text
                </Button>
                {selectedCuts && selectedClip &&
                  (["before", "after"] as const).map((side) => {
                    // A neighbour there: the cut's dialog; a free edge: the clip's own in or out transition (a text's animation).
                    const holder = selectedCuts[side]
                    const edge: Edge = side === "before" ? "in" : "out"
                    const set = holder ? null : (edge === "in" ? selectedClip.edgeIn : selectedClip.edgeOut)
                    const what = holder
                      ? `Transition ${side}${isAudioClip(project, selectedClip) ? "" : " / audio overlap"}`
                      : isTextClip(selectedClip)
                        ? `${edge === "in" ? "In" : "Out"} animation (Edit text)`
                        : `Transition ${edge}${set ? `: ${edgeTransitionName(set.type, edge)}, ${Number(set.duration.toFixed(2))} s` : ""}`
                    return (
                      <Button
                        key={side}
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => (holder ? openTransition(holder) : openEdge(selectedClip.id, edge))}
                        title={what}
                        aria-label={holder ? `Transition ${side}` : `Transition ${edge}`}
                        className={cn(side === "after" && "[&_svg]:-scale-x-100", set && "text-editor-accent")}
                      >
                        <Blend className="h-4 w-4" />
                      </Button>
                    )
                  })}
                {transformed && (
                  <Button type="button" size="sm" variant="ghost" onClick={resetTransform} title="Put the selected clip's picture back to fit the frame" aria-label="Reset size, position, crop, rotation and flips">
                    <RotateCcw className="h-4 w-4" /> Reset
                  </Button>
                )}
              </div>
              <Button
                type="button"
                size="icon"
                onClick={toggle}
                disabled={totalLength(project) === 0}
                title={player.playing ? "Pause (Space)" : "Play (Space)"}
                aria-label={player.playing ? "Pause" : "Play"}
                className="rounded-full bg-editor-accent text-editor-accent-foreground hover:bg-editor-accent/85"
              >
                {player.playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
              </Button>
              <div className="flex h-full min-w-0 items-center justify-end gap-1 overflow-hidden px-0.5">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setStoredWaveforms(waveforms ? "0" : "1")}
                  aria-pressed={waveforms}
                  title={waveforms ? "Hide audio waveforms" : "Show audio waveforms"}
                  aria-label="Audio waveforms"
                  className={cn(waveforms && "bg-muted text-foreground")}
                >
                  <AudioWaveform className="h-4 w-4" />
                </Button>
                <label className="flex min-w-0 items-center gap-2">
                  Zoom
                  <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-28 min-w-0 accent-editor-accent" />
                </label>
              </div>
            </div>
            <Timeline project={project} folder={folder} thumbUrl={thumbUrl} selectedId={selectedId} playhead={playhead} zoom={zoom} waveforms={waveforms} onZoom={setZoom} onSelect={setSelectedId} onSeek={player.seek} onScrub={scrub} onChange={edit} onDropInbox={(f, n, t) => void dropFromInbox(f, n, t)} onEditText={openText} onTransition={openTransition} onEdgeTransition={openEdge} transitionFor={transitionFor} />
          </div>
        </div>
      </div>
      {transitionTarget && allClips(project).some((c) => c.id === transitionTarget.clipId) && (
        <TransitionDialog
          key={`${transitionTarget.clipId}:${transitionTarget.edge ?? "cut"}`}
          project={project}
          target={transitionTarget}
          thumbUrl={thumbUrl}
          videoUrl={videoUrl}
          imageUrl={imageUrl}
          audioUrl={audioUrl}
          onApply={(spec) => {
            const id = transitionTarget.clipId
            edit((p) => applyCut(p, id, spec))
          }}
          onApplyEdge={(spec) => {
            const { clipId: id, edge } = transitionTarget
            if (edge) edit((p) => setEdgeTransition(p, id, edge, spec), undefined, true)
          }}
          onClose={() => setTransitionTarget(null)}
        />
      )}
      {textClip && isTextClip(textClip) && (
        <EditTextDialog
          key={textClip.id}
          text={textClip.text}
          length={clipLength(textClip)}
          section={textSection}
          usedColours={usedTextColours(project, textClip.id)}
          onApply={(t) => {
            const id = textClip.id
            edit((p) => setClipText(p, id, t))
          }}
          onClose={() => setTextFor(null)}
        />
      )}
    </div>
  )
}

/** How many edge transitions `after` (an edit of `before`) took away from clips that are still there. */
function lostEdges(before: Project, after: Project): number {
  if (before === after) return 0
  const now = new Map(allClips(after).map((c) => [c.id, c]))
  let lost = 0
  for (const c of allClips(before)) {
    const next = now.get(c.id)
    if (!next) continue
    if (c.edgeIn && !next.edgeIn) lost++
    if (c.edgeOut && !next.edgeOut) lost++
  }
  return lost
}
