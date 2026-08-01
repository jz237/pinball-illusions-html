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
 *
 * ---------------------------------------------------------------------------
 * HOW EVERY BOUND BELOW WAS MEASURED, AND WHAT RE-RUNS IT
 * ---------------------------------------------------------------------------
 * The shipped collision maps were exported 32 px out of phase (slot 2's payload
 * starts at byte 4, not byte 8 — see `scripts/export-table-maps.mjs`). Every
 * column in this file therefore moved: the lane's free centres are exactly 32
 * px right of where they were, on all three tables. The ROWS did not move at
 * all, and could not have: the error shifted each row's bits sideways, so a
 * row-indexed measurement is invariant under it. That is the single cleanest
 * check on the correction, and it is why only the x bounds changed by 32.
 *
 * All four bounds are measured with ONE rule, against the ring
 * `collision-probe.ts` actually collides with, on THE VIEW THE PHYSICS RUNS —
 * which for Law 'n Justice means the level-0 view plus its virtual top wall,
 * not the raw bitmap:
 *
 *   bottomY                  bottommost free ball-centre row on the lane column
 *   minCentreX / maxCentreX  the free-centre run on that row — the seat the ball
 *                            is served into
 *   topY                     top of the unbroken free-centre run through the
 *                            lane column that ends at bottomY
 *
 * That last clause is not decoration. `bottomY: 556` was once shipped for Law 'n
 * Justice, and no ball centre can be on row 556 of any of the three tables: the
 * shared lane floor is a solid bit-0 run on row 561 and a radius-8 ring puts the
 * bottommost free centre on row 552. A hand-read number and a probe-read number
 * disagreed and nothing noticed.
 *
 * SO THE RULE IS NOW EXECUTED, NOT JUST WRITTEN DOWN. `tests/plunger.test.ts`
 * ("re-derives every shooter-lane bound from the shipped map") re-runs exactly
 * the four measurements above against `public/generated/tables/*.map.json` with
 * `level-scan.ts` and asserts the constants below are what comes out. If a map
 * is ever re-exported and a bound moves, that test fails instead of the game
 * quietly serving a ball into a wall — which is the failure this whole file was
 * carrying silently after the last reframe.
 *
 * Cross-check: the seat run each table reports is byte-identical to the run the
 * hand-off band on the same column reports in `playfield-levels.ts`, which is
 * two independent scans agreeing on the same channel.
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
 * Law 'n Justice's shooter lane: a narrow channel on the right of the
 * playfield, walls (bit 0) at x=310..312 and x=333..335 from y=127 down to the
 * shared floor at y=561, free centres x=321..324 at the seat.
 *
 * `topY` is 34 rather than the row the walls start on: above y=127 the lane
 * column is open playfield rather than a channel, and the free-centre run
 * through it is unbroken from the seat all the way up to the ceiling.
 *
 * IT USED TO SAY 8, AND 8 IS THE RAW-BITMAP ANSWER RATHER THAN THE ENGINE'S.
 * Law 'n Justice is the one table whose level-0 view carries a virtual top wall
 * (`VIRTUAL_TOP_WALL_ROWS` in `ball-physics.ts` seals rows 0..25), so a radius-8
 * centre on the view the physics actually collides against cannot be higher than
 * row 34. Measured both ways on the shipped map with the engine's own ring: the
 * unbroken run through column 322 ends at y=8 on the bare bitmap and at y=34 on
 * the physics view. Nothing reads `topY` except `plungerConfigForLane`'s
 * serve-row sanity check, so this was inert — but a lane bound that disagrees
 * with the surface the ball collides with is exactly the kind of number that is
 * true until someone uses it, and the reframe was a lesson in those.
 */
export const LAW_N_JUSTICE_SHOOTER_LANE: ShooterLane = Object.freeze({
  minCentreX: 321,
  maxCentreX: 324,
  topY: 34,
  bottomY: 552,
  confidence: "measured",
});

/**
 * BabeWatch's shooter lane, measured off `babewatch.map.json` with the engine's
 * own radius-8 probe ring.
 *
 * Lower-line walls at x=310..312 and x=332..335 and a floor at y=561 — the SAME
 * floor row as the other two tables, which is the strongest single piece of
 * evidence that all three lanes are one shared cabinet part. Free ball centres
 * are x=321..323 down the seat of the lane.
 *
 * `topY` stops at 384 because BabeWatch's lower line does not carry the lane any
 * higher: above that the channel is pinched shut and the lane continues on the
 * UPPER line — see `playfield-levels.ts`, which is the whole reason this table
 * needed a hand-off before it could be played at all. 384 is unchanged by the
 * reframe, as every row-indexed measurement is.
 */
