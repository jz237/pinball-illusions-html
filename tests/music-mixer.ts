/**
 * A MIXER YOU CAN LISTEN TO — the instrument this project did not have.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 * The audio layers each had unit coverage: the tracker core renders the right
 * command stream, the bank decodes, the controller fires the right cue for the
 * right report. Every one of those tests handed the controller a table whose
 * asset was ALREADY LOADED and asked whether it called `startTracker`. None of
 * them asked the only question a player asks — IS ANYTHING COMING OUT — and so
 * a whole ball of silence sat in the shipped build behind a green suite.
 *
 * This is the missing half: a `TrackerHost` that builds the same node graph the
 * browser would and can then be ASKED, at any context time, what level is
 * reaching the destination. Not a spy on the calls; a model of the graph:
 *
 *   - every `GainNode` remembers what it is connected to, so the level of a
 *     voice is the product of the gains along its own path to `destination` —
 *     which is what makes the MASTER MUTE and the CHANNEL-3 DUCK visible here
 *     rather than merely assumed;
 *   - `AudioParam.setValueAtTime` is kept as automation and evaluated at the
 *     sample time, because the tracker's volume commands are scheduled ahead;
 *   - a voice sounds from its `start(when)` until its `stop(when)`, bounded by
 *     the buffer's own length when the instrument does not loop.
 *
 * `audibleAt(t)` is therefore a genuine statement about the output, and a zero
 * from it means silence in a browser too.
 */

import type { TrackerHost, TrackerOutput } from "../src/audio/tracker-output.js";
import { TRACKER_CHANNELS } from "../src/audio/tracker-output.js";

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/** One `AudioParam`: a base value plus the scheduled steps written onto it. */
class FakeParam {
  value: number;
  readonly events: { readonly at: number; readonly to: number }[] = [];

  constructor(value: number) {
    this.value = value;
  }

  setValueAtTime(to: number, at: number): FakeParam {
    this.events.push({ at, to });
    return this;
  }

  /** The value in force at context time `t`. */
  at(t: number): number {
    let value = this.value;
    let latest = -Infinity;
    for (const event of this.events) {
      if (event.at <= t && event.at >= latest) {
        latest = event.at;
        value = event.to;
      }
    }
    return value;
  }

  /**
   * ∫ value dτ over [t0, t1] — the CONTENT DISTANCE a playback-rate param
   * covers in that window, for the renderer below. Piecewise-constant, like
   * the param itself: `setValueAtTime` steps, no ramps (the tracker schedules
   * none). Events arrive in schedule order, which the pump keeps ascending,
   * but sort defensively — an out-of-order write would silently skew every
   * position after it.
   */
  integrate(t0: number, t1: number): number {
    if (t1 <= t0) return 0;
    const events = [...this.events].sort((a, b) => a.at - b.at);
    let total = 0;
    let from = t0;
    let value = this.at(t0);
    for (const event of events) {
      if (event.at <= from) continue;
      if (event.at >= t1) break;
      total += value * (event.at - from);
      from = event.at;
      value = event.to;
    }
    total += value * (t1 - from);
    return total;
  }
}

class FakeGain {
  readonly gain = new FakeParam(1);
  target: FakeGain | "destination" | null = null;

  connect(node: unknown): void {
    this.target = node === DESTINATION ? "destination" : (node as FakeGain);
  }

  disconnect(): void {
    this.target = null;
  }
}

const DESTINATION = { connect(): void {} } as unknown as AudioNode;

/**
 * The buffer object this model hands out: the length/rate pair the scheduling
 * maths reads, PLUS the actual PCM — `getChannelData` answers one persistent
 * array, so what the tracker writes into it is what the renderer below reads
 * back out. The old model returned a fresh empty array per call, which made
 * `audibleAt` a statement about GAINS only; retaining the content is what
 * turns the same graph into a signal that can be peak- and RMS-measured.
 */
interface ModelBuffer {
  readonly length: number;
  readonly sampleRate: number;
  readonly data: Float32Array;
  getChannelData(channel: number): Float32Array;
}

/** One scheduled note, as the graph holds it. */
export interface Voice {
  readonly start: number;
  stop: number;
  readonly gain: FakeGain | null;
  readonly loop: boolean;
  /** Seconds of PCM, at the rate it is played back at. Infinite when looping. */
  readonly seconds: number;
  /**
   * The buffer this voice is playing, so a caller can say WHICH sound it is.
   * The tracker's voices carry its synthesised instrument buffers; an effect's
   * carries the decoded WAV, and `AudioBank.buffers` maps those back to files.
   */
  readonly buffer: unknown;
  /** The playback-rate param, with its scheduled pitch steps. */
  readonly rate: FakeParam;
  /** `start(when, offset)`'s offset — effect 9's entry point, in seconds. */
  readonly offsetSeconds: number;
  /** The loop window in BUFFER seconds, as the spec has it. */
  readonly loopStartSeconds: number;
  readonly loopEndSeconds: number;
}

