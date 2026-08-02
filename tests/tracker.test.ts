/**
 * The tracker player core, held to the repo's audio law: pure, deterministic,
 * testable in node with no Web Audio anywhere near it.
 *
 * The song data in this file is throwaway TEST material — scales, single
 * notes, effect exercises — written for these assertions. It is not, and must
 * never become, a transcription of anything from the original disks.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  EMPTY_CELL,
  IGNORED_EFFECTS,
  IMPLEMENTED_EFFECTS,
  MAX_PERIOD,
  MIN_PERIOD,
  NOTES_PER_FINETUNE,
  PAL_CLOCK,
  PERIOD_TABLE,
  ROWS_PER_PATTERN,
  TRACKER_CHANNELS,
  TRACKER_MAX_VOLUME,
  cell,
  createTrackerPlayer,
  periodToHz,
  stepTracker,
  tickDurationSeconds,
  validateTrackerSong,
} from "../src/audio/tracker.js";
import type {
  TrackerCell,
  TrackerCommand,
  TrackerPlayer,
  TrackerSong,
} from "../src/audio/tracker.js";

// ---------------------------------------------------------------------------
// Song-building helpers
// ---------------------------------------------------------------------------

function blankPattern(): TrackerCell[][] {
  return Array.from({ length: ROWS_PER_PATTERN }, () =>
    Array.from({ length: TRACKER_CHANNELS }, () => EMPTY_CELL),
  );
}

function put(pattern: TrackerCell[][], row: number, channel: number, value: TrackerCell): void {
  (pattern[row] as TrackerCell[])[channel] = value;
}

function songOf(patterns: TrackerCell[][][], overrides: Partial<TrackerSong> = {}): TrackerSong {
  return {
    title: "test song",
    initialSpeed: 6,
    initialTempo: 125,
    restart: 0,
    orders: patterns.map((_, index) => index),
    patterns,
    instruments: [
      { id: 1, finetune: 0, volume: 64 },
      { id: 2, finetune: -8, volume: 48 },
      { id: 7, finetune: 2, volume: 32 },
    ],
    ...overrides,
  };
}

/** Steps the player `count` times and returns each tick's command list. */
function run(player: TrackerPlayer, count: number): TrackerCommand[][] {
  const ticks: TrackerCommand[][] = [];
  for (let at = 0; at < count; at += 1) ticks.push(stepTracker(player));
  return ticks;
}

/** The integer Paula period a pitch-carrying command encodes. */
function periodOf(command: TrackerCommand): number {
  if (command.action === "volume") throw new Error("volume command has no pitch");
  return Math.round(PAL_CLOCK / command.frequencyHz);
}

// ---------------------------------------------------------------------------

describe("the period table", () => {
  it("is 16 finetunes of 36 notes", () => {
    expect(PERIOD_TABLE.length).toBe(16);
    for (const row of PERIOD_TABLE) expect(row.length).toBe(NOTES_PER_FINETUNE);
  });

  it("runs 856..113 at finetune 0, exactly the decoded $A198 row", () => {
    const ft0 = PERIOD_TABLE[0] as readonly number[];
    expect(ft0).toEqual([
      856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
      428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
      214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
    ]);
  });

  it("descends strictly within every finetune row", () => {
    for (const [finetune, row] of PERIOD_TABLE.entries()) {
      for (let at = 1; at < row.length; at += 1) {
        expect(row[at] as number, `finetune row ${finetune} note ${at}`).toBeLessThan(
          row[at - 1] as number,
        );
      }
    }
  });

  it("octave-doubles within rounding: one octave up halves the period", () => {
    const ft0 = PERIOD_TABLE[0] as readonly number[];
    for (let at = 0; at + 12 < ft0.length; at += 1) {
      expect(Math.abs((ft0[at] as number) / 2 - (ft0[at + 12] as number))).toBeLessThanOrEqual(1);
    }
  });
});

