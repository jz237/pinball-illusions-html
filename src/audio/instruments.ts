/**
 * SYNTHESIZED CHIP INSTRUMENTS, generated in code, owing nothing to the disks.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE EXIST
 * ---------------------------------------------------------------------------
 * These were written under a project rule the operator has since reversed: the
 * original module's PCM was treated as preservation media that could not ship,
 * so a new composition on synthesized voices stood in for it. The original
 * front-end module now ships, gated, under `disk-derived-shell-music` (see
 * `shell-music.ts`), and the stand-in composition is deleted.
 *
 * THE BANK STAYS, because a bank is now a parameter (`InstrumentBank` in
 * `tracker-output.ts`): these voices are what a build with no authorized
 * assets falls back to, and what the tracker's own tests play. They are short
 * looped waveforms in the idiom of the machine — an Amiga instrument IS a small
 * sample with a loop window, pitched by playback rate — but every byte of them
 * is computed here and owes the disks nothing.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF AN INSTRUMENT
 * ---------------------------------------------------------------------------
 * Each instrument is a mono Float32Array holding a few dozen cycles of a
 * waveform with a volume envelope baked in: a short linear attack, a linear
 * decay to a sustain level, then a flat sustain tail that the loop window
 * covers. The loop window is a whole number of cycles and the envelope is
 * constant across it, so looping is exactly periodic — no click, no drift.
 * Percussion is a one-shot noise burst (loopStart -1) that decays to silence.
 *
 * Every buffer is rendered at `baseFrequency`; a player reproduces a pitch by
 * scaling playback rate, which is `playbackRateFor` — the same trick as
 * Paula's period register, wearing Web Audio clothes.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 * Generation uses arithmetic only — no `Math.random`, and no `Math.sin`
 * either, because transcendentals are allowed to differ between JS engines.
 * The "sine-ish" bass is a parabolic approximation; the noise burst comes
 * from a fixed-seed 32-bit LCG. Same code, same bytes, every run, every
 * engine — which is what lets a test pin the hashes.
 */

/** Stable ids the song format references. Renaming one breaks songs; do not. */
export type InstrumentId =
  | "pulse50"
  | "pulse25"
  | "pulse12"
  | "triangle"
  | "sawtooth"
  | "bass"
  | "noise";

export const INSTRUMENT_IDS: readonly InstrumentId[] = [
  "pulse50",
  "pulse25",
  "pulse12",
  "triangle",
  "sawtooth",
  "bass",
  "noise",
];

export interface ChipInstrument {
  readonly id: InstrumentId;
  /** Mono samples in [-1, 1], envelope baked in. */
  readonly samples: Float32Array;
  /** The rate at which `samples` reproduces `baseFrequency`. */
  readonly sampleRate: number;
  /** Pitch an unshifted playback of the buffer produces, in Hz. */
  readonly baseFrequency: number;
  /** Samples per waveform cycle; 0 for the aperiodic noise burst. */
  readonly cycleLength: number;
  /** First sample of the loop window, or -1 for a one-shot. */
  readonly loopStart: number;
  /** One past the last sample of the loop window, or -1 for a one-shot. */
  readonly loopEnd: number;
}

/** Samples per waveform cycle for the pitched instruments. */
export const CYCLE = 32;

/**
 * All pitched buffers are rendered at A-4. The number itself is arbitrary; it
 * only fixes what playbackRate 1 means. 440 Hz x 32 samples puts the buffer's
 * sample rate at 14080 Hz, comfortably inside what `AudioBuffer` accepts.
 */
export const BASE_FREQUENCY = 440;
export const INSTRUMENT_SAMPLE_RATE = BASE_FREQUENCY * CYCLE;

/** Envelope, in cycles. Attack + decay precede the loop; sustain IS the loop. */
const ATTACK_CYCLES = 2;
const DECAY_CYCLES = 8;
const SUSTAIN_CYCLES = 4;
const SUSTAIN_LEVEL = 0.6;

/** Headroom so four channels at full volume do not clip the master. */
const AMPLITUDE = 0.5;

/** Noise burst length and per-sample decay. 2048 samples ~ 145 ms. */
const NOISE_LENGTH = 2048;
const NOISE_DECAY = 0.9965;
const NOISE_SEED = 0x1d872b41;

/**
 * The envelope value at sample `i`: linear attack to 1, linear decay to the
 * sustain level, then flat. Flat is load-bearing — it is what makes the loop
 * window exactly periodic.
 */