class FakeSource {
  buffer: ModelBuffer | null = null;
  readonly playbackRate = new FakeParam(1);
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  target: FakeGain | null = null;
  voice: Voice | null = null;

  constructor(private readonly host: RecordingMusicHost) {}

  connect(node: unknown): void {
    this.target = node as FakeGain;
  }

  start(when?: number, _offset?: number): void {
    const at = when ?? this.host.currentTime;
    const rate = this.playbackRate.value === 0 ? 1 : this.playbackRate.value;
    const seconds =
      this.loop || this.buffer === null
        ? Infinity
        : this.buffer.length / this.buffer.sampleRate / rate;
    const voice: Voice = {
      start: at,
      stop: Infinity,
      gain: this.target,
      loop: this.loop,
      seconds,
      buffer: this.buffer,
      rate: this.playbackRate,
      offsetSeconds: _offset ?? 0,
      loopStartSeconds: this.loopStart,
      loopEndSeconds: this.loopEnd,
    };
    this.voice = voice;
    this.host.voices.push(voice);
  }

  stop(when?: number): void {
    if (this.voice === null) return;
    // A later `stop` replaces an earlier one, as the spec has it.
    this.voice.stop = when ?? this.host.currentTime;
  }
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export class RecordingMusicHost implements TrackerHost {
  currentTime = 0;
  state = "running";
  readonly destination = DESTINATION;
  readonly voices: Voice[] = [];
  /** Every gain built, in build order: [master, bus0..bus3, ...note gains]. */
  readonly gains: FakeGain[] = [];
  resumes = 0;

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    // ONE persistent array, handed back on every call: the content the tracker
    // writes is the content the renderer reads. See `ModelBuffer`.
    const data = new Float32Array(length);
    const buffer: ModelBuffer = {
      length,
      sampleRate,
      data,
      getChannelData: () => data,
    };
    return buffer as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    return new FakeSource(this) as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }

