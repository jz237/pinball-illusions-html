/**
 * The launcher: serving a ball into the shooter lane and firing it out again.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO PLUNGER. THERE NEVER WAS ONE
 * ---------------------------------------------------------------------------
 * This module shipped for most of this project's life as a pull-and-release
 * spring: hold to wind charge, release to convert it to speed, a linear map
 * from hold length to launch velocity. That model was this port's own
 * invention, and the fidelity round that compared the reconstruction against
 * the original running under emulation killed it three ways at once:
 *
 *   DISASSEMBLY (main.seg00 0x65EE, the launch service run every frame in
 *   every in-play state): if the auto-kick flag $D89(a5) is set, kick; else if
 *   the serve queue owes a ball, deliver it; else if the RETURN key byte $ED6
 *   is set, CLEAR IT — edge-consumed, so hold length can never matter — and
 *   kick. The kick at 0x663A is `subi.w #$1770,$10(ball)`: a FIXED 6000-unit
 *   upward impulse, no charge, no hold, no other launch path anywhere in the
 *   binary. The same engine-shared routine serves all three tables.
 *
 *   FILM, Law 'n Justice: three launches identical to ±0.5 px; a 120 ms tap
 *   and a 2000 ms hold frame-identical; ascent 15.5 game px/frame flat.
 *
 *   FILM, BabeWatch and Extreme Sports: same fixed deterministic kick — six
 *   launches, tap and 2500 ms hold frame-equivalent, ascents 14–15.4 game
 *   px/frame. The "maybe those tables have real plungers" question (dossier
 *   C3) is closed: one code path, one constant.
 *
 * So this module is now the original's launcher: a fixed kick fired on the
 * launch key's press EDGE (or by the machine itself for balls it owes), with
 * the hold length ignored entirely. The weak-plunge stall class (sweep finding
 * #9 — a ball re-plunged identically forever at a strength that cannot clear
 * the arch) is not fixed by this change so much as made unrepresentable.
 *
 * ---------------------------------------------------------------------------
 * THE KICK, THROUGH THE MEASURED VELOCITY BRIDGE
 * ---------------------------------------------------------------------------
 * 6000 original velocity units is 24,000 Q10/tick through the bridge in
 * `timebase.ts` — deliberately past the engine's own ±4095-unit component
 * clamp, which the first collision resolve applies at +0x00B4D6/+0x00B692. The
 * ball therefore leaves the rod at exactly the clamp: 4095 units = 16,380 Q10
 * = 16.0 px/tick = 800 px/s, and gravity plus the lane's decoded drive vectors
 * trim it to the filmed 770–775 px/s over the climb. This port applies the
 * same arithmetic in the same order: the launch is written as the pre-clamp
 * 24,000 and the ball's own velocity clamp produces the 16,380, so if the
 * clamp is ever re-measured the launch follows it automatically.
 *
 * ---------------------------------------------------------------------------
 * THE ~13-FRAME KEY-TO-MOTION DELAY IS NOT IMPLEMENTED, ON PURPOSE
 * ---------------------------------------------------------------------------
 * The reference captures show the ball moving ~13 frames (LnJ session) to
 * ~19-20 frames (BW/ES session) after the host-logged key-down — but the two
 * sessions disagree by more than either session's internal spread, both sit
 * inside the ±0.3 s capture-epoch tolerance, and the disassembly is
 * conclusive that the GAME applies the kick on the same frame it sees the key
 * byte: the byte is written by an input ISR outside the game binary (no CIA
 * access exists in main.bin or its loader). The delay is Amiga OS input-chain
 * latency, not a game rule, and reproducing another machine's input latency
 * as a gameplay constant would be fidelity to the wrong layer. Recorded here
 * so the next reader does not re-add it from the raw film numbers.
 */

import type { BallState, TableId } from "./contracts.js";
import type { BallSet } from "./ball-physics.js";
import { spawnBall } from "./ball-physics.js";
import type { Q10 } from "../core/fixed-point.js";
import { pixelsToQ10 } from "../core/fixed-point.js";
import { VELOCITY_CLAMP_Q10, originalVelocityToQ10 } from "./timebase.js";

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
 * contact before the player ever touched the launch key; an inset lets it
 * settle onto the floor under gravity the way the original's serve does.
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
 * The launch kick, in the original's velocity units: `subi.w #$1770,$10(a?)`
 * at main.seg00 0x663A, reached from the launch service 0x65EE for both the
 * player's RETURN edge and the machine's auto-kick. One constant, engine-
 * shared, identical on all three tables.
 */
export const ORIGINAL_LAUNCH_KICK_UNITS = 6000;

/**
 * The kick in Q10 per tick, PRE-CLAMP: 24,000.
 *
 * Deliberately not min()'d against the velocity clamp here: `launchBall` goes
 * through the ball-state clamp exactly as the original's first collision
 * resolve does, and the effective launch speed — 16,380 Q10 = 16 px/tick =
 * 800 px/s — is therefore a consequence of the measured clamp rather than a
 * second copy of it. Film: 770–775 px/s flat ascent on all three tables, i.e.
 * the clamped kick with gravity and the decoded lane drive trimming it.
 */
