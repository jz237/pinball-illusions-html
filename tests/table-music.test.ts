/**
 * The in-game music: the decoded table modules, their section streams, and
 * the browser controller that plays them.
 *
 * Two layers of test, on the shell music's own pattern:
 *
 *   - the SHIPPED assets (skipped in a checkout without them): the three
 *     manifests parse, every WAV matches its digest, the cue records carry
 *     exactly the values decoded from the packages, and the section streams
 *     measure the laps the research renders measured — the laps the film
 *     verification anchored on;
 *   - SYNTHETIC fixtures for the semantics and the controller, so the rules
 *     (self-loop pass, F00 stop, serve/launch/tilt, the channel-3 gate) are
 *     held even where the disk assets are absent.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  loadTableMusic,
  parseTableMusicDocument,
  sectionStream,
  tableVoiceId,
} from "../src/audio/table-music.js";
import type { TableMusicAsset, TableMusicFetch } from "../src/audio/table-music.js";
import type { TrackerSong } from "../src/audio/tracker.js";
import {
  createTrackerOutput,
  setTrackerChannelLevel,
  startTracker,
} from "../src/audio/tracker-output.js";
import type { TrackerHost } from "../src/audio/tracker-output.js";
import { TABLE_MUSIC_PHASES, createTableMusic } from "../src/browser/table-music.js";
import type { AudioBank } from "../src/browser/audio.js";
import type { GameTickReport } from "../src/browser/game-loop.js";

const TABLES_DIR = fileURLToPath(new URL("../public/generated/tables/", import.meta.url));

const exported = existsSync(`${TABLES_DIR}law-n-justice.music.json`);

const diskFetch: TableMusicFetch = (url) => {
  const path = `${TABLES_DIR}${url.slice(url.lastIndexOf("/") + 1)}`;
  if (!existsSync(path)) {
    return Promise.resolve({
      ok: false,
      status: 404,
      statusText: "Not Found",
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
  }
  const bytes = readFileSync(path);
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  });
};

async function shipped(tableId: string): Promise<TableMusicAsset> {
  const asset = await loadTableMusic(tableId, diskFetch, "");
  expect(asset, `${tableId} music asset`).not.toBeNull();
  return asset as TableMusicAsset;
}

/**
 * The decoded shape of each table's music, straight from the packages:
 * bank sizes, the engine cue records, and the measured section laps in
 * milliseconds (one tick = one PAL field = 20 ms). The laps are the numbers
 * the film verification anchored on — BabeWatch's launches entered the main
 * tune exactly on 1600 ms vamp-lap boundaries, Extreme Sports' on 1920 ms,
 * Law 'n Justice's on 2880 ms — and the tilt jingle lengths are the filmed
 * tilt-to-silence gaps (Extreme Sports 2100 ms decoded against 2020/2040 ms
 * filmed, twice; BabeWatch 3700 against 3520).
 */
const DECODED = [
  {
    tableId: "law-n-justice",
    songLengths: [70, 24],
    tilt: { command: -2, position: 49, bank: 0 },
    gameOver: { command: -2, position: 50, bank: 0 },
    highScore: { command: -2, position: 38, bank: 0 },
    endStop: { command: -2, position: 22, bank: 1 },
    vampMs: 2880,
    mainMs: 138240,
    mainRestartMs: 0,
    tiltMs: 2900,
  },
  {
    tableId: "babewatch",
    songLengths: [78, 28],
    tilt: { command: 2, position: 17, bank: 1 },
    gameOver: { command: -2, position: 14, bank: 1 },
    highScore: { command: -2, position: 70, bank: 0 },
    endStop: { command: -2, position: 15, bank: 1 },
    vampMs: 1600,
    mainMs: 91200,
    mainRestartMs: 1600,
    tiltMs: 3700,
  },
  {
    tableId: "extreme-sports",
    songLengths: [70, 16],
    tilt: { command: 2, position: 11, bank: 1 },
    gameOver: { command: -2, position: 63, bank: 0 },
    highScore: { command: -2, position: 43, bank: 0 },
    endStop: { command: -2, position: 64, bank: 0 },
    vampMs: 1920,
    mainMs: 136660,
    mainRestartMs: 0,
    tiltMs: 2100,
  },
] as const;

