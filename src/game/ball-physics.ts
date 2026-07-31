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
 * ---------------------------------------------------------------------------
 * THE TABLE THE PHYSICS SEES IS NOT QUITE THE BITMAP
 * ---------------------------------------------------------------------------
 * One shipped map is missing its top border, so the simulation collides against
 * a VIEW of the map — the bitmap plus a per-table virtual top wall. Only the
 * physics sees it; `pixels` is untouched and the renderer draws the table as it
 * shipped. See VIRTUAL_TOP_WALL_ROWS below.
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
  outwardNormalIndex,
  passabilityOf,
  probeRing,
  ringOffsetsFor,
} from "./collision-probe.js";
import { SOLID_BORDER_INDEX } from "./materials.js";

// The ball radius and the integer square root are defined next to the probe ring
// they are needed to build; re-exported here because callers reason about them
// as properties of the ball, not of the probe.
export { BALL_RADIUS_PIXELS, integerSqrt };

const VELOCITY_MIN = -32767;
const VELOCITY_MAX = 32767;

// ---------------------------------------------------------------------------
// The virtual top wall
// ---------------------------------------------------------------------------

/**
 * Rows sealed off at the top of each table by a wall that is not in the bitmap.
 *
 * Law 'n Justice's exported collision layer has NO bit-0 pixel anywhere in rows
 * 0..34: the top arch is drawn, but the line that should close it off above the
 * shooter lane is simply not in the data. A ball that gets over the arch escapes
 * into a 336 px wide empty attic, roams the whole width of the table and comes
 * down somewhere it never could on the real machine. Measured on the shipped
 * map with the real probe ring, the region a ball can reach from the shooter
 * lane is 101608 centre positions with no wall and 16556 with this one — the
 * difference is entirely attic.
 *
 * 26 was chosen by connectivity, not by eye. Flood-filling free ball centres out
 * of the shooter lane, the upper playfield stays connected to it for every wall
 * from 1 to 43 rows (4650 reachable centres in the upper-left quadrant at 26,
 * 3086 at 43) and is severed at 44, where that count drops to zero and the ball
 * can no longer be fed onto the table at all. 26 therefore sits with wide margin
 * on the safe side of the only constraint the geometry imposes.
 *
 * The other two tables are properly walled in their own data and get 0. This is
 * per-table configuration, deliberately explicit and in one place, because it is
 * a correction to specific shipped data rather than a rule about pinball.
 */
export const VIRTUAL_TOP_WALL_ROWS: Readonly<Record<TableId, number>> = Object.freeze({
  "law-n-justice": 26,
  babewatch: 0,
  "extreme-sports": 0,
});

/**
 * The map as the physics sees it: the shipped bitmap plus any virtual walls.
 *
 * Only `materialAt` is overridden. `pixels` is left alone, so the renderer draws
 * the table as it shipped and nothing paints a wall that is not really there.
 *
 * A ball whose centre is placed inside the sealed rows is in solid material like
 * any other, and `recoverPenetration` will push it out only if free space is
 * within a ball diameter — spawn points belong on the playfield, not in the wall.
 */
/**
 * The synthesised top arch.
 *
 * SYNTHESISED, NOT MEASURED — unlike every other piece of geometry here. Law 'n
 * Justice's map carries no collision line at all in its top rows, so there is no
 * arch in the data to decode. Without one, a ball launched up the shooter lane
 * meets a flat ceiling dead-on, rebounds with no sideways motion at all, falls
 * back down the lane and rests there permanently: the plunger becomes a one-shot
 * button that achieves nothing and the table never drains. A headless
 * play-through found exactly that — apex y=34 against a ceiling at y=34.
 *
 * A real table turns the vertical launch into a lateral entry with a curved
 * arch. This models that: over `span` pixels at the right-hand edge the ceiling
 * ramps `depth` pixels lower, so a ball rising in the lane strikes a slope
 * rather than a flat soffit and is deflected left onto the playfield. The
 * gradient is `depth / span`, and a ball arriving vertically leaves at about
 * twice that angle off vertical.
 *
 * Only the table with the gap gets one. If the real arch is ever recovered —
 * most likely by observing the original run — replace this with the measured
 * geometry and delete these numbers rather than tuning them.
 */
export interface TopArch {
  /** Pixels inward from the right edge over which the ceiling descends. */
  readonly span: number;
  /** How much lower the ceiling sits at the right edge. */
  readonly depth: number;
}

