/**
 * The sound layer: the manifest, the priority channel, and the promise that
 * none of it can reach the simulation.
 *
 * The last one is the important test in this file. Everything else is a
 * convenience; a reconstruction whose replays stop matching because a sample
 * decoded a frame later is broken in a way no amount of correct mixing fixes.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { EngineAudioDocument, TableAudioDocument, TableId } from "../src/game/contracts.js";
import {
  PAULA_MAX_VOLUME,
  parseEngineAudioDocument,
  parseTableAudioDocument,
} from "../src/game/table-audio.js";
import type { AudioSample, EngineAudio, TableAudio } from "../src/game/table-audio.js";
import {
  createAudioBank,
  loadAudioBank,
  playAward,
  playSample,
  playTick,
  setMuted,
} from "../src/browser/audio.js";
import type { AudioBank, AudioHost } from "../src/browser/audio.js";
import type { Award } from "../src/game/scoring.js";
import {
  createGame,
  debugSnapshot,
  runTicks,
  startGame,
} from "../src/browser/game-loop.js";
import type { GameTickReport, InputSource } from "../src/browser/game-loop.js";
import { IDLE_SNAPSHOT, controlForKeyEvent } from "../src/browser/input.js";
import { mapFor } from "./table-fixtures.js";
import { renderSongStream, songStreamFor } from "../src/audio/song-stream.js";
import { createTrackerPlayer, stepTracker } from "../src/audio/tracker.js";
import type { TrackerSong } from "../src/audio/tracker.js";
import { shippedShellMusic, syntheticShellMusicAsset } from "./shell-music-fixture.js";
import {
  createTrackerOutput,
  pumpTracker,
  startTracker,
} from "../src/audio/tracker-output.js";
import type { TrackerCommandStream, TrackerHost } from "../src/audio/tracker-output.js";
import {
  MUSIC_MUTED_STORAGE_KEY,
  MUSIC_TOGGLE_CODE,
  MUSIC_TOGGLE_KEY,
  createShellMusic,
  musicWantedFor,
} from "../src/browser/shell-music.js";
import type { MusicStorage } from "../src/browser/shell-music.js";
import { shellKeyFor } from "../src/browser/shell.js";
import type { ShellPhase } from "../src/browser/shell.js";

function documentFor(tableId: TableId): TableAudioDocument {
  const url = new URL(`../public/generated/tables/${tableId}.audio.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as TableAudioDocument;
}

function audioFor(tableId: TableId): TableAudio {
  return parseTableAudioDocument(documentFor(tableId));
}

function engineDocument(): EngineAudioDocument {
  const url = new URL("../public/generated/engine.audio.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as EngineAudioDocument;
}

function engineFor(): EngineAudio {
  return parseEngineAudioDocument(engineDocument());
}

/** A whole report with nothing in it but what the test wants to say. */
function reportWith(over: Partial<GameTickReport> = {}): GameTickReport {
  return {
    tick: 1,
    stepped: true,
    served: false,
    launched: false,
    drained: [],
    writtenOff: [],
    swallowed: [],
    locked: [],
    ejected: [],
    ejectedFrom: [],
    levelTransfers: [],
    multiballStarted: false,
    missionStarted: -1,
    missionEnded: false,
    awards: [],
    elementStarts: [],
    elementAwards: [],
    messagesShown: [],
    justTilted: false,
    gameOver: false,
    flipperRaised: [],
    flipperRested: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A fake audio device
// ---------------------------------------------------------------------------

interface FakeNode {
  connect(target: unknown): void;
}

class FakeHost implements AudioHost {
  currentTime = 0;
  state = "running";
  readonly destination = {} as AudioNode;
  readonly started: { buffer: unknown; gain: number }[] = [];
  stops = 0;

  createBufferSource(): AudioBufferSourceNode {
    const host = this;
    let gainOf = 1;
    const node = {
      buffer: null as unknown,
      connect(target: unknown) {
        const holder = target as { gain?: { value: number } };
        if (holder.gain !== undefined) gainOf = holder.gain.value;
      },
      start() {
        host.started.push({ buffer: node.buffer, gain: gainOf });
      },
      stop() {
        host.stops += 1;
      },
    };
    return node as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    const node: FakeNode & { gain: { value: number } } = {
      gain: { value: 1 },
      connect() {
        /* the destination is a sink in this fake */
      },
    };
    return node as unknown as GainNode;
  }

  async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    return { length: data.byteLength } as unknown as AudioBuffer;
  }

  async resume(): Promise<void> {
    this.state = "running";
  }
}

/** Serves the real WAVs off disk, so the bank under test holds the real bytes. */
function diskFetch() {
  return async (url: string) => {
    const name = url.slice(url.lastIndexOf("/") + 1);
    const file = new URL(`../public/generated/tables/${name}`, import.meta.url);
    const bytes = readFileSync(file);
    return {
      ok: true,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  };
}

async function bankFor(tableId: TableId): Promise<AudioBank> {
  const bank = createAudioBank(new FakeHost(), audioFor(tableId));
  await loadAudioBank(bank, diskFetch());
  return bank;
}

const award = (id: string): Award => ({ source: "device", id, score: 0, bonus: 0, repeat: false });

// ---------------------------------------------------------------------------

describe("the shipped sound manifests", () => {
  it("parse, and every sample is the file the manifest says it is", () => {
    for (const tableId of TABLE_IDS) {
      const audio = audioFor(tableId);
      expect(audio.samples.length, `${tableId} has no samples`).toBeGreaterThan(0);
      for (const sample of audio.samples) {
        const file = new URL(`../public/generated/tables/${sample.file}`, import.meta.url);
        const bytes = readFileSync(file);
        expect(createHash("sha256").update(bytes).digest("hex"), `${sample.file}`).toBe(
          sample.sha256,
        );
        // 44 bytes of RIFF header plus the PCM the record declares.
        expect(bytes.length).toBe(44 + sample.bytes);
        expect(bytes.toString("latin1", 0, 4)).toBe("RIFF");
        expect(bytes.readUInt32LE(24), `${sample.file} rate`).toBe(sample.rate);
        expect(bytes.readUInt16LE(34), `${sample.file} bit depth`).toBe(8);
      }
    }
  });

  it("writes each sample at the PAL rate its Paula period asks for", () => {
    // 3546895 / period, and the period is an exact ProTracker entry. The two
    // together are what make this a pitch rather than a guess; see the exporter.
    for (const tableId of TABLE_IDS) {
      for (const sample of audioFor(tableId).samples) {
        expect(sample.rate).toBe(Math.round(3546895 / sample.period));
        expect(sample.volume).toBeLessThanOrEqual(PAULA_MAX_VOLUME);
      }
    }
  });

  it("binds only things the scoring layer can actually award", () => {
    // The key IS the award id. If these two ever drift apart the sound simply
    // stops happening, silently, which is the kind of bug that survives for
    // months — so the shape is asserted.
    for (const tableId of TABLE_IDS) {
      const audio = audioFor(tableId);
      let bound = 0;
      for (const id of [
        ...Array.from({ length: 224 }, (_, i) => `device-${i + 32}`),
        ...Array.from({ length: 6 }, (_, i) => `bumper-${i + 16}`),
        ...Array.from({ length: 10 }, (_, i) => `slingshot-${i + 22}`),
      ]) {
        if (audio.sampleForAward(id) !== null) bound += 1;
      }
      expect(bound, `${tableId} binds no device, bumper or slingshot sound`).toBeGreaterThan(0);
      expect(audio.sampleForAward("nothing-at-all")).toBeNull();
    }
  });

  it("labels every sample decoded, kind-5 included", () => {
    // The (bank, instrument) resolver was found: the table loader at
    // main.seg00 $343E resolves every kind-5 record at load time, exactly the
    // rule the exporter applies, so the old "inferred" label is retired.
    const kinds = new Set(
      TABLE_IDS.flatMap((tableId) => audioFor(tableId).samples).map(
        (sample) => `${sample.kind}:${sample.provenance}`,
      ),
    );
    expect(kinds.has("sample:decoded")).toBe(true);
    expect(kinds.has("instrument:decoded")).toBe(true);
    for (const kind of kinds) {
      expect(["sample:decoded", "instrument:decoded"]).toContain(kind);
    }
  });
});

describe("the sound manifest parser refuses", () => {
  const mutate = (change: (doc: Record<string, unknown>) => void): TableAudioDocument => {
    const doc = JSON.parse(JSON.stringify(documentFor("law-n-justice"))) as Record<string, unknown>;
    change(doc);
    return doc as unknown as TableAudioDocument;
  };

  it("a document with the wrong schema", () => {
    expect(() => parseTableAudioDocument(mutate((doc) => { doc["schema"] = "no"; }))).toThrow(/schema/);
  });

  it("a sample with no digest", () => {
    expect(() =>
      parseTableAudioDocument(mutate((doc) => { (doc["samples"] as { sha256: string }[])[0]!.sha256 = ""; })),
    ).toThrow(/sha256/);
  });

  it("a volume Paula could not hold", () => {
    expect(() =>
      parseTableAudioDocument(mutate((doc) => { (doc["samples"] as { volume: number }[])[0]!.volume = 65; })),
    ).toThrow(/volume/);
  });

  it("a trigger naming a sample that is not there", () => {
    expect(() =>
      parseTableAudioDocument(mutate((doc) => { (doc["triggers"] as { sample: number }[])[0]!.sample = 99; })),
    ).toThrow(/trigger/);
  });
});

describe("the engine sound manifest", () => {
  const EVENTS = [
    "flipper-raise",
    "flipper-rest",
    "serve",
    "drain",
    "level-transfer",
    "capture",
    "eject",
  ] as const;

  it("parses, binds its seven events, and every WAV matches its digest", () => {
    const engine = engineFor();
    expect(engine.samples.length).toBe(7);
    for (const sample of engine.samples) {
      const file = new URL(`../public/generated/${sample.file}`, import.meta.url);
      const bytes = readFileSync(file);
      expect(createHash("sha256").update(bytes).digest("hex"), sample.file).toBe(sample.sha256);
      expect(bytes.length).toBe(44 + sample.bytes);
      expect(bytes.readUInt32LE(24), `${sample.file} rate`).toBe(sample.rate);
      expect(sample.rate).toBe(Math.round(3546895 / sample.period));
      expect(sample.provenance).toBe("decoded");
    }
    for (const id of EVENTS) expect(engine.sampleFor(id), id).not.toBeNull();
    expect(engine.sampleFor("tilt")).toBeNull(); // no tilt sample exists to bind
  });

  it("keeps the records' own priorities: serve over drain over the flippers", () => {
    // Straight out of main.bin hunk 10: these are what decide which of two
    // same-frame events the one channel actually voices.
    const engine = engineFor();
    const priority = (id: string) => (engine.sampleFor(id) as AudioSample).priority;
    expect(priority("serve")).toBe(50);
    expect(priority("drain")).toBe(45);
    expect(priority("capture")).toBe(43);
    expect(priority("eject")).toBe(43);
    expect(priority("level-transfer")).toBe(41);
    expect(priority("flipper-raise")).toBe(40);
    expect(priority("flipper-rest")).toBe(20);
  });
});

describe("the tick report reaches the engine sounds", () => {
  function stubbedBank(tableId: TableId = "law-n-justice"): {
    bank: AudioBank;
    host: FakeHost;
    tags: Map<unknown, string>;
  } {
    const host = new FakeHost();
    const bank = createAudioBank(host, audioFor(tableId), engineFor());
    const tags = new Map<unknown, string>();
    const admit = (sample: AudioSample): void => {
      const buffer = { file: sample.file } as unknown as AudioBuffer;
      tags.set(buffer, sample.file);
      bank.buffers.set(sample.file, buffer);
    };
    for (const sample of bank.audio.samples) admit(sample);
    for (const sample of (bank.engine as EngineAudio).samples) admit(sample);
    return { bank, host, tags };
  }
  const startedFiles = (host: FakeHost, tags: Map<unknown, string>): (string | undefined)[] =>
    host.started.map((one) => tags.get(one.buffer));
  const engineFile = (bank: AudioBank, id: string): string =>
    ((bank.engine as EngineAudio).sampleFor(id) as AudioSample).file;

  it("a serve, a drain, a capture, a transfer and both flipper strokes all sound", () => {
    const { bank, host, tags } = stubbedBank();
    const ticks: Partial<GameTickReport>[] = [
      { served: true },
      { drained: [0] },
      { locked: [1] },
      { levelTransfers: [0] },
      { flipperRaised: ["left"] },
      { flipperRested: ["left"] },
    ];
    for (const over of ticks) {
      playTick(bank, reportWith(over));
      host.currentTime += 10; // let each effect end so nothing is refused
    }
    expect(startedFiles(host, tags)).toEqual([
      engineFile(bank, "serve"),
      engineFile(bank, "drain"),
      engineFile(bank, "capture"),
      engineFile(bank, "level-transfer"),
      engineFile(bank, "flipper-raise"),
      engineFile(bank, "flipper-rest"),
    ]);
  });

  it("an eject plays the saucer's own voice when the table has one, else the engine's", () => {
    const { bank, host, tags } = stubbedBank(); // LNJ records zone-eject-0-5..7
    const own = bank.audio.sampleForAward("zone-eject-0-5") as AudioSample;
    expect(own).not.toBeNull();
    playTick(bank, reportWith({ ejected: [0], ejectedFrom: [{ level: 0, index: 5 }] }));
    host.currentTime += 10;
    playTick(bank, reportWith({ ejected: [0], ejectedFrom: [{ level: 0, index: 99 }] }));
    expect(startedFiles(host, tags)).toEqual([own.file, engineFile(bank, "eject")]);
  });

  it("a flipper thump cannot displace a sounding mission callout", () => {
    const { bank, host } = stubbedBank();
    const callout = bank.audio.samples.find((one) => one.priority >= 100) as AudioSample;
    expect(playSample(bank, callout)).toBe(true);
    // Priority 40 against a sounding 100: both flags dropped, $779E's refusal.
    playTick(bank, reportWith({ flipperRaised: ["left", "right"] }));
    expect(host.started.length).toBe(1);
    // Once it has ended the flipper sounds — and the drain (45) displaces the
    // thump (40), because a ball out speaks over the bat that missed it.
    host.currentTime = bank.channel.until + 1;
    playTick(bank, reportWith({ flipperRaised: ["left"] }));
    playTick(bank, reportWith({ drained: [0] }));
    expect(host.started.length).toBe(3);
  });

  it("mode starts and shown messages fire the sting layer", () => {
    // BabeWatch binds mode-message-0 and mode-start-7; see the exporter's log.
    const { bank, host } = stubbedBank("babewatch");
    expect(bank.audio.sampleForAward("mode-message-0")).not.toBeNull();
    expect(bank.audio.sampleForAward("mode-start-7")).not.toBeNull();
    playTick(bank, reportWith({ messagesShown: [0] }));
    host.currentTime += 10;
    playTick(bank, reportWith({ elementStarts: [7] }));
    expect(host.started.length).toBe(2);
  });

  it("a bank with no engine manifest plays the table and keeps engine events silent", () => {
    const host = new FakeHost();
    const bank = createAudioBank(host, audioFor("law-n-justice"));
    for (const sample of bank.audio.samples) {
      bank.buffers.set(sample.file, { length: sample.bytes } as unknown as AudioBuffer);
    }
    playTick(bank, reportWith({ served: true, drained: [0], flipperRaised: ["left"] }));
    expect(host.started.length).toBe(0);
  });
});

describe("the effect channel", () => {
  it("plays a bound award and gives it Paula's own volume", async () => {
    const bank = await bankFor("law-n-justice");
    const host = bank.host as FakeHost;
    const sample = bank.audio.samples.find((one) => one.priority > 0) as AudioSample;
    expect(playSample(bank, sample)).toBe(true);
    expect(host.started.length).toBe(1);
    expect(host.started[0]?.gain).toBeCloseTo(sample.volume / PAULA_MAX_VOLUME, 6);
  });

  it("refuses to let a quieter event interrupt a louder one", async () => {
    // `$779E`: `cmp.w $2(a1),d7 / bcs skip` — strictly lower priority is dropped
    // while the current effect is still sounding, and an equal one gets through.
    const bank = await bankFor("babewatch");
    const host = bank.host as FakeHost;
    const loud = [...bank.audio.samples].sort((a, b) => b.priority - a.priority)[0] as AudioSample;
    const quiet = [...bank.audio.samples].sort((a, b) => a.priority - b.priority)[0] as AudioSample;
    expect(loud.priority).toBeGreaterThan(quiet.priority);

    expect(playSample(bank, loud)).toBe(true);
    expect(playSample(bank, quiet)).toBe(false);
    expect(playSample(bank, loud)).toBe(true);
    expect(host.started.length).toBe(2);

    // Once it has finished, anything may start.
    host.currentTime = bank.channel.until + 1;
    expect(playSample(bank, quiet)).toBe(true);
  });

  it("plays nothing at all while muted, and stops what was sounding", async () => {
    const bank = await bankFor("law-n-justice");
    const host = bank.host as FakeHost;
    const sample = bank.audio.samples[0] as AudioSample;
    playSample(bank, sample);
    setMuted(bank, true);
    expect(host.stops).toBeGreaterThan(0);
    expect(playSample(bank, sample)).toBe(false);
    setMuted(bank, false);
    expect(playSample(bank, sample)).toBe(true);
  });

  it("plays nothing for an award nothing is bound to", async () => {
    const bank = await bankFor("law-n-justice");
    expect(playAward(bank, award("device-255"))).toBe(false);
  });

  it("survives a sample that will not load", async () => {
    const bank = createAudioBank(new FakeHost(), audioFor("law-n-justice"));
    await loadAudioBank(bank, async () => ({ ok: false, async arrayBuffer() { return new ArrayBuffer(0); } }));
    expect(bank.failed.size).toBe(bank.audio.samples.length);
    expect(playSample(bank, bank.audio.samples[0] as AudioSample)).toBe(false);
  });
});

describe("audio cannot reach the simulation", () => {
  it("plays a real game's ticks and changes nothing about it", () => {
    // The contract in one assertion. The same game is run twice from the same
    // start; the second run has the whole sound layer hanging off every tick.
    // The two must finish byte-identical.
    const idle = (): InputSource => ({ sample: () => IDLE_SNAPSHOT });

    const silent = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
    startGame(silent);
    runTicks(silent, idle(), 3_000);

    const loud = createGame(mapFor("law-n-justice"), { ballsPerGame: 3 });
    startGame(loud);
    const bank = createAudioBank(new FakeHost(), audioFor("law-n-justice"), engineFor());
    // Buffers on purpose, so `playSample` really runs rather than bailing out on
    // a missing one: the point is that the WORK happening changes nothing. The
    // engine bank is stubbed too, so the serve/drain/flipper paths all run.
    for (const sample of [...bank.audio.samples, ...(bank.engine as EngineAudio).samples]) {
      bank.buffers.set(sample.file, { length: sample.bytes } as unknown as AudioBuffer);
    }
    for (const report of runTicks(loud, idle(), 3_000)) playTick(bank, report);

    expect(JSON.stringify(debugSnapshot(loud))).toBe(JSON.stringify(debugSnapshot(silent)));
  });
});

// ---------------------------------------------------------------------------
// The shell music: the rendered stream, the output layer, and the controller
// that follows the shell's phases. All in node, on fakes, per the house law.
// ---------------------------------------------------------------------------

/** One fake voice: records its starts, stops and scheduled parameter changes. */
class FakeMusicSource {
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = {
    value: 1,
    changes: [] as { value: number; time: number }[],
    setValueAtTime(value: number, time: number): void {
      this.changes.push({ value, time });
    },
  };
  readonly started: number[] = [];
  readonly stopped: number[] = [];
  gainNode: FakeMusicGain | null = null;
  connect(target: unknown): void {
    this.gainNode = target as FakeMusicGain;
  }
  start(when = 0): void {
    this.started.push(when);
  }
  stop(when = 0): void {
    this.stopped.push(when);
  }
}

class FakeMusicGain {
  readonly gain = {
    value: 1,
    changes: [] as { value: number; time: number }[],
    setValueAtTime(value: number, time: number): void {
      this.changes.push({ value, time });
    },
  };
  connect(): void {
    /* sink */
  }
}

/** The slice of `AudioContext` the tracker output uses, as a recorder. */
class FakeMusicHost implements TrackerHost {
  currentTime = 0;
  state = "running";
  readonly destination = {} as AudioNode;
  readonly sources: FakeMusicSource[] = [];
  readonly gains: FakeMusicGain[] = [];
  resumes = 0;
  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    return {
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length),
    } as unknown as AudioBuffer;
  }
  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeMusicSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
  createGain(): GainNode {
    const gain = new FakeMusicGain();
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }
  async resume(): Promise<void> {
    this.resumes += 1;
    this.state = "running";
  }
}

