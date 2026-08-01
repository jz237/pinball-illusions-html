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
 * recovered from geometry, and the cheapest honest way is the original's own:
 * sample a ring of points around the ball centre and take the mean direction of
 * the ones that landed in solid material. That mean points at the obstruction,
 * so the surface normal is its opposite — which, because the ring is symmetric,
 * is exactly the ring entry half a revolution away and needs no extra
 * arithmetic. Reconstructing that shape rather than a modern swept-circle solver
 * is what keeps the bounces feeling like the 1995 game.
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

const QUARTER_TURN = ANGLE_UNITS_PER_TURN / 4;

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
function roundHalfAwayFromZero(value: number): number {
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

/** The probe ring for one radius, as parallel arrays in ring order. */
export interface RingOffsets {
  /** Number of entries. Depends on the radius; it is not a fixed 32 or 24. */
  readonly size: number;
  /** Integer pixel offsets, ordered by angle from +x toward +y (screen down). */
  readonly dx: readonly number[];
  readonly dy: readonly number[];
  /** The same directions as Q10 unit vectors, so the mean is not length-weighted. */
  readonly unitX: readonly number[];
  readonly unitY: readonly number[];
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
 * atan(ratio) in radians for ratio in [0, 1].
 *
 * A three-term polynomial, max error about 0.0015 rad — a third of one angle
 * unit at this scale. It uses only IEEE `+ - *`, every one of which is correctly
 * rounded and therefore identical on every engine; `Math.atan2` is not, and this
 * table is baked into replay-critical contact records.
 */
function atanRadians(ratio: number): number {
  return (Math.PI / 4) * ratio - ratio * (ratio - 1) * (0.2447 + 0.0663 * ratio);
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
      : QUARTER_TURN - atanRadians(ax / ay) * RADIANS_TO_ANGLE_UNITS;
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

/** One component of the Q10 unit vector along (dx, dy), rounded sign-symmetrically. */
function unitComponent(component: number, lengthSquared: number): number {
  if (component === 0) return 0;
  const scaledLength = integerSqrt(lengthSquared * Q10_ONE * Q10_ONE);
  return roundHalfAwayFromZero((component * Q10_ONE * Q10_ONE) / scaledLength);
}

/**
 * Builds the whole ring by rotating the quarter arc through 90 degrees four
 * times. Entry `i` and entry `i + size / 2` are therefore exact negations, which
 * is what makes the outward normal a table lookup rather than a negation.
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

  const unitX: number[] = [];
  const unitY: number[] = [];
  const angle: number[] = [];
  for (let i = 0; i < dx.length; i += 1) {
    const ox = numberAt(dx, i);
    const oy = numberAt(dy, i);
    const lengthSquared = ox * ox + oy * oy;
    unitX.push(unitComponent(ox, lengthSquared));
    unitY.push(unitComponent(oy, lengthSquared));
    angle.push(angleUnitsFor(ox, oy));
  }

  return Object.freeze({
    size: dx.length,
    dx: Object.freeze(dx),
    dy: Object.freeze(dy),
    unitX: Object.freeze(unitX),
    unitY: Object.freeze(unitY),
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

/** A probe result plus the ring entry the mean contact direction landed on. */
export interface RingProbe extends ContactResult {
  /** Ring index of the mean contact direction, or -1 when nothing was touched. */
  readonly contactIndex: number;
  /**
   * Outward surface normal as a Q10 unit vector — the mean contact direction
   * reversed, WITHOUT being snapped to the ring. Zero when nothing was touched.
   *
   * See `outwardNormalOf` for why the snapped version is not good enough to
   * reflect with.
   */
  readonly normalX: number;
  readonly normalY: number;
}

/**
 * The outward surface normal, as an exact Q10 unit vector rather than a ring
 * entry.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SNAPPED NORMAL IS NOT GOOD ENOUGH TO REFLECT WITH
 * ---------------------------------------------------------------------------
 * `meanContactIndex` rounds the mean contact direction onto one of the ring's
 * 44 entries, and those entries are not evenly spaced: near the axes they are
 * 7.1 degrees apart, because the closest neighbours of (0, 8) are (+-1, 8). So a
 * surface whose true normal is 10.6 degrees off vertical is reflected off as
 * though it were 7.1 — an error of up to about 4 degrees, which is HALF the
 * whole static-friction angle the contact model works with. `WALL_FRICTION` is
 * 154/1024, so a ball is held on anything shallower than atan(0.150) = 8.55
 * degrees; the rounding therefore decides, on its own, whether a ball on a
 * shallow ramp rolls or sticks.
 *
 * Measured, on the shipped Law 'n Justice map: a ball coasting up the top orbit
 * comes to rest at (214.95, 20.93) on the upper collision line, touching the
 * inner arc at (212, 28) and (213, 28). The mean of those two ring directions is
 * 10.6 degrees off vertical, and the arc's own face there falls one row every
 * four columns — a 14 degree slope, which is what a ball actually rolls down.
 * Snapped, it reads 7.1 degrees, the friction budget of 3 Q10/tick exactly
 * cancels the 3 Q10/tick of gravity along the surface, and the ball stops dead
 * with velocity (0, 0) for the rest of the game. Fifteen of two hundred and
 * seventy balls in an aggressive-player census ended on that single pixel.
 *
 * The reported `normalAngle` is deliberately left snapped: it is a contact
 * RECORD for the scoring and device layers, it is one of the tabulated angles by
 * construction, and every test that reads it is asserting that property. This is
 * the vector the physics reflects about, and nothing about it is less
 * deterministic — one integer square root and two integer divides, no
 * trigonometry and no `Math.sqrt`.
 *
 * Falls back to the ring entry when the contacts cancel out exactly, which is
 * the same degenerate case `meanContactIndex` handles: a ball wedged in a
 * corridor touching both walls has no mean direction at all.
 */
export function outwardNormalOf(
  ring: RingOffsets,
  contactIndex: number,
  sumX: number,
  sumY: number,
): { readonly x: number; readonly y: number } {
  const lengthSquared = sumX * sumX + sumY * sumY;
  if (lengthSquared === 0) {
    const fallback = outwardNormalIndex(ring, contactIndex);
    return { x: numberAt(ring.unitX, fallback), y: numberAt(ring.unitY, fallback) };
  }
  return {
    x: unitComponent(-sumX, lengthSquared),
    y: unitComponent(-sumY, lengthSquared),
  };
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
  let sumX = 0;
  let sumY = 0;
  let dominant: MaterialIndex | null = null;
  let dominantBehaviour: MaterialBehaviour | null = null;

  for (let i = 0; i < ring.size; i += 1) {
    const px = centreX + numberAt(ring.dx, i);
    const py = centreY + numberAt(ring.dy, i);
    if (py >= map.height) continue;

    const material = map.materialAt(px, py);
    if (flagAt(passable, material)) continue;

    contacts.push({ ringIndex: i, angle: numberAt(ring.angle, i), material, x: px, y: py });
    sumX += numberAt(ring.unitX, i);
    sumY += numberAt(ring.unitY, i);

    const behaviour = materials.behaviourFor(material);
    if (dominantBehaviour === null || moreDeflecting(behaviour, dominantBehaviour)) {
      dominantBehaviour = behaviour;
      dominant = material;
    }
  }

  if (contacts.length === 0) {
    return { contacts, normalAngle: null, dominant: null, contactIndex: -1, normalX: 0, normalY: 0 };
  }

  const contactIndex = meanContactIndex(ring, contacts, sumX, sumY);
  const normal = outwardNormalOf(ring, contactIndex, sumX, sumY);
  return {
    contacts,
    normalAngle: numberAt(ring.angle, contactIndex),
    dominant,
    contactIndex,
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
): ContactResult {
  return probeRing(map, materials, passabilityOf(materials), ringOffsetsFor(radius), x, y);
}

/**
 * Mean contact direction, snapped to the ring.
 *
 * An arithmetic mean of the angles is wrong here and wrong in a way that hides:
 * two contacts at 1963 and 85 are 170 units apart either side of zero, and
 * averaging the numbers gives 1024 — the exact opposite direction, which would
 * fire the ball INTO the wall it just touched. Summing unit vectors and taking
 * the nearest ring entry respects the wrap, avoids `atan2`, and as a side effect
 * guarantees the answer is one of the tabulated directions — so the outward
 * normal is an exact integer vector rather than a rounded one.
 *
 * When the contacts cancel out exactly (a ball wedged in a corridor, touching
 * both sides) there is no meaningful mean, and the first contact is used so the
 * ball still gets pushed somewhere instead of being trapped. That choice is
 * arbitrary but deterministic: it is whichever wall the ring reached first.
 */
export function meanContactIndex(
  ring: RingOffsets,
  contacts: readonly ContactPoint[],
  sumX: number,
  sumY: number,
): number {
  if (sumX === 0 && sumY === 0) {
    const first = contacts[0];
    if (first === undefined) {
      throw new RangeError("mean contact direction of an empty contact set");
    }
    return first.ringIndex;
  }

  let bestIndex = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < ring.size; i += 1) {
    const dot = sumX * numberAt(ring.unitX, i) + sumY * numberAt(ring.unitY, i);
    if (dot > bestDot) {
      bestDot = dot;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/** The outward surface normal for a contact: the ring entry half a turn away. */
export function outwardNormalIndex(ring: RingOffsets, contactIndex: number): number {
  return (contactIndex + ring.size / 2) % ring.size;
}
