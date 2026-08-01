/**
 * Nudge and tilt.
 *
 * The player may shove the table to steer a ball, but only so often. Warnings
 * decay, as on a real machine — nudging twice across a whole ball is not the
 * same as nudging twice in a second, and a machine that never forgave would be
 * unplayable.
 *
 * ---------------------------------------------------------------------------
 * THE IMPULSE IS MEASURED. THE ALLOWANCE IS NOT, AND USED TO CLAIM IT WAS
 * ---------------------------------------------------------------------------
 * THE IMPULSE. The original does not push the BALL at all: it biases the whole
 * ball-versus-cabinet relative velocity while a collision pass runs. $D8E(a5)
 * and $D90(a5) are added to the ball's velocity at +0x00B4CC, the contact and
 * bounce are resolved on the biased value, and the bias is subtracted again at
 * +0x00B688 before the velocity is stored. A ball in free flight is therefore
 * untouched by a shove and a ball against a rail is thrown off it, which is what
 * a cabinet shove physically does.
 *
 * The MAGNITUDE is a plain constant and is adopted: 600 of the original's
 * velocity units, `move.w #$258,$d90(a5)` at +0x00BC3E for the forward shove and
 * `#$258` / `#$FDA8` (-600) at +0x00BCE6 / +0x00BCA6 for the two sideways ones,
 * with a -200 (`#$FF38` / `#$C8`) recentring bias on the passes where no key is
 * down and an accumulator at $D92/$D94 saturating at +-1000. Through the
 * measured velocity bridge — see `timebase.ts` — 600 units is 2400 Q10 per tick.
 *
 * THE APPLICATION IS THIS PORT'S. `stepBalls` adds the impulse to the ball's
 * velocity rather than biasing the contact frame, because `BallState` has no
 * notion of a cabinet. That makes a shove stronger than the original's, since it
 * moves a ball in flight as well as one in contact; the magnitude is measured
 * and the model is not, and this is the honest way round to have it. The value
 * was 2048 (two pixels a tick) and chosen; 2400 is measured and near enough to
 * it that nothing about the feel of a shove changes.
 *
 * THE ALLOWANCE. This file used to say the 5 / 5 / 10 below came from
 * `table00N.opt` record 6. It does not, and record 6 is not a nudge count: the
 * option records are, zero-indexed, 0 balls-per-game, 1 GRAVITY, 2 camera scroll
 * divisor, 3 tilt sensitivity, 4 table x-tilt, 5 a duration in whole seconds,
 * 6 a 0..2 mode selector. The 5 / 5 / 10 is record 5's default, which is a
 * duration in SECONDS (10 on Extreme Sports) consumed at +0x0049AE as
 * `option x $50(a5)` frames — the same numbers, meaning something else entirely,
 * which is exactly why the mistake survived.
 *
 * The original's real tilt rule is at +0x00BE9A and is a different mechanism:
 * every nudged frame adds record 3's value ($E8A, min 0, max 200, DEFAULT 100)
 * to a warning counter that decays by one per frame and trips TILT at 200, so
 * the shipped machine tilts on the SECOND nudge and the option is a sensitivity
 * rather than a count. Implementing that is a behaviour change well outside a
 * timebase audit — it would make the table roughly twice as touchy — so the
 * counts below stay as they are and are now labelled for what they are: this
 * port's own, and no longer wearing someone else's provenance.
 */

import type { TableId } from "./contracts.js";
import type { Q10 } from "../core/fixed-point.js";
import { originalVelocityToQ10 } from "./timebase.js";

export type NudgeDirection = "left" | "right" | "forward";

export interface NudgeConfig {
  /** Nudges tolerated before the table tilts. This port's own — see the header. */
  readonly allowance: number;
  /** Ticks after which one accumulated warning is forgiven. */
  readonly decayTicks: number;
  /** Ticks a nudge is locked out for, so the key cannot be spammed. */
  readonly cooldownTicks: number;
  /** Impulse applied to every live ball, in Q10 per tick. */
  readonly impulse: Q10;
}

