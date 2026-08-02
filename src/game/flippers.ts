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
 * WHERE THE BATS SIT IS NOW MEASURED TOO, and this file used to say it could not
 * be. The placement was looked for in the wrong place: it is not in `main.bin`
 * at all but in the TABLE packages, as four 0x1FA-byte flipper records reached
 * through $2346(a5) from the surface-id handlers for ids 1..4 at +0x00AE80,
 * +0x00AE86, +0x00AE90 and +0x00AE9A. Each record opens with a type byte, a
 * handler byte, the pivot as two words, the rest pose and the flipped pose, and
 * then the stroke rates. The pivots read (86,556) and (199,556) on Law 'n
 * Justice, (112,556) and (227,556) on BabeWatch and (113,556) and (227,556) on
 * Extreme Sports — within two pixels of what this project had inferred from the
 * map's free-centre spans, which is a good independent check on both.
 *
 * Law 'n Justice also carries a THIRD record, at pivot (37,302), sweeping 11
 * poses instead of 18 — the upper-left flipper this file has always said it
 * could not locate. It is recorded in LAW_N_JUSTICE_UPPER_FLIPPER and NOT wired
 * in: giving a table a third bat is a change to how it plays and wants its own
 * pass with the census, not a line in a timebase audit.
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
 * WHY THE BAT MUST BE MOVING, AND WHAT IT GIVES THE BALL WHEN IT DOES
 * ---------------------------------------------------------------------------
 * MEASURED, and this whole model used to be this port's own invention. The
 * original's bat-versus-ball handler is at main.seg00 +0x00AEA2, reached from
 * the surface-id entries for ids 1..4 at +0x00AE80/86/90/9A (`adda.w` of 0,
 * $1FA, $3F4, $5EE onto $2346(a5) — the 506-byte flipper record stride). It does
 * five things and this file now does the same five:
 *
 *   1. `move.w $10(a0),d2 / beq -> rts`. The bat's angular RATE is a GATE. A bat
 *      that is not turning imparts nothing at all, however it is placed.
 *   2. `d0 = |ballX - $2(a0)|`, `d1 = |ballY - $4(a0)|`, `d0 = (d0<<6)+d1`,
 *      `move.w (a1,d0.w*2),d0` off a 64x64 word table. The table is at offset
 *      $B0B8 of HUNK 1 — the `lea.l $b0b8.l,a1` at +0x00AEA2 carries a hunk-1
 *      relocation, which is why reading it as a hunk-0 address lands inside the
 *      impulse sub-handlers and why it has been reported as undecodable. All
 *      4096 entries are exactly `isqrt((dx*dx + dy*dy) * 35810 >> 16)`, i.e.
 *      `floor(0.7392 * distance)`: the table is the ball's DISTANCE FROM THE
 *      PIVOT, three quarters scale. See `flipperImpulseRadius`.
 *   3. `d3 = d0>>1` is SUBTRACTED from the bat's rate toward zero at +0x00AED2..
 *      +0x00AEE0 and written back to $10(a0). The ball takes angular momentum
 *      out of the bat: the impulse is computed from the REDUCED rate, and a
 *      second ball on the same stroke gets less.
 *   4. Small radii are floored: `if d0 < $2E: d0 += ($2E - d0) >> 3`, so a ball
 *      struck at the boss still leaves with something.
 *   5. One of eight sub-handlers at $B036 + 0x3C*n, chosen by the record's byte
 *      $1(a0), writes `$1c(a4) = magnitude * 2 * rate` and `$1a(a4) = 8 * 2 *
 *      rate`. Those two are consumed at +0x00B528: $1C is added to the NORMAL
 *      component and $1A to the TANGENTIAL component of the ball's velocity
 *      after it has been rotated into the contact frame by $28(a4). Each
 *      sub-handler also carries an eight-byte mask indexed by `$28(a4)>>8` — the
 *      contact normal's octant — and the eight masks are the same four-of-eight
 *      pattern rotated one byte per handler: the bat only imparts to a ball on
 *      the face it is sweeping toward.
 *
 * So the impulse is NOT a reflection and it is NOT a rigid-body frame change. It
 * is an additive kick along the contact normal whose size is
 * `magnitude(radius) * 2 * rate`, with `8 * 2 * rate` of drag along the surface,
 * and the reflection that follows is skipped outright when the kick has already
 * sent the ball outward (`tst.w d0 / ble` at +0x00B54C, which is exactly what
 * `reflectVelocity`'s own "not approaching, return" does).
 *
 * WHAT THE PORT HAD, AND WHY IT WAS THE DEFECT. This file used to reflect the
 * ball in the bat's instantaneous rigid-body frame with an elasticity of 400.
 * That scales the whole impulse by the bat's angular velocity times the lever
 * arm and nothing else, which under-drives the boss — 367 px/s where the
 * original gives about 590 — and over-drives everything past about 30 px out
 * into the engine's own +-4095 velocity clamp, so every clean shot left at
 * 798..810 px/s no matter where or when it was struck. Three contact points out
 * of five in the previous agent's harness did not send the ball up the table at
 * all. The original's law is bounded by construction (the table is a distance,
 * and the rate deduction is a self-limiter), and its spread lives in the STROKE:
 * a ball met at rate 20 leaves at a tenth of the speed of one met at rate 120.
 *
 * A bat standing still is unchanged: rate zero closes the gate and all that is
 * left is `elasticity` (400, against 612 for the measured rubber row), which is
 * what lets a ball be trapped on a raised flipper.
 *
 * The radius is the ball CENTRE's distance from the pivot, because that is what
 * +0x00AEB4 measures — `movem.w $2(a0),d3-d4` is the pivot and d0/d1 arrive as
 * the ball's whole-pixel position. It is not the lever arm to the touched point
 * on the surface.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TICK IS SUBDIVIDED
 * ---------------------------------------------------------------------------
 * At full stroke rate the tip travels 17.7 px in one tick. The bat is barely
 * 2 px thick out there, so a ball 8 px in radius sitting near the tip is inside
 * a window that one tick's rotation can step straight over: test only the
 * end-of-tick pose and the flipper passes through the ball without touching it.
 * The arc is therefore sampled at `substepsFor` intermediate poses and the FIRST
 * one that touches is the one that resolves. The sample count is derived from
 * the configuration, not guessed, so a slower or shorter flipper automatically
 * uses fewer.
 *
 * The subdivision is now the ORIGINAL'S OWN, which it used not to be: the four
 * steps of the stroke, each subdivided again if the tip could still outrun a
 * ball inside one of them (on the shipped bats it cannot — 4.4 px against a
 * radius of 8, so the count is unchanged at four). That matters beyond tidiness,
 * because the bat's RATE is what sizes the impulse and the rate changes at every
 * one of those four steps: a fresh stroke runs at 20, 40, 60 and 80 bat units
 * inside a single frame. Sampling a pose without the rate that belongs to it is
 * what would collapse the flipper's timing gradient.
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

import type { BallState, MaterialBehaviour, PlayfieldLevel, TableId } from "./contracts.js";
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
import {
  ORIGINAL_ANGLE_UNITS_PER_POSE,
  ORIGINAL_ANGLE_UNITS_PER_TURN,
  ORIGINAL_FLIPPER_STEPS_PER_FRAME,
  ORIGINAL_POSES_PER_TURN,
  VELOCITY_CLAMP_Q10,
  originalVelocityToQ10,
} from "./timebase.js";

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

