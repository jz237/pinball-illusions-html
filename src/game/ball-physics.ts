/**
 * The N-ball simulation core.
 *
 * Pinball Illusions' selling point was multiball, so there is deliberately no
 * "the ball" anywhere in this module. Everything operates on a `BallSet` and
 * every rule — gravity, contact, drain, ball-to-ball — is written for an
 * arbitrary population. A single ball is just a set of size one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ALL INTEGER
 * ---------------------------------------------------------------------------
 * Positions are Q10 and velocities are signed 16-bit because that is what the
 * original did, but the reason it matters here is replay parity: a recorded
 * input sequence must produce a bit-identical trajectory on every machine, or
 * the parity tests against captured video are worthless. That rules out
 * `Math.random`, `Date`, and — less obviously — runtime trigonometry, whose
 * last bits are implementation-defined. The probe ring is therefore built from
 * integer square roots, and the only floating point anywhere near it is IEEE
 * `+ - * /`, which is correctly rounded and so is bit-identical everywhere.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CONTACT MODEL LIVES
 * ---------------------------------------------------------------------------
 * Not here. `collision-probe.ts` owns the probe ring and the ball-versus-map
 * test, and this module imports them; there is exactly one implementation and it
 * is that one. This file used to keep a private copy, which drifted from the
 * exported one on the ball's radius, the ring size, the dominant-material rule
 * and whether the bottom of the map is solid. Read that file for why the ring is
 * a gapless midpoint circle rather than N evenly spaced unit vectors — the
 * one-pixel collision line makes it a correctness requirement, not a nicety.
 *
 * THE NORMAL THE BOUNCE IS TAKEN ABOUT IS `RingProbe.normalX/normalY`, NOT THE
 * RING ENTRY. `probe.contactIndex` is the mean contact direction ROUNDED onto
 * one of the ring's 44 entries, which near the axes are 7.1 degrees apart —
 * comparable to the whole static-friction angle of atan(154/1024) = 8.55
 * degrees, so the rounding alone decided whether a ball on a shallow ramp rolled
 * or stuck. `outwardNormalOf` in collision-probe.ts has the measurement that
 * forced the change and the Law 'n Justice site it was found on.
 *
 * ---------------------------------------------------------------------------
 * THE TABLE THE PHYSICS SEES IS NOT QUITE THE BITMAP
 * ---------------------------------------------------------------------------
 * The map holds TWO collision lines and a ball rides one of them at a time, so
 * every contact test below goes through a per-level VIEW of the map rather than
 * the map itself. `playfield-levels.ts` owns both views and the rule for when a
 * ball changes level; this file only routes each ball to the right one. On top
 * of that, one of the three maps is missing its LOWER line's top border, so
 * the level-0 view also carries a per-table virtual ceiling. Only the physics
 * sees it; `pixels` is untouched and the renderer draws the table as it
 * shipped. See VIRTUAL_TOP_WALL_ROWS below — and the note under it about the
 * virtual LEFT wall, which the corrected maps no longer justify and which has
 * been deleted rather than left as a dead knob.
 *
 * ---------------------------------------------------------------------------
 * GRAVITY IS NOT THE ONLY ACCELERATION
 * ---------------------------------------------------------------------------
 * `stepBalls` adds a second one: the RAMP DRIVE, a per-8x8-block (dx, dy) looked
 * up from the ball's position and the level it is on. It is decoded from the
 * original's own data — two 42x75 block maps and a short vector list at the
 * front of slot 4 — and `table-accel.ts` holds both the decode and the reason a
 * reconstruction cannot do without it: with a 0.15 friction coefficient the
 * static-friction angle is 8.55 degrees, every ramp face shallower than that is
 * an equilibrium, and the original's answer was to drive the ball rather than to
 * pick a friction number that works everywhere. There is no such number.
 *
 * ---------------------------------------------------------------------------
 * WHY A TICK ALWAYS MAKES PROGRESS
 * ---------------------------------------------------------------------------
 * Contact is evaluated at a position the ball can actually reach, never at a
 * candidate that may lie inside the wall: from inside, the mean contact
 * direction inverts, the reflection reads as "already leaving", and the move is
 * then refused — leaving position AND velocity untouched, so every later tick is
 * bit-identical and the ball is stuck forever with speed. Instead the sweep
 * CLAMPS the move to the last free sample, the surface it stopped against
 * supplies the normal, and a pass that still cannot move kills the velocity
 * component along the refused direction. Some state changes on every tick, so no
 * configuration can repeat.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TICK IS SPENT AS A FRACTION
 * ---------------------------------------------------------------------------
 * A bounce must land in the same place however finely the tick is cut, so the
 * integrator sweeps the whole remaining tick at one-pixel resolution and spends
 * only the unconsumed fraction on the reflected velocity. See `integrateBall`
 * and `sweepToContact` for what the fixed-substep version got wrong.
 */

import type {
  BallState,
  ContactPoint,
  ContactResult,
  MaterialBehaviour,
  MaterialIndex,
  MaterialTable,
  SimulationForces,
  TableId,
  TableMap,
} from "./contracts.js";
import type { Q10 } from "../core/fixed-point.js";
import {
  Q10_ONE,
  pixelsToQ10,
  q10Clamp,
  q10IntegrateSigned16Velocity,
  q10Multiply,
  q10ToPixel,
} from "../core/fixed-point.js";
import type { RingOffsets, RingProbe } from "./collision-probe.js";
import {
  BALL_RADIUS_PIXELS,
  DEFAULT_PROBE_RADIUS,
  flagAt,
  integerSqrt,
  meanContactIndex,
  moreDeflecting,
  numberAt,
  passabilityOf,
  probeRing,
  ringOffsetsFor,
} from "./collision-probe.js";
import { SOLID_BORDER_INDEX } from "./materials.js";
import { SIMULATION_GRAVITY, VELOCITY_CLAMP_Q10 } from "./timebase.js";
import type { SurfaceResponse } from "./surface-physics.js";
import {
  LEVEL_TO_LOWER_ID,
  LEVEL_TO_UPPER_ID,
  SURFACE_ID_NONE,
  surfaceResponseFor,
} from "./surface-physics.js";
import type { TableAcceleration } from "./table-accel.js";
import type { LevelGate, PlayfieldLevel } from "./playfield-levels.js";
import {
  levelAfterCrossing,
  levelGatesFor,
  nudgeReachesLevel,
  upperLevelViewFor,
} from "./playfield-levels.js";

// The ball radius and the integer square root are defined next to the probe ring
// they are needed to build; re-exported here because callers reason about them
// as properties of the ball, not of the probe.
export { BALL_RADIUS_PIXELS, integerSqrt };

// The original's own velocity clamp, +-4095 of its units, measured twice over
// at main.seg00 +0x00B4D6 and +0x00B692 and worth 16380 Q10 per tick here — 16
// px a tick, 800 px a second. See `timebase.ts`: it is also the independent
// confirmation of the velocity bridge, because 4095>>1 is one whisker under the
// 2 px the original allows a ball to move between collision passes.
//
// It replaces a pair of signed-16-bit limits that were never a behaviour, only a
// guard against `q10IntegrateSigned16Velocity` throwing. At the old gravity
// nothing came close to either; at the measured one a flipper tip can throw a
// ball at 17.7 px a tick, so the real bound now does real work.
const VELOCITY_MIN = -VELOCITY_CLAMP_Q10;
const VELOCITY_MAX = VELOCITY_CLAMP_Q10;

/**
 * The original's rolling friction: the fraction of a resting ball's
 * along-surface speed lost in one 50 Hz frame. Q10, so 30/1024 = 2.91%.
 *
 * DECODED, not chosen. The engine's bounce takes `5*256/(8*$3a)` of the slip per
 * pass, `$3a` comes from the 256-entry per-region table in main.seg08, and the
 * bounce runs once per COLLISION PASS. The bulk region — 134 of the 256 entries
 * — has `$3a` = 21760, giving `160/21760` = 0.7353% per pass.
 *
 * THE PASS COUNT WAS THREE HERE AND IT IS FOUR. Counted directly, the unrolled
 * tick at +0x00A618 calls the contact routine $b4ba at +0x00A64C, +0x00A696,
 * +0x00A6E0 and +0x00A728 — the first of the four was missed, and this file's
 * own parenthesis used to list only the last three. So
 *
 *     1 - (1 - 160/21760)^4  =  2.9071%   ->  30 in Q10
 *
 * per frame, which is one tick here, where it used to say 22. It is a correction
 * of a miscount rather than of the timebase, but it belongs to the same audit:
 * four collision passes and eight integration sub-steps is the whole shape of
 * the original's frame, and every number derived from either had to be recounted
 * against it.
 *
 * The other seven rows of that table give 0.69% to 3.1% per pass; a per-region
 * version of this would need the RLE region map at `$50(a4)` decoded as well,
 * which has not been done, so the commonest value stands for all of them and
 * this is the ONE number in the contact model that is a table average rather
 * than a per-surface fact.
 *
 * See `reflectVelocity` for how it is used — as a CAP on the Coulomb budget of a
 * resting contact, never as a replacement for it — and why.
 */
export const ROLLING_SLIP_FRICTION: Q10 = 30;

// ---------------------------------------------------------------------------
// The virtual top wall
// ---------------------------------------------------------------------------

