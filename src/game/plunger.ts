/**
 * The plunger: serving a ball into the shooter lane and firing it out again.
 *
 * A pull-and-release spring. Holding the control winds charge up to a ceiling;
 * letting go converts that charge into upward velocity. The player therefore
 * aims by timing, which is the only skill the launch offers, so the mapping
 * from charge to speed is linear and the charge itself accumulates at a fixed
 * rate per tick — nothing here reads a clock. A hold of N ticks always produces
 * exactly the same launch, on every machine, which is what lets a recorded
 * input log reproduce a whole ball.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PLUNGER OWNS AN "ARMED" FLAG RATHER THAN JUST A CHARGE LEVEL
 * ---------------------------------------------------------------------------
 * The interesting failure is a double fire. The input layer reports "released
 * this tick" as an edge, and edges can arrive without a matching press: the
 * page regains focus mid-release, a gamepad is unplugged, two sources bound to
 * the same control let go one after the other. If firing were simply "released
 * and charge > 0" then a stray release would launch a ball that is already in
 * play. So a launch requires the plunger to be *pulling*, and firing clears
 * that flag in the same step. A release with nothing pulled is a no-op.
 *
 * ---------------------------------------------------------------------------
 * WHY A TAP SHORTER THAN A TICK STILL FIRES
 * ---------------------------------------------------------------------------
 * At 50 Hz a tick is 20 ms, and a deliberate flick of the plunger key is easily
 * shorter than that. The input layer buffers the press and the release into the
 * same snapshot, and this module charges *before* it tests for release, so a
 * press and release inside one tick still banks one tick of charge and fires a
 * gentle nudge rather than being swallowed. That gentle nudge is deliberately
 * feeble: `minLaunchSpeed` moves the ball about twenty pixels up a five-hundred
 * pixel lane, so a fumbled tap costs the player the plunge instead of silently
 * doing nothing at all.
 */

import type { BallState, TableId } from "./contracts.js";
import type { BallSet } from "./ball-physics.js";
import { spawnBall } from "./ball-physics.js";
import type { Q10 } from "../core/fixed-point.js";
import { Q10_ONE, pixelsToQ10, q10Clamp, q10Multiply } from "../core/fixed-point.js";

/** Charge is a Q10 fraction, so a full pull is 1.0 in Q10. */
export const PLUNGER_FULL_CHARGE: Q10 = Q10_ONE;

/**
 * Ticks of holding needed to reach a full pull: 32 ticks, near enough to two
 * thirds of a second at the PAL step. Fast enough that the launch never feels
 * like a loading bar, slow enough that the meter is readable and the player can
 * actually aim at a fraction of it.
 *
 * 1024 divides by 32 exactly, so the charge lands on the ceiling rather than
 * near it and "held long enough" is an exact comparison, not an approximate one.
 */
export const PLUNGER_CHARGE_TICKS = 32;

/** Q10 charge added per tick while the plunger is pulled back. */
export const PLUNGER_CHARGE_RATE: Q10 = PLUNGER_FULL_CHARGE / PLUNGER_CHARGE_TICKS;

/**
 * The shooter lane, as free ball-centre bounds measured against the collision
 * layer of the shipped map. These are centres, not lane walls: the ball has a
 * radius of 8, so the physical channel is 16 pixels wider than this box.
 */
export interface ShooterLane {
  /** Leftmost and rightmost free centre column. */
  readonly minCentreX: number;
  readonly maxCentreX: number;
  /** Topmost and bottommost free centre row of the unbroken channel. */
  readonly topY: number;
  readonly bottomY: number;
  readonly confidence: "measured" | "assumed";
}

/**
 * Law 'n Justice's shooter lane: a narrow full-height channel on the right of
 * the playfield, free centres spanning x=285..296 unbroken from y=4 to y=556.
 */
export const LAW_N_JUSTICE_SHOOTER_LANE: ShooterLane = Object.freeze({
  minCentreX: 285,
  maxCentreX: 296,
  topY: 4,
  bottomY: 556,
  confidence: "measured",
});

/**
 * How far above the bottom of the channel a served ball appears.
 *
 * One ball radius. Serving hard against the floor of the lane would put the
 * probe ring in contact on the very first tick, and the ball would resolve that
 * contact before the player ever touched the plunger; an inset lets it settle
 * onto the floor under gravity the way the original's serve does.
 */
export const SERVE_INSET_PIXELS = 8;

/**
 * Per-table lanes. Only Law 'n Justice has been measured off the map; the other
 * two carry the same geometry marked `assumed` rather than a fabricated
 * measurement, so a wrong serve position is visible in the data instead of
 * hidden in a constant. Callers that care can refuse to serve on an assumption.
 */
export const SHOOTER_LANE_BY_TABLE: Readonly<Record<TableId, ShooterLane>> = Object.freeze({
  "law-n-justice": LAW_N_JUSTICE_SHOOTER_LANE,
  babewatch: Object.freeze({ ...LAW_N_JUSTICE_SHOOTER_LANE, confidence: "assumed" as const }),
  "extreme-sports": Object.freeze({ ...LAW_N_JUSTICE_SHOOTER_LANE, confidence: "assumed" as const }),
});