function fakeMusicStorage(seed: Record<string, string> = {}): MusicStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("the shell music stream", () => {
  it("renders one pass of the decoded module, deterministic to the byte", async () => {
    const asset = await shippedShellMusic();
    if (asset === null) return;
    const one = renderSongStream(asset.song, asset.voices, asset.startOrder);
    const two = renderSongStream(asset.song, asset.voices, asset.startOrder);
    expect(one.commands.length).toBeGreaterThan(0);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    // The memo hands back the same object rather than re-rendering.
    expect(songStreamFor(asset.song, asset.voices, asset.startOrder)).toBe(
      songStreamFor(asset.song, asset.voices, asset.startOrder),
    );
    // ...and a different entry point is a different stream, not the memo's.
    expect(songStreamFor(asset.song, asset.voices, 0)).not.toBe(
      songStreamFor(asset.song, asset.voices, asset.startOrder),
    );
  });

  it("times the pass to the module's own speed changes", async () => {
    const asset = await shippedShellMusic();
    if (asset === null) return;
    const stream = songStreamFor(asset.song, asset.voices, asset.startOrder);
    // Not `orders.length * 64 * rowMs`: the module sets its own speed with `F`
    // on row 0 of nearly every pattern (F03 on 23 of the loop's orders, F06 on
    // 9, and F01/F04/F05/F08/F0A/F0E scattered besides), so the pass is a sum
    // over rows rather than a product.
    const tickMs = 2500 / asset.song.initialTempo;
    expect(tickMs).toBe(20);
    let previous = -1;
    for (const command of stream.commands) {
      expect(command.timeMs).toBeGreaterThanOrEqual(previous);
      expect(command.timeMs).toBeLessThan(stream.durationMs);
      previous = command.timeMs;
    }
  });

  it("names only voices the loaded bank builds, and speaks all three kinds", async () => {
    const asset = await shippedShellMusic();
    if (asset === null) return;
    const stream = songStreamFor(asset.song, asset.voices, asset.startOrder);
    const kinds = new Set<string>();
    for (const command of stream.commands) {
      kinds.add(command.kind);
      expect(command.channel).toBeGreaterThanOrEqual(0);
      expect(command.channel).toBeLessThan(4);
      if (command.kind === "note") {
        expect(asset.bank(command.instrument), command.instrument).not.toBeNull();
      }
    }
    expect([...kinds].sort()).toEqual(["note", "pitch", "volume"]);
  });

  it("refuses a song whose instruments have no voice in the bank", async () => {
    const asset = await shippedShellMusic();
    if (asset === null) return;
    expect(() => renderSongStream(asset.song, {})).toThrow(/no synthesized voice/);
  });
});