/**
 * Rows sealed off at the top of each table by a wall that is not in the bitmap.
 *
 * Law 'n Justice's exported collision layer has NO bit-0 pixel anywhere in rows
 * 0..34: the top arch is drawn, but on the LOWER line the arch simply is not
 * there. (It is on the upper line — see `playfield-levels.ts` — which is where
 * a launched ball goes; this wall is about the lower-level ball that never
 * should have been up there in the first place.) A lower-level ball that gets
 * over the arch escapes into a 336 px wide empty attic, roams the whole width of
 * the table and comes down somewhere it never could on the real machine.
 *
 * ---------------------------------------------------------------------------
 * RE-MEASURED AFTER THE 32 PX MAP REFRAME, AND IT SURVIVED
 * ---------------------------------------------------------------------------
 * The shipped maps were re-exported: slot 2's payload starts at byte 4, not 8,
 * so the old export framed every row 32 px left of where it belonged. That made
 * every column-indexed measurement in this codebase suspect, and this wall was
 * the first thing to re-check, because its premise is about rows that "carry no
 * bit-0 pixel" — a claim a horizontal shift could in principle have invented.
 * It did not. On the corrected map:
 *
 *   - The first row carrying ANY bit-0 pixel is still 35, and rows 35..37 carry
 *     one 38 px fragment (x=94..131) rather than a border. Rows 0..34 are empty
 *     on the lower line, exactly as before.
 *   - Flooding free lower-level ball centres out of the CORRECTED serve point
 *     (322,544) — the lane moved 32 px right, so the flood had to be re-seeded
 *     and this is the re-seeded one: 104246 reachable centres with no wall, of
 *     which 8242 are above row 35 — the attic. With this wall, 10760 reachable
 *     and 188 in the attic. The walled flood's lowest row is 552, i.e. it does
 *     NOT reach the drain, which is the premise of the whole two-level model:
 *     the launch shot must leave the lane on the upper line.
 *   - 26 is still chosen by connectivity, not by eye. Sweeping the wall height
 *     and counting reachable centres in the upper-left quadrant (x < 168,
 *     y < 300), the quadrant stays connected to the lane for every value from 0
 *     to 43 — 30186 at 0, 2888 at 26, 2412 at 43 — and is severed at 44, where
 *     the count drops to zero and the ball can no longer be fed onto the table
 *     at all. The severance row is 44 under both framings, which is what a
 *     row-indexed measurement being invariant under a horizontal reframe looks
 *     like. 26 sits with wide margin on the safe side of it.
 *   - The consequence for the LANE bound: on this view a radius-8 centre cannot
 *     be above row 34, which is why `LAW_N_JUSTICE_SHOOTER_LANE.topY` is 34 and
 *     not the raw bitmap's 8. See `plunger.ts`.
 *
 * The other two tables are properly walled in their own data and get 0. This is
 * per-table configuration, deliberately explicit and in one place, because it is
 * a correction to specific shipped data rather than a rule about pinball.
 *
 * ---------------------------------------------------------------------------
 * THERE WAS A VIRTUAL LEFT WALL HERE TOO. IT IS GONE. DO NOT PUT IT BACK
 * WITHOUT NEW EVIDENCE
 * ---------------------------------------------------------------------------
 * `VIRTUAL_LEFT_WALL_COLUMNS` sealed nine columns down the left of Extreme
 * Sports and nothing on the other two. Its stated derivation was "bit 1 is solid
 * at x=6..8 on EVERY row from y=50 to y=390, so nine columns is the upper line's
 * own border and nothing more". On the corrected map that rail is at x=38..40 —
 * 38 px in from the edge, not 6 — and there is a SECOND continuous bit-1 line at
 * x=16..18 (set on every row of y=33..397, the longest such run on the table).
 * Neither is at x=0..8. The constant named nothing.
 *
 * It also did nothing. Over thirty scripted games a table at every plunge
 * strength — the same census `tests/plays.test.ts` runs — the results with the
 * wall at 0, at 9 and at 19 are identical: 73 drains and two write-offs on
 * Extreme Sports, both at (50,432), which is a ball resting on the crown of a
 * post in the middle of the left playfield and nothing to do with the edge. No
 * ball entered the strip at all, on any table, at any setting. On the other two
 * tables the lower-level flood from the serve point never reaches the left of
 * the table in the first place, so the knob was already inert for them.
 *
 * And the premise itself is weaker than it read. Where Extreme Sports' LOWER
 * line draws a left border it draws it at x=0..3 (bit 0 is set at column 2 on
 * 195 rows and at column 0 on 106 consecutive rows, y=415..520) — at the table
 * edge, not 6 px in. A wall named for a rail that is 32 px from where it was
 * thought to be, sealing a strip no ball ever enters, is a hypothesis with
 * nothing left holding it up.
 *
 * ---------------------------------------------------------------------------
 * AND BABEWATCH IN PARTICULAR DOES NOT WANT ONE BACK
 * ---------------------------------------------------------------------------
 * BabeWatch was the table most likely to need a left wall after the reframe,
 * because the correction gave it a left border it did not appear to have before
 * (bit 0 at column 0 on 49 rows under the old framing, 540 under the corrected
 * one). Re-measured on the shipped map, that border is now the argument AGAINST
 * a wall rather than for one:
 *
 *   bit 0 set at column 0 on 540 of 600 rows, and somewhere in columns 0..2 on
 *   541 of 600. Every row of the table carries a bit-0 pixel somewhere, and the
 *   median leftmost one is column 0.
 *
 * And the decisive figure is the same one on all three tables: the number of
 * rows on which a radius-8 ball centre can be free at x < 8 is ZERO — on
 * BabeWatch, on Law 'n Justice and on Extreme Sports alike. The leftmost free
 * lower-line centre anywhere on any of the three is exactly x=8, which is the
 * ball's own radius against the edge of the bitmap, where `table-map.ts` answers
 * OUT_OF_BOUNDS_MATERIAL (bit 0 set). The edge already contains the ball. A
 * virtual left wall would be sealing columns no ball can occupy.
 */
export const VIRTUAL_TOP_WALL_ROWS: Readonly<Record<TableId, number>> = Object.freeze({
  "law-n-justice": 26,
  babewatch: 0,
  "extreme-sports": 0,
});

/**
 * The lower playfield as the physics sees it: the shipped bitmap plus the
 * virtual top wall.
 *
 * Only `materialAt` is overridden. `pixels` is left alone, so the renderer draws
 * the table as it shipped and nothing paints a wall that is not really there.
 *
 * A ball whose centre is placed inside the sealed rows is in solid material like
 * any other, and `recoverPenetration` will push it out only if free space is
 * within a ball diameter — spawn points belong on the playfield, not in the wall.
 *
 * There is no arch parameter here and there must not be one. An earlier version
 * carried a SYNTHESISED top arch — a ceiling that ramped `depth` px lower over
 * `span` px at the right edge — to deflect a launched ball out of the shooter
 * lane. It is gone because the real arch was found: it is authored map data on
 * the upper collision line, and `playfield-levels.ts` uses it. Do not add a
 * fabricated ceiling back; the 30-in-60 version also cut the flipper return from
 * over 20 px of gain to 10.
 */
export function playfieldViewFor(map: TableMap, topWallRows: number): TableMap {
  if (topWallRows <= 0) return map;
  return Object.freeze({
    tableId: map.tableId,
    displayName: map.displayName,
    width: map.width,
    height: map.height,
    pixels: map.pixels,
    materialAt(x: number, y: number): MaterialIndex {
      // Floor, matching the loader, so a probe converts to the same pixel here
      // as it would there. NaN floors to NaN, fails the comparison and falls
      // through to the map's own out-of-bounds answer.
      if (Math.floor(y) < topWallRows) return SOLID_BORDER_INDEX;
      return map.materialAt(x, y);
    },
  });
}

/**
 * Both level views for one map, built once per tick.
 *
 * The upper view is cached by `upperLevelViewFor`, so this is a lookup rather
 * than a closure allocation; the lower one is rebuilt because it depends on the
 * caller's wall settings.
 */
interface LevelViews {
  readonly lower: TableMap;
  readonly upper: TableMap;
}

function levelViewsFor(map: TableMap, topWallRows: number): LevelViews {
  return {
    lower: playfieldViewFor(map, topWallRows),
    upper: upperLevelViewFor(map),
  };
}

function viewForLevel(views: LevelViews, level: PlayfieldLevel): TableMap {
  return level === 1 ? views.upper : views.lower;
}

/** Tunables for one simulation. Every default is a chosen value, not a measured one. */
export interface SimulationOptions {
  /** Ball radius in Q10. Also the radius of the contact probe ring. */
  readonly radius: Q10;
  /**
   * Largest distance the centre may travel between two contact probes. Half the
   * radius, so a ball cannot skip past a wall thinner than the probe ring can
   * see.
   *
   * It is a declared upper bound, not a step size: `sweepToContact` probes every
   * pixel of the path, which is finer than any value this may sensibly hold, so
   * the bound is satisfied with room to spare and the trajectory does not depend
   * on it. It used to BE the step size, and that is exactly what made a bounce
   * land in a different place depending on how the tick happened to divide.
   */
  readonly maxSubstepDistance: Q10;
  /**
   * Inward speed below which a contact stops the ball dead instead of bouncing.
   * Without this a ball sitting on a slope re-bounces on its own weight every
   * tick and never settles. See REST_THRESHOLD.
   */
  readonly restThreshold: number;
  /** Centre y past which the ball has left the table. Null means the map bottom. */
  readonly drainY: Q10 | null;
  /**
   * Rows of virtual wall across the top of the map, closing a top border the
   * shipped collision layer does not draw. Null means "whatever this table needs"
   * — see VIRTUAL_TOP_WALL_ROWS, which is 26 for Law 'n Justice and 0 for the
   * other two. Pass 0 to simulate the raw bitmap with no correction at all.
   */
  readonly topWallRows: number | null;
  /** Ball-to-ball collision. On by default; multiball is the whole point. */
  readonly ballToBall: boolean;
  /**
   * The table's RAMP DRIVE: the per-8x8-block acceleration the original added
   * to velocity beside gravity. See `table-accel.ts`.
   *
   * Null means no drive, and that is the right default for the many unit tests
   * below that simulate on synthetic maps where "a ramp" means nothing. It is
   * NOT a safe default for a real table — a shallow ramp face is an equilibrium
   * under the contact model's friction angle and a ball that reaches one stops
   * for good — so the game loop does not go through this option's default:
   * `createGame` obtains the drive from `tableAccelerationFor`, which throws
   * rather than answering null. There is no path to a real game without it.
   */
  readonly rampDrive: TableAcceleration | null;
  /**
   * False while the table is TILTED: the coils are dead.
   *
   * The original gates the bumper latch (+0x00B216) and the slingshot latch
   * (+0x00B234) on the tilt flag, so a tilted table's powered faces impart no
   * kick and no tangential throw — but they keep their own restitution,
   * because the surface-row load runs before either gate. This flag reproduces
   * exactly that: with it false, `surfaceResponseFor(id, false)` answers the
   * disarmed row and nothing else about the contact changes.
   */
  readonly poweredKicksLive: boolean;
  /**
   * The table's SURFACE-ID MAP: one byte per pixel per level, naming what the
   * ball is touching rather than merely whether it is solid.
   *
   * Null means "this map has no surface layer", which is right for every
   * synthetic map in the test suite and for nothing else. With it, three things
   * change and all three are the original's own behaviour:
   *
   *   - restitution comes from the 256-row table in `surface-physics.ts`, keyed
   *     by the id under the contact, instead of from the pixel index;
   *   - ids 16..21 fire a POP BUMPER and 22..31 a SLINGSHOT, adding the measured
   *     kick to the inward normal speed before restitution, exactly where the
   *     original adds it;
   *   - every id the ball touched in the tick is reported in `StepResult`, which
   *     is what the scoring layer runs on.
   *
   * Nullable rather than required for the same reason `rampDrive` is not: the
   * physics tests below build maps that have no such thing, and a simulation
   * that refused to run without one would take the whole suite with it. The game
   * loop does register it — see `createGame`.
   */
  readonly surfaces: SurfaceIdMap | null;
}

