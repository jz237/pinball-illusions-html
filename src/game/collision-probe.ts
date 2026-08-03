/**
 * The collision probe: ONE ring, ONE ball-versus-map test, used by everything.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS THE ONLY PROBE
 * ---------------------------------------------------------------------------
 * There used to be two. A private ring inside `ball-physics.ts` drove the
 * simulation while this module exported a second one that nothing under `src/`
 * imported, and the two disagreed about the ball's radius (8 px versus 4), about
 * how many points the ring has (44 versus 24), about which touched material
 * dominates (most deflecting versus bounciest) and about whether the rows past
 * the bottom of the bitmap are solid (they are not — that is the drain). So
 * `ContactPoint.ringIndex` and `.angle` meant different things depending on
 * which function produced the record, and a device layer that imported the
 * unused one would have got a ball of half the radius that bounced off the
 * bottom of the map instead of draining.
 *
 * The simulation's version won on every point of disagreement, because it is the
 * one that was actually exercised against the shipped maps. It now lives here
 * and `ball-physics.ts` imports it. Nothing else may define a probe ring.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CONTACT MODEL LOOKS LIKE THIS
 * ---------------------------------------------------------------------------
 * `materials.ts` establishes that the disk data carries a single solid/not-solid
 * bit per pixel and no surface normals at all. A normal therefore has to be
 * recovered from geometry, and the original's way is to sample a ring of points
 * around the ball centre and average the directions of the ones that landed in
 * solid material. That mean points at the obstruction, so the surface normal is
 * its opposite. Reconstructing that shape rather than a modern swept-circle
 * solver is what keeps the bounces feeling like the 1995 game.
 *
 * THE MEAN IS AN ARITHMETIC MEAN OF TABULATED ANGLES, NOT A MEAN OF VECTORS.
 * That distinction is the whole of `meanContactAngle`, and it is the machine's:
 * the ring evaluator at +0x00A9C4..+0x00AD04 adds up the bearings of the set
 * points as plain 16-bit numbers, applies ONE wrap correction on ONE of three
 * quadrant patterns, and divides. This port summed unit vectors instead and
 * snapped the result back onto a ring entry, which agrees with the machine on
 * any ordinary single-face contact and disagrees — often wildly — the moment
 * the ring straddles two surfaces.
 *
 * CENSUS: all three shipped maps, both level views, every ball centre standing
 * in passable material whose ring touches something — 437,581 positions. The
 * gap is measured against the vector mean's EXACT direction, which is what the
 * responder was handed, not against its snapped report:
 *
 *     one contiguous arc, < 4 quadrants   179,001 positions   worst 4 units, NONE >= 8
 *     two or more separate arcs           236,752             91,429 differ >= 8
 *     an arc spanning all four quadrants   21,828             21,108 differ >= 8
 *     the two agree within one unit       292,781 = 66.9%
 *     vector sum cancelled exactly            676  (the old rule had no answer at all)
 *
 * FOR ANY ORDINARY SINGLE-FACE CONTACT THE TWO RULES ARE THE SAME RULE, to
 * within 0.7 degrees. They part company only where the ring straddles two
 * surfaces — a corridor, a corner, a wedge — which is exactly where a ball gets
 * stuck, so that is where the difference was being paid.
 *
 * THE RING MUST BE GAPLESS. The bit-0 collision layer is a ONE PIXEL outline
 * (see materials.ts): Law 'n Justice alone has 41 horizontal and 11 vertical
 * 1-px solid runs. A ring built by rounding N evenly spaced unit vectors does
 * not sample every integer offset — at radius 8 with 32 entries the components
 * are only {0, +-2, +-3, +-4, +-6, +-7, +-8}, so a 1-px wall at offset +-1 or
 * +-5 is INVISIBLE and the ball freezes against a wall it cannot feel. The ring
 * is therefore a midpoint/Bresenham circle: an 8-connected chain whose integer
 * offsets cover every value from -r to +r on both axes. Angles are derived from
 * each point's actual offset rather than from an assumed even spacing, because
 * the points are not evenly spaced.
 *
 * ---------------------------------------------------------------------------
 * UNITS
 * ---------------------------------------------------------------------------
 * Angles are in the original's 2048-units-per-revolution scale, not radians: one
 * turn is 2048, so a unit is about 0.176 degrees and every angle fits a u16.
 * Angle 0 points along +x (right) and angles increase toward +y, which is DOWN
 * the screen, because the playfield bitmap is stored top row first.
 *
 * There is no runtime trigonometry: `Math.sin`, `Math.cos` and `Math.atan2` are
 * not correctly rounded and their last bits are implementation-defined, which
 * would put replay parity at the mercy of the host engine. The ring is built
 * from integer square roots and the angles from a polynomial using only IEEE
 * `+ - * /`, all of which are correctly rounded and therefore bit-identical
 * everywhere.
 */

