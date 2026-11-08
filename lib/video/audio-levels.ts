// A clip's audio levels (Clip.audio): its overall gain and a short ordered
// list of audio effects, applied to the whole of its sound. Each effect is a
// list of plain node specs (AudioNodeSpec) that both sides read: the export
// turns them into ffmpeg filters (fxFilters, lib/video/ffmpeg-server) and the
// preview into Web Audio nodes (components/video/audio-levels-graph). A spec
// with no faithful Web Audio node ("export") makes its effect heard in the
// export only. Plain data and maths, safe on the client.

export const AUDIO_FX_TYPES = [
  "lowcut", "highcut", "bass", "treble", "voice", "deess", "compressor", "limiter", "gate", "denoise", "normalize", "mono", "wide",
  "room", "hall", "echo", "slapback",
  "lofi", "telephone", "radio", "can", "megaphone", "muffled", "underwater",
  "robot", "chipmunk", "deep", "alien", "vinyl",
] as const
export type AudioFxType = (typeof AUDIO_FX_TYPES)[number]
export type AudioFx = { type: AudioFxType; amount?: number }
/** `gainDb` absent means 0 dB; `fx` absent means none. A clip with neither stores no `audio`. */
export type ClipAudio = { gainDb?: number; fx?: AudioFx[] }

export const MIN_GAIN_DB = -60
export const MAX_GAIN_DB = 24
export const MAX_FX = 4
export const DEFAULT_AMOUNT = 0.5

export const AUDIO_FX_GROUPS = ["Clean-up and tone", "Space", "Character", "Creative"] as const
export type AudioFxGroup = (typeof AUDIO_FX_GROUPS)[number]

export type AudioFxInfo = {
  id: AudioFxType
  name: string
  group: AudioFxGroup
  description: string
  /** Whether it has an intensity slider (Clip.audio.fx[].amount). */
  amount: boolean
  bestFor: string
  avoid: string
}

/** One processing step, read by the export (ffmpeg) and the preview (Web Audio). Times in seconds unless named ms; levels in dB unless named. */
export type AudioNodeSpec =
  | { kind: "filter"; type: "highpass" | "lowpass" | "bandpass" | "peaking" | "lowshelf" | "highshelf"; frequency: number; q?: number; gain?: number }
  | { kind: "gain"; db: number }
  | { kind: "compressor"; threshold: number; ratio: number; knee: number; attack: number; release: number; makeup: number }
  | { kind: "limiter"; ceiling: number; attack: number; release: number }
  | { kind: "shaper"; curve: "soft" | "hard"; drive: number; levels?: number }
  | { kind: "noise"; hiss: number; crackle: number; rate: number }
  | { kind: "ring"; frequency: number }
  | { kind: "taps"; dry: number; out: number; delays: number[]; decays: number[] }
  | { kind: "mono" }
  | { kind: "haas"; ms: number }
  | { kind: "vibrato"; rate: number; depth: number }
  | { kind: "flanger"; delay: number; depth: number; regen: number; width: number; speed: number }
  | { kind: "export"; filters: string[] }

const r1 = (x: number) => Math.round(x * 10) / 10
const r3 = (x: number) => Math.round(x * 1000) / 1000
const r6 = (x: number) => Math.round(x * 1e6) / 1e6
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** From `a` to `b` in even steps of pitch. */
const glide = (a: number, b: number, t: number) => Math.round(a * (b / a) ** t)
export const dbToGain = (db: number) => 10 ** (db / 20)

const hp = (frequency: number): AudioNodeSpec => ({ kind: "filter", type: "highpass", frequency })
const lp = (frequency: number): AudioNodeSpec => ({ kind: "filter", type: "lowpass", frequency })
const peak = (frequency: number, q: number, gain: number): AudioNodeSpec => ({ kind: "filter", type: "peaking", frequency, q, gain })

/** Multi-tap echoes (aecho): the dry signal at `dry`, each delay at its decay, the sum scaled so it rarely clips. */
function taps(delays: number[], decays: number[], dry = 1): AudioNodeSpec {
  const d = decays.map(r3)
  const sum = d.reduce((a, b) => a + b, 0)
  return { kind: "taps", dry, out: r3(Math.min(1, 1 / (dry + sum * 0.5))), delays, decays: d }
}

