/**
 * Nudge and tilt.
 *
 * The player may shove the table to steer a ball, but only so often. Warnings
 * decay, as on a real machine — nudging twice across a whole ball is not the
 * same as nudging twice in a second, and a machine that never forgave would be
 * unplayable.
 *
 * ---------------------------------------------------------------------------
 * THE IMPULSE IS MEASURED
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
 * velocity units, `move.w #$258,$d90(a5)` at +0x00BC42 for the forward shove and
 * `#$258` / `#$FDA8` (-600) at +0x00BCEA / +0x00BCAA for the two sideways ones,
 * with a -200 (`#$FF38` / `#$C8`) recentring bias on the passes where no key is
 * down and an accumulator at $D92/$D94 saturating at +-1000. Through the
 * measured velocity bridge — see `timebase.ts` — 600 units is 2400 Q10 per tick.
 *
 * THE APPLICATION IS THIS PORT'S. `stepBalls` adds the impulse to the ball's
 * velocity rather than biasing the contact frame, because `BallState` has no
 * notion of a cabinet. That makes a shove stronger than the original's, since it
 * moves a ball in flight as well as one in contact; the magnitude is measured
 * and the model is not, and this is the honest way round to have it.
 *
 * ---------------------------------------------------------------------------
 * THE TILT RULE IS NOW MEASURED TOO, AND IT IS NOT A COUNT OF NUDGES
 * ---------------------------------------------------------------------------
 * This file used to tolerate 5 / 5 / 10 nudges per table, and for most of this
 * project's life those numbers were tagged as decoded from `tableNNN.opt`. They
 * were not. They are option record 5's default — a duration in whole SECONDS,
 * ten on Extreme Sports, consumed at +0x0049AE as `option x VBlankFrequency`
 * frames for the ball-start countdown. The same three numbers, meaning something
 * else entirely, which is exactly why the mistake survived eleven commits: every
 * check anyone ran was "do the numbers look like a nudge allowance?", and they
 * did.
 *
 * The real rule is thirteen instructions at the tail of $BC24, entered with no
 * `rts` between it and the flipper loop that precedes it:
 *
 *     00BE90  move.b  $23ef(a5), d0
 *     00BE94  and.b   $23ee(a5), d0      ; a nudge went live THIS pass
 *     00BE98  beq     $beae
 *     00BE9A  move.w  $e8a(a5), d0       ; <- option record 3, SENSITIVITY
 *     00BE9E  add.w   d0, $23f0(a5)      ; warning += sensitivity
 *     00BEA2  cmpi.w  #$c8, $23f0(a5)    ; 200
 *     00BEA8  bcs     $beae
 *     00BEAA  st.b    $23ed(a5)          ; TILT
 *     00BEAE  tst.w   $23f0(a5) / beq / subq.w #1, $23f0(a5)
 *
 * so the option is a SENSITIVITY against a fixed threshold of 200, not a count.
 * Two details decide what that means in nudges, and both were read wrong by the
 * note this replaces:
 *
 * ONE — THE ADD IS PER KEY PRESS, NOT PER NUDGED FRAME. $23EE has all three bits
 * re-armed by `ori.b #$7,$23ee(a5)` at the head of $BC24 (+0x00BC28) on every
 * call, and the per-direction blocks at +0x00BC34, +0x00BC9C and +0x00BCDC do
 * `bset` on $23EF and then `bclr` the matching $23EE bit only when the bset
 * found the bit ALREADY SET. So the AND is non-zero on the pass a direction
 * first goes active and zero on every pass it is held, and the key bytes $ED2 /
 * $EF8 / $EF9 are written only by the keyboard handler's key-down. Holding the
 * key counts once. This port's `wasPressed` is the same rising edge, so the
 * game loop already had this half right.
 *
 * TWO — THE DECAY IS FOUR A FRAME, NOT ONE. $BE90 is the tail of $BC24 and
 * $BC24 is called ONCE PER COLLISION PASS: +0x00A65A, +0x00A6A4, +0x00A6EE and
 * +0x00A736 in the tick at +0x00A614, and four times over in each of the two
 * no-ball paths at +0x00A750 and +0x00A770. Four passes to a 50 Hz frame, so the
 * counter loses 200 a second.
 *
 * WHAT THE SHIPPED MACHINE THEREFORE DOES, with sensitivity 100 against 200:
 *
 *     one nudge   -> 100, drained to nothing in 25 frames, half a second
 *     two nudges  -> CANNOT tilt. 100 + (100 - 4) is 196 at the very best.
 *     three       -> tilts, if the third lands inside about half a second
 *     sensitivity 0 -> the table can never tilt at all
 *     sensitivity 200 -> the first nudge tilts
 *
 * It is not "the second nudge", which is what a threshold of exactly twice the
 * default looks like on paper before the decay is counted. It is the third
 * inside half a second, and it is the same on all three tables — record 3 is
 * byte-identical across `table001.opt`, `table002.opt` and `table003.opt`, so
 * the per-table difference this file used to advertise does not exist.
 */

import type { TableId } from "./contracts.js";
import type { Q10 } from "../core/fixed-point.js";
import { ORIGINAL_COLLISION_PASSES_PER_FRAME, originalVelocityToQ10 } from "./timebase.js";

export type NudgeDirection = "left" | "right" | "forward";

/**
 * The TILT SENSITIVITY option, `tableNNN.opt` record 3: (min 0, max 200,
 * DEFAULT 100). MEASURED; $E8A(a5) has exactly one reader, +0x00BE9A.
 */
