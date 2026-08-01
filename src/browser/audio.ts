/**
 * PLAYING THE MACHINE'S SOUNDS, strictly downstream of the simulation.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE
 * ---------------------------------------------------------------------------
 * Audio may never affect the physics or the replay. Nothing in this file is
 * imported by anything under `src/game/`, nothing here is read back by the loop,
 * and the only thing it is given is a `GameTickReport` — a value the tick has
 * already finished producing. So the same input log replays to the same bytes
 * with the sound off, with the audio device refusing to open, and while
 * `decodeAudioData` is still working on the first buffer.
 *
 * That is also why every entry point here is failure-tolerant rather than
 * throwing: a browser that will not give us an `AudioContext`, a WAV that will
 * not decode, an autoplay policy that keeps the context suspended until the
 * player touches the keyboard — all of those end in silence, and silence is a
 * correct outcome for a pinball table.
 *
 * ---------------------------------------------------------------------------
 * ONE EFFECT AT A TIME, BY PRIORITY, BECAUSE PAULA HAS ONE CHANNEL FOR THEM
 * ---------------------------------------------------------------------------
 * The original's mixing policy is two instructions. `$779E` starts an effect by
 * first testing the request against whatever is sounding:
 *
 *     cmp.w  $2(a1),d7      ; d7 = the new record's priority
 *     bcs    skip           ; lower than what is playing -> drop it
 *
 * and `$09D2` sets the channel's DMACON mask to `#$8`, which is bit 3: AUD3. So
 * sound effects own Paula channel 3 and the music has 0, 1 and 2. One effect
 * sounds at a time and a quieter event never interrupts a louder one — which is
 * why a bumper does not stamp all over a mission callout.
 *
 * `EffectChannel` is that, and only that: one source node, the priority it is
 * playing at, and when it will finish. There is no mixer, no reverb and no
 * ducking, because the machine had none.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS BOUND, AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * Bound, from the packages: every device (drop targets and stand-ups), both
 * bumper banks, both slingshots, and every trigger zone that carries a sound —
 * the lane rollovers, the ramp entries and the ball locks. A mission start
 * plays the sound of the element it lights, because that is where the mode's
 * sound record hangs.
 *
 * NOT bound: THE DRAIN. No zone object on any of the three tables carries a
 * sound record at the outlanes or the middle, and there is no drain entry in the
 * device chain either. Something in the original certainly makes a noise when
 * the ball goes — but it is not in the data this decode can see, and inventing a
 * sample for it would be putting a noise in the player's ears that the machine
 * never made. So a drain is silent, and this paragraph is the reason.
 */

import type { Award } from "../game/scoring.js";
import type { AudioSample, TableAudio } from "../game/table-audio.js";
import { PAULA_MAX_VOLUME, audioSampleUrl } from "../game/table-audio.js";
import type { GameTickReport } from "./game-loop.js";

/** The slice of `AudioContext` this module uses, so a test can supply one. */
export interface AudioHost {
  readonly currentTime: number;
  readonly destination: AudioNode;
  readonly state: string;
  createBufferSource(): AudioBufferSourceNode;
  createGain(): GainNode;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  resume(): Promise<void>;
}

/** What one sounding effect is, mirroring the original's channel block. */
interface EffectChannel {
  source: AudioBufferSourceNode | null;
  priority: number;
  /** `host.currentTime` at which the sounding effect ends. */
  until: number;
}

export interface AudioBank {
  readonly host: AudioHost;
  readonly audio: TableAudio;
  /** Sample index to decoded buffer. Absent while a WAV is still decoding. */
  readonly buffers: Map<number, AudioBuffer>;
  readonly channel: EffectChannel;
  /** Player's mute. Nothing else in the machine reads it. */
  muted: boolean;
  /** Samples that failed to fetch or decode, so a caller can say so once. */
  readonly failed: Set<number>;
}

export function createAudioBank(host: AudioHost, audio: TableAudio): AudioBank {
  return {
    host,
    audio,
    buffers: new Map<number, AudioBuffer>(),
    channel: { source: null, priority: 0, until: 0 },
    muted: false,
    failed: new Set<number>(),
  };
}