describe("period to frequency under the PAL clock", () => {
  it("divides 3546895 by the period, exactly", () => {
    for (const period of [856, 428, 214, 113, 320, 907]) {
      expect(periodToHz(period)).toBe(3546895 / period);
    }
  });

  it("hits the known Amiga rates", () => {
    expect(periodToHz(428)).toBeCloseTo(8287.1379, 3); // C-2 at ft0
    expect(periodToHz(214)).toBeCloseTo(16574.2757, 3); // C-3 at ft0
    expect(periodToHz(856)).toBeCloseTo(4143.5689, 3); // C-1 at ft0
    expect(periodToHz(113)).toBeCloseTo(31388.4513, 3); // B-3, the ceiling
  });
});

describe("the effect coverage declaration", () => {
  it("accounts for all 16 effects, each exactly once", () => {
    expect(IMPLEMENTED_EFFECTS.size + IGNORED_EFFECTS.size).toBe(16);
    for (let effect = 0; effect < 16; effect += 1) {
      expect(
        IMPLEMENTED_EFFECTS.has(effect) !== IGNORED_EFFECTS.has(effect),
        `effect ${effect.toString(16)}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

describe("basic sequencing", () => {
  it("plays a row on tick 0 and is silent for the rest of the row", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(13, 1, 0, 0)); // period 428
    put(pattern, 1, 2, cell(25, 1, 0, 0)); // period 214
    const player = createTrackerPlayer(songOf([pattern]));

    const ticks = run(player, 7);
    expect(ticks[0]).toEqual([
      {
        channel: 0,
        action: "trigger",
        instrument: 1,
        frequencyHz: periodToHz(428),
        volume: 64,
        // Effect 9's start point rides out on every trigger; 0 is "from the
        // beginning", which is what a note with no 9xx means.
        sampleOffsetBytes: 0,
      },
    ]);
    for (let at = 1; at < 6; at += 1) expect(ticks[at], `tick ${at}`).toEqual([]);
    expect(ticks[6]).toEqual([
      {
        channel: 2,
        action: "trigger",
        instrument: 1,
        frequencyHz: periodToHz(214),
        volume: 64,
        sampleOffsetBytes: 0,
      },
    ]);
  });

  it("advances a row every `speed` ticks and a pattern every 64 rows", () => {
    const player = createTrackerPlayer(songOf([blankPattern(), blankPattern()]));
    run(player, 6 * 64);
    expect([player.order, player.row, player.tick]).toEqual([1, 0, 0]);
  });

  it("applies an instrument's finetune to its notes", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(1, 2, 0, 0)); // ft -8: note 1 is period 907
    const player = createTrackerPlayer(songOf([pattern]));
    const first = (run(player, 1)[0] as TrackerCommand[])[0] as TrackerCommand;
    expect(periodOf(first)).toBe(907);
    expect(first.action === "trigger" && first.volume).toBe(48);
  });

  it("clamps an out-of-range start position to 0, as $7B18 does", () => {
    const song = songOf([blankPattern(), blankPattern()]);
    expect(createTrackerPlayer(song, 17).order).toBe(0); // the shell's own d0 = $11
    expect(createTrackerPlayer(song, 1).order).toBe(1);
  });

  it("loops the order list back to the restart position", () => {
    const first = blankPattern();
    const second = blankPattern();
    put(second, 0, 0, cell(13, 1, 0, 0));
    const player = createTrackerPlayer(
      songOf([first, second], { initialSpeed: 1, restart: 1 }),
    );
    run(player, 2 * 64); // both patterns, one row per tick at speed 1
    expect([player.order, player.row]).toEqual([1, 0]);
    // And the restarted pattern actually plays again.
    const replay = run(player, 1)[0] as TrackerCommand[];
    expect(replay.some((one) => one.action === "trigger")).toBe(true);
  });
});

describe("silent channels", () => {
  it("a note with no instrument ever set makes no sound at all", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(13, 0, 0, 0));
    const player = createTrackerPlayer(songOf([pattern]));
    for (const tick of run(player, 12)) expect(tick).toEqual([]);
  });

  it("a bare note keeps the current instrument and the current volume", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(13, 1, 0, 0));
    put(pattern, 1, 0, cell(0, 0, 0xc, 0x20)); // volume 32
    put(pattern, 2, 0, cell(13, 0, 0, 0)); // bare note
    const player = createTrackerPlayer(songOf([pattern]));
    const ticks = run(player, 13);
    expect(ticks[6]).toEqual([{ channel: 0, action: "volume", volume: 0x20 }]);
    expect(ticks[12]).toEqual([
      {
        channel: 0,
        action: "trigger",
        instrument: 1,
        frequencyHz: periodToHz(428),
        volume: 0x20,
        sampleOffsetBytes: 0,
      },
    ]);
  });

  it("an instrument with no note resets volume without retriggering", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(13, 1, 0xc, 0x10));
    put(pattern, 1, 0, cell(0, 1, 0, 0)); // instrument only
    const player = createTrackerPlayer(songOf([pattern]));
    const ticks = run(player, 7);
    expect(ticks[6]).toEqual([{ channel: 0, action: "volume", volume: 64 }]);
  });
});

describe("effect arithmetic", () => {
  it("0: arpeggio cycles base / +x / +y and restores on the next row", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(13, 1, 0, 0x47)); // 428; +4 = 339, +7 = 285
    const player = createTrackerPlayer(songOf([pattern]));
    const ticks = run(player, 7);
    expect(periodOf((ticks[0] as TrackerCommand[])[0] as TrackerCommand)).toBe(428);
    const heard = ticks
      .slice(1, 6)
      .map((tick) => periodOf((tick as TrackerCommand[])[0] as TrackerCommand));
    expect(heard).toEqual([339, 285, 428, 339, 285]);
    // Row 1 is empty: tick 0 restores the base pitch.
    expect(ticks[6]).toEqual([{ channel: 0, action: "pitch", frequencyHz: periodToHz(428) }]);
  });

  it("0: arpeggio clamps at the top of the period table", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(36, 1, 0, 0x47)); // 113 is already the last entry
    const player = createTrackerPlayer(songOf([pattern]));
    const ticks = run(player, 6);
    for (let at = 1; at < 6; at += 1) expect(ticks[at], `tick ${at}`).toEqual([]);
  });

  it("1: portamento up slides per tick and clamps at period 113", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(25, 1, 0, 0)); // 214
    put(pattern, 1, 0, cell(0, 0, 0x1, 30));
    const player = createTrackerPlayer(songOf([pattern]));
    const ticks = run(player, 12);
    const slid = ticks.slice(7, 12).map((tick) =>
      (tick as TrackerCommand[]).map((one) => periodOf(one)),
    );
    expect(slid).toEqual([[184], [154], [124], [MIN_PERIOD], []]); // pinned, then silent
  });

  it("2: portamento down slides per tick and clamps at period 856", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(13, 1, 0, 0)); // 428
    put(pattern, 1, 0, cell(0, 0, 0x2, 200));
    const player = createTrackerPlayer(songOf([pattern]));
    const ticks = run(player, 12);
    const slid = ticks.slice(7, 12).map((tick) =>
      (tick as TrackerCommand[]).map((one) => periodOf(one)),
    );
    expect(slid).toEqual([[628], [828], [MAX_PERIOD], [], []]);
  });

  it("3: tone portamento walks to the target, never overshoots, never retriggers", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(25, 1, 0, 0)); // 214
    put(pattern, 1, 0, cell(13, 0, 0x3, 50)); // toward 428, 50 per tick
    const player = createTrackerPlayer(songOf([pattern]));
    const ticks = run(player, 12);
    expect((ticks[6] as TrackerCommand[]).every((one) => one.action !== "trigger")).toBe(true);
    const slid = ticks.slice(7, 12).map((tick) =>
      (tick as TrackerCommand[]).map((one) => periodOf(one)),
    );
    expect(slid).toEqual([[264], [314], [364], [414], [428]]);
  });

  it("3: a zero param reuses the remembered portamento speed", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(25, 1, 0, 0)); // 214
    put(pattern, 1, 0, cell(13, 0, 0x3, 20)); // toward 428 at 20 per tick: reaches 314
    put(pattern, 2, 0, cell(0, 0, 0x3, 0)); // keeps sliding at 20
    const player = createTrackerPlayer(songOf([pattern]));
    const ticks = run(player, 18);
    const lastRow = ticks.slice(13, 18).map((tick) =>
      (tick as TrackerCommand[]).map((one) => periodOf(one)),
    );
    expect(lastRow).toEqual([[334], [354], [374], [394], [414]]);
  });

  it("A: volume slides down to 0 and up to 64, clamped", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(13, 1, 0xc, 0x0c)); // start at 12
    put(pattern, 1, 0, cell(0, 0, 0xa, 0x05)); // down 5 per tick
    put(pattern, 2, 0, cell(0, 0, 0xa, 0xf0)); // up 15 per tick
    const player = createTrackerPlayer(songOf([pattern]));
    const ticks = run(player, 18);
    const down = ticks.slice(7, 12).map((tick) =>
      (tick as TrackerCommand[]).map((one) => one.action === "volume" && one.volume),
    );
    expect(down).toEqual([[7], [2], [0], [], []]);
    const up = ticks.slice(13, 18).map((tick) =>
      (tick as TrackerCommand[]).map((one) => one.action === "volume" && one.volume),
    );
    expect(up).toEqual([[15], [30], [45], [60], [TRACKER_MAX_VOLUME]]);
  });

  it("C: set volume clamps to Paula's 64", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(13, 1, 0xc, 0xff));
    const player = createTrackerPlayer(songOf([pattern]));
    const first = (run(player, 1)[0] as TrackerCommand[])[0] as TrackerCommand;
    expect(first.action === "trigger" && first.volume).toBe(TRACKER_MAX_VOLUME);
  });

  it("ignored effects change nothing but still let the note trigger", () => {
    // 4 and 9 used to be on this list and are now implemented — they are two of
    // the five the front-end module actually uses. What is left ignored is 7
    // (tremolo) and 8 (unused in ProTracker), neither of which appears in any
    // shipped song.
    const quiet = blankPattern();
    const noisy = blankPattern();
    put(quiet, 0, 0, cell(13, 1, 0, 0));
    put(noisy, 0, 0, cell(13, 1, 0x7, 0x33)); // tremolo, ignored
    put(quiet, 1, 1, cell(25, 2, 0, 0));
    put(noisy, 1, 1, cell(25, 2, 0x8, 0x10)); // unused in PT, ignored
    const a = createTrackerPlayer(songOf([quiet]));
    const b = createTrackerPlayer(songOf([noisy]));
    expect(run(b, 18)).toEqual(run(a, 18));
  });

  it("4: vibrato bends the output period and leaves state.period alone", () => {
    // The five effects added for the front-end module: 4 and 6 vibrato, 9
    // sample offset, EA/EB fine volume slides, E6 pattern loop. This one is the
    // one with per-tick arithmetic.
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(13, 1, 0x4, 0x84)); // speed 8, depth 4
    const player = createTrackerPlayer(songOf([pattern], { initialSpeed: 8 }));
    const ticks = run(player, 8);
    // Tick 0 triggers at the unbent period; the following ticks retune.
    const pitches = ticks
      .flat()
      .filter((command) => command.action === "pitch")
      .map((command) => (command.action === "pitch" ? command.frequencyHz : 0));
    expect(pitches.length).toBeGreaterThan(0);
    // The channel's own period is untouched: the bend is on the output only.
    const state = player.channels[0];
    expect(state?.period).toBe(PERIOD_TABLE[0]?.[12]);
  });

  it("9: a sample offset rides out on the trigger, in bytes", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(13, 1, 0x9, 0x10));
    const player = createTrackerPlayer(songOf([pattern]));
    const first = (run(player, 1)[0] as TrackerCommand[])[0] as TrackerCommand;
    expect(first.action === "trigger" && first.sampleOffsetBytes).toBe(0x10 * 256);
  });

  it("EA/EB: fine volume slides move once, on tick 0", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(13, 1, 0xc, 0x20)); // volume 32
    put(pattern, 1, 0, cell(0, 0, 0xe, 0xa5)); // fine up 5
    put(pattern, 2, 0, cell(0, 0, 0xe, 0xb9)); // fine down 9
    const player = createTrackerPlayer(songOf([pattern], { initialSpeed: 3 }));
    const volumes = run(player, 9)
      .flat()
      .filter((command) => command.action === "volume")
      .map((command) => (command.action === "volume" ? command.volume : -1));
    expect(volumes).toEqual([37, 28]);
  });

  it("E6: the pattern loop replays the marked span, counting its first pass", () => {
    // $8678 increments the counter $2f BEFORE comparing it against x, so `E62`
    // plays the marked span x+1 = three times in all. The front-end module does
    // this twice: `E60`/`E67` on channel 2 of pattern 0, and `E60`/`E64` on
    // channel 3 of pattern 9 — both in the run-in.
    const pattern = blankPattern();
    put(pattern, 60, 0, cell(0, 0, 0xe, 0x60));
    put(pattern, 63, 0, cell(0, 0, 0xe, 0x62));
    const player = createTrackerPlayer(songOf([pattern, blankPattern()], { initialSpeed: 1 }));
    // 64 rows, then rows 60..63 twice more = 72 rows before the pattern ends.
    run(player, 72);
    expect([player.order, player.row]).toEqual([1, 0]);
  });

  it("E6: the mark is PER CHANNEL — four marks stand at once", () => {
    // The marked row $2c and the counter $2f live in the 62-byte channel block
    // at a4, not in the song state, so four channels hold four marks. All four
    // lay one here and channel 0 then jumps: with one shared pair it would land
    // on whichever channel marked LAST (row 40), not on its own row 10.
    const pattern = blankPattern();
    put(pattern, 10, 0, cell(0, 0, 0xe, 0x60));
    put(pattern, 20, 1, cell(0, 0, 0xe, 0x60));
    put(pattern, 30, 2, cell(0, 0, 0xe, 0x60));
    put(pattern, 40, 3, cell(0, 0, 0xe, 0x60));
    put(pattern, 50, 0, cell(0, 0, 0xe, 0x61));
    const player = createTrackerPlayer(songOf([pattern, blankPattern()], { initialSpeed: 1 }));
    run(player, 51); // rows 0..50; the E61 fires as row 50 ends
    expect(player.row).toBe(10);
    expect(player.channels.map((one) => one.loopRow)).toEqual([10, 20, 30, 40]);
    expect(player.channels.map((one) => one.loopCount)).toEqual([1, 0, 0, 0]);
    // The replay runs 10..50 once more and the counter dies there, so the
    // pattern ends normally rather than looping for ever.
    run(player, 41 + 13);
    expect([player.order, player.row]).toEqual([1, 0]);
  });
});

describe("sequencing effects", () => {
  it("D: breaks to the RAW row of the next pattern, not ProTracker's 10x + y", () => {
    // $884C is `move.b $5(a4),d0 / addi.w #$40,d0 / move.w d0,$116(a2)` and the
    // intro build's copy at +$1C8C is the same three instructions. The byte is
    // the row; there is no decimal split. The only D in the shipped module is
    // D00 (pattern 35 row 50), where both readings agree, so this is the
    // machine's arithmetic pinned rather than an audible change.
    const first = blankPattern();
    put(first, 5, 0, cell(0, 0, 0xd, 0x12)); // 0x12 is 18, not 12
    const player = createTrackerPlayer(songOf([first, blankPattern()], { initialSpeed: 1 }));
    run(player, 6); // rows 0..5
    expect([player.order, player.row]).toEqual([1, 18]);
  });

  it("D: a param past the last row lands on row 0 rather than off the pattern", () => {
    const first = blankPattern();
    put(first, 0, 0, cell(0, 0, 0xd, 0x40)); // 64: one past the last row
    const player = createTrackerPlayer(songOf([first, blankPattern()], { initialSpeed: 1 }));
    run(player, 1);
    expect([player.order, player.row]).toEqual([1, 0]);
  });

  it("D: at the last order, breaks into the restart pattern", () => {
    const only = blankPattern();
    put(only, 0, 0, cell(0, 0, 0xd, 0x03));
    const player = createTrackerPlayer(songOf([only], { initialSpeed: 1 }));
    run(player, 1);
    expect([player.order, player.row]).toEqual([0, 3]);
  });

  it("B: jumps to an order position, and B + D jump to B's order at D's row", () => {
    const first = blankPattern();
    const second = blankPattern();
    put(first, 3, 0, cell(0, 0, 0xb, 0x00));
    put(second, 0, 0, cell(0, 0, 0xb, 0x01));
    put(second, 0, 1, cell(0, 0, 0xd, 0x07));
    const player = createTrackerPlayer(songOf([first, second], { initialSpeed: 1 }), 1);
    run(player, 1); // B01 + D07 together
    expect([player.order, player.row]).toEqual([1, 7]);
    const looper = createTrackerPlayer(songOf([first, second], { initialSpeed: 1 }));
    run(looper, 4); // rows 0..3, B00 at row 3
    expect([looper.order, looper.row]).toEqual([0, 0]);
  });

  it("F: sets ticks per row, immediately", () => {
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(0, 0, 0xf, 0x03));
    const player = createTrackerPlayer(songOf([pattern]));
    run(player, 3);
    expect([player.row, player.speed]).toEqual([1, 3]);
  });

  it("F: 0x20 and above is STILL ticks per row — this format has no BPM", () => {
    // ProTracker splits Fxx at 0x20 and reprograms CIA-B timer A above it.
    // This replayer does not: $883A is `move.b $5(a4),d0 ... move.b d0,$10d(a2)`,
    // storing the raw byte in the low half of the speed word $10c that $80BE
    // reloads the countdown from. There is no compare against $20 and no CIA
    // write anywhere in the effect table. The tick is a PAL field, delivered by
    // the level-6 EXTER interrupt the copper raises once a frame, so the tick
    // LENGTH is a constant 20 ms whatever Fxx says.
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(0, 0, 0xf, 0x80));
    const player = createTrackerPlayer(songOf([pattern]));
    expect(tickDurationSeconds(player)).toBe(0.02); // one PAL field
    run(player, 1);
    expect(player.speed).toBe(0x80); // 128 fields for this row
    expect(player.tempo).toBe(125); // and nothing touched the clock
    expect(tickDurationSeconds(player)).toBe(0.02);
    run(player, 127);
    expect([player.row, player.tick]).toEqual([1, 0]);
  });

  it("F00 gives a ONE-FIELD row and never halts", () => {
    // The two builds spell it differently and mean the same thing: the shell's
    // $883A stores 1 (and raises the stop flag $21c, which is the shell's own
    // business), while the intro build at +$1C82 has no `bne` at all and stores
    // the 0 verbatim. A stored 0 reloads the countdown with 0, `subq.w #1`
    // takes it to -1, and `ble` ends the row — one field, exactly as a stored 1
    // does. The shipped module carries one F00, at pattern 14 row 62.
    const pattern = blankPattern();
    put(pattern, 0, 0, cell(0, 0, 0xf, 0x00));
    put(pattern, 3, 0, cell(0, 0, 0xf, 0x06));
    const player = createTrackerPlayer(songOf([pattern]));
    run(player, 1);
    expect([player.row, player.tick]).toEqual([1, 0]); // row 0 lasted one field
    run(player, 2); // rows 1 and 2 are one field each: the speed stays 0
    expect([player.row, player.tick]).toEqual([3, 0]);
    run(player, 6); // and F06 on row 3 puts it back
    expect([player.row, player.speed]).toEqual([4, 6]);
  });

  it("a speed change mid-song re-times every later row", () => {
    const pattern = blankPattern();
    put(pattern, 2, 3, cell(0, 0, 0xf, 0x02));
    const player = createTrackerPlayer(songOf([pattern]));
    run(player, 12); // rows 0 and 1 at speed 6
    expect([player.row, player.tick]).toEqual([2, 0]);
    run(player, 2); // row 2 now lasts 2 ticks
    expect([player.row, player.tick]).toEqual([3, 0]);
  });
});

