/**
 * THE FRONT-END MODULE, loaded as a gated asset and turned into a playable song.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT REPLACED WHAT
 * ---------------------------------------------------------------------------
 * `scripts/export-shell-music.mjs` decodes the `SNT!` bank in `intro.bin` — the
 * tune the attract/credits cycle plays, NOT the menu tune in `music001.bin`;
 * that exporter's header carries the measurement that settles which is which —
 * into `public/generated/shell/shell-music.json` plus one 8-bit WAV per live
 * instrument, all under the `disk-derived-shell-music` gate class. This module
 * fetches them and hands back three things the audio layer already understands:
 *
 *   song    a `TrackerSong` — the order list, the 37 patterns, the 31
 *           instrument descriptors' finetune and volume
 *   voices  instrument number -> the bank's own id for that voice
 *   bank    an `InstrumentBank`: id -> a `ChipInstrument` over the WAV's PCM
 *
 * It replaces `shell-song.ts`, a wholly new composition ("SILVER MIRAGE") that
 * was written under a project rule the operator has since reversed. That file
 * and its test are deleted rather than left in the tree: a dead composition
 * that nothing plays is worse than no composition, because the next reader
 * cannot tell which one is the real one.
 *
 * ---------------------------------------------------------------------------
 * HOW A PAULA SAMPLE BECOMES A ChipInstrument
 * ---------------------------------------------------------------------------
 * The tracker core emits `frequencyHz = 3546895 / period` — Paula's own output
 * RATE, not a musical pitch — and the output layer plays a buffer at
 * `frequencyHz / instrument.baseFrequency`. So a disk instrument sets
 * `baseFrequency = sampleRate`, and the playback rate comes out as
 * `wanted rate / buffer rate`, which is exactly what the hardware does.
 *
 * The loop window is the descriptor's own `repeatWords`/`repeatLengthWords`,
 * in bytes and therefore in samples: a descriptor whose repeat length is 1 word
 * is ProTracker's "no loop" and becomes a one-shot (`loopStart = -1`), which is
 * why instruments 2, 4, 7, 13, 18 and 28 fire once and the other 22 sustain.
 *
 * SILENCE IS A CORRECT OUTCOME. Every failure path here answers null: a build
 * without the authorized assets, a 404, a truncated WAV. The shell then runs
 * with no music, exactly as it does with no skin.
 */

import type { TrackerCell, TrackerInstrument, TrackerPattern, TrackerSong } from "./tracker.js";
import { ROWS_PER_PATTERN, TRACKER_CHANNELS, validateTrackerSong } from "./tracker.js";
import type { ChipInstrument } from "./instruments.js";
import type { InstrumentBank } from "./tracker-output.js";

/** The document `export-shell-music.mjs` writes. */
export const SHELL_MUSIC_SCHEMA = "pinball-illusions/shell-music/v1";

/** The bank's id for a disk instrument. Namespaced so it can never collide
 * with a synthesized `InstrumentId`. */
export function diskVoiceId(instrument: number): string {
  return `disk-${instrument}`;
}

export interface ShellMusicAsset {
  readonly song: TrackerSong;
  readonly voices: Readonly<Record<number, string>>;
  readonly bank: InstrumentBank;
  /** The instrument numbers that carry PCM, ascending. */
  readonly liveInstruments: readonly number[];
  /**
   * The order position the PROGRAM enters the module at — 17, not 0. The
   * replayer takes a start position in d0 ($79EA and intro.seg00's own copy),
   * so this is the program's choice rather than anything in the bank, and it
   * is measured off the cold-boot take: that recording is digitally silent for
   * 884 fields while the disk loads, and the silence ends on order 17's first
   * field. Orders 17 and 18 then correlate +0.9389 and +0.8758 waveform
   * against this render, and every order before 17 correlates at noise. See
   * the exporter's header for the whole measurement.
   */
  readonly startOrder: number;
}

/** The minimum a fetch has to look like; `table-art.ts` uses the same shape. */
export type ShellMusicFetch = (url: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  json?(): Promise<unknown>;
}>;

interface RawDescriptor {
  readonly index: number;
  readonly lengthWords: number;
  readonly finetune: number;
  readonly volume: number;
  readonly repeatWords: number;
  readonly repeatLengthWords: number;
}

interface RawDocument {
  readonly schema: string;
  readonly songLength: number;
  readonly restart: number;
  readonly startOrder: number;
  readonly orders: readonly number[];
  readonly instruments: readonly RawDescriptor[];
  readonly patternCells: number;
  readonly patterns: readonly (readonly number[])[];
  readonly samples: readonly { readonly instrument: number; readonly file: string }[];
}

function fail(what: string): never {
  throw new Error(`shell music: ${what}`);
}

/**
 * The document, checked field by field.
 *
 * Everything the exporter proved is re-proved here, because a shipped asset can
 * be edited after it is exported and the guard only checks digests of the media
 * beside it, not the shape of the JSON.
 */
