/**
 * THE IN-GAME MUSIC, loaded as a gated asset and cut into playable sections.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * Every table package carries its own music: the two `SNT!` banks at
 * descriptor +$74/+$78 are full modules — order lists, packed patterns, PCM —
 * played by the same replayer as the front end through its alternate entry at
 * main.seg00 $7A24. `scripts/export-table-music.mjs` decodes them into
 * `public/generated/tables/<table>.music.json` plus one 8-bit WAV per live
 * instrument, under the `disk-derived-table-music` gate class, and carries
 * the engine's decoded CUE RECORDS besides. This module fetches all of it and
 * hands back what the browser controller plays with:
 *
 *   songs      one `TrackerSong` per bank
 *   voices     per bank: instrument number -> the bank's own voice id
 *   bank       an `InstrumentBank` over both banks' WAV PCM
 *   cues       the decoded {command, position, bank} records
 *   sections   `sectionStream(...)`, the section renderer below
 *
 * ---------------------------------------------------------------------------
 * WHY SECTIONS AND NOT ONE STREAM
 * ---------------------------------------------------------------------------
 * A table module is not one tune: it is a SUITE addressed by order position.
 * Position 0 is a short vamp that loops on itself (`B00` at its end) while
 * the ball waits on the plunger; position 1 opens the main play loop (its
 * closing `Bxx` loops back to it); further positions hold the mode,
 * game-over, fanfare and stop sections the engine's kind-4 cue records enter
 * by number. The stop sections end in `F00`, which in the shell build HALTS
 * the player ($883A sets the stop flag $21C) — that is the tilt silence on
 * the films, and it is the one place this renderer deviates from the pure
 * core, whose `F00` (the intro build's reading) races on instead of halting.
 *
 * `sectionStream` therefore steps the core itself:
 *
 *   - a pass ends when any order position is ENTERED A SECOND TIME (row 0,
 *     tick 0); that covers the `B00` self-loop, a backwards `Bxx` and the
 *     end-of-list wrap with one rule, and `restartMs` is the first entry
 *     time of the position the loop re-enters — for every section shipped
 *     that is 0, and the tests pin it;
 *   - an `F00` ends the stream dead: the F00 row's own tick sounds (the
 *     machine plays that row and silences on the next frame's stop-flag
 *     check at $7D74/$7CC2) and then every channel is stopped; `restartMs`
 *     is null — a stopped section does not loop.
 *
 * SIM ISOLATION, unchanged: pure data in, pure data out, no Web Audio, no
 * clock, no I/O. Silence is a correct outcome for every failure path.
 */

import type { TrackerCell, TrackerInstrument, TrackerPattern, TrackerSong } from "./tracker.js";
import {
  ROWS_PER_PATTERN,
  TRACKER_CHANNELS,
  createTrackerPlayer,
  stepTracker,
  tickDurationSeconds,
  validateTrackerSong,
} from "./tracker.js";
import { chipInstrumentFromWav } from "./shell-music.js";
import type { ChipInstrument } from "./instruments.js";
import type {
  InstrumentBank,
  TrackerCommand as StreamCommand,
  TrackerCommandStream,
} from "./tracker-output.js";

/** The document `export-table-music.mjs` writes. */
export const TABLE_MUSIC_SCHEMA = "pinball-illusions/table-music/v1";

/** Where the manifests and WAVs live; the sound effects' own base path. */
export const TABLE_MUSIC_BASE_PATH = "generated/tables/";

/**
 * The bank's id for a disk voice. Namespaced BY BANK: bank 0's instrument 5
 * and bank 1's instrument 5 are different PCM, and the output layer caches
 * buffers by this id.
 */
export function tableVoiceId(bank: number, instrument: number): string {
  return `disk-t${bank}-${instrument}`;
}

/** One decoded engine cue record: what $6868 would post to the mailbox. */
export interface TableMusicCue {
  readonly command: number;
  readonly position: number;
  readonly bank: number;
}