// ---------------------------------------------------------------------------
// THE LAP. These are the assertions the film is the oracle for, and the whole
// reason the shipped module is the one in `intro.bin` rather than the one in
// `music001.bin`. Measured against the continuous 399.6 s take in
// research/view/reference/session3 (48 kHz, unresampled), rendering this exact
// command stream at 960 samples a field:
//
//   * the take's own waveform self-correlation is +0.9969 at lag 8077 fields
//     and -0.100..-0.017 at 8074..8076 and 8078..8080 — a sharp measurement,
//     not a fit;
//   * one 8077-field lap of this render sits in the take at +0.7240 waveform
//     and +0.9820 onset-envelope, twice, exactly 8077 fields apart;
//   * all 33 orders of the lap correlate individually, waveform +0.5615 worst,
//     +0.7083 median, +0.9081 best;
//   * the `A01` volume slides at pattern 35 rows 39-43 take the render to
//     DIGITAL ZERO for loop-offset fields 6499..6516, and the take is at the
//     noise floor at loop offsets 6499.5..6515.5 on all three of its laps;
//   * the separate cold-boot take replicates the whole lap at +0.7223 waveform
//     and +0.9821 envelope, and the lead-in orders 17 and 18 at +0.9389 and
//     +0.8758 — while every order before 17 correlates at noise there, four of
//     them against 884 fields in which that take is at digital zero.
//
// The reading these replaced — music001 at speed 4/8, lapping in 3584 — scored
// +0.0146 waveform and +0.0322 envelope through the identical pipeline.
// ---------------------------------------------------------------------------