import type {
  ContactPoint,
  ContactResult,
  MaterialBehaviour,
  MaterialIndex,
  MaterialTable,
  TableMap,
} from "./contracts.js";
import type { Q10 } from "../core/fixed-point.js";
import { Q10_ONE, pixelsToQ10, q10ToPixel } from "../core/fixed-point.js";

/** One full revolution in the original's angle units. */
export const ANGLE_UNITS_PER_TURN = 2048;

/** Half a revolution: add this to a contact angle to get the outward normal. */
export const ANGLE_HALF_TURN = ANGLE_UNITS_PER_TURN / 2;

/** Angle units in a quarter turn: 512 on the 2048-unit scale. */
export const QUARTER_TURN_UNITS = ANGLE_UNITS_PER_TURN / 4;

const MATERIAL_INDEX_COUNT = 16;

/**
 * Ball radius in whole pixels, which is also the probe ring's radius.
 *
 * A 16 px ball on a 336x600 playfield is 4.8% of the width and 1/37th of the
 * height, which matches a 27 mm ball on a real table almost exactly. It is also
 * the radius `materials.ts` used when it measured which pixels a ball can
 * physically reach, so the two modules agree about what "reachable" means.
 */
export const BALL_RADIUS_PIXELS = 8;

/** The ball radius in Q10 — the default radius of every ring built here. */
export const DEFAULT_PROBE_RADIUS: Q10 = pixelsToQ10(BALL_RADIUS_PIXELS);

/** Bounds-checked reads, because `noUncheckedIndexedAccess` is on for good reason. */
export function numberAt(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`index ${index} out of range (length ${values.length})`);
  }
  return value;
}

export function flagAt(values: readonly boolean[], index: number): boolean {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`index ${index} out of range (length ${values.length})`);
  }
  return value;
}

/**
 * Integer square root by Newton's method; no `Math.sqrt`, so no last-bit
 * ambiguity. Lives here because the ring cannot be built without it; the ball
 * simulation borrows it for distances between ball centres.
 */
export function integerSqrt(value: number): number {
  if (value <= 0) return 0;
  let previous = value;
  let current = Math.floor((value + 1) / 2);
  while (current < previous) {
    previous = current;
    current = Math.floor((current + Math.floor(value / current)) / 2);
  }
  return previous;
}

/** `Math.round` breaks ties toward +Infinity; this one is sign-symmetric. */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Nearest integer to sqrt(squared), computed without leaving the integers. */
function roundedLeg(squared: number): number {
  const floor = integerSqrt(squared);
  // sqrt(v) >= floor + 1/2  <=>  v >= floor^2 + floor + 1/4  <=>  v >= floor^2 + floor + 1.
  return squared >= floor * floor + floor + 1 ? floor + 1 : floor;
}

/**
 * Wraps an angle into 0..2047.
 *
 * The `wrapped === 0` arm exists to turn -0 into +0; a negative zero angle would
 * otherwise leak into contact records and fail identity comparisons.
 */