export interface TableMusicAsset {
  readonly tableId: string;
  readonly songs: readonly [TrackerSong, TrackerSong];
  readonly voices: readonly [Readonly<Record<number, string>>, Readonly<Record<number, string>>];
  readonly bank: InstrumentBank;
  readonly cues: {
    /** Serve/plunger vamp: position 0, a self-looping bar or two. */
    readonly vamp: TableMusicCue;
    /** The main play loop, entered from position 1. */
    readonly main: TableMusicCue;
    /** Ball start (-2/0/0): the engine's $49BE/$4FC4 sites. */
    readonly ballStart: TableMusicCue;
    /** Queue-main (-1/1/0): launch and ball end. */
    readonly queueMain: TableMusicCue;
    /**
     * The tilt cue ($4E32, phase 8 — the tilted state): a jingle ending in
     * F00, the player stop. Its decoded length is the filmed tilt-to-silence
     * gap on every filmed tilt.
     */
    readonly tilt: TableMusicCue;
    /** Decoded but not yet driven: the shell owns these screens today. */
    readonly gameOver: TableMusicCue;
    readonly highScore: TableMusicCue;
    /** The end-of-ball bonus routine's stop record; unwired, see exporter. */
    readonly endStop: TableMusicCue;
  };
}

/** The minimum a fetch has to look like; `shell-music.ts` uses the same. */
export type TableMusicFetch = (url: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

interface RawDescriptor {
  readonly index: number;
  readonly lengthWords: number;
  readonly finetune: number;
  readonly volume: number;
  readonly repeatWords: number;
  readonly repeatLengthWords: number;
}

interface RawBank {
  readonly index: number;
  readonly songLength: number;
  readonly restart: number;
  readonly orders: readonly number[];
  readonly instruments: readonly RawDescriptor[];
  readonly patternCells: number;
  readonly patterns: readonly (readonly number[])[];
}

interface RawDocument {
  readonly schema: string;
  readonly tableId: string;
  readonly banks: readonly RawBank[];
  readonly cues: Readonly<Record<string, { command: number; position: number; bank: number }>>;
  readonly samples: readonly {
    readonly bank: number;
    readonly instrument: number;
    readonly file: string;
  }[];
}

function fail(what: string): never {
  throw new Error(`table music: ${what}`);
}

function parseBankSong(raw: RawBank, tableId: string): {
  readonly song: TrackerSong;
  readonly voices: Readonly<Record<number, string>>;
  readonly descriptors: readonly RawDescriptor[];
} {
  if (!Array.isArray(raw.orders) || raw.orders.length !== raw.songLength || raw.songLength === 0) {
    fail(`bank ${raw.index}: order list is ${raw.orders?.length} against song length ${raw.songLength}`);
  }
  if (!Array.isArray(raw.patterns) || raw.patterns.length === 0) fail(`bank ${raw.index}: no patterns`);
  if (raw.patternCells !== 4) fail(`bank ${raw.index}: cells are ${raw.patternCells} numbers, not 4`);
  if (!Array.isArray(raw.instruments) || raw.instruments.length !== 31) {
    fail(`bank ${raw.index}: instrument directory is ${raw.instruments?.length} long, not 31`);
  }

  const patterns: TrackerPattern[] = [];
  for (const [at, flat] of raw.patterns.entries()) {
    const wanted = ROWS_PER_PATTERN * TRACKER_CHANNELS * 4;
    if (flat.length !== wanted) fail(`bank ${raw.index} pattern ${at} has ${flat.length} numbers, not ${wanted}`);
    const rows: TrackerCell[][] = [];
    for (let row = 0; row < ROWS_PER_PATTERN; row += 1) {
      const cells: TrackerCell[] = [];
      for (let channel = 0; channel < TRACKER_CHANNELS; channel += 1) {
        const base = (row * TRACKER_CHANNELS + channel) * 4;
        cells.push({
          note: flat[base] as number,
          instrument: flat[base + 1] as number,
          effect: flat[base + 2] as number,
          param: flat[base + 3] as number,
        });
      }
      rows.push(cells);
    }
    patterns.push(rows);
  }

  const used = new Set<number>();
  for (const pattern of patterns) {
    for (const row of pattern) {
      for (const cell of row) if (cell.instrument !== 0) used.add(cell.instrument);
    }
  }
  const instruments: TrackerInstrument[] = [];
  const voices: Record<number, string> = {};
  for (const descriptor of raw.instruments) {
    if (!used.has(descriptor.index)) continue;
    instruments.push({
      id: descriptor.index,
      finetune: descriptor.finetune,
      volume: descriptor.volume,
    });
    voices[descriptor.index] = tableVoiceId(raw.index, descriptor.index);
  }

  const song = validateTrackerSong({
    title: `${tableId} music bank ${raw.index}`,
    // The replayer writes speed 6 on every song start ($7B08); one tick is
    // one PAL field and 125 names that constant. See `tracker.ts`.
    initialSpeed: 6,
    initialTempo: 125,
    // The bank's restart byte is ProTracker's unused 127; running off the
    // order list wraps to position 0 ($8138-$814A).
    restart: 0,
    orders: raw.orders,
    patterns,
    instruments,
  });
  return { song, voices, descriptors: raw.instruments };
}

/** The document, checked field by field; shape mirrors the shell loader. */
export function parseTableMusicDocument(doc: unknown): {
  readonly tableId: string;
  readonly songs: readonly [TrackerSong, TrackerSong];
  readonly voices: readonly [Readonly<Record<number, string>>, Readonly<Record<number, string>>];
  readonly descriptors: readonly (readonly RawDescriptor[])[];
  readonly files: readonly { readonly bank: number; readonly instrument: number; readonly file: string }[];
  readonly cues: TableMusicAsset["cues"];
} {
  const raw = doc as RawDocument | null;
  if (raw === null || typeof raw !== "object") fail("document is not an object");
  if (raw.schema !== TABLE_MUSIC_SCHEMA) fail(`unknown schema ${String(raw.schema)}`);
  if (typeof raw.tableId !== "string" || raw.tableId.length === 0) fail("no tableId");
  if (!Array.isArray(raw.banks) || raw.banks.length !== 2) {
    fail(`expected exactly 2 banks, got ${raw.banks?.length}`);
  }
  const parsed = raw.banks.map((bank, at) => {
    if (bank.index !== at) fail(`bank ${at} declares index ${bank.index}`);
    return parseBankSong(bank, raw.tableId);
  });

  const cueNames = [
    "vamp",
    "main",
    "ballStart",
    "queueMain",
    "tilt",
    "gameOver",
    "highScore",
    "endStop",
  ] as const;
  const cues: Record<string, TableMusicCue> = {};
  for (const name of cueNames) {
    const cue = raw.cues?.[name];
    if (cue === undefined) fail(`cue ${name} missing`);
    const { command, position, bank } = cue;
    if (!Number.isInteger(command)) fail(`cue ${name} command ${String(command)}`);
    if (!Number.isInteger(bank) || bank < 0 || bank > 1) fail(`cue ${name} bank ${String(bank)}`);
    const songLength = raw.banks[bank]?.songLength ?? 0;
    if (!Number.isInteger(position) || position < 0 || position >= songLength) {
      fail(`cue ${name} position ${String(position)} outside bank ${bank}'s ${songLength} orders`);
    }
    cues[name] = { command, position, bank };
  }

  const files: { bank: number; instrument: number; file: string }[] = [];
  for (const sample of raw.samples ?? []) {
    if (typeof sample.file !== "string") fail("sample without a file");
    if (sample.bank !== 0 && sample.bank !== 1) fail(`sample ${sample.file} bank ${String(sample.bank)}`);
    files.push({ bank: sample.bank, instrument: sample.instrument, file: sample.file });
  }
  if (files.length === 0) fail("no samples");

  const first = parsed[0];
  const second = parsed[1];
  if (first === undefined || second === undefined) fail("bank parse failed");
  return {
    tableId: raw.tableId,
    songs: [first.song, second.song],
    voices: [first.voices, second.voices],
    descriptors: [first.descriptors, second.descriptors],
    files,
    cues: cues as unknown as TableMusicAsset["cues"],
  };
}

// ---------------------------------------------------------------------------
// Section rendering
// ---------------------------------------------------------------------------

/** A hard stop against a section that neither loops nor F00s. */
const MAX_TICKS_PER_SECTION = 1_000_000;

/**
 * Renders one SECTION of a bank as a timed command stream: from `entry` until
 * the position loops (a pass, `restartMs` set) or an `F00` halts the player
 * (`restartMs` null, channel stops appended). See the module header for why
 * the F00 rule lives here and not in the core.
 */
export function sectionStream(
  song: TrackerSong,
  voices: Readonly<Record<number, string>>,
  entry: number,
): TrackerCommandStream {
  const player = createTrackerPlayer(song, entry);
  const commands: StreamCommand[] = [];
  let elapsedMs = 0;
  const enteredMs = new Map<number, number>();
  enteredMs.set(player.order, 0);

  for (let guard = 0; ; guard += 1) {
    if (guard > MAX_TICKS_PER_SECTION) {
      throw new Error(`section at order ${entry} of "${song.title}" never looped or stopped`);
    }

    for (const command of stepTracker(player)) {
      switch (command.action) {
        case "trigger": {
          const voice = voices[command.instrument];
          if (voice === undefined) {
            throw new Error(`"${song.title}" instrument ${command.instrument} has no voice`);
          }
          commands.push({
            kind: "note",
            timeMs: elapsedMs,
            channel: command.channel,
            instrument: voice,
            frequencyHz: command.frequencyHz,
            volume: command.volume,
            sampleOffsetBytes: command.sampleOffsetBytes,
          });
          break;
        }
        case "pitch":
          commands.push({
            kind: "pitch",
            timeMs: elapsedMs,
            channel: command.channel,
            frequencyHz: command.frequencyHz,
          });
          break;
        case "volume":
          commands.push({
            kind: "volume",
            timeMs: elapsedMs,
            channel: command.channel,
            volume: command.volume,
          });
          break;
      }
    }

    // The tick that just played lasts the CURRENT tick length - a speed
    // effect re-times the section from the row that set it. Same convention
    // as `renderSongStream`.
    elapsedMs += tickDurationSeconds(player) * 1000;

    // F00: the machine's stop flag. The row that carried it has sounded for
    // its one tick; the next frame's check silences everything ($7CC2).
    if (player.speed === 0) {
      for (let channel = 0; channel < TRACKER_CHANNELS; channel += 1) {
        commands.push({ kind: "stop", timeMs: elapsedMs, channel });
      }
      return { commands, durationMs: elapsedMs, restartMs: null };
    }

    if (player.row === 0 && player.tick === 0) {
      const before = enteredMs.get(player.order);
      if (before !== undefined) {
        // The pass is over: this position has played once already.
        return { commands, durationMs: elapsedMs, restartMs: before };
      }
      enteredMs.set(player.order, elapsedMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Fetches and assembles one table's music, or answers null — a build without
 * the authorized assets is a silent table, not a broken one.
 */
export async function loadTableMusic(
  tableId: string,
  fetcher: TableMusicFetch,
  base: string = TABLE_MUSIC_BASE_PATH,
): Promise<TableMusicAsset | null> {
  let parsed: ReturnType<typeof parseTableMusicDocument>;
  try {
    const response = await fetcher(`${base}${tableId}.music.json`);
    if (!response.ok) return null;
    const text = new TextDecoder().decode(await response.arrayBuffer());
    parsed = parseTableMusicDocument(JSON.parse(text));
  } catch {
    return null;
  }
  if (parsed.tableId !== tableId) return null;

  const instruments = new Map<string, ChipInstrument>();
  for (const file of parsed.files) {
    const descriptor = parsed.descriptors[file.bank]?.[file.instrument - 1];
    if (descriptor === undefined) return null;
    try {
      const response = await fetcher(`${base}${file.file}`);
      if (!response.ok) return null;
      const id = tableVoiceId(file.bank, file.instrument);
      const voice = chipInstrumentFromWav(id, await response.arrayBuffer(), descriptor);
      if (voice === null) return null;
      instruments.set(id, voice);
    } catch {
      return null;
    }
  }
  if (instruments.size === 0) return null;

  return {
    tableId: parsed.tableId,
    songs: parsed.songs,
    voices: parsed.voices,
    bank: (id) => instruments.get(id) ?? null,
    cues: parsed.cues,
  };
}
