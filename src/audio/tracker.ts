/**
 * A pure ProTracker-style replayer core, matching the decoded shell engine's
 * semantics (docs/DISK_ANALYSIS.md, "music001.bin — DECODED").
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * The original shell plays one SNT! module (DICE-repacked ProTracker) through
 * the player at main.seg00 $79EA: 4 channels, an order list into 64-row
 * patterns, per-row events of {note, instrument, effect, param}, tick-based
 * timing, and the standard 16-finetune x 36-note period table at $A198
 * (ft0 = 856..113). That FORMAT and ENGINE BEHAVIOUR is decoded functional
 * knowledge, and it is what this module implements.
 *
 * WHAT THIS FILE CONTAINS, AND WHAT IT DOES NOT. It is ENGINE ONLY: no pattern
 * data, no order list and no PCM is a literal anywhere in it. That is a
 * structural rule about where data lives, not a rights rule — the song IS the
 * original's, decoded from the operator's own disks by
 * `scripts/export-shell-music.mjs` and loaded at runtime as a gated asset under
 * the `disk-derived-shell-music` class, exactly like the artwork, the maps and
 * the sound effects.
 *
 * This header used to say the opposite: "the original's song ... must never
 * enter this file or any file that feeds it. The song this core will play is a
 * NEW composition on synthesized instruments." That rule has been REVERSED by
 * the operator and the stand-in composition is deleted. The synthesized
 * instrument bank in `instruments.ts` stays, because a bank is now a parameter
 * (see `song-stream.ts`) and the synthesized one is what a build with no
 * authorized assets falls back to.
 *
 * ---------------------------------------------------------------------------
 * PURITY — REPO LAW
 * ---------------------------------------------------------------------------
 * Audio never touches the simulation, and this core never touches the world:
 * no Web Audio types, no Date, no Math.random, no I/O. `stepTracker` is a
 * function of the player state alone; the same song stepped twice produces the
 * identical command stream, byte for byte, and the tests hash it to hold that
 * promise. Output is plain data — the browser layer downstream turns commands
 * into sound; node tests consume them directly.
 *
 * ---------------------------------------------------------------------------
 * EFFECT COVERAGE
 * ---------------------------------------------------------------------------
 * IMPLEMENTED (the practical subset the shell module's idiom needs):
 *   0 arpeggio            (xy: base / +x / +y semitones, table-clamped)
 *   1 portamento up       (period -= param per non-zero tick, clamps at 113)
 *   2 portamento down     (period += param per non-zero tick, clamps at 856)
 *   3 tone portamento     (slides toward the row's note, param is remembered)
 *   5 tone porta + volume slide
 *   A volume slide        (x up / y down per non-zero tick, clamps 0..64)
 *   B position jump       (order = param on row end; out of range goes to 0)
 *   C set volume          (tick 0, clamped to 64)
 *   D pattern break       (next order — or B's target — at row 10x + y)
 *   F set speed/tempo     (param < 0x20 is ticks/row, else BPM; F00 ignored)
 *
 *   4 vibrato             (sine table, depth/speed memory, per-tick)
 *   6 vibrato + volume slide
 *   9 sample offset       (start the note 256*param bytes in)
 *   E6 pattern loop       (E60 marks, E6x jumps back x times)
 *   EA/EB fine volume slide up/down (tick 0 only, once)
 *
 * ACCEPTED BUT IGNORED (valid in song data, note still triggers, no effect):
 *   7 tremolo, 8 (unused in PT), and the E sub-commands other than 6, A and B.
 *   F00 — ProTracker halts; this player keeps the current speed, because the
 *   shell's music loops forever.
 *
 * The five that were added are the five the FRONT-END MODULE ACTUALLY USES:
 * a census of its 11 decoded patterns counts 4 x103, 6 x26, 9 x6, EA x94,
 * EB x48 and E6 x2, against 1 x24, 2 x1, 3 x13, A x35, B x1, C x183 and F x19
 * for the ones that were already here. Leaving them accepted-but-ignored would
 * have shipped an audible deviation on every bar that vibratos.
 */

// ---------------------------------------------------------------------------
// Constants of the machine
// ---------------------------------------------------------------------------

/** Paula's PAL master clock. frequencyHz = PAL_CLOCK / period. */
export const PAL_CLOCK = 3546895;