export function parseShellMusicDocument(doc: unknown): {
  readonly song: TrackerSong;
  readonly voices: Readonly<Record<number, string>>;
  readonly descriptors: readonly RawDescriptor[];
  readonly files: Readonly<Record<number, string>>;
  readonly startOrder: number;
} {
  const raw = doc as RawDocument | null;
  if (raw === null || typeof raw !== "object") fail("document is not an object");
  if (raw.schema !== SHELL_MUSIC_SCHEMA) fail(`unknown schema ${String(raw.schema)}`);
  if (!Array.isArray(raw.orders) || raw.orders.length !== raw.songLength) {
    fail(`order list is ${raw.orders?.length} long against a song length of ${raw.songLength}`);
  }
  if (
    !Number.isInteger(raw.startOrder) ||
    raw.startOrder < 0 ||
    raw.startOrder >= raw.orders.length
  ) {
    fail(`start order ${String(raw.startOrder)} is outside the ${raw.orders.length}-order list`);
  }
  if (!Array.isArray(raw.patterns) || raw.patterns.length === 0) fail("no patterns");
  if (raw.patternCells !== 4) fail(`cells are ${raw.patternCells} numbers, not 4`);
  if (!Array.isArray(raw.instruments) || raw.instruments.length !== 31) {
    fail(`instrument directory is ${raw.instruments?.length} long, not 31`);
  }

  const patterns: TrackerPattern[] = [];
  for (const [at, flat] of raw.patterns.entries()) {
    const wanted = ROWS_PER_PATTERN * TRACKER_CHANNELS * 4;
    if (flat.length !== wanted) fail(`pattern ${at} has ${flat.length} numbers, not ${wanted}`);
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

  // Only the descriptors the patterns actually name become tracker
  // instruments: the validator refuses a note on an undeclared one, which is
  // the check that catches a document whose PCM and pattern data disagree.
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
    voices[descriptor.index] = diskVoiceId(descriptor.index);
  }

  const files: Record<number, string> = {};
  for (const sample of raw.samples ?? []) files[sample.instrument] = sample.file;

  const song = validateTrackerSong({
    title: "Pinball Illusions front end",
    // The replayer is VBlank-clocked at one tick a PAL field, and 6 is the
    // speed it writes on every song start ($7B08, intro.seg00 +$12D2) before
    // row 0 is fetched. The module's own `F` rows take over from there.
    initialSpeed: 6,
    initialTempo: 125,
    // `restart` is only what happens if the position runs off the END of the
    // order list, which $8138-$814A answers with position 0. The bank's own
    // restart byte is 127 against a song length of 54 — ProTracker's "unused"
    // marker, and out of range for the validator besides. The tune never gets
    // there: the `B13` on the last row of order 51 loops it back to order 19,
    // and `renderSongStream` measures that entry rather than reading it here.
    restart: 0,
    orders: raw.orders,
    patterns,
    instruments,
  });

  return { song, voices, descriptors: raw.instruments, files, startOrder: raw.startOrder };
}

/**
 * An 8-bit mono RIFF/WAVE as a `ChipInstrument`.
 *
 * Only the shape this project's own exporter writes is accepted: 44-byte
 * canonical header, PCM, one channel, 8 bits. Anything else is a null, because
 * a partial decode of an instrument is a wrong note rather than a missing one.
 */
export function chipInstrumentFromWav(
  id: string,
  bytes: ArrayBuffer,
  descriptor: RawDescriptor,
): ChipInstrument | null {
  const view = new DataView(bytes);
  if (view.byteLength < 44) return null;
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== "RIFF") return null;
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  const dataLength = view.getUint32(40, true);
  if (channels !== 1 || bits !== 8 || rate <= 0) return null;
  if (44 + dataLength > view.byteLength) return null;

  const samples = new Float32Array(dataLength);
  for (let i = 0; i < dataLength; i += 1) samples[i] = (view.getUint8(44 + i) - 128) / 128;

  // The descriptor's repeat window, in bytes and therefore in samples. A repeat
  // length of one word is ProTracker's "no loop".
  const looped = descriptor.repeatLengthWords > 1;
  const loopStart = looped ? Math.min(descriptor.repeatWords * 2, dataLength) : -1;
  const loopEnd = looped
    ? Math.min((descriptor.repeatWords + descriptor.repeatLengthWords) * 2, dataLength)
    : -1;

  return {
    // `ChipInstrument.id` is typed to the synthesized union; a disk voice is
    // named by the bank's own id and nothing reads this field back.
    id: id as ChipInstrument["id"],
    samples,
    sampleRate: rate,
    // See the header: the core's `frequencyHz` IS a rate, so a rate here makes
    // `playbackRateFor` the ratio the hardware computes.
    baseFrequency: rate,
    cycleLength: 0,
    loopStart: looped && loopEnd > loopStart ? loopStart : -1,
    loopEnd: looped && loopEnd > loopStart ? loopEnd : -1,
  };
}

/**
 * Fetches and assembles the asset, or answers null.
 *
 * `base` is the directory the exporter wrote into, as a URL prefix — the same
 * argument `loadShellArt` takes, and for the same reason: the caller owns where
 * the build serves its assets from.
 */
export async function loadShellMusic(
  fetcher: ShellMusicFetch,
  base = "generated/shell/",
): Promise<ShellMusicAsset | null> {
  let parsed: ReturnType<typeof parseShellMusicDocument>;
  try {
    const response = await fetcher(`${base}shell-music.json`);
    if (!response.ok) return null;
    const text = new TextDecoder().decode(await response.arrayBuffer());
    parsed = parseShellMusicDocument(JSON.parse(text));
  } catch {
    return null;
  }

  const instruments = new Map<string, ChipInstrument>();
  const live: number[] = [];
  for (const descriptor of parsed.descriptors) {
    const file = parsed.files[descriptor.index];
    if (file === undefined) continue;
    try {
      const response = await fetcher(`${base}${file}`);
      if (!response.ok) return null;
      const voice = chipInstrumentFromWav(
        diskVoiceId(descriptor.index),
        await response.arrayBuffer(),
        descriptor,
      );
      if (voice === null) return null;
      instruments.set(diskVoiceId(descriptor.index), voice);
      live.push(descriptor.index);
    } catch {
      return null;
    }
  }
  if (instruments.size === 0) return null;

  return {
    song: parsed.song,
    voices: parsed.voices,
    bank: (id) => instruments.get(id) ?? null,
    liveInstruments: live,
    startOrder: parsed.startOrder,
  };
}
