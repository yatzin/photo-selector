"use client"

import { FieldHelp } from "@/components/ui/field-help"
import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { InHeader } from "@/components/header-slot"
import { ArrowLeft, AudioWaveform, Blend, Check, Download, Loader2, Eraser, Layers, Palette, PanelLeftClose, PanelLeftOpen, Pause, Play, Redo2, Repeat, RotateCcw, SkipBack, SquareSplitHorizontal, Trash2, TriangleAlert, Type, Undo2 } from "lucide-react"
import { toast } from "sonner"
import { Button, buttonVariants } from "@/components/ui/button"
import { useStoredValue } from "@/lib/hooks/use-stored-state"
import { deleteAssetAction, setBackgroundAction, exportStatusAction, createTemplateAction, importAssetAction, previewRetimeAction, retimeAssetAction, saveTemplateSlotsAction, startExportAction } from "@/lib/actions/video-projects"
import { importStockAction } from "@/lib/actions/stock"
import { stockKey } from "@/lib/stock/drag"
import type { StockRef } from "@/lib/stock/types"
import { mediaUrl } from "@/lib/format"
import { cn } from "@/lib/utils"
import { newId } from "@/lib/video/ids"
import { canRedo, canUndo, commit, createHistory, redo, undo, type History } from "@/lib/video/history"
import {
  addClip, addTextClip, allClips, placeDropped, placeDroppedText, assetLabel, newClipLength, assetKind, AUDIO_TRACK, backgroundOf, baseInsertion, clipEnd, clipLength, clipsAt, DEFAULT_BACKGROUND, DEFAULT_IMAGE, editOf, freeTrackFor, isAudioClip, isLooping, isMagnetic, isTextClip, MAX_TRACKS, removeAsset,
  pasteClip, removeClip, resolveStart, retimeClip, rippleRemoveClip, setClipAudio, setClipKey, setClipMuted, setClipText, setTransform, splitClip, totalLength, trackAt, trackEnd, type Asset, type Clip, type Edit, type Project,
} from "@/lib/video/project"
import { withStockDropSize } from "@/lib/video/stock-drop"
import { DEFAULT_TEXT } from "@/lib/video/text"
import { usedTextColors } from "@/lib/video/text-colors"
import { DEFAULT_ZOOM, sliderToZoom, zoomToSlider } from "@/lib/video/timeline-math"
import { dragMove, IDENTITY, isIdentity, withScale } from "@/lib/video/transform"
import { ZoomControl } from "./zoom-control"
import { TransparentDialog } from "./transparent-dialog"
import { SpeedDialog } from "./speed-dialog"
import { TemplateSetupDialog } from "./template-setup-dialog"
import type { KeyOptions } from "@/lib/video/chroma"
import { formatTimecode } from "@/lib/video/time"
import { applyCut, cutsOf, edgeTransitionName, setEdgeTransition } from "@/lib/video/transitions"
import type { Edge } from "@/lib/video/transition-types"
import { AudioLevelsDialog } from "./audio-levels-dialog"
import { EditTextDialog, type TextSection } from "./edit-text-dialog"
import { FileTree, type TempFolder } from "./file-tree"
import { BackgroundPicker } from "./background-picker"
import { FormatMenus } from "./format-menu"
import { ORIENTATIONS, orientationOf, RESOLUTIONS, resolutionOf, sizeText, type Orientation } from "@/lib/video/format"
import { ImportButton } from "./import-button"
import { Preview, type MediaDrop } from "./preview"
import { ResizeHandle } from "./resize-handle"
import { usePreviewPlayer } from "./use-preview-player"
import { TEXT_DRAG_TYPE, Timeline, type DropTarget, type PasteAt, type PendingDrop } from "./timeline"
import { TransitionDialog, type TransitionTarget } from "./transition-dialog"
import { useAutosave } from "./use-autosave"
import { useMediaImport } from "./use-media-import"

// The editor: file tree on the left, preview in the middle, timeline below.
// Slice 1 shell: import, add to timeline and autosave; drag/trim/split come
// with the timeline interactions, playback with the preview player.

