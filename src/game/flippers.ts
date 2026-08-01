/**
 * The flippers: the only way the player touches the ball.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE NUMBERS COME FROM
 * ---------------------------------------------------------------------------
 * The bat itself is MEASURED, from `pkg/flipdat1.bin` — a 136,288 byte raw file
 * shared by all three tables, with no container and no compression. Decoded
 * independently for this module:
 *
 *   * Row stride 16 bytes, split as TWO 8-byte bitplanes over a 64 px wide
 *     frame. Columns 55..63 are empty in BOTH halves, which is what identifies
 *     the split as planes rather than one 128 px row.
 *   * 218 non-blank row runs separated by exactly 4 blank rows, in pairs: a
 *     shaded artwork blob (both planes, with a 2 px outline) followed by a solid
 *     single-plane silhouette. So 109 frames, not 109 masks of a 2 px line — an
 *     earlier report that the data is "2 px thick" was reading the outline.
 *   * The 109 frames are ONE rotation sweep of ONE bat. Fitting the centroid
 *     bearing against the frame index gives 3.0001 deg/frame over the first 85
 *     frames and 3.0294 over the last 24: the step is 3 degrees exactly, i.e.
 *     120 frames to the full turn, of which 109 are stored. The stored arc runs
 *     -72 deg .. +252 deg; the 11 frames from 255 to 285 (tip pointing up and to
 *     the left) are the ones no flipper on any table ever needs.
 *   * Silhouette geometry, from the solid frames: the pivot is the centre of the
 *     largest inscribed disc, radius 5 px; the tip is 45 px from it (exactly 45
 *     on the 0 deg and 90 deg frames, 43.4 median across the sweep once
 *     rasterisation noise is included); half-thickness at the boss is 5 px,
 *     tapering linearly to about 1 px at the tip, with the taper starting 6 px
 *     out. A 45 px bat next to a 16 px ball is 2.8 ball diameters, which is a
 *     real machine's proportion to two significant figures.
 *
 * Everything about WHERE the bats sit is INFERRED and marked as such, because
 * the flippers are not in the playfield map and the placement tables are inside
 * `main.bin`, which is a packed TSL container (entropy 7.73) this project has
 * not unpacked. Searching the unpacked table segments for the frame row offsets,
 * frame heights and per-frame pivot offsets found nothing, so there is no
 * measured placement to be had yet. See FLIPPER_PLACEMENT_NOTE.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STROKE IS A SCALAR AND NOT AN ANGLE
 * ---------------------------------------------------------------------------
 * State is a `stroke` in 0..sweep, and the angle is derived. Storing the angle
 * directly means every comparison ("is it fully up?", "has it come home?") has
 * to cope with the 2048-unit wrap, because the left flipper's active angle is
 * negative and normalises to 1928. A scalar cannot wrap, cannot leave its range,
 * and makes the left and right flippers literally the same arithmetic with the
 * `direction` sign flipped — which is what makes them exact mirrors of each
 * other rather than approximate ones.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BAT MUST BE MOVING
 * ---------------------------------------------------------------------------
 * A flipper that merely reflected would make every shot the same shot. The
 * response is computed in the BAT'S frame: the bat's surface velocity at the
 * contact point is subtracted from the ball's velocity, the normal impulse is
 * applied to what is left, and the surface velocity is added back. A ball
 * resting on a still bat therefore gets `elasticity` and settles; the same ball
 * caught by a bat sweeping under it leaves at roughly (1 + elasticity) times the
 * bat's surface speed there. That is also why `elasticity` is deliberately low
 * (400, against 845 for rubber): a live flipper should be dead enough to trap a
 * ball on, and take its power from the swing instead.
 *
 * The lever arm is the real one — the vector from the pivot to the point on the
 * bat's SURFACE that the ball touches, not the axial distance — so a ball caught
 * near the tip leaves faster than one caught near the boss, which is the whole
 * skill of aiming with a flipper.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TICK IS SUBDIVIDED
 * ---------------------------------------------------------------------------
 * At the up-stroke rate the tip travels 9.4 px in one tick. The bat is barely
 * 2 px thick out there, so a ball 8 px in radius sitting near the tip is inside
 * a 9 px window that one tick's rotation can step straight over: test only the
 * end-of-tick pose and the flipper passes through the ball without touching it.
 * The arc is therefore sampled at `substepsFor` intermediate poses and the FIRST
 * one that touches is the one that resolves. The sample count is derived from
 * the configuration, not guessed, so a slower or shorter flipper automatically
 * uses fewer.
 *
 * ---------------------------------------------------------------------------
 * ON DETERMINISM
 * ---------------------------------------------------------------------------
 * No `Math.random`, no `Date`, no `Math.sin`/`Math.cos`/`Math.atan2` at runtime.
 * The sine table is built once from a Taylor polynomial evaluated with nothing
 * but IEEE `+ - * /`, every one of which is correctly rounded and therefore
 * bit-identical on every engine, and only a quarter turn is stored: the other
 * three quadrants are exact integer reflections of it. That is what makes
 * `cos(1024 - a) === -cos(a)` and `sin(1024 - a) === sin(a)` hold EXACTLY, and
 * hence what makes the right flipper the precise mirror of the left instead of
 * a copy that drifts a unit or two at some angles.
 */