// ---------------------------------------------------------------------------
// The stroke, MEASURED — this whole block used to be chosen
// ---------------------------------------------------------------------------
//
// THE BAT IS NOT DRIVEN AT A CONSTANT RATE AND IT IS NOT STEPPED ONCE A TICK.
// The animation is the tail of the routine at main.seg00 +0x00BC24, entered at
// +0x00BD46 with no `rts` between, and $BC24 is called ONCE PER COLLISION PASS —
// +0x00A65A, +0x00A6A4, +0x00A6EE, +0x00A736, and four times again in each of
// the two no-ball paths at +0x00A750 and +0x00A770. So the bat advances FOUR
// TIMES per 50 Hz frame, and what advances is an angular VELOCITY under
// constant acceleration to a cap:
//
//     00BD86  movem.w $10(a0), d0-d4   ; d0 angvel, d1 angle, d2 limit,
//                                      ; d3 up accel, d4 up max rate
//     00BD8C  add.w   d0, d1           ; angle += angvel      <- POSITION FIRST
//     00BD8E  bmi.b   $bd98            ; ran past rest? clamp to rest, angvel 0
//     00BD98  cmp.w   d2, d1 / bgt     ; ran past the limit? clamp, angvel 0,
//                                      ; and set the "fully flipped" flag $23F5
//     00BDA8  sub.w   d3, d0           ; angvel += accel
//     00BDAA  cmp.w   d4, d0 / bgt     ; capped at the max rate
//     00BDB4  move.w  d1, $12(a0)      ; store the angle
//     00BDB8  asr.w   #$6, d1
//     00BDBA  move.w  d1, $1a(a0)      ; POSE OFFSET = angle >> 6
//
// The release path at +0x00BDC4 is the same shape with the record's OTHER pair,
// and it carries the current angular velocity across the reversal rather than
// zeroing it, so a button released mid-stroke decelerates and then falls back.
//
// The numbers come out of the per-table flipper records — four records of 0x1FA
// bytes at $2346(a5), reached from the surface-id jump table at +0x00AE40 whose
// entries for ids 1..4 are +0, +0x1FA, +0x3F4, +0x5EE — and they are IDENTICAL
// on all three tables and mirrored between the two bats:
//
//   law-n-justice  lower left  pivot (86,556)  poses 10 -> 112  down(30,+50) up(20,-120)
//                  lower right pivot (199,556) poses 50 ->  68  down(30,-50) up(20,+120)
//   babewatch      lower left  pivot (112,556) / right (227,556), same rates
//   extreme-sports lower left  pivot (113,556) / right (227,556), same rates
//
// 112 wraps to -8 against a base of 10, so both bats sweep EIGHTEEN of the 120
// three-degree poses: 54 degrees, 1152 angle units, and the two ends of the
// sweep are stored as the poses themselves.

/** The bat's own angle scale: 64 units to a drawn pose, 7680 to a turn. */
export const BAT_ANGLE_UNITS_PER_POSE = ORIGINAL_ANGLE_UNITS_PER_POSE;
export const BAT_ANGLE_UNITS_PER_TURN = ORIGINAL_ANGLE_UNITS_PER_TURN;

/** Times the bat's angle advances per tick. MEASURED: four, one per collision pass. */
export const FLIPPER_STEPS_PER_TICK = ORIGINAL_FLIPPER_STEPS_PER_FRAME;

/**
 * Sweep of the stroke: 18 poses, 1152 bat angle units, 54 degrees. MEASURED.
 *
 * It was 272 of 2048 — 47.8 degrees — chosen because "a Williams-era flipper
 * sweeps about 48 degrees" and because 4 and 8 divide it. The real bat is six
 * degrees wider and the numbers that set it are on the disk.
 */
export const FLIPPER_SWEEP_POSES = 18;
export const FLIPPER_SWEEP_UNITS = FLIPPER_SWEEP_POSES * BAT_ANGLE_UNITS_PER_POSE;

/** Bat units per step the coil adds to the angular rate, and its cap. MEASURED. */
export const FLIPPER_UP_ACCELERATION = 20;
export const FLIPPER_UP_MAX_RATE = 120;

/** The same for the return spring, which is weaker and slower. MEASURED. */
export const FLIPPER_DOWN_ACCELERATION = 30;
export const FLIPPER_DOWN_MAX_RATE = 50;

/**
 * Ticks from rest to fully flipped: 3.5, and it is now a RESULT rather than a
 * setting.
 *
 * Replaying the measured stroke — rate 0, 20, 40, 60, 80, 100, 120, 120... with
 * the angle advanced before the rate — the sweep of 1152 units is consumed on
 * the 14th step, and there are four steps to a tick. The port chose FOUR ticks,
 * which is remarkably close; what was wrong was not the duration but the SHAPE.
 * A constant-rate bat sweeps at 68 of the port's angle units a tick throughout,
 * where the real one peaks at 480 bat units a step * 4 = 128 port units a tick,
 * nearly twice as fast, and does it only in the second half of the stroke. A
 * ball caught early and a ball caught late leave at genuinely different speeds,
 * which is the whole of what flipper timing is.
 *
 * At the tip, 45 px out, the peak is 17.7 px a tick — 885 px a second, against a
 * measured velocity clamp of 800 — so a full-strength flipper shot now crosses
 * the 600 px playfield in about half a second. At the old constant rate it was
 * 9.4 px a tick, which after the gravity correction would have made a flipper
 * shot WEAKER than a scoop kicker and a bumper twice as strong as a bat. That
 * would have been the next defect, and it was found by re-deriving this rather
 * than by playing it.
 */
export const FLIPPER_UP_TICKS = 3.5;

/** Ticks from fully flipped back to rest: 6.25. Also a result. */
export const FLIPPER_DOWN_TICKS = 6.25;

// ---------------------------------------------------------------------------
// The impulse, MEASURED — this whole block used to be a rigid-body reflection
// ---------------------------------------------------------------------------

/**
 * Side of the original's impulse table, in whole pixels: 64.
 *
 * MEASURED. `+0x00AEC6` builds the index as `(|dx| << 6) + |dy|` and reads a
 * word, so both offsets are taken modulo nothing at all — a ball more than 63 px
 * from the pivot on either axis would read off the end of the row. It cannot
 * happen on a 45 px bat with an 8 px ball, and the port clamps rather than
 * reproducing the overrun.
 */
export const ORIGINAL_IMPULSE_TABLE_SIDE = 64;

/**
 * The scale the impulse table applies to the pivot distance, as a 16-bit
 * fraction of the SQUARE: 35810 / 65536.
 *
 * MEASURED, and it reproduces all 4096 entries exactly:
 *
 *     table[dx][dy] === isqrt(((dx*dx + dy*dy) * 35810) >> 16)
 *
 * sqrt(35810/65536) is 0.7392005, and the table pins the linear constant to
 * [0.73919716, 0.73920458) — a bracket seven parts in a million wide, which is
 * the tightest any constant in this project has been measured to and which
 * contains the five-digit decimal 0.7392 and essentially nothing else. Written
 * as the squared form because that is the only shape that stays in the integers:
 * the port must not evaluate a square root in floating point and then floor it.
 */
export const ORIGINAL_IMPULSE_SCALE_Q16 = 35810;

/**
 * The floor applied to a small radius: 46, one pixel past the bat's own length.
 *
 * MEASURED at +0x00AEF0: `subi.w #$2e,d5 / bge / neg.w d5 / lsr.w #3,d5 /
 * add.w d5,d0`, i.e. `if v < 46: v += (46 - v) >> 3`. Every radius a 45 px bat
 * can produce is under 46, so on a flipper the floor ALWAYS fires; it lifts the
 * boss from 0 to 5 and the tip from 33 to 34, which is what stops a ball caught
 * at the boss from being handed nothing.
 */
