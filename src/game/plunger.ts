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
 * feeble: `minLaunchSpeed` moves the ball about fifteen pixels up a five-hundred
 * pixel lane, so a fumbled tap costs the player the plunge instead of silently
 * doing nothing at all.
 */

import type { BallState, TableId } from "./contracts.js";
import type { BallSet } from "./ball-physics.js";
import { spawnBall } from "./ball-physics.js";
import type { Q10 } from "../core/fixed-point.js";
import { Q10_ONE, pixelsToQ10, q10Clamp, q10Multiply } from "../core/fixed-point.js";
import { SIMULATION_GRAVITY } from "./timebase.js";

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
 * Gravity the launch speeds below are calibrated against, in Q10 per tick.
 *
 * IT WAS 24 AND IT WAS NEVER MEASURED — an inherited constant, and the reason
 * this whole simulation played like it was in orbit. It is now an alias of the
 * measured `SIMULATION_GRAVITY` (128) in `timebase.ts`, kept under this name
 * only because the dependency it documents is real and worth naming at the point
 * of use: `maxLaunchSpeed` is meaningless except relative to a pull of gravity,
 * and if one moves the other must.
 *
 * THE DEPENDENCY IS NOT LINEAR, and getting that wrong is the trap here. The
 * lane climb is fixed geometry, so a launch that just reaches the top satisfies
 * v^2 = 2 g h: the launch speed goes as SQRT of gravity, by sqrt(16/3) = 2.309,
 * not by 16/3. Anyone scaling this file by the same factor as the kicks would
 * overshoot by 2.3x. Both numbers below were re-measured by sweeping the real
 * game loop rather than scaled by anything.
 */
export const PLUNGER_REFERENCE_GRAVITY: Q10 = SIMULATION_GRAVITY;

/**
 * Slowest launch, two pixels per tick.
 *
 * RE-DERIVED against the measured gravity, and it had to move: a launch at v
 * rises about v^2/(2g) before falling back, so one pixel a tick — which used to
 * buy a twenty-pixel dribble — buys four pixels against a gravity of 128, which
 * is inside the ball's own radius and reads as the plunger doing nothing at all.
 * Two pixels a tick restores the visible dribble (about 16 px) that tells a
 * player their tap was heard and cost them the plunge. This is what a sub-tick
 * tap gets.
 */
export const MIN_LAUNCH_SPEED = pixelsToQ10(2);

/**
 * Fastest launch, FOURTEEN pixels per tick.
 *
 * RE-MEASURED, not rescaled. It was six, and six was measured honestly against a
 * gravity that was 5.33x too weak — which is the whole shape of this defect: a
 * number arrived at by sweeping the real loop is only as good as the field it
 * was swept in.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DOES NOT MOVE BY THE SAME FACTOR AS EVERYTHING ELSE
 * ---------------------------------------------------------------------------
 * Every velocity decoded off the disk moved by 4x and every acceleration by 32x.
 * This one is not decoded off the disk: it is the speed needed to make a fixed
 * CLIMB. A launch at v rises about v^2/(2g) - v/2, and the climb is geometry, so
 * v goes as sqrt(g): the factor is sqrt(16/3) = 2.309, not 16/3. Six pixels a
 * tick times 2.309 is 13.85, and the swept answer below is 14 — the arithmetic
 * and the measurement agree to within a pixel a tick, which is the check that
 * says the correction is a change of scale and not a change of table.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SHOT COSTS, SWEPT AGAIN IN THE REAL LOOP AT GRAVITY 128
 * ---------------------------------------------------------------------------
 * One plunge of N ticks of the 32 that make a full pull, no flippers, no nudge,
 * on the shipped maps, "completes" meaning the ball leaves by the BOTTOM ROW
 * rather than by the ball search. The first completing hold, and the launch
 * speed it corresponds to:
 *
 *   law-n-justice   hold 29 of 32   launch 13,184 Q10 (12.88 px/tick)  90.6% pull
 *   babewatch       hold 17 of 32   launch  8,576 Q10  (8.38 px/tick)  53.1% pull
 *   extreme-sports  hold 27 of 32   launch 12,416 Q10 (12.13 px/tick)  84.4% pull
 *
 * and all three completing ranges are CONTIGUOUS to 32, which is the property
 * that makes pull length mean anything and the one that forced Extreme Sports
 * onto its own value last time.
 *
 * The binding table is Law 'n Justice, as before, and its arch threshold is a
 * property of the table rather than of this constant: swept at ceilings of 13,
 * 14 and 15 px/tick the first completing launch comes out at 12,960 / 13,184 /
 * 12,864 Q10, i.e. about 12.7 px/tick however the ramp to it is scaled. So the
 * requirement is ~13,000 Q10 and the ceiling is the smallest whole pixel per
 * tick that clears it with real margin:
 *
 *   13 px/tick = 13,312 Q10 —  2.7% margin, and the shot completes only from
 *                hold 31 of 32. The top 3% of the pull is not an aiming device.
 *   14 px/tick = 14,336 Q10 — 10.6% margin, completing from 29. TAKEN.
 *   15 px/tick = 15,360 Q10 — completing from 26, and only 6% under the
 *                engine's own velocity clamp of 16,380.
 *
 * Fourteen also reproduces the ergonomics the six-pixel version had exactly:
 * Law 'n Justice completed 29..32 then and completes 29..32 now.
 *
 * ---------------------------------------------------------------------------
 * TWO INDEPENDENT CHECKS ON THE NUMBER
 * ---------------------------------------------------------------------------
 * In the original's own velocity units 14,336 Q10 is 3,584 — just above the
 * slingshot coil's 3,500 and well under the pop bumper's 5,500. A plunger that
 * hits a shade harder than a slingshot and a good deal softer than a bumper is
 * the right ordering for a pinball machine, and it is an ordering the old value
 * got backwards: 6,144 Q10 under the old bridge was 8,192 original units, which
 * asked the plunger to hit half again as hard as a pop bumper to make its own
 * lane.
 *
 * And it sits inside the engine's measured velocity clamp of +-16,380 with 12.5%
 * to spare, so a full plunge is never silently truncated. (Fifteen would still
 * fit; sixteen would not, because pixelsToQ10(16) is 16,384 and the clamp would
 * take four units off every full pull.)
 *
 * ---------------------------------------------------------------------------
 * ONE THING THAT DID CHANGE, AND IS REPORTED RATHER THAN TUNED AWAY
 * ---------------------------------------------------------------------------
 * BabeWatch now completes from 53% of a pull where it used to need 66%. This
 * file used to state a design rule — "a full pull has to finish the shot and a
 * two-thirds pull must not" — and BabeWatch no longer satisfies it. That is not
 * fixed by giving BabeWatch a weaker plunger, because nothing measured asks for
 * one: its lane is the one that is not driven by the ramp map at all (see
 * `table-accel.ts`) and its `topY` is 384 rather than 34, because BabeWatch's
 * lower line loses the channel half way up and the UPPER line carries the rest.
 * A shorter climb needs a slower ball. The rule was a rule of thumb about two of
 * the three tables; the geometry is the fact.
 */