export function normalizeAngle(angle: number): number {
  const wrapped = angle % ANGLE_UNITS_PER_TURN;
  if (wrapped < 0) {
    return wrapped + ANGLE_UNITS_PER_TURN;
  }
  return wrapped === 0 ? 0 : wrapped;
}

/**
 * Shortest signed turn from one angle to another, in -1024..1023.
 *
 * Exists so callers comparing angles never subtract them directly, which is the
 * same wrap bug that makes a naive mean of two contact angles point at the wall
 * instead of away from it.
 */
export function angleDelta(from: number, to: number): number {
  const difference = normalizeAngle(to - from);
  return difference > ANGLE_HALF_TURN ? difference - ANGLE_UNITS_PER_TURN : difference;
}

// ---------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------

/**
 * The probe ring for one radius, as parallel arrays in ring order.
 *
 * It used to carry a fifth array, `unitX`/`unitY`: the Q10 unit vector of each
 * entry, which the vector mean summed. Nothing sums vectors any more — the
 * machine adds `angle` values and takes `sineUnits`/`cosineUnits` of the result
 * — so the arrays went with the rule that needed them rather than staying on as
 * a second, slightly different answer to which way each entry points.
 */
export interface RingOffsets {
  /** Number of entries. Depends on the radius; it is not a fixed 32 or 24. */
  readonly size: number;
  /** Integer pixel offsets, ordered by angle from +x toward +y (screen down). */
  readonly dx: readonly number[];
  readonly dy: readonly number[];
  /** Angle of each entry in the 2048-unit scale, derived from its actual offset. */
  readonly angle: readonly number[];
}

const RING_CACHE = new Map<Q10, RingOffsets>();

/**
 * Ring offsets in whole pixels for one radius. Cached: the radius rarely
 * changes, and the build must stay deterministic anyway.
 */
export function ringOffsetsFor(radius: Q10 = DEFAULT_PROBE_RADIUS): RingOffsets {
  const cached = RING_CACHE.get(radius);
  if (cached !== undefined) return cached;
  const built = buildRing(radius);
  RING_CACHE.set(radius, built);
  return built;
}

/**
 * The quarter arc from (r, 0) up to but not including (0, r), ordered by angle.
 *
 * Both midpoint passes are taken — y = round(sqrt(r^2 - x^2)) for every x AND
 * x = round(sqrt(r^2 - y^2)) for every y — which is what makes the chain
 * 8-connected and, crucially here, what makes every integer offset from 0 to r
 * appear on BOTH axes. One pass alone skips offsets (at r = 8 the x-pass never
 * produces dy = 1, 2 or 3) and a 1-px wall parked on a skipped offset is
 * invisible to the ball.
 *
 * The ordering compares cross products, so no trigonometry decides it; two
 * entries can never tie because all of them lie within half a pixel of the same
 * circle and equal directions would then have to be the same point.
 */
function firstQuadrantArc(radius: number): readonly { readonly x: number; readonly y: number }[] {
  const seen = new Set<number>();
  const points: { x: number; y: number }[] = [];
  const stride = radius + 1;
  const add = (x: number, y: number): void => {
    const key = x * stride + y;
    if (seen.has(key)) return;
    seen.add(key);
    points.push({ x, y });
  };

  const squared = radius * radius;
  for (let k = 0; k <= radius; k += 1) {
    const leg = roundedLeg(squared - k * k);
    add(leg, k);
    add(k, leg);
  }

  points.sort((a, b) => a.y * b.x - b.y * a.x || b.x - a.x);
  // (0, radius) is the first point of the next quadrant, and it is the only
  // entry with x = 0; dropping it here keeps the four quadrants disjoint.
  return points.filter((point) => point.x !== 0);
}

