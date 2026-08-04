/**
 * THE BALL'S SPIN, THE EJECTOR AND THE PER-SURFACE REST THRESHOLD.
 *
 * Three decodes that belong together, all of them out of
 * `research/spin/SPIN_DECODE.md` and the bytes of `main.seg00`:
 *
 *   `$26(a4)`   the ball's SPIN. Charged by `sub.w d4,$26(a4)` at +0x00B640
 *               with the same `d4` that puts `5q/8` into the translation one
 *               instruction earlier, and bled one unit per SUBSTEP at
 *               +0x00B770. Nothing else in the segment writes it.
 *   +0x00B6BE   the EJECTOR. Six or more of the forty-four ring points in solid
 *               and the responder's last instruction shoves the ball half a
 *               pixel out along the contact bearing.
 *   `$38(a4)`   the per-surface minimum normal impact, tested at +0x00B56E on
 *               the RAW approach, where this port used one global threshold on
 *               the outgoing bounce.
 *
 * WHAT IS ASSERTED HERE AND NOT ELSEWHERE. `tests/ball-physics.test.ts` owns
 * the synthetic-map Coulomb model, which none of this touches; `tests/
 * physics-gate.test.ts` owns the score against the machine's own RAM, which is
 * a statement about SIZE. This file pins the SHAPE of the three rules — the
 * decay quantum, the handedness, the flooring, the trigger count and each of
 * the five threshold values — so that a future round that scores well on
 * average cannot quietly get any of them wrong.
 */

import { describe, expect, it } from "vitest";

import { SIMULATION_GRAVITY } from "../src/game/timebase.js";

import type {
  MaterialIndex,
  PlayfieldLevel,
  SimulationForces,
  TableId,
  TableMap,
} from "../src/game/contracts.js";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../src/game/contracts.js";
import { SOLID_BORDER_INDEX, materialTableFor } from "../src/game/materials.js";
import { Q10_ONE, pixelsToQ10, q10Multiply } from "../src/core/fixed-point.js";
import {
  PROBE_RING,
  meanBearingOf,
  outwardNormalOf,
  probeContacts,
} from "../src/game/collision-probe.js";
import type { BallSet } from "../src/game/ball-physics.js";
import {
  DEFAULT_SIMULATION_OPTIONS,
  createBall,
  createBallSet,
  integerSqrt,
  levelSolidForMap,
  pushClampForMap,
  reflectVelocity,
  stepBalls,
} from "../src/game/ball-physics.js";
import {
  UPPER_FLIPPER_RECORDS,
  batUnionSolid,
  batUnionMaskFor,
  createBatUnionMasks,
  createFlipperApproachSides,
  createFlipperBank,
  createFlipperPass,
  flipperConfigsFor,
  flipperInputFrom,
  flipperPoseAt,
  tickFlipperBank,
} from "../src/game/flippers.js";
import { accelFor, devicesFor, flipperBatsFixture, mapFor } from "./table-fixtures.js";
import {
  ORIGINAL_SPIN_UNIT_Q10,
  RESPONDER_VELOCITY_SCALE,
  SURFACE_CONSTANT_ROWS,
  minimumImpactQ10,
  surfaceResponseFor,
} from "../src/game/surface-physics.js";
import { CLEARED_TROUGH_RECORD, serveBall, troughRecordOf } from "../src/game/plunger.js";

const MATERIALS = materialTableFor("babewatch");
const WALL = 5 as MaterialIndex;
const REST = DEFAULT_SIMULATION_OPTIONS.restThreshold;
/** Id 0, the plain wall: the commonest row on every table. */
const PLAIN_WALL = surfaceResponseFor(0);
/** Id 15, the rubber posts and rings — the slipperiest divisor there is. */
const RUBBER = surfaceResponseFor(15);

/**
 * A synthetic 336x600 playfield, the same shape `ball-physics.test.ts` builds
 * and for the same reason: these tests are about the simulation, and a
 * hand-drawn wall of a known thickness is what makes the claim falsifiable.
 */
function mapWith(paint?: (set: (x: number, y: number) => void) => void): TableMap {
  const width = PLAYFIELD_WIDTH;
  const height = PLAYFIELD_HEIGHT;
  const pixels = new Uint8Array(width * height);
  paint?.((x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    pixels[y * width + x] = WALL;
  });
  return {
    tableId: "babewatch" as TableId,
    displayName: "spin fixture",
    width,
    height,
    pixels,
    materialAt(x: number, y: number): MaterialIndex {
      if (!Number.isInteger(x) || !Number.isInteger(y)) return SOLID_BORDER_INDEX;
      if (x < 0 || y < 0 || x >= width || y >= height) return SOLID_BORDER_INDEX;
      return (pixels[y * width + x] ?? 0) as MaterialIndex;
    },
  };
}

const NO_FORCES: SimulationForces = { gravityY: 0, nudgeX: 0, nudgeY: 0 };
const GRAVITY: SimulationForces = { gravityY: SIMULATION_GRAVITY, nudgeX: 0, nudgeY: 0 };

// ---------------------------------------------------------------------------
// The field, and the units it is in
// ---------------------------------------------------------------------------