/**
 * The slice of the scoring document the physics needs: a surface id per pixel
 * per level. `TableDevices` satisfies it structurally, so nothing here has to
 * know what a device or an award is.
 */
export interface SurfaceIdMap {
  surfaceIdAt(level: PlayfieldLevel, x: number, y: number): number;
  /** The level a hand-off zone at this point sends the ball to, or null. */
  levelChangeAt(level: PlayfieldLevel, x: number, y: number): PlayfieldLevel | null;
}

/**
 * The rest threshold, in Q10 per tick: a bounce smaller than this is no bounce.
 *
 * RE-DERIVED ON THE CORRECTED TIMEBASE, not scaled by habit. This is a port
 * constant — the original settles a ball with its per-surface `$38` minimum
 * impact word, which is a parameter of a contact model this port does not have —
 * but it is a constant whose only meaningful unit is TICKS OF GRAVITY. A ball
 * lying on a surface approaches it at exactly one tick of gravity per tick, and
 * the threshold has to sit far enough above the bounce that produces to stop the
 * chatter and far enough below a real impact to leave one alone.
 *
 * It was 160 against a gravity of 24, i.e. 20/3 of a tick of gravity, and that
 * ratio is what is preserved: 128 * 20/3 = 853. Left as 160 it would have been
 * 1.25 ticks of gravity, and every ball on every slope would have chattered.
 *
 * Written as the arithmetic rather than as a literal so that it cannot be left
 * behind if gravity is ever re-measured again.
 */
export const REST_THRESHOLD: Q10 = Math.trunc((SIMULATION_GRAVITY * 20) / 3);

export const DEFAULT_SIMULATION_OPTIONS: SimulationOptions = {
  radius: DEFAULT_PROBE_RADIUS,
  maxSubstepDistance: DEFAULT_PROBE_RADIUS >> 1,
  restThreshold: REST_THRESHOLD,
  drainY: null,
  topWallRows: null,
  ballToBall: true,
  poweredKicksLive: true,
  rampDrive: null,
  surfaces: null,
};

interface ResolvedOptions {
  readonly radius: Q10;
  readonly maxSubstepDistance: Q10;
  readonly restThreshold: number;
  readonly drainY: Q10;
  readonly topWallRows: number;
  readonly ballToBall: boolean;
  readonly poweredKicksLive: boolean;
  readonly rampDrive: TableAcceleration | null;
  readonly surfaces: SurfaceIdMap | null;
}

/**
 * Resolved with `??` rather than object spread: under `exactOptionalPropertyTypes`
 * a partial may legitimately carry an explicit `undefined`, and spreading that
 * would silently wipe the default instead of falling back to it.
 */
function resolveOptions(map: TableMap, options?: Partial<SimulationOptions>): ResolvedOptions {
  const radius = options?.radius ?? DEFAULT_SIMULATION_OPTIONS.radius;
  if (radius <= 0) {
    throw new RangeError(`ball radius must be positive: ${radius}`);
  }
  const maxSubstepDistance = options?.maxSubstepDistance ?? Math.max(1, radius >> 1);
  if (maxSubstepDistance <= 0) {
    throw new RangeError(`maxSubstepDistance must be positive: ${maxSubstepDistance}`);
  }
  const topWallRows = options?.topWallRows ?? VIRTUAL_TOP_WALL_ROWS[map.tableId];
  if (!Number.isInteger(topWallRows) || topWallRows < 0 || topWallRows >= map.height) {
    throw new RangeError(
      `topWallRows must be a whole number of rows inside the map (0..${map.height - 1}): ${topWallRows}`,
    );
  }
  return {
    radius,
    maxSubstepDistance,
    restThreshold: options?.restThreshold ?? DEFAULT_SIMULATION_OPTIONS.restThreshold,
    drainY: options?.drainY ?? pixelsToQ10(map.height),
    topWallRows,
    ballToBall: options?.ballToBall ?? DEFAULT_SIMULATION_OPTIONS.ballToBall,
    poweredKicksLive: options?.poweredKicksLive ?? DEFAULT_SIMULATION_OPTIONS.poweredKicksLive,
    rampDrive: options?.rampDrive ?? DEFAULT_SIMULATION_OPTIONS.rampDrive,
    surfaces: options?.surfaces ?? DEFAULT_SIMULATION_OPTIONS.surfaces,
  };
}

/** A live population of balls. Ids are never reused, so a replay log stays readable. */
export interface BallSet {
  readonly balls: BallState[];
  nextId: number;
}

/**
 * One ball. Positions are Q10; use `pixelsToQ10` at the call site so the units
 * are visible there rather than hidden behind a helper.
 */
export function createBall(
  id: number,
  x: Q10,
  y: Q10,
  velocityX = 0,
  velocityY = 0,
  level: PlayfieldLevel = 0,
): BallState {
  if (!Number.isInteger(id) || id < 0) {
    throw new RangeError(`ball id must be a non-negative integer: ${id}`);
  }
  return {
    id,
    x: x | 0,
    y: y | 0,
    velocityX: clampVelocity(velocityX),
    velocityY: clampVelocity(velocityY),
    active: true,
    // Nothing is ever created already held: being held is something a ball earns
    // by rolling into a saucer during a tick. See `ball-locks.ts`.
    heldBy: null,
    // Balls start on the playfield. Nothing is served onto a ramp: a ball
    // reaches the upper level by driving through a hand-off, never by being
    // placed there, so the level is always something the run earned.
    level,
  };
}

export function createBallSet(balls: readonly BallState[] = []): BallSet {
  let highest = -1;
  for (const ball of balls) {
    if (ball.id > highest) highest = ball.id;
  }
  return { balls: [...balls], nextId: highest + 1 };
}

/** Adds a ball with the next free id and returns it, so the caller can steer it. */
export function spawnBall(
  set: BallSet,
  x: Q10,
  y: Q10,
  velocityX = 0,
  velocityY = 0,
  level: PlayfieldLevel = 0,
): BallState {
  const ball = createBall(set.nextId, x, y, velocityX, velocityY, level);
  set.nextId += 1;
  set.balls.push(ball);
  return ball;
}

export function ballById(set: BallSet, id: number): BallState | undefined {
  return set.balls.find((ball) => ball.id === id);
}

export function activeBalls(set: BallSet): BallState[] {
  return set.balls.filter((ball) => ball.active);
}

export function activeBallCount(set: BallSet): number {
  let count = 0;
  for (const ball of set.balls) {
    if (ball.active) count += 1;
  }
  return count;
}

/**
 * True when a ball is on the table AND in play — not drained and not sitting in
 * a lock.
 *
 * The distinction matters everywhere a rule asks "is there still a ball to
 * play": a held ball is on the table and drawn, but it will never move, never
 * drain and never close a switch, so counting it as in play stalls the serve,
 * feeds the ball search a ball that can never satisfy it, and pins the camera to
 * the whole-table view for a single rolling ball. See `ball-locks.ts`.
 */
export function ballIsInPlay(ball: BallState): boolean {
  return ball.active && ball.heldBy === null;
}

/** The balls actually in play: active, and not held by a lock. */
export function freeBalls(set: BallSet): BallState[] {
  return set.balls.filter(ballIsInPlay);
}

export function freeBallCount(set: BallSet): number {
  let count = 0;
  for (const ball of set.balls) {
    if (ballIsInPlay(ball)) count += 1;
  }
  return count;
}

/**
 * Drops drained balls from the set.
 *
 * Optional, and deliberately not automatic: ball-lifecycle rules want to see a
 * drained ball for at least the tick it drained on. `nextId` is untouched, so
 * ids never get reused after a prune either.
 */
export function pruneInactiveBalls(set: BallSet): void {
  const kept = set.balls.filter((ball) => ball.active);
  set.balls.length = 0;
  set.balls.push(...kept);
}

/** What one tick did, beyond mutating the balls themselves. */
export interface StepResult {
  /** Ids that left the table this tick, in ascending set order. */
  readonly drained: readonly number[];
  /**
   * Contacts by ball id, for the device and scoring layers. Absent when free.
   *
   * Every solid pixel the ball's ring touched anywhere in the tick is here, not
   * merely the last substep's: a fast ball that clips a slingshot on substep 1
   * and a wall on substep 3 must score the slingshot. Repeats of the same pixel
   * across substeps are folded together, so one surface touched throughout a
   * tick is one set of contacts rather than one per substep.
   */
  readonly contacts: ReadonlyMap<number, ContactResult>;
  /**
   * SURFACE IDS touched by each ball this tick, in first-touch order, deduped.
   *
   * Empty unless `options.surfaces` was supplied. This is the input the scoring
   * layer runs on and it is deliberately the WHOLE tick's set rather than the
   * blocker's single id: the original's device dispatch runs off the collision
   * pass, and a ball that clips a drop target and a wall in the same tick has hit
   * the target whichever of the two turned it around.
   *
   * Order is the order the ids were first seen, which is a function of the ring
   * scan and the substep sequence and therefore reproducible.
   */
  readonly surfaces: ReadonlyMap<number, readonly number[]>;
}

function clampVelocity(value: number): number {
  return q10Clamp(Math.trunc(value), VELOCITY_MIN, VELOCITY_MAX);
}