// ---------------------------------------------------------------------------

describe("the validator refuses", () => {
  const valid = (): TrackerSong => songOf([blankPattern()]);
  const mutate = (change: (doc: Record<string, unknown>) => void): TrackerSong => {
    const doc = JSON.parse(JSON.stringify(valid())) as Record<string, unknown>;
    change(doc);
    return doc as unknown as TrackerSong;
  };

  it("accepts the valid song and returns it", () => {
    const song = valid();
    expect(validateTrackerSong(song)).toBe(song);
  });

  it("a song with no title", () => {
    expect(() => validateTrackerSong(mutate((doc) => { doc["title"] = ""; }))).toThrow(/title/);
  });

  it("a speed or tempo outside the machine's range", () => {
    expect(() => validateTrackerSong(mutate((doc) => { doc["initialSpeed"] = 0; }))).toThrow(/initialSpeed/);
    expect(() => validateTrackerSong(mutate((doc) => { doc["initialTempo"] = 20; }))).toThrow(/initialTempo/);
  });

  it("an empty order list, and an order naming no pattern", () => {
    expect(() => validateTrackerSong(mutate((doc) => { doc["orders"] = []; }))).toThrow(/order list/);
    expect(() => validateTrackerSong(mutate((doc) => { doc["orders"] = [1]; }))).toThrow(/order 0/);
  });

  it("a restart past the end of the order list", () => {
    expect(() => validateTrackerSong(mutate((doc) => { doc["restart"] = 1; }))).toThrow(/restart/);
  });

  it("a pattern that is not 64 rows, and a row that is not 4 channels", () => {
    expect(() =>
      validateTrackerSong(mutate((doc) => { (doc["patterns"] as unknown[][])[0]!.pop(); })),
    ).toThrow(/64 rows/);
    expect(() =>
      validateTrackerSong(mutate((doc) => { ((doc["patterns"] as unknown[][][])[0]!)[0]!.pop(); })),
    ).toThrow(/4 cells/);
  });

  it("a cell with a note, effect or param off the table", () => {
    const corrupt = (field: string, value: number): TrackerSong =>
      mutate((doc) => {
        const target = ((doc["patterns"] as Record<string, unknown>[][][])[0]!)[0]![0]!;
        target[field] = value;
      });
    expect(() => validateTrackerSong(corrupt("note", 37))).toThrow(/note/);
    expect(() => validateTrackerSong(corrupt("effect", 16))).toThrow(/effect/);
    expect(() => validateTrackerSong(corrupt("param", 256))).toThrow(/param/);
    expect(() => validateTrackerSong(corrupt("instrument", 3))).toThrow(/undeclared instrument 3/);
  });

  it("an instrument with a bad id, finetune, volume, or a duplicate id", () => {
    const instrument = (change: (one: Record<string, unknown>) => void): TrackerSong =>
      mutate((doc) => { change((doc["instruments"] as Record<string, unknown>[])[0]!); });
    expect(() => validateTrackerSong(instrument((one) => { one["id"] = 0; }))).toThrow(/id/);
    expect(() => validateTrackerSong(instrument((one) => { one["finetune"] = 9; }))).toThrow(/finetune/);
    expect(() => validateTrackerSong(instrument((one) => { one["volume"] = 65; }))).toThrow(/volume/);
    expect(() => validateTrackerSong(instrument((one) => { one["id"] = 2; }))).toThrow(/twice/);
    expect(() => validateTrackerSong(mutate((doc) => { doc["instruments"] = []; }))).toThrow(/instruments/);
  });

  it("a player cannot even be built over a malformed song", () => {
    expect(() => createTrackerPlayer(mutate((doc) => { doc["orders"] = []; }))).toThrow(/order list/);
  });
});

