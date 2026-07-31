/**
 * Fixed-timestep scheduler.
 *
 * The Amiga original was locked to the PAL vertical blank: one simulation step
 * per field, 50 per second. Every constant in the physics — gravity per tick,
 * flipper travel, nudge cooldowns — is calibrated against that step, so the
 * browser port must run the same number of steps per second of wall clock no
 * matter what rate the display refreshes at. This module is the only place that
 * converts real time into simulation ticks; everything downstream counts ticks
 * and never looks at a clock.
 *
 * Two properties matter more than anything else here:
 *
 * 1. No drift. The tick rate is an exact ratio of integers (ticks per N
 *    nanoseconds) and the leftover time is carried as an exact integer, never a
 *    float. A float period such as 1/60 s is unrepresentable in binary, so
 *    accumulating it loses a tick roughly every few hours of play; an exact
 *    ratio cannot. The accumulator is a bigint so a tab left backgrounded for
 *    days cannot push the intermediate product past the safe-integer range.
 *
 * 2. No negative or unbounded work. A backgrounded tab hands back a timestamp
 *    minutes in the future; running every skipped tick would freeze the page and
 *    tunnel balls through walls. The burst is capped and the discarded ticks are
 *    reported, so a caller can distinguish "the machine is running slow" (ticks
 *    at the cap, no drops) from "time was skipped" (drops), which are very
 *    different bugs.
 */

/**
 * An exact tick rate: `ticks` simulation ticks every `perNanos` nanoseconds.
 *
 * Kept as a ratio rather than a period because most interesting rates have no
 * exact integer period. If the true Amiga PAL field rate is ever measured to be
 * something other than a round 50 Hz, it drops in here as a ratio without any
 * change to the arithmetic below.
 */
export interface TickRate {
  readonly ticks: number;
  readonly perNanos: number;
}

export const NANOS_PER_SECOND = 1_000_000_000;
export const NANOS_PER_MILLISECOND = 1_000_000;

/** PAL field rate, the original's simulation step. */
export const PAL_TICK_RATE: TickRate = { ticks: 50, perNanos: NANOS_PER_SECOND };

/**
 * Ceiling on ticks emitted from a single `advance`.
 *
 * Eight is a sixth of a second of catch-up: enough to ride out a garbage
 * collection pause or a slow frame without visibly stalling, far short of the
 * point where a ball moving at speed would step through a wall.
 */
export const DEFAULT_MAX_CATCH_UP_TICKS = 8;

/** How much simulation to run for one real frame. */
export interface TickBatch {
  /** Ticks to run now; never negative, never above `maxCatchUpTicks`. */
  readonly ticks: number;
  /** Ticks the burst clamp threw away. Non-zero means real time was skipped. */
  readonly droppedTicks: number;
}

export interface FixedStepSchedulerOptions {
  readonly rate?: TickRate;
  readonly maxCatchUpTicks?: number;
  /**
   * Timestamp to treat as t=0. Omit to seed from the first `advance` call,
   * which is usually what you want: the first animation-frame timestamp is an
   * arbitrary page-load offset and charging it would emit a spurious burst.
   */
  readonly startNanos?: number;
}

const EMPTY_BATCH: TickBatch = { ticks: 0, droppedTicks: 0 };

/** Converts a `performance.now()`-style millisecond reading to nanoseconds. */
export function millisecondsToNanos(milliseconds: number): number {
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`timestamp must be finite: ${milliseconds}`);
  }
  return Math.round(milliseconds * NANOS_PER_MILLISECOND);
}

/**
 * Floors a timestamp to whole nanoseconds.
 *
 * Timestamps are absolute rather than deltas, so truncating each one loses at
 * most a nanosecond overall instead of compounding — and browser clocks are
 * deliberately coarsened well above that anyway.
 */
