/**
 * The synthesized instruments and the tracker output layer.
 *
 * Two promises under test. The instruments are pure functions of nothing —
 * the same bytes on every build, on every engine, which is what lets a song
 * reference them by id and sound the same everywhere; the hashes are pinned
 * to hold the generators still. And the output layer is a dumb affine map
 * from the pure core's millisecond clock to `AudioContext` time — all of its
 * scheduling maths is exercised here against a fake clock, because a real
 * `AudioContext` never appears in a test.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  BASE_FREQUENCY,
  CYCLE,
  INSTRUMENT_IDS,
  INSTRUMENT_SAMPLE_RATE,
  buildInstruments,
  instrumentById,
  playbackRateFor,
} from "../src/audio/instruments.js";
import type { ChipInstrument, InstrumentId } from "../src/audio/instruments.js";
import {
  TRACKER_CHANNELS,
  TRACKER_MAX_VOLUME,
  contextTimeFor,
  createTrackerOutput,
  gainFor,
  pumpTracker,
  resumeTracker,
  setTrackerMasterVolume,
  setTrackerMuted,
  startTracker,
  stopTracker,
} from "../src/audio/tracker-output.js";
import type {
  TrackerCommand,
  TrackerCommandStream,
  TrackerHost,
  TrackerOutput,
} from "../src/audio/tracker-output.js";

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

/** Raw little-endian float32 bytes; the platforms vitest runs on are LE. */
function hashOf(instrument: ChipInstrument): string {
  const bytes = Buffer.from(
    instrument.samples.buffer,
    instrument.samples.byteOffset,
    instrument.samples.byteLength,
  );
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Pinned at generation time. A change here is a change to what every song
 * sounds like, so it must be deliberate: regenerate, listen, then repin.
 */
const PINNED_HASHES: Record<InstrumentId, string> = {
  pulse50: "bb415720458e90af795ad47ebccb0f9946035dba10319e2038230382e58f00bb",
  pulse25: "a1824086cfeb82b5d4186507822f06ccb2b1014a7f9d4cb47ae16f566e91216d",
  pulse12: "2471bee0b558c448385f34e1fd3286b38663291e16be34c1de413185793e4d03",
  triangle: "a684573f28d75bf6bb4f7f48d0af08aad6cf4d591412178da81550640b595ac7",
  sawtooth: "438a9a43359bc618e6d47d5e8d545b6a08b5a86f997da29e790d063265ad7ba5",
  bass: "58e4067d628340cbf6c054b45f84779d36072bc8acf1d642edede5e3ca7b843b",
  noise: "6c8ae7f1000e94103816555f9613cfba16a667359b6a86bfd6e47c20cd0a4f6c",
};

describe("the synthesized instruments", () => {
  it("build to the pinned bytes, twice over", () => {
    const first = buildInstruments();
    const second = buildInstruments();
    expect(first.length).toBe(second.length);
    for (let i = 0; i < first.length; i += 1) {
      const a = first[i] as ChipInstrument;
      const b = second[i] as ChipInstrument;
      expect(b.id).toBe(a.id);
      expect(hashOf(b)).toBe(hashOf(a));
      expect(hashOf(a), a.id).toBe(PINNED_HASHES[a.id]);
    }
  });

  it("declare loop windows that are whole cycles inside the buffer", () => {
    for (const instrument of buildInstruments()) {
      if (instrument.loopStart === -1) {
        expect(instrument.loopEnd).toBe(-1);
        continue;
      }
      expect(instrument.loopStart).toBeGreaterThanOrEqual(0);
      expect(instrument.loopStart).toBeLessThan(instrument.loopEnd);
      expect(instrument.loopEnd).toBeLessThanOrEqual(instrument.samples.length);
      expect(instrument.cycleLength).toBe(CYCLE);
      expect((instrument.loopEnd - instrument.loopStart) % instrument.cycleLength).toBe(0);
      expect(instrument.loopStart % instrument.cycleLength).toBe(0);
    }
  });

  it("loop exactly: every cycle in the window is bit-identical to the next", () => {
    // The envelope is flat across the sustain and the waveform is a pure
    // function of phase, so this is EXACT float equality, not closeness —
    // which is what makes the loop click-free at any playback rate.
    for (const instrument of buildInstruments()) {
      if (instrument.loopStart === -1) continue;
      for (let i = instrument.loopStart; i < instrument.loopEnd - CYCLE; i += 1) {
        expect(instrument.samples[i]).toBe(instrument.samples[i + CYCLE]);
      }
      // And the wrap itself: the first loop sample continues the last cycle.
      expect(instrument.samples[instrument.loopStart]).toBe(
        instrument.samples[instrument.loopEnd - CYCLE],
      );
    }
  });

  it("stay inside [-1, 1] with headroom for four channels", () => {
    for (const instrument of buildInstruments()) {
      for (const value of instrument.samples) {
        expect(Math.abs(value)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it("makes the noise burst a one-shot that dies away", () => {
    const noise = instrumentById("noise");
    expect(noise.loopStart).toBe(-1);
    expect(noise.cycleLength).toBe(0);
    const peakOf = (from: number, to: number) => {
      let peak = 0;
      for (let i = from; i < to; i += 1) peak = Math.max(peak, Math.abs(noise.samples[i] ?? 0));
      return peak;
    };
    expect(peakOf(0, 128)).toBeGreaterThan(0.1);
    expect(peakOf(noise.samples.length - 128, noise.samples.length)).toBeLessThan(0.05);
  });

  it("answers by stable id, uniquely, and refuses an unknown one", () => {
    const built = buildInstruments();
    expect(built.map((instrument) => instrument.id)).toEqual([...INSTRUMENT_IDS]);
    expect(new Set(INSTRUMENT_IDS).size).toBe(INSTRUMENT_IDS.length);
    for (const id of INSTRUMENT_IDS) expect(instrumentById(id).id).toBe(id);
    expect(() => instrumentById("theremin" as InstrumentId)).toThrow(/unknown instrument/);
  });

  it("prices a pitch as a playback-rate ratio, Paula's period inverted", () => {
    const square = instrumentById("pulse50");
    expect(square.baseFrequency).toBe(BASE_FREQUENCY);
    expect(square.sampleRate).toBe(INSTRUMENT_SAMPLE_RATE);
    expect(playbackRateFor(square, 440)).toBe(1);
    expect(playbackRateFor(square, 880)).toBe(2);
    expect(playbackRateFor(square, 220)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// A fake audio device with a fake clock
// ---------------------------------------------------------------------------

interface FakeParam {
  value: number;
  readonly sets: { value: number; time: number }[];
  setValueAtTime(value: number, time: number): void;
}

function fakeParam(initial: number): FakeParam {
  const sets: { value: number; time: number }[] = [];
  return {
    value: initial,
    sets,
    setValueAtTime(value: number, time: number) {
      sets.push({ value, time });
    },
  };
}

interface FakeGain {
  readonly gain: FakeParam;
  readonly connected: unknown[];
  connect(target: unknown): void;
}

interface FakeSource {
  buffer: FakeBuffer | null;
  readonly playbackRate: FakeParam;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  /** The gain node this source was wired into, so a test can read its value. */
  gainNode: FakeGain | null;
  readonly starts: number[];
  readonly stops: number[];
  connect(target: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
}

interface FakeBuffer {
  readonly length: number;
  readonly sampleRate: number;
  readonly data: Float32Array;
  getChannelData(channel: number): Float32Array;
}

class FakeTrackerHost implements TrackerHost {
  currentTime = 0;
  state = "running";
  readonly destination = {} as AudioNode;
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  readonly buffersMade: FakeBuffer[] = [];
  resumes = 0;

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    const data = new Float32Array(length);
    const buffer: FakeBuffer = {
      length,
      sampleRate,
      data,
      getChannelData: () => data,
    };
    this.buffersMade.push(buffer);
    return buffer as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    const host = this;
    const source: FakeSource = {
      buffer: null,
      playbackRate: fakeParam(1),
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      gainNode: null,
      starts: [],
      stops: [],
      connect(target: unknown) {
        source.gainNode = target as FakeGain;
      },
      start(when?: number) {
        source.starts.push(when ?? host.currentTime);
      },
      stop(when?: number) {
        source.stops.push(when ?? host.currentTime);
      },
    };
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    const gain: FakeGain = {
      gain: fakeParam(1),
      connected: [],
      connect(target: unknown) {
        gain.connected.push(target);
      },
    };
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }

  async resume(): Promise<void> {
    this.resumes += 1;
    this.state = "running";
  }
}

function outputOn(host: FakeTrackerHost): TrackerOutput {
  return createTrackerOutput(() => host);
}

const note = (
  timeMs: number,
  channel: number,
  instrument: InstrumentId,
  frequencyHz: number,
  volume: number,
): TrackerCommand => ({ kind: "note", timeMs, channel, instrument, frequencyHz, volume });

const once = (commands: TrackerCommand[], durationMs: number): TrackerCommandStream => ({
  commands,
  durationMs,
  restartMs: null,
});

// ---------------------------------------------------------------------------

describe("the scheduling maths", () => {
  it("maps song milliseconds onto the context clock affinely", () => {
    expect(contextTimeFor(10, 0)).toBe(10);
    expect(contextTimeFor(10, 250)).toBe(10.25);
    expect(contextTimeFor(10, 250, 4000)).toBe(14.25);
  });

  it("maps Paula volume onto unit gain, clamped to the register", () => {
    expect(gainFor(TRACKER_MAX_VOLUME)).toBe(1);
    expect(gainFor(32)).toBe(0.5);
    expect(gainFor(0)).toBe(0);
    expect(gainFor(-3)).toBe(0);
    expect(gainFor(200)).toBe(1);
  });
});

describe("the tracker output layer", () => {
  it("builds nothing until a song starts — headless code never wakes Web Audio", () => {
    let factoryCalls = 0;
    const output = createTrackerOutput(() => {
      factoryCalls += 1;
      return new FakeTrackerHost();
    });
    pumpTracker(output);
    stopTracker(output);
    setTrackerMuted(output, true);
    setTrackerMasterVolume(output, 0.5);
    resumeTracker(output);
    expect(factoryCalls).toBe(0);
    expect(startTracker(output, once([note(0, 0, "pulse50", 440, 64)], 100))).toBe(true);
    expect(factoryCalls).toBe(1);
  });

  it("treats a refused audio device as silence, not an error", () => {
    const output = createTrackerOutput(() => null);
    expect(startTracker(output, once([note(0, 0, "pulse50", 440, 64)], 100))).toBe(false);
    pumpTracker(output);
    stopTracker(output);
    setTrackerMuted(output, true);
    resumeTracker(output);
  });

  it("schedules each note at its mapped time with its pitch and its volume", () => {
    const host = new FakeTrackerHost();
    host.currentTime = 10;
    const output = outputOn(host);
    startTracker(output, once([
      note(0, 0, "pulse50", 440, 64),
      note(250, 1, "bass", 220, 32),
    ], 400));

    expect(host.sources.length).toBe(2);
    const [first, second] = host.sources as [FakeSource, FakeSource];
    expect(first.starts).toEqual([10]);
    expect(first.playbackRate.value).toBe(1);
    expect(first.gainNode?.gain.value).toBe(1);
    expect(second.starts).toEqual([10.25]);
    expect(second.playbackRate.value).toBe(0.5);
    expect(second.gainNode?.gain.value).toBe(0.5);
    // Every voice's gain feeds its CHANNEL BUS — the per-channel gain the
    // in-game arbitration ducks (channel 3 while an effect sounds) — and the
    // buses feed the master, which feeds the destination. Gains are created
    // master first, then the four buses in channel order.
    const master = host.gains[0] as FakeGain;
    expect(master.connected).toContain(host.destination);
    const channelOneBus = host.gains[2] as FakeGain;
    expect(channelOneBus.connected).toContain(master);
    expect(second.gainNode?.connected).toContain(channelOneBus);
  });

  it("wires the instrument's buffer and loop window into the source", () => {
    const host = new FakeTrackerHost();
    const output = outputOn(host);
    startTracker(output, once([
      note(0, 0, "sawtooth", 440, 64),
      note(50, 1, "sawtooth", 880, 64),
      note(100, 2, "noise", 440, 64),
    ], 200));

    const sawtooth = instrumentById("sawtooth");
    const [a, b, drum] = host.sources as [FakeSource, FakeSource, FakeSource];
    expect(a.buffer?.sampleRate).toBe(sawtooth.sampleRate);
    expect(a.buffer?.data).toEqual(sawtooth.samples);
    expect(a.loop).toBe(true);
    expect(a.loopStart).toBe(sawtooth.loopStart / sawtooth.sampleRate);
    expect(a.loopEnd).toBe(sawtooth.loopEnd / sawtooth.sampleRate);
    // One decoded buffer per instrument, shared between notes.
    expect(b.buffer).toBe(a.buffer);
    expect(host.buffersMade.length).toBe(2);
    // The one-shot does not loop.
    expect(drum.loop).toBe(false);
  });

  it("lets a new note replace its channel's voice at the moment it starts", () => {
    const host = new FakeTrackerHost();
    host.currentTime = 10;
    const output = outputOn(host);
    startTracker(output, once([
      note(0, 0, "pulse50", 440, 64),
      note(100, 0, "pulse50", 660, 64),
      note(150, 1, "triangle", 330, 64),
    ], 200));

    const [first, , other] = host.sources as [FakeSource, FakeSource, FakeSource];
    expect(first.stops).toEqual([10.1]);
    // A different channel interrupts nothing.
    expect(other.stops).toEqual([]);
  });

  it("honours stop and volume commands on the sounding voice", () => {
    const host = new FakeTrackerHost();
    const output = outputOn(host);
    startTracker(output, once([
      note(0, 0, "pulse25", 440, 64),
      { kind: "volume", timeMs: 100, channel: 0, volume: 16 },
      { kind: "stop", timeMs: 200, channel: 0 },
      { kind: "volume", timeMs: 300, channel: 0, volume: 64 }, // nothing sounding: ignored
    ], 400));

    const voice = host.sources[0] as FakeSource;
    expect(voice.gainNode?.gain.sets).toEqual([{ value: 0.25, time: 0.1 }]);
    expect(voice.stops).toEqual([0.2]);
  });

  it("holds commands beyond the lookahead until the clock approaches them", () => {
    const host = new FakeTrackerHost();
    host.currentTime = 10;
    const output = outputOn(host);
    startTracker(output, once([
      note(0, 0, "pulse50", 440, 64),
      note(2000, 1, "pulse50", 440, 64),
    ], 3000));

    expect(host.sources.length).toBe(1);
    pumpTracker(output, 0.5);
    expect(host.sources.length).toBe(1);
    host.currentTime = 11.6; // horizon 12.1 now covers the 12.0 note
    pumpTracker(output, 0.5);
    expect(host.sources.length).toBe(2);
    expect((host.sources[1] as FakeSource).starts).toEqual([12]);
  });

  it("repeats from the restart point with the pass length added each time", () => {
    // A 400 ms pass restarting at 100 ms: the 100 ms note recurs every 300 ms
    // after its first sounding, exactly as the module engine's order-list
    // restart replays the tail of the song.
    const host = new FakeTrackerHost();
    const output = outputOn(host);
    const stream: TrackerCommandStream = {
      commands: [note(0, 0, "pulse50", 440, 64), note(100, 1, "bass", 110, 64)],
      durationMs: 400,
      restartMs: 100,
    };
    startTracker(output, stream);
    pumpTracker(output, 1.0);

    const starts = host.sources.map((source) => source.starts[0]);
    expect(starts).toEqual([0, 0.1, 0.4, 0.7, 1.0]);
    // Only the tail repeats; the 0 ms note sounded once.
    expect(host.sources.filter((source) => source.playbackRate.value === 1).length).toBe(1);
  });

  it("plays a stream once when there is no restart, without spinning", () => {
    const host = new FakeTrackerHost();
    const output = outputOn(host);
    startTracker(output, once([note(0, 0, "pulse50", 440, 64)], 400));
    pumpTracker(output, 60);
    pumpTracker(output, 60);
    expect(host.sources.length).toBe(1);
  });

  it("treats a restart that does not advance time as play-once", () => {
    const host = new FakeTrackerHost();
    const output = outputOn(host);
    startTracker(output, {
      commands: [note(0, 0, "pulse50", 440, 64)],
      durationMs: 400,
      restartMs: 400,
    });
    pumpTracker(output, 60);
    expect(host.sources.length).toBe(1);
  });

  it("keeps mute and master volume at the master gain, so unmute rejoins mid-song", () => {
    const host = new FakeTrackerHost();
    const output = outputOn(host);
    startTracker(output, once([note(0, 0, "pulse50", 440, 64)], 100));
    const master = host.gains[0] as FakeGain;
    expect(master.gain.value).toBe(1);

    expect(setTrackerMasterVolume(output, 0.5)).toBe(0.5);
    expect(master.gain.value).toBe(0.5);
    expect(setTrackerMuted(output, true)).toBe(true);
    expect(master.gain.value).toBe(0);
    expect(setTrackerMasterVolume(output, 0.8)).toBe(0.8);
    expect(master.gain.value).toBe(0); // still muted
    expect(setTrackerMuted(output, false)).toBe(false);
    expect(master.gain.value).toBe(0.8);
    expect(setTrackerMasterVolume(output, 7)).toBe(1); // clamped
  });

  it("remembers a mute asked for before the device existed", () => {
    const host = new FakeTrackerHost();
    const output = outputOn(host);
    setTrackerMuted(output, true);
    startTracker(output, once([note(0, 0, "pulse50", 440, 64)], 100));
    expect((host.gains[0] as FakeGain).gain.value).toBe(0);
  });

  it("stops every voice and forgets the song on stopTracker", () => {
    const host = new FakeTrackerHost();
    const output = outputOn(host);
    startTracker(output, once([
      note(0, 0, "pulse50", 440, 64),
      note(0, 1, "bass", 110, 64),
    ], 100));
    host.currentTime = 5;
    stopTracker(output);
    for (const source of host.sources) expect(source.stops).toEqual([5]);
    expect(output.playing).toBe(false);
    pumpTracker(output, 60);
    expect(host.sources.length).toBe(2);
  });

  it("starting a new song silences the old one first", () => {
    const host = new FakeTrackerHost();
    const output = outputOn(host);
    startTracker(output, once([note(0, 0, "pulse50", 440, 64)], 100));
    host.currentTime = 3;
    startTracker(output, once([note(0, 0, "triangle", 220, 64)], 100));
    expect((host.sources[0] as FakeSource).stops).toEqual([3]);
    expect((host.sources[1] as FakeSource).starts).toEqual([3]);
  });

  it("nudges only a suspended context on a gesture", () => {
    const host = new FakeTrackerHost();
    const output = outputOn(host);
    startTracker(output, once([], 100));
    resumeTracker(output);
    expect(host.resumes).toBe(0);
    host.state = "suspended";
    resumeTracker(output);
    expect(host.resumes).toBe(1);
  });

  it("drops a note aimed at a channel Paula does not have", () => {
    const host = new FakeTrackerHost();
    const output = outputOn(host);
    startTracker(output, once([
      note(0, TRACKER_CHANNELS, "pulse50", 440, 64),
      note(0, -1, "pulse50", 440, 64),
    ], 100));
    expect(host.sources.length).toBe(0);
  });
});