export const TRACKER_CHANNELS = 4;
export const ROWS_PER_PATTERN = 64;
export const NOTES_PER_FINETUNE = 36;

/** Slide clamps. ProTracker pins portamento inside 113..856 for every finetune. */
export const MIN_PERIOD = 113;
export const MAX_PERIOD = 856;

/** Channel volume is 0..64, a plain linear multiplier — Paula's own register. */
export const TRACKER_MAX_VOLUME = 64;

/** Effects this core acts on. `0xe` is partial: sub-commands 6, A and B. */
export const IMPLEMENTED_EFFECTS: ReadonlySet<number> = new Set([
  0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x9, 0xa, 0xb, 0xc, 0xd, 0xe, 0xf,
]);

/** Effects the validator accepts but the player deliberately does nothing with. */
export const IGNORED_EFFECTS: ReadonlySet<number> = new Set([0x7, 0x8]);

/**
 * ProTracker's own vibrato table: a quarter sine in 32 steps, 0..255.
 *
 * Written out rather than computed, for the reason `instruments.ts` gives —
 * transcendentals may differ between JS engines and this core's output is
 * hashed. The player reads it as `table[pos & 31]`, negating above 31.
 */
const VIBRATO_TABLE: readonly number[] = [
  0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253,
  255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24,
];

/**
 * The 16-finetune x 36-note period table — the table at main.seg00 $A198
 * (stride $48 = 36 words), which is the standard ProTracker tuning table.
 * Rows are indexed by the ProTracker finetune nibble: 0..7 are finetunes
 * 0..+7, 8..15 are finetunes -8..-1 (`finetune & 15` maps a signed finetune
 * to its row). Row 0 runs 856 (C-1) down to 113 (B-3).
 */
export const PERIOD_TABLE: readonly (readonly number[])[] = [
  // ft 0
  [856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
   428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
   214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113],
  // ft +1
  [850, 802, 757, 715, 674, 637, 601, 567, 535, 505, 477, 450,
   425, 401, 379, 357, 337, 318, 300, 284, 268, 253, 239, 225,
   213, 201, 189, 179, 169, 159, 150, 142, 134, 126, 119, 113],
  // ft +2
  [844, 796, 752, 709, 670, 632, 597, 563, 532, 502, 474, 447,
   422, 398, 376, 355, 335, 316, 298, 282, 266, 251, 237, 224,
   211, 199, 188, 177, 167, 158, 149, 141, 133, 125, 118, 112],
  // ft +3
  [838, 791, 746, 704, 665, 628, 592, 559, 528, 498, 470, 444,
   419, 395, 373, 352, 332, 314, 296, 280, 264, 249, 235, 222,
   209, 198, 187, 176, 166, 157, 148, 140, 132, 125, 118, 111],
  // ft +4
  [832, 785, 741, 699, 660, 623, 588, 555, 524, 494, 467, 441,
   416, 392, 370, 350, 330, 312, 294, 278, 262, 247, 233, 220,
   208, 196, 185, 175, 165, 156, 147, 139, 131, 124, 117, 110],
  // ft +5
  [826, 779, 736, 694, 655, 619, 584, 551, 520, 491, 463, 437,
   413, 390, 368, 347, 328, 309, 292, 276, 260, 245, 232, 219,
   206, 195, 184, 174, 164, 155, 146, 138, 130, 123, 116, 109],
  // ft +6
  [820, 774, 730, 689, 651, 614, 580, 547, 516, 487, 460, 434,
   410, 387, 365, 345, 325, 307, 290, 274, 258, 244, 230, 217,
   205, 193, 183, 172, 163, 154, 145, 137, 129, 122, 115, 109],
  // ft +7
  [814, 768, 725, 684, 646, 610, 575, 543, 513, 484, 457, 431,
   407, 384, 363, 342, 323, 305, 288, 272, 256, 242, 228, 216,
   204, 192, 181, 171, 161, 152, 144, 136, 128, 121, 114, 108],
  // ft -8
  [907, 856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480,
   453, 428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240,
   226, 214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120],
  // ft -7
  [900, 850, 802, 757, 715, 675, 636, 601, 567, 535, 505, 477,
   450, 425, 401, 379, 357, 337, 318, 300, 284, 268, 253, 238,
   225, 212, 200, 189, 179, 169, 159, 150, 142, 134, 126, 119],
  // ft -6
  [894, 844, 796, 752, 709, 670, 632, 597, 563, 532, 502, 474,
   447, 422, 398, 376, 355, 335, 316, 298, 282, 266, 251, 237,
   223, 211, 199, 188, 177, 167, 158, 149, 141, 133, 125, 118],
  // ft -5
  [887, 838, 791, 746, 704, 665, 628, 592, 559, 528, 498, 470,
   444, 419, 395, 373, 352, 332, 314, 296, 280, 264, 249, 235,
   222, 209, 198, 187, 176, 166, 157, 148, 140, 132, 125, 118],
  // ft -4
  [881, 832, 785, 741, 699, 660, 623, 588, 555, 524, 494, 467,
   441, 416, 392, 370, 350, 330, 312, 294, 278, 262, 247, 233,
   220, 208, 196, 185, 175, 165, 156, 147, 139, 131, 123, 117],
  // ft -3
  [875, 826, 779, 736, 694, 655, 619, 584, 551, 520, 491, 463,
   437, 413, 390, 368, 347, 328, 309, 292, 276, 260, 245, 232,
   219, 206, 195, 184, 174, 164, 155, 146, 138, 130, 123, 116],
  // ft -2
  [868, 820, 774, 730, 689, 651, 614, 580, 547, 516, 487, 460,
   434, 410, 387, 365, 345, 325, 307, 290, 274, 258, 244, 230,
   217, 205, 193, 183, 172, 163, 154, 145, 137, 129, 121, 115],
  // ft -1
  [862, 814, 768, 725, 684, 646, 610, 575, 543, 513, 484, 457,
   431, 407, 384, 363, 342, 323, 305, 288, 272, 256, 242, 228,
   216, 203, 192, 181, 171, 161, 152, 143, 136, 128, 121, 114],
];