export const MAX_LAUNCH_SPEED = pixelsToQ10(14);

/**
 * The speed a FULL pull gives, per table.
 *
 * The table is kept — the three lanes are separately measured and a per-table
 * value has to have somewhere to land — but it holds ONE value again.
 *
 * It has been two values and it has been three. Extreme Sports was on seven
 * pixels a tick while the others were on six, because at six a FULL pull missed
 * a shot that a seven-eighths pull made: the full-power ball crested the arch
 * flatter and came down onto the flat-topped bumper at x=113..125, y=115, whose
 * contact normal is exactly vertical, and nothing rolls a ball off a level
 * surface. That non-monotonicity was the diagnostic. Before that, BabeWatch was
 * on ten, bought entirely to pay for a friction bug that charged a ball 15% of
 * its speed for every tick it spent touching a rail it was rolling along.
 *
 * On the corrected timebase all three complete contiguously from a single
 * ceiling — 29..32, 17..32 and 27..32 of 32 — so there is nothing for a
 * per-table value to buy. The sweep is in MAX_LAUNCH_SPEED.
 *
 * The lane-drive asymmetry that forced the last split is still there and is
 * still worth recording, because it is the reason the three thresholds differ at
 * all. Counted over the lanes' own block columns 39..41 on both levels:
 *
 *   law-n-justice    50 driven blocks, every one of them vector (0,2)
 *   babewatch         3 driven blocks, none of them in the lane's climb
 *   extreme-sports  105 driven blocks, every one of them vector (0,2)
 *
 * (0,2) is now 64 Q10 per tick squared of extra downward acceleration — half of
 * gravity, where under the old bridge it was read as 12 — over roughly 200 px of
 * climb. Two of the three lanes are materially steeper than a bare ballistic
 * model and BabeWatch's is not, which is why BabeWatch's threshold is the lowest
 * of the three by a wide margin. That is decoded, not fitted.
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
 * A full-strength launch the machine gives itself, for a ball the player never
 * asked to serve.
 *
 * Multiball feeds its balls out of this one lane, one after another, and a
 * player already flipping two balls cannot also be winding a spring. Every
 * machine that does this has an auto-launcher, and this is it. Full charge, so
 * the ball always clears the lane; and the returned `state` is the IDLE plunger,
 * because the player's spring was never touched and must not come back part
 * wound — a launch the machine performed cannot leave charge behind for the
 * player's next shot.
 *
 * Used only by the game loop, and only for balls it owes itself. A ball the
 * player was given is always the player's to shoot.
 */
export function autoLaunchOutcome(config: PlungerConfig = DEFAULT_PLUNGER_CONFIG): PlungerOutcome {
  return {
    state: INITIAL_PLUNGER,
    fired: true,
    launchVelocityY: -launchSpeedFor(PLUNGER_FULL_CHARGE, config),
    launchCharge: PLUNGER_FULL_CHARGE,
  };
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