/**
 * atan(ratio) in radians for ratio in [0, 1], to the last bit of a double.
 *
 * Euler's arctangent series,
 *
 *     atan(t) = t / (1 + t^2) * SUM c_n u^n,
 *     u = t^2 / (1 + t^2),   c_0 = 1,   c_n = c_(n-1) * 2n / (2n + 1),
 *
 * which uses only IEEE `+ - * /` — every one correctly rounded, so the sum is
 * bit-identical on every engine, where `Math.atan2` is not — and whose terms
 * shrink by at least a half each step over the whole first octant (u <= 1/2).
 * Measured against `Math.atan2` over every integer offset in a 41x41 block:
 * worst disagreement 4.5e-13 angle units.
 *
 * IT REPLACED A THREE-TERM POLYNOMIAL, AND THAT WAS A CORRECTNESS FIX. The old
 * approximation was worth about half an angle unit, which is exactly the size
 * that decides a rounding, and it left EIGHT of the ring's FORTY-FOUR angles one
 * unit away from the machine's own tabulated constants: entries 5, 6, 16, 17,
 * 27, 28, 38, 39 — the (6,5)/(5,6) family — read 227, 285, 739, 797, 1251,
 * 1309, 1763, 1821 where the disk holds 226, 286, 738, 798, 1250, 1310, 1762,
 * 1822 (`addi.w` immediates at +0x00AB72..+0x00AC7A and the two 32-entry blocks
 * at +0x00A804 / +0x00A8E4). Those constants are now SUMMED to make a contact
 * normal — see `meanContactAngle` — so a one-unit error in a tabulated angle is
 * a one-unit error in the answer, and it no longer averages out. All 44 now
 * equal `round(atan2(dy, dx) * 2048 / 2pi)` exactly, and the whole table is
 * pinned entry by entry in `collision-probe.test.ts`.
 *
 * The closest any of the 44 comes to a rounding tie is 0.033 units, twelve
 * orders of magnitude above this series' error, so the table would not move if
 * the series were improved again.
 */
function atanRadians(ratio: number): number {
  const denominator = 1 + ratio * ratio;
  const u = (ratio * ratio) / denominator;
  let term = 1;
  let sum = 1;
  // 80 terms is well past the point where `term` underflows the sum's last bit
  // at u = 1/2; the loop is bounded rather than tolerance-driven so its length
  // is a property of the code and not of the argument.
  for (let n = 1; n <= 80; n += 1) {
    term = (term * u * (2 * n)) / (2 * n + 1);
    sum += term;
  }
  return (ratio / denominator) * sum;
}

const RADIANS_TO_ANGLE_UNITS = ANGLE_UNITS_PER_TURN / (2 * Math.PI);

/**
 * The angle of an offset in the original's 2048-unit scale, y increasing
 * downward.
 *
 * Folded into the first octant and rounded there, then mirrored with exact
 * integer arithmetic, so the four quadrants stay perfect reflections of each
 * other and a mirrored trajectory reports mirrored contact angles.
 */
export function angleUnitsFor(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  const octant =
    ax >= ay
      ? atanRadians(ay / ax) * RADIANS_TO_ANGLE_UNITS
      : QUARTER_TURN_UNITS - atanRadians(ax / ay) * RADIANS_TO_ANGLE_UNITS;
  const first = Math.round(octant);

  const angle =
    dy >= 0
      ? dx >= 0
        ? first
        : ANGLE_HALF_TURN - first
      : dx >= 0
        ? ANGLE_UNITS_PER_TURN - first
        : ANGLE_HALF_TURN + first;
  return normalizeAngle(angle);
}

// ---------------------------------------------------------------------------
// Directions
// ---------------------------------------------------------------------------

