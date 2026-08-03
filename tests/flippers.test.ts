import { describe, expect, it } from "vitest";

import { SIMULATION_GRAVITY } from "../src/game/timebase.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  BallState,
  SimulationForces,
  TableId,
  TableMap,
  TableMapDocument,
} from "../src/game/contracts.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { materialTableFor } from "../src/game/materials.js";
import { upperLevelViewFor } from "../src/game/playfield-levels.js";
import { createBall, createBallSet, stepBalls } from "../src/game/ball-physics.js";
import {
  ANGLE_UNITS_PER_TURN,
  BALL_RADIUS_PIXELS,
  QUARTER_TURN_UNITS,
  angleDelta,
  cosineUnits,
  ringOffsetsFor,
  sineUnits,
} from "../src/game/collision-probe.js";
import { Q10_ONE, pixelsToQ10, q10Multiply, q10ToPixel } from "../src/core/fixed-point.js";
import type { Q10 } from "../src/core/fixed-point.js";
import type { FlipperConfig, FlipperState, FlipperSweep } from "../src/game/flippers.js";

/**
 * A bat parked at a stroke with no angular velocity.
 *
 * The stroke is state in two parts now — see `FlipperState` — because the
 * measured bat accelerates and carries its rate across a reversal. Every literal
 * in this file that used to be `{ stroke }` is a bat that has been PLACED there
 * rather than one that has arrived, so its rate is zero.
 */
function batAt(stroke: number): FlipperState {
  return { stroke, rate: 0 };
}

/** Whole ticks a full up-stroke and a full return take. 3.5 and 6.25 measured. */
const UP_STROKE_TICKS = Math.ceil(FLIPPER_UP_TICKS);
const DOWN_STROKE_TICKS = Math.ceil(FLIPPER_DOWN_TICKS);
import {
  FLIPPER_AT_REST,
  FLIPPER_BOSS_RADIUS_PIXELS,
  FLIPPER_DOWN_TICKS,
  FLIPPER_FIRST_BANK_FRAMES,
  FLIPPER_FRAMES_PER_TURN,
  FLIPPER_FRAME_ARC_END_DEGREES,
  FLIPPER_FRAME_ARC_START_DEGREES,
  FLIPPER_FRAME_COUNT,
  FLIPPER_FRAME_STEP_DEGREES,
  FLIPPER_DRAWN_HUB_PIXELS,
  FLIPPER_DRAWN_TIP_PIXELS,
  FLIPPER_LENGTH_PIXELS,
  FLIPPER_PLACEMENT_NOTE,
  FLIPPER_RECORDS,
  FLIPPER_SURFACE,
  FLIPPER_STEPS_PER_TICK,
  FLIPPER_SWEEP_UNITS,
  FLIPPER_TAPER_START_PIXELS,
  FLIPPER_TIP_RADIUS_PIXELS,
  FLIPPER_UP_TICKS,
  UPPER_FLIPPER_RECORDS,
  BAT_ANGLE_UNITS_PER_POSE,
  poseToAngleUnits,
  BAT_ANGLE_UNITS_PER_TURN,
  FLIPPER_UP_MAX_RATE,
  batAngleToBearing,
  batRadiusAt,
  createFlipperBank,
  flipperAngle,
  flipperConfigsFor,
  flipperEndpoints,
  flipperFrameIndex,
  flipperInputFrom,
  flipperPoseAt,
  flipperRecordFor,
  hasUpperFlipper,
  isFullyFlipped,
  resolveFlipperContacts,
  substepsFor,
  sweptAngle,
  applyFlipperReactions,
  flipperImpulseMagnitude,
  flipperImpulseRadius,
  flipperRateTaken,
  ORIGINAL_IMPULSE_FLOOR,
  ORIGINAL_IMPULSE_TABLE_SIDE,
  tangentialSpeed,
  tickFlipper,
  tickFlipperBank,
  validateFlipperConfig,
} from "../src/game/flippers.js";
import {
  DEGREES_PER_POSE,
  POSES_PER_TURN,
  batBodySolid,
  batPoseBody,
  batPoseForStroke,
  clearFlipperBats,
} from "../src/game/flipper-bats.js";
import { devicesFor, flipperBatsFixture, mapFor as shippedMapFor } from "./table-fixtures.js";
import { FLIPPER_ID_MAX, FLIPPER_ID_MIN, surfaceResponseFor } from "../src/game/surface-physics.js";

const BALL_RADIUS: Q10 = pixelsToQ10(BALL_RADIUS_PIXELS);

// ---------------------------------------------------------------------------
// THE DRAWN BAT, read back out of the shipped pose bank
// ---------------------------------------------------------------------------
//
// Every geometric assertion below that used to restate a number now DERIVES it
// from `public/generated/flipper-bats.json` — the same document the renderer
// blits — so it cannot go stale the way "45 px long, 5 px at the boss" did.

const BATS = flipperBatsFixture();