/**
 * Reflects a ball's velocity about an outward normal.
 *
 * Split into a normal and a tangential part: the normal part is reversed and
 * scaled by elasticity, the tangential part is reduced by a friction IMPULSE,
 * and the material's kick is added outward on top.
 *
 * A ball that is already leaving the surface is left ENTIRELY alone — not merely
 * left with its normal speed, as an earlier version did. Friction and kick are
 * responses to an impact, and re-applying them on every substep that still sees
 * the surface made the substep count physically significant: the substep count
 * is `ceil(speed / maxSubstepDistance)`, so a ball at 4097 Q10/tick kept 72% of
 * its tangential speed where one at 4096 kept 85%, and the cliff repeated at
 * every multiple of the substep distance. Responding only to approach costs the
 * same whatever the tick was cut into.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TANGENTIAL LOSS IS AN IMPULSE AND NOT A PERCENTAGE
 * ---------------------------------------------------------------------------
 * It used to be `tangent * (1 - friction)`: a flat 15% of the ball's ENTIRE
 * along-surface speed, taken every time this function ran. The guard above was
 * documented as confining that to real impacts — "no normal force, no friction"
 * — and it does not, because `stepBalls` adds gravity to `velocityY` before
 * every integration. A ball merely LYING on a surface is therefore approaching
 * it on every single tick, `normalSpeedIn` is negative every time, and the guard
 * never fires. The percentage rule then acted as a viscous damper on a resting
 * ball, removing 15% of its speed along the surface every 20 ms forever.
 *
 * What that produces is not a ball that stops; it is a ball that never speeds
 * up. Balancing one tick of gravity against the decay gives a TERMINAL CRAWL
 *
 *     v = g * sin(theta) * (1 - f) / f  =  135 * sin(theta) Q10/tick
 *
 * for f = 0.15 and the gravity of 24 this project then had — between 0.001 and
 * 0.036 px/tick, one to two pixels a second, on every slope on every table. (The
 * measured gravity is 128, which would make that crawl 5.33x faster and no less
 * wrong; the rule was rejected on its shape, not on its size.) Traced on the
 * shipped maps at the time, balls
 * written off by the ball search were not wedged at all: at Extreme Sports'
 * (247,144) the ball advanced exactly 36 Q10 on every one of the 500 ticks the
 * search counted, and at Law 'n Justice's (40,122) exactly 1 Q10 per tick — a
 * pixel every twenty seconds. The search asks for 8 px in 500 ticks, i.e. 16.4
 * Q10/tick, so every slope shallower than about 7 degrees was uncleanable and a
 * ball still visibly rolling got written off as lost.
 *
 * Coulomb's rule is that the tangential loss is bounded by the friction
 * coefficient times the NORMAL IMPULSE, which for a ball resting on a surface is
 * one tick of gravity and nothing more. So the loss is computed as a speed
 * decrement, `min(|tangent|, friction * normalImpulse)`, and subtracted:
 *
 *   - On an impact the normal impulse is large and the loss is large, so a
 *     graze still scrubs off tangential speed the way it always did.
 *   - On a resting contact the normal impulse is ~128 Q10 — one tick of the
 *     measured gravity — and the loss is ~19, while gravity contributes
 *     `128 * sin(theta)` along the surface. The ball
 *     therefore ACCELERATES down any slope steeper than `atan(friction)` and is
 *     held still on anything shallower — which is the static-friction condition,
 *     and is the behaviour a slope is supposed to have.
 *
 * The kick is excluded from the normal impulse on purpose: a slingshot's coil
 * fires along the normal after the ball has already bounced, and charging its
 * energy for tangential friction would make powered devices scrub the shot they
 * exist to launch.
 *
 * Integer and deterministic throughout: `integerSqrt` for the tangential
 * magnitude, one Q10 divide for the scale.
 */
export function reflectVelocity(
  ball: BallState,
  behaviour: MaterialBehaviour,
  normalX: number,
  normalY: number,
  restThreshold: number,
  surface: SurfaceResponse | null = null,
): void {
  const normalSpeedIn = q10Multiply(ball.velocityX, normalX) + q10Multiply(ball.velocityY, normalY);
  if (normalSpeedIn >= 0) return;

  const tangentX = ball.velocityX - q10Multiply(normalSpeedIn, normalX);
  const tangentY = ball.velocityY - q10Multiply(normalSpeedIn, normalY);

  // ---------------------------------------------------------------------------
  // THE SURFACE, WHEN THE MAP HAS ONE, OUTRANKS THE PIXEL INDEX
  // ---------------------------------------------------------------------------
  // The original does not look a coefficient up by pixel index at all — it reads
  // the SURFACE ID under the contact and indexes a 256-row table. When the caller
  // supplied a surface map that is what happens here too, and `behaviour`
  // contributes only its friction, which is the one coefficient the original has
  // no importable equivalent for. Without a surface map nothing below changes and
  // the arithmetic is bit-identical to what it always was.
  //
  // The kick goes in BEFORE the restitution because that is where the original
  // puts it — `subi.w #$157c,d0` at +0x00B588 and `subi.w #$dac,d0` at +0x00B5E0
  // both precede the `muls.w $36(a4),d0` at +0x00B620 — so a pop bumper's 5500
  // units are scaled by the bumper's own 0.348 restitution, not added on top of
  // it. Each has a minimum approach speed and below it the surface is an ordinary
  // wall: 50 units for a bumper, 100 for a slingshot.
  const elasticity = surface === null ? behaviour.elasticity : surface.elasticity;
  const fires =
    surface !== null && surface.kick > 0 && -normalSpeedIn >= surface.kickThreshold;
  const drivenIn = fires && surface !== null ? normalSpeedIn - surface.kick : normalSpeedIn;

  const bounced = -q10Multiply(drivenIn, elasticity);
  // A ball creeping into the surface under gravity must settle, not chatter.
  const deflected = bounced <= restThreshold ? 0 : bounced;
  const normalSpeedOut = deflected + (surface === null ? behaviour.kick : 0);

  // The surface's reaction: the ball's approach killed, plus whatever of it is
  // handed back elastically. Never negative, so the friction budget cannot be.
  //
  // Measured from the UNPOWERED reflection even when a coil fired, for the reason
  // the header gives: a slingshot's energy must not be charged to the tangential
  // friction budget, or the device scrubs the very shot it exists to launch. With
  // no kick this is exactly `-normalSpeedIn + deflected` as before.
  const passiveBounce = -q10Multiply(normalSpeedIn, elasticity);
  const passiveDeflected = passiveBounce <= restThreshold ? 0 : passiveBounce;
  const normalImpulse = -normalSpeedIn + passiveDeflected;
  const friction = q10Clamp(behaviour.friction, 0, Q10_ONE);
  // A loss that rounds to nothing is not a loss. `friction * normalImpulse`
  // truncates to zero once the impulse is under 1/friction — about 7 Q10 units
  // for a wall — and a ball wedged in a corner sits at exactly that scale: on
  // Law 'n Justice a ball in the top-left triangle held v = (-1, 1) for
  // seven hundred consecutive ticks, moving one Q10 unit a tick, which is half a
  // pixel per ball-search window and so never left the box. It was in contact,
  // it was sliding, and the model was taking nothing off it. One unit is the
  // smallest loss the integer state can express, so a sliding contact always
  // costs at least that and the tangential speed is guaranteed to reach zero in
  // finite time. It is bounded by the speed itself below, so it can never push
  // the ball backwards, and against a rolling ball on a slope — which gains up
  // to a whole tick of gravity, 128 units — one unit is noise.
  //
  // ---------------------------------------------------------------------------
  // AND ON A RESTING CONTACT THE COULOMB BUDGET IS CAPPED BY THE ORIGINAL'S OWN
  // ROLLING RULE, WHICH IS WHAT CLOSES THE SHALLOW-SLOPE TRAPS
  // ---------------------------------------------------------------------------
  // Coulomb friction has a STATIC FRICTION ANGLE: `atan(154/1024)` = 8.55
  // degrees, below which the budget is at least as large as the tangential speed
  // gravity supplies and a ball lying on the surface is held there for the rest
  // of the game. The tables are full of surfaces shallower than that, because a
  // real ramp is nearly flat, and no choice of coefficient escapes it — raising
  // friction widens the band and lowering it turns the whole table to ice.
  //
  // THE ORIGINAL HAS NO SUCH ANGLE, because it has no Coulomb term at all. Its
  // bounce is at main.seg00 +0x00B620 and its whole tangential rule is
  //
  //     00b626  move.w  $3a(a4), d5
  //     00b62a  move.w  $26(a4), d3     ; ball SPIN
  //     00b62e  sub.w   d2, d3          ;  - tangential speed = the SLIP
  //     00b632  asl.l   #8, d3
  //     00b634  divs.w  d5, d3          ;  / $3a
  //     00b638  asl.w   #2, d3          ; x 5/8
  //     00b63a  add.w   d4, d3
  //     00b63c  asr.w   #3, d3
  //     00b63e  add.w   d3, d2          ; tangential += that
  //     00b640  sub.w   d4, $26(a4)     ; spin -= the same
  //
  // — a fraction of the SLIP between the ball's spin and its along-surface speed,
  // so a ball rolling without slipping loses nothing whatever, and NO slope,
  // however shallow, can hold a ball. `$3a` comes from a 256-entry per-region
  // table in main.seg08 whose eight distinct rows give slip fractions
  // `5*256/(8*$3a)` of 0.0069 to 0.031 per bounce, and the bounce runs FOUR
  // times a frame (the unrolled tick is four groups of a collision-and-bounce
  // at +0x00A64C, +0x00A696, +0x00A6E0 and +0x00A728 followed by two
  // integrations each; this used to say three and had missed the first).
  //
  // This port cannot adopt that rule wholesale, and it is worth saying why so
  // nobody tries it as a simplification: friction on SLIP needs a spin state
  // `BallState` does not have, and dropping the spin term leaves friction
  // proportional to the whole tangential speed — the percentage model this file
  // already measured and rejected above, which caps a ball on a slope at
  // `g*sin(theta)/f` instead of letting it accelerate. At the decoded coefficient
  // that cap is 789 Q10/tick on a 45-degree ramp, under the 1000 that "lets a
  // ball on a slope accelerate instead of settling into a crawl" demands.
  //
  // So the two rules are combined the only way that keeps what each is right
  // about: ON A RESTING CONTACT THE LOSS IS THE SMALLER OF THE TWO. Coulomb
  // never gets to take more than the original's rolling friction would, and the
  // proportional rule never gets to cap a fast ball, because the moment it
  // exceeds the Coulomb budget the budget wins. `resting` is `deflected === 0`,
  // i.e. the approach was too gentle to bounce — for a plain wall an approach
  // under 0.25 px/tick — so every graze, bounce and flipper shot is charged full
  // Coulomb exactly as before and no impact behaviour changes.
  //
  // What that buys, in the two regimes that matter:
  //
  //   - A BALL LYING ON A SHALLOW SLOPE ACCELERATES. Below about 890 Q10/tick of
  //     tangential speed the proportional loss is under the Coulomb budget of 19,
  //     so the ball keeps a strictly positive share of the `g*sin(theta)` gravity
  //     hands it and accumulates it tick over tick. On the 7.1 to 7.9 degree
  //     faces this work was about — Law 'n Justice (86,156), BabeWatch (91,171),
  //     Extreme Sports' plateau shoulders — it settles at about 890 Q10/tick,
  //     which is far past the 8 px per 500-tick window the ball search asks for.
  //     (Both figures are `budget / ROLLING_SLIP_FRICTION` and both moved with
  //     gravity: the budget is a fraction of one tick of it, so the crossover
  //     rises by the same 16/3 the timebase correction applied everywhere else.)
  //   - A FAST BALL IS UNTOUCHED. Above that the minimum is the Coulomb
  //     budget and the rule is bit-for-bit what it was. That matters: an earlier
  //     attempt exempted resting contacts outright, and because a ball rolling
  //     FAST along a floor also approaches it at only one tick of gravity, that
  //     quietly removed friction from fast rolling everywhere — Law 'n Justice
  //     balls carried the extra speed into the left rail and 17 of 90 census
  //     balls died at (8,236) that had drained before.
  //
  // A ball on LEVEL ground still comes to rest: there is no tangential speed to
  // keep, so the floor takes what little there is — on flat floors, in the bottom
  // of cups, and on a raised flipper bat. And the one-unit floor still applies,
  // so a sliding contact still always costs something and a wedged ball still
  // reaches zero in finite time.
  //
  // The band is narrowed, not closed. Below about `atan(1/gravityY)` — 2.4
  // degrees at the gravity of 24 this was written against, and 0.45 degrees at
  // the measured 128, so the timebase correction narrows it by another 5.33x —
  // one tick of gravity contributes less than one Q10 unit along the
  // surface and the floor holds the ball. That is left alone and is not a fudge:
  // a 2.4 degree surface is flat, and a genuinely flat trap — Extreme Sports has
  // one, a flat-topped mound whose crown at x=113..125, y=106 has an exactly
  // vertical contact normal — is emptied on the real machine by a coil, in the
  // device layer this reconstruction does not have yet.
  const budget = q10Multiply(friction, normalImpulse);
  const full = friction > 0 && normalImpulse > 0 ? Math.max(1, budget) : budget;
  const tangentSpeed = integerSqrt(tangentX * tangentX + tangentY * tangentY);
  const resting = passiveDeflected === 0 && friction > 0 && normalImpulse > 0;
  // ---------------------------------------------------------------------------
  // A FIRED COIL TAKES THE ORIGINAL'S OWN TANGENTIAL TOLL, NOT COULOMB'S
  // ---------------------------------------------------------------------------
  // At a powered contact the original's tangential rule is at 0xB626-0xB660:
  // the slip exchange against ball spin, "and a 1/16+1 per-contact decay" —
  // the along-surface speed PASSES THROUGH a bumper hit nearly intact. The
  // Coulomb budget above, charged on a bumper's enormous normal impulse, took
  // ~60% of it instead, and that difference is the whole of the B3 trap: two
  // facing bumper rims are CONVEX, so any drift along the channel between them
  // is amplified bounce over bounce and walks the ball out — the original's
  // escape mechanism, fed by gravity's fresh 128 Q10 of drift every tick — but
  // a 60% scrub per hit killed the drift faster than the geometry amplified
  // it, re-centring the orbit onto the head-on line forever. Reproduced from
  // the sweep's own pinch site: ±(10868, 4370) Q10 between Extreme Sports'
  // bumpers 16/17 for 3000+ ticks with Coulomb, out in a few hundred with the
  // original's decay. The spin half of the exchange still needs a spin state
  // this port does not have (see the long note above); the decay half is
  // adopted exactly, and it is the half that decides the trap.
  const drop = fires
    ? Math.min(tangentSpeed, (tangentSpeed >> 4) + 1)
    : resting
      ? Math.max(1, Math.min(budget, q10Multiply(ROLLING_SLIP_FRICTION, tangentSpeed)))
      : full;
  // Friction opposes sliding; it cannot reverse it, so the loss stops at rest.
  const keep =
    tangentSpeed <= drop ? 0 : Math.trunc(((tangentSpeed - drop) * Q10_ONE) / tangentSpeed);

  // A SLINGSHOT ALSO THROWS ALONG ITS FACE. The original's `add.w $6(a4),d2` at
  // +0x00B5E4 adds +400 or -400 to the tangential speed, the sign chosen by
  // whether the surface id is even or odd — a slingshot is two ids, one per
  // face, and the sign is which way that face throws.
  //
  // The direction used is the outward normal turned a quarter turn, so it is a
  // property of the SURFACE and not of how the ball happened to arrive; a ball
  // that comes in dead square still gets thrown along the face, which is what a
  // kicker arm does. Which of the two rotations the original called positive is
  // not recoverable from the data — only that the two faces of one slingshot
  // disagree — so the handedness is this port's and the ANTISYMMETRY is the
  // original's. Added after the friction for the reason the header already gives
  // for the normal kick: a coil's energy must not be charged to the tangential
  // friction budget.
  const tangentKick = surface === null ? 0 : surface.tangentKick;
  ball.velocityX = clampVelocity(
    q10Multiply(tangentX, keep) + q10Multiply(normalSpeedOut, normalX) - q10Multiply(tangentKick, normalY),
  );
  ball.velocityY = clampVelocity(
    q10Multiply(tangentY, keep) + q10Multiply(normalSpeedOut, normalY) + q10Multiply(tangentKick, normalX),
  );
}