describe.runIf(exported)("the shipped table music", () => {
  it("every manifest parses and every WAV matches its digest", () => {
    for (const table of DECODED) {
      const raw = JSON.parse(readFileSync(`${TABLES_DIR}${table.tableId}.music.json`, "utf8")) as {
        provenance: { sourceClass: string; authorizationRequired: boolean };
        samples: readonly { file: string; sha256: string }[];
      };
      expect(raw.provenance.sourceClass).toBe("disk-derived-table-music");
      expect(raw.provenance.authorizationRequired).toBe(true);
      expect(raw.samples.length).toBeGreaterThan(0);
      for (const sample of raw.samples) {
        const bytes = readFileSync(`${TABLES_DIR}${sample.file}`);
        expect(createHash("sha256").update(bytes).digest("hex"), sample.file).toBe(sample.sha256);
        expect(bytes.toString("latin1", 0, 4)).toBe("RIFF");
      }
      // The document round-trips through the strict parser.
      parseTableMusicDocument(raw);
    }
  });

  it("carries the engine's decoded cue records, table by table", async () => {
    for (const table of DECODED) {
      const asset = await shipped(table.tableId);
      expect(asset.songs[0].orders.length).toBe(table.songLengths[0]);
      expect(asset.songs[1].orders.length).toBe(table.songLengths[1]);
      // The ball-start and queue-main cues are uniform across the tables —
      // the vamp at position 0, the main tune queued from position 1.
      expect(asset.cues.vamp).toEqual({ command: -2, position: 0, bank: 0 });
      expect(asset.cues.main).toEqual({ command: -1, position: 1, bank: 0 });
      expect(asset.cues.ballStart).toEqual({ command: -2, position: 0, bank: 0 });
      expect(asset.cues.queueMain).toEqual({ command: -1, position: 1, bank: 0 });
      expect(asset.cues.tilt).toEqual(table.tilt);
      expect(asset.cues.gameOver).toEqual(table.gameOver);
      expect(asset.cues.highScore).toEqual(table.highScore);
      expect(asset.cues.endStop).toEqual(table.endStop);
    }
  });

  it("sections measure the laps the films were verified against", async () => {
    for (const table of DECODED) {
      const asset = await shipped(table.tableId);
      const song = (bank: number): TrackerSong => asset.songs[bank === 0 ? 0 : 1];
      const voices = (bank: number) => asset.voices[bank === 0 ? 0 : 1];

      const vamp = sectionStream(song(0), voices(0), asset.cues.vamp.position);
      expect(vamp.durationMs, `${table.tableId} vamp lap`).toBe(table.vampMs);
      expect(vamp.restartMs).toBe(0);

      const main = sectionStream(song(0), voices(0), asset.cues.main.position);
      expect(main.durationMs, `${table.tableId} main lap`).toBe(table.mainMs);
      expect(main.restartMs).toBe(table.mainRestartMs);

      const tilt = sectionStream(
        song(asset.cues.tilt.bank),
        voices(asset.cues.tilt.bank),
        asset.cues.tilt.position,
      );
      expect(tilt.durationMs, `${table.tableId} tilt jingle`).toBe(table.tiltMs);
      // A tilt jingle does not loop, and it ends with every channel stopped.
      expect(tilt.restartMs).toBeNull();
      const tail = tilt.commands.slice(-4);
      expect(tail.map((command) => command.kind)).toEqual(["stop", "stop", "stop", "stop"]);
    }
  });

  it("renders deterministically", async () => {
    const asset = await shipped("babewatch");
    const one = sectionStream(asset.songs[0], asset.voices[0], 0);
    const two = sectionStream(asset.songs[0], asset.voices[0], 0);
    const digest = (stream: unknown) =>
      createHash("sha256").update(JSON.stringify(stream)).digest("hex");
    expect(digest(one)).toBe(digest(two));
  });
});