/**
 * Nudges tolerated per table. CHOSEN, not measured — see the header for what
 * these numbers were mistaken for and what the original's tilt rule actually is.
 */
export const NUDGE_ALLOWANCE_BY_TABLE: Readonly<Record<TableId, number>> = {
  "law-n-justice": 5,
  babewatch: 5,
  "extreme-sports": 10,
};

/**
 * The shove, in the original's velocity units: 600, MEASURED at +0x00BC3E,
 * +0x00BCA6 and +0x00BCE6. 2400 Q10 per tick through the bridge in `timebase.ts`.
 */
export const ORIGINAL_NUDGE_UNITS = 600;
export const NUDGE_IMPULSE: Q10 = originalVelocityToQ10(ORIGINAL_NUDGE_UNITS);

export function nudgeConfigFor(tableId: TableId): NudgeConfig {
  return {
    allowance: NUDGE_ALLOWANCE_BY_TABLE[tableId],
    decayTicks: 150,
    cooldownTicks: 10,
    impulse: NUDGE_IMPULSE,
  };
}

export interface TiltState {
  /** Accumulated warnings; reaching the allowance tilts the table. */
  readonly warnings: number;
  readonly tilted: boolean;
  /** Ticks remaining before another nudge is accepted. */
  readonly cooldown: number;
  /** Ticks since the last warning, used to forgive over time. */
  readonly sinceWarning: number;
}

export const INITIAL_TILT: TiltState = {
  warnings: 0,
  tilted: false,
  cooldown: 0,
  sinceWarning: 0,
};

export interface NudgeOutcome {
  readonly state: TiltState;
  /** Impulse to apply to live balls this tick; zero when the nudge was refused. */
  readonly impulseX: Q10;
  readonly impulseY: Q10;
  /** True only on the tick the table tips over, so the caller can play the cue once. */
  readonly justTilted: boolean;
  readonly accepted: boolean;
}

/**
 * Attempts a nudge.
 *
 * A refused nudge — during cooldown, or once tilted — still returns state so
 * the caller can treat every tick uniformly.
 */
export function nudge(
  state: TiltState,
  direction: NudgeDirection,
  config: NudgeConfig,
): NudgeOutcome {
  const refuse = (): NudgeOutcome => ({
    state,
    impulseX: 0,
    impulseY: 0,
    justTilted: false,
    accepted: false,
  });

  if (state.tilted || state.cooldown > 0) return refuse();

  const warnings = state.warnings + 1;
  const tilted = warnings >= config.allowance;

  const next: TiltState = {
    warnings,
    tilted,
    cooldown: config.cooldownTicks,
    sinceWarning: 0,
  };

  // A tilting shove still moves the table; the penalty is what follows.
  const magnitude = config.impulse;
  const impulseX = direction === "left" ? -magnitude : direction === "right" ? magnitude : 0;
  const impulseY = direction === "forward" ? -magnitude : 0;

  return { state: next, impulseX, impulseY, justTilted: tilted, accepted: true };
}

/** Advances cooldown and warning decay by one tick. */
export function tickTilt(state: TiltState, config: NudgeConfig): TiltState {
  if (state.tilted) {
    // Once tilted the ball is dead; nothing decays until the ball ends.
    return state;
  }

  const cooldown = state.cooldown > 0 ? state.cooldown - 1 : 0;

  if (state.warnings === 0) {
    return { ...state, cooldown, sinceWarning: 0 };
  }

  const sinceWarning = state.sinceWarning + 1;
  if (sinceWarning >= config.decayTicks) {
    return { warnings: state.warnings - 1, tilted: false, cooldown, sinceWarning: 0 };
  }

  return { ...state, cooldown, sinceWarning };
}

/** Clears tilt for the next ball. Warnings do not carry across balls. */
export function resetTiltForNewBall(): TiltState {
  return INITIAL_TILT;
}

/** While tilted the flippers are dead and nothing scores. */
export function flippersLive(state: TiltState): boolean {
  return !state.tilted;
}

export function scoringLive(state: TiltState): boolean {
  return !state.tilted;
}