/**
 * sin over the first quadrant, Q10, one entry per angle unit plus the endpoint.
 *
 * The 11th-order Taylor series is accurate to about 2e-9 over 0..pi/2, four
 * orders of magnitude finer than the Q10 quantum and three below the closest
 * approach any entry makes to a rounding tie (1.7e-4 at 1024 * sin), so the
 * table is the correctly rounded one and would not change if the polynomial
 * were improved. `i / 512` is exact (512 is a power of two) and everything after
 * it is a correctly rounded IEEE operation, so the table is identical on every
 * engine.
 *
 * THIS IS THE MACHINE'S OWN TABLE AT THIS PORT'S SCALE. The disk carries 2048
 * words of `round(16384 * sin(2*pi*i/2048))` at main.bin.seg01 file offset 0xBC,
 * reached through the two hunk-1 relocations at main.seg00 offsets 0xB4BC and
 * 0xB4C2, and the responder rotates the ball's velocity into and out of the
 * contact frame with it (+0x00B502, +0x00B666). The amplitude here is Q10
 * because that is the scale every vector in this port is written at, and the
 * amplitude cancels out of a rotation; `surface-physics.ts` carries the
 * measurement of what does NOT cancel, which is the responder's own constants.
 *
 * It used to live in `flippers.ts`, where the bat angles needed it. It moved
 * here when the contact normal became `cos`/`sin` of a mean bearing, because two
 * copies of a trigonometric table is two answers to "which way is 738".
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
 * quadrants are exact reflections and a mirrored trajectory reflects off a
 * mirrored normal. Zero is returned as +0: a negative zero here would survive
 * into a contact normal and fail identity comparisons.
 */
export function sineUnits(angle: number): Q10 {
  const wrapped = normalizeAngle(angle);
  const withinHalf = wrapped % ANGLE_HALF_TURN;
  const folded = withinHalf <= QUARTER_TURN_UNITS ? withinHalf : ANGLE_HALF_TURN - withinHalf;
  const magnitude = quarterSineAt(folded);
  if (magnitude === 0) return 0;
  return wrapped < ANGLE_HALF_TURN ? magnitude : -magnitude;
}

/** cos of an angle in 2048-unit form, as Q10. */
export function cosineUnits(angle: number): Q10 {
  return sineUnits(angle + QUARTER_TURN_UNITS);
}

/**
 * Builds the whole ring by rotating the quarter arc through 90 degrees four
 * times. Entry `i` and entry `i + size / 2` are therefore exact negations, so
 * the four quadrants report exactly mirrored bearings.
 */
function buildRing(radius: Q10): RingOffsets {
  const pixels = Math.max(1, Math.round(radius / Q10_ONE));
  const quadrant = firstQuadrantArc(pixels);

  const dx: number[] = [];
  const dy: number[] = [];
  for (let turn = 0; turn < 4; turn += 1) {
    for (const point of quadrant) {
      let px = point.x;
      let py = point.y;
      for (let rotation = 0; rotation < turn; rotation += 1) {
        const nextX = -py;
        py = px;
        px = nextX;
      }
      // `| 0` collapses the -0 that negating a zero component produces. It
      // makes no arithmetic difference, but a -0 in the table would compare
      // unequal to 0 under Object.is and could leak into a contact record.
      dx.push(px | 0);
      dy.push(py | 0);
    }
  }

  const angle: number[] = [];
  for (let i = 0; i < dx.length; i += 1) {
    angle.push(angleUnitsFor(numberAt(dx, i), numberAt(dy, i)));
  }

  return Object.freeze({
    size: dx.length,
    dx: Object.freeze(dx),
    dy: Object.freeze(dy),
    angle: Object.freeze(angle),
  });
}

/**
 * The ring a default-radius ball probes with, built once at module load so every
 * ball on every table shares one deterministic set of offsets.
 */
export const PROBE_RING: RingOffsets = ringOffsetsFor(DEFAULT_PROBE_RADIUS);

/**
 * Probe points around a default-radius ball.
 *
 * 44 at radius 8. Not a round number and not a tunable: it is however many
 * points a gapless discrete circle of that radius has.
 */
export const PROBE_RING_SIZE = PROBE_RING.size;

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/** Passability as a flat 16-entry lookup, so the probe loop is not a Map hit per point. */
export function passabilityOf(materials: MaterialTable): readonly boolean[] {
  const flags: boolean[] = [];
  for (let index = 0; index < MATERIAL_INDEX_COUNT; index += 1) {
    flags.push(materials.behaviourFor(index as MaterialIndex).passable);
  }
  return flags;
}