function envelopeAt(i: number): number {
  const attackEnd = ATTACK_CYCLES * CYCLE;
  const decayEnd = attackEnd + DECAY_CYCLES * CYCLE;
  if (i < attackEnd) return i / attackEnd;
  if (i < decayEnd) return 1 - (1 - SUSTAIN_LEVEL) * ((i - attackEnd) / (decayEnd - attackEnd));
  return SUSTAIN_LEVEL;
}

/** Renders one pitched instrument from a single-cycle wave function of phase. */
function renderPitched(id: InstrumentId, wave: (phase: number) => number): ChipInstrument {
  const totalCycles = ATTACK_CYCLES + DECAY_CYCLES + SUSTAIN_CYCLES;
  const samples = new Float32Array(totalCycles * CYCLE);
  for (let i = 0; i < samples.length; i += 1) {
    const phase = (i % CYCLE) / CYCLE;
    // Math.fround pins each stored value to the float32 the array would hold
    // anyway; spelling it out keeps the generator's arithmetic explicit.
    samples[i] = Math.fround(AMPLITUDE * envelopeAt(i) * wave(phase));
  }
  const loopStart = (ATTACK_CYCLES + DECAY_CYCLES) * CYCLE;
  return {
    id,
    samples,
    sampleRate: INSTRUMENT_SAMPLE_RATE,
    baseFrequency: BASE_FREQUENCY,
    cycleLength: CYCLE,
    loopStart,
    loopEnd: samples.length,
  };
}

/** Pulse wave at a duty cycle. 50% is the square; narrower is reedier. */
function pulse(duty: number): (phase: number) => number {
  return (phase) => (phase < duty ? 1 : -1);
}

/** Triangle: -1 at phase 0, +1 at phase 0.5, back down. */
function triangle(phase: number): number {
  return phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
}

/** Sawtooth, rising. */
function sawtooth(phase: number): number {
  return 2 * phase - 1;
}

/**
 * The "sine-ish" bass: a parabolic sine approximation, chosen over `Math.sin`
 * because it is exact arithmetic — deterministic on every engine — and its
 * gentle harmonic content reads as a soft chip bass anyway.
 */
function parabolicSine(phase: number): number {
  return phase < 0.5 ? 16 * phase * (0.5 - phase) : -16 * (phase - 0.5) * (1 - phase);
}

/**
 * The percussion burst: fixed-seed LCG noise under a multiplicative decay.
 * `Math.imul` keeps the multiply in 32 bits, so the sequence is the same
 * everywhere. One-shot; a player lets it run out.
 */
function renderNoise(): ChipInstrument {
  const samples = new Float32Array(NOISE_LENGTH);
  let state = NOISE_SEED;
  let level = 1;
  for (let i = 0; i < NOISE_LENGTH; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    // Top 24 bits, mapped to [-1, 1).
    const white = ((state >>> 8) / 0x800000) - 1;
    samples[i] = Math.fround(AMPLITUDE * level * white);
    level *= NOISE_DECAY;
  }
  return {
    id: "noise",
    samples,
    sampleRate: INSTRUMENT_SAMPLE_RATE,
    baseFrequency: BASE_FREQUENCY,
    cycleLength: 0,
    loopStart: -1,
    loopEnd: -1,
  };
}

/**
 * Builds the whole bank, fresh. Pure and deterministic: two calls return
 * byte-identical buffers, which the tests assert by hash.
 */
export function buildInstruments(): readonly ChipInstrument[] {
  return [
    renderPitched("pulse50", pulse(0.5)),
    renderPitched("pulse25", pulse(0.25)),
    renderPitched("pulse12", pulse(0.125)),
    renderPitched("triangle", triangle),
    renderPitched("sawtooth", sawtooth),
    renderPitched("bass", parabolicSine),
    renderNoise(),
  ];
}

let cachedBank: Map<InstrumentId, ChipInstrument> | null = null;

/** The shared bank, built once on first use. Throws on an unknown id. */
export function instrumentById(id: InstrumentId): ChipInstrument {
  if (cachedBank === null) {
    cachedBank = new Map<InstrumentId, ChipInstrument>();
    for (const instrument of buildInstruments()) cachedBank.set(instrument.id, instrument);
  }
  const found = cachedBank.get(id);
  if (found === undefined) throw new Error(`unknown instrument: ${id}`);
  return found;
}

/**
 * The playback rate that makes `instrument` sound `frequencyHz` — Paula's
 * period register, inverted. Pure; the output layer and the tests share it.
 */
export function playbackRateFor(instrument: ChipInstrument, frequencyHz: number): number {
  return frequencyHz / instrument.baseFrequency;
}
