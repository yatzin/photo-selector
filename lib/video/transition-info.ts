import type { AudioTransitionType, TransitionType } from "./transition-types"

// What each transition does and when to use it: the guidance the Transition
// dialog shows under its preview. Plain data, safe on the client.

export type TransitionGuide = { does: string; bestFor: string; avoid: string }

export const TRANSITION_GUIDES: Record<TransitionType | "none", TransitionGuide> = {
  none: {
    does: "A hard cut: the next clip replaces the previous one on a single frame.",
    bestFor: "Most edits; fast-paced Reels and TikToks cut to the beat; dialogue and interviews where you want no distraction.",
    avoid: "A jump in time or place that viewers might miss; two shots so alike that the cut reads as a glitch (a jump cut you didn't mean).",
  },
  fade: {
    does: "The previous clip dissolves into the next one: both are visible, blended, for the length of the transition.",
    bestFor: "Showing time passing; a slow montage of travel or event shots; softening a cut between two calm scenes.",
    avoid: "Fast, beat-driven edits where it looks sluggish; every cut in a video (it starts to feel like a slideshow); action you want to feel sudden.",
  },
  fadeblack: {
    does: "The previous clip fades down to black, then the next one fades up from black.",
    bestFor: "Ending a chapter or a scene; the start or end of a video; a pause before a reveal or a punchline.",
    avoid: "The middle of a continuous moment, where it feels like the video ended; short social clips where every second counts.",
  },
  fadewhite: {
    does: "The previous clip flashes up to white, then the next one comes down out of the white.",
    bestFor: "Dreamy or nostalgic moments; flashbacks; a bright, upbeat change such as a wedding or a holiday highlight.",
    avoid: "Dark or moody footage, where the white flash jars; viewers sensitive to flashes; serious or sad subjects.",
  },
  wipeleft: {
    does: "A straight edge travels from right to left, uncovering the next clip behind it.",
    bestFor: "Moving on to the next item in a list or a step-by-step; following motion that already heads left; a playful, retro feel.",
    avoid: "Emotional or cinematic edits, where it looks cheap; cuts where the movement in the shot heads the other way.",
  },
  wiperight: {
    does: "A straight edge travels from left to right, uncovering the next clip behind it.",
    bestFor: "A \"next\" or forward step, as you read left to right; following a pan or a walk to the right; before-and-after reveals.",
    avoid: "Going back in time or to an earlier step (it reads as forward); serious, slow-paced pieces.",
  },
  wipeup: {
    does: "A straight edge rises from the bottom to the top, uncovering the next clip.",
    bestFor: "Vertical videos, matching the swipe-up habit; revealing a result or a title; following something that rises, like a launch or a jump.",
    avoid: "Landscape footage with a strong horizon, where the moving edge fights it; quiet, emotional moments.",
  },
  wipedown: {
    does: "A straight edge drops from the top to the bottom, uncovering the next clip.",
    bestFor: "Following something falling or pouring; a curtain-like reveal of the next scene; lists in vertical videos read top to bottom.",
    avoid: "Upbeat moments, since downward motion can feel like a let-down; footage that is already busy at the top of the frame.",
  },
  slideleft: {
    does: "The next clip pushes in from the right and shoves the previous one out to the left.",
    bestFor: "Carousel-style sequences, like swiping through photos; product or outfit lineups; matching a camera move to the left.",
    avoid: "Shots with text or faces near the edges, which get pushed off awkwardly; slow, reflective edits.",
  },
  slideright: {
    does: "The next clip pushes in from the left and shoves the previous one out to the right.",
    bestFor: "Going back, or showing the \"before\" in a comparison; matching a camera move to the right; light-hearted vlogs.",
    avoid: "A forward sequence of steps, where right-to-left reading feels wrong; too many in a row (it gets dizzying).",
  },
  slideup: {
    does: "The next clip pushes in from the bottom and shoves the previous one up and out.",
    bestFor: "Vertical feeds, where it mimics scrolling to the next post; stacking quick tips or facts; story-style recaps.",
    avoid: "Landscape cinematic shots; moments that need the viewer to linger on the previous picture.",
  },
  slidedown: {
    does: "The next clip pushes in from the top and shoves the previous one down and out.",
    bestFor: "Dropping into a new scene or location; a countdown that falls into place; following a downward tilt of the camera.",
    avoid: "Upward-moving action, which it fights against; edits that should feel like progress or a rise.",
  },
  circleopen: {
    does: "The next clip appears in a circle at the centre that grows until it fills the frame.",
    bestFor: "Revealing a subject in the centre of the shot; playful, cartoon-like edits; opening a video or a new segment.",
    avoid: "Subjects off-centre, which stay hidden until the end; serious or documentary pieces, where it feels gimmicky.",
  },
  circleclose: {
    does: "The previous clip shrinks into a closing circle at the centre while the next one shows around it.",
    bestFor: "A classic \"that's all\" ending on a centred subject; comedic beats; closing one segment before the next.",
    avoid: "Subjects at the edges of the frame; the middle of a smooth sequence, where it reads as an ending.",
  },
  radial: {
    does: "A line sweeps round the centre like a clock hand, revealing the next clip behind it.",
    bestFor: "Showing time passing (before and after, day to night); countdowns and timers; a fun recap of several moments.",
    avoid: "Footage with strong straight lines that the sweep cuts across; calm, emotional moments.",
  },
  pixelize: {
    does: "The previous clip breaks into big blocks, swaps to the next clip and then sharpens again.",
    bestFor: "Gaming, tech and retro content; a glitchy, digital look; hiding a jump between two very different shots.",
    avoid: "Faces and close-ups you want to keep flattering; elegant or romantic videos. The preview here shows it as a blur; the export draws real blocks.",
  },
  dissolve: {
    does: "The next clip appears through a grain of random dots that fills in until it covers the previous one.",
    bestFor: "A textured, film-like change; dream sequences; a softer alternative to a crossfade in a montage.",
    avoid: "Compressed or low-light footage, where the dots look like noise; fast edits. The preview shows it as a plain crossfade.",
  },
  zoomin: {
    does: "The previous clip zooms in towards the centre, and the next clip fades in over the zoom.",
    bestFor: "Energetic transitions in travel and sport edits; diving into a detail; matching a punch-in on the beat.",
    avoid: "Low-resolution footage, which goes soft as it scales; subjects off-centre; calm, quiet scenes.",
  },
  hblur: {
    does: "Both clips smear sideways in a blur, swapping in the middle, like a fast camera whip.",
    bestFor: "Whip-pan style changes of place; fast travel or sports montages; hiding a cut between two moving shots.",
    avoid: "Static, locked-off shots, where the blur has no motion to match; text-heavy frames. The preview shows a plain blur.",
  },
  collage: {
    does: "The previous clip breaks into a grid of squares that shrink and swipe away one after another, uncovering the matching squares of the next clip, like a digital scrapbook.",
    bestFor: "Travel highlight videos; upbeat corporate or event recaps; joining two shots full of detail, people or places.",
    avoid: "Quiet, emotional moments, where the busy grid distracts; a single face or subject that the squares would cut apart; very short transitions, where the squares just flicker.",
  },
  exchange: {
    does: "The previous clip shrinks into a card that slides away while the next one slides in as a card and grows to fill the frame: one shot swapped for the other.",
    bestFor: "Before-and-after comparisons on Instagram Reels; showing two options, products or outfits side by side in time; contrasts you want viewers to notice.",
    avoid: "Two shots with no link between them, where the swap means nothing; long, slow scenes; footage whose subject sits at the edge of the frame (it shrinks out of sight first).",
  },
  pageturn: {
    does: "The previous clip folds away from the right edge like a page in a book, its plain back showing, with a soft shadow on the next clip underneath.",
    bestFor: "Sequential content such as explainers, recipes and how-tos (the next chapter); birthday and milestone videos; storybook or scrapbook styles.",
    avoid: "Fast, modern edits, where it feels old-fashioned; every cut in a video; dark, serious pieces, where the paper look jars.",
  },
  reveal: {
    does: "The previous clip splits down the middle and the two halves slide apart to the sides, uncovering the next clip behind them.",
    bestFor: "Building drama or suspense before a reveal; \"get ready with me\" and makeover videos; opening on a product, a venue or a big moment.",
    avoid: "A subject right in the middle of the previous shot, which the split cuts in two; quick cuts where the reveal has nothing to reveal; calm, low-key pieces.",
  },
  heart: {
    does: "A heart opens from the middle of the frame and grows until the next clip, seen through it, fills the screen.",
    bestFor: "Valentine's Day and Mother's Day posts; wedding slideshows, proposals and video cards; any romantic or loving moment.",
    avoid: "Business, news or serious subjects; repeated use in one video, where it gets cheesy; a next shot whose subject sits in a corner, which shows last.",
  },
  glitch: {
    does: "Both clips break up like a bad video signal: the colors split apart (chromatic aberration), strips of the picture jump sideways and noisy blocks flash, with a hard switch at the peak.",
    bestFor: "Spooky Halloween videos; product launches and tech promos; energetic social media edits and music videos.",
    avoid: "Calm or sentimental footage; viewers sensitive to flashing images; long transitions, where the effect wears thin.",
  },
  glitchreveal: {
    does: "The next clip appears strip by strip, each horizontal strip swapping over at its own moment and jittering with split colors as it does.",
    bestFor: "Tech and gaming content; reveals with a digital or hacked look; intros, title cards and social clips that need some edge.",
    avoid: "Soft, romantic or natural footage; two shots with very different brightness, where the strips look broken; flash-sensitive audiences.",
  },
  "whip-left": {
    does: "Both clips rush to the left together, smeared by motion blur at full speed, hiding the cut inside a fast camera move.",
    bestFor: "Joining two travel or action scenes while keeping the momentum; shots that already end or start with a quick pan to the left.",
    avoid: "Shots that move the other way or slowly, where the change of direction jars; static, locked-off shots; text you need to read during the move.",
  },
  "whip-right": {
    does: "Both clips rush to the right together, smeared by motion blur at full speed, hiding the cut inside a fast camera move.",
    bestFor: "Fast-paced montages of places or people; matching a quick pan to the right at the end of one shot and the start of the next.",
    avoid: "Shots heading left, which fight the move; calm interviews and dialogue; footage that is already blurry.",
  },
  "whip-up": {
    does: "Both clips rush upwards together, smeared by motion blur, as if the camera tilted up fast between the shots.",
    bestFor: "Going from the ground to the sky (a building, a jump, fireworks); energetic sport and dance edits; a quick tilt that matches across the cut.",
    avoid: "Sideways camera moves, which don't match a vertical whip; slow scenes; repeating it on every cut.",
  },
  "whip-down": {
    does: "Both clips rush downwards together, smeared by motion blur, as if the camera tilted down fast between the shots.",
    bestFor: "Dropping from the sky or a view to the ground; landing on a subject or a product; matching a fast downward tilt across the cut.",
    avoid: "Shots with upward motion; quiet or emotional moments; footage with fine text, which turns to a smear.",
  },
  zoomfromfull: {
    does: "The next clip starts filling the whole screen and zooms smoothly down into the size and place you gave it, while the previous clip is gone. The picture seems to shrink into the corner.",
    bestFor: "Splitting one video, moving the second part small into a corner, then letting the picture shrink down into it; a main video that turns into a picture-in-picture.",
    avoid: "A next clip that already fills the screen, where there is nothing to shrink into; two unrelated shots, where the full-screen start looks like a jump.",
  },
  zoomtofull: {
    does: "The previous clip leaves its size and place and zooms smoothly out to fill the whole screen, and the next clip, full screen, takes over as it arrives.",
    bestFor: "A small picture-in-picture video that grows back to full screen as the next part begins; undoing a shrink made with Zoom from full screen.",
    avoid: "A previous clip that already fills the screen, where there is nothing to grow; a next clip that is not full screen, which jumps when it takes over.",
  },
}

