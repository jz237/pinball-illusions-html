import { describe, expect, it } from "vitest";
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
import { createBall, createBallSet, stepBalls } from "../src/game/ball-physics.js";
import { ANGLE_UNITS_PER_TURN, BALL_RADIUS_PIXELS, angleDelta } from "../src/game/collision-probe.js";
import { Q10_ONE, pixelsToQ10, q10Multiply, q10ToPixel } from "../src/core/fixed-point.js";
import type { Q10 } from "../src/core/fixed-point.js";
import type { FlipperConfig, FlipperState, FlipperSweep } from "../src/game/flippers.js";
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
  FLIPPER_LENGTH_PIXELS,
  FLIPPER_PLACEMENT_NOTE,
  FLIPPER_REST_ANGLE_UNITS,
  FLIPPER_SURFACE,
  FLIPPER_SWEEP_UNITS,
  FLIPPER_TAPER_START_PIXELS,
  FLIPPER_TIP_RADIUS_PIXELS,
  FLIPPER_UP_TICKS,
  LOWER_FLIPPER_PIVOT_COLUMNS,
  LOWER_FLIPPER_PIVOT_ROW,
  QUARTER_TURN_UNITS,
  batRadiusAt,
  cosineUnits,
  createFlipperBank,
  flipperAngle,
  flipperConfigsFor,
  flipperEndpoints,
  flipperFrameIndex,
  flipperInputFrom,
  hasUpperFlipper,
  isFullyFlipped,
  resolveFlipperContacts,
  sineUnits,
  substepsFor,
  sweptAngle,
  tangentialSpeed,
  tickFlipper,
  tickFlipperBank,
  validateFlipperConfig,
} from "../src/game/flippers.js";

const BALL_RADIUS: Q10 = pixelsToQ10(BALL_RADIUS_PIXELS);

/** The gravity the rest of the simulation is calibrated against. */
const GRAVITY = 24;

const LEFT = flipperConfigsFor("law-n-justice")[0] as FlipperConfig;
const RIGHT = flipperConfigsFor("law-n-justice")[1] as FlipperConfig;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A ball centre resting on the face the bat sweeps toward, `alongPixels` out
 * from the pivot and exactly touching.
 *
 * Built from the module's own geometry rather than hard-coded coordinates: the
 * point of these tests is the behaviour, and a placement recomputed here would
 * only re-test arithmetic that could drift from the collision routine's.
 */
function ballRestingOn(
  config: FlipperConfig,
  state: FlipperState,
  alongPixels: number,
  gap = 0,
): { x: Q10; y: Q10 } {
  const angle = flipperAngle(config, state);
  const axisX = cosineUnits(angle);
  const axisY = sineUnits(angle);
  const faceX = (-config.direction * axisY) | 0;
  const faceY = (config.direction * axisX) | 0;
  const along = pixelsToQ10(alongPixels);
  const standoff = batRadiusAt(config, along) + BALL_RADIUS + pixelsToQ10(gap);
  return {
    x: (config.pivotX + q10Multiply(along, axisX) + q10Multiply(standoff, faceX)) | 0,
    y: (config.pivotY + q10Multiply(along, axisY) + q10Multiply(standoff, faceY)) | 0,
  };
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

  it("carries the measured silhouette: 45 px long, 5 px at the boss, 1 px at the tip", () => {
    expect(FLIPPER_LENGTH_PIXELS).toBe(45);
    expect(FLIPPER_BOSS_RADIUS_PIXELS).toBe(5);
    expect(FLIPPER_TIP_RADIUS_PIXELS).toBe(1);
    expect(FLIPPER_TAPER_START_PIXELS).toBe(6);
    // A 45 px bat against a 16 px ball is a real machine's proportion.
    expect(FLIPPER_LENGTH_PIXELS / (BALL_RADIUS_PIXELS * 2)).toBeCloseTo(2.8, 1);
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
    let state: FlipperState = { stroke: FLIPPER_SWEEP_UNITS };
    for (let tick = 0; tick < FLIPPER_DOWN_TICKS - 1; tick += 1) {
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
        const angle = flipperAngle(config, { stroke });
        expect(angle).toBeGreaterThanOrEqual(0);
        expect(angle).toBeLessThan(ANGLE_UNITS_PER_TURN);
        // Measured from rest, the turn is `direction * stroke` and never more.
        // `| 0` only to collapse the -0 that `-1 * 0` produces on the left bat.
        expect(angleDelta(config.restAngle, angle)).toBe((config.direction * stroke) | 0);
      }
    }
  });

  it("reports the turn it made this tick, signed by the direction it turns", () => {
    const up = tickFlipper(LEFT, FLIPPER_AT_REST, true);
    expect(sweptAngle(up)).toBe(-LEFT.upRate);
    const rightUp = tickFlipper(RIGHT, FLIPPER_AT_REST, true);
    expect(sweptAngle(rightUp)).toBe(RIGHT.upRate);
    expect(sweptAngle(tickFlipper(LEFT, FLIPPER_AT_REST, false))).toBe(0);
  });

  it("returns the same state object when nothing moved, so no tick allocates", () => {
    const idle = tickFlipper(LEFT, FLIPPER_AT_REST, false);
    expect(idle.to).toBe(FLIPPER_AT_REST);
  });

  it("raises the tip on both flippers, mirrored", () => {
    const rest = flipperEndpoints(LEFT, FLIPPER_AT_REST);
    const flipped = flipperEndpoints(LEFT, { stroke: LEFT.sweep });
    expect(flipped.tipY).toBeLessThan(rest.tipY);

    const rightRest = flipperEndpoints(RIGHT, FLIPPER_AT_REST);
    const rightFlipped = flipperEndpoints(RIGHT, { stroke: RIGHT.sweep });
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
    const tipTravel = Math.abs(tangentialSpeed(LEFT.length, LEFT.upRate));
    expect(steps).toBeGreaterThan(1);
    // No two consecutive poses put the tip further apart than the ball is wide.
    expect(tipTravel / steps).toBeLessThan(2 * BALL_RADIUS);
  });
});

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

