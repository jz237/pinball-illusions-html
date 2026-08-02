/**
 * THE RATE TESTS.
 *
 * This file exists because of a defect that shipped, was found by PLAYING and
 * could not have been found by this suite: the ball moved as if it were in
 * space. Gravity was 24 Q10 per tick squared, inherited as a chosen value from
 * the sibling Pinball Dreams reconstruction and never measured, and a ball took
 * four and a half seconds to fall the length of the playfield where a real
 * machine takes about one.
 *
 * Eight hundred tests were green while that was true, and the reason is uniform:
 * every physics test in this project asserted a DIRECTION or a REACHABILITY —
 * the ball falls, the ball reaches the flippers, the ball drains, the plunge
 * clears the arch — and not one asserted a RATE. A simulation can satisfy every
 * one of those at any speed at all.
 *
 * So the tests here are all of the form "X happens within N ticks", and their
 * bounds are brackets around measured values rather than exact equalities: an
 * exact equality would fail on every unrelated change to the contact model and
 * would be deleted within a month, and a bracket that is 25% wide still catches
 * the 5.33x that got through. Where a number IS exact — the unit bridges, the
 * gravity, the clamp — it is asserted exactly, because those are decoded off the
 * disk and nothing is allowed to move them quietly.
 *
 * `timebase.ts` has the disassembly for every constant asserted below.
 */

import { describe, expect, it } from "vitest";

import {
  ORIGINAL_COLLISION_PASSES_PER_FRAME,
  ORIGINAL_FLIPPER_STEPS_PER_FRAME,
  ORIGINAL_GRAVITY_DEFAULT,
  ORIGINAL_GRAVITY_MAX,
  ORIGINAL_GRAVITY_MIN,
  ORIGINAL_SUBSTEPS_PER_FRAME,
  ORIGINAL_VELOCITY_CLAMP,
  ORIGINAL_X_TILT_DEFAULT,
  ORIGINAL_X_TILT_MAX,
  ORIGINAL_X_TILT_MIN,
  Q10_PER_ORIGINAL_ACCEL_UNIT,
  Q10_PER_ORIGINAL_VELOCITY_UNIT,
  SIMULATION_GRAVITY,
  SIMULATION_X_TILT,
  TICKS_PER_SECOND,
  VELOCITY_CLAMP_Q10,
  gravityForOption,
  originalVelocityToQ10,
  secondsToTicks,
} from "../src/game/timebase.js";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH, TABLE_IDS } from "../src/game/contracts.js";
import type {
  MaterialIndex,
  SimulationForces,
  TableMap,
  TableId,
} from "../src/game/contracts.js";
import { SOLID_BORDER_INDEX, materialTableFor } from "../src/game/materials.js";
import { createBall, createBallSet, stepBalls } from "../src/game/ball-physics.js";
import type { BallState } from "../src/game/contracts.js";
import { pixelsToQ10, q10ToPixel } from "../src/core/fixed-point.js";
import {
  FLIPPER_AT_REST,
  FLIPPER_LENGTH_PIXELS,
  ORIGINAL_IMPULSE_TANGENT,
  batRadiusAt,
  cosineUnits,
  createFlipperBank,
  flipperAngle,
  flipperConfigsFor,
  flipperImpulseMagnitude,
  flipperInputFrom,
  flipperRateTaken,
  resolveFlipperContacts,
  sineUnits,
  tickFlipper,
  tickFlipperBank,
} from "../src/game/flippers.js";
import type { FlipperConfig } from "../src/game/flippers.js";
import { BALL_RADIUS_PIXELS } from "../src/game/collision-probe.js";
import { q10Multiply } from "../src/core/fixed-point.js";
import { BUMPER_KICK, SLINGSHOT_KICK } from "../src/game/surface-physics.js";
import { LAUNCH_KICK } from "../src/game/plunger.js";
import {
  createGame,
  debugSnapshot,
  runTicks,
  startGame,
} from "../src/browser/game-loop.js";
import type { InputSource } from "../src/browser/game-loop.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { mapFor } from "./table-fixtures.js";