export const ORIGINAL_IMPULSE_FLOOR = 46;

/** Surface drag: the constant `moveq #$8,d1` at +0x00AEE8, in the same units. */
export const ORIGINAL_IMPULSE_TANGENT = 8;

/**
 * The original's raw table entry for a ball `dx`,`dy` pixels from the pivot.
 *
 * Whole pixels in, whole units out, integers throughout. Both offsets are taken
 * as magnitudes (the `neg.w` pair at +0x00AEBC/+0x00AEC4) and clamped to the
 * table's 64 px side.
 */
export function flipperImpulseRadius(dx: number, dy: number): number {
  const x = Math.min(ORIGINAL_IMPULSE_TABLE_SIDE - 1, Math.abs(Math.trunc(dx)));
  const y = Math.min(ORIGINAL_IMPULSE_TABLE_SIDE - 1, Math.abs(Math.trunc(dy)));
  return integerSqrt(Math.trunc((x * x + y * y) * ORIGINAL_IMPULSE_SCALE_Q16 / 65536));
}

/**
 * The same entry with the small-radius floor applied: what actually multiplies
 * the bat's rate. See ORIGINAL_IMPULSE_FLOOR.
 */
export function flipperImpulseMagnitude(dx: number, dy: number): number {
  const raw = flipperImpulseRadius(dx, dy);
  if (raw >= ORIGINAL_IMPULSE_FLOOR) return raw;
  return raw + ((ORIGINAL_IMPULSE_FLOOR - raw) >> 3);
}

/**
 * Bat units per step a ball at this radius takes out of the bat: half the raw
 * table entry, +0x00AED0's `lsr.w #1,d3`.
 *
 * The RAW entry, not the floored one — the floor is applied after the deduction
 * at +0x00AEF0, so a ball caught at the boss costs the bat nothing.
 */
export function flipperRateTaken(dx: number, dy: number): number {
  return flipperImpulseRadius(dx, dy) >> 1;
}

/**
 * The bat's surface, in the same shape the map's materials use so that the one
 * audited reflection routine can be reused verbatim.
 *
 * `index` is a placeholder: `reflectVelocity` reads only elasticity, friction
 * and kick, and a flipper is not a map material at all. `kick` is zero on
 * purpose — a flipper's power comes from the swing, and a fake outward impulse
 * on top would also fire a ball off a bat that is standing still.
 *
 * ELASTICITY IS NOW MEASURED. The flipper ids 1..4 select the hunk-8 surface
 * row with restitution word 115 — the same 256-row table every other surface's
 * restitution is read from (`surface-physics.ts`, and the disassembly's static
 * bat model: "a resting or held-at-top bat acts as a static wall with id-1..4
 * hunk-8 constants: restitution 115/256"). 115 * 4 = 460 Q10. The old 400 was
 * chosen; the measured value keeps the property it was chosen for — one tick of
 * gravity bounces at 460/1024 * 128 = 57 Q10, far under the rest threshold, so
 * a cradled ball still settles instead of chattering.
 *
 * Friction stays this port's own 205: the original's tangential rule is a
 * fraction of the SLIP against ball spin (word $3A = 12800 for the bat), which
 * a spinless BallState cannot hold — see the long note in `ball-physics.ts`.
 */
