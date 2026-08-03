/**
 * The SHELL's clock: 50 Hz, whatever the screen runs at.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS TO CLOSE
 * ---------------------------------------------------------------------------
 * The simulation has run on a fixed step since the beginning — `GameLoop.frame`
 * asks `FixedStepScheduler` how much real time has passed and runs exactly that
 * many 1/50 s ticks — but the SHELL never did. `src/main.ts` advanced it one
 * tick per animation frame, so every clock in the front end ran at the display's
 * refresh rate:
 *
 *     60 Hz    1.2x fast   a credits page every 2.93 s
 *    120 Hz    2.4x fast   a credits page every 1.47 s
 *    144 Hz    2.88x fast  a credits page every 1.22 s
 *
 * against the filmed 176 frames = 3.52 s, which
 * `research\view\reference\session3` measured on every one of the 112
 * start-to-start intervals of a 399 s continuous take and all 55 of an
 * independent cold boot, with no variation at all. Everything downstream moved
 * with it: the per-page hold of 101 + 2*(K_min + 1) frames, the erase front's
 * 4 rows a frame, the backdrop's 2058-frame palette lap against the 2112-frame
 * page lap — the two are incommensurate on purpose, and running both fast keeps
 * the ratio but destroys the wall-clock beat the film measured — and the band
 * scroll's C, which steps one 32-px object every 128 frames.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS THE SAME SCHEDULER AND NOT A SECOND IMPLEMENTATION
 * ---------------------------------------------------------------------------
 * `FixedStepScheduler` already converts real time into whole ticks without
 * drift (an exact integer ratio carried in a bigint) and clamps the burst a
 * backgrounded tab would otherwise hand back. Those two properties are exactly
 * as load-bearing here as in the physics: a shell left running for an hour must
 * have turned 1023 pages, not 1022, and a tab that comes back after ten minutes
 * must not run thirty thousand shell ticks in one frame. So this is a thin
 * wrapper, not a parallel mechanism.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A SEPARATE CLOCK FROM THE SIMULATION'S
 * ---------------------------------------------------------------------------
 * They are the same RATE and must never be the same ACCUMULATOR. In `play` the
 * shell is advanced by the number of ticks the simulation actually ran, so the
 * two cannot drift apart while a ball is on the table; everywhere else the
 * simulation is stopped dead and its scheduler paused, so the wall time spent in
 * a menu is not banked as catch-up against the next ball. One accumulator could
 * not do both — pausing it for the menus would freeze the credits roll, and not
 * pausing it would fast-forward the ball. The host therefore pauses whichever of
 * the two is not driving, and `pause` keeps the sub-tick remainder while
 * `resume` re-seeds, so neither one charges for the time it was not running.
 */

import { FixedStepScheduler, millisecondsToNanos } from "../core/fixed-step-scheduler.js";
import type { FixedStepSchedulerOptions } from "../core/fixed-step-scheduler.js";
import { shellTick } from "./shell.js";
import type { ScoreStore, ShellEffect, ShellState } from "./shell.js";

export class ShellClock {
  readonly #scheduler: FixedStepScheduler;

  /**
   * Defaults to `PAL_TICK_RATE` and the simulation's own catch-up clamp. The
   * clamp matters for the same reason it does there: a hidden tab hands back a
   * timestamp minutes in the future, and running every skipped shell tick would
   * spin the credits through hundreds of pages in one frame.
   */
  constructor(options: FixedStepSchedulerOptions = {}) {
    this.#scheduler = new FixedStepScheduler(options);
  }

  /** Shell ticks run since construction. */
  get totalTicks(): number {
    return this.#scheduler.totalTicks;
  }

  /** Ticks the catch-up clamp discarded — real time the shell never ran. */
  get droppedTicks(): number {
    return this.#scheduler.totalDroppedTicks;
  }

  get paused(): boolean {
    return this.#scheduler.paused;
  }

  /**
   * One animation frame: converts elapsed real time into whole shell ticks and
   * runs exactly that many, returning whatever the shell asked the host to do.
   *
   * Resumes itself, because the host pauses this clock for every frame the
   * playfield is driving the shell instead and a caller should not have to
   * remember the crossing in two places. `resume()` with no timestamp re-seeds
   * on the next `advance`, so the time spent in `play` is never charged here.
   */
  frame(timeMs: number, state: ShellState, store: ScoreStore): readonly ShellEffect[] {
    if (this.#scheduler.paused) this.#scheduler.resume();
    const batch = this.#scheduler.advance(millisecondsToNanos(timeMs));
    return shellTick(state, store, batch.ticks);
  }

  /** Stops accumulating, keeping the sub-tick remainder. */
  pause(): void {
    this.#scheduler.pause();
  }

  /** Starts accumulating again without charging for the pause. */
  resume(timeMs?: number): void {
    if (timeMs === undefined) {
      this.#scheduler.resume();
      return;
    }
    this.#scheduler.resume(millisecondsToNanos(timeMs));
  }
}