/** A pitch shift of `semitones` with the length kept: relabelled to a new rate, resampled, then sped back (asetrate, atempo). */
function pitch(semitones: number): AudioNodeSpec {
  const rate = Math.round(48000 * 2 ** (semitones / 12))
  return { kind: "export", filters: [`asetrate=${rate}`, "aresample=48000", `atempo=${r6(48000 / rate)}`] }
}

type FxDef = Omit<AudioFxInfo, "id"> & { nodes: (amount: number) => AudioNodeSpec[] }

/**
 * Every effect: its texts and its nodes for an intensity `a` (0 to 1; 0.5
 * for the ones without a slider). The comment over each says what the export
 * (ffmpeg) and the preview (Web Audio) run.
 */
const FX: Record<AudioFxType, FxDef> = {
  // ffmpeg highpass (Butterworth) 40-200 Hz; Web Audio highpass biquad, same cutoff.
  lowcut: {
    name: "Low cut", group: "Clean-up and tone", amount: true,
    description: "Takes out rumble below the voice: wind, traffic, handling noise, air conditioning.",
    bestFor: "Speech recorded outdoors or on a phone; any voice that sounds boomy or muddy.",
    avoid: "Music with a bass line or a kick drum you want to keep; deep sound effects.",
    nodes: (a) => [hp(Math.round(lerp(40, 200, a)))],
  },
  // ffmpeg lowpass 16 kHz down to 3 kHz; Web Audio lowpass biquad, same cutoff.
  highcut: {
    name: "High cut", group: "Clean-up and tone", amount: true,
    description: "Rolls off the top end: hiss, buzz and harsh digital edge.",
    bestFor: "Old or noisy recordings with a steady hiss; taming a harsh, cheap microphone.",
    avoid: "Clean recordings, which only get duller; cymbals and sparkle you want to keep.",
    nodes: (a) => [lp(glide(16000, 3000, a))],
  },
  // ffmpeg bass shelf (slope 1) at 100 Hz, +3 to +12 dB; Web Audio lowshelf, same.
  bass: {
    name: "Bass boost", group: "Clean-up and tone", amount: true,
    description: "Lifts the low end for a fuller, warmer sound.",
    bestFor: "Thin music from a phone; a voice-over that needs more weight; beats in short social clips.",
    avoid: "Sound that already booms or distorts; speech recorded with wind or rumble (boosts that too).",
    nodes: (a) => [{ kind: "filter", type: "lowshelf", frequency: 100, gain: r1(lerp(3, 12, a)) }],
  },
  // ffmpeg treble shelf (slope 1) at 5 kHz, +3 to +12 dB; Web Audio highshelf, same.
  treble: {
    name: "Treble boost", group: "Clean-up and tone", amount: true,
    description: "Lifts the top end for a brighter, crisper sound.",
    bestFor: "Dull or muffled recordings; making speech cut through music.",
    avoid: "Hissy sources (the hiss comes up too); voices with sharp S sounds.",
    nodes: (a) => [{ kind: "filter", type: "highshelf", frequency: 5000, gain: r1(lerp(3, 12, a)) }],
  },
  // ffmpeg highpass 90 Hz, then equalizer at 3 kHz (Q 1) +2 to +8 dB; Web Audio highpass and peaking biquads, same.
  voice: {
    name: "Voice boost", group: "Clean-up and tone", amount: true,
    description: "Brings speech forward: a presence lift around 3 kHz and a gentle low cut.",
    bestFor: "Interviews, vlogs and voice-overs that sit behind music or room noise.",
    avoid: "Music, where it sounds nasal; voices that are already sharp or shouty.",
    nodes: (a) => [hp(90), peak(3000, 1, r1(lerp(2, 8, a)))],
  },
  // ffmpeg equalizer at 7 kHz (Q 1.5) -3 to -12 dB; Web Audio peaking biquad, same.
  deess: {
    name: "Tame harshness", group: "Clean-up and tone", amount: true,
    description: "Softens sharp S and T sounds and harsh highs with a cut around 7 kHz.",
    bestFor: "Close-miked voices with piercing sibilance; bright phone recordings.",
    avoid: "Dull or distant voices, which lose clarity; music with important cymbals.",
    nodes: (a) => [peak(7000, 1.5, -r1(lerp(3, 12, a)))],
  },
  // ffmpeg acompressor (threshold -12 to -30 dB, ratio 2 to 8, 10 ms attack, 150 ms release, 9 dB knee, makeup gain);
  // Web Audio DynamicsCompressorNode with the same settings and a gain for the makeup.
  compressor: {
    name: "Compressor", group: "Clean-up and tone", amount: true,
    description: "Evens out loud and quiet parts so the level stays steady.",
    bestFor: "Speech that jumps between whispers and shouts; voice-overs; music under talking.",
    avoid: "Music with deliberate quiet and loud parts; noisy recordings (raises the noise in pauses).",
    nodes: (a) => {
      const threshold = r1(lerp(-12, -30, a))
      const ratio = r1(lerp(2, 8, a))
      return [{ kind: "compressor", threshold, ratio, knee: 9, attack: 0.01, release: 0.15, makeup: r1((-threshold * (1 - 1 / ratio)) / 2) }]
    },
  },
  // ffmpeg alimiter at -1 dB (5 ms lookahead, compensated; no auto level); Web Audio DynamicsCompressorNode at ratio 20, no knee.
  limiter: {
    name: "Limiter", group: "Clean-up and tone", amount: false,
    description: "Stops peaks going over -1 dB, so loud moments don't clip.",
    bestFor: "After a volume boost; claps, shouts and bangs that spike; the last effect in a stack.",
    avoid: "Quiet material that never peaks (nothing to do); as a way to make things louder by itself.",
    nodes: () => [{ kind: "limiter", ceiling: -1, attack: 0.005, release: 0.05 }],
  },
  // ffmpeg agate (threshold -60 to -30 dB, ratio 10, range -24 dB). No Web Audio gate: export only.
  gate: {
    name: "Noise gate", group: "Clean-up and tone", amount: true,
    description: "Turns the sound down in the pauses between words, hiding steady background noise.",
    bestFor: "Speech with hum or hiss that shows in the gaps; podcast-style recordings.",
    avoid: "Soft voices or music fade-outs (they get chopped); noise that is loud under the speech too.",
    nodes: (a) => [{ kind: "export", filters: [`agate=threshold=${r6(dbToGain(lerp(-60, -30, a)))}:ratio=10:attack=5:release=120:range=0.063`] }],
  },
  // ffmpeg afftdn (6 to 30 dB of reduction, -50 dB noise floor). Export only.
  denoise: {
    name: "Noise reduction", group: "Clean-up and tone", amount: true,
    description: "Learns the steady background noise and subtracts it from the whole clip.",
    bestFor: "Hiss, fan noise, fridge hum and other constant background sound under a voice.",
    avoid: "Changing noise like traffic or crowds; heavy settings on music (it goes watery).",
    nodes: (a) => [{ kind: "export", filters: [`afftdn=nr=${r1(lerp(6, 30, a))}:nf=-50`] }],
  },
  // ffmpeg loudnorm to -16 LUFS (true peak -1.5 dB), resampled back to 48 kHz. Export only.
  normalize: {
    name: "Normalize", group: "Clean-up and tone", amount: false,
    description: "Sets the clip's loudness to -16 LUFS, the usual level for social video and podcasts.",
    bestFor: "Clips from different sources that should sound equally loud; quiet phone recordings.",
    avoid: "A clip meant to sit quietly under others (it comes up to full level); very short clips.",
    nodes: () => [{ kind: "export", filters: ["loudnorm=I=-16:TP=-1.5:LRA=11", "aresample=48000"] }],
  },
  // ffmpeg pan, both channels to their average; Web Audio a one-channel gain (the browser's own downmix), copied back to both.
  mono: {
    name: "Stereo to mono", group: "Clean-up and tone", amount: false,
    description: "Mixes left and right into one centred channel.",
    bestFor: "A voice recorded on one side only; interviews where the mic sits in one channel.",
    avoid: "Music with a wide stereo image you want to keep.",
    nodes: () => [{ kind: "mono" }],
  },
  // ffmpeg adelay on the right channel only (4 to 20 ms, the Haas effect); Web Audio a delay on the right channel, same.
  wide: {
    name: "Wide stereo", group: "Clean-up and tone", amount: true,
    description: "Delays one side by a few milliseconds so a mono sound feels wider.",
    bestFor: "Mono music beds and ambience that feel narrow; background sound under a voice.",
    avoid: "Speech that should stay centred; anything listened to on a phone speaker in mono (it can thin out).",
    nodes: (a) => [{ kind: "haas", ms: r1(lerp(4, 20, a)) }],
  },
  // ffmpeg aecho with six early reflections (13 to 71 ms); Web Audio the same taps as delays and gains.
  room: {
    name: "Room reverb", group: "Space", amount: true,
    description: "Places the sound in a small room with close reflections.",
    bestFor: "Dry voice-overs that sound pasted on; matching a voice to an indoor scene.",
    avoid: "Recordings that already echo; fast speech that needs to stay crisp.",
    nodes: (a) => {
      const w = lerp(0.4, 1.4, a)
      return [taps([13, 23, 31, 43, 59, 71], [0.45, 0.4, 0.35, 0.3, 0.25, 0.2].map((d) => d * w))]
    },
  },
  // ffmpeg aecho twice (three short diffusing taps, then eight long ones from 89 to 503 ms) and a 6 kHz lowpass; Web Audio the same taps and filter.
  hall: {
    name: "Hall reverb", group: "Space", amount: true,
    description: "A large, long reverb like a concert hall or a church.",
    bestFor: "Dramatic or dreamy moments; a single voice line or sound effect that should feel big.",
    avoid: "Dialogue that must stay clear; busy music, where it smears into a wash.",
    nodes: (a) => {
      const w = lerp(0.5, 1.3, a)
      return [taps([7, 11, 17], [0.5, 0.4, 0.3]), taps([89, 131, 173, 227, 283, 347, 419, 503], [0, 1, 2, 3, 4, 5, 6, 7].map((k) => 0.6 * 0.85 ** k * w)), lp(6000)]
    },
  },
  // ffmpeg aecho with three repeats 300 ms apart, each quieter; Web Audio the same taps.
  echo: {
    name: "Echo", group: "Space", amount: true,
    description: "Repeats the sound three times, 0.3 s apart, each repeat quieter.",
    bestFor: "A shout across a canyon; emphasising a last word or a title hit.",
    avoid: "Long stretches of speech (the repeats pile up); music with its own tempo.",
    nodes: (a) => {
      const b = lerp(0.25, 0.65, a)
      return [taps([300, 600, 900], [b, b * b, b * b * b])]
    },
  },
  // ffmpeg aecho with one 110 ms repeat; Web Audio the same tap.
  slapback: {
    name: "Slapback", group: "Space", amount: true,
    description: "A single quick repeat, the classic rockabilly vocal echo.",
    bestFor: "Vocals and guitar with a vintage feel; a voice in a hard-walled space like a stairwell.",
    avoid: "Quiet, intimate narration; anything already drenched in reverb.",
    nodes: (a) => [taps([110], [lerp(0.25, 0.65, a)])],
  },
  // ffmpeg highpass 300 Hz, lowpass 4 kHz, and aeval (soft saturation and fewer bits); Web Audio biquads and a WaveShaper with the same curve.
  lofi: {
    name: "Lo-fi", group: "Character", amount: true,
    description: "A cheap, band-limited sound with light grit, like an old cassette or a small speaker.",
    bestFor: "Music beds with a chilled, nostalgic feel; a flashback or a memory.",
    avoid: "Main dialogue that must be clear; when you want the full sound of the music.",
    nodes: (a) => [hp(300), lp(4000), { kind: "shaper", curve: "soft", drive: r1(lerp(1, 4, a)), levels: 2 ** (Math.round(lerp(10, 5, a)) - 1) }],
  },
  // ffmpeg two highpass at 400 Hz, two lowpass at 3.4 kHz and soft clipping (aeval); Web Audio the same biquads and WaveShaper.
  telephone: {
    name: "Telephone", group: "Character", amount: true,
    description: "The narrow 400 Hz to 3.4 kHz band of a phone line, slightly overdriven.",
    bestFor: "A voice on the other end of a call; voicemail; a narrator heard through a device.",
    avoid: "Long stretches of speech (tiring to listen to); music you want to enjoy.",
    nodes: (a) => [hp(400), hp(400), lp(3400), lp(3400), { kind: "shaper", curve: "soft", drive: r1(lerp(1, 3, a)) }],
  },
  // ffmpeg pan to mono, two highpass at 500 Hz, two lowpass at 3 kHz, a 1.8 kHz bump, soft clipping, then a faint hiss and crackle
  // (aeval, fixed seeds); Web Audio the same mono, biquads and WaveShaper, and a looping noise buffer from a fixed seed.
  radio: {
    name: "Old-time radio", group: "Character", amount: true,
    description: "An AM radio from the 1940s: mono, a narrow 500 Hz to 3 kHz band, warm clipping and a faint crackle.",
    bestFor: "Period pieces; a broadcast inside the story; announcements and vintage ads.",
    avoid: "Modern scenes where it reads as a fault; dialogue that has to carry the story for long.",
    nodes: (a) => [{ kind: "mono" }, hp(500), hp(500), lp(3000), lp(3000), peak(1800, 1, 3), { kind: "shaper", curve: "soft", drive: r1(lerp(2, 5, a)) }, { kind: "noise", hiss: r3(lerp(0.002, 0.006, a)), crackle: 0.15, rate: 0.0002 }],
  },
  // ffmpeg bandpass at 1.6 kHz (Q 3), a sharp 2.6 kHz resonance, two very short echoes (3 and 7 ms) and soft clipping;
  // Web Audio the same biquads, taps and WaveShaper.
  can: {
    name: "Through a can", group: "Character", amount: true,
    description: "A tin can on a string: a narrow, hollow, metallic ring around 1 to 2 kHz.",
    bestFor: "Comedy; a toy or tin-can phone; a voice inside a pipe, a bucket or a helmet.",
    avoid: "Anything that needs to sound natural; music.",
    nodes: (a) => {
      const w = lerp(0.6, 1.4, a)
      return [{ kind: "filter", type: "bandpass", frequency: 1600, q: 3 }, peak(2600, 8, r1(lerp(6, 12, a))), taps([3, 7], [0.5 * w, 0.35 * w], 0.8), { kind: "shaper", curve: "soft", drive: 1.5 }]
    },
  },
  // ffmpeg two highpass at 500 Hz, two lowpass at 4 kHz and hard clipping (aeval); Web Audio the same biquads and WaveShaper.
  megaphone: {
    name: "Megaphone", group: "Character", amount: true,
    description: "A bullhorn: band-limited from 500 Hz to 4 kHz and hard-clipped.",
    bestFor: "Protests, sports coaches, public address; a robotic or authoritarian announcement.",
    avoid: "Quiet, soft voices (the clipping exaggerates breaths); long passages.",
    nodes: (a) => [hp(500), hp(500), lp(4000), lp(4000), { kind: "shaper", curve: "hard", drive: r1(lerp(3, 12, a)) }, { kind: "gain", db: -3 }],
  },
  // ffmpeg two lowpass from 900 down to 250 Hz; Web Audio the same biquads.
  muffled: {
    name: "Muffled", group: "Character", amount: true,
    description: "Heard through a wall or a closed door: only the low end gets through.",
    bestFor: "A party next door; music from another room; a character waking up or passing out.",
    avoid: "Anything the viewer needs to understand word for word.",
    nodes: (a) => {
      const f = glide(900, 250, a)
      return [lp(f), lp(f)]
    },
  },
  // ffmpeg two lowpass (800 down to 400 Hz) and vibrato (0.5 to 1.5 Hz); Web Audio the same biquads and a delay swept by an oscillator.
  underwater: {
    name: "Underwater", group: "Character", amount: true,
    description: "Dark, dull and gently wobbling, as if heard under water.",
    bestFor: "Diving and swimming shots; a dream or a daze; sound heard from inside a fish tank.",
    avoid: "Dialogue; music that must stay in tune (the wobble bends the pitch).",
    nodes: (a) => {
      const f = Math.round(lerp(800, 400, a))
      return [lp(f), lp(f), { kind: "vibrato", rate: r1(lerp(0.5, 1.5, a)), depth: r1(lerp(0.3, 0.7, a)) }]
    },
  },
  // ffmpeg aeval multiplying by a 30 to 120 Hz sine (ring modulation) and a 6 ms metallic echo; Web Audio a gain driven by an oscillator and the same tap.
  robot: {
    name: "Robot", group: "Creative", amount: true,
    description: "Ring modulation that turns a voice metallic and buzzing.",
    bestFor: "Robots, AIs and machines; comedy; a glitchy sci-fi announcement.",
    avoid: "Music (it goes out of tune); long stretches, which tire the ear.",
    nodes: (a) => [{ kind: "ring", frequency: Math.round(lerp(30, 120, a)) }, taps([6], [0.4])],
  },
  // ffmpeg asetrate up 5 semitones, aresample and atempo back, so the length stays. Web Audio can't shift pitch and keep time: export only.
  chipmunk: {
    name: "Chipmunk", group: "Creative", amount: false,
    description: "Raises the pitch by five semitones and keeps the speed.",
    bestFor: "Comedy; cartoon animals; a sped-up feel without losing sync.",
    avoid: "Serious content; music, which shifts key against other tracks.",
    nodes: () => [pitch(5)],
  },
  // ffmpeg asetrate down 5 semitones, aresample and atempo back. Export only.
  deep: {
    name: "Deep voice", group: "Creative", amount: false,
    description: "Lowers the pitch by five semitones and keeps the speed.",
    bestFor: "Monster or villain voices; an anonymous witness; slow-motion moments.",
    avoid: "Music in time with other tracks; voices that are already low and get muddy.",
    nodes: () => [pitch(-5)],
  },
  // ffmpeg flanger (1 ms base delay, 3 to 8 ms sweep, 40 to 80% feedback, 0.2 to 1 Hz) and a 6 Hz vibrato; Web Audio swept delays with feedback, same settings.
  alien: {
    name: "Alien", group: "Creative", amount: true,
    description: "A sweeping, warbling flanger that makes a voice sound otherworldly.",
    bestFor: "Aliens, ghosts and space scenes; a psychedelic music moment.",
    avoid: "Clear dialogue; subtle, realistic edits.",
    nodes: (a) => [{ kind: "flanger", delay: 1, depth: r1(lerp(3, 8, a)), regen: Math.round(lerp(40, 80, a)), width: 71, speed: r1(lerp(0.2, 1, a)) }, { kind: "vibrato", rate: 6, depth: 0.25 }],
  },
  // ffmpeg highpass 40 Hz, lowpass 9 kHz and an added hiss and crackle (aeval, fixed seeds); Web Audio the same biquads and a looping noise buffer.
  vinyl: {
    name: "Vinyl crackle", group: "Creative", amount: true,
    description: "Adds the soft hiss and pops of an old record.",
    bestFor: "Music with a retro feel; old film or home-movie looks; nostalgic montages.",
    avoid: "Silent passages you want silent (the crackle plays throughout); clean modern scenes.",
    nodes: (a) => [hp(40), lp(9000), { kind: "noise", hiss: 0.0015, crackle: r3(lerp(0.1, 0.4, a)), rate: 0.0003 }],
  },
}