/** Where the machine enters the module. See `ShellMusicAsset.startOrder`. */
const SHIPPED_START_ORDER = 17;
/** Orders 17 and 18, played once before the loop: 384 + 192 fields. */
const SHIPPED_LEAD_IN_FIELDS = 576;
const SHIPPED_LAP_FIELDS = 8077;

/** Steps the shipped song and reports where the order list actually goes. */
function walkShippedSong(song: TrackerSong, fields: number): {
  readonly entries: { order: number; field: number }[];
  readonly rowLengths: Map<number, number>;
} {
  const player = createTrackerPlayer(song, SHIPPED_START_ORDER);
  const entries: { order: number; field: number }[] = [];
  const rowLengths = new Map<number, number>();
  let previousOrder = -1;
  let rowStart = 0;
  for (let field = 0; field < fields; field += 1) {
    if (player.row === 0 && player.tick === 0 && player.order !== previousOrder) {
      entries.push({ order: player.order, field });
      previousOrder = player.order;
    }
    const row = player.row;
    const order = player.order;
    stepTracker(player);
    if (player.row !== row || player.order !== order) {
      const length = field + 1 - rowStart;
      rowLengths.set(length, (rowLengths.get(length) ?? 0) + 1);
      rowStart = field + 1;
    }
  }
  return { entries, rowLengths };
}