/**
 * "Most deflecting" ordering: a powered surface beats a springy one, which beats
 * a dead one. Ties break on the lower index so the choice never depends on ring
 * iteration order.
 *
 * Kick outranks elasticity because a kick adds energy the ball did not bring:
 * clipping a slingshot and a wall in the same tick must fire like the slingshot,
 * even though the wall may be the bouncier of the two.
 */
export function moreDeflecting(candidate: MaterialBehaviour, incumbent: MaterialBehaviour): boolean {
  if (candidate.kick !== incumbent.kick) return candidate.kick > incumbent.kick;
  if (candidate.elasticity !== incumbent.elasticity) {
    return candidate.elasticity > incumbent.elasticity;
  }
  return candidate.index < incumbent.index;
}

/** A probe result plus the contact point the mean bearing re-quantises onto. */
export interface RingProbe extends ContactResult {
  /**
   * Ring index of the REPORTED CONTACT POINT, or -1 when nothing was touched.
   *
   * The machine's +0x00AD92, not the mean itself: `round(angle * 44 / 2048)`.
   * See `ringIndexForAngle`. The physics never reads it; `normalX`/`normalY`
   * carry the direction, and this is the point the device layer is told about.
   */
  readonly contactIndex: number;
  /**
   * Outward surface normal as a Q10 unit vector: `cos`/`sin` of the mean bearing
   * plus half a turn, at the machine's own 1/2048-turn resolution. Zero when
   * nothing was touched.
   */
  readonly normalX: number;
  readonly normalY: number;
}

/**
 * THE CONTACT ANGLE — the machine's `$28(a4)`, and the one number every bounce
 * in the game turns on.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DISK DOES, +0x00A9C4 .. +0x00AD04
 * ---------------------------------------------------------------------------
 * The ring evaluator walks the 68-byte `D = A AND C` buffer the collision blit
 * leaves behind — 17 rows by 2 words, C being the ball's own 44-point probe ring
 * — and for every set point adds that point's TABULATED BEARING to `d5` as a
 * plain 16-bit number. It also keeps a four-bit quadrant mask in `d6` (bit j set
 * when some hit has an angle in [512j, 512j + 512)) and, in `d3`, a count of the
 * hits below half a turn. The tail is twelve instructions:
 *
 *     +0x00ACD8  cmpi.b #$b,d6 / #$9,d6 / #$d,d6   masks 1011, 1001, 1101 only
 *     +0x00ACEA  move.l d3,d0 / swap / ror.l #5    d5 += 2048 * d3
 *     +0x00ACF2  add.w d1,d2 / d2,d3 / d3,d4       fold the four counters
 *     +0x00ACF8  lsr.w #1,d4                       d4 = N, each hit bumped two
 *     +0x00ACFE  divu.w d4,d5                      TRUNCATING integer mean
 *     +0x00AD00  andi.w #$7ff,d5
 *     +0x00AD04  move.w d5,$28(a4)                 <- the answer
 *
 * THE WRAP RULE IS THREE MASKS AND NOT FOUR. Only 9 (1001), 11 (1011) and 13
 * (1101) get the correction; 15 (1111) contains quadrants 0 and 3 as well and is
 * DELIBERATELY EXCLUDED. So a contact arc spanning all four quadrants — a ball
 * wedged in a corridor, a ball buried in a corner — is averaged on the raw
 * numbers and gets an answer that is not any kind of bisector. That is a real,
 * deliberate limit of the machine's rule and it is reproduced rather than
 * papered over: it is how the original behaves, and inventing a fourth mask
 * would be inventing an engine rule.
 *
 * There is no empty case to guard. The caller only reaches the evaluator when
 * the hardware says the AND was non-empty (+0x00A7F6 `btst.b #$5,$2(a6)` reads
 * DMACONR's BZERO), so N >= 1 always and +0x00ACFE can never divide by zero.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PORT DID BEFORE, AND WHAT IT COST
 * ---------------------------------------------------------------------------
 * It summed Q10 unit vectors and took the nearest ring entry, with a fallback to
 * `contacts[0]` when the sum cancelled exactly. For a single contiguous arc the
 * two rules agree to within 4.18 units over 114,345 measured positions and the
 * substitution is invisible. Where they part company is where balls get stuck:
 * 59,163 of 151,077 multi-arc positions and 12,571 of 13,078 four-quadrant
 * positions differ by 8 units or more. Three concrete disagreements, all
 * verifiable by hand:
 *
 *     contacts {right, left}   disk 512 (down)   old rule 0    (the first one)
 *     contacts {up, down}      disk 1024 (left)  old rule 512
 *     the whole ring solid     disk 1000         old rule 0
 *
 * `outwardNormalOf` turns the answer into a vector. Nothing snaps.
 */
