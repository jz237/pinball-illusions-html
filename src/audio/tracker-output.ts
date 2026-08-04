/**
 * THE BROWSER END OF THE MUSIC: Web Audio scheduling for the pure core's
 * command stream, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE, AGAIN
 * ---------------------------------------------------------------------------
 * Same law as `src/browser/audio.ts`: sound may never affect the simulation.
 * This module takes exactly one input — a `TrackerCommandStream`, a finished
 * value the pure player core has already produced — and returns nothing the
 * game could read. No import from `src/game/`, no state flowing back. And it
 * is failure-tolerant the same way: a browser that refuses an `AudioContext`
 * ends in silence, and silence is a correct outcome.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT WITH THE CORE
 * ---------------------------------------------------------------------------
 * The core is the deterministic half: same song data in, identical command
 * schedule out, testable in node. Its output is the types below — an ordered
 * list of note / pitch / volume / stop commands on four channels (the module engine
 * this reconstructs gave the music Paula channels 0-2 and kept 3 for effects,
 * but the synthesized song owns all four here; the effect channel in
 * `browser/audio.ts` runs on its own nodes regardless). Times are
 * milliseconds from song start. This layer's whole job is the affine map from
 * that clock to `AudioContext.currentTime`, one `AudioBufferSourceNode` per
 * note, pitched by playback rate and scaled by a gain — Paula's period and
 * volume registers, translated.
 *
 * ---------------------------------------------------------------------------
 * LAZINESS AND THE GESTURE
 * ---------------------------------------------------------------------------
 * Construction touches no Web Audio: `createTrackerOutput` stores a factory
 * and `startTracker` is the first thing that calls it, so headless tests (and
 * the module graph itself) never see an `AudioContext`. Autoplay policy is
 * handled the same way `resumeAudio` does it — `resumeTracker` nudges a
 * suspended context and is safe to call on every keypress.
 */

import type { ChipInstrument, InstrumentId } from "./instruments.js";
import { instrumentById, playbackRateFor } from "./instruments.js";

/**
 * WHICH BANK A STREAM PLAYS ON.
 *
 * The instrument bank used to be a closed union — `InstrumentId` and the
 * module-level `instrumentById` — which was fine while there was exactly one
 * bank, the synthesized one. There are now two: the synthesized voices, and the
 * 28 PCM INSTRUMENTS decoded out of the front-end module and shipped as WAVs
 * under the `disk-derived-shell-music` gate. So a bank is a parameter: a
 * resolver from the id a command names to the buffer to play, defaulting to the
 * synthesized one so every existing caller is unchanged.
 *
 * A resolver that answers null means "this stream names a voice this bank does
 * not have", and the note is dropped rather than throwing — a shell whose music
 * asset half-loaded should go quiet, not take the page down.
 */
export type InstrumentBank = (id: string) => ChipInstrument | null;