import type { BallState, MaterialBehaviour, TableId } from "./contracts.js";
import type { PushClamp } from "./ball-physics.js";
import { DEFAULT_SIMULATION_OPTIONS, reflectVelocity } from "./ball-physics.js";
import {
  ANGLE_UNITS_PER_TURN,
  DEFAULT_PROBE_RADIUS,
  integerSqrt,
  normalizeAngle,
} from "./collision-probe.js";
import type { Q10 } from "../core/fixed-point.js";
import { Q10_ONE, pixelsToQ10, q10Clamp, q10Multiply } from "../core/fixed-point.js";

// ---------------------------------------------------------------------------
// Deterministic trigonometry
// ---------------------------------------------------------------------------

/** Angle units in a quarter turn: 512 on the 2048-unit scale. */
export const QUARTER_TURN_UNITS = ANGLE_UNITS_PER_TURN / 4;

const HALF_TURN_UNITS = ANGLE_UNITS_PER_TURN / 2;

/** `Math.round` breaks ties toward +Infinity; this one is sign-symmetric. */
function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * sin over the first quadrant, Q10, one entry per angle unit plus the endpoint.
 *
 * The 11th-order Taylor series is accurate to about 2e-9 over 0..pi/2, four
 * orders of magnitude finer than the Q10 quantum, so the table is the correctly
 * rounded one and would not change if the polynomial were improved. `i / 512`
 * is exact (512 is a power of two) and everything after it is a correctly
 * rounded IEEE operation, so the table is identical on every engine.
 */
function buildQuarterSineTable(): readonly number[] {
  const table: number[] = [];
  for (let i = 0; i <= QUARTER_TURN_UNITS; i += 1) {
    const x = (i / QUARTER_TURN_UNITS) * (Math.PI / 2);
    const xx = x * x;
    let p = -1 / 39916800;
    p = p * xx + 1 / 362880;
    p = p * xx - 1 / 5040;
    p = p * xx + 1 / 120;
    p = p * xx - 1 / 6;
    p = p * xx + 1;
    table.push(roundHalfAwayFromZero(x * p * Q10_ONE));
  }
  return table;
}

const QUARTER_SINE = buildQuarterSineTable();

function quarterSineAt(index: number): number {
  const value = QUARTER_SINE[index];
  if (value === undefined) {
    throw new RangeError(`quarter-sine index out of range: ${index}`);
  }
  return value;
}

/**
 * sin of an angle in 2048-unit form, as Q10.
 *
 * Folded to the first quadrant and negated with integer arithmetic, so the four
 * quadrants are exact reflections. Zero is returned as +0: a negative zero here
 * would survive into a contact normal and fail identity comparisons.
 */
export function sineUnits(angle: number): Q10 {
  const wrapped = normalizeAngle(angle);
  const withinHalf = wrapped % HALF_TURN_UNITS;
  const folded = withinHalf <= QUARTER_TURN_UNITS ? withinHalf : HALF_TURN_UNITS - withinHalf;
  const magnitude = quarterSineAt(folded);
  if (magnitude === 0) return 0;
  return wrapped < HALF_TURN_UNITS ? magnitude : -magnitude;
}

/** cos of an angle in 2048-unit form, as Q10. */
export function cosineUnits(angle: number): Q10 {
  return sineUnits(angle + QUARTER_TURN_UNITS);
}

/**
 * Radians per angle unit, scaled by 2^20.
 *
 * Angular velocity arrives in angle units per tick and has to become a linear
 * velocity in Q10 per tick, which needs the conversion to radians. At Q10 the
 * factor would be 3, a 4% error; at 2^20 it is exact to nine digits and the
 * products still fit in a double's integer range with a factor of 10^5 to spare.
 */
const RADIANS_PER_UNIT_Q20 = Math.round((2 * Math.PI * (1 << 20)) / ANGLE_UNITS_PER_TURN);

const Q20_ONE = 1 << 20;

/**
 * Linear speed of a point `radius` from the pivot on a bat turning at
 * `angularUnits` per tick. Q10 in, Q10 out; sign follows `angularUnits`.
 */