/** What an effect is and does, for the dialog and the timeline. */
export function audioFxInfo(type: AudioFxType): AudioFxInfo {
  const { nodes, ...info } = FX[type]
  void nodes
  return { id: type, ...info }
}

export const isAudioFxType = (v: unknown): v is AudioFxType => typeof v === "string" && (AUDIO_FX_TYPES as readonly string[]).includes(v)

/** An effect's intensity (0 to 1): its own, or DEFAULT_AMOUNT; always DEFAULT_AMOUNT for one without a slider. */
export const fxAmount = (fx: AudioFx) => (FX[fx.type].amount && fx.amount !== undefined ? fx.amount : DEFAULT_AMOUNT)

/** An effect's processing steps at its intensity. */
export const fxNodes = (fx: AudioFx): AudioNodeSpec[] => FX[fx.type].nodes(fxAmount(fx))

/** Whether the preview plays an effect (every one of its steps has a Web Audio node). */
export const fxPreviewed = (type: AudioFxType) => FX[type].nodes(DEFAULT_AMOUNT).every((n) => n.kind !== "export")

/**
 * A clip's audio levels from a project file or a client: undefined when there
 * is nothing to store (0 dB and no effects), null when it doesn't validate (a
 * gain outside MIN_GAIN_DB to MAX_GAIN_DB, more than MAX_FX effects, an unknown
 * or repeated effect, an intensity outside 0 to 1). A 0 dB gain, an empty list
 * and an intensity on an effect without a slider are left out.
 */