/**
 * DISABLED PENDING EVIDENCE. Every table is null.
 *
 * A 30-in-60 arch was tried on Law 'n Justice and does deflect the ball out of
 * the lane, but it also measurably degraded the flipper return (best upward gain
 * from a flip fell from over 20px to 10px). At that point the numbers were being
 * fitted to tests rather than to the original, which is precisely the mistake
 * this project has already paid for twice.
 *
 * The better hypothesis is that the arch is not missing at all. Slots 1 and 3 of
 * each table package are still unidentified, and slot 3 is a raster of identical
 * size on all three tables — a strong candidate for geometry the lower-level
 * collision layer does not carry. Decode those before inventing anything here.
 *
 * Consequence while this stays null: on Law 'n Justice a launched ball rises to
 * the flat ceiling, returns down the shooter lane and rests there, so a game
 * cannot progress past the first ball. `tests/plays.test.ts` records that with
 * an `it.fails` characterisation test, which will start failing — and so demand
 * attention — the moment the real geometry makes it pass.
 */
export const TOP_ARCH_BY_TABLE: Readonly<Record<TableId, TopArch | null>> = Object.freeze({
  "law-n-justice": null,
  babewatch: null,
  "extreme-sports": null,
});

/** Ceiling depth at one column: the flat wall plus the arch, where there is one. */
export function ceilingRowsAt(
  x: number,
  topWallRows: number,
  arch: TopArch | null,
  width: number,
): number {
  if (arch === null || arch.span <= 0) return topWallRows;
  const start = width - arch.span;
  if (x < start) return topWallRows;
  const t = Math.min(1, (x - start) / arch.span);
  return topWallRows + Math.round(arch.depth * t);
}

export function playfieldViewFor(
  map: TableMap,
  topWallRows: number,
  arch: TopArch | null = TOP_ARCH_BY_TABLE[map.tableId] ?? null,
): TableMap {
  if (topWallRows <= 0 && arch === null) return map;
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
      const rows = ceilingRowsAt(Math.floor(x), topWallRows, arch, map.width);
      return Math.floor(y) < rows ? SOLID_BORDER_INDEX : map.materialAt(x, y);
    },
  });
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
   * tick and never settles.
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
}

export const DEFAULT_SIMULATION_OPTIONS: SimulationOptions = {
  radius: DEFAULT_PROBE_RADIUS,
  maxSubstepDistance: DEFAULT_PROBE_RADIUS >> 1,
  restThreshold: 160,
  drainY: null,
  topWallRows: null,
  ballToBall: true,
};