/** The guidance for a transition, or for a hard cut ("none"). */
export const transitionGuide = (t: TransitionType | "none"): TransitionGuide => TRANSITION_GUIDES[t]

/** What each audio transition between two adjoining audio clips does, and when to use it. */
export const AUDIO_TRANSITION_GUIDES: Record<AudioTransitionType, TransitionGuide> = {
  "audio-linear": {
    does: "A constant-gain crossfade: the outgoing sound falls in a straight line while the incoming one rises in a straight line, so the two always add up to full volume in level, not in loudness.",
    bestFor: "Two takes of the same sound or the same music, where the waveforms line up and a straight blend sounds even; very short crossfades that only smooth a click.",
    avoid: "Two unrelated sounds, where the middle of the fade dips audibly in loudness; long crossfades between music and speech.",
  },
  "audio-equalpower": {
    does: "A constant-power crossfade (the default): quarter-sine curves keep the overall loudness steady as one sound hands over to the other.",
    bestFor: "Most cuts between different songs, ambiences or voices; music beds under a montage; anywhere you want no dip and no bump in loudness.",
    avoid: "Two copies of the same recording in sync, where the extra power in the middle makes a bump; you want an obvious dip between the two.",
  },
  "audio-scurve": {
    does: "An S-shaped crossfade: each sound changes slowly at the start and end of the fade and quickly through its middle, so the hand-over feels smooth and deliberate.",
    bestFor: "Musical changes on a phrase or a bar; podcasts moving between segments; smoothing a change where both ends should sound settled.",
    avoid: "Very short fades, where the fast middle sounds like a cut; sounds that need to overlap evenly for the whole fade.",
  },
  "audio-log": {
    does: "A logarithmic crossfade: the incoming sound comes up almost at once while the outgoing one holds on until late, so both are loud through the middle.",
    bestFor: "Bringing in a voice or a hit that has to be heard right away; joining two quiet sounds without any hole between them.",
    avoid: "Two loud sounds, where the middle gets louder than either; music in different keys, which clashes while both play.",
  },
  "audio-exp": {
    does: "An exponential crossfade: the outgoing sound drops away early and the incoming one stays low until late, so there is a soft dip in the middle.",
    bestFor: "Two loud sounds that would clash if both played at full level; a gentle breath between two music cues.",
    avoid: "Dialogue that must start clearly; continuous ambience, where the dip is heard as a gap.",
  },
  "audio-dip": {
    does: "The outgoing sound fades down to silence, a short pause of silence follows, then the incoming sound fades up from silence.",
    bestFor: "A clear break between scenes or chapters; a beat of silence before a punchline or a reveal; separating two songs in different keys.",
    avoid: "Continuous ambience or music, where the hole sounds like a mistake; fast-paced edits that rely on momentum.",
  },
  "audio-lowpass": {
    does: "The outgoing sound gets muffled, its high frequencies swept away as if it were heard through a wall, while the incoming sound fades up clean.",
    bestFor: "Club and EDM style changes; moving from one room or place to another; pushing music into the background as a new scene starts.",
    avoid: "Speech in the outgoing clip, which becomes hard to follow; short fades, where the sweep sounds like a glitch.",
  },
  "audio-tapestop": {
    does: "The outgoing sound slows down and drops in pitch until it winds to a stop, like a tape machine switched off, while the incoming sound fades up.",
    bestFor: "Comedic or dramatic interruptions; hip-hop and electronic edits; a record-scratch moment before something unexpected.",
    avoid: "Calm or serious pieces; using it more than once or twice in a video; dialogue, which turns into a growl.",
  },
  "audio-echo": {
    does: "The outgoing sound trails off into a fading echo, its last moments repeating and dying away, while the incoming sound comes in under the echoes.",
    bestFor: "Ending a song or a line with a flourish; dreamy or nostalgic changes; leaving a phrase hanging as the next scene starts.",
    avoid: "Busy outgoing sound, where the echoes pile up into mush; quick dialogue exchanges.",
  },
  "audio-telephone": {
    does: "The outgoing sound narrows to a thin, telephone-like band as it fades, and the incoming sound starts in that same narrow band before opening up to full sound.",
    bestFor: "Phone calls, radio and flashback effects; handing over between two voices; a stylised, lo-fi change in a vlog or a podcast.",
    avoid: "Music where the lost bass and treble are missed; long fades, where the thin sound gets tiring.",
  },
}

