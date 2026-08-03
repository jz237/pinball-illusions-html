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

import type { BallState, PlayfieldLevel, TableId } from "./contracts.js";
import type { BallSet } from "./ball-physics.js";
import { spawnBall } from "./ball-physics.js";
import { BALL_RADIUS_PIXELS } from "./collision-probe.js";
import type { Q10 } from "../core/fixed-point.js";
import { pixelsToQ10, q10ToPixel } from "../core/fixed-point.js";
import {
  Q10_PER_ORIGINAL_VELOCITY_UNIT,
  VELOCITY_CLAMP_Q10,
  originalVelocityToQ10,
} from "./timebase.js";

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
 * How far above the bottom of the channel a served ball appears: NOT AT ALL.
 *
 * This was `8` — one ball radius — and the 8 was invented, not measured. The
 * argument for it was that serving hard against the floor would put the probe
 * ring in contact on the very first tick. The film says the original does
 * exactly that: on `babewatch-take1` the resting silver at f331 has a bounding
 * box of y 546.0..557.5, centroid 551.3, and the frame-difference against f332
 * puts the centre at 550.8 — i.e. on `bottomY` (552), not eight pixels above
 * it. The inset is removed and the constant is kept at 0 so the derivation
 * stays visible rather than disappearing into `serveRow = lane.bottomY`.
 *
 * It describes the SEAT, which is where a ball rolled down the return chute
 * comes to rest, and it is no longer where any ball is placed: the machine
 * serves into the trough and the map holds the ball on the lane floor. Measured
 * with the chute in: 1,782 of 2,000 sampled trough records settle at
 * (321.0000, 552.9990) on BabeWatch, i.e. on this row, which is the film's
 * resting silver to within the frame difference's own precision.
 */
