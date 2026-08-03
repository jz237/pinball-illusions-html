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
 * ducking, because the machine had none. The ENGINE'S sounds and the TABLE'S
 * sounds go through the one channel together, exactly as they share AUD3.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS BOUND, AND FROM WHERE
 * ---------------------------------------------------------------------------
 * Two manifests feed one bank. The TABLE manifest carries the package's own
 * records — devices, bumpers, slingshots, trigger zones, the lock-eject
 * voices, and the award/mode sting layer — keyed by the ids the tick report
 * already carries (`device-36`, `zone-0-8`, `mode-element-15`, ...). The
 * ENGINE manifest carries the seven sounds `main.bin` plays itself, keyed by
 * event name; `playTick` maps the report's fields onto them:
 *
 *     report.served          -> "serve"           (h10+$4E, sites $45E0/$5110/$6616)
 *     report.drained         -> "drain"           (h10+$34, site $52B4)
 *     report.locked          -> "capture"         (h10+$82, site $5574)
 *     report.ejectedFrom     -> the saucer's own `zone-eject-L-N` record, or
 *                               the generic "eject" (h10+$9C, site $701A)
 *     report.levelTransfers  -> "level-transfer"  (h10+$68, sites $B258/$B270)
 *     report.flipperRaised   -> "flipper-raise"   (h10+$00, sites $A7A2/$A7C8)
 *     report.flipperRested   -> "flipper-rest"    (h10+$1A, site $A79A)
 *
 * THE DRAIN IS NO LONGER SILENT. An earlier round bound nothing to it and
 * argued from the table packages — no zone object carries a drain sound, which
 * is true — but the sound is the ENGINE'S: main.seg00 plays its own drain
 * record from `$52B4` on every ball out. The census (research/SOUND_CENSUS.md)
 * corrected the record, and the ball search's write-offs go through the same
 * drain lifecycle, so they drain audibly too.
 *
 * STILL SILENT, BY DECODE: the LAUNCH — the fixed kick at 0x65EE has no sound
 * call; the serve jingle is the lane's delivery sound and the shot itself makes
 * none — the TILT, whose only effect is the music/effects state change, and
 * GAME OVER, which has no dedicated record; the last thing the machine plays
 * there is the final drain, and that is what this port plays too.
 */

import type { Award } from "../game/scoring.js";
import type { AudioSample, EngineAudio, TableAudio } from "../game/table-audio.js";
import {
  ENGINE_AUDIO_BASE_PATH,
  PAULA_MAX_VOLUME,
  audioSampleUrl,
} from "../game/table-audio.js";
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
  /** The engine's seven sounds, or null when their manifest did not load. */
  readonly engine: EngineAudio | null;
  /**
   * Decoded buffers keyed by the sample's FILE NAME, which is unique across
   * both manifests where the numeric index is not. Absent while decoding.
   */
  readonly buffers: Map<string, AudioBuffer>;
  readonly channel: EffectChannel;
  /** Player's mute. Nothing else in the machine reads it. */
  muted: boolean;
  /** Files that failed to fetch or decode, so a caller can say so once. */
  readonly failed: Set<string>;
}

export function createAudioBank(
  host: AudioHost,
  audio: TableAudio,
  engine: EngineAudio | null = null,
): AudioBank {
  return {
    host,
    audio,
    engine,
    buffers: new Map<string, AudioBuffer>(),
    channel: { source: null, priority: 0, until: 0 },
    muted: false,
    failed: new Set<string>(),
  };
}