/** The synthesized bank, as a resolver. */
export const SYNTHESIZED_BANK: InstrumentBank = (id) => {
  try {
    return instrumentById(id as InstrumentId);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// The command stream — the pure core's output format
// ---------------------------------------------------------------------------

export const TRACKER_CHANNELS = 4;

/** Volume is Paula's register scale, 0..64, because the core thinks in it. */
export const TRACKER_MAX_VOLUME = 64;

/** Start an instrument on a channel, replacing whatever it was playing. */
export interface TrackerNoteCommand {
  readonly kind: "note";
  /** Milliseconds from song start. */
  readonly timeMs: number;
  /** 0..TRACKER_CHANNELS-1. */
  readonly channel: number;
  /**
   * The bank's own id for the voice. A plain string rather than the closed
   * `InstrumentId` union, because the disk bank names its voices by instrument
   * number ("disk-11") and a union cannot hold both banks.
   */
  readonly instrument: string;
  readonly frequencyHz: number;
  /** 0..TRACKER_MAX_VOLUME. */
  readonly volume: number;
  /** Effect 9's start point in BYTES into the PCM; 0 for an ordinary note. */
  readonly sampleOffsetBytes?: number;
}

/**
 * Retune the sounding note without retriggering it — a slide or an arpeggio
 * step, Paula's period register rewritten mid-note. A pitch on a silent
 * channel is a no-op, exactly as writing the register of an idle channel is.
 */
export interface TrackerPitchCommand {
  readonly kind: "pitch";
  readonly timeMs: number;
  readonly channel: number;
  readonly frequencyHz: number;
}

/** Change the sounding note's volume without retriggering it. */
export interface TrackerVolumeCommand {
  readonly kind: "volume";
  readonly timeMs: number;
  readonly channel: number;
  readonly volume: number;
}

/** Silence a channel. */
export interface TrackerStopCommand {
  readonly kind: "stop";
  readonly timeMs: number;
  readonly channel: number;
}

export type TrackerCommand =
  | TrackerNoteCommand
  | TrackerPitchCommand
  | TrackerVolumeCommand
  | TrackerStopCommand;

export interface TrackerCommandStream {
  /** One full pass of the song, ascending by `timeMs`. */
  readonly commands: readonly TrackerCommand[];
  /** Length of a pass; the next pass's time origin. */
  readonly durationMs: number;
  /**
   * Where a repeat pass re-enters the command list, or null to play once —
   * the order-list restart field of the module engine, in milliseconds.
   * A repeat must actually advance time (`restartMs < durationMs`) or the
   * stream is treated as play-once rather than spinning forever.
   */
  readonly restartMs: number | null;
  /**
   * THE OTHER BANK, when the pass ended on a `Bxx` whose bit 7 is set: the
   * (bank, position) the machine's loop-jump handler switches to at
   * `+0x0088A8` / `+0x0088B0`. `restartMs` is null for such a pass — it does
   * not loop, it HANDS OVER — and it is not an `F00` stop either, so a
   * controller that sees this plays the named section at `durationMs` instead
   * of falling silent. Absent on every other stream in the shipped corpus:
   * there is exactly one such cell, BabeWatch's game-over section. See
   * `sectionStream` in `table-music.ts`.
   */
  readonly nextSection?: { readonly bank: number; readonly position: number } | null;
}

// ---------------------------------------------------------------------------
// Pure scheduling maths, shared with the tests
// ---------------------------------------------------------------------------

/**
 * The affine map from song time to context time. `passOffsetMs` is the
 * accumulated length of the passes already played (0 during the first).
 */
export function contextTimeFor(
  startContextTime: number,
  timeMs: number,
  passOffsetMs: number = 0,
): number {
  return startContextTime + (passOffsetMs + timeMs) / 1000;
}

/** Paula volume to unit gain, clamped to the register's range. */
export function gainFor(volume: number): number {
  return Math.min(Math.max(volume, 0), TRACKER_MAX_VOLUME) / TRACKER_MAX_VOLUME;
}

// ---------------------------------------------------------------------------
// The output object
// ---------------------------------------------------------------------------

/** The slice of `AudioContext` this module uses, so a test can supply one. */
export interface TrackerHost {
  readonly currentTime: number;
  readonly destination: AudioNode;
  readonly state: string;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  createGain(): GainNode;
  resume(): Promise<void>;
}

/** One sounding note: its source, its own gain, and the instrument it plays —
 * kept so a later pitch command can recompute the playback rate. */
interface ChannelVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  instrument: ChipInstrument;
  /**
   * The context time this voice has been told to stop at, `Infinity` until
   * something tells it.
   *
   * Kept for two reasons. `AudioBufferSourceNode.stop` takes the LAST call and
   * not the earliest, so telling a voice that already stops at T to stop at a
   * later time would EXTEND it — every stop below is guarded on this. And a
   * voice whose stop has passed is finished, which is how `live` stays short.
   */
  stopAt: number;
}

export interface TrackerOutput {
  readonly hostFactory: () => TrackerHost | null;
  /** Where a command's instrument id is resolved. See `InstrumentBank`. */
  bank: InstrumentBank;
  /** Null until `startTracker` first needs it; stays null if the factory fails. */
  host: TrackerHost | null;
  /** Master gain every voice feeds; mute and master volume both live here. */
  master: GainNode | null;
  /**
   * One bus per channel between the voices and the master, so a channel can
   * be ducked LIVE — scheduled volume commands write the per-voice gains and
   * would overwrite a duck applied there. This is Paula's channel 3 rule:
   * while a sound effect is sounding on AUD3 the module engine feeds channel
   * 3's registers to a dummy sink ($800C/$8950 swap a3 to $79DA when the
   * effect flag $2442 is up), and the effect ending gives the channel back.
   */
  readonly channelBuses: (GainNode | null)[];
  /** The level each bus should sit at, applied when the bus is built. */
  readonly channelLevels: number[];
  /** Instrument buffers, built once per host. */
  readonly buffers: Map<string, AudioBuffer>;
  /**
   * The LAST-SCHEDULED voice per channel, so the next note can replace it and
   * a pitch or volume command can reach it.
   *
   * It is not "the sounding voice", which is what this used to say and what
   * `stopTracker` used to assume. The pump runs half a second AHEAD of the
   * clock, so at any moment a channel has one voice actually sounding and
   * several more already committed with `start(when)` in the future — and this
   * slot holds the furthest-future one, not the near one. See `live`.
   */
  readonly channels: (ChannelVoice | null)[];
  /**
   * EVERY VOICE STILL OWED A STOP — the ones the lookahead has committed and
   * the clock has not reached yet.
   *
   * `stopTracker` walked `channels` alone and so stopped one voice per channel
   * out of the several the pump had already scheduled. The rest kept their
   * committed `start(when)` and sounded, which is a real browser behaviour and
   * not a modelling artefact: a source that has been started cannot be
   * un-started, only stopped. Measured on the mixer model, the front-end tune
   * went on at FULL LEVEL for 23 ticks — 0.46 s, the lookahead — after the
   * shell handed over to a ball, and every immediate background set (a tilt,
   * the end-of-ball stop, a mode cue) laid the outgoing section under the new
   * one for the same window.
   *
   * Pruned as it is appended to, so it never grows past the voices in flight.
   */
  live: ChannelVoice[];
  stream: TrackerCommandStream | null;
  /** Context time at which the song's millisecond 0 sounds. */
  startContextTime: number;
  /** Next command to schedule within the current pass. */
  nextIndex: number;
  /** Accumulated milliseconds of completed passes; see `contextTimeFor`. */
  passOffsetMs: number;
  playing: boolean;
  muted: boolean;
  /** Unit master volume, 0..1. Applied at the master gain, not per note. */
  masterVolume: number;
}

/**
 * The real factory. Guarded so merely importing this module — or calling this
 * in node — cannot throw; no context means no music, which is fine.
 */
export function defaultTrackerHostFactory(): TrackerHost | null {
  try {
    const Ctor = (globalThis as { AudioContext?: new () => AudioContext }).AudioContext;
    return Ctor === undefined ? null : (new Ctor() as unknown as TrackerHost);
  } catch {
    return null;
  }
}

/** Builds the output. Touches no Web Audio; the factory waits for `startTracker`. */
export function createTrackerOutput(
  hostFactory: () => TrackerHost | null = defaultTrackerHostFactory,
  bank: InstrumentBank = SYNTHESIZED_BANK,
): TrackerOutput {
  return {
    hostFactory,
    bank,
    host: null,
    master: null,
    channelBuses: Array.from({ length: TRACKER_CHANNELS }, () => null),
    channelLevels: Array.from({ length: TRACKER_CHANNELS }, () => 1),
    buffers: new Map<string, AudioBuffer>(),
    channels: Array.from({ length: TRACKER_CHANNELS }, () => null),
    live: [],
    stream: null,
    startContextTime: 0,
    nextIndex: 0,
    passOffsetMs: 0,
    playing: false,
    muted: false,
    masterVolume: 1,
  };
}

function ensureHost(output: TrackerOutput): TrackerHost | null {
  if (output.host === null) {
    output.host = output.hostFactory();
    if (output.host !== null) {
      const master = output.host.createGain();
      master.gain.value = output.muted ? 0 : output.masterVolume;
      master.connect(output.host.destination);
      output.master = master;
      for (let channel = 0; channel < TRACKER_CHANNELS; channel += 1) {
        const bus = output.host.createGain();
        bus.gain.value = output.channelLevels[channel] ?? 1;
        bus.connect(master);
        output.channelBuses[channel] = bus;
      }
    }
  }
  return output.host;
}

function bufferFor(
  output: TrackerOutput,
  host: TrackerHost,
  id: string,
  instrument: ChipInstrument,
): AudioBuffer {
  const cached = output.buffers.get(id);
  if (cached !== undefined) return cached;
  const buffer = host.createBuffer(1, instrument.samples.length, instrument.sampleRate);
  buffer.getChannelData(0).set(instrument.samples);
  output.buffers.set(id, buffer);
  return buffer;
}

/** Stops a voice at `when`, tolerant of nodes that have already ended. */
function stopVoice(voice: ChannelVoice | null, when: number): void {
  if (voice === null) return;
  // `stop` takes the LAST call, so a later time would extend a voice that is
  // already ending. Only ever bring a stop forward.
  if (when >= voice.stopAt) return;
  voice.stopAt = when;
  try {
    voice.source.stop(when);
  } catch {
    // A node that has already ended throws on `stop` in some engines; it is
    // the outcome we wanted either way. Same note as `browser/audio.ts`.
  }
}

function scheduleNote(
  output: TrackerOutput,
  host: TrackerHost,
  command: TrackerNoteCommand,
  when: number,
): void {
  if (command.channel < 0 || command.channel >= TRACKER_CHANNELS) return;
  const instrument = output.bank(command.instrument);
  // A voice this bank does not have: drop the note. See `InstrumentBank`.
  if (instrument === null) return;

  stopVoice(output.channels[command.channel] ?? null, when);

  const source = host.createBufferSource();
  source.buffer = bufferFor(output, host, command.instrument, instrument);
  source.playbackRate.value = playbackRateFor(instrument, command.frequencyHz);
  if (instrument.loopStart >= 0) {
    source.loop = true;
    source.loopStart = instrument.loopStart / instrument.sampleRate;
    source.loopEnd = instrument.loopEnd / instrument.sampleRate;
  }

  const gain = host.createGain();
  gain.gain.value = gainFor(command.volume);
  source.connect(gain);
  const sink = output.channelBuses[command.channel] ?? output.master;
  if (sink !== null) gain.connect(sink);
  // Effect 9 starts the note part-way into the PCM. The command carries BYTES
  // because that is what `9xx` means on Paula; the buffer is one sample a byte
  // for a disk instrument, so the two agree, and a synthesized instrument never
  // carries the field at all.
  const offsetBytes = command.sampleOffsetBytes ?? 0;
  if (offsetBytes > 0 && offsetBytes < instrument.samples.length) {
    source.start(when, offsetBytes / instrument.sampleRate);
  } else {
    source.start(when);
  }

  const voice: ChannelVoice = { source, gain, instrument, stopAt: Infinity };
  output.channels[command.channel] = voice;
  // Everything the lookahead has committed, so a stop can reach all of it.
  // Pruned here rather than on a timer: a voice whose stop has passed is done.
  const settled = host.currentTime;
  if (output.live.length > 0) {
    output.live = output.live.filter((one) => one.stopAt > settled);
  }
  output.live.push(voice);
}

function scheduleCommand(output: TrackerOutput, host: TrackerHost, command: TrackerCommand): void {
  const when = contextTimeFor(output.startContextTime, command.timeMs, output.passOffsetMs);
  switch (command.kind) {
    case "note":
      scheduleNote(output, host, command, when);
      break;
    case "pitch": {
      const voice = output.channels[command.channel] ?? null;
      if (voice !== null) {
        voice.source.playbackRate.setValueAtTime(
          playbackRateFor(voice.instrument, command.frequencyHz),
          when,
        );
      }
      break;
    }
    case "volume": {
      const voice = output.channels[command.channel] ?? null;
      if (voice !== null) voice.gain.gain.setValueAtTime(gainFor(command.volume), when);
      break;
    }
    case "stop": {
      stopVoice(output.channels[command.channel] ?? null, when);
      output.channels[command.channel] = null;
      break;
    }
  }
}

/** First command index at or after the restart point. */
function restartIndex(stream: TrackerCommandStream, restartMs: number): number {
  let index = 0;
  while (index < stream.commands.length) {
    const command = stream.commands[index];
    if (command !== undefined && command.timeMs >= restartMs) break;
    index += 1;
  }
  return index;
}

/**
 * Schedules every command due within the lookahead window. Call it from the
 * shell's frame callback; it is cheap when there is nothing to do. The window
 * is generous enough that a dropped frame or two never starves the music, and
 * short enough that a `stopTracker` does not leave half a minute of notes
 * queued on dead nodes.
 */
export function pumpTracker(output: TrackerOutput, lookaheadSeconds: number = 0.5): void {
  if (!output.playing || output.stream === null || output.host === null) return;
  const stream = output.stream;
  const horizon = output.host.currentTime + lookaheadSeconds;

  for (;;) {
    if (output.nextIndex >= stream.commands.length) {
      const restartMs = stream.restartMs;
      if (restartMs === null || restartMs >= stream.durationMs) {
        // Played out, no repeat (a restart that does not advance time counts
        // as none, rather than spinning). The looping voices sustain, which
        // is the module engine's behaviour too; `stopTracker` is the off
        // switch.
        return;
      }
      output.passOffsetMs += stream.durationMs - restartMs;
      output.nextIndex = restartIndex(stream, restartMs);
      if (output.nextIndex >= stream.commands.length) return; // nothing after restart
      continue;
    }
    const command = stream.commands[output.nextIndex];
    if (command === undefined) return;
    if (contextTimeFor(output.startContextTime, command.timeMs, output.passOffsetMs) > horizon) {
      return;
    }
    scheduleCommand(output, output.host, command);
    output.nextIndex += 1;
  }
}

/**
 * Starts a song. Builds the context on first use (this is the lazy edge);
 * answers whether playback actually began — false means no audio device, and
 * false is not an error. `atContextTime` pins the moment playback begins;
 * omitted, the song starts now.
 *
 * `fromMs` ENTERS THE STREAM PART-WAY THROUGH ITS OWN PASS, which is how a
 * background resumes after an override has interrupted it: the module engine
 * saves the whole song state at $815E and copies it back at $821C, so the
 * interrupted tune carries on from the row it was on rather than restarting.
 * Here that is an offset of the song clock — `startContextTime` is pushed back
 * so song millisecond `fromMs` lands at `atContextTime` — and the commands
 * before it are skipped rather than scheduled in the past. The note that was
 * mid-flight at the interruption is NOT re-triggered; that is the one part of
 * the register file this model does not carry.
 */
export function startTracker(
  output: TrackerOutput,
  stream: TrackerCommandStream,
  atContextTime?: number,
  fromMs: number = 0,
): boolean {
  const host = ensureHost(output);
  if (host === null) return false;
  // A start scheduled for the future stops the OLD stream's voices at that
  // same moment, so a section handover — the in-game music switching at a
  // loop boundary, exactly where the machine's queued command lands — is a
  // splice rather than a gap.
  stopTracker(output, atContextTime);
  const entryMs = Math.min(Math.max(fromMs, 0), stream.durationMs);
  output.stream = stream;
  output.startContextTime = (atContextTime ?? host.currentTime) - entryMs / 1000;
  output.nextIndex = entryMs === 0 ? 0 : restartIndex(stream, entryMs);
  output.passOffsetMs = 0;
  output.playing = true;
  pumpTracker(output);
  return true;
}

/**
 * Stops everything — now, or at `atContextTime` for a scheduled handover.
 * Safe to call twice, or before anything started.
 *
 * EVERY VOICE, not one per channel. The pump commits up to half a second of
 * notes ahead of the clock and a started source cannot be un-started, so a
 * stop that only reached `channels` left the rest of the lookahead to play
 * out: the shell's tune ran on over the first 0.46 s of every ball, and every
 * immediate background set laid the outgoing section under the incoming one
 * for the same window. Voices already ending sooner than `when` keep their own
 * ending — `stopVoice` only ever brings a stop forward.
 */
export function stopTracker(output: TrackerOutput, atContextTime?: number): void {
  const now = output.host === null ? 0 : output.host.currentTime;
  const when = atContextTime === undefined ? now : Math.max(atContextTime, now);
  for (const voice of output.live) stopVoice(voice, when);
  output.live = output.live.filter((one) => one.stopAt > now);
  for (let channel = 0; channel < output.channels.length; channel += 1) {
    output.channels[channel] = null;
  }
  output.playing = false;
  output.stream = null;
  output.nextIndex = 0;
  output.passOffsetMs = 0;
}

/**
 * Sets a channel's live level, 0..1 — the in-game arbitration switch: the
 * effects layer owns Paula channel 3, and while an effect is sounding the
 * module's channel 3 is held at 0 exactly as the original's $800C/$8950
 * redirect its register writes. Scheduling continues underneath, so the
 * channel rejoins the song mid-phrase when the effect ends, which is what
 * the hardware does when the DMA feed comes back.
 */
export function setTrackerChannelLevel(output: TrackerOutput, channel: number, level: number): void {
  if (channel < 0 || channel >= TRACKER_CHANNELS) return;
  const clamped = Math.min(Math.max(level, 0), 1);
  output.channelLevels[channel] = clamped;
  const bus = output.channelBuses[channel] ?? null;
  if (bus !== null) bus.gain.value = clamped;
}

/**
 * Mute at the master gain: scheduling continues, so unmuting rejoins the song
 * mid-phrase instead of restarting it. Returns the new state, for a display.
 */
export function setTrackerMuted(output: TrackerOutput, muted: boolean): boolean {
  output.muted = muted;
  if (output.master !== null) output.master.gain.value = muted ? 0 : output.masterVolume;
  return output.muted;
}

/** Master volume, 0..1, clamped. Applied unless muted. Returns what stuck. */
export function setTrackerMasterVolume(output: TrackerOutput, volume: number): number {
  output.masterVolume = Math.min(Math.max(volume, 0), 1);
  if (output.master !== null && !output.muted) output.master.gain.value = output.masterVolume;
  return output.masterVolume;
}

/**
 * Nudges a suspended context, for browsers that will not start audio until
 * the player has interacted with the page. Safe to call on every keypress;
 * does nothing before the context exists. Mirrors `resumeAudio`.
 */
export function resumeTracker(output: TrackerOutput): void {
  if (output.host === null || output.host.state !== "suspended") return;
  void output.host.resume().catch(() => {
    // An autoplay policy that will not budge is silence, not an error.
  });
}