// ---------------------------------------------------------------------------
// Synthetic semantics
// ---------------------------------------------------------------------------

const CELL = (note: number, instrument: number, effect: number, param: number) => ({
  note,
  instrument,
  effect,
  param,
});
const EMPTY = CELL(0, 0, 0, 0);

function rows(patternRows: (typeof EMPTY)[][]): (typeof EMPTY)[][] {
  const out = [...patternRows];
  while (out.length < 64) out.push([EMPTY, EMPTY, EMPTY, EMPTY]);
  return out;
}

/**
 * A one-instrument song: order 0 self-loops via a B00 at row 40 — a lap of
 * 41 x 6 ticks = 4920 ms, LONGER than the scheduler's lookahead so the
 * queued-switch behaviour is observable — and order 1 stops via F00.
 */
function syntheticSong(): TrackerSong {
  const loopRow = [EMPTY, EMPTY, EMPTY, CELL(0, 0, 0xb, 0x00)];
  const pattern0 = rows([
    [CELL(13, 1, 0, 0), EMPTY, EMPTY, EMPTY],
    ...Array.from({ length: 39 }, () => [EMPTY, EMPTY, EMPTY, EMPTY]),
    loopRow,
  ]);
  const pattern1 = rows([
    [CELL(25, 1, 0, 0), EMPTY, EMPTY, EMPTY],
    [EMPTY, EMPTY, EMPTY, CELL(0, 0, 0xf, 0x00)],
  ]);
  return {
    title: "table music fixture",
    initialSpeed: 6,
    initialTempo: 125,
    restart: 0,
    orders: [0, 1],
    patterns: [pattern0, pattern1],
    instruments: [{ id: 1, finetune: 0, volume: 64 }],
  };
}

/** The fixture vamp's lap: rows 0..40 at speed 6, in milliseconds. */
const FIXTURE_VAMP_MS = 41 * 6 * 20;

const FIXTURE_VOICES = { 1: tableVoiceId(0, 1) };

