import type { FieldHelpMap } from "./types"

export const VIDEO_HELP: FieldHelpMap = {
  "video.project-name": {
    title: "Project name",
    what: "What the project is called in the Video Editing list.",
    use: "The project lives in its own folder named after it. Renaming changes the name and the folder; clips, settings and exported videos stay with it.",
  },
  "video.search": {
    title: "Search projects",
    what: "Narrows the list to projects whose name contains what you type.",
    use: "Only changes what you see here. Sorting still applies to the matches.",
  },
  "video.orientation": {
    title: "Orientation",
    what: "Whether the video is wide (Horizontal) or tall (Vertical).",
    use: "Sets the shape of the preview and of the exported video. A new project picks it from the first video or photo you add; you can change it any time. Clips keep their place and size relative to the frame.",
    values: [
      { label: "Horizontal", effect: "Wide, 16:9. For YouTube and TV." },
      { label: "Vertical", effect: "Tall, 9:16. For phones: Shorts, TikTok, Reels." },
    ],
  },
  "video.resolution": {
    title: "Resolution",
    what: "How sharp the exported video is, in pixels.",
    use: "Higher is sharper but makes bigger files that take longer to export. A new project matches its first video, up to Full HD. Changing it makes the next export render again.",
    values: [
      { label: "Ultra HD", effect: "3840 on the long side. Sharpest, biggest, slowest." },
      { label: "Full HD", effect: "1920 on the long side. The usual choice for YouTube and social media." },
      { label: "HD", effect: "1280 on the long side. Smaller file, fine for messages." },
      { label: "Standard", effect: "854 on the long side. Smallest and quickest, lower quality." },
    ],
  },
  "video.preview-layout": {
    title: "Preview layout",
    what: "Where the preview sits in the editor: above the timeline, or beside it.",
    use: "Only changes how the editor is laid out, in this browser. It does not change the video. Switching a project to Vertical moves the preview to the right; you can switch back.",
    values: [
      { label: "Horizontal", effect: "The preview is on top, the timeline below it." },
      { label: "Vertical", effect: "The preview is on the right, the timeline on the left. Drag the bar between them to resize." },
    ],
  },
  "video.zoom": {
    title: "Zoom",
    what: "How much of the timeline fits on screen. Zoomed in, one second is wider, so cuts are easier to place.",
    use: "Only changes the view. It does not change any clip, and it is not saved with the project.",
  },
  "video.waveforms": {
    title: "Audio waveforms",
    what: "Shows the shape of the sound inside audio and video clips on the timeline.",
    use: "Only changes the timeline's look. Dialogs that show a waveform, like Edit length, show it either way.",
  },
  "length.start": {
    title: "Start",
    what: "Where the clip begins on the timeline, in seconds from the start of the project.",
    use: "Changing it moves the whole clip, keeping its length. On layer 1, which snaps clips together, it follows the clips before it and can't be typed.",
  },
  "length.end": {
    title: "End",
    what: "Where the clip ends on the timeline. It always equals Start plus Length.",
    use: "Typing an End changes Length and leaves Start where it is.",
  },
  "length.length": {
    title: "Length",
    what: "How long the clip plays, in seconds. The shortest is 0.2 s.",
    use: "For a video or audio clip, a longer length can only reach the end of its source file. Changing it keeps Start and moves End.",
  },
  "length.mode": {
    title: "When it overlaps other media",
    what: "What happens to other clips on the same layer when the new timing runs into them.",
    use: "Only this layer is affected. Clips on other layers never move.",
    values: [
      { label: "Push later media", effect: "Clips after this one slide later to make room. Nothing is cut." },
      { label: "Overwrite", effect: "The clip covers whatever it overlaps. The covered part of those clips is trimmed or removed." },
    ],
  },
  "length.source": {
    title: "Source",
    what: "The whole media file as a waveform. The highlighted part is what the clip plays.",
    use: "Drag an edge to crop, or the middle to slide the same length across the file. Start and Length follow what you pick, and the clip stays where it is on the timeline.",
  },
  "length.in": {
    title: "In",
    what: "The time in the source file where the clip starts playing. Type seconds or m:ss.mmm.",
    use: "Use the Set to playhead button to take the time from the preview while it plays, then fine tune by 0.01 s.",
  },
  "length.out": {
    title: "Out",
    what: "The time in the source file where the clip stops. Type seconds or m:ss.mmm.",
    use: "Length becomes Out minus In. The clip keeps its Start on the timeline.",
  },
  "text.content": {
    title: "Text",
    what: "The words shown on the video. Enter starts a new line.",
    use: "Drawn on the preview and in the exported video in the font and color you pick.",
  },
  "text.color": {
    title: "Color",
    what: "The color of the letters. The swatches are colors other text clips in this project already use.",
    use: "The sample's background changes to a light or dark one so you can judge the contrast. The video behind the text is not changed.",
  },
  "text.shadow": {
    title: "Shadow",
    what: "A copy of the letters behind them, pushed off to one side. Pick its color, the direction it falls (drag the dial) and how far.",
    use: "The distance is a share of the text's size, so the shadow grows and shrinks with the text. It is solid, not blurred.",
  },
  "text.direction": {
    title: "Direction",
    what: "Whether the letters run across the frame or stack one above the other.",
    values: [
      { label: "Horizontal", effect: "Normal lines of text, read left to right." },
      { label: "Vertical (stacked)", effect: "Each letter sits below the last, read top to bottom." },
    ],
  },
  "text.font": {
    title: "Font",
    what: "The typeface for the text, grouped by mood.",
    use: "The exported video uses the same font file, so the text looks as it does here.",
  },
  "text.animation": {
    title: "Animation",
    what: "How the text arrives (In) or leaves (Out). None keeps it still.",
    use: "In plays from the clip's start and Out ends at the clip's end. The preview here repeats them with a pause between.",
  },
  "text.animation-length": {
    title: "Length",
    what: "How many seconds the animation takes.",
    use: "In and Out together can't be longer than the clip. If they are, both are shortened in proportion when you save.",
  },
  "transition.type": {
    title: "Transition",
    what: "How the picture changes from one clip to the next. Each tile shows a sample.",
    use: "Applies at the cut between the two clips. The preview loops the real two clips so you can judge it.",
  },
  "transition.duration": {
    title: "Duration",
    what: "How many seconds the transition takes.",
    use: "Half of it plays on each side of the cut, so each clip needs enough footage. The dialog shows the most it allows.",
  },
  "transition.audio-overlap": {
    title: "Audio overlap",
    what: "Lets the sound change at a different moment than the picture.",
    values: [
      { label: "None", effect: "Sound and picture change together." },
      { label: "J cut", effect: "The next clip's sound starts before its picture appears." },
      { label: "L cut", effect: "The first clip's sound carries on over the next picture." },
    ],
  },
  "transition.overlap": {
    title: "Overlap",
    what: "How many seconds the sound is shifted from the picture cut for a J or L cut.",
    use: "Only the sound moves. The picture cut stays where it is.",
  },
  "transition.audio-type": {
    title: "Audio transition",
    what: "The curve the sound follows as it blends from one clip into the next, or a creative blend.",
    use: "Applies in the preview and in the exported video. Equal power keeps the loudness steady through the blend.",
  },
  "transition.edge": {
    title: "Transition in or out",
    what: "How a clip comes in from nothing or goes out to nothing, such as a fade from black or a fade-out of sound.",
    use: "Applies at the clip's own start or end, not between two clips.",
  },
  "audio.volume": {
    title: "Volume",
    what: "Makes the clip's sound louder or quieter, in decibels. 0 dB leaves it as recorded. Up to +24 dB or down to -60 dB.",
    use: "Applied before the effects. Muting a clip still wins over any volume.",
  },
  "audio.presets": {
    title: "Presets",
    what: "A ready-made set of effects. Picking one replaces the effects listed under Applied.",
    use: "Fine tune the effects afterwards, or press Remove all to start again.",
  },
  "audio.applied": {
    title: "Applied effects",
    what: "The effects on this clip, at most four, in the order they run. The first one hears the sound first.",
    use: "Order matters: reverb before a telephone filter sounds different from after it. Use the arrows to reorder.",
  },
  "audio.effects": {
    title: "Effects",
    what: "Filters for the clip's sound, in groups: clean-up and tone, space, character and creative.",
    use: "Some effects can't be played faithfully in the preview and are marked. They are always in the exported video.",
  },
  "audio.amount": {
    title: "Effect amount",
    what: "How strong the effect is, from barely there to full.",
    use: "Only effects with a slider have one. The preview updates as you drag.",
  },
}