export const FLIPPER_SURFACE: MaterialBehaviour = Object.freeze({
  index: 1,
  kind: "flipper",
  passable: false,
  elasticity: 460,
  friction: 205,
  kick: 0,
  confidence: "measured",
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
  /**
   * BAT angle units swept from rest to fully flipped, always positive, on the
   * original's 7680-per-turn scale rather than the 2048 the bearings use.
   *
   * The bat keeps its own scale because the measured stroke is expressed in it —
   * 64 units to a drawn pose, an acceleration of 20 and a cap of 120 — and none
   * of those are whole numbers of the coarser one. `flipperAngle` converts.
   */
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
  /** Bat units per step the coil adds to the angular rate, and its cap. */
  readonly upAcceleration: number;
  readonly upMaxRate: number;
  /** The same for the return spring. */
  readonly downAcceleration: number;
  readonly downMaxRate: number;
  readonly surface: MaterialBehaviour;
  /**
   * The COLLISION LEVEL this bat lives on. A ball riding the other one is not
   * struck by it.
   *
   * The three lower pairs and Law 'n Justice's upper bat are on the main level;
   * the BabeWatch and Extreme Sports upper bats are on the raised playfield. See
   * `UPPER_FLIPPER_RECORDS` for the evidence and for exactly how strong it is.
   */
  readonly level: PlayfieldLevel;
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
 * THE INFERENCE WAS THEN CHECKED AGAINST THE DISK AND SURVIVED, WITHIN TWO
 * PIXELS. The flipper records in the table packages (see the file header) give
 * the pivots outright: MEASURED_FLIPPER_PIVOTS below. Every one of the six
 * columns is within two pixels of the inferred one and three are exact, and the
 * row is 556 against the inferred 558.
 *
 * The INFERRED placement is still what the simulation runs on, and that is a
 * deliberate choice rather than an oversight. The inferred numbers are
 * mechanically re-derived from a shipped asset by the placement tests, so they
 * cannot rot; the disk numbers cannot be, because the table packages are not in
 * this repository. Swapping them in also moves both bats two rows up and shifts
 * one of them sideways, which is a change to how a table PLAYS, and belongs in a
 * change that can run the census against it rather than in a timebase audit. The
 * test suite asserts the two agree to within two pixels, so the day they stop
 * agreeing is the day something is wrong with one of them.
 */
export const FLIPPER_PLACEMENT_NOTE =
  "Bat geometry measured from pkg/flipdat1.bin; sweep and both stroke rates " +
  "measured from the per-table flipper records at $2346(a5) (Table00N.seg04); " +
  "LOWER pivots inferred from measured map anchors (guide tips row 556, free " +
  "ball-centre span row 558) and cross-checked against those records to within " +
  "two pixels; the UPPER bat every table ships is measured outright - pivot, " +
  "both poses and all four stroke rates straight off its record, there being " +
  "no map anchor to infer one from.";

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

/**
 * What the disk says, for the cross-check: word +2 and word +4 of each table's
 * two lower-flipper records, which are the pivot's x and y in whole pixels.
 *
 * Not used by the simulation. See FLIPPER_PLACEMENT_NOTE for why the inferred
 * placement above is still the one that runs, and `tests/flippers.test.ts` for
 * the assertion that the two never drift more than two pixels apart.
 */
export const MEASURED_FLIPPER_PIVOTS: Readonly<
  Record<TableId, { readonly left: number; readonly right: number; readonly row: number }>
> = Object.freeze({
  "law-n-justice": Object.freeze({ left: 86, right: 199, row: 556 }),
  babewatch: Object.freeze({ left: 112, right: 227, row: 556 }),
  "extreme-sports": Object.freeze({ left: 113, right: 227, row: 556 }),
});

/**
 * ALL THREE TABLES SHIP A THIRD BAT, and this file used to say two of them did
 * not. That claim was an ALIGNMENT ARTEFACT and it is worth spelling out,
 * because the same mistake is available to anyone who re-reads these records.
 *
 * The four-slot array (stride 0x1FA, surface id n selecting slot n-1 through the
 * `adda.w #0/$1FA/$3F4/$5EE` at main.seg00 +0xAE80/86/90/9A onto `$2346(a5)`)
 * starts at a DIFFERENT hunk-4 body offset on each table: Law 'n Justice
 * 0x18D8, BabeWatch 0x18D0, Extreme Sports 0x18D4. Read at Law 'n Justice's base
 * the other two tables' slot 1 lands eight and four bytes out and reads as
 * blank. Read at each table's own base, every one of the twelve slots parses
 * against the same field map, and all three tables carry THREE records with type
 * byte 1 and ONE with type byte 3 — the unused marker the bat loop skips with
 * `cmpi.b #3,(a0) / beq` at +0xBD62.
 *
 * THE FIELD MAP, verified against all twelve records:
 *
 *   +0  type byte      1 = active, 3 = unused slot
 *   +1  handler        sub-handler family n, at $B036 + 0x3C*n
 *   +2  pivot x word   +4  pivot y word, whole pixels
 *   +6  rest pose      +8  flipped pose, on the 120-pose/3-degree flipdat scale
 *   +A  KEY BINDING    1 = LEFT button, 0 = RIGHT button
 *   +C  spring accel   +E  spring cap, signed
 *   +16 coil accel     +18 coil cap, signed
 *   +1C longword, relocated into the table's hunk 2: the pose/mask bank
 *
 * THE KEY BINDING IS MEASURED, at +0xBD6C: `cmpi.w #0,$A(a0) / beq` takes the
 * RIGHT path at +0xBE04, which tests `$23F4(a5)` (built at +0xBD5A from key
 * `$EF3(a5)` or joystick `$EF7(a5)`); anything nonzero falls into the LEFT path
 * at +0xBD76 testing `$23F3(a5)`. THERE IS NO THIRD BUTTON. An upper bat fires
 * on the same shift key as the lower bat on its side.
 *
 * THE LEVEL IS A READING AND NOT A MEASUREMENT, and is labelled so wherever it
 * is used. The +0x1C bank pointer is hunk2+0 for every main-level bat and
 * hunk2+0x65B8 for the BabeWatch and Extreme Sports upper bats. 0x65B8 = 26040 =
 * 42 bytes a row x 620 rows, exactly one more 336-px-wide one-bit-per-pixel
 * plane, and hunk 2's body of 0x19050 = 42 x 2440 rows decomposes as
 * 620+620+600+600 on all three tables. The arithmetic is exact; that the two
 * banks ARE the two collision levels' bat masks was not confirmed from code, and
 * the hunk-2 consumers were not traced. What supports it independently is the
 * geometry: BabeWatch's (205,115) has upper-level walls around it and nothing at
 * all on the main level there.
 *
 * THE SUB-HANDLER FAMILIES (+1) are eight 0x3C-byte handlers at +0xB036 whose
 * CODE is byte-identical; only a trailing 8-byte octant mask differs, and
 * `mask_n[k] = mask_0[(k+n) mod 8]` with `mask_0 = 00 00 00 00 01 01 01 01`. The
 * mask gates which contact octants the stroke imparts into, which is the
 * original's way of saying "only the face the bat sweeps through". This port
 * gates analytically on the approach side in `touchAt`, which subsumes it, so
 * the family byte is recorded and not used.
 */
export const UPPER_FLIPPER_RECORDS: Readonly<
  Record<
    TableId,
    {
      readonly pivotXPixels: number;
      readonly pivotYPixels: number;
      readonly restPose: number;
      readonly flippedPose: number;
      readonly sweepPoses: number;
      readonly role: FlipperRole;
      readonly handlerFamily: number;
      readonly upAcceleration: number;
      readonly upMaxRate: number;
      readonly downAcceleration: number;
      readonly downMaxRate: number;
      readonly level: PlayfieldLevel;
    }
  >
> = Object.freeze({
  // Slot 0, id 1, hunk4 +0x18D8. Key word 1 = LEFT. Poses run DOWN, 23 -> 12,
  // so eleven of them: 33 degrees, two thirds of a lower bat. Bank hunk2+0 =
  // the main playfield.
  "law-n-justice": Object.freeze({
    pivotXPixels: 37,
    pivotYPixels: 302,
    restPose: 23,
    flippedPose: 12,
    sweepPoses: 11,
    role: "left" as FlipperRole,
    handlerFamily: 7,
    upAcceleration: 20,
    upMaxRate: 120,
    downAcceleration: 30,
    downMaxRate: 50,
    level: 0 as PlayfieldLevel,
  }),
  // Slot 1, id 2, hunk4 +0x18D0. Key word 0 = RIGHT. Poses run UP, 35 -> 48,
  // thirteen of them, 39 degrees. SOFTER than a lower bat in both directions —
  // coil acceleration 10 against 20, spring 15 against 30 — with the same caps.
  babewatch: Object.freeze({
    pivotXPixels: 205,
    pivotYPixels: 115,
    restPose: 35,
    flippedPose: 48,
    sweepPoses: 13,
    role: "right" as FlipperRole,
    handlerFamily: 5,
    upAcceleration: 10,
    upMaxRate: 120,
    downAcceleration: 15,
    downMaxRate: 50,
    level: 1 as PlayfieldLevel,
  }),
  // Slot 1, id 2, hunk4 +0x18D4. Key word 0 = RIGHT. A FULL eighteen-pose
  // sweep on the same pose numbers as a lower-right bat, softened coil.
  "extreme-sports": Object.freeze({
    pivotXPixels: 182,
    pivotYPixels: 194,
    restPose: 50,
    flippedPose: 68,
    sweepPoses: 18,
    role: "right" as FlipperRole,
    handlerFamily: 4,
    upAcceleration: 15,
    upMaxRate: 120,
    downAcceleration: 20,
    downMaxRate: 50,
    level: 1 as PlayfieldLevel,
  }),
});

/**
 * Kept under its old name because other modules and the dossier cite it.
 * Superseded by `UPPER_FLIPPER_RECORDS`, which carries all three tables.
 */
export const LAW_N_JUSTICE_UPPER_FLIPPER = UPPER_FLIPPER_RECORDS["law-n-justice"];

/** A flipdat pose index as a bearing on the 2048-unit scale. 120 poses a turn. */
export function poseToAngleUnits(pose: number): number {
  return Math.round((pose * ANGLE_UNITS_PER_TURN) / ORIGINAL_POSES_PER_TURN);
}

/**
 * The third bat, built from its table's record.
 *
 * PROVENANCE IS MIXED and the config says `measured` because the parts that
 * decide where the bat is and how it moves all come off the disk: pivot, both
 * poses, and all four stroke constants. The lower pairs deliberately run on
 * INFERRED pivots (row 558 against the disk's 556) because there is a shipped
 * asset the placement tests can re-derive them from; there is no such anchor for
 * an upper bat, so the disk pivot is used directly. What is still this port's is
 * the bat's own geometry — length 45, boss 5, tip 1, taper 6, from
 * pkg/flipdat1.bin — and its elasticity, and those are shared with the lower
 * bats: there is no mini-flipper art in the package, flipdat1 holds 109 poses of
 * ONE 45 px bat, and the record carries no length field.
 */
function upperFlipper(tableId: TableId): FlipperConfig {
  const record = UPPER_FLIPPER_RECORDS[tableId];
  const mirrored = record.role === "right";
  return {
    id: "upper",
    role: record.role,
    pivotX: pixelsToQ10(record.pivotXPixels),
    pivotY: pixelsToQ10(record.pivotYPixels),
    restAngle: poseToAngleUnits(record.restPose),
    sweep: record.sweepPoses * BAT_ANGLE_UNITS_PER_POSE,
    // Whether the poses count up or down IS the handedness, and it agrees with
    // the key binding on all three records.
    direction: mirrored ? 1 : -1,
    length: pixelsToQ10(FLIPPER_LENGTH_PIXELS),
    bossRadius: pixelsToQ10(FLIPPER_BOSS_RADIUS_PIXELS),
    tipRadius: pixelsToQ10(FLIPPER_TIP_RADIUS_PIXELS),
    taperStart: pixelsToQ10(FLIPPER_TAPER_START_PIXELS),
    upAcceleration: record.upAcceleration,
    upMaxRate: record.upMaxRate,
    downAcceleration: record.downAcceleration,
    downMaxRate: record.downMaxRate,
    surface: FLIPPER_SURFACE,
    level: record.level,
    confidence: "measured",
  };
}

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
    upAcceleration: FLIPPER_UP_ACCELERATION,
    upMaxRate: FLIPPER_UP_MAX_RATE,
    downAcceleration: FLIPPER_DOWN_ACCELERATION,
    downMaxRate: FLIPPER_DOWN_MAX_RATE,
    surface: FLIPPER_SURFACE,
    // Both lower bats are on the main playfield on all three tables: their
    // records' +0x1C bank pointers are hunk2+0, the same bank, and they sit on
    // the drain row where there is no raised level at all.
    level: 0,
    // The pivot, the sweep and both stroke rates are read off the table
    // package now. What is still this port's own is the REST BEARING and the
    // bat's elasticity, so the configuration as a whole is not yet "measured".
    confidence: "inferred",
  };
}