export function tangentialSpeed(radius: Q10, angularUnits: number): number {
  // `| 0` collapses the negative zero the sign-symmetric rounding produces for
  // small negative products; a -0 leaking into a velocity fails identity checks.
  return roundHalfAwayFromZero((radius * angularUnits * RADIANS_PER_UNIT_Q20) / Q20_ONE) | 0;
}

// ---------------------------------------------------------------------------
// The bat, as measured from flipdat1.bin
// ---------------------------------------------------------------------------

/** Frames stored in `flipdat1.bin`: 109 poses of one bat. */
export const FLIPPER_FRAME_COUNT = 109;

/** Degrees between consecutive frames. Measured, and exactly 3. */
export const FLIPPER_FRAME_STEP_DEGREES = 3;

/** Poses in a full turn at that step. 2048 / 120 is not a whole angle unit. */
export const FLIPPER_FRAMES_PER_TURN = 360 / FLIPPER_FRAME_STEP_DEGREES;

/** Bearing of frame 0, in degrees, y downward. The stored arc is -72 .. +252. */
export const FLIPPER_FRAME_ARC_START_DEGREES = -72;
export const FLIPPER_FRAME_ARC_END_DEGREES = 252;

/**
 * Frame order in the file: frames 0..84 are bearings 0..252 and frames 85..108
 * are bearings -72..-3, appended after a 48 row gap — the only irregular gap in
 * the file, and the one thing that says these are two banks of one sweep rather
 * than one run.
 */
export const FLIPPER_FIRST_BANK_FRAMES = 85;

/** Pivot-to-tip length of the drawn bat, in pixels. Measured. */
export const FLIPPER_LENGTH_PIXELS = 45;

/** Half-thickness at the boss, in pixels: the largest inscribed disc. Measured. */
export const FLIPPER_BOSS_RADIUS_PIXELS = 5;

/** Half-thickness at the tip, in pixels. Measured. */
export const FLIPPER_TIP_RADIUS_PIXELS = 1;

/** Distance from the pivot at which the taper begins, in pixels. Measured. */
export const FLIPPER_TAPER_START_PIXELS = 6;

/**
 * The frame whose bearing is `angle`, or null when the sweep does not store one.
 *
 * Null is a real answer, not a failure: 11 of the 120 poses in a turn are simply
 * absent from the file, and a renderer asking for one of them is asking for a
 * pose no flipper on any table reaches. Callers should treat it as a bug in
 * their placement rather than substituting a neighbour.
 */
export function flipperFrameIndex(angle: number): number | null {
  const wrapped = normalizeAngle(angle);
  // Rounded to the nearest of the 120 slots without leaving the integers:
  // slot = round(wrapped * 120 / 2048) = round(wrapped * 15 / 256).
  const slot = Math.round((wrapped * FLIPPER_FRAMES_PER_TURN) / ANGLE_UNITS_PER_TURN)
    % FLIPPER_FRAMES_PER_TURN;
  if (slot < FLIPPER_FIRST_BANK_FRAMES) return slot;
  const negativeSlot = slot - FLIPPER_FRAMES_PER_TURN; // -35 .. -1
  const fromArcStart = negativeSlot - FLIPPER_FRAME_ARC_START_DEGREES / FLIPPER_FRAME_STEP_DEGREES;
  if (fromArcStart < 0) return null; // bearings 255..285: not drawn
  return FLIPPER_FIRST_BANK_FRAMES + fromArcStart;
}

// ---------------------------------------------------------------------------
// Timing and surface
// ---------------------------------------------------------------------------

/**
 * Sweep of the stroke, in angle units: 272 of 2048, or 47.8 degrees.
 *
 * A Williams-era flipper sweeps about 48 degrees, and 272 is the value in that
 * region that both `FLIPPER_UP_TICKS` and `FLIPPER_DOWN_TICKS` divide exactly,
 * so neither stroke has to round and neither accumulates a remainder.
 */
export const FLIPPER_SWEEP_UNITS = 272;

/**
 * Ticks from rest to fully flipped: 4, or 80 ms at the 50 Hz PAL step.
 *
 * A real flipper is quicker than that, but at 50 Hz a two-tick stroke gives the
 * moving-bat impulse only two distinct speeds to sample and the difference
 * between an early and a late flip nearly vanishes. Four ticks keeps the stroke
 * inside human reaction error while leaving the timing of the flip audible in
 * where the ball goes, which is the point of the mechanism.
 */
export const FLIPPER_UP_TICKS = 4;

/**
 * Ticks from fully flipped back to rest: 8.
 *
 * Longer than the up-stroke, as on a real machine, where the up-stroke is driven
 * by the coil and the return only by a spring. It also gives the player a
 * usable window to catch a ball on the way down.
 */
export const FLIPPER_DOWN_TICKS = 8;

/** Angle units the stroke advances per tick while the button is held. */
export const FLIPPER_UP_RATE = FLIPPER_SWEEP_UNITS / FLIPPER_UP_TICKS;