export function normalizeClipAudio(v: unknown): ClipAudio | undefined | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null
  const { gainDb, fx } = v as Record<string, unknown>
  if (gainDb !== undefined && !(typeof gainDb === "number" && Number.isFinite(gainDb) && gainDb >= MIN_GAIN_DB && gainDb <= MAX_GAIN_DB)) return null
  if (fx !== undefined && !(Array.isArray(fx) && fx.length <= MAX_FX)) return null
  const list: AudioFx[] = []
  for (const f of (fx as unknown[] | undefined) ?? []) {
    if (typeof f !== "object" || f === null || Array.isArray(f)) return null
    const { type, amount } = f as Record<string, unknown>
    if (!isAudioFxType(type) || list.some((x) => x.type === type)) return null
    if (amount !== undefined && !(typeof amount === "number" && Number.isFinite(amount) && amount >= 0 && amount <= 1)) return null
    list.push(FX[type].amount && amount !== undefined ? { type, amount } : { type })
  }
  const out: ClipAudio = {}
  if (gainDb !== undefined && gainDb !== 0) out.gainDb = gainDb
  if (list.length > 0) out.fx = list
  return out.gainDb === undefined && !out.fx ? undefined : out
}

/** Whether two clips' audio levels sound the same (absent counts as 0 dB and no effects). */
export function sameClipAudio(a: ClipAudio | undefined, b: ClipAudio | undefined): boolean {
  if ((a?.gainDb ?? 0) !== (b?.gainDb ?? 0)) return false
  const x = a?.fx ?? []
  const y = b?.fx ?? []
  return x.length === y.length && x.every((f, i) => f.type === y[i].type && fxAmount(f) === fxAmount(y[i]))
}

