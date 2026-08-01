/**
 * The shell song, held to its contract: it validates against the tracker
 * core's format, names only instruments that exist (both in its own
 * declaration table and in the synthesized bank), keeps every note and
 * every arpeggio offset inside the 36-note period table, loops its order
 * list back to the restart position, and runs the intended length when
 * stepped through the pure core.
 *
 * Same law as tests/audio.test.ts: everything here runs in node with no Web
 * Audio anywhere — the core is pure and the song is data, so the whole
 * piece is verifiable as arithmetic.
 */

import { describe, expect, it } from "vitest";
import {
  NOTES_PER_FINETUNE,
  ROWS_PER_PATTERN,
  TRACKER_CHANNELS,
  TRACKER_MAX_VOLUME,
  MAX_PERIOD,
  MIN_PERIOD,
  createTrackerPlayer,
  periodToHz,
  stepTracker,
  tickDurationSeconds,
  validateTrackerSong,
} from "../src/audio/tracker.js";
import type { TrackerCell, TrackerCommand, TrackerPlayer } from "../src/audio/tracker.js";
import { SHELL_SONG, SHELL_SONG_VOICES } from "../src/audio/shell-song.js";
import { instrumentById } from "../src/audio/instruments.js";

// ---------------------------------------------------------------------------
// Walking the data
// ---------------------------------------------------------------------------

interface CellAt {
  readonly pattern: number;
  readonly row: number;
  readonly channel: number;
  readonly at: TrackerCell;
}

function* everyCell(): Generator<CellAt> {
  for (const [pattern, rows] of SHELL_SONG.patterns.entries()) {
    for (const [row, cells] of rows.entries()) {
      for (const [channel, at] of cells.entries()) {
        yield { pattern, row, channel, at };
      }
    }
  }
}

/**
 * Steps the player through one full pass of the order list: from wherever it
 * stands to the moment the position wraps. The order index only ever moves
 * forward in this song (no Bxx jumps), so a decrease IS the wrap.
 */
function runOnePass(player: TrackerPlayer): { ticks: number; commands: TrackerCommand[] } {
  const commands: TrackerCommand[] = [];
  let ticks = 0;
  let previousOrder = player.order;
  for (;;) {
    commands.push(...stepTracker(player));
    ticks += 1;
    if (player.order < previousOrder) break;
    previousOrder = player.order;
    if (ticks > 1_000_000) throw new Error("the song never wrapped its order list");
  }
  return { ticks, commands };
}

// ---------------------------------------------------------------------------