interface ResolvedOptions {
  readonly radius: Q10;
  readonly maxSubstepDistance: Q10;
  readonly restThreshold: number;
  readonly drainY: Q10;
  readonly topWallRows: number;
  readonly ballToBall: boolean;
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
export function createBall(id: number, x: Q10, y: Q10, velocityX = 0, velocityY = 0): BallState {
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
export function spawnBall(set: BallSet, x: Q10, y: Q10, velocityX = 0, velocityY = 0): BallState {
  const ball = createBall(set.nextId, x, y, velocityX, velocityY);
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
}

function clampVelocity(value: number): number {
  return q10Clamp(Math.trunc(value), VELOCITY_MIN, VELOCITY_MAX);
}

/**
 * Reflects a ball's velocity about an outward normal.
 *
 * Split into a normal and a tangential part: the normal part is reversed and
 * scaled by elasticity, the tangential part is scaled down by friction, and the
 * material's kick is added outward on top.
 *
 * A ball that is already leaving the surface is left ENTIRELY alone — not merely
 * left with its normal speed, as an earlier version did. Friction and kick are
 * responses to an impact, and re-applying them on every substep that still sees
 * the surface made the substep count physically significant: the substep count
 * is `ceil(speed / maxSubstepDistance)`, so a ball at 4097 Q10/tick kept 72% of
 * its tangential speed where one at 4096 kept 85%, and the cliff repeated at
 * every multiple of the substep distance. Responding only to approach costs the
 * same whatever the tick was cut into, and is also the correct Coulomb rule:
 * no normal force, no friction.
 */
export function reflectVelocity(
  ball: BallState,
  behaviour: MaterialBehaviour,
  normalX: number,
  normalY: number,
  restThreshold: number,
): void {
  const normalSpeedIn = q10Multiply(ball.velocityX, normalX) + q10Multiply(ball.velocityY, normalY);
  if (normalSpeedIn >= 0) return;

  const tangentX = ball.velocityX - q10Multiply(normalSpeedIn, normalX);
  const tangentY = ball.velocityY - q10Multiply(normalSpeedIn, normalY);

  const bounced = -q10Multiply(normalSpeedIn, behaviour.elasticity);
  // A ball creeping into the surface under gravity must settle, not chatter.
  let normalSpeedOut = bounced <= restThreshold ? 0 : bounced;
  normalSpeedOut += behaviour.kick;

  const grip = q10Clamp(Q10_ONE - behaviour.friction, 0, Q10_ONE);
  ball.velocityX = clampVelocity(
    q10Multiply(tangentX, grip) + q10Multiply(normalSpeedOut, normalX),
  );
  ball.velocityY = clampVelocity(
    q10Multiply(tangentY, grip) + q10Multiply(normalSpeedOut, normalY),
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

    const normal = outwardNormalIndex(ring, probe.contactIndex);
    const into =
      q10Multiply(ball.velocityX, numberAt(ring.unitX, normal)) +
      q10Multiply(ball.velocityY, numberAt(ring.unitY, normal));
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
}

function newContactLog(): ContactLog {
  return { points: [], seen: new Set<number>(), sumX: 0, sumY: 0, dominant: null, dominantBehaviour: null };
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
  }
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
  // Everything below collides against the VIEW, never the raw map, so the
  // virtual top wall is as solid as any painted one and there is no path through
  // the integrator that can miss it.
  const view = playfieldViewFor(map, resolved.topWallRows);

  const contacts = new Map<number, ContactResult>();
  const drained: number[] = [];

  for (const ball of balls.balls) {
    if (!ball.active) continue;

    ball.velocityX = clampVelocity(ball.velocityX + forces.nudgeX);
    ball.velocityY = clampVelocity(ball.velocityY + forces.gravityY + forces.nudgeY);

    const contact = integrateBall(ball, view, materials, passable, ring, resolved);
    if (contact !== null) {
      contacts.set(ball.id, contact);
    }
  }

  if (resolved.ballToBall) {
    resolveBallCollisions(
      balls.balls,
      resolved.radius,
      pushClampFor(view, materials, passable, ring),
    );
  }

  // Drained last, so a ball knocked back above the drain line by another ball
  // on the very tick it fell out is correctly still in play.
  for (const ball of balls.balls) {
    if (!ball.active) continue;
    if (ball.y >= resolved.drainY) {
      ball.active = false;
      drained.push(ball.id);
    }
  }

  return { drained, contacts };
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
  const maximum = Math.max(2 * radiusPixels, options.topWallRows + radiusPixels);

  const probe = probeRing(map, materials, passable, ring, ball.x, ball.y);
  if (probe.contactIndex >= 0) {
    logContacts(log, probe, ring, materials);
    const normal = outwardNormalIndex(ring, probe.contactIndex);
    const normalX = numberAt(ring.unitX, normal);
    const normalY = numberAt(ring.unitY, normal);
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
): ContactResult | null {
  const log = newContactLog();
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
      const normal = outwardNormalIndex(ring, stop.blocker.contactIndex);
      reflectVelocity(
        ball,
        materials.behaviourFor(stop.blocker.dominant),
        numberAt(ring.unitX, normal),
        numberAt(ring.unitY, normal),
        options.restThreshold,
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
  // has channels narrower than the ball, and one at (54, 156) held a ball that
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

  return closeContactLog(log, ring);
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
  map: TableMap,
  materials: MaterialTable,
  passable: readonly boolean[],
  ring: RingOffsets,
): PushClamp {
  return (ball: BallState, deltaX: Q10, deltaY: Q10): { x: Q10; y: Q10 } => {
    let dx = deltaX;
    let dy = deltaY;

    const probe = probeRing(map, materials, passable, ring, ball.x, ball.y);
    if (probe.contactIndex >= 0) {
      const towardX = numberAt(ring.unitX, probe.contactIndex);
      const towardY = numberAt(ring.unitY, probe.contactIndex);
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
    if (a === undefined || !a.active) continue;

    for (let j = i + 1; j < balls.length; j += 1) {
      const b = balls[j];
      if (b === undefined || !b.active) continue;

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