const MIN_PREVIEW = 120 // px
const MIN_TIMELINE = 160 // px
const HANDLE = 8 // px, the resize handle's height (or width, beside the timeline)
const MIN_PREVIEW_W = 220 // px, the preview when it sits beside the timeline
const MIN_TIMELINE_W = 480 // px, the timeline when the preview sits beside it
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
  folder, userFolder, initial, temp,
}: {
  folder: string
  userFolder: string
  initial: Project
  temp: TempFolder[]
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
  // The clip whose Audio levels dialog is open.
  const [audioFor, setAudioFor] = useState<string | null>(null)
  // The image clip whose background the Make background transparent dialog is working on.
  const [transparentFor, setTransparentFor] = useState<string | null>(null)
  // The video clip whose Speed / Reverse dialog is open.
  const [speedFor, setSpeedFor] = useState<string | null>(null)
  // The template setup dialog: create one from this project, or change this template's slots.
  const [templateSetup, setTemplateSetup] = useState<"create" | "edit" | null>(null)
  const audioClip = audioFor ? allClips(project).find((c) => c.id === audioFor) : undefined
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
  // A Stock result dropped on the timeline and still downloading: the timeline holds its place with a spinner.
  const [pending, setPending] = useState<PendingDrop | null>(null)
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
  // Preview layout: above the timeline, or on the right of it. Each video orientation remembers the layout last chosen for it (in this browser) and every project of that orientation opens with it; until one is chosen the preview follows the orientation.
  const videoOrientation = orientationOf(project.width, project.height)
  const [horizontalLayout, setHorizontalLayout] = useStoredValue("ps.video.previewLayout.horizontal")
  const [verticalLayout, setVerticalLayout] = useStoredValue("ps.video.previewLayout.vertical")
  const storedLayout = videoOrientation === "horizontal" ? horizontalLayout : verticalLayout
  const setStoredLayout = videoOrientation === "horizontal" ? setHorizontalLayout : setVerticalLayout
  const layout: Orientation = storedLayout === "horizontal" || storedLayout === "vertical" ? storedLayout : videoOrientation
  const sideBySide = layout === "vertical"
  // The media panel on the left: folded to a thin rail, remembered in this browser (the server and first paint show it open).
  const [storedCollapsed, setStoredCollapsed] = useStoredValue("ps.video.mediaCollapsed")
  const mediaCollapsed = storedCollapsed === "1"
  const [storedWidth, setStoredWidth] = useStoredValue("ps.video.previewWidth")
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const parsedWidth = storedWidth ? Number(storedWidth) : NaN
  const previewWidth = dragWidth ?? (parsedWidth >= MIN_PREVIEW_W ? parsedWidth : null)
  const column = useRef<HTMLDivElement>(null)
  const previewBox = useRef<HTMLDivElement>(null)
  const [sizes, setSizes] = useState({ preview: 0, column: 0, previewW: 0, columnW: 0 })
  useEffect(() => {
    const col = column.current
    const pre = previewBox.current
    if (!col || !pre) return
    const ro = new ResizeObserver(() => setSizes({ preview: Math.round(pre.offsetHeight), column: col.clientHeight, previewW: Math.round(pre.offsetWidth), columnW: col.clientWidth }))
    ro.observe(col)
    ro.observe(pre)
    return () => ro.disconnect()
  }, [])
  const maxPreview = Math.max(MIN_PREVIEW, sizes.column - HANDLE - MIN_TIMELINE)
  const maxPreviewW = Math.max(MIN_PREVIEW_W, sizes.columnW - HANDLE - MIN_TIMELINE_W)
  // Beside the timeline the preview starts about as wide as a tall frame fits its height (plus the margin round it).
  const defaultPreviewW = sizes.column > 0 ? Math.min(maxPreviewW, Math.max(MIN_PREVIEW_W, Math.round((sizes.column * 9) / 16) + 32)) : null

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
    (assetId: string, key?: KeyOptions) => {
      const asset = project.assets[assetId]
      if (!asset || assetKind(asset) !== "image") return ""
      // A keyed clip shows its background-cleared picture, made on the server from the same image.
      if (key) return `/api/video-keyed/${encodeURIComponent(folder)}?asset=${encodeURIComponent(assetId)}&r=${key.key[0]}&g=${key.key[1]}&b=${key.key[2]}&tol=${key.tolerance}&c=${key.contiguous ? 1 : 0}`
      return mediaUrl("video-projects", [userFolder, folder, "assets"], asset.file, "preview", assetId)
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
  /** A video's or a sound file's URL, for the Edit length dialog's preview. */
  const lengthMediaUrl = useCallback((assetId: string) => videoUrl(assetId) || audioUrl(assetId), [videoUrl, audioUrl])
  const [storedLoop, setStoredLoop] = useStoredValue("ps.video.loop")
  const loop = storedLoop === "1"
  const player = usePreviewPlayer(project, videoUrl, audioUrl, loop)
  // Import: files from the computer land in Project media as each one finishes (the server owns assets: take the new one from its reply).
  /** The project's size changed (chosen in the format menus, or taken from a new project's first picture). */
  const applySize = useCallback((size: { width: number; height: number }, announce = false) => {
    setEditor((s) => ({ ...s, meta: { ...s.meta, width: size.width, height: size.height } }))
    if (announce) {
      const orientation = ORIENTATIONS.find((o) => o.id === orientationOf(size.width, size.height))!.label
      const named = RESOLUTIONS.find((r) => r.id === resolutionOf(size.width, size.height))
      toast.info(`Video set to ${orientation}, ${named ? named.label : sizeText(size.width, size.height)}, to match your first clip. Change it in the top bar.`)
    }
  }, [])
  /** The canvas color: the preview follows at once, the server (which owns it) is told once the picking pauses. */
  const [bgPicker, setBgPicker] = useState<{ x: number; y: number } | null>(null)
  const closeBgPicker = useCallback(() => setBgPicker(null), [])
  const bgSave = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setBackground = useCallback(
    (color: string) => {
      setEditor((s) => {
        const meta = { ...s.meta }
        delete meta.background
        return { ...s, meta: color === DEFAULT_BACKGROUND ? meta : { ...meta, background: color } }
      })
      if (bgSave.current) clearTimeout(bgSave.current)
      bgSave.current = setTimeout(() => {
        void setBackgroundAction(folder, color).then((r) => "error" in r && toast.error(r.error), () => toast.error("Couldn't save the background color."))
      }, 400)
    },
    [folder]
  )
  const importer = useMediaImport(folder, (id, asset, format) => {
    setEditor((s) => ({ ...s, meta: { ...s.meta, assets: { ...s.meta.assets, [id]: asset } } }))
    if (format) applySize(format, true)
  })
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

  /** Opens the Audio levels dialog for clip `id`; the player pauses (silent) while only the dialog's preview plays. */
  const openAudio = (id: string) => {
    player.pause()
    setAudioFor(id)
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

  /** Copies a Personal Storage file (inboxFolder is its path, "user/sub") into Project media (or finds the copy already there); its asset id and asset, or null when it failed. */
  async function importFile(inboxFolder: string, name: string): Promise<{ id: string; asset: Asset } | null> {
    if (importingRef.current) {
      toast.info("Wait for the current import to finish.")
      return null
    }
    importingRef.current = true
    setImporting(`${inboxFolder}/${name}`)
    try {
      const r = await importAssetAction(folder, inboxFolder.split("/"), name)
      if ("error" in r) {
        toast.error(r.error)
        return null
      }
      // The server owns assets: take the new one from its reply.
      setEditor((s) => ({ ...s, meta: { ...s.meta, assets: { ...s.meta.assets, [r.id]: r.asset } } }))
      if (r.format) applySize(r.format, true)
      return { id: r.id, asset: r.asset }
    } catch {
      toast.error("Something went wrong importing that file.")
      return null
    } finally {
      importingRef.current = false
      setImporting(null)
    }
  }

  /** A Personal Storage file dropped on Project media (or chosen from its menu): copied in, not placed. */
  async function copyToMedia(inboxFolder: string, name: string) {
    const known = Object.values(latest.current.assets).some((a) => a.source === `${inboxFolder}/${name}`)
    const imported = await importFile(inboxFolder, name)
    if (imported) toast.success(known ? `${name} is already in Project media` : `Copied ${name} to Project media`)
  }

  /** A Personal Storage file dropped on the timeline: import it, then put it where it was dropped. */
  async function dropFromInbox(inboxFolder: string, name: string, target: DropTarget) {
    const imported = await importFile(inboxFolder, name)
    if (!imported) return
    const id = newId()
    // Clips may have changed while importing; addClip slides the clip clear of the others, and a layer
    // removed meanwhile makes the clip a new top layer rather than dropping it.
    edit((p) => placeDropped(p, imported.id, Math.min(target.track, p.tracks.length), target, id))
    // The ghost had a guessed length before the import: say so when the real length slid the clip along.
    if (target.on) return
    const p = latest.current
    const track = Math.min(target.track, p.tracks.length)
    const length = newClipLength(imported.asset)
    const start = landing(p, track, length, target.start, id)
    if (Math.abs(start - target.start) > 0.05) toast.info(`Placed at ${formatTimecode(start)} to avoid overlap`)
  }

  /**
   * Downloads a Stock tab result into Project media (or finds the asset made from it before); its asset id and
   * asset, or null when it failed. Shares importFile's one-at-a-time guard: a second drop while one is
   * downloading is turned away with the same notice, not queued.
   */
  async function importStock(ref: StockRef): Promise<{ id: string; asset: Asset } | null> {
    if (importingRef.current) {
      toast.info("Wait for the current import to finish.")
      return null
    }
    importingRef.current = true
    setImporting(stockKey(ref))
    try {
      const r = await importStockAction(folder, ref)
      if ("error" in r) {
        toast.error(r.error)
        return null
      }
      // The server owns assets: take the new (or reused) one from its reply.
      setEditor((s) => ({ ...s, meta: { ...s.meta, assets: { ...s.meta.assets, [r.id]: r.asset } } }))
      if (r.format) applySize(r.format, true)
      return { id: r.id, asset: r.asset }
    } catch {
      toast.error("Something went wrong downloading that file.")
      return null
    } finally {
      importingRef.current = false
      setImporting(null)
    }
  }

  /** A Stock tab result dropped on Project media: downloaded in, not placed. */
  async function stockToMedia(ref: StockRef) {
    const known = Object.values(latest.current.assets).some((a) => a.source === stockKey(ref))
    const imported = await importStock(ref)
    if (imported) toast.success(known ? `${assetLabel(imported.asset)} is already in Project media` : `Added ${assetLabel(imported.asset)} to Project media`)
  }

  /** A Stock tab result dropped on the timeline: download it, then put it where it was dropped (a sound on the audio layer). */
  async function dropFromStock(ref: StockRef, target: DropTarget, shownLength: number) {
    setPending({ track: target.track, start: target.start, length: shownLength, audio: ref.kind === "audio" })
    let imported: Awaited<ReturnType<typeof importStock>>
    try {
      imported = await importStock(ref)
    } finally {
      setPending(null)
    }
    if (!imported) return
    const audio = assetKind(imported.asset) === "audio"
    // Dropped on the audio layer as an audio result, but the file isn't a sound file: the layer takes sound only.
    if (target.track === AUDIO_TRACK && !audio) {
      toast.info("Only sound files go on the audio layer. The file is in Project media.")
      return
    }
    const id = newId()
    // As dropFromInbox: addClip slides the clip clear of clips added meanwhile, and puts a sound on the audio layer.
    edit((p) => placeDropped(p, imported.id, Math.min(target.track, p.tracks.length), target, id))
    if (target.on) return
    const p = latest.current
    const length = newClipLength(imported.asset)
    const start = audio
      ? resolveStart(trackAt(p, AUDIO_TRACK)?.clips ?? [], length, target.start, id)
      : landing(p, Math.min(target.track, p.tracks.length), length, target.start, id)
    if (Math.abs(start - target.start) > 0.05) toast.info(`Placed at ${formatTimecode(start)} to avoid overlap`)
  }

  /**
   * A file dropped on the player: a clip at the playhead (as it was at the
   * drop) on the lowest layer free for its whole length there, a new layer when
   * none is (up to MAX_TRACKS), selected so its frame shows. A Personal Storage file (or a
   * Stock tab result) is imported first and placed in the project as it is then. One undo step.
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
      const imported = drop.kind === "stock" ? await importStock(drop.ref) : await importFile(drop.folder, drop.name)
      if (!imported) return
      assetId = imported.id
      asset = imported.asset
    }
    const length = newClipLength(asset)
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
    // A stock result dropped on the scene comes in small and centred, not full frame.
    const small = drop.kind === "stock"
    edit((p) => {
      const free = freeTrackFor(p, at, length)
      if (free === null) return p
      const added = addClip(p, assetId, free, { start: at }, id)
      return small ? withStockDropSize(added, id) : added
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
    const file = Object.hasOwn(before.assets, assetId) ? assetLabel(before.assets[assetId]) : "the file"
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

  /** The Add text button dropped on the timeline: a text clip at that layer and time (or beside the clip it hit), selected, nothing opened. One undo step. */
  function dropText(target: DropTarget) {
    const id = newId()
    edit((p) => placeDroppedText(p, DEFAULT_TEXT, Math.min(target.track, p.tracks.length), target, id))
    setSelectedId(id)
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
  const splitCandidate = selectedId
    ? (playheadHits.tracks.find((h) => h?.clip.id === selectedId)?.clip.id ?? (selectedAudio && playhead >= selectedAudio.start && playhead < clipEnd(selectedAudio) ? selectedAudio.id : null))
    : (playheadHits.top?.clip.id ?? null)
  // A looping clip isn't split (splitClip isn't loop-aware): turn Loop off first.
  const splitClipFound = splitCandidate ? allClips(project).find((c) => c.id === splitCandidate) : undefined
  const splitTarget = splitClipFound && isLooping(project, splitClipFound) ? null : splitCandidate

  /** Splits at the playhead (S, or the toolbar); false when there's no clip under it. One undo step. */
  function splitAtPlayhead(): boolean {
    if (!splitTarget) return false
    const id = splitTarget
    const at = playhead
    const splitId = newId()
    edit((p) => splitClip(p, id, at, splitId))
    return true
  }

  /** Ripple delete (Shift+Delete, or the clip's menu): removes the selected clip and closes the gap on its layer; false with no selection. One undo step. */
  function rippleDeleteSelected(): boolean {
    if (!selectedId) return false
    const id = selectedId
    edit((p) => rippleRemoveClip(p, id))
    setSelectedId(null)
    return true
  }

  // The copied clip (every setting with it) and the layer it came from; Ctrl+C / Ctrl+V and the clip's menu.
  const [clipboard, setClipboard] = useState<{ clip: Clip; track: number } | null>(null)

  /** Copies clip `id` (default: the selected one) for pasting; false when there's none. */
  function copyClip(id: string | null = selectedId): boolean {
    if (!id) return false
    const p = latest.current
    const clip = allClips(p).find((c) => c.id === id)
    if (!clip) return false
    const track = trackAt(p, AUDIO_TRACK)?.clips.some((c) => c.id === id) ? AUDIO_TRACK : p.tracks.findIndex((t) => t.clips.some((c) => c.id === id))
    setClipboard({ clip: JSON.parse(JSON.stringify(clip)) as Clip, track })
    toast.success("Copied. Paste puts it at the playhead.")
    return true
  }

  // Filled by the timeline: where the mouse is over it (layer, time, the clip under it).
  const pasteAt = useRef<(() => PasteAt | null) | null>(null)

  /**
   * Pastes the copied clip under the mouse: on the layer it's over, at the time
   * under it, in front of or behind a clip it's over, the clips after it moving
   * later to make room. With the mouse elsewhere it goes at the playhead on the
   * layer it came from. False with nothing copied. One undo step.
   */
  function pasteCopied(): boolean {
    if (!clipboard) return false
    const id = newId()
    const at = pasteAt.current?.() ?? null
    // A picture clip can't go on the audio layer: it keeps its own layer there.
    const track = at && at.track !== AUDIO_TRACK ? at.track : clipboard.track
    const start = at ? at.start : playhead
    edit((p) => pasteClip(p, clipboard.clip, track, start, id, at?.on))
    if (allClips(latest.current).some((c) => c.id === id)) setSelectedId(id)
    else toast.info("There's no room to paste it there.")
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

  /** The selected image or video clip, whose picture the toolbar's zoom scales (not a text or a sound). */
  const zoomClip = selectedClip && !isTextClip(selectedClip) && project.assets[selectedClip.asset] && assetKind(project.assets[selectedClip.asset]) !== "audio" ? selectedClip : undefined
  const transparentClip = transparentFor ? allClips(project).find((c) => c.id === transparentFor) : undefined

  /** Saves this project as a template (a copy; the project is unchanged), or changes this template's slots. Resolves to an error message, or null. */
  async function saveTemplateSetup(input: { name: string; description: string; slots: Record<string, string> }): Promise<string | null> {
    try {
      // The server works from what is stored: send pending edits first.
      if (!(await flush())) return "Couldn't save your latest edits first. Try again."
      if (templateSetup === "edit") {
        const r = await saveTemplateSlotsAction(folder, { description: input.description, slots: input.slots })
        if ("error" in r) return r.error
        // Replaceable clips now hold placeholders and their media is gone: reload the project as stored (the undo history starts over).
        setEditor(initialState(r.project))
        setSelectedId(null)
        toast.success("Template slots saved. Replaceable clips now show placeholders.")
        return null
      }
      const r = await createTemplateAction(folder, input)
      if ("error" in r) return r.error
      toast.success(`Template “${input.name}” saved. Start a project from it on the Video Editing page.`)
      return null
    } catch {
      return "Something went wrong saving the template."
    }
  }

  const speedClip = speedFor ? allClips(project).find((c) => c.id === speedFor) : undefined

  /** Speed / Reverse: the server makes the retimed copy (or gives the original back), then the clip points at it. One undo step. Resolves to an error message, or null. */
  async function applySpeed(clip: Clip, speed: number, reverse: boolean): Promise<string | null> {
    try {
      const r = await retimeAssetAction(folder, clip.asset, { in: clip.in, out: clip.out, speed, reverse })
      if ("error" in r) return r.error
      setEditor((s) => ({ ...s, meta: { ...s.meta, assets: { ...s.meta.assets, [r.id]: r.asset } } }))
      const id = clip.id
      // Checked on the project as it is now plus the new asset (the edit itself lands on the next render).
      const now = latest.current
      const probe = { ...now, assets: { ...now.assets, [r.id]: r.asset } }
      if (retimeClip(probe, id, r.id, r.in, r.out) === probe) return "There isn't room on the timeline for that length."
      edit((p) => retimeClip(p, id, r.id, r.in, r.out))
      return null
    } catch {
      return "Something went wrong changing the speed."
    }
  }

  /** Sets (or clears) the clip's transparent background; the image file is untouched and the player and export draw it keyed. One undo step. */
  function applyKey(clipId: string, key: KeyOptions | undefined) {
    edit((p) => setClipKey(p, clipId, key))
  }

  /** Sets the selected picture's zoom (1 = fit the frame) about its centre. One undo step. */
  function zoomSelected(scale: number) {
    if (!zoomClip) return
    const id = zoomClip.id
    edit((p) => {
      const clip = allClips(p).find((c) => c.id === id)
      return clip ? setTransform(p, id, withScale(clip.transform ?? IDENTITY, scale)) : p
    })
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
        } else if (key === "c" && !e.shiftKey) {
          if (copyClip()) e.preventDefault()
        } else if (key === "v" && !e.shiftKey) {
          if (pasteCopied()) e.preventDefault()
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
        if (e.shiftKey ? rippleDeleteSelected() : deleteSelected()) e.preventDefault()
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
      {bgPicker && <BackgroundPicker x={bgPicker.x} y={bgPicker.y} color={backgroundOf(project)} onChange={setBackground} onClose={closeBgPicker} />}
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4">
        <div className="flex min-w-0 items-center gap-3">
        {/* The way back, the project's name and its save status live in the site header. */}
        <InHeader>
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
        </InHeader>
        <ImportButton importer={importer} />
        {project.template?.master && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setTemplateSetup("edit")} title="Change which clips are replaceable and their labels">
            <Layers className="h-4 w-4" /> Template slots
          </Button>
        )}
        {!project.template?.master && allClips(project).length > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setTemplateSetup("create")} title="Save this project as a template with replaceable clips">
            <Layers className="h-4 w-4" /> Create template
          </Button>
        )}
        <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
        <div role="toolbar" aria-label="Edit tools" className="flex min-w-0 items-center gap-1 overflow-hidden text-xs text-muted-foreground">
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
        <Button type="button" size="sm" variant="ghost" onClick={addText} draggable onDragStart={(e) => { e.dataTransfer.setData(TEXT_DRAG_TYPE, "1"); e.dataTransfer.effectAllowed = "copy" }} title="Add a text clip at the playhead, or drag it onto the timeline">
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
        {zoomClip && (
          <Button type="button" size="sm" variant="ghost" onClick={() => { player.pause(); setTransparentFor(zoomClip.id) }} title={zoomClip.key ? "Change or remove the transparent background" : "Make the background transparent"} aria-label="Make background transparent">
            <Eraser className={cn("h-4 w-4", zoomClip.key && "text-editor-accent")} /> Transparency
          </Button>
        )}
        {zoomClip && <ZoomControl scale={zoomClip.transform?.scale ?? 1} onChange={zoomSelected} />}
        {transformed && (
          <Button type="button" size="sm" variant="ghost" onClick={resetTransform} title="Put the selected clip's picture back to fit the frame" aria-label="Reset size, position, crop, rotation and flips">
            <RotateCcw className="h-4 w-4" /> Reset
          </Button>
        )}
        </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={exportProgress !== null}
          aria-haspopup="dialog"
          aria-label="Background color"
          title={exportProgress !== null ? "Not while exporting" : "Color shown where no clip covers the picture"}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setBgPicker({ x: r.right - 224, y: r.bottom + 4 })
          }}
        >
          <Palette className="h-4 w-4" />
          <span aria-hidden className="size-3.5 rounded-sm ring-1 ring-black/20 ring-inset dark:ring-white/30" style={{ backgroundColor: backgroundOf(project) }} />
        </Button>
        <FormatMenus width={project.width} height={project.height} folder={folder} disabled={exportProgress !== null} onChanged={(size) => {
          // Turning the video to the other orientation brings that orientation's remembered layout with it.
          applySize(size)
        }} layout={layout} onLayout={setStoredLayout} />
        <Button type="button" size="sm" onClick={startExport} disabled={allClips(project).length === 0 || exportProgress !== null}>
          {exportProgress === null ? <Download className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
          {exportProgress === null ? "Export" : `Exporting ${Math.round(exportProgress * 100)}%`}
        </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside aria-label="Media" className={cn("hidden shrink-0 flex-col border-r border-border/60 transition-[width] duration-150 motion-reduce:transition-none md:flex", mediaCollapsed ? "w-11" : "w-64")}>
          {/* Like the site's side nav: a button at the top folds the panel to a thin rail and opens it again. */}
          <div className={cn("flex h-9 shrink-0 items-center border-b border-border/60", mediaCollapsed ? "justify-center" : "justify-between pl-3 pr-1.5")}>
            {!mediaCollapsed && <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Media</span>}
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => setStoredCollapsed(mediaCollapsed ? "0" : "1")}
              aria-expanded={!mediaCollapsed}
              aria-label={mediaCollapsed ? "Expand media panel" : "Collapse media panel"}
              title={mediaCollapsed ? "Expand media panel" : "Collapse media panel"}
            >
              {mediaCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </Button>
          </div>
          {/* Kept mounted while folded, so open folders and what was loaded are still there on reopening. */}
          <div className={cn("min-h-0 flex-1", mediaCollapsed && "hidden")}>
            <FileTree temp={temp} project={project} thumbUrl={thumbUrl} importing={importing} onAdd={addToTimeline} onDelete={deleteMedia} onImportFiles={importer.add} onCopyTemp={(f, n) => void copyToMedia(f, n)} onImportStock={(r) => void stockToMedia(r)} />
          </div>
        </aside>
        <div ref={column} className={cn("flex min-w-0 flex-1", sideBySide ? "flex-row-reverse" : "flex-col")}>
          {/* With a set height the preview gives way first (flex-shrink) and the timeline grows; CSS keeps both minimums. */}
          <div
            ref={previewBox}
            className={cn("flex flex-col", sideBySide ? "min-w-[220px]" : "min-h-[120px]", !sideBySide && previewHeight === null && "flex-1")}
            style={sideBySide ? { flex: `0 1 ${previewWidth ?? defaultPreviewW ?? "40%"}${typeof (previewWidth ?? defaultPreviewW) === "number" ? "px" : ""}` } : previewHeight === null ? undefined : { flex: `0 1 ${previewHeight}px` }}
          >
            <Preview player={player} project={project} imageUrl={imageUrl} selectedId={selectedId} onSelect={setSelectedId} onChange={edit} onDrop={(d) => void dropOnPlayer(d)} onEditText={openText} onBackgroundMenu={exportProgress === null ? (x, y) => setBgPicker({ x, y }) : undefined} />
          </div>
          {sideBySide ? (
            <ResizeHandle
              axis="x"
              sizes="after"
              label="Resize preview width"
              value={Math.min(maxPreviewW, Math.max(MIN_PREVIEW_W, sizes.previewW))}
              min={MIN_PREVIEW_W}
              max={maxPreviewW}
              onResize={(px, done) => {
                if (!done) return setDragWidth(px)
                setStoredWidth(String(px))
                setDragWidth(null)
              }}
              onReset={() => {
                setStoredWidth("")
                setDragWidth(null)
              }}
            />
          ) : (
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
          )}
          {/* The tracks scroll inside the timeline (vertically too, with several layers); the bar above stays put. */}
          <div className={cn("flex flex-col bg-card", sideBySide ? "min-w-[480px] min-h-0 flex-1" : previewHeight === null ? "max-h-[60%] shrink-0" : "min-h-[160px] flex-1")}>
            {/* Three parts: the edit tools, Play/Pause in the middle of the bar whatever the sides hold, the view settings. */}
            <div
              role="toolbar"
              aria-label="Timeline tools"
              className="grid h-9 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-border/60 px-3 text-xs text-muted-foreground"
            >
              <div className="flex h-full min-w-0 items-center gap-1 overflow-hidden px-0.5">
                <span className="shrink-0 tabular-nums">{formatTimecode(playhead)} / {formatTimecode(totalLength(project))}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={player.playFromStart}
                  disabled={totalLength(project) === 0}
                  title="Play from start"
                  aria-label="Play from start"
                >
                  <SkipBack className="h-4 w-4" />
                </Button>
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
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setStoredLoop(loop ? "0" : "1")}
                  aria-pressed={loop}
                  title={loop ? "Loop playback (on)" : "Loop playback (off)"}
                  aria-label="Loop playback"
                  className={cn(loop && "bg-editor-accent/20 text-editor-accent hover:bg-editor-accent/30")}
                >
                  <Repeat className="h-4 w-4" />
                </Button>
              </div>
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
                <FieldHelp id="video.waveforms" />
                <label className="flex min-w-0 items-center gap-2">
                  Zoom<FieldHelp id="video.zoom" className="-ml-1" />
                  <input type="range" min={0} max={1} step={0.001} value={zoomToSlider(zoom)} onChange={(e) => setZoom(sliderToZoom(Number(e.target.value)))} className="w-28 min-w-0 accent-editor-accent" />
                </label>
              </div>
            </div>
            <Timeline project={project} folder={folder} thumbUrl={thumbUrl} selectedId={selectedId} playhead={playhead} zoom={zoom} waveforms={waveforms} onZoom={setZoom} onSelect={setSelectedId} onSeek={player.seek} onScrub={scrub} onChange={edit} onDropInbox={(f, n, t) => void dropFromInbox(f, n, t)} onDropStock={(r, t, len) => void dropFromStock(r, t, len)} pending={pending} playing={player.playing} onDropText={dropText} onEditText={openText} onTransition={openTransition} onEdgeTransition={openEdge} onEditAudio={openAudio} mediaUrl={lengthMediaUrl} onEditLength={player.pause} transitionFor={transitionFor} onCopy={copyClip} onPaste={pasteCopied} canPaste={clipboard !== null} pasteAt={pasteAt} onSpeed={(id) => { player.pause(); setSpeedFor(id) }} />
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
      {templateSetup && (
        <TemplateSetupDialog
          mode={templateSetup}
          project={project}
          initial={templateSetup === "edit" ? project.template : undefined}
          defaultName={templateSetup === "create" ? `${project.name} template` : undefined}
          thumbUrl={thumbUrl}
          onSelectClip={setSelectedId}
          onSave={saveTemplateSetup}
          onClose={() => setTemplateSetup(null)}
        />
      )}
      {speedClip && !isTextClip(speedClip) && project.assets[speedClip.asset] && (
        <SpeedDialog
          key={speedClip.id}
          assetId={speedClip.asset}
          asset={project.assets[speedClip.asset]}
          trimIn={speedClip.in}
          trimOut={speedClip.out}
          name={assetLabel(project.assets[speedClip.asset])}
          onApply={(speed, reverse) => applySpeed(speedClip, speed, reverse)}
          onPreview={async (speed, reverse) => {
            try {
              return await previewRetimeAction(folder, speedClip.asset, { in: speedClip.in, out: speedClip.out, speed, reverse })
            } catch {
              return { error: "Something went wrong making the preview." }
            }
          }}
          onClose={() => setSpeedFor(null)}
        />
      )}
      {transparentClip && (
        <TransparentDialog
          key={transparentClip.id}
          imageUrl={imageUrl(transparentClip.asset)}
          video={
            assetKind(project.assets[transparentClip.asset]) === "video"
              ? { url: videoUrl(transparentClip.asset), at: transparentClip.in + Math.min(Math.max(0, playhead - transparentClip.start), Math.max(0, clipLength(transparentClip) - 0.05)) % Math.max(0.1, project.assets[transparentClip.asset].duration) }
              : undefined
          }
          name={assetLabel(project.assets[transparentClip.asset])}
          initial={transparentClip.key}
          onApply={(options) => applyKey(transparentClip.id, options)}
          onRemove={() => applyKey(transparentClip.id, undefined)}
          onClose={() => setTransparentFor(null)}
        />
      )}
      {audioClip && (
        <AudioLevelsDialog
          key={audioClip.id}
          project={project}
          folder={folder}
          clip={audioClip}
          playhead={playhead}
          mediaUrl={isAudioClip(project, audioClip) ? audioUrl(audioClip.asset) : videoUrl(audioClip.asset)}
          onApply={(audio) => {
            const id = audioClip.id
            edit((p) => setClipAudio(p, id, audio))
          }}
          onClose={() => setAudioFor(null)}
        />
      )}
      {textClip && isTextClip(textClip) && (
        <EditTextDialog
          key={textClip.id}
          text={textClip.text}
          length={clipLength(textClip)}
          section={textSection}
          usedColors={usedTextColors(project, textClip.id)}
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