  /**
   * THE SAME HOST SERVES THE EFFECTS, because in a browser it is the same
   * `AudioContext`: `main.ts` hands `sound.context()` to `createTableMusic`,
   * to `createShellMusic` and to every `AudioBank`. `src/browser/audio.ts`
   * wants a `decodeAudioData`, and giving it one here is what lets an effect
   * and the music be weighed on ONE graph — which is the only way the
   * channel-3 duck can be measured against a real sounding effect rather than
   * against a hand-written `until`.
   *
   * The length and rate are read out of the real RIFF header the exporter
   * writes (44-byte canonical header, rate at +24, data size at +40), so a
   * voice's `seconds` is the sound's own length and not a guess — and the
   * PCM itself is decoded exactly as a browser decodes the shipped files
   * (8-bit unsigned mono, `(byte - 128) / 128`), so an effect's samples are
   * renderable content and not an empty stand-in.
   */
  async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    const view = new DataView(data);
    const length = view.getUint32(40, true);
    const available = Math.max(0, Math.min(length, data.byteLength - 44));
    const samples = new Float32Array(length);
    for (let i = 0; i < available; i += 1) {
      samples[i] = (view.getUint8(44 + i) - 128) / 128;
    }
    const buffer: ModelBuffer = {
      length,
      sampleRate: view.getUint32(24, true),
      data: samples,
      getChannelData: () => samples,
    };
    return buffer as unknown as AudioBuffer;
  }

  async resume(): Promise<void> {
    this.resumes += 1;
    this.state = "running";
  }

  /** Advances the context clock, as a real one advances with wall time. */
  advance(seconds: number): void {
    this.currentTime += seconds;
  }

  /** The gain a voice contributes at `t`: the product along its own path. */
  private levelOf(voice: Voice, t: number): number {
    if (t < voice.start) return 0;
    if (t >= voice.stop) return 0;
    if (t >= voice.start + voice.seconds) return 0;
    let level = 1;
    let node: FakeGain | "destination" | null = voice.gain;
    for (let hop = 0; hop < 16 && node !== null && node !== "destination"; hop += 1) {
      level *= node.gain.at(t);
      node = node.target;
    }
    // A voice whose chain never reaches the destination is not audible.
    return node === "destination" ? level : 0;
  }

  /** THE MEASUREMENT: total level reaching the destination at context time `t`. */
  audibleAt(t: number): number {
    let level = 0;
    for (const voice of this.voices) level += this.levelOf(voice, t);
    return level;
  }

  /** The same, restricted to the voices feeding one tracker channel's bus. */
  audibleOnChannelAt(output: TrackerOutput, channel: number, t: number): number {
    const bus = output.channelBuses[channel] ?? null;
    if (bus === null) return 0;
    let level = 0;
    for (const voice of this.voices) {
      if (voice.gain?.target !== (bus as unknown as FakeGain)) continue;
      level += this.levelOf(voice, t);
    }
    return level;
  }

  /**
   * EVERY VOICE THAT ACTUALLY MADE A SOUND, with the context time it was
   * weighed at — the midpoint of its own window, which is inside it by
   * construction. A voice that was started and then displaced on the same tick
   * (the effect channel's `stop()` before the next `start()`) has an empty
   * window and is not here; nor is one whose chain never reached the
   * destination, nor one held at zero by a duck for its whole life.
   *
   * This is what turns `audibleAt` from a scalar into a CENSUS: the caller
   * maps `voice.buffer` back to the file it decoded and so can say WHICH
   * records a played game was heard to play.
   */
  soundedVoices(): { readonly voice: Voice; readonly at: number }[] {
    const sounded: { voice: Voice; at: number }[] = [];
    for (const voice of this.voices) {
      const end = Math.min(voice.stop, voice.start + voice.seconds);
      if (!(end > voice.start)) continue;
      const at = Number.isFinite(end) ? (voice.start + end) / 2 : voice.start;
      if (this.levelOf(voice, at) > 0) sounded.push({ voice, at });
    }
    return sounded;
  }

  /** How many voices are sounding at `t`, ignoring their level. */
  voicesAt(t: number): number {
    let count = 0;
    for (const voice of this.voices) {
      if (t >= voice.start && t < voice.stop && t < voice.start + voice.seconds) count += 1;
    }
    return count;
  }

  /**
   * THE SIGNAL, not just the gain: renders the summed destination waveform
   * over [t0, t1) at `sampleRate` and folds it into `stats`.
   *
   * `audibleAt` answers "what is the PRODUCT OF GAINS reaching the output" —
   * an upper bound that treats every sample as full-scale. This renders the
   * actual content: each voice's PCM, advanced by its playback-rate param
   * (pitch steps included), looped in its own loop window, through its own
   * scheduled volume automation and up the same gain chain to the
   * destination, linearly interpolated as a browser's source node is. Peak
   * and RMS of the result are therefore statements about digital OUTPUT
   * LEVEL, comparable with a figure measured off any other game's output —
   * which is what the loudness round needed and nothing else here could say.
   *
   * CALL IT INCREMENTALLY, a chunk per driven tick, the way the drivers step
   * their clock: live `.value` writes (the channel-3 duck, a mute) carry no
   * timestamp, so each chunk reads the graph as it stands — exactly the
   * granularity a browser's per-frame writes give the real graph. Scheduled
   * `setValueAtTime` steps (note volumes, pitch slides) are evaluated at
   * their own sample regardless of chunking.
   */
  renderInto(stats: RenderStats, t0: number, t1: number, sampleRate: number): void {
    if (!(t1 > t0)) return;
    const total = Math.floor((t1 - t0) * sampleRate);
    if (total <= 0) return;

    // The voices that can sound in this window, filtered once per chunk —
    // per-sample iteration over every voice ever scheduled would be O(n²).
    interface Live {
      readonly voice: Voice;
      readonly buffer: ModelBuffer;
      /** Position in BUFFER SAMPLES at the chunk's first output sample. */
      pos: number;
      /** Ascending rate steps inside this chunk, walked by `rateIndex`. */
      readonly rateEvents: readonly { readonly at: number; readonly to: number }[];
      rateIndex: number;
      rateNow: number;
      readonly gainEvents: readonly { readonly at: number; readonly to: number }[];
      gainIndex: number;
      gainNow: number;
      /** Product of every gain ABOVE the voice's own, read at chunk entry. */
      readonly upstream: number;
      done: boolean;
    }

    const live: Live[] = [];
    for (const voice of this.voices) {
      if (voice.start >= t1 || voice.stop <= t0) continue;
      if (!voice.loop && voice.start + voice.seconds <= t0) continue;
      const buffer = voice.buffer as ModelBuffer | null;
      if (buffer === null || buffer.data.length === 0) continue;

      // The chain above the voice's own gain: the channel bus and the master
      // carry live `.value` writes only, so chunk-entry values are exact for
      // a chunk the driver keeps at tick length. The voice's own gain carries
      // the scheduled note volumes and is walked per sample below.
      let upstream = 1;
      let reached = false;
      let node: FakeGain | "destination" | null = voice.gain?.target ?? null;
      for (let hop = 0; hop < 16 && node !== null; hop += 1) {
        if (node === "destination") {
          reached = true;
          break;
        }
        upstream *= node.gain.at(t0);
        node = node.target;
      }
      if (voice.gain === null || !reached) continue;

      const entry = Math.max(t0, voice.start);
      const rate = voice.rate;
      live.push({
        voice,
        buffer,
        pos:
          (voice.offsetSeconds + rate.integrate(voice.start, entry)) * buffer.sampleRate,
        rateEvents: [...rate.events]
          .filter((event) => event.at > entry && event.at < t1)
          .sort((a, b) => a.at - b.at),
        rateIndex: 0,
        rateNow: rate.at(entry),
        gainEvents: [...voice.gain.gain.events]
          .filter((event) => event.at > entry && event.at < t1)
          .sort((a, b) => a.at - b.at),
        gainIndex: 0,
        gainNow: voice.gain.gain.at(entry),
        upstream,
        done: false,
      });
    }

    const step = 1 / sampleRate;
    for (let i = 0; i < total; i += 1) {
      const t = t0 + i * step;
      let sum = 0;
      for (const one of live) {
        if (one.done || t < one.voice.start || t >= one.voice.stop) continue;
        while (one.rateIndex < one.rateEvents.length) {
          const event = one.rateEvents[one.rateIndex];
          if (event === undefined || event.at > t) break;
          one.rateNow = event.to;
          one.rateIndex += 1;
        }
        while (one.gainIndex < one.gainEvents.length) {
          const event = one.gainEvents[one.gainIndex];
          if (event === undefined || event.at > t) break;
          one.gainNow = event.to;
          one.gainIndex += 1;
        }
        const data = one.buffer.data;
        let pos = one.pos;
        if (one.voice.loop) {
          const loopStart = one.voice.loopStartSeconds * one.buffer.sampleRate;
          const loopEnd = one.voice.loopEndSeconds * one.buffer.sampleRate;
          if (loopEnd > loopStart) {
            while (pos >= loopEnd) pos -= loopEnd - loopStart;
          } else if (pos >= data.length) {
            one.done = true;
            continue;
          }
        } else if (pos >= data.length) {
          one.done = true;
          continue;
        }
        const index = Math.floor(pos);
        const frac = pos - index;
        const here = data[index] ?? 0;
        const next = data[index + 1] ?? here;
        sum += (here + (next - here) * frac) * one.gainNow * one.upstream;
        one.pos += (one.rateNow * one.buffer.sampleRate) / sampleRate;
      }
      const magnitude = Math.abs(sum);
      if (magnitude > stats.peak) stats.peak = magnitude;
      if (magnitude > 1) stats.clipped += 1;
      stats.sumSquares += sum * sum;
      stats.samples += 1;
    }
  }
}