/** The flippers this table is played with: two lower bats and one upper. */
export function flipperConfigsFor(tableId: TableId): readonly FlipperConfig[] {
  const columns = LOWER_FLIPPER_PIVOT_COLUMNS[tableId];
  return Object.freeze([
    lowerFlipper("lower-left", "left", columns.left, LOWER_FLIPPER_PIVOT_ROW),
    lowerFlipper("lower-right", "right", columns.right, LOWER_FLIPPER_PIVOT_ROW),
    upperFlipper(tableId),
  ]);
}

/**
 * TRUE ON EVERY TABLE since round 5. Each of the three ships one active upper
 * bat in its flipper array — see `UPPER_FLIPPER_RECORDS` for the twelve records
 * and for the base offset that used to hide two of them.
 */
export function hasUpperFlipper(_tableId: TableId): boolean {
  return true;
}

/** Rejects a configuration that could not produce a sane stroke. */
export function validateFlipperConfig(config: FlipperConfig): FlipperConfig {
  if (!Number.isInteger(config.sweep) || config.sweep <= 0) {
    throw new RangeError(`flipper sweep must be a positive whole number: ${config.sweep}`);
  }
  if (config.sweep >= BAT_ANGLE_UNITS_PER_TURN) {
    throw new RangeError(`flipper sweep must be under one turn: ${config.sweep}`);
  }
  for (const [field, value] of [
    ["upAcceleration", config.upAcceleration],
    ["upMaxRate", config.upMaxRate],
    ["downAcceleration", config.downAcceleration],
    ["downMaxRate", config.downMaxRate],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`flipper ${field} must be a positive whole number: ${value}`);
    }
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
 * Where the bat is in its stroke, and how fast it is turning.
 *
 * `stroke` is 0 at rest and `config.sweep` fully flipped, in BAT angle units,
 * and cannot leave that range, so no caller has to wrap it. `rate` is the
 * angular velocity in bat units per STEP, four steps to a tick, signed with
 * positive meaning "toward flipped".
 *
 * THE RATE IS REAL STATE AND NOT DERIVABLE FROM THE STROKE. The original carries
 * the angular velocity across a reversal — release the button mid-stroke and the
 * spring has to cancel the coil's momentum before the bat starts back — so two
 * bats at the same angle are not in the same condition. It is the field that
 * makes a stab of the button different from a hold, and this port had neither it
 * nor the acceleration that needs it.
 */
export interface FlipperState {
  readonly stroke: number;
  readonly rate: number;
}

export const FLIPPER_AT_REST: FlipperState = Object.freeze({ stroke: 0, rate: 0 });

/**
 * The bat's angle on the 2048-unit bearing scale the geometry uses.
 *
 * Integer division rather than rounding, so the conversion is a pure function of
 * the integers: the full 1152-unit sweep lands on 307 of 2048, i.e. 53.96
 * degrees against the measured 54, and the fifth of a unit that is lost is a
 * fortieth of a pixel at the tip.
 */
export function batAngleToBearing(units: number): number {
  return Math.trunc((units * ANGLE_UNITS_PER_TURN) / BAT_ANGLE_UNITS_PER_TURN);
}

/**
 * One tick of one flipper: where the bat started, where it ended, and which bat
 * it was. Returned as a unit so a caller cannot advance the state and then
 * resolve contacts against a stale or mismatched starting pose.
 */
export interface FlipperSweep {
  readonly config: FlipperConfig;
  readonly from: FlipperState;
  readonly to: FlipperState;
  /**
   * The bat's state after each of the four steps of this tick, oldest first.
   *
   * Real state rather than a debugging convenience: the original resolves a
   * collision pass BETWEEN every pair of steps, so the rate a ball meets is the
   * rate the bat carries at that step and not the one it ends the tick with. A
   * tick of a fresh stroke runs at 20, 40, 60 and 80 bat units, a factor of four
   * across a single frame, and collapsing that to one number is exactly what
   * removed the flipper's timing gradient.
   */
  readonly steps: readonly FlipperState[];
}

/**
 * Advances one flipper by a tick: FOUR steps of the measured stroke.
 *
 * `held` is the state of the button at the end of the tick. A press and release
 * inside the same tick is not special-cased: unlike the plunger, whose whole
 * behaviour is the length of a hold, a flipper that never spent a sample point
 * down never moved the bat, and pretending otherwise would let a key that
 * bounced fire a shot.
 *
 * The step is the original's, in the original's order — POSITION FIRST, then the
 * rate — so the first step of a stroke moves the bat by whatever it was already
 * doing and not by the coil. That order is what makes the up-stroke take
 * fourteen steps rather than thirteen, and it is the reason a bat cannot jump on
 * the tick the button goes down.
 *
 * Hitting either end clamps the angle and kills the rate, exactly as +0x00BD90
 * and +0x00BD9C do. There is no bounce off the stops.
 */
export function tickFlipper(
  config: FlipperConfig,
  state: FlipperState,
  held: boolean,
): FlipperSweep {
  let stroke = state.stroke;
  let rate = state.rate;
  const steps: FlipperState[] = [];
  for (let step = 0; step < FLIPPER_STEPS_PER_TICK; step += 1) {
    stroke += rate;
    // The far stop is INCLUSIVE going up and EXCLUSIVE coming back, which reads
    // like a typo and is not: the original's up path continues only while
    // `angle > limit` (+0x00BD98 `cmp.w d2,d1 / bgt`) and its down path while
    // `angle >= limit` (+0x00BDDA `cmp.w d4,d3 / bge`). That one bit of
    // asymmetry is what lets a bat sitting on the stop start back down at all —
    // reaching a stop also SKIPS the acceleration (`clr.w $10(a0)` then a branch
    // past it), so a symmetric test would weld the bat to the top of its stroke.
    const stopped = held ? stroke >= config.sweep : stroke > config.sweep;
    if (stopped) {
      stroke = config.sweep;
      rate = 0;
      steps.push({ stroke, rate });
      continue;
    }
    // The near stop, and `<= 0` rather than `< 0` because of what the per-step
    // rates made visible: a bat parked at rest with the button up used to be
    // given -30 on every first step and clamped back on the second, so it
    // reported a live rate while standing still. It never moved and the end of
    // the tick was identical, but the rate is now real state that a contact
    // reads, and a bat leaning on its own stop must not impart anything.
    if (stroke <= 0 && !held) {
      stroke = 0;
      rate = 0;
      steps.push({ stroke, rate });
      continue;
    }
    rate = held
      ? Math.min(config.upMaxRate, rate + config.upAcceleration)
      : Math.max(-config.downMaxRate, rate - config.downAcceleration);
    steps.push({ stroke, rate });
  }
  return {
    config,
    from: state,
    to: stroke === state.stroke && rate === state.rate ? state : { stroke, rate },
    steps,
  };
}

/** The bat's bearing at a stroke, normalised into 0..2047. */
export function flipperAngle(config: FlipperConfig, state: FlipperState): number {
  return normalizeAngle(config.restAngle + config.direction * batAngleToBearing(state.stroke));
}

/**
 * BEARING units the bat turned through this tick, signed — the 2048 scale, not
 * the bat's own, because this is what the impulse and the pose sampling take.
 *
 * Computed as the difference of the two converted bearings rather than by
 * converting the difference, so that it is exactly the arc the poses sampled
 * between `from` and `to` and a tick can never report motion the renderer did
 * not draw.
 *
 * `| 0` because a bat that did not move on a left flipper otherwise reports -0,
 * which compares equal to 0 under `===` but not under `Object.is`, and this
 * value ends up in replay records where the two must not be distinguishable.
 */
export function sweptAngle(sweep: FlipperSweep): number {
  const from = batAngleToBearing(sweep.from.stroke);
  const to = batAngleToBearing(sweep.to.stroke);
  return (sweep.config.direction * (to - from)) | 0;
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
 * `fromX`/`fromY` are the last position the ball was OUTSIDE the bat at — the
 * previous sample of the swept resolve — and they carry the one fact the
 * geometry alone cannot: which side the ball came from. When a fast ball's
 * sample lands past the bat's axis, the nearest-point normal reads off the far
 * face, and resolving with it is exactly the wrong-side ejection that B1
 * documented (161 bat-crossings-while-raised in 80 games, all through this
 * seam). If the geometric normal disagrees with the approach side, the normal
 * is overridden to the approach side's face and the penetration is measured
 * through the axis, so `separate` always pushes the ball back out the way it
 * came in — never through.
 *
 * The degenerate case — a ball centre exactly on the bat's axis — has no normal
 * to read off the geometry either, and takes the approach side too; with no
 * approach side available it falls back to the face the bat sweeps toward, as
 * before.
 */
function touchAt(
  config: FlipperConfig,
  angle: number,
  ballX: Q10,
  ballY: Q10,
  ballRadius: Q10,
  fromX: Q10 = ballX,
  fromY: Q10 = ballY,
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
  // STRICTLY OUTSIDE is not touching; EXACTLY ON THE BOUNDARY IS.
  //
  // This used to be `>=`, and `separate()` below lifts a ball out by exactly its
  // penetration — which lands it at distance == touchDistance, i.e. the one
  // distance the old test called "not touching". A ball a bat had just pushed
  // was therefore invisible to the bat on the NEXT tick, by construction. The
  // lower bats hid it because gravity pulls a cradled ball back inside the
  // capsule every tick; a raised upper bat, whose ball is held from below by the
  // map, does not. Two measured consequences, both closed by the one character:
  //
  //   - Extreme Sports' upper bat at full stroke moved a ball at (184,181)L1 to
  //     (184.124, 180.721) and then reported ZERO contacts there, so the ball
  //     search saw a cradle as a strand and pulsed its coils at it.
  //   - Law 'n Justice's upper bat sits 13 px — boss 5 plus ball 8, exactly the
  //     touch distance — from a notch at (25,307) between the rubber post at
  //     (23-24,305-307) and the top of the level-0 boundary wall at (25,308). A
  //     ball pressed into it was at distance exactly 13.0 and so could neither
  //     be seen as cradled NOR be struck by the bat sweeping past it. Three of
  //     270 census balls ended up there.
  if (distanceSquared > touchDistance * touchDistance) return null;

  // The bat's perpendicular, unit length because the axis is: the reference
  // both side tests below are signed against.
  const perpX = -axisY | 0;
  const perpY = axisX;
  // Which side of the axis the ball approached from: the sign of the last
  // outside position's perpendicular offset. Zero when unknown (no swept
  // history, or a start dead on the axis).
  const fromPerp =
    q10Multiply(fromX - config.pivotX, perpX) + q10Multiply(fromY - config.pivotY, perpY);
  const fromSide = fromPerp > 0 ? 1 : fromPerp < 0 ? -1 : 0;

  const distance = integerSqrt(distanceSquared);
  let normalX: number;
  let normalY: number;
  let penetration = touchDistance - distance;
  if (distance === 0) {
    if (fromSide !== 0) {
      normalX = (fromSide * perpX) | 0;
      normalY = (fromSide * perpY) | 0;
    } else {
      normalX = (-config.direction * axisY) | 0;
      normalY = (config.direction * axisX) | 0;
    }
  } else {
    normalX = roundHalfAwayFromZero((offsetX * Q10_ONE) / distance) | 0;
    normalY = roundHalfAwayFromZero((offsetY * Q10_ONE) / distance) | 0;
    if (fromSide !== 0) {
      const normalPerp = q10Multiply(normalX, perpX) + q10Multiply(normalY, perpY);
      const normalSide = normalPerp > 0 ? 1 : normalPerp < 0 ? -1 : 0;
      if (normalSide !== 0 && normalSide !== fromSide) {
        // The sample crossed the axis between two probes: resolve against the
        // face the ball came from, and push it back through the axis.
        const ballPerp = q10Multiply(offsetX, perpX) + q10Multiply(offsetY, perpY);
        normalX = (fromSide * perpX) | 0;
        normalY = (fromSide * perpY) | 0;
        penetration = touchDistance - fromSide * ballPerp;
      }
    }
  }

  return {
    normalX,
    normalY,
    penetration,
    armX: (nearestX + q10Multiply(batRadius, normalX) - config.pivotX) | 0,
    armY: (nearestY + q10Multiply(batRadius, normalY) - config.pivotY) | 0,
    along,
  };
}

/**
 * Poses to sample inside ONE step of the stroke.
 *
 * The tick is already divided into the original's own four steps, and at the
 * coil's cap of 120 bat units a step the tip covers 4.4 px — barely half a ball.
 * So this is one on the shipped bats and exists for the same reason
 * `substepsFor` did: a longer or faster bat must not be able to step its tip
 * over a ball, and the count is derived from the configuration rather than
 * chosen.
 */
export function substepsPerStrokeStep(
  config: FlipperConfig,
  ballRadius: Q10 = DEFAULT_PROBE_RADIUS,
): number {
  const fastest = batAngleToBearing(config.upMaxRate);
  const tipTravel = Math.abs(tangentialSpeed(config.length, fastest));
  return Math.max(1, Math.ceil(tipTravel / ballRadius));
}

/**
 * Poses sampled across a whole tick: the four steps, each subdivided.
 *
 * The subdivision used to be derived from the tick's total turn and was not
 * aligned to anything; it is now the original's own four collision passes, so a
 * sampled pose and the rate that goes with it are the same pair the machine had.
 */
export function substepsFor(config: FlipperConfig, ballRadius: Q10 = DEFAULT_PROBE_RADIUS): number {
  return FLIPPER_STEPS_PER_TICK * substepsPerStrokeStep(config, ballRadius);
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
  /**
   * Bat angle units per step the ball took out of the bat, +0x00AED0's
   * `lsr.w #1,d3`. Zero when the bat imparted nothing.
   *
   * Reported rather than applied here because a contact is resolved against a
   * sweep, which is immutable; `applyFlipperReactions` is what puts it back into
   * the bank. Without the write-back the second ball of a multiball gets the
   * same stroke as the first, which the original does not give it.
   */
  readonly rateTaken: number;
}

// The original's own clamp, +-4095 of its velocity units. See `timebase.ts`.
// It matters here in a way it never did before: the measured stroke puts the tip
// at 17.7 px a tick and the clamp is 16, so a tip strike is the one impulse in
// the game that the machine's own limiter actually catches.
const VELOCITY_LIMIT = VELOCITY_CLAMP_Q10;

function clampVelocity(value: number): number {
  return q10Clamp(Math.trunc(value), -VELOCITY_LIMIT, VELOCITY_LIMIT);
}

/** The last position a ball was at before this tick's step, for the sweep. */
export interface BallStart {
  readonly x: Q10;
  readonly y: Q10;
}

/**
 * Resolves every ball against every flipper for one tick.
 *
 * Runs AFTER `stepBalls`: the bats guard the drain, and a ball must be given its
 * chance to be saved at the position it actually reached this tick rather than
 * the one it started from.
 *
 * `starts` is where each ball BEGAN the tick, keyed by ball id, and it is what
 * makes the contact test SWEPT rather than endpoint-only. This used to test only
 * the end-of-tick position, and that was the reconstruction's #1 defect (B1): a
 * ball at 9–16 px/tick crosses the whole bat capsule inside one tick, the
 * end-of-tick sample sits past the axis, the nearest-point normal reads off the
 * far face, and the "already leaving" guard then waves it through — 161
 * bat-crossings-while-raised in 80 census games, all through that seam. With
 * `starts`, the ball's motion segment is sampled once per collision pass
 * (matching the original, which tests the bat 4x per frame with at most ~4 px of
 * ball motion between tests — main.seg00 $A618's pass structure), each sample
 * against the pose the bat holds at that pass, and the FIRST approaching touch
 * resolves AT THE CROSSING POINT. Sample spacing (≤4 px of ball travel + ≤4.4 px
 * of tip travel) is well under the thinnest inflated capsule (ball 8 + tip 1 =
 * 9 px each side), so no motion the clamp permits can step over the bat.
 *
 * Callers that pass no `starts` get the endpoint test, which is still right for
 * a ball that did not move (unit harnesses that advance balls by hand).
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
  starts: ReadonlyMap<number, BallStart> | null = null,
): readonly FlipperContact[] {
  const contacts: FlipperContact[] = [];
  for (const ball of balls) {
    if (!ball.active) continue;
    for (const sweep of sweeps) {
      // THE LEVEL GATE. A bat's pixels are on one collision level, and a ball
      // riding the other one passes under or over it untouched. This was
      // harmless while every bat was at the drain — there is no raised
      // playfield down there — and became load-bearing the moment BabeWatch's
      // (205,115) and Extreme Sports' (182,194) upper bats were wired: both sit
      // over main-level playfield a ball rolls across.
      if (sweep.config.level !== ball.level) continue;
      const contact = resolveOne(
        ball,
        sweep,
        ballRadius,
        clamp,
        restThreshold,
        starts?.get(ball.id) ?? null,
      );
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
  start: BallStart | null,
): FlipperContact | null {
  const { config } = sweep;
  const inner = substepsPerStrokeStep(config, ballRadius);
  const startX = start?.x ?? ball.x;
  const startY = start?.y ?? ball.y;
  const deltaX = ball.x - startX;
  const deltaY = ball.y - startY;
  const total = sweep.steps.length * inner;

  let previous = sweep.from;
  // The last sample the ball was NOT touching at: the side reference for
  // `touchAt`, so the resolved face is always the one the ball came from.
  let freeX = startX;
  let freeY = startY;
  let sampled = 0;
  for (const end of sweep.steps) {
    const span = end.stroke - previous.stroke;
    for (let sample = 1; sample <= inner; sample += 1) {
      sampled += 1;
      // Truncated rather than rounded so the samples advance monotonically and
      // the last one is exactly the pose the step ended on.
      const stroke = previous.stroke + Math.trunc((span * sample) / inner);
      const angle = flipperAngle(config, { stroke, rate: end.rate });
      // The ball's position at this pass: the tick's displacement is spent
      // one collision pass at a time, exactly as the original interleaves the
      // bat's animation with the integrator's sub-steps.
      const sampleX = (startX + Math.trunc((deltaX * sampled) / total)) | 0;
      const sampleY = (startY + Math.trunc((deltaY * sampled) / total)) | 0;
      const touch = touchAt(config, angle, sampleX, sampleY, ballRadius, freeX, freeY);
      if (touch === null) {
        freeX = sampleX;
        freeY = sampleY;
        continue;
      }

      // The bat's surface velocity at the touched point, in BEARING units per
      // tick: four steps of the rate this step carried. Used for the gate and
      // for what the contact reports, never for the impulse's size.
      const turnPerTick = config.direction * batAngleToBearing(end.rate * FLIPPER_STEPS_PER_TICK);
      const surfaceX = -tangentialSpeed(touch.armY, turnPerTick);
      const surfaceY = tangentialSpeed(touch.armX, turnPerTick);

      const approachSpeed =
        q10Multiply(ball.velocityX - surfaceX, touch.normalX) +
        q10Multiply(ball.velocityY - surfaceY, touch.normalY);

      // A mid-path touch the ball is already LEAVING is not resolved there:
      // pulling the ball back to a graze it was departing from would cost it
      // most of a tick of travel for a contact that changes nothing. The final
      // sample still resolves whatever it finds — that is the endpoint test
      // this function has always run, and it is what keeps a ball that ends
      // the tick embedded in the bat separated rather than left inside it.
      if (approachSpeed >= 0 && sampled < total) continue;

      // Resolve AT THE CROSSING POINT: the ball is placed at the sample that
      // first met the bat, not at wherever the map integration finished. The
      // discarded remainder of the tick is at most one pass's travel — the
      // same granularity the original loses between its own collision passes.
      //
      // CLAMPED, like `separate()` below and for the same reason: this is a
      // positional write with no collision test of its own, and on a bat whose
      // capsule overlaps the collision line — Law 'n Justice's upper-left one —
      // it can put the ball's centre inside a wall just as surely as the
      // separation can. Round 5 left both unclamped and the two together drove
      // 10.7% of at-rest balls near that bat through a 2 px boundary into the
      // off-playfield shaft behind it.
      moveTo(ball, sampleX, sampleY, clamp);

      // THE GATE, +0x00AEAC and the eight octant masks at $B036+0x3C*n: the bat
      // imparts only when it is sweeping toward the face the ball is on. A rate
      // of zero fails it outright, which is the `beq -> rts`.
      const facing =
        q10Multiply(surfaceX, touch.normalX) + q10Multiply(surfaceY, touch.normalY);
      let rateTaken = 0;
      if (end.rate !== 0 && facing > 0) {
        const dx = Math.trunc(Math.abs(ball.x - config.pivotX) / Q10_ONE);
        const dy = Math.trunc(Math.abs(ball.y - config.pivotY) / Q10_ONE);
        rateTaken = Math.min(Math.abs(end.rate), flipperRateTaken(dx, dy));
        // The rate AFTER the ball has taken its share, which is what the impulse
        // is computed from: +0x00AED2..+0x00AEE4 writes the reduced rate back
        // before +0x00AEF0 even looks at the magnitude. Signed the way the
        // ORIGINAL signs it — the disk's left bat runs its coil at -120 and its
        // right at +120, which this port folds into `direction`.
        const driven = (Math.abs(end.rate) - rateTaken) * (config.direction * end.rate < 0 ? -1 : 1);
        const magnitude = flipperImpulseMagnitude(dx, dy);
        // WHY THERE IS NO FACTOR OF TWO HERE and the sub-handlers have one. The
        // rotation into the contact frame at +0x00B4FE multiplies by tables
        // scaled to 2^14 and takes `(x << 3) >> 16`, i.e. it DOUBLES both
        // components, and the inverse at +0x00B666 halves them again. The
        // handlers' `magnitude * 2 * rate` and `8 * 2 * rate` are written into
        // that doubled frame, so the impulse a ball actually receives is
        // `magnitude * rate` outward and `8 * rate` along the surface. Missing
        // the doubling puts every flipper shot at twice the machine's own
        // velocity clamp, where the whole bat saturates and nothing has range.
        const normal = originalVelocityToQ10(magnitude * Math.abs(driven));
        const tangent = originalVelocityToQ10(ORIGINAL_IMPULSE_TANGENT * driven);
        // The normal is always outward — the sub-handlers negate `d2` on
        // whichever branch keeps `$1c` negative, and +0x00B550's `tst.w d0 /
        // ble` shows the frame's first axis points INTO the surface. The tangent
        // runs along `(normalY, -normalX)` and its sign is the bat's own rotation
        // sign and NOT a projection: the bat's surface velocity is perpendicular
        // to the arm and the arm runs down the bat's axis, so the surface
        // velocity is almost entirely along the NORMAL and its along-face
        // component is numerical noise that no sign can be read off.
        //
        // The consequence, which is worth stating because it is testable: both
        // bats deflect the ball toward their own pivot, by `atan(8/M)` — about
        // 32 degrees at the boss and 13 at the tip. The two are exact mirrors,
        // which is the check that the handedness above is not inverted.
        ball.velocityX = clampVelocity(
          ball.velocityX +
            q10Multiply(normal, touch.normalX) +
            q10Multiply(tangent, -touch.normalY),
        );
        ball.velocityY = clampVelocity(
          ball.velocityY +
            q10Multiply(normal, touch.normalY) +
            q10Multiply(tangent, touch.normalX),
        );
      }

      // Then the ordinary bounce, in the WORLD frame — the original has no bat
      // frame, and `reflectVelocity` returns untouched when the ball is already
      // leaving, which is exactly the `tst.w d0 / ble` that skips the bounce at
      // +0x00B550 once the kick above has sent the ball outward. A bat standing
      // still reaches this with nothing added and behaves as it always has.
      reflectVelocity(ball, config.surface, touch.normalX, touch.normalY, restThreshold);

      separate(ball, touch, clamp);

      const batSpeed = tangentialSpeed(
        integerSqrt(touch.armX * touch.armX + touch.armY * touch.armY),
        turnPerTick,
      );
      return {
        ballId: ball.id,
        flipperId: config.id,
        normalX: touch.normalX,
        normalY: touch.normalY,
        along: touch.along,
        batSpeed,
        approachSpeed,
        struck: end.rate !== 0 && facing > 0,
        rateTaken,
      };
    }
    previous = end;
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
  // Exactly the penetration, which lands the ball ON the capsule boundary. That
  // is a TOUCH — see `touchAt`, whose test is strict — so the bat still sees the
  // ball it has just separated on the next tick and can strike it.
  const deltaX = q10Multiply(touch.penetration, touch.normalX);
  const deltaY = q10Multiply(touch.penetration, touch.normalY);
  if (deltaX === 0 && deltaY === 0) return;
  moveBy(ball, deltaX, deltaY, clamp);
}

/** Moves a ball by an offset, as far as the map allows. */
function moveBy(ball: BallState, deltaX: Q10, deltaY: Q10, clamp: PushClamp | null): void {
  if (clamp === null) {
    ball.x = (ball.x + deltaX) | 0;
    ball.y = (ball.y + deltaY) | 0;
    return;
  }
  const placed = clamp(ball, deltaX, deltaY);
  ball.x = placed.x;
  ball.y = placed.y;
}

/** Moves a ball TO a point, as far as the map allows. */
function moveTo(ball: BallState, x: Q10, y: Q10, clamp: PushClamp | null): void {
  moveBy(ball, (x - ball.x) | 0, (y - ball.y) | 0, clamp);
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

/**
 * Puts the angular momentum the balls took back into the bank.
 *
 * MEASURED: +0x00AED2..+0x00AEE4 reduces the bat's rate toward zero by half the
 * raw impulse-table entry and writes it to $10(a0) DURING the collision pass, so
 * the rest of the stroke really is weaker for having hit something. The stroke
 * itself is untouched — only the rate — which is exactly what the original does
 * and is why a bat that has been loaded still reaches the top, just later.
 *
 * Returns the bank unchanged, by identity, when nothing was taken: a tick that
 * hit nothing must not allocate.
 */
export function applyFlipperReactions(
  bank: FlipperBank,
  contacts: readonly FlipperContact[],
): FlipperBank {
  let taken: Map<string, number> | null = null;
  for (const contact of contacts) {
    if (contact.rateTaken <= 0) continue;
    taken ??= new Map<string, number>();
    taken.set(contact.flipperId, (taken.get(contact.flipperId) ?? 0) + contact.rateTaken);
  }
  if (taken === null) return bank;

  const states = new Map<string, FlipperState>();
  for (const config of bank.configs) {
    const state = bank.states.get(config.id) ?? FLIPPER_AT_REST;
    const loss = taken.get(config.id) ?? 0;
    if (loss === 0 || state.rate === 0) {
      states.set(config.id, state);
      continue;
    }
    const magnitude = Math.max(0, Math.abs(state.rate) - loss);
    states.set(config.id, { stroke: state.stroke, rate: state.rate < 0 ? -magnitude : magnitude });
  }
  return { configs: bank.configs, states };
}

/**
 * Button state built from the abstract control names the input layer uses.
 *
 * The upper bat takes THE SAME BOOLEAN as the lower bat on its side, because
 * that is what its record's key word says and there is no third button on the
 * machine: `cmpi.w #0,$A(a0)` at main.seg00 +0xBD6C routes the record to the
 * right-button test or the left one and to nothing else. Law 'n Justice's upper
 * bat is bound LEFT; BabeWatch's and Extreme Sports' are bound RIGHT.
 */
export function flipperInputFrom(
  left: boolean,
  right: boolean,
  upperRole: FlipperRole = "left",
): FlipperInput {
  return new Map<string, boolean>([
    ["lower-left", left],
    ["lower-right", right],
    ["upper", upperRole === "right" ? right : left],
  ]);
}