/** Angle units the stroke retreats per tick once the button is released. */
export const FLIPPER_DOWN_RATE = FLIPPER_SWEEP_UNITS / FLIPPER_DOWN_TICKS;

/**
 * The bat's surface, in the same shape the map's materials use so that the one
 * audited reflection routine can be reused verbatim.
 *
 * `index` is a placeholder: `reflectVelocity` reads only elasticity, friction
 * and kick, and a flipper is not a map material at all. `kick` is zero on
 * purpose — a flipper's power comes from the swing, and a fake outward impulse
 * on top would also fire a ball off a bat that is standing still.
 *
 * INFERRED, like every coefficient in `materials.ts`: nothing in the shipped
 * data records restitution. 400 is well below the 845 used for rubber so that a
 * ball can be trapped on a raised flipper instead of chattering off it.
 */
export const FLIPPER_SURFACE: MaterialBehaviour = Object.freeze({
  index: 1,
  kind: "flipper",
  passable: false,
  elasticity: 400,
  friction: 205,
  kick: 0,
  confidence: "inferred",
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Which of a table's three flippers this is. */
export type FlipperRole = "left" | "right" | "upper";

export interface FlipperConfig {
  readonly id: string;
  readonly role: FlipperRole;
  /** Pivot in Q10 playfield coordinates. */
  readonly pivotX: Q10;
  readonly pivotY: Q10;
  /** Bearing at rest, 2048 units, y downward. */
  readonly restAngle: number;
  /** Angle units swept from rest to fully flipped. Always positive. */
  readonly sweep: number;
  /** +1 when flipping increases the bearing, -1 when it decreases it. */
  readonly direction: 1 | -1;
  /** Pivot to tip, Q10. */
  readonly length: Q10;
  /** Half-thickness at the boss and at the tip, Q10. */
  readonly bossRadius: Q10;
  readonly tipRadius: Q10;
  /** Distance from the pivot at which the taper starts, Q10. */
  readonly taperStart: Q10;
  readonly upRate: number;
  readonly downRate: number;
  readonly surface: MaterialBehaviour;
  /** Where the pivot and angles came from. */
  readonly confidence: "measured" | "inferred";
}

/**
 * Why every pivot below says `inferred`.
 *
 * The flippers are absent from the collision layer, and the placement tables
 * live in `main.bin`, a packed TSL container. A search of the unpacked table
 * segments for the flipdat frame row offsets, the frame heights and the
 * per-frame pivot offsets — as bytes, 16-bit and 32-bit, both endiannesses —
 * returned nothing, so there is no measured placement available.
 *
 * What IS measured, off the shipped maps with the simulation's own rule that a
 * pixel blocks when its material index is odd:
 *
 *   * The bottom of the playfield is the SAME artwork on all three tables,
 *     shifted 28 px right on BabeWatch and Extreme Sports. Every wall run in
 *     rows 538..556 matches Law 'n Justice's exactly under that shift.
 *   * The two inlane guide rails end in rounded tips whose last blocking pixels
 *     are at x = 75..76 and x = 207..208 on row 556 (Law 'n Justice), so the
 *     bottom of the table is symmetric about x = 141.5.
 *   * Row 558 is the first row below those tips, and the free ball-CENTRE span
 *     across it — computed with the real 8 px radius — is exactly 84..199 on
 *     Law 'n Justice and exactly 112..227 on the other two. Those endpoints are
 *     symmetric about the same axis to the pixel.
 *
 * Every column in that paragraph is 32 px right of where it used to read, and
 * the reason is not a re-derivation: the shipped collision maps were exported a
 * word out of phase and have been re-exported (see `plunger.ts` for the byte
 * evidence). The measurement is the same measurement, run again on the corrected
 * bitmap. The ROW numbers — 556, 558 — are untouched, because a horizontal
 * reframe cannot move a row.
 *
 * The pivots are placed on those endpoints. That puts the boss 3.7 px clear of
 * the guide tip, far less than the 16 px a ball needs, so no ball can pass
 * behind a flipper; and it puts the pivot on the exact centre track a ball
 * rolling out of the inlane follows, so the ball arrives at the bat's base
 * rather than beside it. The rest angle and the sweep are then classic
 * proportions rather than measurements: 26.7 degrees below horizontal leaves
 * 34.6 px between the two tips, 2.2 ball diameters, and the whole stroke clears
 * the painted geometry at both ends.
 *
 * THE UPPER FLIPPER IS NOT PLACED. Illusions has three per table, and the
 * input layer already carries an `upperFlipper` control, but nothing in the
 * collision layer marks where the third pivot goes: the mid-playfield features
 * that look like candidates are posts with rubbers strung between them. Rather
 * than invent a coordinate, `flipperConfigsFor` returns the two that can be
 * derived and `hasUpperFlipper` reports false. Adding it later is data, not
 * code — every function here takes a list.
 */
export const FLIPPER_PLACEMENT_NOTE =
  "Bat geometry measured from pkg/flipdat1.bin; pivots inferred from measured " +
  "Law 'n Justice map anchors (guide tips row 556, free ball-centre span row 558); " +
  "upper flipper not located.";

/** Rest bearing of a left flipper: 152 units below horizontal, 26.7 degrees. */
export const FLIPPER_REST_ANGLE_UNITS = 152;

/** Row the lower pivots sit on, in pixels. Two rows below the guide tips. */
export const LOWER_FLIPPER_PIVOT_ROW = 558;

/**
 * Pivot columns of the two lower flippers, in pixels, per table.
 *
 * These are the endpoints of the measured free ball-centre span on
 * LOWER_FLIPPER_PIVOT_ROW; see FLIPPER_PLACEMENT_NOTE. BabeWatch and Extreme
 * Sports share Law 'n Justice's bottom artwork shifted 28 px right, and their
 * spans confirm it independently.
 */
export const LOWER_FLIPPER_PIVOT_COLUMNS: Readonly<
  Record<TableId, { readonly left: number; readonly right: number }>
> = Object.freeze({
  "law-n-justice": Object.freeze({ left: 84, right: 199 }),
  babewatch: Object.freeze({ left: 112, right: 227 }),
  "extreme-sports": Object.freeze({ left: 112, right: 227 }),
});

function lowerFlipper(
  id: string,
  role: "left" | "right",
  column: number,
  row: number,
): FlipperConfig {
  const mirrored = role === "right";
  return {
    id,
    role,
    pivotX: pixelsToQ10(column),
    pivotY: pixelsToQ10(row),
    // The right flipper's rest angle is the left's reflected in the vertical
    // axis, written as the reflection rather than as a second constant so the
    // two cannot drift apart.
    restAngle: mirrored ? HALF_TURN_UNITS - FLIPPER_REST_ANGLE_UNITS : FLIPPER_REST_ANGLE_UNITS,
    sweep: FLIPPER_SWEEP_UNITS,
    // Flipping raises the tip, which on the left means a smaller bearing and on
    // the right a larger one.
    direction: mirrored ? 1 : -1,
    length: pixelsToQ10(FLIPPER_LENGTH_PIXELS),
    bossRadius: pixelsToQ10(FLIPPER_BOSS_RADIUS_PIXELS),
    tipRadius: pixelsToQ10(FLIPPER_TIP_RADIUS_PIXELS),
    taperStart: pixelsToQ10(FLIPPER_TAPER_START_PIXELS),
    upRate: FLIPPER_UP_RATE,
    downRate: FLIPPER_DOWN_RATE,
    surface: FLIPPER_SURFACE,
    confidence: "inferred",
  };
}

/** The flippers this table can currently be played with. */
export function flipperConfigsFor(tableId: TableId): readonly FlipperConfig[] {
  const columns = LOWER_FLIPPER_PIVOT_COLUMNS[tableId];
  return Object.freeze([
    lowerFlipper("lower-left", "left", columns.left, LOWER_FLIPPER_PIVOT_ROW),
    lowerFlipper("lower-right", "right", columns.right, LOWER_FLIPPER_PIVOT_ROW),
  ]);
}

/**
 * False on every table, and deliberately visible rather than silent: the third
 * flipper exists on the real machine and its pivot has not been located.
 */
export function hasUpperFlipper(_tableId: TableId): boolean {
  return false;
}

/** Rejects a configuration that could not produce a sane stroke. */
export function validateFlipperConfig(config: FlipperConfig): FlipperConfig {
  if (!Number.isInteger(config.sweep) || config.sweep <= 0) {
    throw new RangeError(`flipper sweep must be a positive whole number: ${config.sweep}`);
  }
  if (config.sweep >= ANGLE_UNITS_PER_TURN) {
    throw new RangeError(`flipper sweep must be under one turn: ${config.sweep}`);
  }
  if (!Number.isInteger(config.upRate) || config.upRate <= 0) {
    throw new RangeError(`flipper upRate must be a positive whole number: ${config.upRate}`);
  }
  if (!Number.isInteger(config.downRate) || config.downRate <= 0) {
    throw new RangeError(`flipper downRate must be a positive whole number: ${config.downRate}`);
  }
  if (config.length <= 0) {
    throw new RangeError(`flipper length must be positive: ${config.length}`);
  }
  if (config.bossRadius <= 0 || config.tipRadius <= 0) {
    throw new RangeError("flipper bat radii must be positive");
  }
  if (config.tipRadius > config.bossRadius) {
    throw new RangeError("flipper tip may not be thicker than the boss");
  }
  if (config.taperStart < 0 || config.taperStart > config.length) {
    throw new RangeError(`flipper taper start is outside the bat: ${config.taperStart}`);
  }
  return config;
}

// ---------------------------------------------------------------------------
// State and stroke
// ---------------------------------------------------------------------------

/**
 * Where the bat is in its stroke. 0 is fully at rest, `config.sweep` fully
 * flipped; the value cannot leave that range, so no caller has to wrap it.
 */
export interface FlipperState {
  readonly stroke: number;
}

export const FLIPPER_AT_REST: FlipperState = Object.freeze({ stroke: 0 });

/**
 * One tick of one flipper: where the bat started, where it ended, and which bat
 * it was. Returned as a unit so a caller cannot advance the state and then
 * resolve contacts against a stale or mismatched starting pose.
 */
export interface FlipperSweep {
  readonly config: FlipperConfig;
  readonly from: FlipperState;
  readonly to: FlipperState;
}

/**
 * Advances one flipper by a tick.
 *
 * `held` is the state of the button at the end of the tick. A press and release
 * inside the same tick is not special-cased: unlike the plunger, whose whole
 * behaviour is the length of a hold, a flipper that never spent a sample point
 * down never moved the bat, and pretending otherwise would let a key that
 * bounced fire a shot.
 */
export function tickFlipper(
  config: FlipperConfig,
  state: FlipperState,
  held: boolean,
): FlipperSweep {
  const target = held ? config.sweep : 0;
  const rate = held ? config.upRate : config.downRate;
  let stroke = state.stroke;
  if (stroke < target) {
    stroke = Math.min(target, stroke + rate);
  } else if (stroke > target) {
    stroke = Math.max(target, stroke - rate);
  }
  return {
    config,
    from: state,
    to: stroke === state.stroke ? state : { stroke },
  };
}

/** The bat's bearing at a stroke, normalised into 0..2047. */
export function flipperAngle(config: FlipperConfig, state: FlipperState): number {
  return normalizeAngle(config.restAngle + config.direction * state.stroke);
}

/**
 * Angle units the bat turned through this tick, signed.
 *
 * `| 0` because a bat that did not move on a left flipper otherwise reports -0,
 * which compares equal to 0 under `===` but not under `Object.is`, and this
 * value ends up in replay records where the two must not be distinguishable.
 */
export function sweptAngle(sweep: FlipperSweep): number {
  return (sweep.config.direction * (sweep.to.stroke - sweep.from.stroke)) | 0;
}

/** True once the bat has reached the end of its stroke. */
export function isFullyFlipped(config: FlipperConfig, state: FlipperState): boolean {
  return state.stroke >= config.sweep;
}

/** Pivot and tip of the bat at a stroke, in Q10, for the renderer. */
export function flipperEndpoints(
  config: FlipperConfig,
  state: FlipperState,
): { readonly pivotX: Q10; readonly pivotY: Q10; readonly tipX: Q10; readonly tipY: Q10 } {
  const angle = flipperAngle(config, state);
  return {
    pivotX: config.pivotX,
    pivotY: config.pivotY,
    tipX: (config.pivotX + q10Multiply(config.length, cosineUnits(angle))) | 0,
    tipY: (config.pivotY + q10Multiply(config.length, sineUnits(angle))) | 0,
  };
}

// ---------------------------------------------------------------------------
// The bat as a swept, tapered capsule
// ---------------------------------------------------------------------------

/**
 * Half-thickness of the bat `along` units from the pivot, Q10.
 *
 * The silhouette is a constant 5 px to about 6 px out and then tapers linearly
 * to the tip, which is exactly what this reproduces. Treating the bat as a
 * capsule of varying radius rather than a true cone overstates the surface by at
 * most the taper's slope, about a tenth of a pixel per pixel — well inside the
 * one-pixel quantisation the silhouette was measured at.
 */
export function batRadiusAt(config: FlipperConfig, along: Q10): Q10 {
  if (along <= config.taperStart) return config.bossRadius;
  const span = config.length - config.taperStart;
  if (span <= 0) return config.tipRadius;
  const drop = config.bossRadius - config.tipRadius;
  const reduced = config.bossRadius - Math.trunc((drop * (along - config.taperStart)) / span);
  return reduced < config.tipRadius ? config.tipRadius : reduced;
}

/** A ball touching a bat at one pose. */
interface BatTouch {
  /** Outward unit normal in Q10, pointing from the bat toward the ball. */
  readonly normalX: Q10;
  readonly normalY: Q10;
  /** How far the ball has to move along the normal to just touch, Q10. */
  readonly penetration: Q10;
  /** Lever arm from the pivot to the touched point on the bat's surface, Q10. */
  readonly armX: Q10;
  readonly armY: Q10;
  /** Distance from the pivot along the bat's axis, Q10. */
  readonly along: Q10;
}

/**
 * Tests one ball against one bat pose.
 *
 * The degenerate case — a ball centre exactly on the bat's axis, which happens
 * when a bat sweeps up through a ball that was sitting on it — has no normal to
 * read off the geometry, so it falls back to the face the bat sweeps toward.
 * Choosing the other face there would push the ball down through the bat.
 */
function touchAt(
  config: FlipperConfig,
  angle: number,
  ballX: Q10,
  ballY: Q10,
  ballRadius: Q10,
): BatTouch | null {
  const axisX = cosineUnits(angle);
  const axisY = sineUnits(angle);
  const toBallX = ballX - config.pivotX;
  const toBallY = ballY - config.pivotY;
  const along = q10Clamp(
    q10Multiply(toBallX, axisX) + q10Multiply(toBallY, axisY),
    0,
    config.length,
  );
  const nearestX = config.pivotX + q10Multiply(along, axisX);
  const nearestY = config.pivotY + q10Multiply(along, axisY);
  const offsetX = ballX - nearestX;
  const offsetY = ballY - nearestY;
  const distanceSquared = offsetX * offsetX + offsetY * offsetY;

  const batRadius = batRadiusAt(config, along);
  const touchDistance = batRadius + ballRadius;
  if (distanceSquared >= touchDistance * touchDistance) return null;

  const distance = integerSqrt(distanceSquared);
  let normalX: number;
  let normalY: number;
  if (distance === 0) {
    normalX = (-config.direction * axisY) | 0;
    normalY = (config.direction * axisX) | 0;
  } else {
    normalX = roundHalfAwayFromZero((offsetX * Q10_ONE) / distance) | 0;
    normalY = roundHalfAwayFromZero((offsetY * Q10_ONE) / distance) | 0;
  }

  return {
    normalX,
    normalY,
    penetration: touchDistance - distance,
    armX: (nearestX + q10Multiply(batRadius, normalX) - config.pivotX) | 0,
    armY: (nearestY + q10Multiply(batRadius, normalY) - config.pivotY) | 0,
    along,
  };
}

/**
 * Poses to sample across one tick of this flipper's fastest stroke.
 *
 * One more than the number of ball radii the tip covers in a tick, so no gap
 * between consecutive poses is as wide as the ball is; derived rather than
 * chosen, so a shorter or slower bat costs less.
 */
export function substepsFor(config: FlipperConfig, ballRadius: Q10 = DEFAULT_PROBE_RADIUS): number {
  const tipTravel = Math.abs(tangentialSpeed(config.length, config.upRate));
  return Math.max(1, Math.ceil(tipTravel / ballRadius) + 1);
}

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

/** A ball that met a bat this tick. */
export interface FlipperContact {
  readonly ballId: number;
  readonly flipperId: string;
  readonly normalX: Q10;
  readonly normalY: Q10;
  /** Distance from the pivot along the bat, Q10: near 0 at the boss. */
  readonly along: Q10;
  /** Bat surface speed at the contact point, Q10 per tick. Zero at rest. */
  readonly batSpeed: number;
  /** Closing speed along the normal before the impulse, Q10 per tick. */
  readonly approachSpeed: number;
  /** True when the bat was moving into the ball rather than merely in the way. */
  readonly struck: boolean;
}

const VELOCITY_LIMIT = 32767;

function clampVelocity(value: number): number {
  return q10Clamp(Math.trunc(value), -VELOCITY_LIMIT, VELOCITY_LIMIT);
}

/**
 * Resolves every ball against every flipper for one tick.
 *
 * Runs AFTER `stepBalls`: the bats guard the drain, and a ball must be given its
 * chance to be saved at the position it actually reached this tick rather than
 * the one it started from.
 *
 * `clamp` is the same map-aware push limiter `resolveBallCollisions` takes, and
 * for the same reason: separating a ball from a bat with an unlimited shove can
 * bury it in a wall, and a ball outside the bitmap can never move again. It is
 * optional only so the impulse can be tested without a map.
 */
export function resolveFlipperContacts(
  balls: readonly BallState[],
  sweeps: readonly FlipperSweep[],
  ballRadius: Q10 = DEFAULT_PROBE_RADIUS,
  clamp: PushClamp | null = null,
  restThreshold: number = DEFAULT_SIMULATION_OPTIONS.restThreshold,
): readonly FlipperContact[] {
  const contacts: FlipperContact[] = [];
  for (const ball of balls) {
    if (!ball.active) continue;
    for (const sweep of sweeps) {
      const contact = resolveOne(ball, sweep, ballRadius, clamp, restThreshold);
      if (contact !== null) contacts.push(contact);
    }
  }
  return contacts;
}

function resolveOne(
  ball: BallState,
  sweep: FlipperSweep,
  ballRadius: Q10,
  clamp: PushClamp | null,
  restThreshold: number,
): FlipperContact | null {
  const { config } = sweep;
  const turned = sweptAngle(sweep);
  const startAngle = flipperAngle(config, sweep.from);
  const steps = turned === 0 ? 1 : substepsFor(config, ballRadius);

  for (let step = 1; step <= steps; step += 1) {
    // Truncated rather than rounded so the samples advance monotonically and the
    // last one is exactly the end-of-tick pose.
    const angle = normalizeAngle(startAngle + Math.trunc((turned * step) / steps));
    const touch = touchAt(config, angle, ball.x, ball.y, ballRadius);
    if (touch === null) continue;

    // Rigid-body surface velocity at the touched point: omega crossed with the
    // lever arm, which in two dimensions rotates the arm a quarter turn.
    const surfaceX = -tangentialSpeed(touch.armY, turned);
    const surfaceY = tangentialSpeed(touch.armX, turned);

    const approachSpeed =
      q10Multiply(ball.velocityX - surfaceX, touch.normalX) +
      q10Multiply(ball.velocityY - surfaceY, touch.normalY);

    // Reflect in the bat's frame, so the one audited reflection routine — with
    // its rest threshold and its Coulomb "no normal force, no friction" rule —
    // is the only place a bounce is ever computed.
    ball.velocityX = clampVelocity(ball.velocityX - surfaceX);
    ball.velocityY = clampVelocity(ball.velocityY - surfaceY);
    reflectVelocity(ball, config.surface, touch.normalX, touch.normalY, restThreshold);
    ball.velocityX = clampVelocity(ball.velocityX + surfaceX);
    ball.velocityY = clampVelocity(ball.velocityY + surfaceY);

    separate(ball, touch, clamp);

    const batSpeed = tangentialSpeed(
      integerSqrt(touch.armX * touch.armX + touch.armY * touch.armY),
      turned,
    );
    return {
      ballId: ball.id,
      flipperId: config.id,
      normalX: touch.normalX,
      normalY: touch.normalY,
      along: touch.along,
      batSpeed,
      approachSpeed,
      struck: approachSpeed < 0 && turned !== 0,
    };
  }
  return null;
}

/**
 * Lifts a ball out of the bat it is overlapping.
 *
 * Without this a ball resting on a raised flipper sinks a little further every
 * tick — the impulse cancels the approach but never undoes the overlap gravity
 * already produced — and eventually comes out of the other side.
 */
function separate(ball: BallState, touch: BatTouch, clamp: PushClamp | null): void {
  if (touch.penetration <= 0) return;
  const deltaX = q10Multiply(touch.penetration, touch.normalX);
  const deltaY = q10Multiply(touch.penetration, touch.normalY);
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

// ---------------------------------------------------------------------------
// A whole table's flippers
// ---------------------------------------------------------------------------

/** Button state for one tick, one entry per flipper id. */
export type FlipperInput = ReadonlyMap<string, boolean>;

/** Every flipper on a table plus its stroke. */
export interface FlipperBank {
  readonly configs: readonly FlipperConfig[];
  readonly states: ReadonlyMap<string, FlipperState>;
}

export function createFlipperBank(tableId: TableId): FlipperBank {
  const configs = flipperConfigsFor(tableId).map(validateFlipperConfig);
  const states = new Map<string, FlipperState>();
  for (const config of configs) {
    states.set(config.id, FLIPPER_AT_REST);
  }
  return { configs, states };
}

/** What one tick did to a whole bank. */
export interface FlipperBankTick {
  readonly bank: FlipperBank;
  readonly sweeps: readonly FlipperSweep[];
}

/**
 * Advances a whole bank. Iterates `configs`, never the map, so the order of the
 * sweeps depends on the table's declared flippers rather than on insertion order
 * — a Map's iteration order is stable but it is not the property this wants to
 * rest on.
 */
export function tickFlipperBank(bank: FlipperBank, input: FlipperInput): FlipperBankTick {
  const sweeps: FlipperSweep[] = [];
  const states = new Map<string, FlipperState>();
  for (const config of bank.configs) {
    const state = bank.states.get(config.id) ?? FLIPPER_AT_REST;
    const sweep = tickFlipper(config, state, input.get(config.id) === true);
    sweeps.push(sweep);
    states.set(config.id, sweep.to);
  }
  return { bank: { configs: bank.configs, states }, sweeps };
}

/** Button state built from the abstract control names the input layer uses. */
export function flipperInputFrom(left: boolean, right: boolean): FlipperInput {
  return new Map<string, boolean>([
    ["lower-left", left],
    ["lower-right", right],
  ]);
}