/** "+3 dB, Telephone": the gain (when not 0) and the effects' names, for a title. */
export function audioSummary(audio: ClipAudio | undefined): string {
  const parts: string[] = []
  const g = audio?.gainDb ?? 0
  if (g !== 0) parts.push(`${g > 0 ? "+" : ""}${g} dB`)
  for (const f of audio?.fx ?? []) parts.push(FX[f.type].name)
  return parts.join(", ")
}

/** One-click effect lists for the dialog. */
export const AUDIO_PRESETS: { name: string; fx: AudioFxType[] }[] = [
  { name: "Voice clean-up", fx: ["lowcut", "compressor", "voice", "normalize"] },
  { name: "Radio", fx: ["radio"] },
  { name: "Phone", fx: ["telephone"] },
  { name: "Muffled hallway", fx: ["muffled", "room"] },
]

// The export side: ffmpeg filters for each step.

/** A shaper's output for input `x` (-1 to 1): soft (tanh) or hard clipping at its drive, then rounded to `levels` steps a side when set. */
export function shapeValue(spec: { curve: "soft" | "hard"; drive: number; levels?: number }, x: number): number {
  const y = spec.curve === "soft" ? Math.tanh(spec.drive * x) / Math.tanh(spec.drive) : Math.min(1, Math.max(-1, spec.drive * x))
  return spec.levels ? Math.round(y * spec.levels) / spec.levels : y
}