function wholeNanos(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`timestamp must be finite: ${value}`);
  }
  const whole = Math.floor(value);
  if (!Number.isSafeInteger(whole)) {
    throw new RangeError(`timestamp out of safe integer range: ${value}`);
  }
  return whole;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer: ${value}`);
  }
  return value;
}

export class FixedStepScheduler {
  readonly #rate: TickRate;
  readonly #rateTicks: bigint;
  readonly #ratePerNanos: bigint;
  readonly #maxCatchUpTicks: number;
  readonly #maxCatchUpTicksBig: bigint;

  /**
   * Unconsumed time in units of one `rate.ticks`-th of a nanosecond, held below
   * `rate.perNanos` — that scaling is what makes an inexact tick period exact
   * to store. This is the value that must survive a pause.
   */
  #accumulator = 0n;
  #lastNanos = 0;
  #seeded = false;
  #paused = false;
  #totalTicks = 0;
  #totalDroppedTicks = 0;

  constructor(options: FixedStepSchedulerOptions = {}) {
    const rate = options.rate ?? PAL_TICK_RATE;
    requirePositiveInteger(rate.ticks, "rate.ticks");
    requirePositiveInteger(rate.perNanos, "rate.perNanos");

    this.#rate = { ticks: rate.ticks, perNanos: rate.perNanos };
    this.#rateTicks = BigInt(rate.ticks);
    this.#ratePerNanos = BigInt(rate.perNanos);

    this.#maxCatchUpTicks = requirePositiveInteger(
      options.maxCatchUpTicks ?? DEFAULT_MAX_CATCH_UP_TICKS,
      "maxCatchUpTicks",
    );
    this.#maxCatchUpTicksBig = BigInt(this.#maxCatchUpTicks);

    if (options.startNanos !== undefined) {
      this.#lastNanos = wholeNanos(options.startNanos);
      this.#seeded = true;
    }
  }

  get rate(): TickRate {
    return this.#rate;
  }

  get maxCatchUpTicks(): number {
    return this.#maxCatchUpTicks;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Ticks emitted since construction or the last `reset`. */
  get totalTicks(): number {
    return this.#totalTicks;
  }

  /** Ticks discarded by the burst clamp since construction or the last `reset`. */
  get totalDroppedTicks(): number {
    return this.#totalDroppedTicks;
  }

  /** Carried-over time in nanoseconds; always less than one tick period. */
  get remainderNanos(): number {
    return Number(this.#accumulator) / this.#rate.ticks;
  }

  /** Whole nanoseconds per tick as a float — for display only, never for timing. */
  get tickPeriodNanos(): number {
    return this.#rate.perNanos / this.#rate.ticks;
  }

  /**
   * Sub-tick phase in [0, 1), for interpolating the render between two
   * simulation states. Deliberately a float: it never feeds back into the
   * simulation, so it cannot affect replay determinism.
   */
  get interpolation(): number {
    return Number(this.#accumulator) / this.#rate.perNanos;
  }

  /**
   * Converts elapsed real time into a whole number of ticks to run.
   *
   * Backwards or repeated timestamps yield an empty batch rather than rewinding
   * the timeline, so no caller ever sees a negative count.
   */
  advance(nowNanos: number): TickBatch {
    const now = wholeNanos(nowNanos);

    if (this.#paused) {
      return EMPTY_BATCH;
    }

    if (!this.#seeded) {
      this.#lastNanos = now;
      this.#seeded = true;
      return EMPTY_BATCH;
    }

    if (now <= this.#lastNanos) {
      return EMPTY_BATCH;
    }

    const elapsedNanos = BigInt(now - this.#lastNanos);
    this.#lastNanos = now;

    this.#accumulator += elapsedNanos * this.#rateTicks;
    // Both operands are positive, so bigint truncation is a floor.
    const pending = this.#accumulator / this.#ratePerNanos;
    // Charge the full amount even for the ticks the clamp is about to discard:
    // banking them would make the next frame overflow too, forever.
    this.#accumulator -= pending * this.#ratePerNanos;

    const granted = pending > this.#maxCatchUpTicksBig ? this.#maxCatchUpTicksBig : pending;
    const ticks = Number(granted);
    const droppedTicks = Number(pending - granted);

    this.#totalTicks += ticks;
    this.#totalDroppedTicks += droppedTicks;

    return { ticks, droppedTicks };
  }

  /**
   * Stops accumulating. The fractional remainder is kept, so resuming lands on
   * the same sub-tick phase the pause interrupted.
   */
  pause(): void {
    this.#paused = true;
  }

  /**
   * Resumes without charging the paused wall time.
   *
   * Pass the current timestamp when you have one. Omitting it re-seeds on the
   * next `advance`, which is the safe default — time spent paused must never
   * become simulation ticks.
   */
  resume(nowNanos?: number): void {
    this.#paused = false;
    if (nowNanos === undefined) {
      this.#seeded = false;
      return;
    }
    this.#lastNanos = wholeNanos(nowNanos);
    this.#seeded = true;
  }

  /**
   * Discards carried time and counters, for a fresh game or a replay rewind.
   * Unlike `pause`, this deliberately drops the remainder: a replay must start
   * from a known phase to reproduce.
   */
  reset(nowNanos?: number): void {
    this.#accumulator = 0n;
    this.#totalTicks = 0;
    this.#totalDroppedTicks = 0;
    this.#paused = false;
    if (nowNanos === undefined) {
      this.#lastNanos = 0;
      this.#seeded = false;
      return;
    }
    this.#lastNanos = wholeNanos(nowNanos);
    this.#seeded = true;
  }
}