export const LAUNCH_KICK: Q10 = originalVelocityToQ10(ORIGINAL_LAUNCH_KICK_UNITS);

export interface PlungerConfig {
  /** Q10 units per tick of upward kick, pre-clamp. The same for every ball. */
  readonly launchKick: number;
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
  launchKick: number = LAUNCH_KICK,
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
    launchKick,
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
  if (!Number.isInteger(config.launchKick) || config.launchKick <= 0) {
    throw new RangeError(`launchKick must be a positive integer: ${config.launchKick}`);
  }
  return config;
}

/**
 * One tick of launch control, as reported by the input layer.
 *
 * `pressed` is the edge accumulated over the tick, which is the only field the
 * launcher reads — the original's $ED6 byte is set by the key-down ISR and
 * cleared by the first frame that consumes it, so a hold is one launch and a
 * tap shorter than a tick still fires. `released` and `held` are kept in the
 * shape so the input adapter is unchanged and a future control that does care
 * about holds can take the same snapshot.
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

export interface LaunchOutcome {
  /** True only on a tick the kick fires. */
  readonly fired: boolean;
  /**
   * Velocity to give the ball, in Q10 per tick, pre-clamp. Negative because
   * the lane runs up the screen and y grows downward. Zero when nothing fired.
   */
  readonly launchVelocityY: number;
}

const NOT_FIRED: LaunchOutcome = Object.freeze({ fired: false, launchVelocityY: 0 });

/**
 * The player's launch for one tick: the RETURN edge, consumed.
 *
 * Stateless, because the original's launcher is: the key byte is the only
 * state and the input snapshot's `pressed` edge IS that byte, latched by the
 * router and cleared by sampling. Whether a ball is actually on the rod to be
 * kicked is the caller's test (`$D88` in the original, `laneBallId` here) —
 * an edge with no ball in the lane is consumed and does nothing, exactly as
 * 0x65EE clears $ED6 before it looks at the lane byte.
 */
export function tickLauncher(
  input: PlungerInput,
  config: PlungerConfig = DEFAULT_PLUNGER_CONFIG,
): LaunchOutcome {
  if (!input.pressed) return NOT_FIRED;
  return { fired: true, launchVelocityY: -config.launchKick };
}

/**
 * The kick the machine gives a ball it owes itself — a multiball serve, a
 * lock's replacement. THE SAME KICK: the original's auto path ($D89 set →
 * 0x6628) lands on the identical `subi.w #$1770` the player's edge does, which
 * is why a machine serve and a player serve climb the lane identically on
 * film. Only the trigger differs, and that lives in the game loop.
 */
export function autoLaunchOutcome(config: PlungerConfig = DEFAULT_PLUNGER_CONFIG): LaunchOutcome {
  return { fired: true, launchVelocityY: -config.launchKick };
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
 *
 * DIVERGENCE, recorded: the original re-troughs a drained ball at
 * x=(oldx&7)+284, y=(oldy&7)+510 (main.seg00 $3E36) — three bits of carried
 * position entropy — and lets it ROLL down a serve chute into the lane, so no
 * two serves start from the identical pixel. This port serves at the fixed
 * seat. The chute physics needs the upper-line serve path verified before it
 * can be authentic rather than decorative, and the entropy without the chute
 * would just be noise injected at a place the original derives it; both wait
 * on their own round.
 */
export function serveBall(set: BallSet, config: PlungerConfig = DEFAULT_PLUNGER_CONFIG): BallState {
  return spawnBall(set, config.serveX, config.serveY, 0, 0);
}

/**
 * Applies a fired outcome to the ball sitting in the lane.
 *
 * Sets the vertical velocity outright instead of adding to it — the original's
 * `subi.w` subtracts from a ball the serve placed at rest, and setting is what
 * that is for a resting ball while also preventing a rattling ball from
 * stacking two kicks. The ball-state clamp then cuts the 24,000 Q10 to the
 * engine's ±16,380, which is the original's own order of operations. Sideways
 * motion is left alone, so a ball rattling between the lane walls keeps its
 * rattle. Returns false when nothing fired, so callers can branch on the call.
 */
export function launchBall(ball: BallState, outcome: LaunchOutcome): boolean {
  if (!outcome.fired || !ball.active) return false;
  ball.velocityY = clampLaunch(outcome.launchVelocityY);
  return true;
}

/** The ball-state velocity clamp, applied where the ball is written. */
function clampLaunch(value: number): number {
  if (value < -VELOCITY_CLAMP_Q10) return -VELOCITY_CLAMP_Q10;
  if (value > VELOCITY_CLAMP_Q10) return VELOCITY_CLAMP_Q10;
  return Math.trunc(value);
}
