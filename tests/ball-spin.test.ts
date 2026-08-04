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
  SimulationForces,
  TableId,
  TableMap,
} from "../src/game/contracts.js";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../src/game/contracts.js";
import { SOLID_BORDER_INDEX, materialTableFor } from "../src/game/materials.js";
import { Q10_ONE, pixelsToQ10, q10Multiply } from "../src/core/fixed-point.js";
import { probeContacts } from "../src/game/collision-probe.js";
import {
  DEFAULT_SIMULATION_OPTIONS,
  createBall,
  createBallSet,
  integerSqrt,
  reflectVelocity,
  stepBalls,
} from "../src/game/ball-physics.js";
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
