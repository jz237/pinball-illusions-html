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
 * output layer was built with — the synthesized one, or the twelve PCM voices
 * decoded out of the front-end module. A note on an unmapped instrument is a
 * throw, because a silently dropped voice is the bug that survives for
 * months. `restartMs` is the elapsed time at which the player first stood on
 * the song's restart position, so the output layer's repeat re-enters exactly
 * where the module engine's order-list restart field says.
 */
export function renderSongStream(
  song: TrackerSong,
  voices: Readonly<Record<number, string>>,
): TrackerCommandStream {
  const player = createTrackerPlayer(song);
  const commands: StreamCommand[] = [];
  let elapsedMs = 0;
  let restartMs: number | null = null;
  let previousOrder = player.order;

  for (let guard = 0; ; guard += 1) {
    if (guard > MAX_TICKS_PER_PASS) {
      throw new Error(`tracker song "${song.title}" never wrapped its order list`);
    }
    // The restart point is a POSITION, recorded the first time the player
    // stands on it. With restart 0 that is the very first tick, and the
    // whole pass repeats; the shell song's restart 1 skips its intro.
    if (
      restartMs === null &&
      player.order === song.restart &&
      player.row === 0 &&
      player.tick === 0
    ) {
      restartMs = elapsedMs;
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
    // speed or tempo effect re-times the song from the row that set it.
    elapsedMs += tickDurationSeconds(player) * 1000;
    if (player.order < previousOrder) break; // the order list wrapped: pass over
    previousOrder = player.order;
  }

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
const STREAMS = new WeakMap<TrackerSong, TrackerCommandStream>();

export function songStreamFor(
  song: TrackerSong,
  voices: Readonly<Record<number, string>>,
): TrackerCommandStream {
  const cached = STREAMS.get(song);
  if (cached !== undefined) return cached;
  const stream = renderSongStream(song, voices);
  STREAMS.set(song, stream);
  return stream;
}
