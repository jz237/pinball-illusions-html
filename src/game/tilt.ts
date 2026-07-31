/**
 * Nudge and tilt.
 *
 * The player may shove the table to steer a ball, but only so often. The
 * allowance is a per-table option decoded from the original `table00N.opt`
 * files: Law 'n Justice and BabeWatch permit 5, Extreme Sports permits 10.
 * That asymmetry is a real parity detail, not a balance choice, so the value
 * lives with the table rather than being hard-coded here.
 *
 * Warnings decay, as on a real machine — nudging twice across a whole ball is
 * not the same as nudging twice in a second, and a machine that never forgave
 * would be unplayable.
 */

import type { TableId } from "./contracts.js";
import type { Q10 } from "../core/fixed-point.js";
import { pixelsToQ10 } from "../core/fixed-point.js";

export type NudgeDirection = "left" | "right" | "forward";

export interface NudgeConfig {
  /** Nudges tolerated before the table tilts. From `table00N.opt` record 6. */
  readonly allowance: number;
  /** Ticks after which one accumulated warning is forgiven. */
  readonly decayTicks: number;
  /** Ticks a nudge is locked out for, so the key cannot be spammed. */
  readonly cooldownTicks: number;
  /** Impulse applied to every live ball, in Q10 per tick. */
  readonly impulse: Q10;
}

/**
 * Defaults measured from the original option files. Extreme Sports really does
 * ship with double the tolerance.
 */
export const NUDGE_ALLOWANCE_BY_TABLE: Readonly<Record<TableId, number>> = {
  "law-n-justice": 5,
  babewatch: 5,
  "extreme-sports": 10,
};

export function nudgeConfigFor(tableId: TableId): NudgeConfig {
  return {
    allowance: NUDGE_ALLOWANCE_BY_TABLE[tableId],
    decayTicks: 150,
    cooldownTicks: 10,
    impulse: pixelsToQ10(2),
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