const OPEN = 0 as MaterialIndex;

/** An empty box the size of the real playfield, so a fall is a real fall. */
function emptyPlayfield(): TableMap {
  const pixels = new Uint8Array(PLAYFIELD_WIDTH * PLAYFIELD_HEIGHT);
  return {
    tableId: "babewatch",
    displayName: "empty playfield",
    width: PLAYFIELD_WIDTH,
    height: PLAYFIELD_HEIGHT,
    pixels,
    materialAt(x: number, y: number): MaterialIndex {
      if (!Number.isInteger(x) || !Number.isInteger(y)) return SOLID_BORDER_INDEX;
      if (x < 0 || y < 0 || x >= PLAYFIELD_WIDTH || y >= PLAYFIELD_HEIGHT) {
        return SOLID_BORDER_INDEX;
      }
      return OPEN;
    },
  };
}

const EMPTY = emptyPlayfield();
const MATERIALS = materialTableFor("babewatch");
const BALL_RADIUS = pixelsToQ10(BALL_RADIUS_PIXELS);

/** A ball centre `gap` pixels off the bat's striking face, `along` px out. */
function restingOn(
  config: FlipperConfig,
  alongPixels: number,
  gap: number,
): { readonly x: number; readonly y: number } {
  const angle = flipperAngle(config, FLIPPER_AT_REST);
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

/** Ticks for a ball released at rest from `fromY` to fall to `toY`. */
function ticksToFall(fromY: number, toY: number, gravityY: number): number {
  const set = createBallSet([createBall(0, pixelsToQ10(PLAYFIELD_WIDTH >> 1), pixelsToQ10(fromY))]);
  const ball = set.balls[0] as BallState;
  const forces: SimulationForces = { gravityY, nudgeX: 0, nudgeY: 0 };
  for (let tick = 1; tick <= 2000; tick += 1) {
    stepBalls(set, EMPTY, MATERIALS, forces, { topWallRows: 0, drainY: pixelsToQ10(toY) });
    if (!ball.active || ball.y >= pixelsToQ10(toY)) return tick;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// The constants, exactly
// ---------------------------------------------------------------------------

describe("the timebase", () => {
  it("runs one physics tick per PAL video frame", () => {
    expect(TICKS_PER_SECOND).toBe(50);
    expect(secondsToTicks(2)).toBe(100);
    // $50(a5) is ExecBase->VBlankFrequency and is used only to turn whole
    // seconds into frames; nothing in the game counts sub-steps.
    expect(secondsToTicks(10)).toBe(500);
  });

  it("carries the original's frame shape: four collision passes, eight sub-steps", () => {
    expect(ORIGINAL_COLLISION_PASSES_PER_FRAME).toBe(4);
    expect(ORIGINAL_SUBSTEPS_PER_FRAME).toBe(8);
    expect(ORIGINAL_FLIPPER_STEPS_PER_FRAME).toBe(4);
  });

  it("bridges the original's units by its integrator, not by this port's gravity", () => {
    // Eight sub-steps of `pos += v >> 1` is 4v of travel per frame, so one of the
    // original's velocity units is four Q10 per tick; one unit of per-sub-step
    // acceleration is eight of those. THE HALVING IS THE WHOLE POINT: without the
    // `asr.w #1` at +0x00B710 these would be 8 and 64, and the sub-step
    // hypothesis that started this work predicted exactly that 8x.
    expect(Q10_PER_ORIGINAL_VELOCITY_UNIT).toBe(4);
    expect(Q10_PER_ORIGINAL_ACCEL_UNIT).toBe(32);
    expect(originalVelocityToQ10(1)).toBe(4);
  });

  it("takes gravity from the shipped option record and gets 128", () => {
    expect(ORIGINAL_GRAVITY_DEFAULT).toBe(4);
    expect(SIMULATION_GRAVITY).toBe(128);
    expect(SIMULATION_GRAVITY).toBe(ORIGINAL_GRAVITY_DEFAULT * Q10_PER_ORIGINAL_ACCEL_UNIT);
    // The player's slider, and the reason 24 was never a candidate: it is 2.7x
    // below the WEAKEST setting the original ships.
    expect(gravityForOption(ORIGINAL_GRAVITY_MIN)).toBe(64);
    expect(gravityForOption(ORIGINAL_GRAVITY_MAX)).toBe(256);
    expect(gravityForOption(ORIGINAL_GRAVITY_MIN)).toBeGreaterThan(24 * 2);
  });

  it("clamps velocity where the original does, which cross-checks the bridge", () => {
    expect(ORIGINAL_VELOCITY_CLAMP).toBe(4095);
    expect(VELOCITY_CLAMP_Q10).toBe(16380);
    // 4095 >> 1 is 2047 Q10, one unit under two pixels: the clamp is chosen so
    // the ball cannot move two pixels between collision passes, and that only
    // makes sense at four Q10 per unit.
    // The original's sub-step is `pos_Q10 += v >> 1` with pos already in Q10, so
    // the clamped sub-step displacement IS 4095>>1 Q10 — 2047, one unit under
    // two whole pixels. Read at any other velocity scale that number is
    // meaningless; at four Q10 per unit it is a designed anti-tunnelling bound.
    expect(ORIGINAL_VELOCITY_CLAMP >> 1).toBe(2047);
    expect(ORIGINAL_VELOCITY_CLAMP >> 1).toBeLessThan(pixelsToQ10(2));
    expect(ORIGINAL_VELOCITY_CLAMP >> 1).toBeGreaterThan(pixelsToQ10(2) - 4);
    // Sixteen pixels a tick, 800 px a second, over the whole frame.
    expect(VELOCITY_CLAMP_Q10 / ORIGINAL_SUBSTEPS_PER_FRAME).toBe(2047.5);
    expect(VELOCITY_CLAMP_Q10).toBeLessThan(pixelsToQ10(16));
  });

  it("applies option record 4, the table x-tilt, on the same footing as gravity", () => {
    // MEASURED at +0x00B758: the ramp drive, the x-tilt and gravity are resolved
    // into ONE acceleration and added to the ball's velocity in the same pair of
    // instructions, so the x-tilt takes the same unit bridge gravity does. The
    // shipped value is 0 on all three tables, which is why this asserts the
    // WIRING rather than an effect: an option measured and then left
    // unconnected reads exactly like an option that was never measured.
    expect(ORIGINAL_X_TILT_MIN).toBe(-3);
    expect(ORIGINAL_X_TILT_MAX).toBe(3);
    expect(ORIGINAL_X_TILT_DEFAULT).toBe(0);
    expect(SIMULATION_X_TILT).toBe(0);
    // Full scale is three quarters of gravity of permanent lateral lean.
    expect(ORIGINAL_X_TILT_MAX * Q10_PER_ORIGINAL_ACCEL_UNIT).toBe(96);
    expect(ORIGINAL_X_TILT_MAX * Q10_PER_ORIGINAL_ACCEL_UNIT / SIMULATION_GRAVITY).toBe(0.75);

    const balls = createBallSet([createBall(0, pixelsToQ10(168), pixelsToQ10(200))]);
    const ball = balls.balls[0] as BallState;
    const leaning: SimulationForces = {
      gravityY: SIMULATION_GRAVITY,
      tiltX: ORIGINAL_X_TILT_MAX * Q10_PER_ORIGINAL_ACCEL_UNIT,
      nudgeX: 0,
      nudgeY: 0,
    };
    for (let tick = 0; tick < 10; tick += 1) stepBalls(balls, EMPTY, MATERIALS, leaning);
    expect(ball.velocityX).toBe(10 * (leaning.tiltX ?? 0));

    // ...and the shipped default really is inert.
    const shipped = createBallSet([createBall(0, pixelsToQ10(168), pixelsToQ10(200))]);
    const upright: SimulationForces = {
      gravityY: SIMULATION_GRAVITY,
      tiltX: SIMULATION_X_TILT,
      nudgeX: 0,
      nudgeY: 0,
    };
    for (let tick = 0; tick < 10; tick += 1) stepBalls(shipped, EMPTY, MATERIALS, upright);
    expect((shipped.balls[0] as BallState).velocityX).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RATE 1: a ball falls the playfield in about two seconds
// ---------------------------------------------------------------------------

describe("how fast a ball falls", () => {
  it("crosses the playfield from rest in 90 to 110 ticks", () => {
    // THE TEST THIS SUITE DID NOT HAVE. At the gravity this project shipped with
    // the same fall took 227 ticks — four and a half seconds, and the reason the
    // ball looked like it was in space. The bracket is 1.8 to 2.2 seconds around
    // a measured 98.
    const ticks = ticksToFall(8, PLAYFIELD_HEIGHT - 8, SIMULATION_GRAVITY);
    expect(ticks).toBeGreaterThanOrEqual(90);
    expect(ticks).toBeLessThanOrEqual(110);
    // Stated in seconds too, because that is the unit the defect was noticed in.
    expect(ticks / TICKS_PER_SECOND).toBeLessThan(2.2);
  });

  it("falls faster than the port's old gravity by the measured 16/3", () => {
    // Explicitly, so that if anyone ever puts 24 back this file says what it is.
    const measured = ticksToFall(8, PLAYFIELD_HEIGHT - 8, SIMULATION_GRAVITY);
    const inherited = ticksToFall(8, PLAYFIELD_HEIGHT - 8, 24);
    expect(inherited).toBeGreaterThan(200);
    // Time goes as 1/sqrt(g), so a 16/3 change in gravity is a 2.31x change in
    // the fall, and this asserts the ratio rather than either endpoint.
    const ratio = inherited / measured;
    expect(ratio).toBeGreaterThan(2.1);
    expect(ratio).toBeLessThan(2.5);
  });

  it("tracks the shipped gravity slider from end to end", () => {
    // The 2..8 the options screen offers, and the reason 128 is not a compromise
    // between "the disk" and "a real table": the disk's own maximum lands on the
    // real-table figure of about 1.3 seconds, and its default is deliberately
    // shallower. Both ends are asserted so a re-measurement cannot quietly move
    // one of them.
    const shallow = ticksToFall(8, PLAYFIELD_HEIGHT - 8, gravityForOption(2));
    const steep = ticksToFall(8, PLAYFIELD_HEIGHT - 8, gravityForOption(8));
    expect(shallow).toBeGreaterThan(125);
    expect(shallow).toBeLessThan(155);
    expect(steep).toBeGreaterThan(60);
    expect(steep).toBeLessThan(80);
    expect(steep).toBeLessThan(ticksToFall(8, PLAYFIELD_HEIGHT - 8, SIMULATION_GRAVITY));
  });
});

// ---------------------------------------------------------------------------
// RATE 2: the plunge reaches the top arch
// ---------------------------------------------------------------------------

/** Drives controls from a script so a run is exactly reproducible. */
class ScriptedInput implements InputSource {
  private sequence = 0;
  private held = new Set<Control>();

  constructor(private readonly plan: (tick: number) => readonly Control[]) {}

  sample(): ControlSnapshot {
    const wanted = new Set(this.plan(this.sequence));
    const previous = this.held;
    this.held = wanted;
    this.sequence += 1;
    const controls = {} as Record<Control, ControlEdges>;
    for (const control of CONTROLS) {
      const down = wanted.has(control);
      const was = previous.has(control);
      controls[control] = {
        down,
        pressed: down && !was,
        released: !down && was,
        pressCount: down && !was ? 1 : 0,
        releaseCount: !down && was ? 1 : 0,
      };
    }
    return { controls, sequence: this.sequence };
  }
}

/** Full plunge on a real table: ticks from launch to the ball's highest point. */
function plungeFlight(tableId: TableId): { ticks: number; topY: number } {
  const game = createGame(mapFor(tableId), { ballsPerGame: 1 });
  startGame(game);
  const input = new ScriptedInput((t) => (t >= 40 && t < 90 ? ["plunger"] : []));
  let launchTick = -1;
  let topY = PLAYFIELD_HEIGHT;
  let topTick = -1;
  for (let tick = 0; tick < 600; tick += 1) {
    const report = runTicks(game, input, 1)[0];
    if (report?.launched === true) launchTick = tick;
    if (launchTick < 0) continue;
    for (const ball of debugSnapshot(game).balls) {
      if (!ball.active) continue;
      if (ball.pixelY < topY) {
        topY = ball.pixelY;
        topTick = tick;
      }
    }
  }
  return { ticks: topTick - launchTick, topY };
}

describe("how fast a launched ball climbs", () => {
  for (const tableId of TABLE_IDS) {
    it(`${tableId} carries the launch to the top of the table in under a second and a half`, () => {
      // The launch is the original's fixed kick: 6000 velocity units cut to
      // the ±4095 clamp = 16 px a tick, and the climb from the serve row at
      // 544 to the top arch is about 510 px, so the ballistic answer is v/g =
      // 128 ticks to the apex if nothing were in the way and rather less once
      // the lane's own ramp drive and the arch's rails are.
      //
      // The bound that matters is the UPPER one — a shot that takes three
      // seconds to get up the table is the defect this file is about — and
      // there is a lower bound too, because a launch that arrives instantly
      // would mean the speed had been raised to hide something.
      const { ticks, topY } = plungeFlight(tableId);
      expect(ticks).toBeGreaterThan(15);
      expect(ticks).toBeLessThan(75);
      // And it really did climb: past the middle of the table on every one.
      expect(topY).toBeLessThan(300);
    });
  }

  it("orders the machine's three kicks the way the disassembly does", () => {
    // Launch 6000 > bumper 5500 > slingshot 3500, all in the original's own
    // velocity units — and only the launch is past the ±4095 clamp, so it is
    // the one kick the limiter actually cuts (to exactly 16 px a tick, the
    // 800 px/s the film shows as a flat 770-775 px/s ascent after gravity and
    // the lane drive trim it).
    expect(LAUNCH_KICK).toBeGreaterThan(BUMPER_KICK);
    expect(BUMPER_KICK).toBeGreaterThan(SLINGSHOT_KICK);
    expect(LAUNCH_KICK).toBeGreaterThan(VELOCITY_CLAMP_Q10);
    expect(BUMPER_KICK).toBeGreaterThan(VELOCITY_CLAMP_Q10);
    expect(SLINGSHOT_KICK).toBeLessThan(VELOCITY_CLAMP_Q10);
  });
});

// ---------------------------------------------------------------------------
// RATE 3: a flipper shot crosses the table
// ---------------------------------------------------------------------------

describe("how fast a flipper shot travels", () => {
  it("completes its stroke in three and a half ticks, accelerating", () => {
    const left = flipperConfigsFor("law-n-justice")[0]!;
    let state = FLIPPER_AT_REST;
    let steps = 0;
    // Four steps to a tick; the measured stroke consumes its sweep on step 14.
    for (let tick = 0; tick < 10 && state.stroke < left.sweep; tick += 1) {
      state = tickFlipper(left, state, true).to;
      steps += 1;
    }
    expect(steps).toBe(4);
    expect(state.stroke).toBe(left.sweep);

    // And it is genuinely an acceleration: the last whole tick of the stroke
    // covers more than three times the first.
    let s = FLIPPER_AT_REST;
    const first = tickFlipper(left, s, true).to.stroke;
    s = tickFlipper(left, s, true).to;
    s = tickFlipper(left, s, true).to;
    const third = tickFlipper(left, s, true).to.stroke - s.stroke;
    expect(third).toBeGreaterThan(3 * first);
  });

  it("sends a ball off the bat across 400 px of playfield in under a second", () => {
    // The rate a player feels. A ball dropped onto the left bat and flipped
    // crosses the playfield - the stroke takes 3.5 ticks, so a shot is made by
    // starting it before the ball arrives.
    //
    // WHY THIS IS A RATE TEST AND NOT A REACHABILITY ONE: at the port's old
    // constant-rate stroke the tip moved 9.4 px a tick, which after the gravity
    // correction would have made a full flipper shot WEAKER than a scoop kicker
    // and taken it 0.9 s to cross the table. It would still have reached the top,
    // and every existing flipper test would still have passed.
    //
    // WHY IT SWEEPS THE PRESS MOMENT. The bar - 400 px on the real map inside a
    // second, and not instantly either - is exactly as it was. What has changed
    // under it is that the measured flipper impulse (see `flippers.ts`) fires
    // along the bat's face NORMAL at the instant of contact, so WHEN the button
    // goes down decides where the shot goes as well as how hard. A single fixed
    // lead therefore measures Law 'n Justice's lower-playfield geometry as much
    // as it measures the flipper. The fastest shot a player can time is the rate
    // this file is about, and it is 31 ticks: 0.62 s for 400 px, an average of
    // 645 px a second against a machine limit of 800.
    const map = mapFor("law-n-justice");
    const materials = materialTableFor("law-n-justice");
    const forces: SimulationForces = { gravityY: SIMULATION_GRAVITY, nudgeX: 0, nudgeY: 0 };
    const left = flipperConfigsFor("law-n-justice")[0]!;

    function shoot(lead: number): number {
      // On the bat's striking face, 26 px out along it and 24 px clear of it -
      // the same placement `tests/flippers.test.ts` uses, so the two agree about
      // where a ball sits on a bat.
      const start = restingOn(left, 26, 24);
      const balls = createBallSet([createBall(0, start.x, start.y)]);
      const ball = balls.balls[0] as BallState;
      let bank = createFlipperBank("law-n-justice");
      const trigger = start.y + pixelsToQ10(lead);

      let crossedAt = -1;
      let launchedAt = -1;
      for (let tick = 0; tick < 400; tick += 1) {
        const ticked = tickFlipperBank(bank, flipperInputFrom(ball.y >= trigger, false));
        bank = ticked.bank;
        stepBalls(balls, map, materials, forces);
        resolveFlipperContacts(balls.balls, ticked.sweeps);
        if (!ball.active) break;
        if (launchedAt < 0 && ball.velocityY < -2000) launchedAt = tick;
        if (launchedAt >= 0 && crossedAt < 0 && q10ToPixel(ball.y) < q10ToPixel(start.y) - 400) {
          crossedAt = tick;
        }
      }
      // Every lead must at least get the ball off the bat; only the aim varies.
      expect(launchedAt, `lead ${lead}: the bat never launched the ball`).toBeGreaterThanOrEqual(0);
      return crossedAt < 0 ? -1 : crossedAt - launchedAt;
    }

    let fastest = -1;
    for (let lead = 6; lead <= 22; lead += 2) {
      const flight = shoot(lead);
      if (flight >= 0 && (fastest < 0 || flight < fastest)) fastest = flight;
    }

    expect(fastest, "no timing of the press crossed 400 px").toBeGreaterThanOrEqual(0);
    expect(fastest).toBeGreaterThan(10);
    expect(fastest).toBeLessThan(50);
  });

  it("cannot reach the machine's own velocity clamp from anywhere on the bat", () => {
    // THE FINDING THIS FILE WAS WRITTEN TO CATCH, stated as arithmetic rather
    // than as a trajectory. The impulse the port used to apply was a rigid-body
    // reflection whose size was the bat's angular velocity times the lever arm,
    // and from 30 px out along a 45 px bat it saturated the +-4095 clamp at every
    // rate: a shot struck at the boss and a shot struck at the tip left at the
    // same 800 px a second, so the flipper had no dynamic range at all and no
    // amount of tuning could give it any.
    //
    // The measured impulse is bounded by construction. Its size is a 64x64 table
    // of the ball's distance from the pivot, at three quarters scale, times the
    // bat's rate AFTER the ball has taken its share of the bat's momentum. The
    // largest value the whole product can take, anywhere on the bat at the
    // coil's cap, is under the clamp, and only the very tip approaches it.
    const config = flipperConfigsFor("law-n-justice")[0]!;
    const reach = FLIPPER_LENGTH_PIXELS + 8;
    let worst = 0;
    let worstAt = "";
    for (let dx = 0; dx <= reach; dx += 1) {
      for (let dy = 0; dy <= reach; dy += 1) {
        if (dx * dx + dy * dy > reach * reach) continue;
        const driven = config.upMaxRate - flipperRateTaken(dx, dy);
        const normal = originalVelocityToQ10(flipperImpulseMagnitude(dx, dy) * driven);
        const tangent = originalVelocityToQ10(ORIGINAL_IMPULSE_TANGENT * driven);
        const size = Math.hypot(normal, tangent);
        if (size > worst) {
          worst = size;
          worstAt = `${dx},${dy}`;
        }
      }
    }
    expect(worst, `largest impulse was at ${worstAt}`).toBeLessThan(VELOCITY_CLAMP_Q10);
    // And it is a real spread, not a flat one: the boss gives under half of it.
    const boss = originalVelocityToQ10(
      flipperImpulseMagnitude(0, 13) * (config.upMaxRate - flipperRateTaken(0, 13)),
    );
    expect(boss).toBeLessThan(worst / 2);
  });
});

// ---------------------------------------------------------------------------
// RATE 4: the devices throw a ball a plausible distance
// ---------------------------------------------------------------------------

describe("how far the coils throw a ball", () => {
  const rise = (speed: number): number =>
    (speed * speed) / (2 * SIMULATION_GRAVITY) / 1024;

  it("throws a slingshot's ball most of a table and a bumper's about three", () => {
    // Ballistic, against the measured gravity, in whole pixels. These are the
    // brackets that independently exclude the old bridge: at 0.75 Q10 per
    // original unit the slingshot threw a ball 3,987 px — six and a half table
    // lengths — which is what "the ball is in space" looks like in a number.
    expect(rise(SLINGSHOT_KICK)).toBeGreaterThan(400);
    expect(rise(SLINGSHOT_KICK)).toBeLessThan(900);
    expect(rise(BUMPER_KICK)).toBeGreaterThan(2 * PLAYFIELD_HEIGHT);
    expect(rise(BUMPER_KICK)).toBeLessThan(5 * PLAYFIELD_HEIGHT);
  });

  it("keeps every impulse in the game inside the machine's own clamp", () => {
    // The kicks go in BEFORE restitution, so the raw value may exceed the clamp;
    // what may not is the speed a ball actually leaves with. A bumper's 22,000
    // through its own 356/1024 restitution is 7,648, well inside.
    const bumperOut = (BUMPER_KICK * 356) / 1024;
    const slingOut = (SLINGSHOT_KICK * 612) / 1024;
    expect(bumperOut).toBeLessThan(VELOCITY_CLAMP_Q10);
    expect(slingOut).toBeLessThan(VELOCITY_CLAMP_Q10);
  });
});