/** The audio fades a clip's free edge offers (lib/video/transition-types EDGE_AUDIO_TYPES). */
export type AudioEdgeType = Exclude<AudioTransitionType, "audio-dip" | "audio-telephone">

/** What each audio fade at a clip's free edge does, and when to use it. */
export const AUDIO_EDGE_GUIDES: Record<AudioEdgeType, TransitionGuide> = {
  "audio-linear": {
    does: "The sound fades in from silence (or out to it) in a straight line of gain over the fade's length.",
    bestFor: "Short fades that just stop a click at a hard start or end; sound effects and room tone.",
    avoid: "Long fades on music, where a straight gain line sounds like it rushes at the quiet end.",
  },
  "audio-equalpower": {
    does: "The sound fades in or out on a quarter-sine curve, the smooth, natural-sounding fade most editors reach for first.",
    bestFor: "Fading music in at the start of a video or out at the end; easing ambience in and out under pictures.",
    avoid: "A fade you want to feel sudden or dramatic; very long fades, where it can feel slow to get going or to go.",
  },
  "audio-scurve": {
    does: "The sound fades on an S-shaped curve: it changes slowly at first, quickly in the middle and settles slowly at the end.",
    bestFor: "Polished fade-ins and fade-outs on music beds; endings that should feel deliberate and finished.",
    avoid: "Very short fades, where the slow ends make it sound abrupt in the middle.",
  },
  "audio-log": {
    does: "A logarithmic fade: the sound comes up quickly at the start of a fade-in, or drops quickly at the start of a fade-out, then eases.",
    bestFor: "Voices and hits that should be heard at once; quick tidy endings where the sound should get out of the way early.",
    avoid: "Slow atmospheric swells; fade-outs on music that should linger.",
  },
  "audio-exp": {
    does: "An exponential fade: the sound stays quiet for most of a fade-in and rises late, or holds on for most of a fade-out and falls away at the end.",
    bestFor: "Slow builds into a scene; endings that let the music breathe before it goes.",
    avoid: "Dialogue that must start clearly; short fades, where the late change sounds like a jump.",
  },
  "audio-lowpass": {
    does: "The sound starts muffled and opens up to full brightness as it fades in, or loses its high frequencies and muffles away as it fades out.",
    bestFor: "Music coming in as if from another room; DJ-style intros and outros; pushing a scene's sound away at the end.",
    avoid: "Speech, which goes unclear while muffled; very short fades.",
  },
  "audio-tapestop": {
    does: "At an out edge the sound slows down and drops in pitch to a stop like a tape machine; at an in edge it starts from a standstill and speeds up to normal (a tape start).",
    bestFor: "Comedic stops and starts; hip-hop and electronic intros and outros; a dramatic halt at the end of a scene.",
    avoid: "Serious or calm pieces; dialogue, which turns into a growl; using it often.",
  },
  "audio-echo": {
    does: "The sound's last moments trail off into echoes that die away as the clip ends.",
    bestFor: "A flourish at the end of a song or a line; dreamy, nostalgic endings; leaving a moment hanging.",
    avoid: "Busy sound, where echoes turn to mush; endings that should stop cleanly.",
  },
}