/** The same shape as an ffmpeg expression of `x`. */
function shapeExpr(spec: { curve: "soft" | "hard"; drive: number; levels?: number }, x: string): string {
  const y = spec.curve === "soft" ? `tanh(${spec.drive}*${x})/tanh(${spec.drive})` : `clip(${spec.drive}*${x},-1,1)`
  return spec.levels ? `round((${y})*${spec.levels})/${spec.levels}` : y
}

/** aeval over both channels with `f` making each channel's expression from its sample. */
const aeval = (f: (x: string) => string) => `aeval=exprs='${f("val(0)")}|${f("val(1)")}'`

/** The ffmpeg filters for one step. */
export function nodeFilters(n: AudioNodeSpec): string[] {
  switch (n.kind) {
    case "filter": {
      if (n.type === "highpass" || n.type === "lowpass") return [`${n.type}=f=${n.frequency}${n.q ? `:t=q:w=${n.q}` : ""}`]
      if (n.type === "bandpass") return [`bandpass=f=${n.frequency}:t=q:w=${n.q ?? 0.707}`]
      if (n.type === "peaking") return [`equalizer=f=${n.frequency}:t=q:w=${n.q ?? 1}:g=${n.gain ?? 0}`]
      return [`${n.type === "lowshelf" ? "bass" : "treble"}=g=${n.gain ?? 0}:f=${n.frequency}:t=s:w=1`]
    }
    case "gain":
      return [`volume=${n.db}dB`]
    case "compressor":
      return [`acompressor=threshold=${r6(dbToGain(n.threshold))}:ratio=${n.ratio}:attack=${r3(n.attack * 1000)}:release=${r3(n.release * 1000)}:knee=${r3(Math.min(8, Math.max(1, dbToGain(n.knee))))}:makeup=${r3(dbToGain(n.makeup))}`]
    case "limiter":
      return [`alimiter=limit=${r6(dbToGain(n.ceiling))}:attack=${r3(n.attack * 1000)}:release=${r3(n.release * 1000)}:level=0:latency=1`]
    case "shaper":
      return [aeval((x) => shapeExpr(n, x))]
    case "noise":
      // Fixed seeds (random's own state, starting at 0 in each channel's expression): the same noise every export.
      return [aeval((x) => `${x}+${n.hiss}*(2*random(0)-1)+${n.crackle}*gt(random(1),${r6(1 - n.rate)})*(2*random(2)-1)`)]
    case "ring":
      return [aeval((x) => `${x}*sin(2*PI*${n.frequency}*t)`)]
    case "taps":
      return [`aecho=${n.dry}:${n.out}:${n.delays.join("|")}:${n.decays.join("|")}`]
    case "mono":
      return ["pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1"]
    case "haas":
      return [`adelay=delays=0|${n.ms}`]
    case "vibrato":
      return [`vibrato=f=${n.rate}:d=${n.depth}`]
    case "flanger":
      return [`flanger=delay=${n.delay}:depth=${n.depth}:regen=${n.regen}:width=${n.width}:speed=${n.speed}`]
    case "export":
      return n.filters
  }
}

