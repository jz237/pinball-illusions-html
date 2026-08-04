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
  modeCueKey,
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
import { createModeState, queueScript, tickModes } from "../src/game/mode-vm.js";
import { tableModesFor } from "../src/game/table-modes.js";
import type { TableModes } from "../src/game/table-modes.js";
import { modesFor } from "./table-fixtures.js";
import { registerTableModes } from "../src/game/table-modes.js";
import type { TableId } from "../src/game/contracts.js";

/** The shipped mission layer for one table, registered on first use. */
function tableModesForTest(tableId: string): TableModes {
  registerTableModes(modesFor(tableId as TableId));
  const modes = tableModesFor(tableId as TableId);
  if (modes === null) throw new Error(`${tableId} has no mission layer`);
  return modes;
}

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
// The kind-4 census and the record -> firing-site map
// ---------------------------------------------------------------------------

/**
 * THE WHOLE KIND-4 POPULATION, and where each record is fired from. Every
 * relocated pointer at a kind-4 record in each package is classified by the
 * exporter into one of six paths, and the exporter REFUSES a package with a
 * pointer it cannot place — so these counts are a census, not a sample:
 *
 *   descriptor     the five registered cues, block-copied at $32F6
 *   ball-end       the bonus routine's own `lea` operand (descriptor +$80 +2)
 *   mission-op19   the mission VM's music opcode, handler $5B3E
 *   element        an element record's +$0C / +$10 sound slot
 *   display-op10   the display/anim VM's play-record opcode, handler $6940
 *   table-code     the table's own 68k (BabeWatch's jukebox)
 *
 * The digests pin the mode-cue table itself, so a change to the decode has to
 * be deliberate.
 */
const CENSUS = [
  {
    tableId: "law-n-justice",
    records: 43,
    sites: 88,
    byPath: { descriptor: 4, "mission-op19": 32, "ball-end": 1, "display-op10": 51 },
    modeCues: 32,
    modeCueDigest: "a30fe410b227a9eddbd4eedc86d2bb7fecba6f9575bf69ecb9fd64b2647d060c",
    distinctSections: 17,
    byCommand: { "-2": 22, "-1": 4, "2": 6 },
    elementCues: [] as { element: number; field: string; command: number; position: number; bank: number }[],
  },
  {
    tableId: "babewatch",
    records: 38,
    sites: 84,
    byPath: {
      descriptor: 4,
      "mission-op19": 27,
      "ball-end": 1,
      "display-op10": 45,
      element: 1,
      "table-code": 6,
    },
    modeCues: 27,
    modeCueDigest: "9bfa4172d0754280839dd6f0759ea138b055ebad66244292c4c333ca66b28ede",
    distinctSections: 11,
    byCommand: { "-2": 23, "-1": 2, "2": 2 },
    elementCues: [{ element: 67, field: "start", command: 2, position: 18, bank: 1 }],
  },
  {
    tableId: "extreme-sports",
    records: 38,
    sites: 81,
    byPath: { descriptor: 4, "mission-op19": 32, "ball-end": 1, "display-op10": 44 },
    modeCues: 32,
    modeCueDigest: "1e92f7bd7a20d04a4be755154d43338e7ba8b08c2840b222671e3c241d2ad5a2",
    distinctSections: 12,
    byCommand: { "-2": 30, "-1": 2 },
    elementCues: [] as { element: number; field: string; command: number; position: number; bank: number }[],
  },
] as const;

/** The mission VM's music opcode. Handler main.seg00 $5B3E; see mode-vm.ts. */
const OP_MUSIC = 19;

