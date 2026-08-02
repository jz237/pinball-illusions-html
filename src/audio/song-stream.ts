/**
 * THE BRIDGE between the pure tracker core and the browser output layer.
 *
 * `tracker.ts` speaks in per-tick channel commands and owns no clock;
 * `tracker-output.ts` consumes a finished, millisecond-timed command stream.
 * This module is the affine map between them: it steps a song through the
 * core for exactly one pass of its order list, stamps each command with the
 * elapsed time at its tick, and packages the result as a
 * `TrackerCommandStream` the output layer can schedule.
 *
 * Same law as everything beside it: pure and deterministic. No Web Audio, no
 * clock, no I/O — the caller gets identical bytes for identical songs, which
 * is what lets a node test hold the whole pipeline down to arithmetic. The
 * browser calls this once and hands the value to `startTracker`; the loop
 * from `restartMs` is then the output layer's business.
 */

import {
  createTrackerPlayer,
  stepTracker,
  tickDurationSeconds,
} from "./tracker.js";
import type { TrackerSong } from "./tracker.js";
import type { TrackerCommand as StreamCommand, TrackerCommandStream } from "./tracker-output.js";

/** A hard stop against a song whose order list never wraps. */
const MAX_TICKS_PER_PASS = 1_000_000;

/**
 * Renders one full pass of `song` — from order 0 to the moment the position
 * wraps back into the order list — as a timed command stream.
 *
 * `voices` maps the song's instrument numbers to the ids of whatever BANK the
 * output layer was built with — the synthesized one, or the PCM voices decoded
 * out of the front-end module. A note on an unmapped instrument is a throw,
 * because a silently dropped voice is the bug that survives for months.
 *
 * `restartMs` IS WHERE THE LOOP RE-ENTERS, AND IT IS MEASURED, NOT DECLARED.
 * A pass ends when the order position goes backwards, and the position it goes
 * back TO is the loop entry — whichever mechanism took it there. That covers
 * both of the machine's two wraps with one rule: running off the end of the
 * order list, which $8138-$814A sends to position 0, and a `Bxx`, which
 * $8182 sends to the param. The front-end module's own restart byte is 127
 * against 54 orders — ProTracker's "unused" marker — and its loop is the `B13`
 * on the last row of order 51, so the entry is order 19 and the lead-in ahead
 * of it is never replayed. A song that simply falls off its order list still
 * restarts at millisecond 0, exactly as before.
 *
 * `startOrder` is where the PROGRAM enters the module, which is not always 0
 * and is not the module's business: the replayer takes a start position in d0
 * ($79EA, and intro.seg00's own copy). The front-end module is entered at
 * order 17 — see `shell-music.ts` and the exporter for the measurement.
 */
export function renderSongStream(
  song: TrackerSong,
  voices: Readonly<Record<number, string>>,
  startOrder = 0,
): TrackerCommandStream {
  const player = createTrackerPlayer(song, startOrder);
  const commands: StreamCommand[] = [];
  let elapsedMs = 0;
  let previousOrder = player.order;
  /** Order position -> the elapsed time it was first entered at, row 0 tick 0. */
  const enteredMs = new Map<number, number>();

  for (let guard = 0; ; guard += 1) {
    if (guard > MAX_TICKS_PER_PASS) {
      throw new Error(`tracker song "${song.title}" never wrapped its order list`);
    }
    if (player.row === 0 && player.tick === 0 && !enteredMs.has(player.order)) {
      enteredMs.set(player.order, elapsedMs);
    }

    for (const command of stepTracker(player)) {
      switch (command.action) {
        case "trigger": {
          const voice = voices[command.instrument];
          if (voice === undefined) {
            throw new Error(
              `tracker song "${song.title}" instrument ${command.instrument} has no synthesized voice`,
            );
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

    // The tick that just played lasts the player's CURRENT tick length, so a
    // speed effect re-times the song from the row that set it.
    elapsedMs += tickDurationSeconds(player) * 1000;
    if (player.order < previousOrder) break; // the order list wrapped: pass over
    previousOrder = player.order;
  }

  // The wrap has landed the player on the loop entry. It was necessarily
  // entered once already on the way here, so the lookup answers; a song that
  // somehow jumped somewhere it had never been replays from the top.
  const restartMs = enteredMs.get(player.order) ?? 0;
  return { commands, durationMs: elapsedMs, restartMs };
}

/**
 * `renderSongStream` memoised on the song object.
 *
 * The shell renders its stream once and replays it every time the attract
 * screen comes back; a few thousand ticks of arithmetic is cheap but there is
 * no reason to redo it. Keyed on the song rather than held in a module-level
 * variable, because there is no longer exactly ONE song — the front-end module
 * is loaded at runtime and a test may render a fixture beside it.
 */
const STREAMS = new WeakMap<TrackerSong, Map<number, TrackerCommandStream>>();

export function songStreamFor(
  song: TrackerSong,
  voices: Readonly<Record<number, string>>,
  startOrder = 0,
): TrackerCommandStream {
  // Keyed on the START ORDER as well as the song: the same module entered at a
  // different position is a different stream, with a different length and a
  // different restart point, and a memo that ignored that would hand the
  // second caller the first caller's song.
  let byStart = STREAMS.get(song);
  if (byStart === undefined) {
    byStart = new Map<number, TrackerCommandStream>();
    STREAMS.set(song, byStart);
  }
  const cached = byStart.get(startOrder);
  if (cached !== undefined) return cached;
  const stream = renderSongStream(song, voices, startOrder);
  byStart.set(startOrder, stream);
  return stream;
}