describe("the spin word", () => {
  it("is in RESPONDER units — two Q10, half an original velocity word", () => {
    // Not decoration. `$26(a4)` is subtracted straight from the doubled
    // tangential speed at +0x00B62E, so it lives inside the contact rotation
    // and one of its units is one responder unit: `Q10_ONE / (4 * 2)` = 2.
    expect(ORIGINAL_SPIN_UNIT_Q10).toBe(2);
    expect(ORIGINAL_SPIN_UNIT_Q10).toBe(4 / RESPONDER_VELOCITY_SCALE);
    expect(Q10_ONE % ORIGINAL_SPIN_UNIT_Q10).toBe(0);
  });

  it("starts at zero on a new ball, and that is the only zero ever written to it", () => {
    expect(createBall(0, 0, 0).spin).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// +0x00B640 — what SETS it
// ---------------------------------------------------------------------------

describe("the responder charges the spin, +0x00B640", () => {
  /**
   * The machine's own arithmetic, written out once so every expectation below
   * is against the INSTRUCTIONS rather than against a number this file made up.
   *
   *     q    = trunc((spin - vt) * 256 / $3A)      divs.w, truncates
   *     vt  += (5 * q) >> 3                        asl/add/asr, FLOORS
   *     spin-= q
   */
  function charge(spin: number, tangentIn: number, slipDivisor: number): {
    readonly q: number;
    readonly toll: number;
    readonly spin: number;
  } {
    const q = Math.trunc(((spin - tangentIn) * 256) / slipDivisor);
    let toll = tangentIn + ((5 * q) >> 3);
    if (toll !== 0) {
      const fixed = ((Math.abs(toll) >> 12) & 0xf) + 1;
      toll += toll > 0 ? -fixed : fixed;
    }
    return { q, toll, spin: spin - q };
  }

  it("takes q out of the spin and five eighths of the same q into the velocity", () => {
    // A ball sliding east along a floor, no spin: the pure spinless case the
    // port used to be stuck in. The floor's outward normal points UP.
    const ball = createBall(0, 0, 0, 8192, 128);
    const before = ball.spin;
    reflectVelocity(ball, MATERIALS.behaviourFor(WALL), 0, -1024, REST, PLAIN_WALL);

    // t = (n_y, -n_x) = (-1, 0), so a ball moving +x has NEGATIVE signed
    // tangential speed in the machine's basis.
    const tangentIn = q10Multiply(8192, -1024) >> 1;
    const expected = charge(before, tangentIn, PLAIN_WALL.constants.slipDivisor);
    expect(expected.q).not.toBe(0);
    expect(ball.spin).toBe(expected.spin);
    // And the velocity is the SAME q's five eighths, re-signed into the world.
    expect(ball.velocityX).toBe(q10Multiply(expected.toll * ORIGINAL_SPIN_UNIT_Q10, -1024));
  });

  it("charges NOTHING to a ball already rolling without slipping", () => {
    // `spin == vt` makes the slip zero, so `q` is zero and the whole rule
    // collapses to the fixed `(|t|>>12)+1` decay. That is the sentence
    // ball-physics.ts's header has carried since round 5 and could not test.
    const ball = createBall(0, 0, 0, 8192, 128);
    const tangentIn = q10Multiply(8192, -1024) >> 1;
    ball.spin = tangentIn;
    reflectVelocity(ball, MATERIALS.behaviourFor(WALL), 0, -1024, REST, PLAIN_WALL);

    expect(ball.spin).toBe(tangentIn);
    const expected = charge(tangentIn, tangentIn, PLAIN_WALL.constants.slipDivisor);
    expect(expected.q).toBe(0);
    expect(ball.velocityX).toBe(q10Multiply(expected.toll * ORIGINAL_SPIN_UNIT_Q10, -1024));
    // Which is one fixed unit and not a fraction of the speed.
    expect(8192 - ball.velocityX).toBeLessThanOrEqual(2 * ORIGINAL_SPIN_UNIT_Q10);
  });

  it("takes LESS from a ball whose spin already runs with the surface", () => {
    // The whole point of the field: the spinless limit is the MOST the rule can
    // ever take, and a spun-up ball keeps more of its speed.
    const spinless = createBall(0, 0, 0, 8192, 128);
    const spun = createBall(1, 0, 0, 8192, 128);
    spun.spin = q10Multiply(8192, -1024) >> 1;
    reflectVelocity(spinless, MATERIALS.behaviourFor(WALL), 0, -1024, REST, PLAIN_WALL);
    reflectVelocity(spun, MATERIALS.behaviourFor(WALL), 0, -1024, REST, PLAIN_WALL);
    expect(spun.velocityX).toBeGreaterThan(spinless.velocityX);
  });

  it("is signed in t = (n_y, -n_x), so up and down a vertical wall disagree", () => {
    // THE HANDEDNESS, and it is a real degree of freedom: a port that inverted
    // it would DOUBLE the tangential toll instead of removing it. The basis is
    // the outward normal turned a FIXED quarter turn, so the sign is global —
    // a genuine angular velocity about the axis out of the playfield and not a
    // per-contact convention.
    //
    // Wall on the ball's left, outward normal +x, so `t = (n_y, -n_x)` points
    // UP: a ball sliding DOWN that wall has negative signed tangential speed
    // and is charged negative spin, and one sliding up gets the mirror of it.
    const down = createBall(0, 0, 0, -128, 8192);
    const up = createBall(1, 0, 0, -128, -8192);
    reflectVelocity(down, MATERIALS.behaviourFor(WALL), 1024, 0, REST, PLAIN_WALL);
    reflectVelocity(up, MATERIALS.behaviourFor(WALL), 1024, 0, REST, PLAIN_WALL);

    expect(down.spin).toBeLessThan(0);
    expect(up.spin).toBeGreaterThan(0);
    expect(down.spin).toBe(-up.spin);

    // And the OTHER wall of the same corridor mirrors it, which is the check
    // that the handedness comes from the normal rather than from the motion.
    const downOnTheRight = createBall(2, 0, 0, 128, 8192);
    reflectVelocity(downOnTheRight, MATERIALS.behaviourFor(WALL), -1024, 0, REST, PLAIN_WALL);
    expect(downOnTheRight.spin).toBe(-down.spin);
  });

  it("is charged by a graze, which is where the machine's own residual lived", () => {
    // +0x00B626 is where all four outcomes converge; the graze's `bra.w $b626`
    // at +0x00B56A lands ON it. A grazing contact charges the spin exactly as a
    // bounce does, and it is grazes the RAM corpus is mostly made of.
    const ball = createBall(0, 0, 0, 12000, 200);
    reflectVelocity(ball, MATERIALS.behaviourFor(WALL), 0, -1024, REST, PLAIN_WALL);
    expect(ball.spin).not.toBe(0);
  });

  it("is NOT charged by the leaving gate", () => {
    // +0x00B54E `tst.w d0 / ble` returns before +0x00B626 for a ball that is
    // touching but not approaching: the one path in the responder that skips
    // the charge.
    const ball = createBall(0, 0, 0, 8192, -128);
    ball.spin = 321;
    expect(reflectVelocity(ball, MATERIALS.behaviourFor(WALL), 0, -1024, REST, PLAIN_WALL)).toBe(
      false,
    );
    expect(ball.spin).toBe(321);
  });
});

// ---------------------------------------------------------------------------
// The two quantisation losses the round removed
// ---------------------------------------------------------------------------

describe("the toll is applied to a scalar and floored, not scaled and truncated", () => {
  it("floors `5q/8` where truncation toward zero would keep more", () => {
    // `asl.w #2 / add.w / asr.w #3` is an ARITHMETIC shift, so it FLOORS. The
    // two rounding modes part company whenever `5q` is not a multiple of eight
    // and `q` is negative — and truncation always parts company in the same
    // direction, keeping more speed than the machine keeps. This case is chosen
    // to sit exactly on that split rather than to be a round number:
    //
    //   a ball sliding WEST along a floor at 8400 Q10 has tangentIn +4200,
    //   q = trunc(-4200 * 256 / 21760) = -49,   5q = -245,
    //   -245 >> 3 = -31   but   trunc(-245/8) = -30.
    const slip = PLAIN_WALL.constants.slipDivisor;
    const speed = -8400;
    const ball = createBall(0, 0, 0, speed, 128);
    const tangentIn = q10Multiply(speed, -1024) >> 1;
    expect(tangentIn).toBe(4200);
    const q = Math.trunc(((0 - tangentIn) * 256) / slip);
    expect(q).toBe(-49);
    expect((5 * q) % 8).not.toBe(0);
    expect((5 * q) >> 3).toBe(-31);
    expect(Math.trunc((5 * q) / 8)).toBe(-30);

    reflectVelocity(ball, MATERIALS.behaviourFor(WALL), 0, -1024, REST, PLAIN_WALL);
    expect(ball.spin).toBe(49);
    // The machine's answer, and it is two Q10 slower than the truncating one.
    expect(ball.velocityX).toBe(-8334);
    expect(ball.velocityX).not.toBe(-8336);
  });

  it("keeps strictly more than the `keep` fraction the port used to scale by", () => {
    // The other half of the along-face residual: the port computed
    // `keep = trunc((vt - drop) * 1024 / vt)` and multiplied the tangential
    // VECTOR by it, losing up to one part in 1024 of the speed at EVERY
    // contact, always in the slower direction. The machine has no fraction at
    // all — it adds and subtracts whole units of a signed scalar.
    const speed = 8000;
    const ball = createBall(0, 0, 0, speed, 128);
    reflectVelocity(ball, MATERIALS.behaviourFor(WALL), 0, -1024, REST, PLAIN_WALL);

    const tangentSpeed = integerSqrt(speed * speed);
    const oldDrop =
      Math.trunc((tangentSpeed * 160) / PLAIN_WALL.constants.slipDivisor) +
      (((tangentSpeed >> 13) + 1) << 1);
    const oldKeep = Math.trunc(((tangentSpeed - oldDrop) * Q10_ONE) / tangentSpeed);
    expect(ball.velocityX).toBeGreaterThan(q10Multiply(speed, oldKeep));
  });
});

// ---------------------------------------------------------------------------
// +0x00B770 — what DECAYS it
// ---------------------------------------------------------------------------

describe("the spin decays one unit per SUBSTEP, +0x00B770", () => {
  const OPEN = mapWith();

  it("bleeds exactly eight a frame in free flight", () => {
    const ball = createBall(0, pixelsToQ10(160), pixelsToQ10(200), 0, 0);
    ball.spin = 100;
    const set = createBallSet([ball]);
    stepBalls(set, OPEN, MATERIALS, NO_FORCES, {});
    expect(ball.spin).toBe(92);
    stepBalls(set, OPEN, MATERIALS, NO_FORCES, {});
    expect(ball.spin).toBe(84);
  });

  it("empties a spin of 100 after thirteen frames and then SATURATES at zero", () => {
    // Linear, not exponential: there is no time constant to fit. 100 units is
    // 12.5 frames, so the thirteenth frame is where it lands, and it stays
    // there — `beq.b` at +0x00B774 returns without touching a zero word.
    const ball = createBall(0, pixelsToQ10(160), pixelsToQ10(200), 0, 0);
    ball.spin = 100;
    const set = createBallSet([ball]);
    for (let tick = 0; tick < 12; tick += 1) stepBalls(set, OPEN, MATERIALS, NO_FORCES, {});
    expect(ball.spin).toBe(4);
    stepBalls(set, OPEN, MATERIALS, NO_FORCES, {});
    expect(ball.spin).toBe(0);
    for (let tick = 0; tick < 400; tick += 1) stepBalls(set, OPEN, MATERIALS, NO_FORCES, {});
    expect(ball.spin).toBe(0);
  });

  it("saturates from BELOW as well, without overshooting into a positive", () => {
    const ball = createBall(0, pixelsToQ10(160), pixelsToQ10(200), 0, 0);
    ball.spin = -5;
    const set = createBallSet([ball]);
    stepBalls(set, OPEN, MATERIALS, NO_FORCES, {});
    expect(ball.spin).toBe(0);
  });

  it("is eight a frame and not one: a per-tick decay would leave 7/8 standing", () => {
    // The one arithmetic mistake this rule invites, named so it cannot be made
    // silently. Over ten frames a per-substep decay takes 80 units where a
    // per-tick decay takes 10.
    const ball = createBall(0, pixelsToQ10(160), pixelsToQ10(200), 0, 0);
    ball.spin = 1000;
    const set = createBallSet([ball]);
    for (let tick = 0; tick < 10; tick += 1) stepBalls(set, OPEN, MATERIALS, NO_FORCES, {});
    expect(1000 - ball.spin).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// What does NOT touch it: a lock, a drain, a serve
// ---------------------------------------------------------------------------

describe("nothing ever resets the spin", () => {
  const OPEN = mapWith();

  it("FREEZES while a ball is held, and decays again once it is released", () => {
    // The frame's per-ball loops skip any ball with `$9(a4)` set or bit 7 of
    // `$1(a4)`, so neither the responder nor the decay runs on a locked ball:
    // one released from a saucer comes out with the spin it went in with.
    const ball = createBall(0, pixelsToQ10(160), pixelsToQ10(200), 0, 0);
    ball.spin = 500;
    ball.heldBy = "saucer-1";
    const set = createBallSet([ball]);
    for (let tick = 0; tick < 200; tick += 1) stepBalls(set, OPEN, MATERIALS, NO_FORCES, {});
    expect(ball.spin).toBe(500);

    ball.heldBy = null;
    stepBalls(set, OPEN, MATERIALS, NO_FORCES, {});
    expect(ball.spin).toBe(492);
  });

  it("freezes on a drained ball too", () => {
    const ball = createBall(0, pixelsToQ10(160), pixelsToQ10(200), 0, 0);
    ball.spin = -321;
    ball.active = false;
    const set = createBallSet([ball]);
    for (let tick = 0; tick < 50; tick += 1) stepBalls(set, OPEN, MATERIALS, NO_FORCES, {});
    expect(ball.spin).toBe(-321);
  });

  it("SURVIVES THE SERVE, carried on the trough record like every other low bit", () => {
    // `$3E36` re-seeds `$12/$14/$1E/$22/$0E/$10/$01` of the record it is handed
    // and does not write `$26` at all. This port spawns a new ball where the
    // machine re-uses one of three fixed records, so the carry is explicit.
    const drained = createBall(0, pixelsToQ10(185), pixelsToQ10(601), -4000, 9252);
    drained.spin = -284;
    const record = troughRecordOf(drained);
    expect(record.spin).toBe(-284);

    const set = createBallSet();
    const served = serveBall(set, undefined, record);
    expect(served.spin).toBe(-284);

    // And it then decays out on its own, which is why a port that DID reset it
    // would be wrong in the code and almost right in effect: the machine's own
    // seated lane ball reads exactly zero on 79-87 % of its frames.
    const rolling = createBallSet([served]);
    for (let tick = 0; tick < 36; tick += 1) stepBalls(rolling, OPEN, MATERIALS, NO_FORCES, {});
    expect(served.spin).toBe(0);
  });

  it("serves at zero from a machine that has never had a ball taken off it", () => {
    expect(CLEARED_TROUGH_RECORD.spin).toBe(0);
    expect(serveBall(createBallSet()).spin).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// +0x00B6BE — the ejector
// ---------------------------------------------------------------------------

describe("the ejector, +0x00B6BE", () => {
  /** A floor whose top row is `top`, spanning the whole width. */
  const FLOOR_TOP = 100;
  const FLOORED = mapWith((set) => {
    for (let y = FLOOR_TOP; y < FLOOR_TOP + 20; y += 1) {
      for (let x = 0; x < PLAYFIELD_WIDTH; x += 1) set(x, y);
    }
  });

  it("does not fire at five ring points, and a flat floor puts exactly five there", () => {
    // The trigger is a DEPTH and not a touch. The discrete radius-8 circle's
    // bottom row is dx -2..+2, so a ball resting on a flat floor puts five
    // points on it — one short of the six +0x00B6BE asks for. That is why the
    // machine's seat bobs instead of hovering.
    const restingY = FLOOR_TOP - 8;
    const probe = probeContacts(
      FLOORED,
      MATERIALS,
      pixelsToQ10(160),
      pixelsToQ10(restingY),
    );
    expect(probe.contacts.length).toBe(5);

    const ball = createBall(0, pixelsToQ10(160), pixelsToQ10(restingY), 0, 0);
    const startY = ball.y;
    stepBalls(createBallSet([ball]), FLOORED, MATERIALS, GRAVITY, {});
    expect(ball.y).toBeGreaterThanOrEqual(startY);
  });

  it("fires at six, and pushes exactly half a pixel along the outward normal", () => {
    // One pixel deeper the dy=7 row (dx +-3, +-4) joins the dy=8 row and the
    // count is nine. The push is `move.w #$fe00,d0` = -512 along the bearing,
    // which points INTO the surface, so it is +512 Q10 along the outward normal
    // — half a pixel, straight up out of a floor.
    const buriedY = FLOOR_TOP - 7;
    const probe = probeContacts(FLOORED, MATERIALS, pixelsToQ10(160), pixelsToQ10(buriedY));
    expect(probe.contacts.length).toBeGreaterThanOrEqual(6);
    expect(probe.normalX).toBe(0);
    expect(probe.normalY).toBe(-1024);

    const ball = createBall(0, pixelsToQ10(160), pixelsToQ10(buriedY), 0, 0);
    const startY = ball.y;
    stepBalls(createBallSet([ball]), FLOORED, MATERIALS, GRAVITY, {});

    // The tick's FIRST pass ejects half a pixel; the ball is then only five
    // points deep, so no later pass in the tick fires, and the four quarter
    // ticks of gravity between the passes put back eight Q10 of sink.
    expect(startY - ball.y).toBe(pixelsToQ10(1) / 2 - 8);
  });

  it("bobs rather than sinking: a ball left on a floor does not bury itself", () => {
    // The behaviour the whole rule exists for, and the reason round 8 had to
    // invent a position constraint it could not decode. Without an ejector the
    // sink is unbounded — 8 Q10 a tick, for ever.
    const ball = createBall(0, pixelsToQ10(160), pixelsToQ10(FLOOR_TOP - 8), 0, 0);
    const set = createBallSet([ball]);
    let lowest = ball.y;
    for (let tick = 0; tick < 600; tick += 1) {
      stepBalls(set, FLOORED, MATERIALS, GRAVITY, {});
      if (ball.y > lowest) lowest = ball.y;
    }
    // A whole pixel of bob at the very most, and never a run away downward.
    expect(lowest - pixelsToQ10(FLOOR_TOP - 8)).toBeLessThanOrEqual(pixelsToQ10(1));
  });

  it("is not reached at all when the ring touches nothing", () => {
    // `jsr $a7e0 / bmi.b $a69c` at +0x00A68E skips the whole responder on an
    // empty collision blit, and the ejector is the responder's own last
    // instruction — so free flight is exactly free flight.
    const ball = createBall(0, pixelsToQ10(160), pixelsToQ10(40), 0, 0);
    stepBalls(createBallSet([ball]), FLOORED, MATERIALS, NO_FORCES, {});
    expect(ball.y).toBe(pixelsToQ10(40));
  });
});

// ---------------------------------------------------------------------------
// +0x0039FA and +0x00B278 — the count is taken over `map OR bat`
// ---------------------------------------------------------------------------

/**
 * THE EJECTOR'S RING IS COUNTED OVER THE UNION OF THE MAP AND THE BAT.
 *
 * `+0x00B278` blits the flipper pose's own mask INSTEAD of the playfield plane
 * whenever the pose's box admits the ball, and `+0x0039FA` has ORed the
 * collision plane into that mask at table load. So `$c(a4)` — the count
 * +0x00B6BE gates on — is a count over `map OR bat`, and this port counted the
 * map alone.
 *
 * WHAT MAKES THIS FALSIFIABLE rather than a plausible re-reading: the machine's
 * own `$c(a4)` was read out of RAM at 1,097 pinned positions on Law 'n Justice
 * (`research/pocket/POCKET_TRACE.md` §4.3). Of the 383 whose ring reaches a
 * resting bat the map model reproduced it on ZERO and the union model on ALL
 * 383; of the 714 clear of every bat the two models are the same function and
 * scored identically. The counts below are that scan's own numbers at the sites
 * it named, asserted against the SHIPPED assets — this port's map, this port's
 * pose bank, this port's ring — so a change to any of the three that broke the
 * agreement would fail rather than drift.
 */
describe("the ejector counts over `map OR bat`, +0x0039FA / +0x00B278", () => {
  /**
   * The union masks and the level-solid oracle for one shipped table, built
   * once. Memoised because it is what the game does — `+0x0039FA` runs at table
   * LOAD — and because a sweep that rebuilds nineteen pose masks per position
   * spends its whole budget on the same answer.
   */
  const fixtures = new Map<TableId, ReturnType<typeof buildUnionFixture>>();
  function buildUnionFixture(tableId: TableId) {
    flipperBatsFixture();
    const map = mapFor(tableId);
    const materials = materialTableFor(tableId);
    const solid = levelSolidForMap(map, materials);
    const configs = flipperConfigsFor(tableId);
    return { map, configs, masks: createBatUnionMasks(configs, solid), solid };
  }
  function unionFixture(tableId: TableId): ReturnType<typeof buildUnionFixture> {
    const found = fixtures.get(tableId);
    if (found !== undefined) return found;
    const built = buildUnionFixture(tableId);
    fixtures.set(tableId, built);
    return built;
  }

  /** `(map ring hits, union ring hits)` at a whole-pixel centre, bats at REST. */
  function countsAt(
    tableId: TableId,
    level: PlayfieldLevel,
    centreX: number,
    centreY: number,
  ): { readonly map: number; readonly union: number } {
    const { map, configs, masks, solid } = unionFixture(tableId);
    let onMap = 0;
    let onUnion = 0;
    for (let i = 0; i < PROBE_RING.size; i += 1) {
      const x = centreX + (PROBE_RING.dx[i] ?? 0);
      const y = centreY + (PROBE_RING.dy[i] ?? 0);
      // `probeRing`'s own rule: the bottom row is where a ball leaves the table.
      if (y >= map.height) continue;
      const hitMap = solid(level, x, y);
      if (hitMap) onMap += 1;
      const hitBat = configs.some((config) => {
        if (config.level !== level) return false;
        const pose = masks.get(config.id)?.get(flipperPoseAt(config, 0));
        return pose !== undefined && batUnionSolid(pose, x, y);
      });
      if (hitMap || hitBat) onUnion += 1;
    }
    return { map: onMap, union: onUnion };
  }

  it("reproduces the machine's own counts at all four Law 'n Justice pocket sites", () => {
    // POCKET_TRACE §4.3, `map-only ring hits / union ring hits` at the ball's
    // own integer centre. Six is the gate: not one of these four reaches it on
    // the map and all four clear it on the union, which is the whole of the
    // census's 4-of-288 write-off.
    expect(countsAt("law-n-justice", 0, 24, 304)).toEqual({ map: 4, union: 15 });
    expect(countsAt("law-n-justice", 0, 25, 307)).toEqual({ map: 4, union: 15 });
    expect(countsAt("law-n-justice", 0, 33, 322)).toEqual({ map: 3, union: 18 });
    expect(countsAt("law-n-justice", 0, 42, 341)).toEqual({ map: 5, union: 17 });
  });

  it("is the map itself where no blade is within the ring's reach", () => {
    // BabeWatch's arch apex, POCKET_TRACE §8: the nearest bat rests at (189,107)
    // with a silhouette that stops well short of this ring, so map and union are
    // the same function and give the same three numbers the machine gives.
    expect(countsAt("babewatch", 0, 252, 57)).toEqual({ map: 3, union: 3 });
    expect(countsAt("babewatch", 0, 252, 58)).toEqual({ map: 5, union: 5 });
    expect(countsAt("babewatch", 0, 252, 59)).toEqual({ map: 7, union: 7 });
  });

  it("can never count FEWER points than the map probe alone", () => {
    // The safety property the whole change rests on: the union is a superset by
    // construction, so the ejector can only ever fire where it fired before or
    // in addition, and no ball this port used to push out can stop being pushed.
    // Swept over the pocket block and the whole of the upper-left bat, which is
    // the block POCKET_TRACE's own ring scan covers.
    let raised = 0;
    for (let y = 292; y <= 360; y += 2) {
      for (let x = 16; x <= 64; x += 2) {
        const at = countsAt("law-n-justice", 0, x, y);
        expect(at.union).toBeGreaterThanOrEqual(at.map);
        if (at.union > at.map) raised += 1;
      }
    }
    // And it is not vacuous: the bat really is under a large part of that block.
    expect(raised).toBeGreaterThan(100);
  });

  it("crosses the six-hit gate a PIXEL into a blade, which is what makes it self-limiting", () => {
    // POCKET_TRACE §7.3. A ball resting ON a blade must not be walked off it,
    // and the reason it is not is that the count only reaches six once the ball
    // is a pixel in — one half-pixel push takes it straight back under. Law 'n
    // Justice's lower-left blade at rest, x = 108, by ball-centre row: the
    // machine's own `cradlegeom` reads 0, 0, 6, 9, 11, 13 down its own rows and
    // this is that same staircase against the drawn blade this port collides on.
    const { map, masks, configs, solid } = unionFixture("law-n-justice");
    const blade = configs.find((config) => config.id === "lower-left");
    if (blade === undefined) throw new Error("law-n-justice has no lower-left bat");
    const pose = masks.get(blade.id)?.get(flipperPoseAt(blade, 0));
    const countAt = (cy: number): number => {
      let hits = 0;
      for (let i = 0; i < PROBE_RING.size; i += 1) {
        const x = 108 + (PROBE_RING.dx[i] ?? 0);
        const y = cy + (PROBE_RING.dy[i] ?? 0);
        if (y >= map.height) continue;
        if (solid(0, x, y) || (pose !== undefined && batUnionSolid(pose, x, y))) hits += 1;
      }
      return hits;
    };
    expect([550, 551, 552, 553, 554, 555, 556].map(countAt)).toEqual([0, 0, 0, 6, 9, 11, 13]);
  });
});

/**
 * THE BURIED BALL, END TO END: the pocket the census wrote four balls off in.
 *
 * These drive `stepBalls` the way the game loop drives it — the resting bank's
 * four passes, the map's own push clamp, the table's ramp drive and its surface
 * layer — and differ from each other in exactly one option, `batUnion`. That is
 * the whole experiment: with the machine's own count the ball leaves, with this
 * port's map-only count it does not, and nothing else about the tick changes.
 */
describe("the buried-ball ejector, against the shipped tables", () => {
  interface Rig {
    readonly step: (set: BallSet, union: boolean) => void;
  }

  function rigFor(tableId: TableId): Rig {
    flipperBatsFixture();
    const map = mapFor(tableId);
    const materials = materialTableFor(tableId);
    const options = { rampDrive: accelFor(tableId), surfaces: devicesFor(tableId) };
    const sweeps = tickFlipperBank(
      createFlipperBank(tableId),
      flipperInputFrom(false, false, UPPER_FLIPPER_RECORDS[tableId].role),
    ).sweeps;
    const clamp = pushClampForMap(map, materials, options);
    const masks = createBatUnionMasks(
      flipperConfigsFor(tableId),
      levelSolidForMap(map, materials, options),
    );
    const sides = createFlipperApproachSides();
    const batUnion = batUnionMaskFor(sweeps, masks);
    return {
      step(set: BallSet, union: boolean): void {
        const bats = createFlipperPass(sweeps, undefined, clamp, undefined, sides);
        stepBalls(set, map, materials, GRAVITY, {
          ...options,
          bats: bats.resolve,
          batUnion: union ? batUnion : null,
        });
      },
    };
  }

  /** The port's own dead-stop position, at the Q10 the machine was written at. */
  const POCKET_X = Math.round(42.692 * Q10_ONE);
  const POCKET_Y = Math.round(341.999 * Q10_ONE);

  it("leaves Law 'n Justice's pocket, and does NOT on the map-only count", () => {
    const rig = rigFor("law-n-justice");

    const stuck = createBall(0, POCKET_X, POCKET_Y, 0, 0);
    const stuckSet = createBallSet([stuck]);
    for (let tick = 0; tick < 200; tick += 1) rig.step(stuckSet, false);
    // The defect, pinned: the ball settles half a pixel from where it was put
    // down and stays there for the rest of the game. (Dead still to the Q10
    // with no bat resolved at all; with the bat's own separation running it
    // creeps 0.2 px into the corner of the channel and stops.)
    expect(stuck.active).toBe(true);
    expect(Math.abs(stuck.x - POCKET_X)).toBeLessThan(Q10_ONE);
    expect(Math.abs(stuck.y - POCKET_Y)).toBeLessThan(Q10_ONE);

    const freed = createBall(0, POCKET_X, POCKET_Y, 0, 0);
    const freedSet = createBallSet([freed]);
    let drainedAt = -1;
    for (let tick = 0; tick < 400 && drainedAt < 0; tick += 1) {
      rig.step(freedSet, true);
      if (!freed.active) drainedAt = tick;
    }
    // The machine walks it out at 1.6–1.8 px a frame, clears the wall in seven,
    // crosses the flipper line at 102 and is past y = 560 at 188. This port only
    // has to STOP HOLDING IT: the ball leaves the pocket and reaches the drain
    // rather than sitting there until the ball search retires it.
    expect(drainedAt).toBeGreaterThan(0);
  });

  it("moves the ball on the FIRST tick, along the outward contact bearing", () => {
    // The machine's own first read-back, one PAL frame after the write, is
    // already at (44.481, 342.932) — down and to the right, out of the channel.
    // The push is four half-pixels a frame along a bearing of 206.7°, whose
    // outward normal is (+0.893, +0.450).
    const rig = rigFor("law-n-justice");
    const ball = createBall(0, POCKET_X, POCKET_Y, 0, 0);
    rig.step(createBallSet([ball]), true);
    expect(ball.x - POCKET_X).toBeGreaterThan(Q10_ONE);
    expect(ball.y).toBeGreaterThanOrEqual(POCKET_Y);
  });

  it("does NOT free the rest of the cluster, and the residual is the CLAMP", () => {
    // THE DISCLOSED RESIDUAL, pinned so the next round starts from a fact.
    //
    // Higher up the same two-pixel diagonal channel the ejector fires — the
    // union counts 15 to 18 against a gate of six — and the ball still does not
    // leave, because the mean bearing there is DEGENERATE. The ring straddles
    // the channel and lights it on both sides, so the mean points nearly along
    // the wall: POCKET_TRACE §3.2 measures 2004/2048 = 352.3° at (24,304) and
    // this port's union gives 2003, an outward normal of (-0.990, +0.138) —
    // straight into the two pixels of wall on the far side.
    //
    // The MACHINE ejects the ball THROUGH that wall: it writes `$1e/$22` raw at
    // +0x00B6DC and has no anti-tunnelling test at all, so the ball lands in the
    // left gutter, falls to x = 8, leaves the playfield and is confiscated
    // (`$09 -> $FF`). It does not hold the ball there; it disposes of it, and
    // this port's ball search disposes of it too, by the other route. THIS PORT
    // refuses the push instead, because `advanceCentre` may not put a centre
    // inside solid material — and that invariant is load-bearing: letting the
    // ejector write raw was measured this round and it drives these balls into
    // the off-playfield shaft behind the wall at (8,388), which is a strand site
    // rather than a disposal.
    //
    // So what is asserted is the SHAPE of the residual: the count is over the
    // gate, and the step the gate authorises lands in material.
    const { map, masks, configs, solid } = (() => {
      flipperBatsFixture();
      const table = mapFor("law-n-justice");
      const materials = materialTableFor("law-n-justice");
      const at = levelSolidForMap(table, materials);
      const list = flipperConfigsFor("law-n-justice");
      return { map: table, masks: createBatUnionMasks(list, at), configs: list, solid: at };
    })();
    for (const [x, y] of [
      [24, 304],
      [25, 307],
      [33, 322],
    ] as const) {
      const bearings: number[] = [];
      for (let i = 0; i < PROBE_RING.size; i += 1) {
        const px = x + (PROBE_RING.dx[i] ?? 0);
        const py = y + (PROBE_RING.dy[i] ?? 0);
        if (py >= map.height) continue;
        const hit =
          solid(0, px, py) ||
          configs.some((config) => {
            if (config.level !== 0) return false;
            const pose = masks.get(config.id)?.get(flipperPoseAt(config, 0));
            return pose !== undefined && batUnionSolid(pose, px, py);
          });
        if (hit) bearings.push(PROBE_RING.angle[i] ?? 0);
      }
      expect(bearings.length).toBeGreaterThanOrEqual(6);
      const normal = outwardNormalOf(meanBearingOf(bearings));
      const stepX = x + normal.x / (2 * Q10_ONE);
      const stepY = y + normal.y / (2 * Q10_ONE);
      expect(solid(0, Math.floor(stepX), Math.floor(stepY)), `(${x},${y})`).toBe(true);
    }
  });

  it("does NOT free BabeWatch's (252,57), because the machine cannot either", () => {
    // POCKET_TRACE §8, and this is a REGRESSION TEST FOR A SITE THAT IS ALREADY
    // FAITHFUL. A ball written into the machine's own record at rest on the apex
    // of that rubber arch sinks two pixels and then bobs over a 0.4922 px band
    // for 7,500 consecutive PAL frames — 150 seconds, 114 ejector throw-backs —
    // and never leaves. No bat is within reach, so map and union are the same
    // function there (see the counts above) and the port's map-only probe was
    // already the machine's own answer. A change that "fixed" this site would be
    // a regression away from the original rather than a repair.
    const rig = rigFor("babewatch");
    const ball = createBall(0, pixelsToQ10(252), pixelsToQ10(57), 0, 0);
    const set = createBallSet([ball]);
    for (let tick = 0; tick < 900; tick += 1) rig.step(set, true);
    expect(ball.active).toBe(true);
    expect(Math.abs(ball.x / Q10_ONE - 252)).toBeLessThan(2);
    expect(ball.y / Q10_ONE).toBeLessThan(60);
  });

  it("does not walk a cradled ball off the blade it is lying on", () => {
    // §7.3's invariant, driven rather than counted: a ball seated on the resting
    // lower-left blade rolls down it at its own speed and off the end — which is
    // what a ball on a down-sloped blade does — instead of being flung sideways
    // by an ejector firing on every pass. The machine's own trace of exactly
    // this (`L-cradle-LL-108-553`) covers 9.5 px in 19 frames, about half a
    // pixel a frame, with about one push every other frame.
    const rig = rigFor("law-n-justice");
    const ball = createBall(0, pixelsToQ10(108), pixelsToQ10(553), 0, 0);
    const set = createBallSet([ball]);
    let travelled = 0;
    for (let tick = 0; tick < 19; tick += 1) {
      const wasX = ball.x;
      const wasY = ball.y;
      rig.step(set, true);
      travelled += Math.hypot((ball.x - wasX) / Q10_ONE, (ball.y - wasY) / Q10_ONE);
    }
    // Nineteen frames of rolling, not of being thrown: the ejector's own quantum
    // is half a pixel a pass, so four a frame for nineteen frames would be 38.
    expect(travelled).toBeLessThan(20);
    expect(ball.active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `$38(a4)` — the per-surface rest threshold
// ---------------------------------------------------------------------------

describe("the too-soft gate is per surface and pre-restitution, +0x00B56E", () => {
  it("carries all five distinct values the eight rows hold", () => {
    const values = new Set(SURFACE_CONSTANT_ROWS.map((row) => row.minImpact));
    expect([...values].sort((a, b) => a - b)).toEqual([-2000, -800, -400, -200, 0]);
  });

  it("bridges each of them at responder scale", () => {
    // A plain wall's -800 is 1.5625 px/tick of approach, where the port's one
    // global 853 Q10 on the OUTGOING bounce demanded 2.80 px/tick in.
    expect(minimumImpactQ10(PLAIN_WALL.constants)).toBe(-1600);
    expect(minimumImpactQ10(RUBBER.constants)).toBe(-400);
    expect(minimumImpactQ10(surfaceResponseFor(10).constants)).toBe(-4000);
    expect(minimumImpactQ10(surfaceResponseFor(16).constants)).toBe(0);
    expect(-1600 / Q10_ONE).toBeCloseTo(-1.5625, 4);
  });

  it("bounces just past the row's own threshold and kills the bounce just under it", () => {
    // Table-driven over every row, so a future edit to any one of the eight
    // cannot go untested. The approach is straight down a floor with no
    // tangential speed at all, which keeps the graze gate out of it.
    for (const row of SURFACE_CONSTANT_ROWS) {
      const id = row.ids[0]?.[0] ?? 0;
      const surface = surfaceResponseFor(id);
      const threshold = -minimumImpactQ10(row);
      if (threshold === 0) continue; // the bumpers; their own case is below

      const soft = createBall(0, 0, 0, 0, threshold - 1);
      const hard = createBall(1, 0, 0, 0, threshold + 1);
      reflectVelocity(soft, MATERIALS.behaviourFor(WALL), 0, -1024, REST, surface);
      reflectVelocity(hard, MATERIALS.behaviourFor(WALL), 0, -1024, REST, surface);

      expect(soft.velocityY, `id ${id} just under $38`).toBe(0);
      expect(hard.velocityY, `id ${id} just over $38`).toBeLessThan(0);
    }
  });

  it("lets a pop bumper answer however gently it is touched: its `$38` is ZERO", () => {
    // The case one global threshold could not express at all. 50 Q10 of
    // approach is a twentieth of what the port's 853 demanded.
    const bumper = surfaceResponseFor(16);
    expect(bumper.constants.minImpact).toBe(0);
    const ball = createBall(0, 0, 0, 0, 50);
    reflectVelocity(ball, MATERIALS.behaviourFor(WALL), 0, -1024, REST, bumper);
    expect(ball.velocityY).toBeLessThan(0);
  });

  it("is tested BEFORE the restitution, not after it", () => {
    // The two rules differ by the row's own restitution, and on a plain wall
    // that is 76/256: an approach of 2000 Q10 is past `$38`'s 1600 and bounces,
    // while the bounce it produces — 594 Q10 — is under the port's old global
    // 853 and would have been killed.
    const approach = 2000;
    expect(approach).toBeGreaterThan(1600);
    const bounce = q10Multiply(approach, PLAIN_WALL.elasticity);
    expect(bounce).toBeLessThan(REST);

    const ball = createBall(0, 0, 0, 0, approach);
    reflectVelocity(ball, MATERIALS.behaviourFor(WALL), 0, -1024, REST, PLAIN_WALL);
    expect(ball.velocityY).toBe(-bounce);
  });

  it("leaves the synthetic-map path on the port's own global threshold", () => {
    // No surface layer means no `$38` to read, and every physics unit test in
    // `ball-physics.test.ts` measures that path. It must not have moved.
    const ball = createBall(0, 0, 0, 0, 2000);
    reflectVelocity(ball, MATERIALS.behaviourFor(WALL), 0, -1024, REST);
    expect(ball.velocityY).toBe(0);
  });
});