describe.runIf(exported)("the kind-4 census and the record -> site map", () => {
  it("classifies every music-record pointer, table by table", () => {
    for (const table of CENSUS) {
      const raw = JSON.parse(
        readFileSync(`${TABLES_DIR}${table.tableId}.music.json`, "utf8"),
      ) as {
        census: { records: number; sites: number; byPath: Record<string, number> };
        modeCues: readonly { script: number; pc: number; command: number; position: number; bank: number }[];
        elementCues: readonly { element: number; field: string; command: number; position: number; bank: number }[];
      };
      expect(raw.census.records, `${table.tableId} records`).toBe(table.records);
      expect(raw.census.sites, `${table.tableId} sites`).toBe(table.sites);
      expect(raw.census.byPath, `${table.tableId} paths`).toEqual(table.byPath);
      // The site counts have to add up to the pointer count: no pointer is
      // classified twice and none is dropped.
      const total = Object.values(raw.census.byPath).reduce((sum, n) => sum + n, 0);
      expect(total, `${table.tableId} paths sum`).toBe(table.sites);

      expect(raw.modeCues.length, `${table.tableId} mode cues`).toBe(table.modeCues);
      expect(
        createHash("sha256").update(JSON.stringify(raw.modeCues)).digest("hex"),
        `${table.tableId} mode-cue digest`,
      ).toBe(table.modeCueDigest);
      expect(raw.elementCues, `${table.tableId} element cues`).toEqual(table.elementCues);

      const byCommand: Record<string, number> = {};
      for (const cue of raw.modeCues) {
        byCommand[String(cue.command)] = (byCommand[String(cue.command)] ?? 0) + 1;
      }
      expect(byCommand, `${table.tableId} mode-cue commands`).toEqual(table.byCommand);
      const sections = new Set(raw.modeCues.map((cue) => `${cue.bank}:${cue.position}`));
      expect(sections.size, `${table.tableId} distinct mode sections`).toBe(table.distinctSections);
    }
  });

  it("every mode cue names an opcode-19 instruction of the shipped modes document", () => {
    for (const table of CENSUS) {
      const music = JSON.parse(
        readFileSync(`${TABLES_DIR}${table.tableId}.music.json`, "utf8"),
      ) as { modeCues: readonly { script: number; pc: number }[] };
      const modes = JSON.parse(readFileSync(`${TABLES_DIR}${table.tableId}.modes.json`, "utf8")) as {
        opcodes: readonly { index: number; name: string }[];
        scripts: readonly { index: number; ops: readonly { pc: number; op: number }[] }[];
      };
      // The join is only sound if both documents number their scripts the same
      // way, which is why the music exporter imports the modes decoder.
      expect(modes.opcodes[OP_MUSIC]?.name).toBe("MUSIC");
      for (const cue of music.modeCues) {
        const script = modes.scripts[cue.script];
        expect(script, `${table.tableId} script ${cue.script}`).toBeDefined();
        const op = script?.ops.find((one) => one.pc === cue.pc);
        expect(op, `${table.tableId} ${modeCueKey(cue.script, cue.pc)}`).toBeDefined();
        expect(op?.op, `${table.tableId} ${modeCueKey(cue.script, cue.pc)} opcode`).toBe(OP_MUSIC);
      }
      // ...and every opcode-19 instruction in the whole document has a cue: an
      // unmapped one would be a music switch the runtime silently drops.
      const keyed = new Set(music.modeCues.map((cue) => modeCueKey(cue.script, cue.pc)));
      for (const script of modes.scripts) {
        for (const op of script.ops) {
          if (op.op !== OP_MUSIC) continue;
          expect(keyed.has(modeCueKey(script.index, op.pc)), `${table.tableId} ${script.index}:${op.pc}`).toBe(true);
        }
      }
    }
  });

  it("every cue renders a section, and the mode backgrounds loop", async () => {
    for (const table of CENSUS) {
      const asset = await shipped(table.tableId);
      for (const [key, cue] of asset.modeCues) {
        const stream = asset.section(cue.bank, cue.position);
        expect(stream, `${table.tableId} ${key}`).not.toBeNull();
        expect(stream?.commands.length, `${table.tableId} ${key} commands`).toBeGreaterThan(0);
        // A -2 or -1 names a background, and a background has to loop or the
        // mode would fall silent partway through; only an override (> 0) is
        // allowed to end in an F00.
        if (cue.command < 0) {
          expect(stream?.restartMs, `${table.tableId} ${key} loop point`).not.toBeNull();
        }
      }
      for (const cue of asset.elementCues.start.values()) {
        expect(asset.section(cue.bank, cue.position)).not.toBeNull();
      }
      for (const cue of asset.elementCues.award.values()) {
        expect(asset.section(cue.bank, cue.position)).not.toBeNull();
      }
    }
  });

  it("the section cache answers the same stream twice, and null off the end", async () => {
    const asset = await shipped("babewatch");
    const one = asset.section(0, 57);
    expect(one).not.toBeNull();
    expect(asset.section(0, 57)).toBe(one);
    expect(asset.section(0, 999)).toBeNull();
    expect(asset.section(0, -1)).toBeNull();
  });

  /**
   * THE JOIN, END TO END, on the real documents: every mission the selector
   * offers opens by switching the background and closes by putting the main
   * tune back, and the mode VM run on the shipped scripts fires exactly those
   * sites. This is the test that would fail if the two manifests' script
   * numbering ever drifted apart.
   */
  it("running each shipped mission fires its own background switch", async () => {
    for (const table of CENSUS) {
      const asset = await shipped(table.tableId);
      const modes = tableModesForTest(table.tableId);
      const carriers = new Set<number>();
      for (const key of asset.modeCues.keys()) carriers.add(Number(key.split(":")[0]));

      let switched = 0;
      for (const script of carriers) {
        const state = createModeState(modes);
        queueScript(state, script);
        const fired: string[] = [];
        for (let tick = 0; tick < 600; tick += 1) {
          for (const site of tickModes(modes, state).musicCues) {
            fired.push(modeCueKey(site.script, site.pc));
          }
        }
        for (const key of fired) {
          const cue = asset.modeCues.get(key);
          expect(cue, `${table.tableId} ${key} fired with no cue`).toBeDefined();
          expect(asset.section(cue?.bank ?? 0, cue?.position ?? -1)).not.toBeNull();
        }
        if (fired.length > 0) switched += 1;
      }
      // Most carriers reach their own opcode when run head-on; the ones that
      // do not are gated on state a bare queue does not set up. The floor is
      // what stops the wiring silently going dead.
      expect(switched, `${table.tableId} carriers that fired`).toBeGreaterThanOrEqual(
        Math.ceil(carriers.size * 0.75),
      );
    }
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
 * queued-switch behaviour is observable — order 1 stops via F00, and order 2
 * self-loops via a B02 at row 20 (a 2520 ms lap) so a MODE BACKGROUND and an
 * OVERRIDE have a section of their own to be told apart by.
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
  const pattern2 = rows([
    [CELL(19, 1, 0, 0), EMPTY, EMPTY, EMPTY],
    ...Array.from({ length: 19 }, () => [EMPTY, EMPTY, EMPTY, EMPTY]),
    [EMPTY, EMPTY, EMPTY, CELL(0, 0, 0xb, 0x02)],
  ]);
  return {
    title: "table music fixture",
    initialSpeed: 6,
    initialTempo: 125,
    restart: 0,
    orders: [0, 1, 2],
    patterns: [pattern0, pattern1, pattern2],
    instruments: [{ id: 1, finetune: 0, volume: 64 }],
  };
}

/** The fixture vamp's lap: rows 0..40 at speed 6, in milliseconds. */
const FIXTURE_VAMP_MS = 41 * 6 * 20;
/** The fixture mode/override section's lap: rows 0..20 at speed 6. */
const FIXTURE_MODE_MS = 21 * 6 * 20;

/**
 * The fixture's mode-cue table, one site per command the machine has. Keyed
 * `script:pc` exactly as the shipped manifests are.
 */
const FIXTURE_MODE_CUES = [
  { script: 5, pc: 10, command: -2, position: 2, bank: 0 },
  { script: 5, pc: 20, command: -1, position: 2, bank: 0 },
  { script: 7, pc: 0, command: 2, position: 2, bank: 1 },
];
const FIXTURE_ELEMENT_CUES = [
  { element: 3, field: "award", command: 2, position: 2, bank: 1 },
];

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
    songLength: 3,
    restart: 127,
    orders: [0, 1, 2],
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
    modeCues: FIXTURE_MODE_CUES,
    elementCues: FIXTURE_ELEMENT_CUES,
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
    musicCues: [],
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

  it("leaving the table phases stops the music dead, and the game-over walk is not leaving", async () => {
    const host = new FakeMusicHost();
    const controller = await readyController(host);
    controller.observe(report({ served: true }));
    controller.update("play", null);
    expect(controller.output.playing).toBe(true);
    // The MENU is leaving the table: the shell's own module owns it.
    controller.update("menu", null);
    expect(controller.output.playing).toBe(false);
    // Quit-confirm is a table phase: music through the question.
    controller.observe(report({ served: true }));
    controller.update("play", null);
    controller.update("quit-confirm", null);
    expect(controller.output.playing).toBe(true);
    // AND SO ARE THE FOUR GAME-OVER SCREENS, which are the in-game machine's
    // states 2 and 0. It posts the table's own +$8C on entering the walk and
    // nothing at all on the way into the attract, so the table's module plays
    // right through them; only going back to the front end stops it.
    for (const phase of ["game-over", "fanfare", "initials", "ladder"] as const) {
      controller.update(phase, null);
      expect(controller.output.playing, phase).toBe(true);
    }
    controller.update("attract", null);
    expect(controller.output.playing).toBe(false);
  });

  it("a mode cue's -2 switches the background at once, and it persists", async () => {
    const host = new FakeMusicHost();
    const controller = await readyController(host);

    controller.observe(report({ served: true }));
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(FIXTURE_VAMP_MS);

    // The mission's opening MUSIC opcode: -2 into its own section. $7DD2
    // promotes the background slot on the spot, no boundary involved.
    host.currentTime = 1;
    controller.observe(report({ musicCues: [{ script: 5, pc: 10 }] }));
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(FIXTURE_MODE_MS);
    expect(controller.output.startContextTime).toBeCloseTo(1, 10);

    // It persists across ticks that say nothing.
    host.currentTime = 2;
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(FIXTURE_MODE_MS);
    expect(controller.output.startContextTime).toBeCloseTo(1, 10);
  });

  it("an override saves the background and restores it at its Bxx, where it was", async () => {
    const host = new FakeMusicHost();
    const controller = await readyController(host);

    controller.observe(report({ served: true }));
    controller.update("play", null);
    const vamp = controller.output.stream;

    // One second into the vamp, an override sting (command 2). $815E saves
    // the whole song state; the override starts now.
    host.currentTime = 1;
    controller.observe(report({ musicCues: [{ script: 7, pc: 0 }] }));
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(FIXTURE_MODE_MS);
    expect(controller.output.startContextTime).toBeCloseTo(1, 10);

    // Nothing happens until the override's own Bxx comes inside the lookahead.
    host.currentTime = 2;
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(FIXTURE_MODE_MS);

    // At the Bxx ($8860 -> $821C) the background comes back — and it comes
    // back ONE SECOND IN, where it was interrupted, not at its start.
    const boundary = 1 + FIXTURE_MODE_MS / 1000;
    host.currentTime = boundary - 0.2;
    controller.update("play", null);
    expect(controller.output.stream).toBe(vamp);
    expect(controller.output.startContextTime).toBeCloseTo(boundary - 1, 10);
  });

  it("a nested override does not re-save: the sting still returns to the background", async () => {
    const host = new FakeMusicHost();
    const controller = await readyController(host);
    controller.observe(report({ served: true }));
    controller.update("play", null);
    const vamp = controller.output.stream;

    host.currentTime = 1;
    controller.observe(report({ musicCues: [{ script: 7, pc: 0 }] }));
    controller.update("play", null);
    // A second override half a second later: $815E's `tst.b $21a / bne` skips
    // the save, so the interrupted BACKGROUND is still what returns.
    host.currentTime = 1.5;
    controller.observe(report({ musicCues: [{ script: 7, pc: 0 }] }));
    controller.update("play", null);
    const boundary = 1.5 + FIXTURE_MODE_MS / 1000;
    host.currentTime = boundary - 0.2;
    controller.update("play", null);
    expect(controller.output.stream).toBe(vamp);
    expect(controller.output.startContextTime).toBeCloseTo(boundary - 1, 10);
  });

  it("a -2 while an override is sounding only retargets what it returns to", async () => {
    const host = new FakeMusicHost();
    const controller = await readyController(host);
    controller.observe(report({ served: true }));
    controller.update("play", null);

    host.currentTime = 1;
    controller.observe(report({ musicCues: [{ script: 7, pc: 0 }] }));
    controller.update("play", null);
    const override = controller.output.stream;

    // $7DD2's `tst.b $21a / bne`: the background slot moves, the override
    // keeps sounding, and the return lands on the NEW section from a clean
    // start ($81B0 wipes the saved channel block).
    host.currentTime = 1.2;
    controller.observe(report({ musicCues: [{ script: 5, pc: 10 }] }));
    controller.update("play", null);
    expect(controller.output.stream).toBe(override);

    const boundary = 1 + FIXTURE_MODE_MS / 1000;
    host.currentTime = boundary - 0.2;
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(FIXTURE_MODE_MS);
    expect(controller.output.startContextTime).toBeCloseTo(boundary, 10);
  });

  it("a queued mode cue lands on the current section's boundary, not before", async () => {
    const host = new FakeMusicHost();
    const controller = await readyController(host);
    controller.observe(report({ served: true }));
    controller.update("play", null);
    const vamp = controller.output.stream;
    const lap = FIXTURE_VAMP_MS / 1000;

    host.currentTime = 0.5;
    controller.observe(report({ musicCues: [{ script: 5, pc: 20 }] }));
    controller.update("play", null);
    expect(controller.output.stream).toBe(vamp); // still the vamp

    host.currentTime = lap - 0.2;
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(FIXTURE_MODE_MS);
    expect(controller.output.startContextTime).toBeCloseTo(lap, 10);
  });

  it.runIf(exported)("switches a real table's background on a real mission's cue", async () => {
    // End to end on the shipped documents: BabeWatch's four JACKPOT/TIME
    // missions all open with `-2 pos 57` (script 120 pc 42 is one of them),
    // and all of them close with `-2 pos 1` back to the main tune.
    const host = new FakeMusicHost();
    const controller = createTableMusic(() => host, (url) => diskFetch(`generated/tables/${url.slice(url.lastIndexOf("/") + 1)}`));
    controller.select("babewatch");
    await new Promise((settle) => setTimeout(settle, 0));

    const asset = await shipped("babewatch");
    const vamp = asset.section(0, 0);
    const mode = asset.section(0, 57);
    const main = asset.section(0, 1);
    expect(vamp).not.toBeNull();
    expect(mode).not.toBeNull();

    controller.observe(report({ served: true }));
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(vamp?.durationMs);

    host.currentTime = 1;
    controller.observe(report({ musicCues: [{ script: 120, pc: 42 }] }));
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(mode?.durationMs);

    host.currentTime = 2;
    controller.observe(report({ musicCues: [{ script: 120, pc: 114 }] }));
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(main?.durationMs);
  });

  it("a mode background survives a launch: only the serve section is queued away from", async () => {
    const host = new FakeMusicHost();
    const controller = await readyController(host);
    controller.observe(report({ served: true }));
    controller.update("play", null);

    // A mission switches the background while the ball is still on the rod.
    host.currentTime = 1;
    controller.observe(report({ musicCues: [{ script: 5, pc: 10 }] }));
    controller.update("play", null);
    const mode = controller.output.stream;
    expect(mode?.durationMs).toBe(FIXTURE_MODE_MS);

    // The launch's queue-main is a RECONSTRUCTION anchored on the vamp; with
    // the mode section up it must not fire, or a mission would lose its music
    // the moment the next ball went out.
    host.currentTime = 1.5;
    controller.observe(report({ launched: true }));
    host.currentTime = 1 + FIXTURE_MODE_MS / 1000 - 0.2;
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(FIXTURE_MODE_MS);
  });

  it("an element's award sound slot fires when the mode VM awards it", async () => {
    const host = new FakeMusicHost();
    const controller = await readyController(host);
    controller.observe(report({ served: true }));
    controller.update("play", null);
    host.currentTime = 1;
    controller.observe(report({ elementAwards: [3] }));
    controller.update("play", null);
    expect(controller.output.stream?.durationMs).toBe(FIXTURE_MODE_MS);
    // An element with no cue changes nothing.
    const sounding = controller.output.stream;
    controller.observe(report({ elementAwards: [4], elementStarts: [3] }));
    controller.update("play", null);
    expect(controller.output.stream).toBe(sounding);
  });

  it("a ball end plays the end-stop section and the next serve brings the vamp back", async () => {
    const host = new FakeMusicHost();
    const controller = await readyController(host);
    controller.observe(report({ served: true }));
    controller.update("play", null);
    host.currentTime = 1;
    controller.observe(report({ launched: true }));

    // The drain runs the bonus routine, whose first instruction fires the
    // end-stop record: a -2 into a section that ends in F00.
    controller.observe(report({ drained: [0] }));
    controller.update("play", null);
    expect(controller.output.stream?.restartMs).toBeNull();

    // A multiball drain that leaves a ball in play is NOT a ball end.
    controller.observe(report({ served: true }));
    controller.observe(report({ served: true }));
    controller.update("play", null);
    const vamp = controller.output.stream;
    expect(vamp?.durationMs).toBe(FIXTURE_VAMP_MS);
    controller.observe(report({ drained: [0] }));
    controller.update("play", null);
    expect(controller.output.stream).toBe(vamp);
    // ...and the last one out is.
    controller.observe(report({ drained: [1] }));
    controller.update("play", null);
    expect(controller.output.stream?.restartMs).toBeNull();
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