export function meanContactAngle(contacts: readonly ContactPoint[]): number {
  let sum = 0;
  let quadrants = 0;
  let belowHalfTurn = 0;
  for (const contact of contacts) {
    const angle = contact.angle;
    sum += angle;
    quadrants |= 1 << (angle >> 9);
    if (angle < ANGLE_HALF_TURN) belowHalfTurn += 1;
  }
  if (contacts.length === 0) {
    throw new RangeError("mean contact angle of an empty contact set");
  }
  if (quadrants === 0b1001 || quadrants === 0b1011 || quadrants === 0b1101) {
    sum += ANGLE_UNITS_PER_TURN * belowHalfTurn;
  }
  return Math.trunc(sum / contacts.length) & (ANGLE_UNITS_PER_TURN - 1);
}

/**
 * The machine's re-quantisation of a bearing onto a ring index, +0x00AD92:
 *
 *     mulu.w #$580,d5 / addi.l #$8000,d5 / swap d5      = round(angle * 44 / 2048)
 *
 * `$580` is 1408 and 1408/65536 is exactly 44/2048, so this is a round-to-
 * nearest onto 44 evenly spaced directions — which the ring is NOT, quite. The
 * machine spends the result on `(a0, d5.w*4)`, a table of (dx, dy) offsets with
 * a 45th entry equal to the first, and stores ball position plus that offset as
 * the reported contact point `$2a/$2c(a4)`.
 *
 * It is exact on every one of the ring's own bearings — all 44 round-trip — and
 * approximate in between, by up to half a ring step. That is fine, because it is
 * a REPORTING step: the reflection is taken about the unquantised angle, and the
 * decode confirms the only consumers are the reported contact point and the
 * device/zone layer downstream of it.
 *
 * The angle 2047 lands on 44, which is the wrapped first entry; `% ring.size`
 * is the machine's 45th table row.
 */
export function ringIndexForAngle(ring: RingOffsets, angle: number): number {
  const scaled = Math.round((normalizeAngle(angle) * ring.size) / ANGLE_UNITS_PER_TURN);
  return scaled % ring.size;
}

/**
 * The outward surface normal for a contact bearing, as a Q10 unit vector.
 *
 * The bearing points from the ball centre INTO the surface, so the outward
 * normal is half a turn away, and the machine's own sin/cos tables turn it into
 * a vector at 1/2048-turn resolution — 0.176 degrees, which is finer than the
 * ring's own 8.18-degree spacing by a factor of forty-six. The responder does
 * exactly this at +0x00B502 (`#$800 - $28(a4)`, then `muls.w` against the two
 * tables) and the port does it here so that everything downstream sees a plain
 * vector.
 *
 * WHY NOT SNAP TO A RING ENTRY. Because a bounce taken about a ring entry is a
 * bounce taken about a direction up to 3.5 degrees away from the surface, and
 * the static-friction angle this contact model works with is atan(154/1024) =
 * 8.55 degrees. Measured on the shipped Law 'n Justice map before the exact
 * normal existed: a ball coasting up the top orbit came to rest at
 * (214.95, 20.93), touching the inner arc at (212, 28) and (213, 28) on a face
 * that falls one row every four columns — a 14 degree slope a ball rolls down.
 * Snapped, it read 7.1, friction cancelled gravity exactly, and fifteen of two
 * hundred and seventy census balls ended on that one pixel. The machine has no
 * such failure because it never snaps either.
 */