/** True when a ball centre may legally sit at this Q10 position. */
function centreIsFree(
  map: TableMap,
  passable: readonly boolean[],
  x: Q10,
  y: Q10,
): boolean {
  const py = q10ToPixel(y);
  // Past the bottom row there is no table left; that is the drain, not a wall.
  if (py >= map.height) return true;
  // `materialAt` answers with the solid border material outside the bitmap, so
  // this covers left, right and top out-of-bounds without a separate check.
  return flagAt(passable, map.materialAt(q10ToPixel(x), py));
}

/** How far along a straight centre path the ball may legally travel. */
interface SweepLimit {
  readonly x: Q10;
  readonly y: Q10;
  /** True when solid material stopped the sweep short of its target. */
  readonly clamped: boolean;
}

/**
 * The furthest point on the straight path of the ball *centre* whose centre
 * pixel is free.
 *
 * This is the anti-tunnelling backstop. The probe ring already sees a wall a
 * full radius before the centre reaches it, but the ring is a finite set of
 * points and a pathological one-pixel diagonal could slip between two of them;
 * the centre sweep cannot, because it samples at one-pixel intervals. It never
 * fires for a ball rolling on a floor, since the centre stays a radius clear.
 *
 * It CLAMPS rather than rejecting. Rejecting the whole substep was how a ball
 * could spend a tick changing nothing at all, which — the velocity being
 * unchanged too — repeats forever.
 */
function sweepLimit(
  map: TableMap,
  passable: readonly boolean[],
  fromX: Q10,
  fromY: Q10,
  toX: Q10,
  toY: Q10,
): SweepLimit {
  const deltaX = toX - fromX;
  const deltaY = toY - fromY;
  if (deltaX === 0 && deltaY === 0) return { x: fromX, y: fromY, clamped: false };

  const span = Math.max(Math.abs(deltaX), Math.abs(deltaY));
  const samples = Math.max(1, Math.ceil(span / Q10_ONE));

  let lastX = fromX;
  let lastY = fromY;
  for (let s = 1; s <= samples; s += 1) {
    const x = (fromX + Math.trunc((deltaX * s) / samples)) | 0;
    const y = (fromY + Math.trunc((deltaY * s) / samples)) | 0;
    if (!centreIsFree(map, passable, x, y)) {
      return { x: lastX, y: lastY, clamped: true };
    }
    lastX = x;
    lastY = y;
  }
  return { x: lastX, y: lastY, clamped: false };
}

/** Where a contact-aware sweep had to stop, and what stopped it. */
interface SweepStop {
  readonly x: Q10;
  readonly y: Q10;
  /**
   * Fraction of the requested path actually covered, Q10, so the caller can
   * spend the rest of the tick on whatever velocity the bounce leaves. It is the
   * exact sample ratio `stopped / samples`, not a re-measured distance.
   */
  readonly covered: number;
  /**
   * The probe at the first sample the ball may not occupy — the surface it is
   * about to hit, and the only place a normal can honestly come from, since by
   * construction the ring sees nothing at the position the ball stopped in.
   * Null when nothing was hit, whether the path completed or the centre sweep
   * refused it.
   */
  readonly blocker: RingProbe | null;
  /** True when solid material stopped the sweep short of its target. */
  readonly clamped: boolean;
}

/**
 * Sweeps the ball centre along a straight path and stops it where it first runs
 * into something, at one-pixel resolution.
 *
 * This is where the tick is cut up, and it is cut at a resolution that is a
 * property of the PATH rather than of any tunable. A previous version advanced
 * the ball in `ceil(speed / maxSubstepDistance)` equal substeps and probed only
 * at the end of each, which made the bounce position depend on the substep
 * count: the substep that found contact was re-run from its own start, so the
 * approach it had already covered was thrown away, and the discarded distance
 * was one substep's worth. Starting at y = 388 px with vy = 8191 against a floor
 * at y = 400, one substep ended 6.5 px from where two did — a visible kink in the
 * trajectory at every velocity that happened to be a multiple of the substep
 * distance. Sampling every pixel of the actual path removes the tunable from the
 * answer entirely, and is strictly finer than any substep the old cap allowed.
 *
 * A contact only stops the sweep when the ball is APPROACHING it. A ball
 * rolling along a floor touches that floor at every sample without ever hitting
 * it, and stopping there would freeze it against a surface it is sliding on.
 * Every touched pixel is logged either way: the tick's contact report is "every
 * solid pixel the ring touched", which the scoring layer needs, and that is not
 * the same question as "what turned the ball around".
 */