/** The slice of `fetch` this module needs. */
export interface AudioFetchResponse {
  readonly ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type AudioFetch = (url: string) => Promise<AudioFetchResponse>;

const defaultFetch: AudioFetch = (url) => fetch(url);

async function loadSamples(
  bank: AudioBank,
  samples: readonly AudioSample[],
  fetchImpl: AudioFetch,
  basePath: string | undefined,
): Promise<void> {
  for (const sample of samples) {
    try {
      const response = await fetchImpl(audioSampleUrl(sample, basePath));
      if (!response.ok) {
        bank.failed.add(sample.file);
        continue;
      }
      bank.buffers.set(sample.file, await bank.host.decodeAudioData(await response.arrayBuffer()));
    } catch {
      bank.failed.add(sample.file);
    }
  }
}

/**
 * Fetches and decodes every sample both manifests list.
 *
 * Resolves when it is done and NEVER REJECTS: a sample that will not load is
 * recorded in `failed` and the rest of the machine still has sound. Loading is
 * sequential rather than parallel because the whole bank is under two hundred
 * kilobytes and a burst of parallel decodes on the boot path buys nothing.
 */
export async function loadAudioBank(
  bank: AudioBank,
  fetchImpl: AudioFetch = defaultFetch,
  basePath?: string,
  engineBasePath: string = ENGINE_AUDIO_BASE_PATH,
): Promise<void> {
  await loadSamples(bank, bank.audio.samples, fetchImpl, basePath);
  if (bank.engine !== null) {
    await loadSamples(bank, bank.engine.samples, fetchImpl, engineBasePath);
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
  const buffer = bank.buffers.get(sample.file);
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
 * Plays a table-manifest trigger by id. Answers whether the id is BOUND —
 * not whether it sounded, because a bound sound refused by a louder one is
 * still the event's sound and must not fall through to a substitute.
 */
function playTableTrigger(bank: AudioBank, id: string): boolean {
  const sample = bank.audio.sampleForAward(id);
  if (sample === null) return false;
  playSample(bank, sample);
  return true;
}

/** Plays one of the engine's seven sounds, if the manifest loaded. */
function playEngineTrigger(bank: AudioBank, id: string): void {
  const sample = bank.engine?.sampleFor(id) ?? null;
  if (sample !== null) playSample(bank, sample);
}

/**
 * Plays one tick's worth of sound.
 *
 * Takes a finished tick report and nothing else. Within the tick the requests
 * are made in the order below, and the priority rule decides between them
 * exactly as it decides between two frames — so a flipper thump (priority 40)
 * never displaces the mission callout it landed under, while a drain (45)
 * speaks over the flipper that failed to save it.
 *
 * Awards are visited in the order they scored; they include the mode VM's
 * `mode-element-N` awards, which is how the award fanfares and the display
 * stings attributed to an element's AWARD path fire. `elementStarts` and
 * `messagesShown` carry the START-path sounds and the message stings — the
 * original queues those display programs on its ring and the sting plays when
 * the display does; this port plays it on the tick the record is queued, which
 * is at most a few frames early.
 */
export function playTick(bank: AudioBank, report: GameTickReport): void {
  if (bank.muted) return;
  for (const award of report.awards) playAward(bank, award);
  for (const element of report.elementStarts) playTableTrigger(bank, `mode-start-${element}`);
  for (const message of report.messagesShown) playTableTrigger(bank, `mode-message-${message}`);

  if (report.served) playEngineTrigger(bank, "serve");
  if (report.locked.length > 0) playEngineTrigger(bank, "capture");
  for (const zone of report.ejectedFrom) {
    // The saucer's own eject voice when the table records one (the object's
    // +$10 record); the engine's generic eject otherwise — the popper's own
    // fallback for held objects without a sub-record.
    if (!playTableTrigger(bank, `zone-eject-${zone.level}-${zone.index}`)) {
      playEngineTrigger(bank, "eject");
    }
  }
  if (report.levelTransfers.length > 0) playEngineTrigger(bank, "level-transfer");
  // `drained` includes the ball search's write-offs on purpose: a written-off
  // ball ends through the drain lifecycle, so it drains audibly.
  if (report.drained.length > 0) playEngineTrigger(bank, "drain");
  for (const side of report.flipperRaised) {
    void side; // one flag per side, one call per flag, as $A790 makes them
    playEngineTrigger(bank, "flipper-raise");
  }
  for (const side of report.flipperRested) {
    void side;
    playEngineTrigger(bank, "flipper-rest");
  }
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