/** Running totals for `renderInto`: fold chunks in, read the figures out. */
export interface RenderStats {
  peak: number;
  sumSquares: number;
  samples: number;
  /** Output samples whose |sum| exceeded 1.0 — destination clipping. */
  clipped: number;
}

export function createRenderStats(): RenderStats {
  return { peak: 0, sumSquares: 0, samples: 0, clipped: 0 };
}

export function rmsOf(stats: RenderStats): number {
  return stats.samples === 0 ? 0 : Math.sqrt(stats.sumSquares / stats.samples);
}

/** A `TrackerHost` that starts suspended, as an untouched page's context does. */
export class SuspendedMusicHost extends RecordingMusicHost {
  constructor() {
    super();
    this.state = "suspended";
  }
}

// ---------------------------------------------------------------------------
// Naming what is sounding
// ---------------------------------------------------------------------------

/**
 * A fingerprint for one rendered section, so a test can say WHICH section is
 * up rather than merely that something is. Two independently loaded copies of
 * the same asset render byte-identical streams, so the signature crosses the
 * boundary between the controller's private asset and the test's own.
 */
export function sectionSignature(stream: {
  readonly durationMs: number;
  readonly restartMs: number | null;
  readonly commands: readonly unknown[];
}): string {
  return `${stream.durationMs}|${String(stream.restartMs)}|${stream.commands.length}`;
}

/** Names every (bank, position) of an asset by signature; collisions are kept. */
export function sectionNames(asset: {
  section(bank: number, position: number): { durationMs: number; restartMs: number | null; commands: readonly unknown[] } | null;
  songs: readonly { orders: readonly number[] }[];
}): Map<string, string[]> {
  const names = new Map<string, string[]>();
  for (const [bank, song] of asset.songs.entries()) {
    for (let position = 0; position < song.orders.length; position += 1) {
      const stream = asset.section(bank, position);
      if (stream === null) continue;
      const key = sectionSignature(stream);
      const list = names.get(key) ?? [];
      list.push(`${bank}:${position}`);
      names.set(key, list);
    }
  }
  return names;
}

export { TRACKER_CHANNELS };