/** Period to output rate under the PAL clock. */
export function periodToHz(period: number): number {
  return PAL_CLOCK / period;
}

// ---------------------------------------------------------------------------
// The song data format
// ---------------------------------------------------------------------------

/**
 * One pattern cell. `note` is 0 for none or 1..36 (1-based into the 36-note
 * period table, exactly the decoded engine's `byte0 >> 1` convention).
 * `instrument` is 0 for none or a declared instrument id. `effect`/`param`
 * follow ProTracker; effect 0 with param 0 means no effect at all.
 */
export interface TrackerCell {
  readonly note: number;
  readonly instrument: number;
  readonly effect: number;
  readonly param: number;
}

/** Cell factory, for songs written as plain TS data. */
export function cell(note: number, instrument: number, effect: number, param: number): TrackerCell {
  return { note, instrument, effect, param };
}

export const EMPTY_CELL: TrackerCell = Object.freeze(cell(0, 0, 0, 0));

/** 64 rows of TRACKER_CHANNELS cells each. */
export type TrackerRow = readonly TrackerCell[];
export type TrackerPattern = readonly TrackerRow[];

/**
 * What the player needs to know about an instrument: its tuning and its
 * default volume. The waveform itself is the instrument layer's business —
 * the core only ever names instruments by id.
 */
export interface TrackerInstrument {
  /** 1..31, unique within the song. */
  readonly id: number;
  /** -8..+7, ProTracker finetune. */
  readonly finetune: number;
  /** 0..64, the volume a note starts at when this instrument is set. */
  readonly volume: number;
}

export interface TrackerSong {
  readonly title: string;
  /** Ticks per row at song start, 1..31. ProTracker's default is 6. */
  readonly initialSpeed: number;
  /** BPM at song start, 32..255. ProTracker's default is 125 (50 ticks/s). */
  readonly initialTempo: number;
  /** Order position the song loops back to at the end of the order list. */
  readonly restart: number;
  /** Order list: indices into `patterns`. */
  readonly orders: readonly number[];
  readonly patterns: readonly TrackerPattern[];
  readonly instruments: readonly TrackerInstrument[];
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length ${value.length})`;
  return `${typeof value} ${String(value)}`;
}

function requireWholeNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a whole number in ${min}..${max}, got ${describeValue(value)}`);
  }
  return value;
}