describe("the shell song data", () => {
  it("passes the format validator", () => {
    expect(validateTrackerSong(SHELL_SONG)).toBe(SHELL_SONG);
  });

  it("gives every declared instrument a voice the synthesized bank can build", () => {
    for (const instrument of SHELL_SONG.instruments) {
      const voice = SHELL_SONG_VOICES[instrument.id];
      expect(voice, `instrument ${instrument.id} has no voice`).toBeDefined();
      // Throws on an unknown id, which is exactly the assertion.
      expect(instrumentById(voice as NonNullable<typeof voice>).samples.length).toBeGreaterThan(0);
    }
    // And the bridge table carries no orphans pointing at nothing.
    expect(Object.keys(SHELL_SONG_VOICES).length).toBe(SHELL_SONG.instruments.length);
  });

  it("references only declared instruments, and plays every one it declares", () => {
    const declared = new Set(SHELL_SONG.instruments.map((one) => one.id));
    const used = new Set<number>();
    for (const { at } of everyCell()) {
      if (at.instrument !== 0) {
        expect(declared.has(at.instrument)).toBe(true);
        used.add(at.instrument);
      }
    }
    expect([...used].sort((a, b) => a - b)).toEqual([...declared].sort((a, b) => a - b));
  });

  it("keeps every note, and every arpeggio offset, inside the period table", () => {
    // The validator bounds the notes; the arpeggio bound is the composer's:
    // effect 0 reaches base + x and base + y semitones, and the composition
    // must not lean on the core's clamp at the table edge. Every arpeggio
    // cell must also have a note sounding on its channel to bend — patterns
    // here are self-contained, so a per-pattern scan proves it.
    for (const [pattern, rows] of SHELL_SONG.patterns.entries()) {
      for (let channel = 0; channel < TRACKER_CHANNELS; channel += 1) {
        let noteIndex = -1;
        for (const [row, cells] of rows.entries()) {
          const at = cells[channel] as TrackerCell;
          if (at.note !== 0) noteIndex = at.note - 1;
          if (at.effect === 0x0 && at.param !== 0) {
            const where = `pattern ${pattern} row ${row} channel ${channel}`;
            expect(noteIndex, `${where}: arpeggio with no note sounding`).toBeGreaterThanOrEqual(0);
            expect(noteIndex + (at.param >> 4), where).toBeLessThan(NOTES_PER_FINETUNE);
            expect(noteIndex + (at.param & 0xf), where).toBeLessThan(NOTES_PER_FINETUNE);
          }
        }
      }
    }
  });

  it("authors every set-volume inside Paula's register", () => {
    for (const { pattern, row, channel, at } of everyCell()) {
      if (at.effect === 0xc) {
        expect(
          at.param,
          `pattern ${pattern} row ${row} channel ${channel} sets volume ${at.param}`,
        ).toBeLessThanOrEqual(TRACKER_MAX_VOLUME);
      }
    }
  });

  it("reaches every pattern it ships and restarts inside the order list", () => {
    const reached = new Set(SHELL_SONG.orders);
    for (let pattern = 0; pattern < SHELL_SONG.patterns.length; pattern += 1) {
      expect(reached.has(pattern), `pattern ${pattern} is never played`).toBe(true);
    }
    expect(SHELL_SONG.restart).toBeGreaterThanOrEqual(0);
    expect(SHELL_SONG.restart).toBeLessThan(SHELL_SONG.orders.length);
    // The restart skips only the intro, so the loop keeps the whole piece.
    expect(SHELL_SONG.restart).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("the shell song under the player core", () => {
  it("loops the order list back to the restart position, at row zero", () => {
    const player = createTrackerPlayer(SHELL_SONG);
    runOnePass(player);
    expect(player.order).toBe(SHELL_SONG.restart);
    expect(player.row).toBe(0);
    expect(player.tick).toBe(0);
  });

  it("runs its intended length: 60-90 seconds to the loop, and per lap after", () => {
    const player = createTrackerPlayer(SHELL_SONG);

    // First pass, intro included. No Fxx in the song, so the tick count is
    // exactly orders x rows x speed — asserted, so a stray speed command
    // cannot slip in and silently bend the piece's length.
    const first = runOnePass(player);
    expect(first.ticks).toBe(
      SHELL_SONG.orders.length * ROWS_PER_PATTERN * SHELL_SONG.initialSpeed,
    );
    const firstSeconds = first.ticks * tickDurationSeconds(player);
    expect(firstSeconds).toBeGreaterThanOrEqual(60);
    expect(firstSeconds).toBeLessThanOrEqual(90);

    // Every lap thereafter re-enters at the restart and stays in range too.
    const lap = runOnePass(player);
    expect(lap.ticks).toBe(
      (SHELL_SONG.orders.length - SHELL_SONG.restart) *
        ROWS_PER_PATTERN *
        SHELL_SONG.initialSpeed,
    );
    const lapSeconds = lap.ticks * tickDurationSeconds(player);
    expect(lapSeconds).toBeGreaterThanOrEqual(60);
    expect(lapSeconds).toBeLessThanOrEqual(90);
  });

  it("produces an identical command schedule every time it is stepped", () => {
    const one = runOnePass(createTrackerPlayer(SHELL_SONG));
    const two = runOnePass(createTrackerPlayer(SHELL_SONG));
    expect(one.ticks).toBe(two.ticks);
    expect(JSON.stringify(one.commands)).toBe(JSON.stringify(two.commands));
  });

  it("sounds all four channels, on declared instruments, inside Paula's range", () => {
    const { commands } = runOnePass(createTrackerPlayer(SHELL_SONG));
    const declared = new Set(SHELL_SONG.instruments.map((one) => one.id));
    const sounded = new Set<number>();
    // Highest table period = lowest rate, and vice versa.
    const lowest = periodToHz(MAX_PERIOD);
    const highest = periodToHz(MIN_PERIOD);

    for (const command of commands) {
      if (command.action === "trigger") {
        sounded.add(command.channel);
        expect(declared.has(command.instrument)).toBe(true);
        expect(command.frequencyHz).toBeGreaterThanOrEqual(lowest);
        expect(command.frequencyHz).toBeLessThanOrEqual(highest);
        expect(command.volume).toBeGreaterThanOrEqual(0);
        expect(command.volume).toBeLessThanOrEqual(TRACKER_MAX_VOLUME);
      } else if (command.action === "pitch") {
        expect(command.frequencyHz).toBeGreaterThanOrEqual(lowest);
        expect(command.frequencyHz).toBeLessThanOrEqual(highest);
      } else {
        expect(command.volume).toBeGreaterThanOrEqual(0);
        expect(command.volume).toBeLessThanOrEqual(TRACKER_MAX_VOLUME);
      }
    }
    expect([...sounded].sort()).toEqual([0, 1, 2, 3]);
  });
});