describe("the front-end module's lap, against the capture", () => {
  it("loops in exactly 8077 PAL fields", async () => {
    const asset = await shippedShellMusic();
    if (asset === null) return;
    const stream = songStreamFor(asset.song, asset.voices, asset.startOrder);
    // One field is one tick is 20 ms — the EXTER interrupt the copper raises
    // once a frame. See the tracker core's header.
    expect(2500 / asset.song.initialTempo).toBe(20);
    expect(stream.restartMs).not.toBeNull();
    const restartFields = (stream.restartMs as number) / 20;
    const totalFields = stream.durationMs / 20;
    expect(totalFields - restartFields).toBe(SHIPPED_LAP_FIELDS);
    // And the lead-in ahead of it, orders 17 and 18, played once.
    expect(restartFields).toBe(SHIPPED_LEAD_IN_FIELDS);
    expect(totalFields).toBe(SHIPPED_LEAD_IN_FIELDS + SHIPPED_LAP_FIELDS);
  });

  it("is entered at order 17, where the cold-boot take's 884-field silence ends", async () => {
    const asset = await shippedShellMusic();
    if (asset === null) return;
    expect(asset.startOrder).toBe(SHIPPED_START_ORDER);
    // Orders 17 and 18 are 384 and 192 fields — patterns 16 and 28 at F06 and
    // F03 — and they are what plays before the loop, once.
    const { entries } = walkShippedSong(asset.song, SHIPPED_LEAD_IN_FIELDS + 1);
    expect(entries).toEqual([
      { order: 17, field: 0 },
      { order: 18, field: 384 },
      { order: 19, field: SHIPPED_LEAD_IN_FIELDS },
    ]);
  });

  it("loops orders 19..51 on the B13, and plays 17..18 exactly once", async () => {
    const asset = await shippedShellMusic();
    if (asset === null) return;
    expect(asset.song.orders.length).toBe(54);
    // The jump itself: `B13` on the last row of the last order of the loop.
    const last = asset.song.orders[51] as number;
    expect(last).toBe(29);
    const jump = (asset.song.patterns[last] as readonly (readonly unknown[])[])[63]?.[0] as {
      effect: number;
      param: number;
    };
    expect([jump.effect, jump.param]).toEqual([0xb, 0x13]);

    const span = SHIPPED_LEAD_IN_FIELDS + 2 * SHIPPED_LAP_FIELDS + 1;
    const { entries } = walkShippedSong(asset.song, span);
    const firstPass = entries.slice(0, 35).map((one) => one.order);
    expect(firstPass).toEqual(Array.from({ length: 35 }, (_, at) => at + 17));
    // Orders 52 and 53 are dead: the B13 fires at 51 and never reaches them.
    expect(entries.map((one) => one.order)).not.toContain(52);
    expect(entries.map((one) => one.order)).not.toContain(53);
    // And 0..16 are never entered at all: the machine does not start there.
    expect(Math.min(...entries.map((one) => one.order))).toBe(17);
    // Every later pass re-enters at 19, one lap apart to the field.
    const reentries = entries.filter((one) => one.order === 19).map((one) => one.field);
    expect(reentries).toEqual([
      SHIPPED_LEAD_IN_FIELDS,
      SHIPPED_LEAD_IN_FIELDS + SHIPPED_LAP_FIELDS,
      SHIPPED_LEAD_IN_FIELDS + 2 * SHIPPED_LAP_FIELDS,
    ]);
  });

  it("plays the lap on a six-field row, with the one one-field row that makes 8077 odd", async () => {
    const asset = await shippedShellMusic();
    if (asset === null) return;
    // Rows counted over the lead-in AND the lap; the lap's own share is
    // 1504 x 3 + 594 x 6 + 1 x 1 = 8077 over 2099 rows.
    const span = SHIPPED_LEAD_IN_FIELDS + SHIPPED_LAP_FIELDS;
    const { rowLengths } = walkShippedSong(asset.song, span);
    const total = [...rowLengths.entries()].reduce((sum, [len, n]) => sum + len * n, 0);
    expect(total).toBe(span);
    // Every row is 3 or 6 fields except the single one-field row the `F01` at
    // pattern 35 row 46 buys — the reason 8077 is not divisible by 6.
    expect([...rowLengths.keys()].sort((a, b) => a - b)).toEqual([1, 3, 6]);
    expect(rowLengths.get(1)).toBe(1);
    expect(rowLengths.get(3)).toBe(1504 + 64); // the lap's 1504, plus order 18's 64
    expect(rowLengths.get(6)).toBe(594 + 64); //  the lap's  594, plus order 17's 64
    // The audible grid is six fields: a speed-3 pattern puts its notes on even
    // rows, which is why the capture's onset autocorrelation peaks at 6, 12,
    // 18, 24, 30, 36 and 48 and goes NEGATIVE at 3 and 8. Measured on the
    // capture: mean ACF +0.0849 at multiples of six against -0.0091 elsewhere,
    // with the WORST multiple of six (+0.0609) above the BEST non-multiple
    // (+0.0509). This render gives +0.1552 against -0.0218 on the same test.
    expect(1504 * 3 + 594 * 6 + 1).toBe(SHIPPED_LAP_FIELDS);
  });

  it("takes all four channels to silence where the capture goes silent", async () => {
    const asset = await shippedShellMusic();
    if (asset === null) return;
    // Pattern 35 (order 47) rows 39..43 carry `A01` on all four channels, and
    // the volumes reach 0 together. The capture is at its noise floor for the
    // same 17 fields of every lap.
    const pattern = asset.song.patterns[35] as readonly (readonly {
      effect: number;
      param: number;
    }[])[];
    for (let channel = 0; channel < 4; channel += 1) {
      const slides = [39, 40, 41, 42, 43].filter((row) => {
        const at = pattern[row]?.[channel];
        return at !== undefined && at.effect === 0xa && at.param === 0x01;
      });
      expect(slides.length, `channel ${channel} volume slides`).toBeGreaterThan(0);
    }
    // And the stream really does emit volume 0 on every channel there.
    const player = createTrackerPlayer(asset.song, SHIPPED_START_ORDER);
    const silenced = new Set<number>();
    const from = SHIPPED_LEAD_IN_FIELDS + 6400;
    for (let field = 0; field < SHIPPED_LEAD_IN_FIELDS + 6516; field += 1) {
      for (const command of stepTracker(player)) {
        if (field < from) continue;
        if (command.action === "volume" && command.volume === 0) silenced.add(command.channel);
      }
    }
    expect([...silenced].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe("the tracker output schedules the stream", () => {
  const tinyStream = (): TrackerCommandStream => ({
    commands: [
      { kind: "note", timeMs: 0, channel: 0, instrument: "pulse50", frequencyHz: 440, volume: 64 },
      { kind: "pitch", timeMs: 100, channel: 0, frequencyHz: 880 },
      { kind: "volume", timeMs: 200, channel: 0, volume: 32 },
      { kind: "stop", timeMs: 300, channel: 0 },
    ],
    durationMs: 400,
    restartMs: null,
  });

  it("starts, retunes, fades and stops a voice at its scheduled times", () => {
    const host = new FakeMusicHost();
    const output = createTrackerOutput(() => host);
    expect(startTracker(output, tinyStream())).toBe(true);

    expect(host.sources.length).toBe(1);
    const voice = host.sources[0] as FakeMusicSource;
    expect(voice.started).toEqual([0]);
    // 440 Hz on a 440 Hz base buffer is rate 1; the pitch command doubles it.
    expect(voice.playbackRate.value).toBeCloseTo(1, 9);
    expect(voice.playbackRate.changes).toEqual([{ value: 2, time: 0.1 }]);
    // Paula volume 32 of 64 is half gain, at 200 ms.
    expect(voice.gainNode?.gain.changes).toEqual([{ value: 0.5, time: 0.2 }]);
    expect(voice.stopped).toContain(0.3);
  });

  it("a pitch on a silent channel is a no-op, as writing an idle register is", () => {
    const host = new FakeMusicHost();
    const output = createTrackerOutput(() => host);
    const started = startTracker(output, {
      commands: [{ kind: "pitch", timeMs: 0, channel: 2, frequencyHz: 880 }],
      durationMs: 100,
      restartMs: null,
    });
    expect(started).toBe(true);
    expect(host.sources.length).toBe(0);
  });

  it("loops from the restart point, each pass later than the last", () => {
    const host = new FakeMusicHost();
    const output = createTrackerOutput(() => host);
    startTracker(output, {
      commands: [
        { kind: "note", timeMs: 0, channel: 0, instrument: "pulse50", frequencyHz: 440, volume: 64 },
      ],
      durationMs: 200,
      restartMs: 0,
    });
    // The 0.5 s lookahead covers the passes at 0, 200 and 400 ms — and stops.
    expect(host.sources.length).toBe(3);
    const starts = host.sources.map((source) => source.started[0] as number);
    expect(starts[0]).toBeCloseTo(0, 9);
    expect(starts[1]).toBeCloseTo(0.2, 9);
    expect(starts[2]).toBeCloseTo(0.4, 9);
  });

  it("a browser with no AudioContext ends in silence, not an error", () => {
    const output = createTrackerOutput(() => null);
    expect(startTracker(output, tinyStream())).toBe(false);
    pumpTracker(output); // and pumping the silence is safe too
    expect(output.playing).toBe(false);
  });
});

describe("the shell music follows the shell", () => {
  const MUSICAL_PHASES: readonly ShellPhase[] = [
    "attract",
    "menu",
    "select",
    "info",
    "loading",
    "failed",
    "game-over",
    "fanfare",
    "initials",
    "ladder",
  ];
  const SILENT: readonly ShellPhase[] = ["play", "quit-confirm"];

  it("plays over every shell screen and not over the ball", () => {
    for (const phase of MUSICAL_PHASES) expect(musicWantedFor(phase), phase).toBe(true);
    for (const phase of SILENT) expect(musicWantedFor(phase), phase).toBe(false);
  });

  it("starts on attract, holds through the menus, stops for play, returns at game over", () => {
    const host = new FakeMusicHost();
    const music = createShellMusic(fakeMusicStorage(), () => host);
  music.useAsset(syntheticShellMusicAsset());

    music.update("attract");
    expect(music.output.playing).toBe(true);
    const startedOnAttract = host.sources.length;
    expect(startedOnAttract).toBeGreaterThan(0);
    const anchoredAt = music.output.startContextTime;

    // The menus continue the same performance rather than restarting it.
    music.update("menu");
    music.update("select");
    music.update("info");
    expect(music.output.playing).toBe(true);
    expect(music.output.startContextTime).toBe(anchoredAt);
    expect(host.sources.length).toBe(startedOnAttract);

    // Play silences it and clears the schedule.
    music.update("play");
    expect(music.output.playing).toBe(false);
    expect(music.output.stream).toBeNull();

    // Game over brings it back, from the top.
    music.update("game-over");
    expect(music.output.playing).toBe(true);
    expect(host.sources.length).toBeGreaterThan(startedOnAttract);
  });

  it("stop() silences a hidden tab and the next update starts afresh", () => {
    const host = new FakeMusicHost();
    const music = createShellMusic(fakeMusicStorage(), () => host);
  music.useAsset(syntheticShellMusicAsset());
    music.update("attract");
    music.stop();
    expect(music.output.playing).toBe(false);
    music.update("attract");
    expect(music.output.playing).toBe(true);
  });

  it("mutes at the master gain, persists the setting, honours it from boot", () => {
    const host = new FakeMusicHost();
    const storage = fakeMusicStorage();
    const music = createShellMusic(storage, () => host);
  music.useAsset(syntheticShellMusicAsset());
    music.update("attract");

    expect(music.toggleMuted()).toBe(true);
    expect(storage.data.get(MUSIC_MUTED_STORAGE_KEY)).toBe("1");
    expect((music.output.master as unknown as FakeMusicGain).gain.value).toBe(0);
    // Scheduling continues while muted, so unmuting rejoins mid-phrase.
    expect(music.output.playing).toBe(true);

    expect(music.toggleMuted()).toBe(false);
    expect(storage.data.get(MUSIC_MUTED_STORAGE_KEY)).toBe("0");
    expect((music.output.master as unknown as FakeMusicGain).gain.value).toBe(1);

    // A stored mute is applied before the first note sounds.
    const rebootHost = new FakeMusicHost();
    const reboot = createShellMusic(
      fakeMusicStorage({ [MUSIC_MUTED_STORAGE_KEY]: "1" }),
      () => rebootHost,
    );
  reboot.useAsset(syntheticShellMusicAsset());
    reboot.update("attract");
    expect(reboot.muted()).toBe(true);
    expect((reboot.output.master as unknown as FakeMusicGain).gain.value).toBe(0);
    expect(reboot.output.playing).toBe(true);
  });

  it("survives no storage, and storage that throws", () => {
    const none = createShellMusic(null, () => new FakeMusicHost());
  none.useAsset(syntheticShellMusicAsset());
    none.update("attract");
    expect(none.toggleMuted()).toBe(true);

    const hostile: MusicStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const music = createShellMusic(hostile, () => new FakeMusicHost());
  music.useAsset(syntheticShellMusicAsset());
    music.update("attract");
    expect(music.toggleMuted()).toBe(true);
    expect(music.output.playing).toBe(true);
  });

  it("survives a browser with no audio device at all", () => {
    const music = createShellMusic(fakeMusicStorage(), () => null);
  music.useAsset(syntheticShellMusicAsset());
    music.update("attract");
    expect(music.output.playing).toBe(false);
    music.update("play");
    music.update("attract"); // and keeps retrying without throwing
    expect(music.toggleMuted()).toBe(true);
  });

  it("the mute key collides with nothing: no game control, no shell key", () => {
    const event = { code: MUSIC_TOGGLE_CODE, key: MUSIC_TOGGLE_KEY };
    expect(controlForKeyEvent(event)).toBeNull();
    expect(shellKeyFor(event)).toBeNull();
  });
});

describe("music cannot reach the simulation", () => {
  it("no module under src/game imports the audio layer", () => {
    const dir = new URL("../src/game/", import.meta.url);
    const names = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const text = readFileSync(new URL(name, dir), "utf8");
      expect(/from\s+["']\.\.\/audio\//.test(text), `src/game/${name} imports src/audio`).toBe(
        false,
      );
    }
  });

  it("the pure audio modules import no game or browser code", () => {
    const dir = new URL("../src/audio/", import.meta.url);
    const names = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const text = readFileSync(new URL(name, dir), "utf8");
      expect(
        /from\s+["']\.\.\/(game|browser)\//.test(text),
        `src/audio/${name} reaches outside the audio layer`,
      ).toBe(false);
    }
  });
});