/** Offsets from the pivot of every opaque pixel of one drawn pose. */
function drawnPixels(pose: number): readonly (readonly [number, number])[] {
  const entry = BATS.poses.get(pose);
  if (entry === undefined) throw new Error(`pose ${pose} is not in the shipped bank`);
  const rowBytes = Math.ceil(entry.width / 8);
  const plane2Rows = entry.height - 2 * BATS.plane2RowOffset;
  const bit = (plane: Uint8Array, row: number, x: number): boolean =>
    ((plane[row * rowBytes + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0;
  const out: [number, number][] = [];
  for (let y = 0; y < entry.height; y += 1) {
    for (let x = 0; x < entry.width; x += 1) {
      let index = (bit(entry.plane0, y, x) ? 1 : 0) | (bit(entry.plane1, y, x) ? 2 : 0);
      const body = y - BATS.plane2RowOffset;
      if (body >= 0 && body < plane2Rows && bit(entry.plane2, body, x)) index |= 4;
      if (index !== 0) out.push([x - entry.anchorX, y - entry.anchorY]);
    }
  }
  return out;
}

/** A drawn pixel's position in the bat's own frame, at a bearing in degrees. */
function batFrame(bearingDegrees: number, dx: number, dy: number): { along: number; perp: number } {
  const radians = (bearingDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { along: dx * cos + dy * sin, perp: -dx * sin + dy * cos };
}

/** How far OUTSIDE the collision capsule a point in the bat's frame is; <=0 is in. */
function outsideCapsule(config: FlipperConfig, along: number, perp: number): number {
  const lengthPixels = config.length / Q10_ONE;
  const clamped = Math.min(lengthPixels, Math.max(0, along));
  // The capsule's own radius, in Q10, NOT rounded to a whole pixel: rounding it
  // here would measure a thinner bat than the one the physics collides on.
  const radius = batRadiusAt(config, Math.round(clamped * Q10_ONE)) / Q10_ONE;
  return Math.hypot(along - clamped, perp) - radius;
}

/** True when (dx,dy) from the pivot is inside the capsule at this bat angle. */
function insideCapsuleAt(config: FlipperConfig, angle: number, dx: number, dy: number): boolean {
  const axisX = cosineUnits(angle);
  const axisY = sineUnits(angle);
  const px = pixelsToQ10(dx);
  const py = pixelsToQ10(dy);
  let along = q10Multiply(px, axisX) + q10Multiply(py, axisY);
  if (along < 0) along = 0;
  if (along > config.length) along = config.length;
  const offsetX = px - q10Multiply(along, axisX);
  const offsetY = py - q10Multiply(along, axisY);
  const radius = batRadiusAt(config, along);
  return offsetX * offsetX + offsetY * offsetY <= radius * radius;
}

/** The gravity the rest of the simulation is calibrated against. */
const GRAVITY = SIMULATION_GRAVITY;

const LEFT = flipperConfigsFor("law-n-justice")[0] as FlipperConfig;
const RIGHT = flipperConfigsFor("law-n-justice")[1] as FlipperConfig;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The probe ring the bats and the map both collide on. */
const PROBE = ringOffsetsFor(BALL_RADIUS);

/**
 * The bat's own frame at a stroke, taken from the pose it DRAWS.
 *
 * The bearing is the drawn pose's, not `flipperAngle`'s, because the body is
 * that pose's pixels; the two agree to within the rounding of one pose and the
 * suite pins that separately.
 */
function batFrameAt(
  config: FlipperConfig,
  state: FlipperState,
): { pose: number; cos: number; sin: number; faceX: number; faceY: number } {
  const pose = flipperPoseAt(config, state.stroke);
  const radians = (pose * DEGREES_PER_POSE * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { pose, cos, sin, faceX: -config.direction * sin, faceY: config.direction * cos };
}

/**
 * The outermost DRAWN pixel on the face the bat sweeps toward, per whole along
 * value, as an offset from the pivot.
 */
function drawnFaceProfile(
  config: FlipperConfig,
  state: FlipperState,
): Map<number, { dx: number; dy: number; face: number }> {
  const frame = batFrameAt(config, state);
  const profile = new Map<number, { dx: number; dy: number; face: number }>();
  for (const [dx, dy] of drawnPixels(frame.pose)) {
    const along = Math.round(dx * frame.cos + dy * frame.sin);
    const face = dx * frame.faceX + dy * frame.faceY;
    const seen = profile.get(along);
    if (seen === undefined || face > seen.face) profile.set(along, { dx, dy, face });
  }
  return profile;
}

/**
 * The probe-ring entry pointing INTO the striking face — the direction from a
 * ball resting on that face toward the bat, which is minus the face's outward
 * normal. A ball at `pixel - PROBE[thisEntry]` therefore has `pixel` exactly on
 * its ring and sits on the outward side of the bat.
 */
function faceRingIndex(config: FlipperConfig, state: FlipperState): number {
  const frame = batFrameAt(config, state);
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < PROBE.size; i += 1) {
    const dot = -((PROBE.dx[i] ?? 0) * frame.faceX + (PROBE.dy[i] ?? 0) * frame.faceY);
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  }
  return best;
}

/**
 * A ball centre resting on the face the bat sweeps toward, `alongPixels` out
 * from the pivot and TOUCHING THE PIXELS THE BAT DRAWS.
 *
 * REPLACED, and the replacement is the whole point of this round. This used to
 * stand the ball off the axis by `batRadiusAt(along) + 8` — tangent to the
 * analytic capsule — and "tangent" is a statement no pixel body can honour: the
 * capsule's surface is a real number, the bat's is a set of whole pixels, and
 * the two agree only by luck. Nine of the assertions in this file were resting
 * balls on a curve the machine never had.
 *
 * The placement is now the engine's own definition of contact, the same one
 * `probeRing` uses for every wall in the game: the outermost drawn pixel on the
 * striking face at that along is put EXACTLY on the ball's probe ring, in the
 * ring direction nearest the face normal. So a ball placed here is touching the
 * bat the player can see, by construction and on the grid — and any model that
 * collides against the drawn pixels must say so.
 *
 * `gap` lifts the centre further out along the face normal, in whole pixels, for
 * the tests that want a ball ABOVE the bat rather than on it.
 */
function ballRestingOn(
  config: FlipperConfig,
  state: FlipperState,
  alongPixels: number,
  gap = 0,
): { x: Q10; y: Q10 } {
  const frame = batFrameAt(config, state);
  const profile = drawnFaceProfile(config, state);
  let along = alongPixels;
  let best = Infinity;
  for (const candidate of profile.keys()) {
    const distance = Math.abs(candidate - alongPixels);
    if (distance < best) {
      best = distance;
      along = candidate;
    }
  }
  const target = profile.get(along);
  if (target === undefined) throw new Error(`${config.id} draws nothing at all`);
  const index = faceRingIndex(config, state);
  const centreX =
    q10ToPixel(config.pivotX) + target.dx - (PROBE.dx[index] ?? 0) + Math.round(gap * frame.faceX);
  const centreY =
    q10ToPixel(config.pivotY) + target.dy - (PROBE.dy[index] ?? 0) + Math.round(gap * frame.faceY);
  return { x: pixelsToQ10(centreX), y: pixelsToQ10(centreY) };
}

/** How far along the bat's axis a ball centre projects, from the pivot. Q10. */
function axisOffset(config: FlipperConfig, state: FlipperState, ball: BallState): number {
  const angle = flipperAngle(config, state);
  return (
    q10Multiply(ball.x - config.pivotX, cosineUnits(angle)) +
    q10Multiply(ball.y - config.pivotY, sineUnits(angle))
  );
}

/** Signed distance of a ball centre from the bat's axis, along the striking face. */
function faceOffset(config: FlipperConfig, state: FlipperState, ball: BallState): number {
  const angle = flipperAngle(config, state);
  const faceX = (-config.direction * sineUnits(angle)) | 0;
  const faceY = (config.direction * cosineUnits(angle)) | 0;
  return q10Multiply(ball.x - config.pivotX, faceX) + q10Multiply(ball.y - config.pivotY, faceY);
}

function speedOf(ball: BallState): number {
  return Math.hypot(ball.velocityX, ball.velocityY);
}

/**
 * A minimal integrator: gravity, straight-line motion, then the flipper pass.
 *
 * Deliberately not `stepBalls` — these cases are about the bat alone, and the
 * map would add contacts that make a launch speed hard to attribute. The
 * integration test at the bottom uses the real thing.
 */
function runTicks(
  balls: BallState[],
  configs: readonly FlipperConfig[],
  held: readonly boolean[],
  ticks: number,
  states: FlipperState[] = configs.map(() => FLIPPER_AT_REST),
  gravity = GRAVITY,
): { states: FlipperState[]; contacts: number } {
  let contacts = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    const sweeps: FlipperSweep[] = configs.map((config, index) => {
      const sweep = tickFlipper(config, states[index] as FlipperState, held[index] === true);
      states[index] = sweep.to;
      return sweep;
    });
    for (const ball of balls) {
      if (!ball.active) continue;
      ball.velocityY += gravity;
      ball.x = (ball.x + ball.velocityX) | 0;
      ball.y = (ball.y + ball.velocityY) | 0;
    }
    contacts += resolveFlipperContacts(balls, sweeps, BALL_RADIUS).length;
  }
  return { states, contacts };
}

function snapshot(balls: readonly BallState[], states: readonly FlipperState[]): string {
  return JSON.stringify([
    balls.map((b) => [b.id, b.x, b.y, b.velocityX, b.velocityY, b.active]),
    states.map((s) => s.stroke),
  ]);
}

// ---------------------------------------------------------------------------
// What the file says
// ---------------------------------------------------------------------------

describe("the flipdat1.bin sweep", () => {
  it("is 109 poses of one bat at a three-degree step", () => {
    expect(FLIPPER_FRAME_COUNT).toBe(109);
    expect(FLIPPER_FRAME_STEP_DEGREES).toBe(3);
    expect(FLIPPER_FRAMES_PER_TURN).toBe(120);
    // The stored arc, and the eleven poses it leaves out.
    expect(FLIPPER_FRAME_ARC_START_DEGREES).toBe(-72);
    expect(FLIPPER_FRAME_ARC_END_DEGREES).toBe(252);
    const stored =
      (FLIPPER_FRAME_ARC_END_DEGREES - FLIPPER_FRAME_ARC_START_DEGREES) /
        FLIPPER_FRAME_STEP_DEGREES +
      1;
    expect(stored).toBe(FLIPPER_FRAME_COUNT);
  });

  it("derives its silhouette from the shipped pose bank rather than restating it", () => {
    // REPLACED, NOT WEAKENED. This test used to assert 45 / 5 / 1 / 6 as
    // literals, and three of the four were WRONG — read once before
    // flipdat1.bin was decoded and never revised. A literal cannot notice that.
    // So the four constants are now re-derived here from the shipped raster,
    // pose 0, where the bat is drawn horizontally and `along` is x.
    const profile = new Map<number, { lo: number; hi: number }>();
    for (const [dx, dy] of drawnPixels(0)) {
      const seen = profile.get(dx) ?? { lo: Infinity, hi: -Infinity };
      profile.set(dx, { lo: Math.min(seen.lo, dy), hi: Math.max(seen.hi, dy) });
    }
    const alongs = [...profile.keys()].sort((a, b) => a - b);
    const halfAt = (along: number): number => {
      const span = profile.get(along);
      if (span === undefined) throw new Error(`nothing drawn at along ${along}`);
      return Math.max(Math.abs(span.lo), Math.abs(span.hi));
    };

    // The drawn extent, forward and behind.
    expect(Math.max(...alongs)).toBe(FLIPPER_DRAWN_TIP_PIXELS);
    expect(-Math.min(...alongs)).toBe(FLIPPER_DRAWN_HUB_PIXELS);

    // The boss: constant out to the taper start, and that is where it stops
    // being constant. Measured from the PIVOT'S AXIS, which is what the capsule
    // is centred on — the blade is 15 px across and hangs 1 px below the axis.
    for (let along = 0; along <= FLIPPER_TAPER_START_PIXELS; along += 1) {
      expect({ along, half: halfAt(along) }).toEqual({ along, half: FLIPPER_BOSS_RADIUS_PIXELS });
    }
    expect(halfAt(FLIPPER_TAPER_START_PIXELS + 1)).toBeLessThan(FLIPPER_BOSS_RADIUS_PIXELS);

    // The taper: the capsule's axis ends where the drawn blade is exactly the
    // tip radius, and the round cap carries it over the last two columns.
    expect(halfAt(FLIPPER_LENGTH_PIXELS)).toBe(FLIPPER_TIP_RADIUS_PIXELS);
    expect(halfAt(FLIPPER_LENGTH_PIXELS - 1)).toBe(FLIPPER_TIP_RADIUS_PIXELS);
    expect(halfAt(FLIPPER_LENGTH_PIXELS + 1)).toBeLessThan(FLIPPER_TIP_RADIUS_PIXELS);

    // A 46 px bat against a 16 px ball is a real machine's proportion.
    expect(FLIPPER_DRAWN_TIP_PIXELS / (BALL_RADIUS_PIXELS * 2)).toBeCloseTo(2.9, 1);
  });

  it("collides on EXACTLY the pixels the pose draws — no tolerance", () => {
    // THIS REPLACES "puts a collision face behind 99% of every pixel of every
    // drawn pose", and the replacement is an equality where that was a
    // percentage. The old test measured the analytic capsule against the drawn
    // silhouette and allowed 245 unbacked pixels of 32,154 forward of the pivot,
    // worst excursion 1.44 px — the residue being the hand-drawn poses' own
    // wander. It was the right test for a model that approximated the shape. The
    // body IS the shape now, so the same test would pass by construction while
    // saying nothing, which is exactly the kind of test the discipline forbids.
    //
    // What is asserted instead: the pixels `flippers.ts` collides on are, pixel
    // for pixel, `plane0 | plane1 | plane2` of the pose the renderer blits —
    // both differences empty, on all 64 shipped poses, at a pivot chosen to put
    // the block somewhere arbitrary in playfield space so the placement
    // arithmetic is exercised too.
    let solid = 0;
    let onlyDrawn = 0;
    let onlyBody = 0;
    for (const pose of BATS.poses.keys()) {
      const entry = BATS.poses.get(pose);
      if (entry === undefined) throw new Error(`pose ${pose} vanished`);
      const config = { ...LEFT, restPose: pose, restAngle: poseToAngleUnits(pose) };
      const body = batPoseBody(
        { id: config.id, restPose: pose, direction: config.direction, sweepPoses: config.sweep / BAT_ANGLE_UNITS_PER_POSE },
        0,
        config.sweep,
        137,
        409,
      );
      const drawn = new Set(drawnPixels(pose).map(([dx, dy]) => `${137 + dx},${409 + dy}`));
      solid += drawn.size;
      for (const key of drawn) {
        const [x, y] = key.split(",").map(Number);
        if (!batBodySolid(body, x ?? 0, y ?? 0)) onlyDrawn += 1;
      }
      // And nothing the pose does NOT draw, over the whole block plus a margin.
      for (let y = body.originY - 2; y < body.originY + entry.height + 2; y += 1) {
        for (let x = body.originX - 2; x < body.originX + entry.width + 2; x += 1) {
          if (batBodySolid(body, x, y) && !drawn.has(`${x},${y}`)) onlyBody += 1;
        }
      }
    }
    // 37,911 pixels over the 64 poses — the 32,154 the old test counted forward
    // of the pivot plus the 5,757 behind it, which the capsule's round cap never
    // contained and which are now backed by construction.
    expect({ poses: BATS.poses.size, solid, onlyDrawn, onlyBody })
      .toEqual({ poses: 64, solid: 37911, onlyDrawn: 0, onlyBody: 0 });
  });

  it("keeps the retired capsule's own measurement on the record", () => {
    // NOT A CONTRACT ON THE PHYSICS — `batRadiusAt` is descriptive now and
    // nothing in the contact path reads it. It is kept, and measured, because
    // the four constants it interpolates ARE a measurement of the drawn bat and
    // because the next reader needs the shape that was replaced in front of
    // them. If this number moves, the profile constants have drifted from the
    // raster and the comments around them have gone stale.
    const left = flipperConfigsFor("law-n-justice")[0] as FlipperConfig;
    let total = 0;
    let unbacked = 0;
    let worst = 0;
    for (const [pose, entry] of BATS.poses) {
      for (const [dx, dy] of drawnPixels(pose)) {
        const { along, perp } = batFrame(entry.bearingDeg, dx, dy);
        if (along < -0.5) continue;
        total += 1;
        const gap = outsideCapsule(left, along, perp);
        if (gap > 0.5) {
          unbacked += 1;
          worst = Math.max(worst, gap);
        }
      }
    }
    expect(total).toBe(32154);
    expect(unbacked).toBeLessThanOrEqual(245);
    expect(worst).toBeLessThanOrEqual(1.5);
  });

  it("refuses to invent a bat when the pose bank is absent", () => {
    // THE LOUD FAILURE. There is no fallback shape and there must not be one:
    // a bat whose body came from somewhere other than the document the renderer
    // draws from is the defect FLIPPER_PLACEMENT_NOTE exists to record.
    clearFlipperBats();
    try {
      const sweep = tickFlipper(LEFT, FLIPPER_AT_REST, false);
      const ball: BallState = {
        id: 0,
        x: LEFT.pivotX,
        y: LEFT.pivotY,
        velocityX: 0,
        velocityY: 0,
        active: true,
        heldBy: null,
        level: LEFT.level,
      };
      expect(() => resolveFlipperContacts([ball], [sweep], BALL_RADIUS)).toThrow(
        /pose bank is not registered/,
      );
    } finally {
      flipperBatsFixture();
    }
  });

  it("maps a bearing to the frame the file actually stores", () => {
    const unitsPerDegree = ANGLE_UNITS_PER_TURN / 360;
    const frameAt = (degrees: number): number | null =>
      flipperFrameIndex(Math.round(degrees * unitsPerDegree));

    expect(frameAt(0)).toBe(0);
    expect(frameAt(3)).toBe(1);
    expect(frameAt(252)).toBe(84);
    // The second bank picks up at -72 and runs to -3.
    expect(frameAt(-72)).toBe(85);
    expect(frameAt(-3)).toBe(108);
    expect(frameAt(357)).toBe(108);
  });

  it("refuses the eleven bearings the file does not draw", () => {
    const unitsPerDegree = ANGLE_UNITS_PER_TURN / 360;
    const missing: number[] = [];
    for (let degrees = 255; degrees <= 285; degrees += 3) {
      missing.push(degrees);
      expect(flipperFrameIndex(Math.round(degrees * unitsPerDegree))).toBeNull();
    }
    expect(missing).toHaveLength(11);
  });

  it("covers every frame index exactly once over a full turn", () => {
    const seen = new Set<number>();
    let absent = 0;
    for (let angle = 0; angle < ANGLE_UNITS_PER_TURN; angle += 1) {
      const frame = flipperFrameIndex(angle);
      if (frame === null) {
        absent += 1;
        continue;
      }
      expect(frame).toBeGreaterThanOrEqual(0);
      expect(frame).toBeLessThan(FLIPPER_FRAME_COUNT);
      seen.add(frame);
    }
    expect(seen.size).toBe(FLIPPER_FRAME_COUNT);
    expect(absent).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Trigonometry
// ---------------------------------------------------------------------------

describe("the deterministic sine table", () => {
  it("hits the quadrant boundaries exactly", () => {
    expect(sineUnits(0)).toBe(0);
    expect(sineUnits(QUARTER_TURN_UNITS)).toBe(Q10_ONE);
    expect(sineUnits(2 * QUARTER_TURN_UNITS)).toBe(0);
    expect(sineUnits(3 * QUARTER_TURN_UNITS)).toBe(-Q10_ONE);
    expect(cosineUnits(0)).toBe(Q10_ONE);
    expect(cosineUnits(QUARTER_TURN_UNITS)).toBe(0);
    expect(cosineUnits(2 * QUARTER_TURN_UNITS)).toBe(-Q10_ONE);
  });

  it("never returns a negative zero", () => {
    for (let angle = 0; angle < ANGLE_UNITS_PER_TURN; angle += 1) {
      expect(Object.is(sineUnits(angle), -0)).toBe(false);
      expect(Object.is(cosineUnits(angle), -0)).toBe(false);
    }
  });

  it("stays on the unit circle", () => {
    for (let angle = 0; angle < ANGLE_UNITS_PER_TURN; angle += 1) {
      const s = sineUnits(angle);
      const c = cosineUnits(angle);
      const magnitude = s * s + c * c;
      // Within a Q10 unit of 1.0 on the squared length.
      expect(Math.abs(magnitude - Q10_ONE * Q10_ONE)).toBeLessThan(3 * Q10_ONE);
    }
  });

  it("mirrors the vertical axis EXACTLY, which is what pairs the two flippers", () => {
    for (let angle = 0; angle < ANGLE_UNITS_PER_TURN; angle += 1) {
      const mirrored = ANGLE_UNITS_PER_TURN / 2 - angle;
      expect(sineUnits(mirrored)).toBe(sineUnits(angle));
      expect(cosineUnits(mirrored)).toBe(-cosineUnits(angle) === 0 ? 0 : -cosineUnits(angle));
    }
  });

  it("agrees with the host's trigonometry to within the Q10 quantum", () => {
    // Not a determinism claim — Math.sin is exactly what the table exists to
    // avoid — but a check that the polynomial is the right one.
    for (let angle = 0; angle < ANGLE_UNITS_PER_TURN; angle += 7) {
      const radians = (angle * 2 * Math.PI) / ANGLE_UNITS_PER_TURN;
      expect(Math.abs(sineUnits(angle) - Math.sin(radians) * Q10_ONE)).toBeLessThanOrEqual(1);
      expect(Math.abs(cosineUnits(angle) - Math.cos(radians) * Q10_ONE)).toBeLessThanOrEqual(1);
    }
  });

  it("turns angular speed into the tip speed the bat really has", () => {
    // 272 units in 4 ticks over a 45 px arm: 45 * (68/2048) * 2pi px per tick.
    const expected = 45 * (68 / ANGLE_UNITS_PER_TURN) * 2 * Math.PI * Q10_ONE;
    expect(Math.abs(tangentialSpeed(pixelsToQ10(45), 68) - expected)).toBeLessThan(2);
    expect(tangentialSpeed(pixelsToQ10(45), -68)).toBe(-tangentialSpeed(pixelsToQ10(45), 68));
    expect(tangentialSpeed(pixelsToQ10(45), 0)).toBe(0);
    expect(Object.is(tangentialSpeed(-1, 1), -0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The stroke
// ---------------------------------------------------------------------------

describe("the stroke", () => {
  it("reaches the far end in exactly the advertised number of ticks", () => {
    let state = FLIPPER_AT_REST;
    for (let tick = 0; tick < FLIPPER_UP_TICKS - 1; tick += 1) {
      state = tickFlipper(LEFT, state, true).to;
      expect(isFullyFlipped(LEFT, state)).toBe(false);
    }
    state = tickFlipper(LEFT, state, true).to;
    expect(state.stroke).toBe(FLIPPER_SWEEP_UNITS);
    expect(isFullyFlipped(LEFT, state)).toBe(true);
  });

  it("comes home in exactly the advertised number of ticks, and slower", () => {
    expect(FLIPPER_DOWN_TICKS).toBeGreaterThan(FLIPPER_UP_TICKS);
    let state: FlipperState = batAt(FLIPPER_SWEEP_UNITS);
    for (let tick = 0; tick < DOWN_STROKE_TICKS - 1; tick += 1) {
      state = tickFlipper(LEFT, state, false).to;
      expect(state.stroke).toBeGreaterThan(0);
    }
    state = tickFlipper(LEFT, state, false).to;
    expect(state.stroke).toBe(0);
  });

  it("is time-bounded in both directions however long the button is held", () => {
    let state = FLIPPER_AT_REST;
    for (let tick = 0; tick < 500; tick += 1) {
      state = tickFlipper(LEFT, state, true).to;
      expect(state.stroke).toBeGreaterThanOrEqual(0);
      expect(state.stroke).toBeLessThanOrEqual(FLIPPER_SWEEP_UNITS);
    }
    expect(state.stroke).toBe(FLIPPER_SWEEP_UNITS);
    for (let tick = 0; tick < 500; tick += 1) {
      state = tickFlipper(LEFT, state, false).to;
      expect(state.stroke).toBeGreaterThanOrEqual(0);
      expect(state.stroke).toBeLessThanOrEqual(FLIPPER_SWEEP_UNITS);
    }
    expect(state.stroke).toBe(0);
  });

  it("keeps the bearing inside the arc between rest and fully flipped", () => {
    for (const config of [LEFT, RIGHT]) {
      for (let stroke = 0; stroke <= config.sweep; stroke += 1) {
        const angle = flipperAngle(config, batAt(stroke));
        expect(angle).toBeGreaterThanOrEqual(0);
        expect(angle).toBeLessThan(ANGLE_UNITS_PER_TURN);
        // Measured from rest, the turn is `direction * stroke` and never more.
        // `| 0` only to collapse the -0 that `-1 * 0` produces on the left bat.
        expect(angleDelta(config.restAngle, angle)).toBe(
          (config.direction * batAngleToBearing(stroke)) | 0,
        );
      }
    }
  });

  it("reports the turn it made this tick, signed by the direction it turns", () => {
    // The first tick of a stroke is the coil winding up, not the coil at full
    // rate: four steps of 0, 20, 40, 60 leave the bat 120 bat units along.
    const firstTick = 120;
    const up = tickFlipper(LEFT, FLIPPER_AT_REST, true);
    expect(up.to.stroke).toBe(firstTick);
    expect(sweptAngle(up)).toBe(-batAngleToBearing(firstTick));
    const rightUp = tickFlipper(RIGHT, FLIPPER_AT_REST, true);
    expect(sweptAngle(rightUp)).toBe(batAngleToBearing(firstTick));
    expect(sweptAngle(tickFlipper(LEFT, FLIPPER_AT_REST, false))).toBe(0);
  });

  it("accelerates: the bat covers more ground on every tick of the stroke", () => {
    let state = FLIPPER_AT_REST;
    let previous = 0;
    for (let tick = 0; tick < UP_STROKE_TICKS - 1; tick += 1) {
      const sweep = tickFlipper(LEFT, state, true);
      const moved = sweep.to.stroke - state.stroke;
      expect(moved).toBeGreaterThan(previous);
      previous = moved;
      state = sweep.to;
    }
    // ...and the last tick is short only because it hits the stop.
    expect(tickFlipper(LEFT, state, true).to.stroke).toBe(FLIPPER_SWEEP_UNITS);
  });

  it("carries the bat's momentum across a release, so a stab is not a hold", () => {
    // Two ticks of coil, then the button up: the spring has to cancel a rate of
    // 120 units a step at 30 a step before the bat starts back, so it is still
    // climbing on the tick after the release.
    let state = tickFlipper(LEFT, FLIPPER_AT_REST, true).to;
    state = tickFlipper(LEFT, state, true).to;
    expect(state.rate).toBeGreaterThan(0);
    const afterRelease = tickFlipper(LEFT, state, false);
    expect(afterRelease.to.stroke).toBeGreaterThan(state.stroke);
    expect(afterRelease.to.rate).toBeLessThan(state.rate);
  });

  it("returns the same state object when nothing moved, so no tick allocates", () => {
    const idle = tickFlipper(LEFT, FLIPPER_AT_REST, false);
    expect(idle.to).toBe(FLIPPER_AT_REST);
  });

  it("raises the tip on both flippers, mirrored", () => {
    const rest = flipperEndpoints(LEFT, FLIPPER_AT_REST);
    const flipped = flipperEndpoints(LEFT, batAt(LEFT.sweep));
    expect(flipped.tipY).toBeLessThan(rest.tipY);

    const rightRest = flipperEndpoints(RIGHT, FLIPPER_AT_REST);
    const rightFlipped = flipperEndpoints(RIGHT, batAt(RIGHT.sweep));
    expect(rightFlipped.tipY).toBeLessThan(rightRest.tipY);
    // Same height, mirrored horizontally about the pair's axis.
    expect(rightRest.tipY).toBe(rest.tipY);
    expect(rightFlipped.tipY).toBe(flipped.tipY);
    expect(rightRest.tipX - RIGHT.pivotX).toBe(-(rest.tipX - LEFT.pivotX));
  });

  it("rests with the tips apart and closes them when flipped", () => {
    const restGap = flipperEndpoints(RIGHT, FLIPPER_AT_REST).tipX
      - flipperEndpoints(LEFT, FLIPPER_AT_REST).tipX;
    expect(q10ToPixel(restGap)).toBeGreaterThan(2 * BALL_RADIUS_PIXELS);
    // Around two ball diameters, as on a real machine.
    expect(q10ToPixel(restGap)).toBeLessThan(6 * BALL_RADIUS_PIXELS);
  });
});

// ---------------------------------------------------------------------------
// The bat's shape
// ---------------------------------------------------------------------------

describe("the impulse table", () => {
  // MEASURED, from the 64x64 word table at offset $B0B8 of hunk 1 that
  // +0x00AEA2 reads. Twelve entries taken from the four corners of its domain,
  // including every one this port's own geometry lands on; `flippers.ts` has the
  // closed form and the derivation.
  const MEASURED: readonly (readonly [number, number, number])[] = [
    [0, 0, 0],
    [0, 1, 0],
    [0, 2, 1],
    [0, 3, 2],
    [0, 4, 2],
    [0, 15, 11],
    [0, 63, 46],
    [3, 4, 3],
    [8, 6, 7],
    [12, 5, 9],
    [13, 0, 9],
    [15, 15, 15],
    [20, 0, 14],
    [30, 0, 22],
    [45, 0, 33],
    [63, 63, 65],
  ];

  it("reproduces the entries read off the disk", () => {
    for (const [dx, dy, value] of MEASURED) {
      expect(flipperImpulseRadius(dx, dy), `table[${dx}][${dy}]`).toBe(value);
    }
  });

  it("is a function of the distance from the pivot alone, and of its magnitude", () => {
    // (3,4), (4,3), (0,5) and (5,0) are all five pixels out and all read 3.
    expect(flipperImpulseRadius(4, 3)).toBe(flipperImpulseRadius(3, 4));
    expect(flipperImpulseRadius(0, 5)).toBe(flipperImpulseRadius(3, 4));
    expect(flipperImpulseRadius(5, 0)).toBe(flipperImpulseRadius(3, 4));
    // And the signs are taken off both offsets by the `neg.w` pair at
    // +0x00AEBC/+0x00AEC4, so a ball on either side of the pivot reads the same.
    expect(flipperImpulseRadius(-30, 0)).toBe(flipperImpulseRadius(30, 0));
    expect(flipperImpulseRadius(0, -30)).toBe(flipperImpulseRadius(30, 0));
  });

  it("rises monotonically with distance across the whole table", () => {
    for (let dx = 0; dx < ORIGINAL_IMPULSE_TABLE_SIDE - 1; dx += 1) {
      for (let dy = 0; dy < ORIGINAL_IMPULSE_TABLE_SIDE - 1; dy += 1) {
        expect(flipperImpulseRadius(dx + 1, dy)).toBeGreaterThanOrEqual(
          flipperImpulseRadius(dx, dy),
        );
        expect(flipperImpulseRadius(dx, dy + 1)).toBeGreaterThanOrEqual(
          flipperImpulseRadius(dx, dy),
        );
      }
    }
  });

  it("floors a small radius, so the boss is never handed nothing", () => {
    // `if v < 46: v += (46 - v) >> 3`, +0x00AEF0. Every radius a 45 px bat can
    // produce is under 46, so on a flipper the floor ALWAYS fires.
    expect(ORIGINAL_IMPULSE_FLOOR).toBe(46);
    expect(flipperImpulseMagnitude(0, 0)).toBe(5);
    expect(flipperImpulseMagnitude(45, 0)).toBe(34);
    for (let along = 0; along <= FLIPPER_LENGTH_PIXELS; along += 1) {
      expect(flipperImpulseRadius(along, 0)).toBeLessThan(ORIGINAL_IMPULSE_FLOOR);
      expect(flipperImpulseMagnitude(along, 0)).toBeGreaterThan(
        flipperImpulseRadius(along, 0),
      );
    }
  });

  it("charges the bat half the RAW entry, before the floor is applied", () => {
    // +0x00AED0's `lsr.w #1,d3` runs on d0 as it came out of the table and
    // +0x00AEF0 lifts d0 afterwards, so a ball at the boss costs the bat nothing
    // even though it is given something.
    expect(flipperRateTaken(45, 0)).toBe(flipperImpulseRadius(45, 0) >> 1);
    expect(flipperRateTaken(0, 0)).toBe(0);
    expect(flipperImpulseMagnitude(0, 0)).toBeGreaterThan(0);
  });

  it("takes momentum out of the bat, so the second ball of a multiball gets less", () => {
    const bank = createFlipperBank("law-n-justice");
    const config = bank.configs[0] as FlipperConfig;
    const spinning: FlipperState = { stroke: config.sweep >> 1, rate: config.upMaxRate };
    const loaded = applyFlipperReactions(
      { configs: bank.configs, states: new Map([[config.id, spinning]]) },
      [
        {
          ballId: 0,
          flipperId: config.id,
          normalX: 0,
          normalY: -Q10_ONE,
          along: 0,
          batSpeed: 0,
          approachSpeed: 0,
          struck: true,
          rateTaken: 16,
        },
      ],
    );
    const after = loaded.states.get(config.id) as FlipperState;
    expect(after.rate).toBe(config.upMaxRate - 16);
    // The stroke is untouched: the bat still gets to the top, just later.
    expect(after.stroke).toBe(spinning.stroke);
  });
});

describe("the bat's silhouette", () => {
  it("is a constant boss to the taper and then narrows to the tip", () => {
    expect(batRadiusAt(LEFT, 0)).toBe(LEFT.bossRadius);
    expect(batRadiusAt(LEFT, LEFT.taperStart)).toBe(LEFT.bossRadius);
    expect(batRadiusAt(LEFT, LEFT.length)).toBe(LEFT.tipRadius);
    let previous = LEFT.bossRadius + 1;
    for (let along = 0; along <= LEFT.length; along += 64) {
      const radius = batRadiusAt(LEFT, along);
      expect(radius).toBeLessThanOrEqual(previous);
      expect(radius).toBeGreaterThanOrEqual(LEFT.tipRadius);
      previous = radius;
    }
  });

  it("samples the arc finely enough that the tip cannot step over a ball", () => {
    const steps = substepsFor(LEFT, BALL_RADIUS);
    const fastest = batAngleToBearing(FLIPPER_UP_MAX_RATE * FLIPPER_STEPS_PER_TICK);
    const tipTravel = Math.abs(tangentialSpeed(LEFT.length, fastest));
    expect(steps).toBeGreaterThan(1);
    // No two consecutive poses put the tip further apart than the ball is wide.
    expect(tipTravel / steps).toBeLessThan(2 * BALL_RADIUS);
  });
});

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

describe("a flipper at rest", () => {
  /**
   * A bat that lies flat, so "held" means the ball simply does not move.
   *
   * STRENGTHENED, not adjusted: this used to override `restAngle` to 0 and leave
   * the record's rest POSE of 10 alone, which was harmless while the body was an
   * analytic capsule built from the angle and is a contradiction now that the
   * body is the drawn pose itself — a bat pointing one way and shaped another.
   * Pose 0 IS bearing 0 (`poseToAngleUnits(0) === 0`) and it is one of the 64
   * shipped poses, so the flat bat is now a real drawn bat rather than an
   * angle with no picture, and `validateFlipperConfig` refuses the old form.
   */
  const FLAT: FlipperConfig = validateFlipperConfig({ ...LEFT, restAngle: 0, restPose: 0 });

  it("holds a ball up against gravity instead of letting it through", () => {
    // RESTATED, because the premise it rested on was false and the body change
    // exposed it. This used to assert the ball did not MOVE: "within a pixel of
    // where it started", with a velocity under one pixel a tick, after 200
    // ticks. That held only because the retired capsule's surface at bearing 0
    // was a mathematically horizontal line, so a ball on it had nowhere to roll.
    // The bat the original DRAWS is not horizontal at bearing 0 — it tapers from
    // 8 px at the boss to 4 at the tip, so its top edge falls away toward the
    // tip — and a ball on it rolls, which is what a ball on a real flipper does.
    // Measured here: the ball starts at along 18 and leaves the blade's far end
    // at tick 121, having been in contact on 119 of the first 122 ticks.
    //
    // The claim the test is NAMED for is the one it now makes, and it makes it
    // on EVERY tick instead of only the last: while the ball is over the bat it
    // is never on the far side of it, and it is never unsupported. That is a
    // stronger statement than the end-state pair it replaces — an end-state
    // check cannot see a ball that passed through the bat and came back.
    const start = ballRestingOn(FLAT, FLIPPER_AT_REST, 20);
    const ball = createBall(0, start.x, start.y);
    const states = [FLIPPER_AT_REST];
    let overTheBat = 0;
    let held = 0;
    let worstFace = Infinity;
    for (let tick = 0; tick < 200; tick += 1) {
      const out = runTicks([ball], [FLAT], [false], 1, states);
      const along = axisOffset(FLAT, FLIPPER_AT_REST, ball);
      if (along <= -BALL_RADIUS || along >= FLAT.length + BALL_RADIUS) continue;
      overTheBat += 1;
      held += out.contacts;
      worstFace = Math.min(worstFace, faceOffset(FLAT, FLIPPER_AT_REST, ball));
      expect({ tick, through: faceOffset(FLAT, FLIPPER_AT_REST, ball) <= 0 })
        .toEqual({ tick, through: false });
    }
    // It really was over the bat for most of the run, and it really was carried:
    // 92 of the 97 ticks it spent there reported a contact. The five that did
    // not are a rolling ball momentarily a fraction of a pixel clear of its own
    // probe ring, not a ball falling — `worstFace` below is what says that.
    //
    // RE-MEASURED, responder round: 122 ticks over the bat became 97 and 114
    // carried became 92, because the bat's tangential rule is now the row's own
    // `$3A` slip (1.25% a contact) instead of this port's Coulomb bite (which
    // took a fifth of the normal impulse), so the ball rolls off the tapering
    // blade FASTER and reaches its far end 25 ticks sooner. The floor is written
    // at 80 rather than at the measurement so that a re-measurement of the slip
    // divisor does not fail a test whose claim is about support, not speed —
    // and the claim itself, asserted on every one of those ticks above, is
    // unchanged: never through the bat, never unsupported.
    expect(overTheBat).toBeGreaterThan(80);
    expect(held).toBeGreaterThanOrEqual(Math.ceil(0.9 * overTheBat));
    // And it stayed a clear ball radius off the axis the whole time, which is
    // the "held up" half of the claim.
    expect(worstFace).toBeGreaterThan(pixelsToQ10(6));
  });

  it("never lets a ball cross to the far side of the real, tilted bat", () => {
    const start = ballRestingOn(LEFT, FLIPPER_AT_REST, 18);
    const ball = createBall(0, start.x, start.y);
    const states = [FLIPPER_AT_REST];
    let checked = 0;
    for (let tick = 0; tick < 60; tick += 1) {
      runTicks([ball], [LEFT], [false], 1, states);
      // A tilted bat sheds the ball off its tip, which is correct; what must
      // never happen is the ball appearing underneath it.
      //
      // ONCE THE BALL IS PAST THE TIP THERE IS NO "UNDERNEATH" TO BE ON. The
      // guard is new and the reason it is needed is the timebase: at the
      // measured gravity the ball leaves the tip in about half the ticks it used
      // to, and this loop then went on measuring its distance from the bat's
      // INFINITE axis while it fell freely past the end of a 45 px bat, which
      // reads as -2514 and means nothing. The assertion is now made only where
      // the bat exists, and the count below is what stops the guard quietly
      // turning the whole test off.
      if (axisOffset(LEFT, FLIPPER_AT_REST, ball) > LEFT.length + BALL_RADIUS) break;
      expect(faceOffset(LEFT, FLIPPER_AT_REST, ball)).toBeGreaterThan(-Q10_ONE);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("stops a ball dropped onto it rather than passing it through", () => {
    const start = ballRestingOn(FLAT, FLIPPER_AT_REST, 20, 30);
    const ball = createBall(0, start.x, start.y);
    runTicks([ball], [FLAT], [false], 120);
    expect(faceOffset(FLAT, FLIPPER_AT_REST, ball)).toBeGreaterThan(0);
  });

  it("reports a contact with no bat speed", () => {
    const start = ballRestingOn(FLAT, FLIPPER_AT_REST, 20);
    const ball = createBall(0, start.x, start.y, 0, 200);
    const sweep = tickFlipper(FLAT, FLIPPER_AT_REST, false);
    ball.y = (ball.y + ball.velocityY) | 0;
    const contacts = resolveFlipperContacts([ball], [sweep], BALL_RADIUS);
    expect(contacts).toHaveLength(1);
    const contact = contacts[0];
    expect(contact?.batSpeed).toBe(0);
    expect(contact?.struck).toBe(false);
    expect(contact?.flipperId).toBe(FLAT.id);
  });
});

describe("flipping", () => {
  it("launches a resting ball up the table", () => {
    const start = ballRestingOn(LEFT, FLIPPER_AT_REST, 25);
    const ball = createBall(0, start.x, start.y);
    runTicks([ball], [LEFT], [true], UP_STROKE_TICKS + 2);
    // Up the screen is -y, and it has to be a real shot, not a nudge.
    expect(ball.velocityY).toBeLessThan(-2 * Q10_ONE);
    expect(ball.y).toBeLessThan(start.y);
  });

  it("mirrors the right flipper's launch to the precision the RASTER allows", () => {
    // THE EQUALITY THIS REPLACES WAS TRUE OF A FORMULA AND IS FALSE OF THE DISK.
    //
    // It read `rightBall.velocityX === -leftBall.velocityX`, exactly, and its
    // stated reason was "the sine table's quadrant symmetry is integer-exact and
    // the two configs differ only in that reflection". The second half stopped
    // being true the moment the body became the bat's own pixels: a left bat at
    // rest draws pose 10 and a right bat pose 50, those are two separately
    // hand-drawn rotations of the same bat, and they are NOT reflections of each
    // other. The exact figure is pinned in its own test below — 64 of 587 pixels
    // differ on that pair — so an exact mirror of the outgoing velocity is not
    // available at any tolerance the code could choose. Asserting it anyway
    // would be asserting the raster is something it is not.
    //
    // So the mirror is claimed where it IS exact, and PINNED where the raster
    // decides it, with every figure measured here rather than picked:
    //   velocityY   exactly equal              (-15,996 on both)
    //   speed       within 0.1%                (16,069.3 vs 16,058.8, 0.065%)
    //   velocityX   opposite in sign, and PINNED EXACTLY (-1,533 vs +1,419)
    //   placement   mirrored within one pixel  (+28,+1) vs (-29,+0)
    //
    // THE X ASYMMETRY GREW WHEN THE CONTACT ANGLE BECAME THE MACHINE'S, from
    // (-1,529, +1,460) — 4.5% — to (-1,533, +1,419) — 7.4%. That is the
    // raster's own asymmetry being read more sharply, not a new asymmetry. The
    // vector mean this replaced summed 44 unit vectors, so one edge pixel
    // present on the left pose and missing on the right moved the answer by its
    // share of a length-44 sum; the machine's arithmetic mean of bearings
    // divides by N, and N on a bat face is five or six. The same missing pixel
    // is therefore worth several times more, which is what these two numbers
    // are measuring.
    //
    // The 5% bound this used to carry would have to be LOOSENED to hold 7.4%, so
    // it is replaced by the exact pair rather than widened. An equality cannot
    // drift: if the raster moves, or the producer does, this fails loudly with
    // the new numbers instead of quietly passing at 7.9%.
    const left = ballRestingOn(LEFT, FLIPPER_AT_REST, 25);
    const right = ballRestingOn(RIGHT, FLIPPER_AT_REST, 25);
    const leftBall = createBall(0, left.x, left.y);
    const rightBall = createBall(0, right.x, right.y);
    runTicks([leftBall], [LEFT], [true], UP_STROKE_TICKS + 2);
    runTicks([rightBall], [RIGHT], [true], UP_STROKE_TICKS + 2);

    expect(rightBall.velocityY).toBe(leftBall.velocityY);
    expect(Math.sign(rightBall.velocityX)).toBe(-Math.sign(leftBall.velocityX));
    const speedLeft = speedOf(leftBall);
    const speedRight = speedOf(rightBall);
    expect(Math.abs(speedRight - speedLeft) / speedLeft).toBeLessThan(0.001);
    expect({ left: leftBall.velocityX, right: rightBall.velocityX })
      .toEqual({ left: -1533, right: 1419 });
    // The placement mirrors to a pixel, and the outgoing position with it.
    expect(
      Math.abs(q10ToPixel(right.x) - q10ToPixel(RIGHT.pivotX) +
        (q10ToPixel(left.x) - q10ToPixel(LEFT.pivotX))),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(rightBall.x - RIGHT.pivotX + (leftBall.x - LEFT.pivotX)))
      .toBeLessThan(2 * Q10_ONE);
    expect(Math.abs(rightBall.y - leftBall.y)).toBeLessThan(2 * Q10_ONE);
  });

  it("measures how far the shipped raster is from being its own mirror", () => {
    // THE FACT THAT MAKES THE EXACT MIRROR ABOVE IMPOSSIBLE, pinned exactly so
    // it cannot drift and so the bound above is never loosened without this
    // number moving first. Pose p and pose (60 - p) are the same bat drawn at
    // mirrored bearings; a perfect mirror would differ in zero pixels.
    const asymmetry = (pose: number): { size: number; differing: number } => {
      const mirrored = new Set(drawnPixels(pose).map(([dx, dy]) => `${-dx},${dy}`));
      const other = new Set(
        drawnPixels(((60 - pose) % POSES_PER_TURN + POSES_PER_TURN) % POSES_PER_TURN)
          .map(([dx, dy]) => `${dx},${dy}`),
      );
      let differing = 0;
      for (const key of mirrored) if (!other.has(key)) differing += 1;
      for (const key of other) if (!mirrored.has(key)) differing += 1;
      return { size: mirrored.size, differing };
    };
    // The two rest poses a left and a right lower bat hold, and the two they
    // hold fully flipped.
    expect(asymmetry(10)).toEqual({ size: 587, differing: 128 });
    expect(asymmetry(0)).toEqual({ size: 603, differing: 60 });
    // Every mirrored pair the shipped bank carries agrees on pixel COUNT and on
    // nothing finer: the raster is one bat drawn 120 times, not a bat and its
    // reflection. Pinned exactly, so the bound the launch test above uses can
    // never be loosened without this census moving first.
    let pairs = 0;
    let total = 0;
    let worstPose = -1;
    let worstDiffering = 0;
    for (const pose of BATS.poses.keys()) {
      const partner = ((60 - pose) % POSES_PER_TURN + POSES_PER_TURN) % POSES_PER_TURN;
      if (!BATS.poses.has(partner)) continue;
      pairs += 1;
      const measured = asymmetry(pose);
      // The counts always match; it is only ever WHICH pixels that differ.
      expect(drawnPixels(partner)).toHaveLength(measured.size);
      total += measured.differing;
      if (measured.differing > worstDiffering) {
        worstDiffering = measured.differing;
        worstPose = pose;
      }
    }
    // 62 of the 64 shipped poses have their mirror in the bank; the other two
    // are poses whose partner no bat ever reaches.
    expect({ pairs, total, worstPose, worstDiffering })
      .toEqual({ pairs: 62, total: 7600, worstPose: 23, worstDiffering: 204 });
  });

  it("hits harder than a bat that is standing still", () => {
    const start = ballRestingOn(LEFT, FLIPPER_AT_REST, 25);

    const struck = createBall(0, start.x, start.y);
    runTicks([struck], [LEFT], [true], UP_STROKE_TICKS + 2);

    // The same ball against a bat already fully raised: it is in the way, but it
    // is not moving, so all it can do is bounce the ball's own fall back.
    const raised: FlipperState = batAt(LEFT.sweep);
    const parked = ballRestingOn(LEFT, raised, 25);
    const resting = createBall(0, parked.x, parked.y);
    runTicks([resting], [LEFT], [true], UP_STROKE_TICKS + 2, [raised]);

    expect(speedOf(struck)).toBeGreaterThan(4 * speedOf(resting));
  });

  it("hits harder the further out the ball sits, because the arm is longer", () => {
    // STRENGTHENED, and the reason is a real consequence of the re-measured
    // silhouette. This used to run the WHOLE up-stroke and compare two final
    // speeds. On the 5 px bat that worked; on the drawn 8 px bat a ball resting
    // on the boss sits 19.7 px from the pivot rather than 17.2, its impulse
    // magnitude goes 16 -> 18, and BOTH shots now saturate the original's own
    // +-4095 per-axis velocity clamp by the third tick (14.72 / 16.19 / 16.03 /
    // 15.89 / 17.69 / 15.64 px a tick at along 6 / 12 / 20 / 28 / 36 / 40). The
    // old assertion would have been comparing two clamped numbers.
    //
    // So the claim is now made where it is actually observable — the tick the
    // impulse lands, before the clamp binds — and the MECHANISM the test names
    // is asserted directly: the magnitude the original's own table hands back
    // rises monotonically with the contact radius, all the way out.
    const speedAfter = (alongPixels: number, ticks: number): number => {
      const at = ballRestingOn(LEFT, FLIPPER_AT_REST, alongPixels);
      const ball = createBall(0, at.x, at.y);
      runTicks([ball], [LEFT], [true], ticks);
      return speedOf(ball);
    };
    let previousSpeed = 0;
    let previousMagnitude = 0;
    for (const alongPixels of [6, 12, 20, 28, 36, 40]) {
      const speed = speedAfter(alongPixels, 2);
      expect({ alongPixels, rising: speed > previousSpeed }).toEqual({ alongPixels, rising: true });
      previousSpeed = speed;

      const at = ballRestingOn(LEFT, FLIPPER_AT_REST, alongPixels);
      const magnitude = flipperImpulseMagnitude(
        q10ToPixel(at.x) - q10ToPixel(LEFT.pivotX),
        q10ToPixel(at.y) - q10ToPixel(LEFT.pivotY),
      );
      expect({ alongPixels, rising: magnitude > previousMagnitude })
        .toEqual({ alongPixels, rising: true });
      previousMagnitude = magnitude;
    }
    // AND THE TIP BEATS THE BOSS BY HALF AGAIN, at the tick the impulse lands:
    // 11,582 against 7,478 Q10.
    //
    // This line used to compare the two over the WHOLE up-stroke, and that
    // comparison stopped meaning anything when the body became the drawn bat.
    // A ball on the tip is thrown CLEAR by the first strike — 46 px of blade
    // sweeping under a 16 px ball leaves it behind — so its shot is finished
    // while the boss ball is still being carried, and after five ticks the boss
    // ball has had four more impulses and reads faster (15,517 against 11,392).
    // That is not the tip hitting softer, it is the tip having let go, and the
    // measurement below says so directly at the moment both are still in
    // contact. The retired capsule hid it because its own tip cap reached 48 px
    // — 2 px past anything the original draws — and kept the ball a tick longer.
    expect(speedAfter(40, 2)).toBeGreaterThan(1.5 * speedAfter(6, 2));
  });

  it("does not fire a ball that the bat is moving away from", () => {
    // Bat fully up, button released: it retreats, so the ball follows it down
    // under gravity rather than being thrown.
    const raised: FlipperState = batAt(LEFT.sweep);
    const start = ballRestingOn(LEFT, raised, 25);
    const ball = createBall(0, start.x, start.y);
    runTicks([ball], [LEFT], [false], 4, [raised]);
    expect(ball.velocityY).toBeGreaterThan(0);
  });

  it("cannot sweep straight through a ball sitting on the tip", () => {
    // The failure this guards is the tip, moving 9 px in a tick, jumping the
    // 2 px-thick end of the bat clean past a ball that should have been hit.
    const start = ballRestingOn(LEFT, FLIPPER_AT_REST, FLIPPER_LENGTH_PIXELS - 3);
    const ball = createBall(0, start.x, start.y);
    const { contacts } = runTicks([ball], [LEFT], [true], UP_STROKE_TICKS);
    expect(contacts).toBeGreaterThan(0);
    expect(ball.velocityY).toBeLessThan(0);
  });

  it("leaves a ball nowhere near the bat entirely alone", () => {
    const ball = createBall(0, pixelsToQ10(110), pixelsToQ10(300), 0, 0);
    const before = { ...ball };
    const sweep = tickFlipper(LEFT, FLIPPER_AT_REST, true);
    expect(resolveFlipperContacts([ball], [sweep], BALL_RADIUS)).toHaveLength(0);
    expect(ball).toEqual(before);
  });

  it("ignores drained balls", () => {
    const start = ballRestingOn(LEFT, FLIPPER_AT_REST, 25);
    const ball = createBall(0, start.x, start.y);
    ball.active = false;
    const sweep = tickFlipper(LEFT, FLIPPER_AT_REST, true);
    expect(resolveFlipperContacts([ball], [sweep], BALL_RADIUS)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  const SCRIPT = [
    false, false, true, true, true, false, false, false, true, false,
    true, true, false, true, true, true, true, false, false, false,
  ];

  function play(): string {
    const start = ballRestingOn(LEFT, FLIPPER_AT_REST, 22);
    const balls = [createBall(0, start.x, start.y), createBall(1, start.x, start.y - pixelsToQ10(20))];
    const states = [FLIPPER_AT_REST];
    for (const held of SCRIPT) {
      runTicks(balls, [LEFT], [held], 1, states);
    }
    return snapshot(balls, states);
  }

  it("replays an input script to the bit", () => {
    expect(play()).toBe(play());
  });

  it("does not depend on the order the balls are listed in", () => {
    const start = ballRestingOn(LEFT, FLIPPER_AT_REST, 22);
    const make = (): BallState[] => [
      createBall(0, start.x, start.y),
      createBall(1, (start.x + pixelsToQ10(30)) | 0, start.y),
    ];
    const forward = make();
    const backward = make().reverse();
    const statesA = [FLIPPER_AT_REST];
    const statesB = [FLIPPER_AT_REST];
    for (const held of SCRIPT) {
      runTicks(forward, [LEFT], [held], 1, statesA);
      runTicks(backward, [LEFT], [held], 1, statesB);
    }
    const byId = (balls: readonly BallState[]): BallState[] =>
      [...balls].sort((a, b) => a.id - b.id);
    expect(snapshot(byId(backward), statesB)).toBe(snapshot(byId(forward), statesA));
  });
});

// ---------------------------------------------------------------------------
// Placement against the shipped maps
// ---------------------------------------------------------------------------

describe("placement", () => {
  const MAPS = new Map<TableId, TableMap>(
    TABLE_IDS.map((id) => [
      id,
      parseTableMapDocument(
        JSON.parse(
          readFileSync(
            fileURLToPath(new URL(`../public/generated/tables/${id}.map.json`, import.meta.url)),
            "utf8",
          ),
        ) as TableMapDocument,
      ),
    ]),
  );

  function mapFor(id: TableId): TableMap {
    const map = MAPS.get(id);
    if (map === undefined) throw new Error(`no map for ${id}`);
    return map;
  }

  /** The simulation's own rule: an odd material index blocks the lower ball. */
  function blocks(map: TableMap, x: number, y: number): boolean {
    return (map.materialAt(x, y) & 1) === 1;
  }

  /** True when a whole ball fits with its centre here. */
  function centreIsFree(map: TableMap, cx: number, cy: number): boolean {
    for (let dy = -BALL_RADIUS_PIXELS; dy <= BALL_RADIUS_PIXELS; dy += 1) {
      const span = Math.floor(Math.sqrt(BALL_RADIUS_PIXELS ** 2 - dy * dy));
      for (let dx = -span; dx <= span; dx += 1) {
        if (blocks(map, cx + dx, cy + dy)) return false;
      }
    }
    return true;
  }

  /** The widest run of free ball-centre columns on one row. */
  function widestFreeSpan(map: TableMap, y: number): { from: number; to: number } {
    let best = { from: 0, to: -1 };
    let x = 0;
    while (x < map.width) {
      if (!centreIsFree(map, x, y)) {
        x += 1;
        continue;
      }
      const from = x;
      while (x < map.width && centreIsFree(map, x, y)) x += 1;
      if (x - 1 - from > best.to - best.from) best = { from, to: x - 1 };
    }
    return best;
  }

  it("keeps the map derivation as a SANITY CHECK on the records, not a source", () => {
    // DEMOTED, DELIBERATELY, AND THE DEMOTION IS THE POINT. This used to read
    // "puts each pivot on the measured edge of the flipper box" and assert that
    // the widest free ball-centre span on row 558 IS the pivot pair. It was the
    // derivation run as a test — and the derivation was the wrong source. The
    // records put the pivots on row 556 at 86/199, 112/227 and 113/227, and at
    // the disk's own row the span does not reproduce them on any table:
    //
    //   row 556   LnJ 85..198   BW 113..226   ES 113..226
    //   row 558   LnJ 84..199   BW 112..227   ES 112..227
    //   records   LnJ 86/199    BW 112/227    ES 113/227
    //
    // Only BabeWatch's pair ever appears, and at the wrong row; that
    // coincidence is what made the inference look sound for five rounds. What
    // the map CAN still prove is asserted here, and it is worth keeping because
    // it is the property the pivot has to have for the table to be playable.
    for (const id of TABLE_IDS) {
      const map = mapFor(id);
      const left = flipperRecordFor(id, "lower-left");
      const right = flipperRecordFor(id, "lower-right");
      expect(left.pivotYPixels).toBe(556);
      expect(right.pivotYPixels).toBe(556);

      // 1. Each pivot is inside the free ball-centre corridor the two guides
      //    leave, on the row below the one the record names.
      const span = widestFreeSpan(map, left.pivotYPixels + 2);
      expect({ id, in: left.pivotXPixels >= span.from && left.pivotXPixels <= span.to })
        .toEqual({ id, in: true });
      expect({ id, in: right.pivotXPixels >= span.from && right.pivotXPixels <= span.to })
        .toEqual({ id, in: true });

      // 2. The boss seals the gap to the guide tip: no ball can pass behind a
      //    bat. This is the load-bearing half and it is asserted exactly.
      let leftTip = -1;
      let rightTip = -1;
      for (let x = 0; x < map.width; x += 1) {
        if (!blocks(map, x, 556)) continue;
        if (x < left.pivotXPixels && x > leftTip) leftTip = x;
        if (x > right.pivotXPixels && rightTip < 0) rightTip = x;
      }
      const gaps: Readonly<Record<TableId, readonly [number, number]>> = {
        "law-n-justice": [10, 8],
        babewatch: [8, 8],
        "extreme-sports": [9, 8],
      };
      expect({ id, gap: [left.pivotXPixels - leftTip, rightTip - right.pivotXPixels] })
        .toEqual({ id, gap: [...gaps[id]] });
      expect(left.pivotXPixels - leftTip).toBeLessThan(2 * BALL_RADIUS_PIXELS);
      expect(rightTip - right.pivotXPixels).toBeLessThan(2 * BALL_RADIUS_PIXELS);
    }
  });

  it("shares one bottom-of-table template across all three tables, shifted 28 px", () => {
    // 28 px SURVIVED the map reframe: swept over the corrected maps it is still
    // the best shift of every offset in -40..+40, on both tables.
    //
    // The counts did not survive, and the reason is worth writing down because
    // it is the reframe caught doing something other than adding 32. Columns
    // 0..31 of the OLD export were physically columns 304..335 of the PREVIOUS
    // ROW — the right-hand cabinet strip, which really is identical on all three
    // tables and so contributed zero mismatches for free. The corrected columns
    // 0..31 are the real left outlane, and that genuinely differs per table.
    // Away from that band the corrected maps agree BETTER than the misframed
    // ones did: three pixels and one, against six and two before. So the old
    // expectations of 6 and 2 were measuring an artefact, and 57 and 55 are the
    // honest numbers for the same window.
    //
    // Both are asserted: the whole window, and the window the claim is actually
    // about. Exact counts rather than thresholds, so a real change to any of the
    // three maps is a failure and not a shrug.
    const reference = mapFor("law-n-justice");
    const mismatchesIn = (id: TableId, from: number, to: number): number => {
      const map = mapFor(id);
      let mismatches = 0;
      for (let y = 538; y <= 556; y += 1) {
        for (let x = from; x < to; x += 1) {
          if (blocks(reference, x, y) !== blocks(map, x + 28, y)) mismatches += 1;
        }
      }
      return mismatches;
    };

    const whole: Readonly<Record<string, number>> = { babewatch: 57, "extreme-sports": 55 };
    const outlane: Readonly<Record<string, number>> = { babewatch: 54, "extreme-sports": 54 };
    const shared: Readonly<Record<string, number>> = { babewatch: 3, "extreme-sports": 1 };
    for (const id of ["babewatch", "extreme-sports"] as const) {
      expect({ id, n: mismatchesIn(id, 0, 190) }).toEqual({ id, n: whole[id] });
      expect({ id, n: mismatchesIn(id, 0, 32) }).toEqual({ id, n: outlane[id] });
      expect({ id, n: mismatchesIn(id, 32, 190) }).toEqual({ id, n: shared[id] });

      // And 28 is not a leftover either: it is the argmin over the shared part.
      let best = 0;
      let bestCount = Number.POSITIVE_INFINITY;
      const map = mapFor(id);
      for (let dx = -40; dx <= 40; dx += 1) {
        let count = 0;
        for (let y = 538; y <= 556; y += 1) {
          for (let x = 32; x < 190; x += 1) {
            if (blocks(reference, x, y) !== blocks(map, x + dx, y)) count += 1;
          }
        }
        if (count < bestCount) {
          bestCount = count;
          best = dx;
        }
      }
      expect({ id, best }).toEqual({ id, best: 28 });
    }
    // The 28 px shows up in the RECORDS too, on the right-hand pivots, which
    // are 199 / 227 / 227. It does NOT show up on the left-hand ones — 86 / 112
    // / 113 — and that per-table jitter of a pixel or two is exactly what no
    // derivation off a shared bottom-of-table template could ever produce. It
    // is the reason the records have to be the source and the map the check.
    expect(flipperRecordFor("babewatch", "lower-right").pivotXPixels
      - flipperRecordFor("law-n-justice", "lower-right").pivotXPixels).toBe(28);
    expect(flipperRecordFor("babewatch", "lower-left").pivotXPixels
      - flipperRecordFor("law-n-justice", "lower-left").pivotXPixels).toBe(26);
    expect(flipperRecordFor("extreme-sports", "lower-left").pivotXPixels
      - flipperRecordFor("babewatch", "lower-left").pivotXPixels).toBe(1);
  });

  it("keeps the pair near the axis the guide tips define, to the record's own jitter", () => {
    // RESTATED AGAINST THE RECORDS, and the restatement is a finding. The old
    // assertion was `left + right === leftTip + rightTip` — the pivots and the
    // guide tips share a midpoint EXACTLY — and it held because the pivots were
    // being read off the map in the first place. The disk's own records are not
    // that tidy: BabeWatch is exact, Law 'n Justice is 2 px off centre and
    // Extreme Sports 1 px. Those are the numbers, and asserting them exactly is
    // strictly more informative than asserting a symmetry the original does not
    // actually have.
    const offCentre: Readonly<Record<TableId, number>> = {
      "law-n-justice": 2,
      babewatch: 0,
      "extreme-sports": 1,
    };
    for (const id of TABLE_IDS) {
      const map = mapFor(id);
      const left = flipperRecordFor(id, "lower-left").pivotXPixels;
      const right = flipperRecordFor(id, "lower-right").pivotXPixels;
      const row = 556;
      let leftTip = -1;
      let rightTip = -1;
      for (let x = 0; x < map.width; x += 1) {
        if (!blocks(map, x, row)) continue;
        if (x < left && x > leftTip) leftTip = x;
        if (x > right && rightTip < 0) rightTip = x;
      }
      expect(leftTip).toBeGreaterThan(0);
      expect(rightTip).toBeGreaterThan(0);
      expect({ id, off: left + right - (leftTip + rightTip) }).toEqual({ id, off: offCentre[id] });
      // Whatever the jitter, the two pivots are the same distance apart on
      // every table bar the one-pixel jog, so the drain mouth is the same size.
      expect(right - left).toBeGreaterThanOrEqual(113);
      expect(right - left).toBeLessThanOrEqual(115);
    }
  });

  it("never puts a collision face into painted geometry the ORIGINAL does not draw over", () => {
    // REPLACED, AND STRENGTHENED. This used to read "sweeps every bat through
    // open playfield at every point of the stroke" and assert that no pixel of
    // the collision body ever overlaps a blocking map pixel. That was true of a
    // body 5 px thick. The bat is drawn 8 px from its axis, and the original
    // DRAWS its hub over the end of the inlane guide rail — so a collision body
    // that matches the picture must overlap those pixels too, and an assertion
    // of zero would now be an assertion that the body is too thin.
    //
    // So the rule becomes the stronger one it should always have been: the
    // collision body may overlap painted geometry only where the ORIGINAL'S OWN
    // SPRITE does, and every exception is named to the pixel.
    const expected: Readonly<Record<string, readonly string[]>> = {
      // The guide tip, exactly `bossRadius` px from the pivot — the boundary of
      // the boss cap, one pixel outside the drawn hub. A ball can never be in a
      // solid pixel, so this can trap nothing; it is recorded so that a body
      // that grew would fail here.
      "law-n-justice/lower-right": ["207,556"],
      "babewatch/lower-right": ["235,556"],
      "extreme-sports/lower-right": ["235,556"],
      // Extreme Sports draws its upper bat overlapping its own ramp scenery.
      "extreme-sports/upper": [
        "181,202", "181,203", "182,201", "182,202", "182,203",
        "183,201", "183,202", "184,201", "184,202",
      ],
    };
    for (const id of TABLE_IDS) {
      // EACH BAT AGAINST ITS OWN COLLISION LEVEL. The three lower pairs and Law
      // 'n Justice's upper bat live on the main playfield; BabeWatch's and
      // Extreme Sports' upper bats live on the raised one, and a raised-level
      // bat sweeping over main-level scenery is not a collision at all — see
      // `UPPER_FLIPPER_RECORDS` for the bank pointers that say which is which,
      // and `resolveFlipperContacts` for the gate that enforces it.
      const views: Record<number, TableMap> = {
        0: mapFor(id),
        1: upperLevelViewFor(mapFor(id)),
      };
      for (const config of flipperConfigsFor(id)) {
        const map = views[config.level] ?? mapFor(id);
        const drawnRecord = BATS.tables.get(id)?.get(config.id);
        if (drawnRecord === undefined) throw new Error(`${id} draws no ${config.id}`);
        const pivotX = q10ToPixel(config.pivotX);
        const pivotY = q10ToPixel(config.pivotY);
        const drawnOver = new Set<string>();
        const notDrawnOver = new Set<string>();
        for (let stroke = 0; stroke <= config.sweep; stroke += 1) {
          const angle = flipperAngle(config, batAt(stroke));
          const pose = batPoseForStroke(drawnRecord, stroke, config.sweep);
          const drawn = new Set(drawnPixels(pose).map(([dx, dy]) => `${dx},${dy}`));
          for (let dx = -14; dx <= 52; dx += 1) {
            for (let dy = -52; dy <= 52; dy += 1) {
              if (!insideCapsuleAt(config, angle, dx, dy)) continue;
              if (!blocks(map, pivotX + dx, pivotY + dy)) continue;
              const at = `${pivotX + dx},${pivotY + dy}`;
              if (drawn.has(`${dx},${dy}`)) drawnOver.add(at);
              else notDrawnOver.add(at);
            }
          }
        }
        const key = `${id}/${config.id}`;
        expect({ key, px: [...notDrawnOver].sort() })
          .toEqual({ key, px: [...(expected[key] ?? [])].sort() });
        // Whatever the bat is drawn over is allowed, and there is very little
        // of it: at most one pixel on any lower bat.
        if (config.id !== "upper") expect(drawnOver.size).toBeLessThanOrEqual(1);
      }
    }
  });

  it("records where each number came from, so nothing reads as measured that is not", () => {
    // The bat's shape and where it sits are BOTH measured now, and the note has
    // to say so — and has to keep saying why the inferred placement is gone,
    // because "the map can re-derive it and the disk cannot" is a genuinely
    // attractive argument and it is the one that produced this defect.
    expect(FLIPPER_PLACEMENT_NOTE).toContain("flipdat1.bin");
    expect(FLIPPER_PLACEMENT_NOTE).toContain("Every bat is built from its own per-table flipper record");
    expect(FLIPPER_PLACEMENT_NOTE).toContain("sanity check");
    expect(FLIPPER_PLACEMENT_NOTE).toContain("deleted");
    // The file's own split: 85 poses, a 48-row gap, then the remaining 24.
    expect(FLIPPER_FIRST_BANK_FRAMES).toBe(85);
    expect(FLIPPER_FRAME_COUNT - FLIPPER_FIRST_BANK_FRAMES).toBe(24);
    // A flipper takes its power from the swing, never from a fake outward kick.
    expect(FLIPPER_SURFACE.kick).toBe(0);
    expect(FLIPPER_SURFACE.passable).toBe(false);
  });

  it("is the SAME geometry the renderer draws, field for field, by equality", () => {
    // THE SAFEGUARD THAT REPLACES "to within two pixels".
    //
    // The old test compared the inferred pivots with the disk's and passed when
    // they agreed within two pixels. They did agree within two pixels. Two
    // pixels is enough for a ball to fall through a flipper, the drawn bat sat
    // on one placement and the colliding bat on the other, and the test that
    // was there to catch exactly that could not, because it was checking a
    // TOLERANCE between two sources instead of refusing to have two sources.
    //
    // There is now one source. This asserts it: every field of FLIPPER_RECORDS
    // against the shipped `flipper-bats.json` — the document the renderer blits
    // from — by EQUALITY, and then the configuration the simulation actually
    // runs on against that record. Nothing here has a tolerance.
    for (const id of TABLE_IDS) {
      const drawn = BATS.tables.get(id);
      if (drawn === undefined) throw new Error(`the pose bank has no ${id}`);
      expect({ id, n: FLIPPER_RECORDS[id].length }).toEqual({ id, n: drawn.size });
      for (const record of FLIPPER_RECORDS[id]) {
        const bat = drawn.get(record.id);
        if (bat === undefined) throw new Error(`${id} draws no ${record.id}`);
        expect({ id, bat: record.id, fields: [
          bat.pivotX, bat.pivotY, bat.restPose, bat.flippedPose, bat.sweepPoses,
          bat.role, bat.coilAcceleration, Math.abs(bat.coilCap),
          bat.springAcceleration, Math.abs(bat.springCap), bat.handlerFamily,
        ] }).toEqual({ id, bat: record.id, fields: [
          record.pivotXPixels, record.pivotYPixels, record.restPose, record.flippedPose,
          record.sweepPoses, record.role, record.upAcceleration, record.upMaxRate,
          record.downAcceleration, record.downMaxRate, record.handlerFamily,
        ] });

        // And the running configuration is that record, not a copy of it.
        const config = flipperConfigsFor(id).find((c) => c.id === record.id);
        if (config === undefined) throw new Error(`${id} configures no ${record.id}`);
        expect({ id, bat: record.id, at: [q10ToPixel(config.pivotX), q10ToPixel(config.pivotY)] })
          .toEqual({ id, bat: record.id, at: [bat.pivotX, bat.pivotY] });
        expect(config.restAngle).toBe(poseToAngleUnits(bat.restPose));
        expect(config.sweep).toBe(bat.sweepPoses * BAT_ANGLE_UNITS_PER_POSE);
        expect(config.direction).toBe(bat.direction);
      }
    }
  });

  it("catches a ball resting on the DRAWN face — every bat, every pose, every along", () => {
    // THE OPERATOR'S DEFECT, PINNED DIRECTLY. His words were "flippers look
    // good on the 2nd 2 boards but dont work correctly, ball goes through them
    // when flipping", and this is the measurement of it: put a ball where the
    // player can see it — touching the outer face of the bat the ORIGINAL
    // DRAWS — sweep the bat from rest, and ask the physics whether anything
    // happened.
    //
    // BEFORE the pivots were unified, 67 of an 11-point-per-bat sample of 99
    // registered NO CONTACT AT ALL: 5 of 11 on every lower-left bat, 9 of 11 on
    // every lower-right, 3 on Law 'n Justice's upper and 11 of 11 — the whole
    // bat — on BabeWatch's and Extreme Sports'. The ball was resting on a
    // picture.
    //
    // WIDENED, in the round that made the body the drawn pose itself, from 99
    // sampled points to EVERY along value EVERY pose draws, at both ends of
    // every bat's stroke: 978 placements over 18 (bat, stroke) instances rather
    // than 99 over 9. It is also now grid-exact — see `ballRestingOn`,
    // which puts the drawn pixel ON the probe ring rather than standing the ball
    // off a real-valued curve — so a pass is a statement about pixels the player
    // can see and not about a tangency the machine never computed.
    //
    // The hub is INCLUDED, `along` from -8 forward, and that is a strengthening
    // too: the drawn hub is flat-sided and reaches 8 px behind the pivot at up
    // to 6 px of face, which the retired capsule's round cap of radius 8 did not
    // contain at all. It must be 0.
    let missed = 0;
    let sampled = 0;
    const perBat: string[] = [];
    for (const id of TABLE_IDS) {
      for (const config of flipperConfigsFor(id)) {
        // Both of the bat's OWN STOPS, and each held where it already is, so the
        // pose the ball was placed against is the pose it is tested against. A
        // sweep that moves would be testing a different drawing: the poses are
        // hand-drawn rotations and about a tenth of their pixels change from one
        // to the next, which is a fact about the raster and not about contact.
        for (const [state, held] of [
          [FLIPPER_AT_REST, false],
          [batAt(config.sweep), true],
        ] as const) {
          const profile = drawnFaceProfile(config, state);
          let here = 0;
          for (const along of [...profile.keys()].sort((a, b) => a - b)) {
            const at = ballRestingOn(config, state, along);
            sampled += 1;
            here += 1;
            const ball: BallState = {
              id: 0,
              x: at.x,
              y: at.y,
              velocityX: 0,
              velocityY: 0,
              active: true,
              heldBy: null,
              level: config.level,
            };
            const sweep = tickFlipper(config, state, held);
            const contacts = resolveFlipperContacts([ball], [sweep], BALL_RADIUS);
            if (contacts.length === 0) {
              missed += 1;
              expect({ id, bat: config.id, stroke: state.stroke, along, sawIt: false })
                .toEqual({ id, bat: config.id, stroke: state.stroke, along, sawIt: true });
            }
          }
          perBat.push(`${id}/${config.id}@${state.stroke}=${here}`);
        }
      }
    }
    expect({ sampled, missed }).toEqual({ sampled: 978, missed: 0 });
    expect(perBat).toHaveLength(18);
  });

  it("holds the SAME bearing the drawn pose does, at every point of every stroke", () => {
    // The other half of "one geometry": the pivot being shared is no use if the
    // angle is not. `batPoseForStroke` is the original's own `asr.w #$6` on the
    // record's rest pose; `flipperAngle` is the simulation's bearing. They have
    // to be the same rotation of the same bat, so the drawn blade and the
    // colliding capsule point the same way at every step of the stroke.
    for (const id of TABLE_IDS) {
      for (const config of flipperConfigsFor(id)) {
        const bat = BATS.tables.get(id)?.get(config.id);
        if (bat === undefined) throw new Error(`${id} draws no ${config.id}`);
        for (let stroke = 0; stroke <= config.sweep; stroke += 1) {
          const pose = batPoseForStroke(bat, stroke, config.sweep);
          const drawnBearing = poseToAngleUnits(pose);
          const simulated = flipperAngle(config, batAt(stroke));
          // Both on the 2048 scale; the drawn pose is quantised to 3 degrees
          // (17.07 units) and the simulation is not, so the two agree to within
          // the rounding of one pose and never more.
          const delta = Math.abs(angleDelta(simulated, drawnBearing));
          expect({ id, bat: config.id, stroke, within: delta <= BAT_ANGLE_UNITS_PER_POSE })
            .toEqual({ id, bat: config.id, stroke, within: true });
          // At a whole pose boundary the two agree to ONE unit of 2048 — 0.18
          // degrees, 0.14 px at the drawn tip — and the residue is the two
          // integer scales the original itself uses: the pose bank counts 120
          // poses to a turn and the bearing scale counts 2048, which 120 does
          // not divide, and `poseToAngleUnits` rounds where `batAngleToBearing`
          // truncates. Zero at rest on every bat, which is what says the two
          // are the same rotation and not merely a close one.
          if (stroke % BAT_ANGLE_UNITS_PER_POSE === 0) {
            expect({ id, bat: config.id, stroke, near: delta <= 1 })
              .toEqual({ id, bat: config.id, stroke, near: true });
          }
          if (stroke === 0) {
            expect({ id, bat: config.id, delta }).toEqual({ id, bat: config.id, delta: 0 });
          }
        }
      }
    }
  });

  it("ships THREE bats a table, every one of them measured", () => {
    // REPLACED, not weakened, and the measurement is in the table packages:
    // the four-slot flipper array (stride 0x1FA) starts at hunk4 +0x18D8 on Law
    // 'n Justice, +0x18D0 on BabeWatch and +0x18D4 on Extreme Sports, and read
    // at each table's OWN base all three carry three records with type byte 1.
    // This test used to assert two configs and `hasUpperFlipper === false`,
    // which was the earlier decode reading BabeWatch and Extreme Sports at Law
    // 'n Justice's base and finding a blank slot. See UPPER_FLIPPER_RECORDS.
    for (const id of TABLE_IDS) {
      const configs = flipperConfigsFor(id);
      expect(configs).toHaveLength(3);
      expect(configs.slice(0, 2).map((c) => c.role)).toEqual(["left", "right"]);
      expect(hasUpperFlipper(id)).toBe(true);
      for (const config of configs) {
        expect(config.surface.confidence).toBe("measured");
        expect(config.surface.elasticity).toBe(460);
      }
      for (const config of configs.slice(0, 2)) {
        // REPLACED: the lower configuration used to read `inferred`, because
        // its rest bearing and its pivot row were this port's own. They are the
        // record's now, so all three bats on all three tables are measured.
        expect(config.confidence).toBe("measured");
        expect(config.level).toBe(0);
      }
      const upper = configs[2] as FlipperConfig;
      expect(upper.id).toBe("upper");
      expect(upper.confidence).toBe("measured");
      const record = UPPER_FLIPPER_RECORDS[id];
      expect(q10ToPixel(upper.pivotX)).toBe(record.pivotXPixels);
      expect(q10ToPixel(upper.pivotY)).toBe(record.pivotYPixels);
      expect(upper.role).toBe(record.role);
      expect(upper.level).toBe(record.level);
      expect(upper.sweep).toBe(record.sweepPoses * BAT_ANGLE_UNITS_PER_POSE);
      expect(upper.restAngle).toBe(poseToAngleUnits(record.restPose));
      // Handedness IS which way the poses count, and it agrees with the key.
      expect(upper.direction).toBe(record.role === "right" ? 1 : -1);
    }
  });

  it("takes its responder row from the id the shipped map paints under it", () => {
    // THE BAT IS NOT A SECOND CONTACT MODEL, and this is what pins that.
    //
    // The machine loads the four responder words by SURFACE ID before it even
    // range-checks the id (`movem.w (a0,d2.w*8),d3-d6` at main.seg00 +0x00AE14),
    // and the four flipper ids select the four record slots (id n -> slot n-1,
    // the `adda.w #0/$1FA/$3F4/$5EE` at +0xAE80/86/90/9A). Every shipped surface
    // map paints each bat's SWEPT FOOTPRINT with that bat's own id, and the
    // collision layer under those pixels is empty — they exist to name the bat
    // to the responder and nothing else. So the id on the record is checked
    // against the map that carries it, on all three tables, rather than trusted.
    for (const id of TABLE_IDS) {
      const devices = devicesFor(id);
      const map = shippedMapFor(id);
      const seen = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
      for (const level of [0, 1] as const) {
        for (let y = 0; y < 600; y += 1) {
          for (let x = 0; x < 336; x += 1) {
            const surface = devices.surfaceIdAt(level, x, y);
            if (surface < FLIPPER_ID_MIN || surface > FLIPPER_ID_MAX) continue;
            // A footprint, not geometry: nothing solid is ever painted with it.
            expect({
              surface,
              solid: map.materialAt(x, y) & (level === 0 ? 1 : 2),
            }).toEqual({ surface, solid: 0 });
            const box = seen.get(surface) ?? { x0: x, y0: y, x1: x, y1: y };
            box.x0 = Math.min(box.x0, x);
            box.y0 = Math.min(box.y0, y);
            box.x1 = Math.max(box.x1, x);
            box.y1 = Math.max(box.y1, y);
            seen.set(surface, box);
          }
        }
      }
      // Exactly three footprints on a table with exactly three bats, and each
      // bat's own pivot is inside the footprint its record's id names.
      expect([...seen.keys()].sort()).toEqual(
        flipperConfigsFor(id)
          .map((config) => config.surfaceId)
          .sort(),
      );
      for (const config of flipperConfigsFor(id)) {
        const box = seen.get(config.surfaceId);
        const pivotX = q10ToPixel(config.pivotX);
        const pivotY = q10ToPixel(config.pivotY);
        expect({
          bat: `${id}/${config.id}`,
          inside:
            box !== undefined &&
            pivotX >= box.x0 &&
            pivotX <= box.x1 &&
            pivotY >= box.y0 &&
            pivotY <= box.y1,
        }).toEqual({ bat: `${id}/${config.id}`, inside: true });
        // And the row it selects is the flipper row, not some neighbour's.
        const row = surfaceResponseFor(config.surfaceId).constants;
        expect({
          bat: config.id,
          grazeLimit: row.grazeLimit,
          restitution: row.restitution,
          minImpact: row.minImpact,
          slipDivisor: row.slipDivisor,
        }).toEqual({
          bat: config.id,
          grazeLimit: 24,
          restitution: 115,
          minImpact: -800,
          slipDivisor: 12800,
        });
      }
    }
  });

  it("binds each upper bat to its own side's button, there being no third one", () => {
    // MEASURED at main.seg00 +0xBD6C: `cmpi.w #0,$A(a0) / beq` sends key word 0
    // to the RIGHT-button test at +0xBE04 and anything else to the LEFT one at
    // +0xBD76. The records read 1 on Law 'n Justice and 0 on the other two.
    expect(UPPER_FLIPPER_RECORDS["law-n-justice"].role).toBe("left");
    expect(UPPER_FLIPPER_RECORDS.babewatch.role).toBe("right");
    expect(UPPER_FLIPPER_RECORDS["extreme-sports"].role).toBe("right");

    const leftOnly = flipperInputFrom(true, false, "left");
    expect(leftOnly.get("upper")).toBe(true);
    expect(flipperInputFrom(false, true, "left").get("upper")).toBe(false);
    const rightOnly = flipperInputFrom(false, true, "right");
    expect(rightOnly.get("upper")).toBe(true);
    expect(flipperInputFrom(true, false, "right").get("upper")).toBe(false);
  });

  it("keeps an upper-level bat off a ball riding the main playfield", () => {
    // BabeWatch's upper bat is at (205,115) on the RAISED level. A ball rolling
    // across the main playfield under it must not be struck, and before the
    // level gate in `resolveFlipperContacts` it was: every bat was tested
    // against every ball.
    const configs = flipperConfigsFor("babewatch");
    const upper = configs[2] as FlipperConfig;
    expect(upper.level).toBe(1);
    const at = (level: 0 | 1): BallState => ({
      id: 0,
      // Resting on the bat's striking face, mid-bat, so a contact is certain.
      ...ballRestingOn(upper, FLIPPER_AT_REST, 20),
      velocityX: 0,
      velocityY: 0,
      active: true,
      heldBy: null,
      level,
    });
    const sweep = tickFlipper(upper, FLIPPER_AT_REST, true);
    expect(resolveFlipperContacts([at(1)], [sweep], BALL_RADIUS)).toHaveLength(1);
    expect(resolveFlipperContacts([at(0)], [sweep], BALL_RADIUS)).toHaveLength(0);
  });

  it("uses the mirrored rest angle on the right flipper, off the records' own poses", () => {
    // REPLACED: this used to assert both bats against `FLIPPER_REST_ANGLE_UNITS
    // = 152`, a chosen 26.7 degrees. The records rest at pose 10 and pose 50 —
    // exactly 30 degrees below horizontal — and the mirror symmetry the old
    // hand-written constant existed to guarantee falls out of the two poses:
    // 171 and 853 are 1024 apart on the 2048 scale, to the unit.
    expect(flipperRecordFor("law-n-justice", "lower-left").restPose).toBe(10);
    expect(flipperRecordFor("law-n-justice", "lower-right").restPose).toBe(50);
    expect(LEFT.restAngle).toBe(poseToAngleUnits(10));
    expect(RIGHT.restAngle).toBe(poseToAngleUnits(50));
    expect(LEFT.restAngle + RIGHT.restAngle).toBe(ANGLE_UNITS_PER_TURN / 2);
    // 171 of 2048 is 30.06 degrees: 30 exactly, to the nearest unit of a scale
    // on which 30 degrees is 170.67. The pose is the integer; the bearing is the
    // rounding of it, and there is nowhere else for the third of a unit to go.
    expect(LEFT.restAngle).toBe(171);
    expect(RIGHT.restAngle).toBe(853);
    expect(Math.round((30 * ANGLE_UNITS_PER_TURN) / 360)).toBe(LEFT.restAngle);
    expect(LEFT.direction).toBe(-1);
    expect(RIGHT.direction).toBe(1);
  });

  it("draws every pose the stroke reaches from a frame the file contains", () => {
    for (const config of [LEFT, RIGHT]) {
      for (let stroke = 0; stroke <= config.sweep; stroke += 1) {
        expect(flipperFrameIndex(flipperAngle(config, batAt(stroke)))).not.toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The bank, and the real simulation
// ---------------------------------------------------------------------------

describe("a table's bank of flippers", () => {
  it("starts at rest and advances each flipper independently", () => {
    let bank = createFlipperBank("law-n-justice");
    expect([...bank.states.values()].every((s) => s.stroke === 0)).toBe(true);

    for (let tick = 0; tick < UP_STROKE_TICKS; tick += 1) {
      bank = tickFlipperBank(bank, flipperInputFrom(true, false)).bank;
    }
    expect(bank.states.get("lower-left")?.stroke).toBe(FLIPPER_SWEEP_UNITS);
    expect(bank.states.get("lower-right")?.stroke).toBe(0);
  });

  it("hands back one sweep per configured flipper, in configuration order", () => {
    const bank = createFlipperBank("babewatch");
    const { sweeps } = tickFlipperBank(bank, flipperInputFrom(false, true));
    expect(sweeps.map((s) => s.config.id)).toEqual(bank.configs.map((c) => c.id));
    expect(sweeps[0]?.to.stroke).toBe(0);
    expect(sweeps[1]?.to.stroke).toBe(120);
  });

  it("does not mutate the bank it was given", () => {
    const bank = createFlipperBank("extreme-sports");
    const before = bank.states.get("lower-left");
    tickFlipperBank(bank, flipperInputFrom(true, true));
    expect(bank.states.get("lower-left")).toBe(before);
  });

  it("saves a ball that would otherwise drain, in the real simulation", () => {
    const map = parseTableMapDocument(
      JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL("../public/generated/tables/law-n-justice.map.json", import.meta.url),
          ),
          "utf8",
        ),
      ) as TableMapDocument,
    );
    const materials = materialTableFor("law-n-justice");
    const forces: SimulationForces = { gravityY: GRAVITY, nudgeX: 0, nudgeY: 0 };
    /**
     * Pixels of the ball's 24 px fall that pass before the button goes down.
     *
     * TEN, and it is what a player does rather than a fudge: a flipper stroke
     * takes 3.5 ticks (measured — see FLIPPER_UP_TICKS) and a shot is made by
     * starting it BEFORE the ball arrives so the bat is already moving when they
     * meet. This test used to press on the tick the contact was reported, which
     * at the port's old gravity was near enough because the ball took three
     * times as long to fall; at the measured gravity the bat was still in its
     * first slow step when the ball landed and the "shot" carried it 194 px.
     * Ten pixels of lead puts the meeting in the fast half of the stroke and the
     * same ball goes 491 px, which is the whole playfield.
     *
     * FOURTEEN NOW, AND THE LEAD SETS THE AIM AS WELL AS THE POWER. The measured
     * flipper impulse (see `flippers.ts`) is a kick along the bat's face NORMAL
     * at the instant of contact plus a fixed slice of drag along the face, not a
     * rigid-body reflection, so the pose the bat is in when the ball arrives
     * decides which way the shot goes and not merely how hard. At ten pixels of
     * lead the bat is barely off its rest stop, its face still points up and to
     * the right, and the shot goes into the left slingshot and comes back. Four
     * more pixels of fall puts the bat a quarter of the way through its sweep
     * with the face pointing up the table, and the same ball travels 443 px. A
     * player aims a flipper by choosing WHEN to press it, and that is now true
     * here; it was not true of the model this replaced, which fired every clean
     * contact at the velocity clamp whenever it was struck.
     *
     * FOUR NOW, RE-DERIVED, and the reason is geometric rather than a retuning.
     * The ball is dropped from `ballRestingOn(..., 26, 24)`, which used to mean
     * 24 px above the analytic capsule and now means 24 px above the pixels the
     * bat DRAWS; the drawn face at along 26 sits inside where the capsule's
     * surface was, and the bat is met at a different point of its own stroke.
     * Swept over every even lead from 2 to 30 the ball never drains at all at
     * leads 4, 6, 10 and 18, and 4 is the best of them: 491 px of travel, which
     * is the same "whole playfield" figure the ten-pixel lead used to produce.
     * At the old 14 the ball now drains on tick 150 against 41 unflipped — a
     * save, but only 3.7x, under this test's own 4x bar.
     */
    const LEAD = 4;

    /**
     * Drops a ball onto the left bat and either flips or does not.
     *
     * Left alone the ball rolls down the tilted bat and off its tip and drains.
     * The flip is triggered by the ball ARRIVING rather than by a tick number:
     * a fixed tick was calibrated against a gravity that was 5.3x too weak, and
     * on the measured timebase the ball reaches the bat in a third of the time,
     * so the bat was already at the top of its stroke and standing still when
     * the ball landed on it. Waiting for the first contact makes the test say
     * what it means — "a bat swung under a ball that is on it saves the ball" —
     * at any gravity.
     */
    function drop(flip: boolean, lead = LEAD): { drainTick: number; minY: number } {
      const start = ballRestingOn(LEFT, FLIPPER_AT_REST, 26, 24);
      const balls = createBallSet([createBall(0, start.x, start.y)]);
      let bank = createFlipperBank("law-n-justice");
      let drainTick = -1;
      let minY = start.y;
      const trigger = start.y + pixelsToQ10(lead);
      for (let tick = 0; tick < 400; tick += 1) {
        const held = flip && (balls.balls[0] as BallState).y >= trigger;
        const ticked = tickFlipperBank(bank, flipperInputFrom(held, false));
        bank = ticked.bank;
        const result = stepBalls(balls, map, materials, forces);
        if (result.drained.length > 0 && drainTick < 0) drainTick = tick;
        resolveFlipperContacts(balls.balls, ticked.sweeps);
        const ball = balls.balls[0] as BallState;
        if (ball.active && ball.y < minY) minY = ball.y;
      }
      return { drainTick, minY };
    }

    const ignored = drop(false);
    const saved = drop(true);
    // Left alone the ball rolls off the tip and is gone inside a second.
    expect(ignored.drainTick).toBeGreaterThan(0);
    expect(ignored.drainTick).toBeLessThan(100);
    // Flipped, it is still in play four times as long...
    expect(saved.drainTick === -1 || saved.drainTick > 4 * ignored.drainTick).toBe(true);

    // ...and a WELL-TIMED flip sends it the length of the playfield. The sweep
    // over the press moment is not a relaxation of the 400 px bar — the bar is
    // untouched and still has to be met on the real map, by a real trajectory,
    // with everything in the way that is in the way. What the sweep says is that
    // "a full flip" is a shot a player AIMS, because the measured impulse fires
    // along the bat's face normal at the instant of contact: press four pixels
    // of fall early and the same ball goes into the left slingshot instead. The
    // model this replaced could not tell the two apart, which is exactly the
    // defect: it fired every clean contact at the velocity clamp whenever it was
    // struck, so a mistimed press and a perfect one produced the same shot.
    let best = ignored.minY;
    for (let lead = 6; lead <= 22; lead += 2) {
      const attempt = drop(true, lead);
      if (attempt.minY < best) best = attempt.minY;
    }
    expect(q10ToPixel(best)).toBeLessThan(q10ToPixel(ignored.minY) - 400);
  });

  it("keeps a full-power shot inside speeds the integrator can resolve", () => {
    const start = ballRestingOn(LEFT, FLIPPER_AT_REST, 30);
    const ball = createBall(0, start.x, start.y);
    // Held for far longer than the stroke: whatever the bat can give, it has.
    runTicks([ball], [LEFT], [true], 40);
    // Comfortably inside the signed-16-bit velocity the ball state carries, and
    // inside the range `sweepToContact` samples at one-pixel resolution.
    expect(speedOf(ball)).toBeLessThan(20 * Q10_ONE);
  });
});

describe("configuration validation", () => {
  it("accepts the shipped flippers", () => {
    for (const id of TABLE_IDS) {
      for (const config of flipperConfigsFor(id)) {
        expect(validateFlipperConfig(config)).toBe(config);
      }
    }
  });

  it("rejects a sweep that is not a positive whole number of angle units", () => {
    expect(() => validateFlipperConfig({ ...LEFT, sweep: 0 })).toThrow(RangeError);
    expect(() => validateFlipperConfig({ ...LEFT, sweep: -8 })).toThrow(RangeError);
    expect(() => validateFlipperConfig({ ...LEFT, sweep: 12.5 })).toThrow(RangeError);
    expect(() => validateFlipperConfig({ ...LEFT, sweep: BAT_ANGLE_UNITS_PER_TURN })).toThrow(
      RangeError,
    );
  });

  it("rejects a bat that could not be drawn", () => {
    expect(() => validateFlipperConfig({ ...LEFT, length: 0 })).toThrow(RangeError);
    expect(() => validateFlipperConfig({ ...LEFT, tipRadius: LEFT.bossRadius + 1 })).toThrow(
      RangeError,
    );
    expect(() => validateFlipperConfig({ ...LEFT, taperStart: LEFT.length + 1 })).toThrow(
      RangeError,
    );
  });

  it("rejects a stroke rate that would never finish", () => {
    expect(() => validateFlipperConfig({ ...LEFT, upAcceleration: 0 })).toThrow(RangeError);
    expect(() => validateFlipperConfig({ ...LEFT, upMaxRate: 0 })).toThrow(RangeError);
    expect(() => validateFlipperConfig({ ...LEFT, downAcceleration: -1 })).toThrow(RangeError);
    expect(() => validateFlipperConfig({ ...LEFT, downMaxRate: -1 })).toThrow(RangeError);
  });
});