/** The slice of `fetch` this module needs. */
export interface AudioFetchResponse {
  readonly ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type AudioFetch = (url: string) => Promise<AudioFetchResponse>;

const defaultFetch: AudioFetch = (url) => fetch(url);

/**
 * Fetches and decodes every sample the manifest lists.
 *
 * Resolves when it is done and NEVER REJECTS: a sample that will not load is
 * recorded in `failed` and the rest of the table still has sound. Loading is
 * sequential rather than parallel because the whole bank is a few tens of
 * kilobytes and a burst of parallel decodes on the boot path buys nothing.
 */
export async function loadAudioBank(
  bank: AudioBank,
  fetchImpl: AudioFetch = defaultFetch,
  basePath?: string,
): Promise<void> {
  for (const sample of bank.audio.samples) {
    try {
      const response = await fetchImpl(audioSampleUrl(sample, basePath));
      if (!response.ok) {
        bank.failed.add(sample.index);
        continue;
      }
      bank.buffers.set(sample.index, await bank.host.decodeAudioData(await response.arrayBuffer()));
    } catch {
      bank.failed.add(sample.index);
    }
  }
}

/**
 * Plays one sample, if a louder one is not already sounding.
 *
 * The refusal is `$779E`'s: `cmp.w $2(a1),d7 / bcs` drops a request whose
 * priority is BELOW the sounding effect's, and lets an equal one through. The
 * gain is Paula's volume register over its full scale, which is what that
 * register is — a linear multiplier on the sample byte, not a decibel figure.
 *
 * Answers whether it actually started something, which is what a test asserts on.
 */
export function playSample(bank: AudioBank, sample: AudioSample): boolean {
  if (bank.muted) return false;
  const buffer = bank.buffers.get(sample.index);
  if (buffer === undefined) return false;

  const now = bank.host.currentTime;
  if (now < bank.channel.until && sample.priority < bank.channel.priority) return false;

  try {
    bank.channel.source?.stop();
  } catch {
    // A node that has already ended throws on `stop` in some engines; it is the
    // outcome we wanted either way.
  }

  const source = bank.host.createBufferSource();
  source.buffer = buffer;
  const gain = bank.host.createGain();
  gain.gain.value = sample.volume / PAULA_MAX_VOLUME;
  source.connect(gain);
  gain.connect(bank.host.destination);
  source.start();

  bank.channel.source = source;
  bank.channel.priority = sample.priority;
  bank.channel.until = now + sample.milliseconds / 1000;
  return true;
}

/** Plays whatever one award is bound to, if anything is. */
export function playAward(bank: AudioBank, award: Award): boolean {
  const sample = bank.audio.sampleForAward(award.id);
  return sample === null ? false : playSample(bank, sample);
}

/**
 * Plays one tick's worth of sound.
 *
 * Takes a finished tick report and nothing else. Awards are visited in the order
 * they scored, so the priority rule decides between two events on the same frame
 * exactly as it would between two frames — and the loudest one wins whichever
 * order the physics happened to produce them in.
 *
 * The drain is deliberately silent; see the header.
 */
export function playTick(bank: AudioBank, report: GameTickReport): void {
  if (bank.muted) return;
  for (const award of report.awards) playAward(bank, award);
}

/**
 * Nudges a suspended context, for browsers that will not start audio until the
 * player has interacted with the page. Safe to call on every keypress.
 */
export function resumeAudio(bank: AudioBank): void {
  if (bank.host.state !== "suspended") return;
  void bank.host.resume().catch(() => {
    // An autoplay policy that will not budge is silence, not an error.
  });
}

/** Turns the sound off or on. Returns the new state, for a display. */
export function setMuted(bank: AudioBank, muted: boolean): boolean {
  bank.muted = muted;
  if (muted) {
    try {
      bank.channel.source?.stop();
    } catch {
      // See `playSample`.
    }
    bank.channel.source = null;
    bank.channel.until = 0;
    bank.channel.priority = 0;
  }
  return bank.muted;
}