/** An effect's ffmpeg filters at its intensity, in order. */
export const fxFilters = (fx: AudioFx) => fxNodes(fx).flatMap(nodeFilters)

/** The ffmpeg filters for a clip's audio levels: the gain (when not 0), then each effect in order; none for absent levels. */
export function audioLevelFilters(audio: ClipAudio | undefined): string[] {
  if (!audio) return []
  return [...(audio.gainDb ? [`volume=${audio.gainDb}dB`] : []), ...(audio.fx ?? []).flatMap(fxFilters)]
}

// The preview side: numbers the Web Audio graph needs that are worth testing on their own.

/** A shaper's WaveShaper curve: `size` points from -1 to 1. */
export function shaperCurve(spec: { curve: "soft" | "hard"; drive: number; levels?: number }, size = 4097): Float32Array {
  const out = new Float32Array(size)
  for (let i = 0; i < size; i++) out[i] = shapeValue(spec, (2 * i) / (size - 1) - 1)
  return out
}

/** `n` samples of a noise step's hiss and crackle from a fixed seed (a small LCG), so the preview's noise is the same every time. */
export function noiseSamples(spec: { hiss: number; crackle: number; rate: number }, n: number): Float32Array {
  let s = 1
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const hiss = spec.hiss * (2 * rnd() - 1)
    const hit = rnd() > 1 - spec.rate
    out[i] = hiss + (hit ? spec.crackle * (2 * rnd() - 1) : 0)
  }
  return out
}

/** A low- or high-pass Q for Web Audio, which reads it in dB (ffmpeg's Butterworth 0.707 is about -3 dB). */
export const passQ = (q = Math.SQRT1_2) => r3(20 * Math.log10(q))

/**
 * A vibrato's swept delay (s) for Web Audio, as ffmpeg's vibrato sweeps it:
 * from 0 to `depth` of a 5 ms buffer and back, so it centres on half of that.
 */
export const vibratoDelay = (depth: number) => ({ base: r6(depth * 0.0025), sweep: r6(depth * 0.0025) })

/** A flanger's delay line for Web Audio (s), its feedback and its dry and wet mix, from ffmpeg's flanger settings. */
export function flangerParams(n: { delay: number; depth: number; regen: number; width: number }) {
  const w = n.width / 100
  return { base: r6((n.delay + n.depth / 2) / 1000), sweep: r6(n.depth / 2000), feedback: n.regen / 100, dry: r3(1 / (1 + w)), wet: r3(w / (1 + w)) }
}