export const BABEWATCH_SHOOTER_LANE: ShooterLane = Object.freeze({
  minCentreX: 321,
  maxCentreX: 323,
  topY: 384,
  bottomY: 552,
  confidence: "measured",
});

/**
 * Extreme Sports' shooter lane, measured the same way.
 *
 * Lower-line walls at x=310..313 and x=333..335, floor at y=561, free centres
 * x=322..324 — one column right of BabeWatch's, which is why the serve column
 * is derived from the span rather than shared. `topY` is 330 for the same
 * reason as BabeWatch's 384: the lower line loses the lane above that and the
 * upper line carries it on.
 */
export const EXTREME_SPORTS_SHOOTER_LANE: ShooterLane = Object.freeze({
  minCentreX: 322,
  maxCentreX: 324,
  topY: 330,
  bottomY: 552,
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
 * Per-table lanes, all three now measured off their own shipped map rather than
 * copied from Law 'n Justice.
 *
 * The copy used to be marked `assumed`, and the assumption was very nearly
 * right — every one of the three lanes sits in the same place, with its floor on
 * the same row (561) — but "very nearly" was enough to matter: BabeWatch's free
 * centres are x=321..323 and Extreme Sports' are x=322..324, so the serve column
 * derived from Law 'n Justice's span was a pixel off on one of them.
 */
export const SHOOTER_LANE_BY_TABLE: Readonly<Record<TableId, ShooterLane>> = Object.freeze({
  "law-n-justice": LAW_N_JUSTICE_SHOOTER_LANE,
  babewatch: BABEWATCH_SHOOTER_LANE,
  "extreme-sports": EXTREME_SPORTS_SHOOTER_LANE,
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
 * DERIVED, not chosen — but the derivation written here used to name the wrong
 * target, and this is the corrected one.
 *
 * ---------------------------------------------------------------------------
 * THE OLD DERIVATION MEASURED THE LANE. THE SHOT IS NOT THE LANE
 * ---------------------------------------------------------------------------
 * It said: with gravity applied before each integration step a launch at v rises
 * v^2/(2g) - v/2 units, so reaching the top of Law 'n Justice's lane — 536 px
 * from the serve point — needs v >= 5145 against g = 24, and 6144 is the
 * smallest whole pixel per tick above that. Every step of that is true and the
 * conclusion is still 6144, which is exactly why the error survived: the ball
 * does not merely have to reach the top of the lane. It has to cross the top
 * arch, on the upper collision line, rubbing both rails, and still be moving
 * when it starts down the far side. A ballistic climb up an empty column is a
 * LOWER BOUND on that, not the requirement.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SHOT ACTUALLY COSTS, MEASURED
 * ---------------------------------------------------------------------------
 * Swept in the real game loop — one plunge of N ticks, no flippers, no nudge, on
 * the shipped map — the launch shot first completes at:
 *
 *   law-n-justice   hold 28 of 32   launch 5504 Q10 (5.375 px/tick)   87.5% pull
 *   babewatch       hold 22 of 32   launch 4544 Q10 (4.437 px/tick)   68.75% pull
 *   extreme-sports  hold 26 of 32   launch 5184 Q10 (5.062 px/tick)   81.25% pull
 *
 * and what the ball does one step below each threshold is the evidence that the
 * threshold is the arch rather than the lane: Law 'n Justice at hold 27 crests
 * the crown and comes to rest on its outer shoulder at (214,20) with the channel
 * beside it; BabeWatch at hold 21 reaches (294,276), the `ramp-end` gate's own
 * row, and fails the strict `toY < gate.y` by one pixel; Extreme Sports at hold
 * 25 crosses the crown and ends in the (302,162) cup. None of the three is short
 * of the top of its lane.
 *
 * So the binding requirement is Law 'n Justice's 5504 Q10, and six pixels per
 * tick — 6144 — is still the smallest whole pixel per tick above it, with 11.6%
 * of margin. The number does not move; the reason it is that number does.
 *
 * The consequence is worth stating plainly rather than leaving to be rediscovered:
 * on Law 'n Justice only the top 12.5% of the pull completes the shot, so an
 * under-plunge is common. That is not a fault as long as an under-plunge gives
 * the ball back — it dribbles down the lane, `game-loop.ts` re-pins it on the rod
 * and the player shoots again — and `tests/plays.test.ts` proves exactly that for
 * every starting pull on every table.
 *
 * IT WAS RAISED TO SEVEN, AND THAT WAS A SYMPTOM. The argument for seven was
 * that the lane hands the ball to the top arch and "the ball rubs the arch's
 * rails the whole way, losing about 18% of its speed at every contact", so a
 * six-pixel launch stalled just short of the apex at (186, 21). That 18% was the
 * friction bug in `reflectVelocity` — a flat percentage of the ball's whole
 * tangential speed taken on every tick of contact, rather than a Coulomb impulse
 * bounded by the normal force. With that corrected a ball no longer pays a
 * tariff for touching a rail it is rolling along, the arch costs what an arch
 * costs, and the launch speed goes back to the number the lane climb implies.
 *
 * The same applies to BabeWatch, whose ten pixels a tick were bought entirely to
 * pay for two contacts in the bend above y=400 (measured then: in at 6664 Q10,
 * out at 2492). Under the corrected model all three tables complete their launch
 * shot on six, so the per-table override table below has one value in it rather
 * than three, and the reason for that is a physics fix rather than a coincidence.
 *
 * It is deliberately not raised further. The plunger is an aiming device: a full
 * pull has to finish the shot and a two-thirds pull must not, or pull length
 * stops meaning anything — and the measured thresholds above are 87.5%, 68.75%
 * and 81.25%, all of them above two thirds, on all three tables. It is also well
 * inside the signed-16-bit velocity range and under two substeps of the
 * anti-tunnelling limit, so nothing clips a wall.
 */
export const MAX_LAUNCH_SPEED = pixelsToQ10(6);

/**
 * The speed a FULL pull gives, per table.
 *
 * The table is kept — the three lanes are separately measured and a future
 * per-table measurement has to have somewhere to land — but it now holds ONE
 * value, because the differences it used to carry were all paying for the
 * friction bug rather than for anything on the tables.
 *
 * What that looked like before: Law 'n Justice and Extreme Sports were on seven
 * pixels a tick and BabeWatch on ten, and BabeWatch's extra three were bought
 * entirely to survive the staircase bend above y=400 (it entered at 6664 Q10 and
 * left at 2492). Under the Coulomb model in `ball-physics.ts` a ball rolling
 * along a rail no longer pays 15% of its speed per tick of contact, and all
 * three tables complete their launch shot on six — measured over plunge holds of
 * 32..91 ticks, i.e. every hold that reaches a full pull, on the shipped maps.
 *
 * The value is still per-table configuration in shape, and it is still checked
 * the same way: a full pull completes the shot and a two-thirds pull does not,
 * so pull length still aims. It is inside the signed-16-bit velocity range and
 * under two substeps of the anti-tunnelling limit, so it cannot clip a wall.
 *
 * MEASURED AGAIN AFTER THE MAP REFRAME, per table, by sweeping the plunge hold
 * through the real loop on the corrected maps. One value still serves all three:
 * the shot completes at hold 28 / 22 / 26 of 32 and the ceiling is above all of
 * them. See MAX_LAUNCH_SPEED for the sweep and for what each table does one step
 * below its own threshold.
 */
export const FULL_PLUNGE_SPEED_BY_TABLE: Readonly<Record<TableId, number>> = Object.freeze({
  "law-n-justice": MAX_LAUNCH_SPEED,
  babewatch: MAX_LAUNCH_SPEED,
  "extreme-sports": MAX_LAUNCH_SPEED,
});

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
export function plungerConfigForLane(
  lane: ShooterLane,
  maxLaunchSpeed: number = MAX_LAUNCH_SPEED,
): PlungerConfig {
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
    maxLaunchSpeed,
    serveX: pixelsToQ10(centreX),
    serveY: pixelsToQ10(serveRow),
    laneConfidence: lane.confidence,
  };
}

export function plungerConfigFor(tableId: TableId): PlungerConfig {
  return plungerConfigForLane(shooterLaneFor(tableId), FULL_PLUNGE_SPEED_BY_TABLE[tableId]);
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