function sweepToContact(
  map: TableMap,
  materials: MaterialTable,
  passable: readonly boolean[],
  ring: RingOffsets,
  log: ContactLog,
  ball: BallState,
  toX: Q10,
  toY: Q10,
): SweepStop {
  const deltaX = toX - ball.x;
  const deltaY = toY - ball.y;
  // The path is parameterised by its longest component, so one unit of `t` moves
  // the ball by at most one Q10 unit and the parameter is a property of the ray.
  const span = Math.max(Math.abs(deltaX), Math.abs(deltaY));
  if (span === 0) {
    return { x: ball.x, y: ball.y, covered: Q10_ONE, blocker: null, clamped: false };
  }

  const pointAt = (t: number): { readonly x: Q10; readonly y: Q10 } => ({
    x: (ball.x + Math.trunc((deltaX * t) / span)) | 0,
    y: (ball.y + Math.trunc((deltaY * t) / span)) | 0,
  });

  /**
   * What stops the ball at `t`, or null when the ball may stand there. A probe
   * of null means the centre sweep refused the point and there is no surface to
   * bounce off — the anti-tunnelling backstop, which only fires for geometry the
   * ring is blind to, since the ring sees a wall a full radius earlier.
   */
  const stopperAt = (t: number, record: boolean): { readonly probe: RingProbe | null } | null => {
    const point = pointAt(t);
    if (!centreIsFree(map, passable, point.x, point.y)) return { probe: null };

    const probe = probeRing(map, materials, passable, ring, point.x, point.y);
    if (probe.contactIndex < 0) return null;
    if (record) logContacts(log, probe, ring, materials);

    // The un-snapped normal, which is also what the bounce is taken about; see
    // `outwardNormalOf`. Using the ring entry here and the exact vector there
    // would let a sweep stop against a surface it then reads as leaving.
    const into =
      q10Multiply(ball.velocityX, probe.normalX) + q10Multiply(ball.velocityY, probe.normalY);
    return into < 0 ? { probe } : null;
  };

  let low = 0;
  let high = span;
  let stopper: { readonly probe: RingProbe | null } | null = null;
  for (let t = Math.min(Q10_ONE, span); ; t = Math.min(t + Q10_ONE, span)) {
    const found = stopperAt(t, true);
    if (found !== null) {
      stopper = found;
      high = t;
      break;
    }
    low = t;
    if (t === span) break;
  }

  // Back the ball up to within one Q10 unit of where it actually met the
  // surface. Leaving it at the last whole-pixel sample made the bounce position
  // jump by up to a pixel whenever the velocity crossed a sample-count boundary
  // — the same class of artefact as the substep dependence, one order smaller.
  while (stopper !== null && high - low > 1) {
    const middle = low + Math.trunc((high - low) / 2);
    const found = stopperAt(middle, false);
    if (found === null) {
      low = middle;
    } else {
      stopper = found;
      high = middle;
    }
  }

  const stopped = pointAt(low);
  return {
    x: stopped.x,
    y: stopped.y,
    covered: Math.trunc((low * Q10_ONE) / span),
    blocker: stopper === null ? null : stopper.probe,
    clamped: stopper !== null,
  };
}

/**
 * Removes the part of the velocity pointing along a direction the ball was
 * refused, leaving the part that slides across it.
 *
 * The guarantee this exists for: a substep that moved the ball nowhere must
 * still change something, or the tick is a no-op and every later tick repeats
 * it exactly. Returns true when the velocity actually changed.
 */
function cancelMotionAlong(ball: BallState, deltaX: number, deltaY: number): boolean {
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) return false;

  const dot = ball.velocityX * deltaX + ball.velocityY * deltaY;
  if (dot <= 0) return false;

  const scale = Math.trunc((dot * Q10_ONE) / lengthSquared);
  const nextX = clampVelocity(ball.velocityX - q10Multiply(scale, deltaX));
  const nextY = clampVelocity(ball.velocityY - q10Multiply(scale, deltaY));
  if (nextX === ball.velocityX && nextY === ball.velocityY) return false;

  ball.velocityX = nextX;
  ball.velocityY = nextY;
  return true;
}

// ---------------------------------------------------------------------------
// Per-tick contact accumulation
// ---------------------------------------------------------------------------

/**
 * Every contact a ball made during one tick.
 *
 * Keeping only the last substep's contacts silently dropped the rest, so a fast
 * ball that clipped a bumper early in a tick and a wall late in it reported the
 * wall alone and the bumper never scored. Repeats of the same pixel are folded
 * together — the ball touched that pixel once, however many substeps saw it.
 */
interface ContactLog {
  readonly points: ContactPoint[];
  readonly seen: Set<number>;
  sumX: number;
  sumY: number;
  dominant: MaterialIndex | null;
  dominantBehaviour: MaterialBehaviour | null;
  /** Surface ids touched this tick, first-touch order, deduped. Empty with no map. */
  readonly surfaceIds: number[];
  readonly surfacesSeen: Set<number>;
  /** Reads the id under a contact pixel on the level this ball is riding. */
  readonly surfaceAt: ((x: number, y: number) => number) | null;
}

function newContactLog(surfaceAt: ((x: number, y: number) => number) | null): ContactLog {
  return {
    points: [],
    seen: new Set<number>(),
    sumX: 0,
    sumY: 0,
    dominant: null,
    dominantBehaviour: null,
    surfaceIds: [],
    surfacesSeen: new Set<number>(),
    surfaceAt,
  };
}

/** Injective for any pixel a probe can reach; plain `y * width + x` is not, for negative x. */
function pixelKey(x: number, y: number): number {
  return (y + 0x8000) * 0x10000 + (x + 0x8000);
}

function logContacts(
  log: ContactLog,
  probe: RingProbe,
  ring: RingOffsets,
  materials: MaterialTable,
): void {
  for (const point of probe.contacts) {
    const key = pixelKey(point.x, point.y);
    if (log.seen.has(key)) continue;
    log.seen.add(key);
    log.points.push(point);
    log.sumX += numberAt(ring.unitX, point.ringIndex);
    log.sumY += numberAt(ring.unitY, point.ringIndex);

    const behaviour = materials.behaviourFor(point.material);
    if (log.dominantBehaviour === null || moreDeflecting(behaviour, log.dominantBehaviour)) {
      log.dominantBehaviour = behaviour;
      log.dominant = point.material;
    }

    // Id 0 is "no surface" and is not reported: it is what the map answers for
    // every pixel nothing was ever assigned to, and a scoring layer that saw it
    // would be told the ball touched something on every tick of every game.
    if (log.surfaceAt !== null) {
      const id = log.surfaceAt(point.x, point.y);
      if (id !== SURFACE_ID_NONE && !log.surfacesSeen.has(id)) {
        log.surfacesSeen.add(id);
        log.surfaceIds.push(id);
      }
    }
  }
}

/**
 * The surface response the bounce is taken with, picked from the pixels the
 * blocking probe actually touched.
 *
 * The original reads ONE id, at its single contact point. This port resolves a
 * whole ring of them, so it needs a rule for which one speaks for the contact,
 * and the rule is `moreDeflecting` restated for surfaces: a powered face
 * outranks an unpowered one, and between two of the same sort the bouncier wins.
 * That is the same tie-break the material path has used since the probe was
 * written, and it errs the only safe way — a ball that grazes a bumper's rim and
 * a wall in the same contact gets the bumper, which is what the player sees.
 */
function surfaceResponseOf(
  probe: RingProbe,
  surfaceAt: ((x: number, y: number) => number) | null,
  powered: boolean,
): SurfaceResponse | null {
  if (surfaceAt === null) return null;
  let best: SurfaceResponse | null = null;
  for (const point of probe.contacts) {
    const id = surfaceAt(point.x, point.y);
    if (id === SURFACE_ID_NONE) continue;
    const response = surfaceResponseFor(id, powered);
    if (best === null) {
      best = response;
      continue;
    }
    if (response.kick > best.kick) best = response;
    else if (response.kick === best.kick && response.elasticity > best.elasticity) best = response;
  }
  return best;
}

/** What one ball's integration reported: its contacts, and the ids under them. */
interface IntegrationResult {
  readonly contact: ContactResult | null;
  readonly surfaceIds: readonly number[];
}