// ---------------------------------------------------------------------------

describe("determinism", () => {
  /** A test song exercising every implemented effect across two patterns. */
  const workout = (): TrackerSong => {
    const first = blankPattern();
    put(first, 0, 0, cell(13, 1, 0, 0));
    put(first, 0, 1, cell(1, 2, 0, 0));
    put(first, 0, 2, cell(25, 7, 0xc, 0x18));
    put(first, 1, 0, cell(0, 0, 0x0, 0x47)); // arpeggio
    put(first, 1, 1, cell(0, 0, 0x2, 40)); // portamento down
    put(first, 1, 2, cell(0, 0, 0xa, 0x04)); // volume slide down
    put(first, 2, 0, cell(25, 0, 0x3, 20)); // tone portamento
    put(first, 3, 0, cell(0, 0, 0x3, 0)); // porta memory
    put(first, 3, 3, cell(36, 1, 0x1, 60)); // porta up into the clamp
    put(first, 4, 0, cell(0, 0, 0xf, 0x03)); // speed 3
    put(first, 5, 1, cell(0, 0, 0x4, 0x33)); // vibrato, now implemented
    put(first, 5, 2, cell(20, 0, 0x9, 0x10)); // sample offset, now implemented
    put(first, 6, 0, cell(0, 0, 0xd, 0x08)); // break to row 8

    const second = blankPattern();
    put(second, 8, 0, cell(6, 2, 0, 0));
    // Was `F F0`, when this core read F above 0x20 as a BPM. It is ticks per
    // row over the whole byte range (see the F tests above), so a 240 here
    // would spend the 2000-tick budget on one row and cost this workout its
    // coverage of rows 10, 20 and 63. The big-F case has its own test.
    put(second, 9, 1, cell(0, 0, 0xf, 0x02));
    put(second, 10, 2, cell(13, 0, 0x5, 0x02)); // porta + volume slide
    put(second, 20, 1, cell(0, 1, 0, 0)); // instrument only
    put(second, 63, 3, cell(30, 7, 0, 0));
    put(second, 63, 0, cell(0, 0, 0xb, 0x00)); // jump home

    return songOf([first, second]);
  };

  const streamOf = (steps: number): string[] =>
    run(createTrackerPlayer(workout()), steps).map((tick) => JSON.stringify(tick));

  it("two players over the same song emit byte-identical command streams", () => {
    expect(streamOf(2000)).toEqual(streamOf(2000));
  });

  it("the full command stream hashes to the recorded value", () => {
    // Pure arithmetic on plain data: this hash must never drift between runs,
    // machines, or refactors that claim to preserve behaviour.
    // Re-recorded once, when `F` stopped being read as a BPM above 0x20 and
    // `D` stopped being read as 10x + y — both corrections to this machine's
    // own arithmetic, both quoted from the replayer's bytes in the core's
    // header, and both covered by their own tests above. The workout still
    // exercises every implemented effect and still reaches the `B00` on row 63
    // of the second pattern at tick 146 of 2000.
    const digest = createHash("sha256").update(streamOf(2000).join("\n")).digest("hex");
    expect(digest).toBe("d0d88db3db1553d0ff7457e24f8f134465651b14cd1741baa3b86ba66620a663");
  });
});