export function shooterLaneFor(tableId: TableId): ShooterLane {
  return SHOOTER_LANE_BY_TABLE[tableId];
}

/**
 * Gravity the launch speeds below were calibrated against, in Q10 per tick.
 *
 * Recorded here because `maxLaunchSpeed` is only meaningful relative to a pull
 * of gravity: if the simulation's gravity is ever re-measured, the launch
 * ceiling has to move with it or a full plunge stops reaching the top of the
 * lane. This constant is what makes that dependency checkable instead of
 * folklore.
 */
export const PLUNGER_REFERENCE_GRAVITY: Q10 = 24;

/**
 * Slowest launch, one pixel per tick.
 *
 * Against the reference gravity that carries the ball roughly twenty pixels up
 * the lane before it falls back — a visible dribble, not a launch. This is what
 * a sub-tick tap gets.
 */
export const MIN_LAUNCH_SPEED = pixelsToQ10(1);

/**
 * Fastest launch, six pixels per tick.
 *
 * With gravity applied before each integration step, a launch at v rises
 * v^2/(2g) - v/2 units before stalling. Reaching the top of Law 'n Justice's
 * lane from the serve point — about 540 pixels, or 552,960 Q10 — needs v = 5164
 * against g = 24. Six pixels per tick clears that with room to spare, so a full
 * plunge leaves the lane still moving and feeds the playfield instead of dying
 * at the mouth. It is also well inside the signed-16-bit velocity range and
 * only two substeps of the anti-tunnelling limit, so nothing clips a wall.
 */
export const MAX_LAUNCH_SPEED = pixelsToQ10(6);

export interface PlungerConfig {
  /** Q10 charge gained per tick while pulling. */
  readonly chargeRate: Q10;
  /** Q10 units per tick launched at zero charge. */
  readonly minLaunchSpeed: number;
  /** Q10 units per tick launched at a full pull. */
  readonly maxLaunchSpeed: number;
  /** Where a new ball appears, in Q10 playfield coordinates. */
  readonly serveX: Q10;
  readonly serveY: Q10;
  /** Whether the serve point comes from a measured lane or an assumed one. */
  readonly laneConfidence: ShooterLane["confidence"];
}

/**
 * Builds the config for a table's lane.
 *
 * The serve column is the centre of the free span rather than either edge, so
 * the ball is clear of both lane walls whichever side the channel is measured
 * from.
 */
export function plungerConfigForLane(lane: ShooterLane): PlungerConfig {
  if (lane.minCentreX > lane.maxCentreX || lane.topY > lane.bottomY) {
    throw new RangeError("shooter lane bounds are inverted");
  }
  const centreX = (lane.minCentreX + lane.maxCentreX) >> 1;
  const serveRow = lane.bottomY - SERVE_INSET_PIXELS;
  if (serveRow < lane.topY) {
    throw new RangeError(`shooter lane is too short to serve into: ${JSON.stringify(lane)}`);
  }
  return {
    chargeRate: PLUNGER_CHARGE_RATE,
    minLaunchSpeed: MIN_LAUNCH_SPEED,
    maxLaunchSpeed: MAX_LAUNCH_SPEED,
    serveX: pixelsToQ10(centreX),
    serveY: pixelsToQ10(serveRow),
    laneConfidence: lane.confidence,
  };
}

export function plungerConfigFor(tableId: TableId): PlungerConfig {
  return plungerConfigForLane(shooterLaneFor(tableId));
}

export const DEFAULT_PLUNGER_CONFIG: PlungerConfig = plungerConfigFor("law-n-justice");

/** Rejects a config that could never produce a sane launch. */
export function validatePlungerConfig(config: PlungerConfig): PlungerConfig {
  if (!Number.isInteger(config.chargeRate) || config.chargeRate <= 0) {
    throw new RangeError(`chargeRate must be a positive integer: ${config.chargeRate}`);
  }
  if (config.minLaunchSpeed < 0) {
    throw new RangeError(`minLaunchSpeed must not be negative: ${config.minLaunchSpeed}`);
  }
  if (config.maxLaunchSpeed < config.minLaunchSpeed) {
    throw new RangeError(
      `maxLaunchSpeed ${config.maxLaunchSpeed} is below minLaunchSpeed ${config.minLaunchSpeed}`,
    );
  }
  return config;
}

/** Ticks of holding this config needs to reach a full pull. */
export function chargeTicksToFull(config: PlungerConfig): number {
  return Math.ceil(PLUNGER_FULL_CHARGE / config.chargeRate);
}

export interface PlungerState {
  /** Q10 fraction, 0..PLUNGER_FULL_CHARGE. */
  readonly charge: Q10;
  /** True while the spring is wound and a release would fire. */
  readonly pulling: boolean;
}

export const INITIAL_PLUNGER: PlungerState = Object.freeze({ charge: 0, pulling: false });

/**
 * One tick of plunger control, as reported by the input layer.
 *
 * `pressed` and `released` are edges accumulated over the tick, so both can be
 * true at once for a tap that began and ended between two samples. `held` is
 * the state at the end of the tick.
 */