describe("sectionStream semantics", () => {
  it("a B00 self-loop is one pass: the lap ends when the position re-enters", () => {
    const stream = sectionStream(syntheticSong(), FIXTURE_VOICES, 0);
    // Rows 0..40 at speed 6 — the jump row plays whole.
    expect(stream.durationMs).toBe(FIXTURE_VAMP_MS);
    expect(stream.restartMs).toBe(0);
    expect(stream.commands[0]?.kind).toBe("note");
  });

  it("an F00 halts the section: its row sounds one tick, then four stops", () => {
    const stream = sectionStream(syntheticSong(), FIXTURE_VOICES, 1);
    // Row 0 runs its 6 ticks; the F00 row's own tick sounds; then the stop.
    expect(stream.durationMs).toBe(7 * 20);
    expect(stream.restartMs).toBeNull();
    expect(stream.commands.slice(-4).every((command) => command.kind === "stop")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

class FakeMusicHost implements TrackerHost {
  currentTime = 0;
  state = "running";
  readonly destination = { connect() {} } as unknown as AudioNode;
  readonly notes: { at: number; channel: number }[] = [];
  gains = 0;

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    return {
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length),
    } as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    const host = this;
    const node = {
      buffer: null as { channel?: number } | null,
      playbackRate: { value: 1, setValueAtTime() {} },
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      connect() {},
      start(when?: number) {
        host.notes.push({ at: when ?? host.currentTime, channel: -1 });
      },
      stop() {},
    };
    return node as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    this.gains += 1;
    return {
      gain: { value: 1, setValueAtTime() {} },
      connect() {},
    } as unknown as GainNode;
  }

  async resume(): Promise<void> {
    this.state = "running";
  }
}

/** The manifest the synthetic controller fixture serves. */
function fixtureManifestJson(): string {
  const flat = (pattern: (typeof EMPTY)[][]) =>
    pattern.flatMap((row) => row.flatMap((cell) => [cell.note, cell.instrument, cell.effect, cell.param]));
  const song = syntheticSong();
  const bank = (index: number) => ({
    index,
    songLength: 2,
    restart: 127,
    orders: [0, 1],
    instruments: Array.from({ length: 31 }, (_, i) => ({
      index: i + 1,
      lengthWords: i === 0 ? 4 : 0,
      finetune: 0,
      volume: 64,
      repeatWords: 0,
      repeatLengthWords: 1,
    })),
    patternCells: 4,
    patterns: song.patterns.map((pattern) => flat(pattern as (typeof EMPTY)[][])),
  });
  return JSON.stringify({
    schema: "pinball-illusions/table-music/v1",
    tableId: "fixture-table",
    displayName: "Fixture",
    provenance: { sourceClass: "disk-derived-table-music", authorizationRequired: true },
    banks: [bank(0), bank(1)],
    cues: {
      vamp: { command: -2, position: 0, bank: 0 },
      main: { command: -1, position: 1, bank: 0 },
      ballStart: { command: -2, position: 0, bank: 0 },
      queueMain: { command: -1, position: 1, bank: 0 },
      tilt: { command: -2, position: 1, bank: 0 },
      gameOver: { command: -2, position: 1, bank: 0 },
      highScore: { command: -2, position: 1, bank: 0 },
      endStop: { command: -2, position: 1, bank: 0 },
    },
    samples: [
      { bank: 0, instrument: 1, file: "fixture-b0-inst01.wav", sha256: "0", byteLength: 8, rate: 16574 },
      { bank: 1, instrument: 1, file: "fixture-b1-inst01.wav", sha256: "0", byteLength: 8, rate: 16574 },
    ],
  });
}

/** An 8-byte 8-bit mono WAV, enough for the fixture's one instrument. */
function fixtureWav(): ArrayBuffer {
  const buffer = new ArrayBuffer(52);
  const view = new DataView(buffer);
  const write = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 44, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16574, true);
  view.setUint32(28, 16574, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  write(36, "data");
  view.setUint32(40, 8, true);
  for (let i = 0; i < 8; i += 1) view.setUint8(44 + i, 128 + (i % 2 === 0 ? 40 : -40));
  return buffer;
}

const fixtureFetch: TableMusicFetch = (url) => {
  const ok = (body: ArrayBuffer) =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: () => Promise.resolve(body),
    });
  if (url.endsWith(".music.json")) {
    if (!url.endsWith("fixture-table.music.json")) {
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: "Not Found",
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
    }
    return ok(new TextEncoder().encode(fixtureManifestJson()).buffer as ArrayBuffer);
  }
  return ok(fixtureWav());
};

/** A report with nothing happening, to be overridden per test. */
function report(overrides: Partial<GameTickReport>): GameTickReport {
  return {
    tick: 0,
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
    ...overrides,
  } as unknown as GameTickReport;
}

async function readyController(host: FakeMusicHost) {
  const controller = createTableMusic(() => host, fixtureFetch);
  controller.select("fixture-table");
  // The select's fetch is promise-plumbed; a macrotask turn settles it.
  await new Promise((settle) => setTimeout(settle, 0));
  return controller;
}

const effectsBank = (until: number): AudioBank =>
  ({ channel: { source: null, priority: 0, until } }) as unknown as AudioBank;

describe("the table music controller", () => {
  it("plays only in the table phases", () => {
    expect(TABLE_MUSIC_PHASES.has("play")).toBe(true);
    expect(TABLE_MUSIC_PHASES.has("quit-confirm")).toBe(true);
    expect(TABLE_MUSIC_PHASES.has("attract")).toBe(false);
    expect(TABLE_MUSIC_PHASES.has("menu")).toBe(false);
  });

  it("serve starts the vamp; launch switches to the main tune at a lap boundary", async () => {
    const host = new FakeMusicHost();
    const controller = await readyController(host);

    controller.observe(report({ served: true }));
    controller.update("play", null);
    expect(controller.output.playing).toBe(true);
    expect(controller.output.stream?.durationMs).toBe(FIXTURE_VAMP_MS);
    const vampStart = controller.output.startContextTime;
    const lap = FIXTURE_VAMP_MS / 1000;

    // Launch mid-vamp: nothing switches until the boundary comes within the
    // scheduler's lookahead, and then the main stream starts EXACTLY on it.
    controller.observe(report({ launched: true }));
    host.currentTime = vampStart + 0.05;
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(FIXTURE_VAMP_MS);
    host.currentTime = vampStart + lap - 0.2; // boundary now inside the lookahead
    controller.update("play", null);
    expect(controller.output.stream?.restartMs).toBeNull(); // the F00 fixture "main"
    expect(controller.output.startContextTime).toBeCloseTo(vampStart + lap, 10);
  });

  it("a multiball add-a-ball serve does not restart the vamp over the main tune", async () => {
    const host = new FakeMusicHost();
    const controller = await readyController(host);

    controller.observe(report({ served: true }));
    controller.update("play", null);
    const vamp = controller.output.stream;
    controller.observe(report({ launched: true }));
    host.currentTime = controller.output.startContextTime + FIXTURE_VAMP_MS / 1000 - 0.2;
    controller.update("play", null);
    const main = controller.output.stream;
    expect(main).not.toBe(vamp);

    // A second serve with a ball still live: no music cue on the machine.
    controller.observe(report({ served: true }));
    controller.update("play", null);
    expect(controller.output.stream).toBe(main);

    // Both drain, then a fresh ball: the vamp comes back.
    controller.observe(report({ drained: [0, 1] }));
    controller.observe(report({ served: true }));
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(FIXTURE_VAMP_MS);
  });

  it("tilt plays the jingle and silence holds until the next serve", async () => {
    const host = new FakeMusicHost();
    const controller = await readyController(host);

    controller.observe(report({ served: true }));
    controller.update("play", null);
    controller.observe(report({ justTilted: true }));
    controller.update("play", null);
    // The tilt jingle: play-once, no loop.
    expect(controller.output.stream?.restartMs).toBeNull();

    // The next ball's serve brings the vamp back.
    controller.observe(report({ drained: [0] }));
    controller.observe(report({ served: true }));
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(FIXTURE_VAMP_MS);
  });

  it("leaving the table phases stops the music dead", async () => {
    const host = new FakeMusicHost();
    const controller = await readyController(host);
    controller.observe(report({ served: true }));
    controller.update("play", null);
    expect(controller.output.playing).toBe(true);
    controller.update("game-over", null);
    expect(controller.output.playing).toBe(false);
    // Quit-confirm is a table phase: music through the question.
    controller.observe(report({ served: true }));
    controller.update("play", null);
    controller.update("quit-confirm", null);
    expect(controller.output.playing).toBe(true);
  });

  it("holds channel 3 at zero exactly while an effect is sounding", async () => {
    const host = new FakeMusicHost();
    const controller = await readyController(host);
    controller.observe(report({ served: true }));
    host.currentTime = 1;
    controller.update("play", effectsBank(1.5));
    expect(controller.output.channelLevels[3]).toBe(0);
    host.currentTime = 1.6;
    controller.update("play", effectsBank(1.5));
    expect(controller.output.channelLevels[3]).toBe(1);
  });
});

describe("the channel bus", () => {
  it("ducks through its own gain so scheduled volumes cannot overwrite it", () => {
    const host = new FakeMusicHost();
    const output = createTrackerOutput(() => host);
    startTracker(output, { commands: [], durationMs: 100, restartMs: null });
    // 1 master + 4 channel buses.
    expect(host.gains).toBe(5);
    setTrackerChannelLevel(output, 3, 0);
    expect(output.channelLevels[3]).toBe(0);
    setTrackerChannelLevel(output, 3, 1);
    expect(output.channelLevels[3]).toBe(1);
  });
});