export const ORIGINAL_TILT_SENSITIVITY_MIN = 0;
export const ORIGINAL_TILT_SENSITIVITY_MAX = 200;
export const ORIGINAL_TILT_SENSITIVITY_DEFAULT = 100;

/** The threshold the warning counter trips at: `cmpi.w #$c8` at +0x00BEA2. */
export const ORIGINAL_TILT_THRESHOLD = 200;

/** Counts the warning loses per collision pass: `subq.w #1` at +0x00BEB4. */
export const ORIGINAL_TILT_DECAY_PER_PASS = 1;

/**
 * Counts the warning loses per 50 Hz tick: FOUR, one per collision pass.
 *
 * This is the whole difference between "the second nudge tilts" and "the third
 * nudge inside half a second tilts", and it is the reason the rule had to be
 * read out of the call graph rather than out of the routine.
 */
export const TILT_DECAY_PER_TICK =
  ORIGINAL_TILT_DECAY_PER_PASS * ORIGINAL_COLLISION_PASSES_PER_FRAME;

export interface NudgeConfig {
  /** Option record 3: counts added to the warning per shove. MEASURED. */
  readonly sensitivity: number;
  /** The warning value that tilts the table. MEASURED: 200. */
  readonly threshold: number;
  /** Counts the warning loses each tick. MEASURED: four, one per pass. */
  readonly decayPerTick: number;
  /** Ticks a nudge is locked out for while the cabinet recentres. */
  readonly cooldownTicks: number;
  /** Impulse applied to every live ball, in Q10 per tick. */
  readonly impulse: Q10;
}

/**
 * Tilt sensitivity per table: the same on all three, because record 3 is.
 *
 * Kept as a per-table lookup rather than a bare constant so that the day a table
 * IS found to differ there is somewhere for it to go, and so that the shape of
 * this table records what was checked rather than what was assumed.
 */
export const TILT_SENSITIVITY_BY_TABLE: Readonly<Record<TableId, number>> = {
  "law-n-justice": ORIGINAL_TILT_SENSITIVITY_DEFAULT,
  babewatch: ORIGINAL_TILT_SENSITIVITY_DEFAULT,
  "extreme-sports": ORIGINAL_TILT_SENSITIVITY_DEFAULT,
};

/**
 * The shove, in the original's velocity units: 600, MEASURED at +0x00BC42,
 * +0x00BCAA and +0x00BCEA. 2400 Q10 per tick through the bridge in `timebase.ts`.
 */
export const ORIGINAL_NUDGE_UNITS = 600;
export const NUDGE_IMPULSE: Q10 = originalVelocityToQ10(ORIGINAL_NUDGE_UNITS);

/**
 * Passes the cabinet takes to come back to rest after one shove: SEVEN.
 *
 * MEASURED from the accumulator rather than chosen. $D92/$D94 take +600 a pass
 * while the key byte is set and saturate at +-1000 (`cmpi.w #$3e8` at +0x00BC54
 * and +0x00BCFC), which happens on the SECOND pass and also clears the key byte;
 * the recentring bias is then -200 a pass (+0x00BD20 / +0x00BD28) and takes five
 * more passes to reach zero. Seven passes is 1.75 frames, so two ticks, and that
 * is the port's refusal window. It replaces a chosen ten.
 */
export const ORIGINAL_NUDGE_RECENTRE_PASSES = 7;
export const NUDGE_COOLDOWN_TICKS = Math.ceil(
  ORIGINAL_NUDGE_RECENTRE_PASSES / ORIGINAL_COLLISION_PASSES_PER_FRAME,
);

export function nudgeConfigFor(tableId: TableId): NudgeConfig {
  return {
    sensitivity: TILT_SENSITIVITY_BY_TABLE[tableId],
    threshold: ORIGINAL_TILT_THRESHOLD,
    decayPerTick: TILT_DECAY_PER_TICK,
    cooldownTicks: NUDGE_COOLDOWN_TICKS,
    impulse: NUDGE_IMPULSE,
  };
}

export interface TiltState {
  /** $23F0(a5): the warning counter. Reaching `threshold` tilts the table. */
  readonly warning: number;
  readonly tilted: boolean;
  /** Ticks remaining before another nudge is accepted. */
  readonly cooldown: number;
}

export const INITIAL_TILT: TiltState = {
  warning: 0,
  tilted: false,
  cooldown: 0,
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
 *
 * The order is the original's: add, then test, then let `tickTilt` decay. A
 * shove that lands exactly on the threshold tilts on the shove and not a tick
 * later.
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

  const warning = state.warning + config.sensitivity;
  const tilted = warning >= config.threshold;

  const next: TiltState = {
    warning,
    tilted,
    cooldown: config.cooldownTicks,
  };

  // A tilting shove still moves the table; the penalty is what follows.
  const magnitude = config.impulse;
  const impulseX = direction === "left" ? -magnitude : direction === "right" ? magnitude : 0;
  const impulseY = direction === "forward" ? -magnitude : 0;

  return { state: next, impulseX, impulseY, justTilted: tilted, accepted: true };
}

/** Advances cooldown and the warning decay by one tick. */
export function tickTilt(state: TiltState, config: NudgeConfig): TiltState {
  if (state.tilted) {
    // Once tilted the ball is dead; nothing decays until the ball ends.
    return state;
  }

  const cooldown = state.cooldown > 0 ? state.cooldown - 1 : 0;
  const warning = state.warning > config.decayPerTick ? state.warning - config.decayPerTick : 0;
  if (warning === state.warning && cooldown === state.cooldown) return state;
  return { warning, tilted: false, cooldown };
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