export interface PlungerInput {
  readonly pressed: boolean;
  readonly released: boolean;
  readonly held: boolean;
}

export const PLUNGER_IDLE: PlungerInput = Object.freeze({
  pressed: false,
  released: false,
  held: false,
});

export interface PlungerOutcome {
  readonly state: PlungerState;
  /** True only on the tick the spring lets go. */
  readonly fired: boolean;
  /**
   * Velocity to give the ball, in Q10 per tick. Negative because the lane runs
   * up the screen and y grows downward. Zero when nothing fired.
   */
  readonly launchVelocityY: number;
  /** Charge that was converted into the launch, for scoring or telemetry. */
  readonly launchCharge: Q10;
}

const NOT_FIRED_VELOCITY = 0;

/** Launch speed for a charge, clamped into the config's range. Always positive. */
export function launchSpeedFor(charge: Q10, config: PlungerConfig): number {
  const clamped = q10Clamp(charge, 0, PLUNGER_FULL_CHARGE);
  const span = config.maxLaunchSpeed - config.minLaunchSpeed;
  return config.minLaunchSpeed + q10Multiply(clamped, span);
}

/**
 * Advances the plunger one tick.
 *
 * Order matters and is the whole behaviour of this function: a press begins a
 * pull, charge accrues while pulling, and only then is a release tested. Any
 * other order either swallows sub-tick taps (charge after release) or lets a
 * stale release fire a fresh pull (release before press).
 */
export function tickPlunger(
  state: PlungerState,
  input: PlungerInput,
  config: PlungerConfig = DEFAULT_PLUNGER_CONFIG,
): PlungerOutcome {
  // `held` alone arms the plunger as well as `pressed` does: the router may
  // have been created while the key was already down, and a plunger that
  // ignored that would never charge until the player let go and tried again.
  const pulling = state.pulling || input.pressed || input.held;

  // Charge only on ticks the control was actually down for some of — a release
  // edge counts, which is what banks a sub-tick tap. Requiring evidence of
  // contact rather than charging on `pulling` alone is what stops a lost key-up
  // (an alt-tab, an unplugged pad) from silently winding the spring to full
  // while the player is not touching anything; the plunger stays armed at
  // whatever it had, and fires when a release finally arrives.
  const touched = input.held || input.pressed || input.released;

  let charge = state.charge;
  if (pulling && touched) {
    charge = q10Clamp(charge + config.chargeRate, 0, PLUNGER_FULL_CHARGE);
  }

  if (!input.released || !pulling) {
    return {
      state: { charge, pulling },
      fired: false,
      launchVelocityY: NOT_FIRED_VELOCITY,
      launchCharge: 0,
    };
  }

  // A press that arrived after the release inside the same tick leaves the key
  // down at the sample point, so the next pull has already begun. Starting it
  // from zero here is what stops one long hold and a quick re-grab from adding
  // up into a second full-power launch.
  const stillPulling = input.held;

  return {
    state: { charge: 0, pulling: stillPulling },
    fired: true,
    launchVelocityY: -launchSpeedFor(charge, config),
    launchCharge: charge,
  };
}

/**
 * Charge as a 0..1 float for the meter.
 *
 * The only floating-point value this module produces, and it is deliberately
 * one-way: nothing reads it back into the simulation, so it cannot make a
 * replay diverge.
 */
export function chargeLevel(state: PlungerState): number {
  return state.charge / PLUNGER_FULL_CHARGE;
}

/** Discards any wound charge, e.g. when a ball drains or the table tilts. */
export function resetPlunger(): PlungerState {
  return INITIAL_PLUNGER;
}

/** Where a served ball appears, in Q10. */
export function servePosition(config: PlungerConfig = DEFAULT_PLUNGER_CONFIG): {
  readonly x: Q10;
  readonly y: Q10;
} {
  return { x: config.serveX, y: config.serveY };
}

/**
 * Puts a new, motionless ball at the bottom of the shooter lane.
 *
 * It is served at rest rather than with a downward nudge: gravity settles it
 * onto the lane floor within a few ticks, and starting it moving would make the
 * launch depend on when the player pressed relative to the serve.
 */
export function serveBall(set: BallSet, config: PlungerConfig = DEFAULT_PLUNGER_CONFIG): BallState {
  return spawnBall(set, config.serveX, config.serveY, 0, 0);
}

/**
 * Applies a fired outcome to the ball sitting in the lane.
 *
 * Sets the vertical velocity outright instead of adding to it: the plunger
 * strikes a ball that is resting on the lane floor, and adding would let a ball
 * still dribbling from an earlier tap stack two launches into one. Sideways
 * motion is left alone, so a ball rattling between the lane walls keeps its
 * rattle. Returns false when nothing fired, so callers can branch on the call.
 */
export function launchBall(ball: BallState, outcome: PlungerOutcome): boolean {
  if (!outcome.fired || !ball.active) return false;
  ball.velocityY = outcome.launchVelocityY;
  return true;
}