export function outwardNormalOf(contactAngle: number): {
  readonly x: number;
  readonly y: number;
} {
  const outward = contactAngle + ANGLE_HALF_TURN;
  return { x: cosineUnits(outward), y: sineUnits(outward) };
}

/**
 * Samples one prepared ring around a ball centre. The hot path: the caller hoists
 * the passability table and the ring out of its loop.
 *
 * Points at or below the bottom map row are treated as open rather than as the
 * solid out-of-bounds border, because that row is where the ball is supposed to
 * leave the table. Left, right and top out-of-bounds stay solid: `materialAt`
 * returns the border material there and the ball is meant to be contained.
 *
 * `normalAngle` points from the ball centre TOWARD the contacts, i.e. into the
 * surface. The outward normal is the ring entry half a revolution away, which
 * `outwardNormalIndex` returns.
 */
export function probeRing(
  map: TableMap,
  materials: MaterialTable,
  passable: readonly boolean[],
  ring: RingOffsets,
  x: Q10,
  y: Q10,
): RingProbe {
  // Truncated to whole pixels the way the original's integer addressing did, so
  // a ball anywhere inside a pixel probes the same ring of pixels.
  const centreX = q10ToPixel(x);
  const centreY = q10ToPixel(y);

  const contacts: ContactPoint[] = [];
  let dominant: MaterialIndex | null = null;
  let dominantBehaviour: MaterialBehaviour | null = null;

  for (let i = 0; i < ring.size; i += 1) {
    const px = centreX + numberAt(ring.dx, i);
    const py = centreY + numberAt(ring.dy, i);
    if (py >= map.height) continue;

    const material = map.materialAt(px, py);
    if (flagAt(passable, material)) continue;

    contacts.push({ ringIndex: i, angle: numberAt(ring.angle, i), material, x: px, y: py });

    const behaviour = materials.behaviourFor(material);
    if (dominantBehaviour === null || moreDeflecting(behaviour, dominantBehaviour)) {
      dominantBehaviour = behaviour;
      dominant = material;
    }
  }

  if (contacts.length === 0) {
    return { contacts, normalAngle: null, dominant: null, contactIndex: -1, normalX: 0, normalY: 0 };
  }

  const contactAngle = meanContactAngle(contacts);
  const normal = outwardNormalOf(contactAngle);
  return {
    contacts,
    normalAngle: contactAngle,
    dominant,
    contactIndex: ringIndexForAngle(ring, contactAngle),
    normalX: normal.x,
    normalY: normal.y,
  };
}

/**
 * Tests one ball against the map at the default ball radius.
 *
 * The convenience form of `probeRing` for callers outside the integrator — a
 * device or scoring layer asking "what is this ball touching right now". It
 * builds the passability table on every call, so it is not the shape to use
 * inside a per-substep loop.
 *
 * Callers that must agree with the simulation exactly have to pass the same map
 * view the simulation runs on, virtual walls included: see
 * `playfieldViewFor` in ball-physics.ts.
 */
export function probeContacts(
  map: TableMap,
  materials: MaterialTable,
  x: Q10,
  y: Q10,
  radius: Q10 = DEFAULT_PROBE_RADIUS,
): RingProbe {
  return probeRing(map, materials, passabilityOf(materials), ringOffsetsFor(radius), x, y);
}

/** The outward surface normal for a contact: the ring entry half a turn away. */
export function outwardNormalIndex(ring: RingOffsets, contactIndex: number): number {
  return (contactIndex + ring.size / 2) % ring.size;
}