/**
 * Checks every field of a song and throws with a message naming the exact
 * fault. A malformed song must fail here, loudly, not as a wrong note later.
 */
export function validateTrackerSong(song: TrackerSong): TrackerSong {
  const raw = song as unknown as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(`tracker song must be an object, got ${describeValue(song)}`);
  }
  if (typeof raw["title"] !== "string" || raw["title"].length === 0) {
    throw new Error(`tracker song has a non-string or empty title`);
  }
  const label = `tracker song "${raw["title"]}"`;

  requireWholeNumber(raw["initialSpeed"], `${label} initialSpeed`, 1, 31);
  requireWholeNumber(raw["initialTempo"], `${label} initialTempo`, 32, 255);

  const rawInstruments = raw["instruments"];
  if (!Array.isArray(rawInstruments) || rawInstruments.length === 0) {
    throw new Error(`${label} declares no instruments`);
  }
  const ids = new Set<number>();
  for (const [at, entry] of rawInstruments.entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} instrument ${at}`;
    const id = requireWholeNumber(item["id"], `${where} id`, 1, 31);
    if (ids.has(id)) throw new Error(`${label} declares instrument id ${id} twice`);
    ids.add(id);
    requireWholeNumber(item["finetune"], `${where} finetune`, -8, 7);
    requireWholeNumber(item["volume"], `${where} volume`, 0, TRACKER_MAX_VOLUME);
  }

  const rawPatterns = raw["patterns"];
  if (!Array.isArray(rawPatterns) || rawPatterns.length === 0) {
    throw new Error(`${label} has no patterns`);
  }
  for (const [pat, rows] of rawPatterns.entries()) {
    if (!Array.isArray(rows) || rows.length !== ROWS_PER_PATTERN) {
      throw new Error(
        `${label} pattern ${pat} must have exactly ${ROWS_PER_PATTERN} rows, got ${describeValue(rows)}`,
      );
    }
    for (const [rowAt, row] of (rows as unknown[]).entries()) {
      if (!Array.isArray(row) || row.length !== TRACKER_CHANNELS) {
        throw new Error(
          `${label} pattern ${pat} row ${rowAt} must have exactly ${TRACKER_CHANNELS} cells, got ${describeValue(row)}`,
        );
      }
      for (const [ch, entry] of (row as unknown[]).entries()) {
        const item = entry as Record<string, unknown>;
        const where = `${label} pattern ${pat} row ${rowAt} channel ${ch}`;
        requireWholeNumber(item["note"], `${where} note`, 0, NOTES_PER_FINETUNE);
        const instrument = requireWholeNumber(item["instrument"], `${where} instrument`, 0, 31);
        if (instrument !== 0 && !ids.has(instrument)) {
          throw new Error(`${where} names undeclared instrument ${instrument}`);
        }
        requireWholeNumber(item["effect"], `${where} effect`, 0, 15);
        requireWholeNumber(item["param"], `${where} param`, 0, 255);
      }
    }
  }

  const rawOrders = raw["orders"];
  if (!Array.isArray(rawOrders) || rawOrders.length === 0) {
    throw new Error(`${label} has an empty order list`);
  }
  for (const [at, entry] of rawOrders.entries()) {
    requireWholeNumber(entry, `${label} order ${at}`, 0, rawPatterns.length - 1);
  }
  requireWholeNumber(raw["restart"], `${label} restart`, 0, rawOrders.length - 1);

  return song;
}

// ---------------------------------------------------------------------------
// The player
// ---------------------------------------------------------------------------

/**
 * What one tick tells the output stage to do with one channel. Plain data,
 * no Web Audio: "trigger" restarts the named instrument at a rate and volume,
 * "pitch" retunes whatever is sounding, "volume" adjusts its level. Commands
 * are only emitted on change, so a silent tick is an empty list.
 */
export type TrackerCommand =
  | {
      readonly channel: number;
      readonly action: "trigger";
      readonly instrument: number;
      readonly frequencyHz: number;
      readonly volume: number;
      /**
       * Effect 9's start point, in BYTES into the instrument's PCM: `9xx`
       * starts the note 256*xx bytes in. 0 for every other note, which is the
       * ordinary "start at the beginning".
       */
      readonly sampleOffsetBytes: number;
    }
  | { readonly channel: number; readonly action: "pitch"; readonly frequencyHz: number }
  | { readonly channel: number; readonly action: "volume"; readonly volume: number };

interface ChannelState {
  /** Current instrument id, 0 until one is ever set. */
  instrument: number;
  finetune: number;
  /** Current Paula period; slides move it, and it may leave the table. */
  period: number;
  /** Base note index 0..35 (for arpeggio), or -1 before any note. */
  noteIndex: number;
  /** Tone-portamento destination period, or 0 when not sliding. */
  target: number;
  /** Effect 3 speed memory: `3xx` with x = 0 reuses the last speed. */
  portaSpeed: number;
  /** Effect 4/6 memory: `4x0`/`40y` reuse the last speed/depth. */
  vibratoSpeed: number;
  vibratoDepth: number;
  /** Vibrato table position, 0..63; reset by a note without effect 4/6. */
  vibratoPos: number;
  volume: number;
  /** True once a note has actually triggered; silent channels emit nothing. */
  active: boolean;
  /** Last emitted period/volume, so the stream only carries changes. */
  emittedPeriod: number;
  emittedVolume: number;
}

export interface TrackerPlayer {
  readonly song: TrackerSong;
  readonly channels: readonly ChannelState[];
  /** Position: order-list index, row 0..63, tick 0..speed-1 within the row. */
  order: number;
  row: number;
  tick: number;
  speed: number;
  tempo: number;
  /** Row-end jump requests (effects B and D), consumed when the row ends. */
  pendingJump: number | null;
  pendingBreak: number | null;
  /**
   * Effect E6's state: the row `E60` marked and how many jumps back are left.
   *
   * ProTracker keeps these per channel; this core keeps one pair, because the
   * shipped module uses E6 on ONE channel of ONE pattern (pattern 0, `E60` at
   * row 48 and `E62` at row 63, which plays rows 48..63 three times) and a
   * per-channel model would be four times the state for no shipped behaviour.
   * Stated rather than assumed: a song that ran two channels' loops at once
   * would need the split.
   */
  loopRow: number;
  loopCount: number;
  /** Set by an E6x that still owes a jump; consumed when the row ends. */
  pendingLoop: boolean;
}

/** Wall-clock length of one tick: 2.5 / BPM seconds (125 BPM = 50 ticks/s). */
export function tickDurationSeconds(player: TrackerPlayer): number {
  return 2.5 / player.tempo;
}

function periodFor(finetune: number, noteIndex: number): number {
  const row = PERIOD_TABLE[finetune & 15] as readonly number[];
  const clamped = Math.min(Math.max(noteIndex, 0), NOTES_PER_FINETUNE - 1);
  return row[clamped] as number;
}

/**
 * Validates the song and builds a player at `startOrder`. An out-of-range
 * start position is clamped to 0 — the decoded engine does exactly this at
 * $7B18-$7B2C with the shell's own d0 = $11 against songlen 14.
 */
export function createTrackerPlayer(song: TrackerSong, startOrder = 0): TrackerPlayer {
  validateTrackerSong(song);
  const channels: ChannelState[] = [];
  for (let ch = 0; ch < TRACKER_CHANNELS; ch += 1) {
    channels.push({
      instrument: 0,
      finetune: 0,
      period: 0,
      noteIndex: -1,
      target: 0,
      portaSpeed: 0,
      vibratoSpeed: 0,
      vibratoDepth: 0,
      vibratoPos: 0,
      volume: 0,
      active: false,
      emittedPeriod: 0,
      emittedVolume: -1,
    });
  }
  return {
    song,
    channels,
    order: startOrder >= 0 && startOrder < song.orders.length ? startOrder : 0,
    row: 0,
    tick: 0,
    speed: song.initialSpeed,
    tempo: song.initialTempo,
    pendingJump: null,
    pendingBreak: null,
    loopRow: 0,
    loopCount: 0,
    pendingLoop: false,
  };
}

/** Tick-0 work for one cell. Returns the byte offset a triggered note starts at,
 * or -1 when no note triggered. */
function applyRowStart(player: TrackerPlayer, state: ChannelState, at: TrackerCell): number {
  const { effect, param } = at;
  if (at.instrument !== 0) {
    // The validator proved this id is declared.
    const instrument = player.song.instruments.find((one) => one.id === at.instrument) as TrackerInstrument;
    state.instrument = at.instrument;
    state.finetune = instrument.finetune;
    state.volume = instrument.volume;
  }
  let triggered = -1;
  if (at.note !== 0) {
    const noteIndex = at.note - 1;
    const period = periodFor(state.finetune, noteIndex);
    if ((effect === 0x3 || effect === 0x5) && state.active) {
      // Tone portamento: the note names the destination, nothing retriggers.
      state.target = period;
      state.noteIndex = noteIndex;
    } else {
      state.period = period;
      state.noteIndex = noteIndex;
      state.target = 0;
      // ProTracker restarts the vibrato table on a retrigger UNLESS the row
      // carries vibrato itself, which is what lets a held vibrato survive a
      // re-articulation.
      if (effect !== 0x4 && effect !== 0x6) state.vibratoPos = 0;
      if (state.instrument !== 0) {
        state.active = true;
        // Effect 9: start `256 * param` bytes into the sample.
        triggered = effect === 0x9 ? param * 256 : 0;
      }
    }
  }
  switch (effect) {
    case 0x3:
      if (param !== 0) state.portaSpeed = param;
      break;
    case 0x4:
    case 0x6: {
      // `4xy`: x is speed, y is depth, and a zero nibble reuses the memory.
      // Effect 6 carries no vibrato operands at all — its param is the volume
      // slide — so it always runs on the remembered pair.
      if (effect === 0x4) {
        const speed = param >> 4;
        const depth = param & 0xf;
        if (speed !== 0) state.vibratoSpeed = speed;
        if (depth !== 0) state.vibratoDepth = depth;
      }
      break;
    }
    case 0xe: {
      const command = param >> 4;
      const operand = param & 0xf;
      if (command === 0x6) {
        // E60 marks the loop row; E6x jumps back to it x times. The counter is
        // set on the FIRST E6x seen and decremented after, so `E62` plays the
        // marked span three times in all.
        if (operand === 0) player.loopRow = player.row;
        else if (player.loopCount === 0) {
          player.loopCount = operand;
          player.pendingLoop = true;
        } else {
          player.loopCount -= 1;
          if (player.loopCount > 0) player.pendingLoop = true;
        }
      } else if (command === 0xa) {
        state.volume = Math.min(state.volume + operand, TRACKER_MAX_VOLUME);
      } else if (command === 0xb) {
        state.volume = Math.max(state.volume - operand, 0);
      }
      break;
    }
    case 0xb:
      player.pendingJump = param < player.song.orders.length ? param : 0;
      break;
    case 0xc:
      state.volume = Math.min(param, TRACKER_MAX_VOLUME);
      break;
    case 0xd: {
      const target = (param >> 4) * 10 + (param & 0xf);
      player.pendingBreak = target < ROWS_PER_PATTERN ? target : 0;
      break;
    }
    case 0xf:
      // F00 halts real ProTracker; shell music loops forever, so it is ignored.
      if (param === 0) break;
      if (param < 0x20) player.speed = param;
      else player.tempo = param;
      break;
    default:
      break;
  }
  return triggered;
}

function slideTowardTarget(state: ChannelState): void {
  if (state.target === 0 || state.period === 0) return;
  if (state.period < state.target) {
    state.period = Math.min(state.period + state.portaSpeed, state.target);
  } else if (state.period > state.target) {
    state.period = Math.max(state.period - state.portaSpeed, state.target);
  }
  if (state.period === state.target) state.target = 0;
}

function slideVolume(state: ChannelState, param: number): void {
  const up = param >> 4;
  const down = param & 0xf;
  if (up > 0) state.volume = Math.min(state.volume + up, TRACKER_MAX_VOLUME);
  else state.volume = Math.max(state.volume - down, 0);
}

/** The vibrato table's signed value at the channel's current position. */
function vibratoOffset(state: ChannelState): number {
  const magnitude = VIBRATO_TABLE[state.vibratoPos & 31] as number;
  const swing = ((magnitude * state.vibratoDepth) / 128) | 0;
  return state.vibratoPos < 32 ? swing : -swing;
}

/** Per-tick effect work (ticks 1..speed-1 of a row). */
function applyTickEffect(state: ChannelState, at: TrackerCell): void {
  const { effect, param } = at;
  switch (effect) {
    case 0x4:
      state.vibratoPos = (state.vibratoPos + state.vibratoSpeed) & 63;
      break;
    case 0x6:
      state.vibratoPos = (state.vibratoPos + state.vibratoSpeed) & 63;
      slideVolume(state, param);
      break;
    case 0x1:
      if (state.period > 0) state.period = Math.max(state.period - param, MIN_PERIOD);
      break;
    case 0x2:
      if (state.period > 0) state.period = Math.min(state.period + param, MAX_PERIOD);
      break;
    case 0x3:
      slideTowardTarget(state);
      break;
    case 0x5:
      slideTowardTarget(state);
      slideVolume(state, param);
      break;
    case 0xa:
      slideVolume(state, param);
      break;
    default:
      break;
  }
}

function advance(player: TrackerPlayer): void {
  player.tick += 1;
  if (player.tick < player.speed) return;
  player.tick = 0;
  // E6's jump is decided before B and D, exactly as ProTracker orders them:
  // the loop is inside the pattern and a position jump leaves it.
  if (player.pendingLoop && player.pendingJump === null && player.pendingBreak === null) {
    player.pendingLoop = false;
    player.row = player.loopRow;
    return;
  }
  player.pendingLoop = false;
  if (player.pendingJump !== null || player.pendingBreak !== null) {
    player.order = player.pendingJump ?? player.order + 1;
    player.row = player.pendingBreak ?? 0;
    player.pendingJump = null;
    player.pendingBreak = null;
  } else {
    player.row += 1;
    if (player.row < ROWS_PER_PATTERN) return;
    player.row = 0;
    player.order += 1;
  }
  if (player.order >= player.song.orders.length) player.order = player.song.restart;
}

/**
 * Advances the player by exactly one tick and returns the channel commands
 * for that tick. Pure: same state in, same commands out, no clock anywhere —
 * the caller owns time, at `tickDurationSeconds` per step.
 */
export function stepTracker(player: TrackerPlayer): TrackerCommand[] {
  const commands: TrackerCommand[] = [];
  const patternIndex = player.song.orders[player.order] as number;
  const pattern = player.song.patterns[patternIndex] as TrackerPattern;
  const row = pattern[player.row] as TrackerRow;

  for (let ch = 0; ch < TRACKER_CHANNELS; ch += 1) {
    const state = player.channels[ch] as ChannelState;
    const at = row[ch] as TrackerCell;
    let triggered = -1;
    if (player.tick === 0) triggered = applyRowStart(player, state, at);
    else applyTickEffect(state, at);

    // Arpeggio bends the OUTPUT period only; state.period stays put and the
    // next row's tick 0 naturally restores it through the change detector.
    let effective = state.period;
    if (at.effect === 0x0 && at.param !== 0 && state.noteIndex >= 0 && state.period > 0) {
      const phase = player.tick % 3;
      if (phase === 1) effective = periodFor(state.finetune, state.noteIndex + (at.param >> 4));
      else if (phase === 2) effective = periodFor(state.finetune, state.noteIndex + (at.param & 0xf));
    }
    // Vibrato bends the OUTPUT period the same way arpeggio does — state.period
    // is untouched, so the effect leaves nothing behind when the row ends.
    if ((at.effect === 0x4 || at.effect === 0x6) && state.period > 0) {
      effective = Math.min(Math.max(state.period + vibratoOffset(state), MIN_PERIOD), MAX_PERIOD);
    }

    if (triggered >= 0) {
      commands.push({
        channel: ch,
        action: "trigger",
        instrument: state.instrument,
        frequencyHz: periodToHz(effective),
        volume: state.volume,
        sampleOffsetBytes: triggered,
      });
      state.emittedPeriod = effective;
      state.emittedVolume = state.volume;
    } else if (state.active) {
      if (effective > 0 && effective !== state.emittedPeriod) {
        commands.push({ channel: ch, action: "pitch", frequencyHz: periodToHz(effective) });
        state.emittedPeriod = effective;
      }
      if (state.volume !== state.emittedVolume) {
        commands.push({ channel: ch, action: "volume", volume: state.volume });
        state.emittedVolume = state.volume;
      }
    }
  }

  advance(player);
  return commands;
}