export const SERVE_INSET_PIXELS = 0;

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
  /**
   * The SEAT, in Q10 playfield coordinates: the centre of the lane's free span
   * on its bottommost free row.
   *
   * NOT where a ball is placed — nothing places a ball here any more; see the
   * trough below. It is the lane's own geometry, and what still reads it is the
   * camera framing, the tests that assert where a served ball ends up, and
   * anything that wants to name the rod's nominal position.
   */
  readonly serveX: Q10;
  readonly serveY: Q10;
  /** Whether the seat comes from a measured lane or an assumed one. */
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
  // With the inset gone the serve row IS `bottomY`, so it can no longer fall
  // above `topY`; what is still worth refusing is a lane with no runway at all,
  // which would serve and launch onto the same row.
  if (serveRow <= lane.topY) {
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

/** The lane seat, in Q10 — where a served ball comes to REST, not where it starts. */
export function servePosition(config: PlungerConfig = DEFAULT_PLUNGER_CONFIG): {
  readonly x: Q10;
  readonly y: Q10;
} {
  return { x: config.serveX, y: config.serveY };
}

// ---------------------------------------------------------------------------
// THE TROUGH: main.seg00 $3E36, and the entropy it carries
// ---------------------------------------------------------------------------
//
// This is the routine that puts a ball back in the trough, and it is the only
// place in the binary — apart from a saucer's authored eject at +0x0070FC and
// the integrator itself at +0x00B728 — that ever writes a ball's position. It
// runs on a drain (+0x00B424 falls into it when the y>600 test fires at
// +0x00B29A), on a device that swallows a ball (+0x005B7C), and on every one of
// the three ball records at the start of a game (+0x003550) and of a ball
// (+0x003E84). Byte-verified against main.bin.seg00.bin — the shipped listing
// is one word out of phase here, because $3E34 is a data counter sitting inside
// the code and the disassembler kept going:
//
//   $3E36  02 6C 00 07 00 12   andi.w  #$0007,$12(a4)      x  &= 7
//   $3E3C  06 6C 01 1C 00 12   addi.w  #$011C,$12(a4)      x  += 284
//   $3E42  70 00               moveq   #0,d0
//   $3E44  30 2C 00 12         move.w  $12(a4),d0
//   $3E48  E1 88 E5 88         lsl.l   #8,d0 / lsl.l #2,d0     (<<10)
//   $3E4C  29 40 00 1E         move.l  d0,$1e(a4)          xQ10 = x<<10
//   $3E50  02 6C 00 07 00 14   andi.w  #$0007,$14(a4)      y  &= 7
//   $3E56  06 6C 01 FE 00 14   addi.w  #$01FE,$14(a4)      y  += 510
//   $3E5C  30 2C 00 14 ...     (same <<10)
//   $3E64  29 40 00 22         move.l  d0,$22(a4)          yQ10 = y<<10
//   $3E68  02 AC 00FF00FF 000E andi.l  #$00FF00FF,$e(a4)   vx &= 255, vy &= 255
//   $3E70  06 AC 02000200 000E addi.l  #$02000200,$e(a4)   vx += 512, vy += 512
//   $3E78  42 2C 00 01         clr.b   $1(a4)
//   $3E7C  4E B9 000053F4      jsr     $53F4               level pointers := UPPER
//   $3E82  4E 75               rts
//
// Four facts the numbers alone do not carry, all of them load-bearing:
//
//  1. IT MASKS IN PLACE. There is no "old position" variable — the routine ANDs
//     the ball record's own fields, so the three bits it keeps are the bits of
//     wherever that ball was standing when the machine took it away. A drain at
//     x=185 serves the next ball one pixel right of a drain at x=184.
//
//  2. $12/$14 ARE WHOLE PIXELS, not sub-pixels. $1e/$22 are the Q10 masters and
//     $12/$14 are `asr.l #10` of them (+0x00B722), and this routine rebuilds
//     $1e/$22 by shifting $12/$14 back up. So `&7` is SEVEN WHOLE PIXELS. The
//     round-6 sweep that treated it as 7/256 px and found the serve degenerate
//     was measuring a 256th of the real thing.
//
//  3. $12/$14 ARE THE SPRITE'S TOP-LEFT, and this port's `BallState.x/y` is the
//     CENTRE — the same +8 that `table-accel.ts` documents at +0x00B72E. So the
//     placement in this port's frame is 284+8 = 292 and 510+8 = 518. (The mask
//     is unaffected: the radius is 8, so (centre-8)&7 == centre&7.)
//
//  4. IT IS NOT THE LANE. (292..299, 518..525) is a mouth on the UPPER
//     collision line — $53F4 is the "level 1" pointer set, the sibling of
//     $53C6's level 0 — and it is the top of a 45-degree chute that is PIXEL
//     IDENTICAL on all three shipped maps (as the lane floor at y=561 is), the
//     ball-return running down to the shooter lane's foot at (317,562), where
//     every table carries the same `to-lower` hand-off zone (317,545)-(337,565).
//     The mouth is a FUNNEL, not a slot: measured with the engine's own probe
//     ring, the free ball-centre run on rows 518..522 is 295..327, 294..327,
//     293..327, 292..327, 291..327 — identical on all three maps to the pixel —
//     so 45 of the 64 placements start clear and the other 19 start inside the
//     upper-left wall's touch band and are pushed off it by the first collision
//     pass. That is a machine dropping a ball into a funnel. The velocity is the
//     reason it is a chute and not a drop: +512 in BOTH axes is 2 px/tick down
//     and 2 px/tick right, i.e. straight down the 45-degree channel.
//
// So the serve is: place at the chute mouth with three bits of the last ball's
// position, push off with the low byte of its velocity, and roll. Every draw
// arrives on the rod (measured: all 64 mouth pixels at both ends of the velocity
// carry, all three tables, 11..75 ticks), which is why nothing has to pin it.

/** `addi.w #$011C` — the trough x, as the original's top-left sprite column. */
export const TROUGH_ORIGIN_X = 284;
/** `addi.w #$01FE` — the trough y, same frame. */
export const TROUGH_ORIGIN_Y = 510;
/** `andi.w #$0007` — three bits of the drained ball's position, both axes. */
export const TROUGH_POSITION_MASK = 7;
/** `andi.l #$00FF00FF` — the low byte of the drained ball's velocity, both axes. */
export const TROUGH_VELOCITY_MASK = 0xff;
/** `addi.l #$02000200` — the push-off, in the original's velocity units. */
export const TROUGH_VELOCITY_UNITS = 512;
/** `jsr $53F4`: the ball is placed on the UPPER collision line, in the chute. */
export const TROUGH_LEVEL: PlayfieldLevel = 1;

/** The chute mouth in this port's centre frame: 284+8 and 510+8. */
export const TROUGH_CENTRE_X = TROUGH_ORIGIN_X + BALL_RADIUS_PIXELS;
export const TROUGH_CENTRE_Y = TROUGH_ORIGIN_Y + BALL_RADIUS_PIXELS;

/**
 * The four fields $3E36 reads out of the ball record before it overwrites them:
 * the machine's carried serve entropy, already masked.
 *
 * Kept masked rather than raw so that the only place the masks are applied is
 * `troughRecordOf`, and so a record can be compared and pinned.
 */
export interface TroughRecord {
  /** `x & 7` of the ball that was last put in the trough. */
  readonly x: number;
  /** `y & 7`. */
  readonly y: number;
  /** `vx & 255`, in the original's velocity units. */
  readonly velocityX: number;
  /** `vy & 255`. */
  readonly velocityY: number;
}

/**
 * The record a machine that has never had a ball taken off it serves from.
 *
 * WHAT THE ORIGINAL DOES HERE IS UNDEFINED, and this is the defensible reading.
 * The three ball records live at $FAA(a5) in the workspace the loader allocates,
 * and nothing ever initialises them: the game-start path at +0x003536 walks the
 * three of them calling $3E36, which masks whatever is already there. On the
 * first game after the machine is switched on that is cleared BSS — zeros — and
 * on every later game it is the previous game's leftovers, which is real
 * behaviour that no reconstruction can reproduce, because it depends on what
 * else the Amiga happened to leave in that memory.
 *
 * So: a cold machine, zeros. `createGame` starts here, `startGame` deliberately
 * does NOT reset it (the leftovers survive a new game on the original too, and
 * that is exactly the carry this models), and the choice is stated rather than
 * hidden because a reader comparing against a real machine will see the first
 * ball of the first game agree and later games diverge.
 */
export const CLEARED_TROUGH_RECORD: TroughRecord = Object.freeze({
  x: 0,
  y: 0,
  velocityX: 0,
  velocityY: 0,
});

/**
 * `andi.w #$0007` / `andi.l #$00FF00FF` applied to a ball this port is about to
 * take off the table.
 *
 * The position mask is on the CENTRE rather than the top-left, and that is not
 * an approximation: the radius is 8, so the two differ by a multiple of the
 * mask. The velocity mask goes through the original's own word: this port's Q10
 * velocity is `Q10_PER_ORIGINAL_VELOCITY_UNIT` times the original's, and `>>` is
 * the `asr` the 68000 would have used, so a negative velocity masks to the same
 * two's-complement byte the machine would have kept. A drain is nearly always
 * moving down and left or down and right at speed, so this byte is the liveliest
 * of the four fields — it is what makes two drains a pixel apart serve
 * differently rather than identically.
 */
export function troughRecordOf(ball: {
  readonly x: Q10;
  readonly y: Q10;
  readonly velocityX: Q10;
  readonly velocityY: Q10;
}): TroughRecord {
  return {
    x: q10ToPixel(ball.x) & TROUGH_POSITION_MASK,
    y: q10ToPixel(ball.y) & TROUGH_POSITION_MASK,
    velocityX: originalVelocityWord(ball.velocityX) & TROUGH_VELOCITY_MASK,
    velocityY: originalVelocityWord(ball.velocityY) & TROUGH_VELOCITY_MASK,
  };
}

/**
 * This port's Q10 velocity as the original's velocity WORD, floored.
 *
 * Floor rather than truncate-toward-zero because every shift in the engine is an
 * `asr`, and the mask that follows reads the two's-complement bit pattern: -1000
 * units is $FC18 and $FC18 & $FF is 24, which is the number the machine carries.
 * Rounding the other way for negatives would carry a different byte.
 */
function originalVelocityWord(velocityQ10: Q10): number {
  return Math.floor(velocityQ10 / Q10_PER_ORIGINAL_VELOCITY_UNIT);
}

/** Where and how fast a ball leaves the trough, in Q10. */
export interface TroughPlacement {
  readonly x: Q10;
  readonly y: Q10;
  readonly velocityX: Q10;
  readonly velocityY: Q10;
  readonly level: PlayfieldLevel;
}

/** $3E36's arithmetic, in this port's units. */
export function troughPlacement(record: TroughRecord = CLEARED_TROUGH_RECORD): TroughPlacement {
  return {
    x: pixelsToQ10(TROUGH_CENTRE_X + (record.x & TROUGH_POSITION_MASK)),
    y: pixelsToQ10(TROUGH_CENTRE_Y + (record.y & TROUGH_POSITION_MASK)),
    velocityX: originalVelocityToQ10(
      TROUGH_VELOCITY_UNITS + (record.velocityX & TROUGH_VELOCITY_MASK),
    ),
    velocityY: originalVelocityToQ10(
      TROUGH_VELOCITY_UNITS + (record.velocityY & TROUGH_VELOCITY_MASK),
    ),
    level: TROUGH_LEVEL,
  };
}

/**
 * Puts a ball in the trough, carrying the last one's low bits with it.
 *
 * `config` is no longer read — the trough is engine geometry, one place for all
 * three tables, exactly as $3E36's two immediates are one pair of constants in
 * the shared binary — but it stays in the signature because every caller has a
 * config to hand and losing the parameter would hide the fact that the SEAT is
 * still per-table even though the trough is not.
 */
export function serveBall(
  set: BallSet,
  _config: PlungerConfig = DEFAULT_PLUNGER_CONFIG,
  record: TroughRecord = CLEARED_TROUGH_RECORD,
): BallState {
  const place = troughPlacement(record);
  return spawnBall(set, place.x, place.y, place.velocityX, place.velocityY, place.level);
}

/**
 * THE ROD SWITCH: the level-0 zone the machine reads to know a ball has arrived
 * in the lane and may be kicked.
 *
 * The original's launcher does not kick "the ball that was served" — it kicks
 * whatever ball index is standing in a byte a per-table pointer names
 * ($234E(a5), read at +0x006628, `move.b (a0),d0 / beq` and no kick when it is
 * zero). That byte is a zone's occupancy byte, and the zone is in the shipped
 * data: every table carries exactly one level-0 `trigger-b` zone over the lane
 * seat, scoring nothing, and all three are the SAME rectangle —
 * (310,540)-(330,560) — as the lane floor at y=561 and the return chute are the
 * same on all three. `tests/plunger.test.ts` re-derives it from the three
 * shipped device documents rather than trusting this constant.
 *
 * It matters now in a way it never did before: a served ball spends 11 to 75
 * ticks in the return chute, and a launch press that lands in that window must
 * be consumed and do nothing (which is what the original's `beq` does) rather
 * than fire a 6000-unit kick at a ball halfway down a habitrail.
 */
export const ROD_SWITCH: {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
} = Object.freeze({ minX: 310, minY: 540, maxX: 330, maxY: 560 });

/** True when a ball is standing on the rod switch, i.e. is kickable. */
export function ballIsOnTheRod(ball: BallState): boolean {
  if (!ball.active || ball.level !== 0) return false;
  const x = q10ToPixel(ball.x);
  const y = q10ToPixel(ball.y);
  return x >= ROD_SWITCH.minX && x <= ROD_SWITCH.maxX && y >= ROD_SWITCH.minY && y <= ROD_SWITCH.maxY;
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