describe("a flipper at rest", () => {
  /** A bat that lies flat, so "held" means the ball simply does not move. */
  const FLAT: FlipperConfig = validateFlipperConfig({ ...LEFT, restAngle: 0 });

  it("holds a ball up against gravity instead of letting it through", () => {
    const start = ballRestingOn(FLAT, FLIPPER_AT_REST, 20);
    const ball = createBall(0, start.x, start.y);
    runTicks([ball], [FLAT], [false], 200);
    // Still on the striking face, and within a pixel of where it started.
    expect(faceOffset(FLAT, FLIPPER_AT_REST, ball)).toBeGreaterThan(0);
    expect(Math.abs(ball.y - start.y)).toBeLessThan(Q10_ONE);
    expect(Math.abs(ball.velocityY)).toBeLessThan(Q10_ONE);
  });

  it("never lets a ball cross to the far side of the real, tilted bat", () => {
    const start = ballRestingOn(LEFT, FLIPPER_AT_REST, 18);
    const ball = createBall(0, start.x, start.y);
    const states = [FLIPPER_AT_REST];
    for (let tick = 0; tick < 60; tick += 1) {
      runTicks([ball], [LEFT], [false], 1, states);
      // A tilted bat sheds the ball off its tip, which is correct; what must
      // never happen is the ball appearing underneath it.
      expect(faceOffset(LEFT, FLIPPER_AT_REST, ball)).toBeGreaterThan(-Q10_ONE);
    }
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
    runTicks([ball], [LEFT], [true], FLIPPER_UP_TICKS + 2);
    // Up the screen is -y, and it has to be a real shot, not a nudge.
    expect(ball.velocityY).toBeLessThan(-2 * Q10_ONE);
    expect(ball.y).toBeLessThan(start.y);
  });

  it("launches the mirrored ball on the right flipper by the same amount", () => {
    const left = ballRestingOn(LEFT, FLIPPER_AT_REST, 25);
    const right = ballRestingOn(RIGHT, FLIPPER_AT_REST, 25);
    const leftBall = createBall(0, left.x, left.y);
    const rightBall = createBall(0, right.x, right.y);
    runTicks([leftBall], [LEFT], [true], FLIPPER_UP_TICKS + 2);
    runTicks([rightBall], [RIGHT], [true], FLIPPER_UP_TICKS + 2);
    // Exactly mirrored, not merely similar: the sine table's quadrant symmetry
    // is integer-exact and the two configs differ only in that reflection.
    expect(rightBall.velocityY).toBe(leftBall.velocityY);
    expect(rightBall.velocityX).toBe(-leftBall.velocityX);
    expect(rightBall.x - RIGHT.pivotX).toBe(-(leftBall.x - LEFT.pivotX));
    expect(rightBall.y).toBe(leftBall.y);
  });

  it("hits harder than a bat that is standing still", () => {
    const start = ballRestingOn(LEFT, FLIPPER_AT_REST, 25);

    const struck = createBall(0, start.x, start.y);
    runTicks([struck], [LEFT], [true], FLIPPER_UP_TICKS + 2);

    // The same ball against a bat already fully raised: it is in the way, but it
    // is not moving, so all it can do is bounce the ball's own fall back.
    const raised: FlipperState = { stroke: LEFT.sweep };
    const parked = ballRestingOn(LEFT, raised, 25);
    const resting = createBall(0, parked.x, parked.y);
    runTicks([resting], [LEFT], [true], FLIPPER_UP_TICKS + 2, [raised]);

    expect(speedOf(struck)).toBeGreaterThan(4 * speedOf(resting));
  });

  it("hits harder the further out the ball sits, because the arm is longer", () => {
    const atBoss = ballRestingOn(LEFT, FLIPPER_AT_REST, 12);
    const atTip = ballRestingOn(LEFT, FLIPPER_AT_REST, 40);
    const bossBall = createBall(0, atBoss.x, atBoss.y);
    const tipBall = createBall(1, atTip.x, atTip.y);
    runTicks([bossBall], [LEFT], [true], FLIPPER_UP_TICKS + 2);
    runTicks([tipBall], [LEFT], [true], FLIPPER_UP_TICKS + 2);
    expect(speedOf(tipBall)).toBeGreaterThan(speedOf(bossBall));
  });

  it("does not fire a ball that the bat is moving away from", () => {
    // Bat fully up, button released: it retreats, so the ball follows it down
    // under gravity rather than being thrown.
    const raised: FlipperState = { stroke: LEFT.sweep };
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
    const { contacts } = runTicks([ball], [LEFT], [true], FLIPPER_UP_TICKS);
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

  it("puts each pivot on the measured edge of the flipper box", () => {
    // This is the derivation itself, run as a test: the pivots ARE the ends of
    // the widest free ball-centre span on the first row below the inlane guides.
    for (const id of TABLE_IDS) {
      const span = widestFreeSpan(mapFor(id), LOWER_FLIPPER_PIVOT_ROW);
      const columns = LOWER_FLIPPER_PIVOT_COLUMNS[id];
      expect({ id, ...span }).toEqual({ id, from: columns.left, to: columns.right });
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
    expect(LOWER_FLIPPER_PIVOT_COLUMNS.babewatch.left
      - LOWER_FLIPPER_PIVOT_COLUMNS["law-n-justice"].left).toBe(28);
  });

  it("keeps the pair symmetric about the axis the guide tips define", () => {
    for (const id of TABLE_IDS) {
      const columns = LOWER_FLIPPER_PIVOT_COLUMNS[id];
      const map = mapFor(id);
      // The guide tips are the last blocking pixels on row 556 either side.
      const row = 556;
      let leftTip = -1;
      let rightTip = -1;
      for (let x = 0; x < map.width; x += 1) {
        if (!blocks(map, x, row)) continue;
        if (x < columns.left && x > leftTip) leftTip = x;
        if (x > columns.right && rightTip < 0) rightTip = x;
      }
      expect(leftTip).toBeGreaterThan(0);
      expect(rightTip).toBeGreaterThan(0);
      // Same axis to the pixel: the guide tips' inner edges and the two pivots
      // share a midpoint, which is what says the pivots are on the table's own
      // line of symmetry rather than near it.
      expect(columns.left + columns.right).toBe(leftTip + rightTip);
      // And the boss seals the gap: no ball can pass behind the flipper.
      expect(columns.left - leftTip).toBeLessThan(2 * BALL_RADIUS_PIXELS);
    }
  });

  it("sweeps both bats through open playfield at every point of the stroke", () => {
    for (const id of TABLE_IDS) {
      const map = mapFor(id);
      for (const config of flipperConfigsFor(id)) {
        for (let stroke = 0; stroke <= config.sweep; stroke += 17) {
          const state: FlipperState = { stroke };
          const angle = flipperAngle(config, state);
          const axisX = cosineUnits(angle);
          const axisY = sineUnits(angle);
          for (let alongPixels = 0; alongPixels <= FLIPPER_LENGTH_PIXELS; alongPixels += 1) {
            const along = pixelsToQ10(alongPixels);
            const cx = q10ToPixel(config.pivotX + q10Multiply(along, axisX));
            const cy = q10ToPixel(config.pivotY + q10Multiply(along, axisY));
            const radius = q10ToPixel(batRadiusAt(config, along));
            for (let dy = -radius; dy <= radius; dy += 1) {
              for (let dx = -radius; dx <= radius; dx += 1) {
                if (dx * dx + dy * dy > radius * radius) continue;
                expect({ id, stroke, alongPixels, blocked: blocks(map, cx + dx, cy + dy) })
                  .toEqual({ id, stroke, alongPixels, blocked: false });
              }
            }
          }
        }
      }
    }
  });

  it("records where each number came from, so nothing reads as measured that is not", () => {
    // The bat's shape is measured; where it sits is not. Both halves of that
    // have to stay visible in the data or the next person will trust the wrong
    // one of them.
    expect(FLIPPER_PLACEMENT_NOTE).toContain("flipdat1.bin");
    expect(FLIPPER_PLACEMENT_NOTE).toContain("inferred");
    expect(FLIPPER_PLACEMENT_NOTE).toContain("upper flipper not located");
    // The file's own split: 85 poses, a 48-row gap, then the remaining 24.
    expect(FLIPPER_FIRST_BANK_FRAMES).toBe(85);
    expect(FLIPPER_FRAME_COUNT - FLIPPER_FIRST_BANK_FRAMES).toBe(24);
    // A flipper takes its power from the swing, never from a fake outward kick.
    expect(FLIPPER_SURFACE.kick).toBe(0);
    expect(FLIPPER_SURFACE.passable).toBe(false);
  });

  it("declares itself inferred, and says so about the missing upper flipper", () => {
    for (const id of TABLE_IDS) {
      const configs = flipperConfigsFor(id);
      expect(configs).toHaveLength(2);
      expect(configs.map((c) => c.role)).toEqual(["left", "right"]);
      for (const config of configs) {
        expect(config.confidence).toBe("inferred");
        expect(config.surface.confidence).toBe("inferred");
      }
      expect(hasUpperFlipper(id)).toBe(false);
    }
  });

  it("uses the mirrored rest angle on the right flipper", () => {
    expect(LEFT.restAngle).toBe(FLIPPER_REST_ANGLE_UNITS);
    expect(RIGHT.restAngle).toBe(ANGLE_UNITS_PER_TURN / 2 - FLIPPER_REST_ANGLE_UNITS);
    expect(LEFT.direction).toBe(-1);
    expect(RIGHT.direction).toBe(1);
  });

  it("draws every pose the stroke reaches from a frame the file contains", () => {
    for (const config of [LEFT, RIGHT]) {
      for (let stroke = 0; stroke <= config.sweep; stroke += 1) {
        expect(flipperFrameIndex(flipperAngle(config, { stroke }))).not.toBeNull();
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

    for (let tick = 0; tick < FLIPPER_UP_TICKS; tick += 1) {
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
    expect(sweeps[1]?.to.stroke).toBe(bank.configs[1]?.upRate);
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
     * Drops a ball onto the left bat and either flips or does not.
     *
     * Left alone the ball rolls down the tilted bat and off its tip, and drains
     * on tick 109; the budget is long enough to see that happen and long enough
     * for a flipped ball to complete its trip up the table and come back.
     */
    function drop(flip: boolean): { drained: boolean; minY: number } {
      const start = ballRestingOn(LEFT, FLIPPER_AT_REST, 26, 24);
      const balls = createBallSet([createBall(0, start.x, start.y)]);
      let bank = createFlipperBank("law-n-justice");
      let drained = false;
      let minY = start.y;
      for (let tick = 0; tick < 140; tick += 1) {
        // Flip once the ball has had time to arrive, then hold.
        const held = flip && tick >= 12;
        const ticked = tickFlipperBank(bank, flipperInputFrom(held, false));
        bank = ticked.bank;
        const result = stepBalls(balls, map, materials, forces);
        if (result.drained.length > 0) drained = true;
        resolveFlipperContacts(balls.balls, ticked.sweeps);
        const ball = balls.balls[0] as BallState;
        if (ball.active && ball.y < minY) minY = ball.y;
      }
      return { drained, minY };
    }

    const ignored = drop(false);
    const saved = drop(true);
    expect(ignored.drained).toBe(true);
    expect(saved.drained).toBe(false);
    // And not merely held: a full flip sends it the length of the playfield.
    expect(q10ToPixel(saved.minY)).toBeLessThan(q10ToPixel(ignored.minY) - 400);
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
    expect(() => validateFlipperConfig({ ...LEFT, sweep: ANGLE_UNITS_PER_TURN })).toThrow(RangeError);
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
    expect(() => validateFlipperConfig({ ...LEFT, upRate: 0 })).toThrow(RangeError);
    expect(() => validateFlipperConfig({ ...LEFT, downRate: -1 })).toThrow(RangeError);
  });
});
