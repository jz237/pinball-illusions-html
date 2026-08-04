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

/** One scheduled note, as the graph holds it. */
export interface Voice {
  readonly start: number;
  stop: number;
  readonly gain: FakeGain | null;
  readonly loop: boolean;
  /** Seconds of PCM, at the rate it is played back at. Infinite when looping. */
  readonly seconds: number;
}

class FakeSource {
  buffer: { length: number; sampleRate: number } | null = null;
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
    return {
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length),
    } as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    return new FakeSource(this) as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain as unknown as GainNode;
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

  /** How many voices are sounding at `t`, ignoring their level. */
  voicesAt(t: number): number {
    let count = 0;
    for (const voice of this.voices) {
      if (t >= voice.start && t < voice.stop && t < voice.start + voice.seconds) count += 1;
    }
    return count;
  }
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