function closeContactLog(log: ContactLog, ring: RingOffsets): ContactResult | null {
  if (log.points.length === 0) return null;
  const index = meanContactIndex(ring, log.points, log.sumX, log.sumY);
  return { contacts: log.points, normalAngle: numberAt(ring.angle, index), dominant: log.dominant };
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/**
 * Advances every active ball one tick.
 *
 * Order matters: forces first, then per-ball integration with contact
 * resolution, then ball-to-ball, then the drain test. Ball-to-ball runs after
 * integration so two balls that both moved this tick are separated from their
 * final positions rather than from a half-updated mixture of old and new.
 */
export function stepBalls(
  balls: BallSet,
  map: TableMap,
  materials: MaterialTable,
  forces: SimulationForces,
  options?: Partial<SimulationOptions>,
): StepResult {
  const resolved = resolveOptions(map, options);
  const passable = passabilityOf(materials);
  const ring = ringOffsetsFor(resolved.radius);
  // Everything below collides against a VIEW, never the raw map: the level-0
  // view carries the virtual top wall and the level-1 view swaps the collision
  // line for the ramp one. There is no path through the integrator that reads
  // the bitmap directly, so neither correction can be missed.
  const views = levelViewsFor(map, resolved.topWallRows);
  const gates = levelGatesFor(map.tableId);

  const contacts = new Map<number, ContactResult>();
  const surfaces = new Map<number, readonly number[]>();
  const drained: number[] = [];

  for (const ball of balls.balls) {
    // A ball in a lock is out of the simulation entirely — no gravity, no drive,
    // no contact — exactly as the original's integrator skips any ball whose
    // flag byte has bit 7 set (`tst.b $1(a4)` / `bmi` at data 0xA684, 0xA6CE,
    // 0xA718). Not merely frozen in place: nothing is read from it either, so a
    // saucer that happens to sit over a wall cannot push it anywhere.
    if (!ballIsInPlay(ball)) continue;

    // A shove moves the cabinet, and the cabinet does not reach into a habitrail:
    // see `nudgeReachesLevel` for the arch measurements that forced this. Gravity
    // still applies on every level — a ball rolls down a ramp.
    const shoved = nudgeReachesLevel(ball.level);

    // The RAMP DRIVE, read at the position the ball starts the tick in and added
    // beside gravity — the same two additions the original makes, in the same
    // order, at main.seg00 +0x00B754/+0x00B758. It applies on both levels and
    // whether or not the ball is in contact with anything: the original does not
    // test either, and a ball flying through a habitrail's mouth really is being
    // pushed along it. `table-accel.ts` has the derivation of the Q10 scale and
    // the measurements of the shallow-slope equilibria this exists to clear.
    //
    // No `nudgeReachesLevel` equivalent guards it, and there is nothing to guard
    // against: it is a property of the place, not an impulse from the cabinet.
    const drive =
      resolved.rampDrive === null
        ? null
        : resolved.rampDrive.driveAt(ball.level, q10ToPixel(ball.x), q10ToPixel(ball.y));

    ball.velocityX = clampVelocity(
      ball.velocityX +
        (forces.tiltX ?? 0) +
        (shoved ? forces.nudgeX : 0) +
        (drive === null ? 0 : drive.x),
    );
    ball.velocityY = clampVelocity(
      ball.velocityY +
        forces.gravityY +
        (shoved ? forces.nudgeY : 0) +
        (drive === null ? 0 : drive.y),
    );

    // Captured before the move, because a level change is a CROSSING: the ball
    // has to have been on the other side of the hand-off line at the start of
    // the tick for it to count.
    const fromX = q10ToPixel(ball.x);
    const fromY = q10ToPixel(ball.y);
    const integrated = integrateBall(
      ball,
      viewForLevel(views, ball.level),
      materials,
      passable,
      ring,
      resolved,
    );
    if (integrated.contact !== null) {
      contacts.set(ball.id, integrated.contact);
    }
    if (integrated.surfaceIds.length > 0) {
      surfaces.set(ball.id, integrated.surfaceIds);
    }
    // Three level-change mechanisms, in the order the engine runs them: this
    // project's reconstructed geometric gates, then the SURFACE IDS the
    // collision pass dispatches at +0x00AD42, then the ZONE rectangles the ball
    // loop walks afterwards at +0x0052E6. The two measured ones run last so they
    // have the last word over the reconstruction.
    applyLevelGates(ball, gates, fromX, fromY);
    applyLevelSurfaces(ball, integrated.surfaceIds);
    applyLevelZones(ball, resolved.surfaces);
  }

  if (resolved.ballToBall) {
    resolveBallCollisions(
      balls.balls,
      resolved.radius,
      pushClampFor(views, materials, passable, ring),
    );
  }

  // Drained last, so a ball knocked back above the drain line by another ball
  // on the very tick it fell out is correctly still in play. A held ball is
  // exempt: the drain is a place on the table and a ball in a saucer is not on
  // the table, so a lock below the drain line would otherwise eat it.
  for (const ball of balls.balls) {
    if (!ballIsInPlay(ball)) continue;
    if (ball.y >= resolved.drainY) {
      ball.active = false;
      drained.push(ball.id);
    }
  }

  return { drained, contacts, surfaces };
}

/**
 * Moves a ball onto the other collision line if this tick took it through a
 * hand-off.
 *
 * Applied AFTER the integration rather than before it, so the tick the ball
 * crosses on is resolved entirely against the level it started on and the new
 * level takes effect from the next tick. The hand-off rows exist precisely
 * because the two lines are identical there, so which side of the crossing the
 * switch lands on cannot change the trajectory — but doing it after keeps the
 * tick's contact report and its reflection consistent with one another.
 */
function applyLevelGates(
  ball: BallState,
  gates: readonly LevelGate[],
  fromX: number,
  fromY: number,
): void {
  if (gates.length === 0) return;
  ball.level = levelAfterCrossing(
    gates,
    ball.level,
    fromX,
    fromY,
    q10ToPixel(ball.x),
    q10ToPixel(ball.y),
  );
}

/**
 * Moves a ball onto the other collision line because it TOUCHED a surface whose
 * whole job is to move it, and stops it dead in the process.
 *
 * Surface ids 10 and 11 are two of the thirty-two entries in the engine's jump
 * table at +0x00AE40 — 10 to +0x00B420, 11 to +0x00B408 — and both handlers do
 * the same two things: swap the ball's plane pointers for the other level's, and
 * ZERO the velocity. They are drawn as short solid bars, and on Law 'n Justice
 * the clearest is a 25-pixel run of id 11 at x 23..47, y 465..467, lying flat
 * across the foot of the left habitrail's channel. That is the habitrail
 * DELIVERY: the ball rides the upper line down the rail, lands on the bar, stops,
 * and is handed to the lower line in the left inlane.
 *
 * Without it a ball that reached the foot of that channel had nowhere to go —
 * the upper line simply stops at y=468 — and the aggressive census wrote off
 * fifty-seven balls at (36,456) and (37,456), which is a ball centre resting one
 * radius above that bar. Zeroing the velocity is the handler's own behaviour and
 * is what a drop off the end of a wireform looks like.
 *
 * Id 10 (to the upper level) appears on ZERO pixels of any of the six shipped
 * surface maps, so only the downward half is ever reached; it is implemented
 * anyway because the handler exists and because a map that used it would
 * otherwise fail silently. Ids are visited in first-touch order and the last one
 * wins, matching a dispatch that runs once per contact.
 */
function applyLevelSurfaces(ball: BallState, surfaceIds: readonly number[]): void {
  let next: PlayfieldLevel | null = null;
  for (const id of surfaceIds) {
    if (id === LEVEL_TO_UPPER_ID) next = 1;
    else if (id === LEVEL_TO_LOWER_ID) next = 0;
  }
  if (next === null) return;
  ball.velocityX = 0;
  ball.velocityY = 0;
  ball.level = next;
}

/**
 * Moves a ball onto the other collision line if it finished the tick inside one
 * of the ENGINE'S OWN hand-off rectangles.
 *
 * This is types 2 and 3 of the zone dispatch at +0x0053A8, and it is applied
 * after `applyLevelGates` so that where the shipped data and this project's
 * reconstructed gates disagree, the shipped data has the last word.
 *
 * A rectangle rather than a row is the whole point. The gates in
 * `playfield-levels.ts` are three or four columns wide on a single row, because
 * that is what could be inferred from where two collision lines happen to carry
 * identical runs; the original's hand-offs are twenty-pixel boxes. A ball that
 * crossed Law 'n Justice's `ramp-end` gate row at x=37 when the gate is x 34..36
 * missed it by one pixel, stayed on the habitrail, drifted down the upper line
 * and was eventually tipped onto the lower one by the `left-apron` gate at the
 * top of a strip that is SEALED on the lower collision line. That is one pixel
 * of miss turning into a lost ball, and the box catches it.
 *
 * Idempotent: a ball already on the level the zone names is left alone, so a
 * ball sitting in a hand-off box costs nothing per tick.
 */
function applyLevelZones(ball: BallState, surfaces: SurfaceIdMap | null): void {
  if (surfaces === null) return;
  const next = surfaces.levelChangeAt(ball.level, q10ToPixel(ball.x), q10ToPixel(ball.y));
  if (next !== null && next !== ball.level) ball.level = next;
}

/**
 * Pushes a ball whose centre is inside solid material back out into free space.
 *
 * The integrator itself cannot produce this state — the centre sweep clamps
 * every move to free space — but a spawn point, a hand-placed ball or a future
 * device kick can, and from inside the material no reflection is meaningful
 * because the mean contact direction points back the way the ball came.
 *
 * The outward normal is tried first, a pixel at a time so the ball lands at the
 * first free position rather than being flung a radius away. It is only a
 * preference, though: the ring is hollow, so a solid pocket narrower than the
 * ball is invisible to it and reports no contacts at all — Law 'n Justice has
 * one at (318, 400), and a ball placed there had no direction to be pushed in
 * and stayed lost for the rest of the game. The fallback is an expanding
 * discrete circle, which finds the nearest free centre whether or not the ring
 * saw anything.
 *
 * Both stop at the reach below, past which there is nothing sensible left to try
 * and the ball is left where it is. One ball diameter covers everything the
 * geometry can produce — but not a ball placed inside the VIRTUAL TOP WALL,
 * which is 26 rows deep on Law 'n Justice, so the reach has to clear that too.
 * A ball that cannot be freed is not merely stuck: it repeats the whole search
 * on every tick for the rest of the game.
 */
function recoverPenetration(
  ball: BallState,
  map: TableMap,
  materials: MaterialTable,
  passable: readonly boolean[],
  ring: RingOffsets,
  options: ResolvedOptions,
  log: ContactLog,
): void {
  if (centreIsFree(map, passable, ball.x, ball.y)) return;

  const radiusPixels = Math.max(1, Math.round(options.radius / Q10_ONE));
  const maximum = Math.max(
    2 * radiusPixels,
    options.topWallRows + radiusPixels,
  );

  const probe = probeRing(map, materials, passable, ring, ball.x, ball.y);
  if (probe.contactIndex >= 0) {
    logContacts(log, probe, ring, materials);
    const normalX = probe.normalX;
    const normalY = probe.normalY;
    for (let step = 1; step <= maximum; step += 1) {
      const distance = pixelsToQ10(step);
      const x = (ball.x + q10Multiply(distance, normalX)) | 0;
      const y = (ball.y + q10Multiply(distance, normalY)) | 0;
      if (centreIsFree(map, passable, x, y)) {
        ball.x = x;
        ball.y = y;
        return;
      }
    }
  }

  // Nearest free centre, searched in rings of growing radius and, within a
  // ring, in the ring's own angular order — so the choice is the same on every
  // machine and on every run.
  for (let step = 1; step <= maximum; step += 1) {
    const shell = ringOffsetsFor(pixelsToQ10(step));
    for (let i = 0; i < shell.size; i += 1) {
      const x = (ball.x + pixelsToQ10(numberAt(shell.dx, i))) | 0;
      const y = (ball.y + pixelsToQ10(numberAt(shell.dy, i))) | 0;
      if (centreIsFree(map, passable, x, y)) {
        ball.x = x;
        ball.y = y;
        return;
      }
    }
  }
}

/**
 * How many times one ball may be turned around inside a single tick.
 *
 * A tick is 20 ms; a ball that reverses more than a handful of times in one is
 * wedged in geometry, not playing pinball. The cap exists to bound the work and
 * to guarantee the loop terminates whatever the map does — it is not a physical
 * quantity, and nothing about a normal trajectory comes near it.
 */
const MAX_CONTACTS_PER_TICK = 8;

/**
 * Integrates one ball as a swept path with bounce events.
 *
 * The tick is spent as a FRACTION, not as a fixed number of equal substeps.
 * `remaining` is how much of the tick is still unspent, in Q10; each pass sweeps
 * the ball along `velocity * remaining`, and a contact consumes only the part of
 * that path the ball actually covered before hitting, leaving the rest to be
 * spent on the reflected velocity. That is what makes the bounce POSITION
 * independent of how finely the tick is cut: the approach displacement is kept
 * rather than discarded, and no per-substep rounding ever enters the answer.
 *
 * Contact is evaluated only at positions the ball can actually reach, never at a
 * candidate that may lie inside the wall: from inside, the mean contact
 * direction inverts, the reflection reads as "already leaving", and the move is
 * then refused — leaving position AND velocity untouched, so every later tick is
 * bit-identical and the ball is stuck forever with speed. When geometry still
 * refuses a move, the velocity component along the refused direction is killed,
 * so some state changes on every tick and no configuration can repeat.
 */
function integrateBall(
  ball: BallState,
  map: TableMap,
  materials: MaterialTable,
  passable: readonly boolean[],
  ring: RingOffsets,
  options: ResolvedOptions,
): IntegrationResult {
  // Bound to the level the ball is riding at the start of the tick, matching the
  // per-level view it is about to be collided against. A ball changes level only
  // after the integration, so one tick never mixes the two maps.
  const surfaces = options.surfaces;
  const level = ball.level;
  const surfaceAt =
    surfaces === null ? null : (x: number, y: number): number => surfaces.surfaceIdAt(level, x, y);
  const log = newContactLog(surfaceAt);
  recoverPenetration(ball, map, materials, passable, ring, options, log);

  const startX = ball.x;
  const startY = ball.y;
  let remaining = Q10_ONE;
  let advanced = false;
  for (let pass = 0; pass < MAX_CONTACTS_PER_TICK && remaining > 0; pass += 1) {
    const stepX = q10Multiply(ball.velocityX, remaining);
    const stepY = q10Multiply(ball.velocityY, remaining);
    if (stepX === 0 && stepY === 0) break;

    const stop = sweepToContact(
      map,
      materials,
      passable,
      ring,
      log,
      ball,
      q10IntegrateSigned16Velocity(ball.x, stepX),
      q10IntegrateSigned16Velocity(ball.y, stepY),
    );

    const moved = stop.x !== ball.x || stop.y !== ball.y;
    advanced = advanced || moved;
    ball.x = stop.x;
    ball.y = stop.y;
    // Whatever share of the path the approach used up is gone; the bounce below
    // gets only what is left.
    remaining = q10Multiply(remaining, Q10_ONE - stop.covered);

    // Past the bottom row there is no more table to collide with.
    if (ball.y >= options.drainY) break;

    const velocityX = ball.velocityX;
    const velocityY = ball.velocityY;
    if (stop.blocker !== null && stop.blocker.dominant !== null) {
      reflectVelocity(
        ball,
        materials.behaviourFor(stop.blocker.dominant),
        stop.blocker.normalX,
        stop.blocker.normalY,
        options.restThreshold,
        surfaceResponseOf(stop.blocker, surfaceAt, options.poweredKicksLive),
      );
    } else if (!stop.clamped) {
      // The path ran out with nothing in the way; `remaining` is zero and the
      // loop is about to end anyway.
      break;
    }

    if (!moved && ball.velocityX === velocityX && ball.velocityY === velocityY) {
      // Geometry refused the move and the reflection did not turn the ball
      // around. Take the refused direction out of the velocity so the next
      // attempt differs; if even that changes nothing, stop the ball dead. A
      // tick must never leave both position and velocity exactly as it found
      // them, or the simulation has reached a fixed point it cannot leave.
      if (!cancelMotionAlong(ball, stepX, stepY)) {
        ball.velocityX = 0;
        ball.velocityY = 0;
        break;
      }
    }
  }

  // The tick as a whole gets the same rule the individual passes do, because a
  // tick can go nowhere without any single pass going nowhere. Law 'n Justice
  // has channels narrower than the ball, and one at (86, 156) held a ball that
  // drifted one Q10 unit down, bounced, drifted back up and ended every tick on
  // the pixel it started on with the velocity it started with — position and
  // velocity both unchanged with speed still on the books, which is precisely the
  // fixed point no tick may leave behind.
  //
  // Nothing moved at all means the geometry refuses every direction; the ball is
  // wedged and the velocity is fiction whatever its size. Moved but came back
  // means the ball is rattling in place, and what is left of the velocity is at
  // rest by the same threshold that stops a ball chattering on a slope.
  if (ball.x === startX && ball.y === startY) {
    const speed = Math.max(Math.abs(ball.velocityX), Math.abs(ball.velocityY));
    if (!advanced || speed <= options.restThreshold) {
      ball.velocityX = 0;
      ball.velocityY = 0;
    }
  }

  return { contact: closeContactLog(log, ring), surfaceIds: log.surfaceIds };
}

// ---------------------------------------------------------------------------
// Ball to ball
// ---------------------------------------------------------------------------

/**
 * Clamps a ball-to-ball separation push against the map.
 *
 * Returns the position the ball may actually be moved to: the requested one when
 * nothing is in the way, something short of it otherwise.
 */
export type PushClamp = (ball: BallState, deltaX: Q10, deltaY: Q10) => { x: Q10; y: Q10 };

/**
 * The push rule for one map.
 *
 * Testing the centre pixel alone — which is all the previous version did — lets
 * a separation push bury a ball a full radius inside a wall before anything
 * objects, because the centre is a radius clear of the surface the ball is
 * resting on. Two balls stacked on a floor then drove the lower one 8 px into
 * it, 12 Q10 per tick, for as long as the stack lasted. So the ring is consulted
 * too: the component of the push that points at whatever the ball is already
 * touching is removed, which leaves the component that slides along the surface.
 * The centre sweep then still applies, so the remainder cannot cross solid
 * material either.
 */
function pushClampFor(
  views: LevelViews,
  materials: MaterialTable,
  passable: readonly boolean[],
  ring: RingOffsets,
): PushClamp {
  return (ball: BallState, deltaX: Q10, deltaY: Q10): { x: Q10; y: Q10 } => {
    let dx = deltaX;
    let dy = deltaY;
    // Each ball is clamped against its OWN level: a ball on a ramp is nowhere
    // near the walls the playfield ball is bounded by, and using one view for
    // both would shove one of them through geometry it cannot see.
    const map = viewForLevel(views, ball.level);

    const probe = probeRing(map, materials, passable, ring, ball.x, ball.y);
    if (probe.contactIndex >= 0) {
      const towardX = -probe.normalX;
      const towardY = -probe.normalY;
      const into = q10Multiply(dx, towardX) + q10Multiply(dy, towardY);
      if (into > 0) {
        dx -= q10Multiply(into, towardX);
        dy -= q10Multiply(into, towardY);
      }
    }

    const reach = sweepLimit(map, passable, ball.x, ball.y, (ball.x + dx) | 0, (ball.y + dy) | 0);
    return { x: reach.x, y: reach.y };
  };
}

/**
 * Moves a ball by a separation offset, as far as the map allows.
 *
 * The push exists to unstick overlapping balls, and an unstick that shoves a
 * ball through a wall or off the edge of the bitmap is worse than the overlap it
 * cures: outside the bitmap every probe reads solid, so the ball can never move
 * again and is silently lost for the rest of the game.
 */
function displace(ball: BallState, deltaX: Q10, deltaY: Q10, clamp: PushClamp | null): void {
  if (deltaX === 0 && deltaY === 0) return;
  if (clamp === null) {
    ball.x = (ball.x + deltaX) | 0;
    ball.y = (ball.y + deltaY) | 0;
    return;
  }
  const placed = clamp(ball, deltaX, deltaY);
  ball.x = placed.x;
  ball.y = placed.y;
}

/**
 * Equal-mass elastic collisions between every pair of live balls.
 *
 * Only the component along the line of centres is exchanged, which for equal
 * masses is the whole of an elastic collision — the tangential components are
 * untouched. Overlap is also split evenly so a stack of balls in the plunger
 * lane pushes apart instead of fusing. O(n^2), and n is at most six.
 *
 * `clamp` is optional only so the momentum exchange can be unit-tested without a
 * map; `stepBalls` always supplies it, and any caller simulating on real geometry
 * must, or balls stacked against a wall will be pushed into it.
 */
export function resolveBallCollisions(
  balls: readonly BallState[],
  radius: Q10,
  clamp: PushClamp | null = null,
): void {
  const diameter = radius * 2;
  const diameterSquared = diameter * diameter;

  for (let i = 0; i < balls.length; i += 1) {
    const a = balls[i];
    // Held balls are out of the simulation, so they neither push nor are pushed:
    // a ball rolling over a saucer that already has one in it must not be
    // deflected by a ball that is, physically, below the playfield surface.
    if (a === undefined || !ballIsInPlay(a)) continue;

    for (let j = i + 1; j < balls.length; j += 1) {
      const b = balls[j];
      if (b === undefined || !ballIsInPlay(b)) continue;
      // Different levels are different heights: a ball on the top arch passes
      // over one on the playfield, and overlapping their 2D circles is an
      // artefact of the projection rather than a collision.
      if (a.level !== b.level) continue;

      const deltaX = b.x - a.x;
      const deltaY = b.y - a.y;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;
      if (distanceSquared >= diameterSquared) continue;

      // Exactly coincident balls have no line of centres; pick +x so two balls
      // spawned on the same pixel still separate, and separate deterministically.
      const coincident = distanceSquared === 0;
      const distance = coincident ? 0 : integerSqrt(distanceSquared);
      const normalX = coincident ? Q10_ONE : Math.round((deltaX * Q10_ONE) / distance);
      const normalY = coincident ? 0 : Math.round((deltaY * Q10_ONE) / distance);

      const overlap = diameter - distance;
      if (overlap > 0) {
        // At least one unit each. `overlap / 2` truncated to zero left a 1-unit
        // overlap unresolvable, so "overlapping" became a permanent state that
        // re-entered this branch on every tick for the rest of the game.
        const push = Math.max(1, Math.trunc(overlap / 2));
        const pushX = q10Multiply(push, normalX);
        const pushY = q10Multiply(push, normalY);
        displace(a, -pushX, -pushY, clamp);
        displace(b, pushX, pushY, clamp);
      }

      const relativeX = b.velocityX - a.velocityX;
      const relativeY = b.velocityY - a.velocityY;
      const approach = q10Multiply(relativeX, normalX) + q10Multiply(relativeY, normalY);
      if (approach >= 0) continue;

      const exchangeX = q10Multiply(approach, normalX);
      const exchangeY = q10Multiply(approach, normalY);
      a.velocityX = clampVelocity(a.velocityX + exchangeX);
      a.velocityY = clampVelocity(a.velocityY + exchangeY);
      b.velocityX = clampVelocity(b.velocityX - exchangeX);
      b.velocityY = clampVelocity(b.velocityY - exchangeY);
    }
  }
}
