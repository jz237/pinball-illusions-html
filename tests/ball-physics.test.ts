import { describe, expect, it } from "vitest";

import { SIMULATION_GRAVITY, VELOCITY_CLAMP_Q10 } from "../src/game/timebase.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  MaterialIndex,
  SimulationForces,
  TableId,
  TableMap,
  TableMapDocument,
} from "../src/game/contracts.js";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../src/game/contracts.js";
import {
  LEVEL1_SOLID_BIT,
  SOLID_BORDER_INDEX,
  WALL_FRICTION,
  materialTableFor,
} from "../src/game/materials.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { pixelsToQ10, q10Multiply, q10ToPixel } from "../src/core/fixed-point.js";
import {
  DEFAULT_PROBE_RADIUS,
  PROBE_RING,
  PROBE_RING_SIZE,
  numberAt,
  passabilityOf,
  probeContacts,
} from "../src/game/collision-probe.js";
import { shooterLaneFor } from "../src/game/plunger.js";
import {
  BALL_RADIUS_PIXELS,
  DEFAULT_SIMULATION_OPTIONS,
  VIRTUAL_TOP_WALL_ROWS,
  activeBallCount,
  ballById,
  createBall,
  createBallSet,
  integerSqrt,
  playfieldViewFor,
  reflectVelocity,
  resolveBallCollisions,
  spawnBall,
  stepBalls,
} from "../src/game/ball-physics.js";
import type { BallSet } from "../src/game/ball-physics.js";

/**
 * The fixtures are BabeWatch maps.
 *
 * All three tables share one material table, but they do not share the virtual
 * top wall: Law 'n Justice needs 26 rows of it because its collision layer has
 * no top border at all, and a fixture that silently grew a wall it did not paint
 * would be testing the correction rather than the geometry. BabeWatch's entry is
 * 0, so a fixture map here is exactly what `paint` says it is. The Law 'n
 * Justice wall gets its own section at the bottom of this file, on the real map.
 */
const MATERIALS = materialTableFor("babewatch");

/** Bare playfield; index 5 is the wall. Both come straight from materials.ts. */
const OPEN: MaterialIndex = 0;
const WALL: MaterialIndex = 5;

/** The real playfield, not a rounded-off approximation of it. */
const WIDTH = PLAYFIELD_WIDTH;
const HEIGHT = PLAYFIELD_HEIGHT;

const GRAVITY: SimulationForces = { gravityY: SIMULATION_GRAVITY, nudgeX: 0, nudgeY: 0 };
const WEIGHTLESS: SimulationForces = { gravityY: 0, nudgeX: 0, nudgeY: 0 };

/**
 * A synthetic playfield, 336x600 like every shipped table.
 *
 * Deliberately not the real map loader: these tests are about the simulation,
 * and a hand-drawn wall of a known thickness is the only way to make the
 * anti-tunnelling claim falsifiable. Out-of-bounds returns the solid border
 * material, matching the contract the real loader implements.
 */
function makeMap(paint: (x: number, y: number) => MaterialIndex): TableMap {
  const pixels = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      pixels[y * WIDTH + x] = paint(x, y);
    }
  }
  return {
    tableId: "babewatch",
    displayName: "fixture",
    width: WIDTH,
    height: HEIGHT,
    pixels,
    materialAt(x: number, y: number): MaterialIndex {
      if (!Number.isInteger(x) || !Number.isInteger(y)) return SOLID_BORDER_INDEX;
      if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return SOLID_BORDER_INDEX;
      return (pixels[y * WIDTH + x] ?? OPEN) as MaterialIndex;
    },
  };
}

const EMPTY_MAP = makeMap(() => OPEN);

/** High enough that one tick at 4 px/tick carries the centre past the bottom row. */
const BELOW_DRAIN_IN_ONE_TICK = HEIGHT - 2;
const FLOOR_Y = 400;
const FLOOR_MAP = makeMap((_x, y) => (y >= FLOOR_Y ? WALL : OPEN));

/** A vertical wall exactly two pixels thick, for the tunnelling test. */
const THIN_WALL_X = 200;
const THIN_VERTICAL_WALL = makeMap((x) => (x === THIN_WALL_X || x === THIN_WALL_X + 1 ? WALL : OPEN));
/** The same, horizontal, so tunnelling is tested on both axes. */
const THIN_WALL_Y = 400;
const THIN_HORIZONTAL_WALL = makeMap((_x, y) =>
  y === THIN_WALL_Y || y === THIN_WALL_Y + 1 ? WALL : OPEN,
);

/**
 * The same two walls one pixel thick.
 *
 * A 2 px wall always straddles one of the offsets the probe ring samples, so a
 * ring with holes in it passes the 2 px tests and still cannot see the real
 * table: the shipped collision layer is a ONE pixel outline, and Law 'n Justice
 * alone has 41 horizontal and 11 vertical 1-px solid runs. These are the
 * fixtures that fail when the ring stops being gapless.
 */
const ONE_PX_VERTICAL_WALL = makeMap((x) => (x === THIN_WALL_X ? WALL : OPEN));
const ONE_PX_HORIZONTAL_WALL = makeMap((_x, y) => (y === THIN_WALL_Y ? WALL : OPEN));

function setWith(...balls: readonly { x: number; y: number; vx?: number; vy?: number }[]): BallSet {
  const set = createBallSet();
  for (const spec of balls) {
    spawnBall(set, pixelsToQ10(spec.x), pixelsToQ10(spec.y), spec.vx ?? 0, spec.vy ?? 0);
  }
  return set;
}

function only(set: BallSet) {
  const ball = set.balls[0];
  if (ball === undefined) throw new Error("expected a ball");
  return ball;
}

function snapshot(set: BallSet): string {
  return JSON.stringify(set.balls);
}

describe("ball set bookkeeping", () => {
  it("hands out stable, non-reused ids", () => {
    const set = createBallSet();
    const first = spawnBall(set, pixelsToQ10(10), pixelsToQ10(10));
    const second = spawnBall(set, pixelsToQ10(20), pixelsToQ10(10));
    expect(first.id).toBe(0);
    expect(second.id).toBe(1);
    first.active = false;
    // The id counter must not rewind, or a replay log becomes ambiguous.
    expect(spawnBall(set, pixelsToQ10(30), pixelsToQ10(10)).id).toBe(2);
    expect(ballById(set, 0)).toBe(first);
    expect(activeBallCount(set)).toBe(2);
  });

  it("keeps drained balls in the list so ids stay meaningful", () => {
    const set = setWith({ x: 100, y: BELOW_DRAIN_IN_ONE_TICK, vy: 4096 });
    stepBalls(set, EMPTY_MAP, MATERIALS, GRAVITY);
    expect(set.balls).toHaveLength(1);
    expect(only(set).active).toBe(false);
  });

  it("rejects a negative id", () => {
    expect(() => createBall(-1, 0, 0)).toThrow(RangeError);
  });
});

describe("gravity", () => {
  it("accelerates a free ball downward", () => {
    const set = setWith({ x: 100, y: 100 });
    const ball = only(set);
    let previousVelocity = ball.velocityY;
    let previousY = ball.y;

    for (let tick = 0; tick < 10; tick += 1) {
      stepBalls(set, EMPTY_MAP, MATERIALS, GRAVITY);
      expect(ball.velocityY).toBeGreaterThan(previousVelocity);
      expect(ball.y).toBeGreaterThan(previousY);
      previousVelocity = ball.velocityY;
      previousY = ball.y;
    }
    expect(ball.velocityY).toBe(GRAVITY.gravityY * 10);
  });

  it("does not move a ball sideways on its own", () => {
    const set = setWith({ x: 100, y: 100 });
    for (let tick = 0; tick < 10; tick += 1) stepBalls(set, EMPTY_MAP, MATERIALS, GRAVITY);
    expect(only(set).x).toBe(pixelsToQ10(100));
    expect(only(set).velocityX).toBe(0);
  });

  it("leaves inactive balls alone", () => {
    const set = setWith({ x: 100, y: 100 });
    const ball = only(set);
    ball.active = false;
    stepBalls(set, EMPTY_MAP, MATERIALS, GRAVITY);
    expect(ball.velocityY).toBe(0);
    expect(ball.y).toBe(pixelsToQ10(100));
  });

  it("applies a nudge to every live ball at once", () => {
    const set = setWith({ x: 100, y: 100 }, { x: 200, y: 100 });
    stepBalls(set, EMPTY_MAP, MATERIALS, { gravityY: 0, nudgeX: -300, nudgeY: 0 });
    for (const ball of set.balls) expect(ball.velocityX).toBe(-300);
  });

  it("does not shove a ball that is inside a ramp", () => {
    // A habitrail is a tube and the cabinet does not reach into it; see
    // `nudgeReachesLevel`. Without this one shove was forty times the speed of a
    // ball coasting round Law 'n Justice's top arch, and it replaced the shot
    // rather than perturbing it.
    const set = setWith({ x: 100, y: 100 }, { x: 200, y: 100 });
    const [playfield, ramp] = set.balls;
    if (playfield === undefined || ramp === undefined) throw new Error("expected two balls");
    ramp.level = 1;

    stepBalls(set, EMPTY_MAP, MATERIALS, { gravityY: 0, nudgeX: -300, nudgeY: -400 });

    expect(playfield.velocityX).toBe(-300);
    expect(playfield.velocityY).toBe(-400);
    expect(ramp.velocityX).toBe(0);
    expect(ramp.velocityY).toBe(0);
  });

  it("still pulls a ball inside a ramp downhill", () => {
    // Only the shove is withheld. Gravity applies on every level, or a ball
    // would never come back off a ramp at all.
    const set = setWith({ x: 100, y: 100 });
    const ball = only(set);
    ball.level = 1;
    stepBalls(set, EMPTY_MAP, MATERIALS, { gravityY: SIMULATION_GRAVITY, nudgeX: -300, nudgeY: 0 });
    expect(ball.velocityY).toBe(SIMULATION_GRAVITY);
    expect(ball.velocityX).toBe(0);
  });
});

describe("resting on a floor", () => {
  /** Centre sits one radius above the first solid row; the probe ring just touches it. */
  const RESTING_CENTRE = FLOOR_Y - BALL_RADIUS_PIXELS;

  it("does not sink and does not creep", () => {
    const set = setWith({ x: 100, y: RESTING_CENTRE });
    const ball = only(set);

    for (let tick = 0; tick < 200; tick += 1) {
      stepBalls(set, FLOOR_MAP, MATERIALS, GRAVITY);
      expect(ball.y).toBe(pixelsToQ10(RESTING_CENTRE));
      expect(ball.velocityY).toBe(0);
      expect(ball.active).toBe(true);
    }
  });

  it("settles after a drop instead of bouncing forever", () => {
    const set = setWith({ x: 100, y: RESTING_CENTRE - 12 });
    const ball = only(set);

    for (let tick = 0; tick < 600; tick += 1) stepBalls(set, FLOOR_MAP, MATERIALS, GRAVITY);

    expect(ball.velocityY).toBe(0);
    // Contact is decided at whole-pixel resolution, so the ball comes to rest at
    // whatever sub-pixel height the last substep before a pass carried it to:
    // WITHIN ONE PIXEL of the geometric resting centre, either side of it.
    //
    // IT USED TO SAY "NEVER BELOW IT", and that was a property of the swept-path
    // integrator, which stopped the ball at exact first touch and so could never
    // put the ring inside the material. The machine's frame can and does — its
    // own resting lane ball sits 0.53 to 0.91 px into the floor's band
    // (research/view/reference/session4, cy 553.53..553.91 against a floor whose
    // first solid row is 561) — and this fixture settles 0.14 px in. What may
    // never happen is the ball SINKING, which the tick after tick after tick
    // check below and `never lets the ball reach the floor material` both pin.
    expect(ball.y).toBeLessThan(pixelsToQ10(RESTING_CENTRE + 1));
    expect(ball.y).toBeGreaterThan(pixelsToQ10(RESTING_CENTRE - 1));

    const settled = ball.y;
    for (let tick = 0; tick < 60; tick += 1) {
      stepBalls(set, FLOOR_MAP, MATERIALS, GRAVITY);
      expect(ball.y).toBe(settled);
    }
  });

  it("never lets the ball reach the floor material", () => {
    const set = setWith({ x: 100, y: RESTING_CENTRE - 40, vy: 6000 });
    const ball = only(set);
    for (let tick = 0; tick < 300; tick += 1) {
      stepBalls(set, FLOOR_MAP, MATERIALS, GRAVITY);
      expect(q10ToPixel(ball.y) + BALL_RADIUS_PIXELS).toBeLessThanOrEqual(FLOOR_Y);
    }
  });
});

describe("wall bounces", () => {
  const WALL_X = 250;
  const WALL_MAP = makeMap((x) => (x >= WALL_X ? WALL : OPEN));

  it("reverses direction and loses speed", () => {
    const set = setWith({ x: 100, y: 200, vx: 4096 });
    const ball = only(set);
    const incoming = ball.velocityX;

    let bounced = false;
    for (let tick = 0; tick < 60 && !bounced; tick += 1) {
      stepBalls(set, WALL_MAP, MATERIALS, WEIGHTLESS);
      bounced = ball.velocityX < 0;
    }

    expect(bounced).toBe(true);
    expect(Math.abs(ball.velocityX)).toBeLessThan(incoming);
    // Restitution of the wall material, not an arbitrary damping.
    expect(Math.abs(ball.velocityX)).toBe(
      Math.round((incoming * MATERIALS.behaviourFor(WALL).elasticity) / 1024),
    );
  });

  it("never puts the ball inside the wall", () => {
    const set = setWith({ x: 100, y: 200, vx: 4096 });
    const ball = only(set);
    for (let tick = 0; tick < 200; tick += 1) {
      stepBalls(set, WALL_MAP, MATERIALS, WEIGHTLESS);
      expect(q10ToPixel(ball.x) + BALL_RADIUS_PIXELS).toBeLessThanOrEqual(WALL_X);
    }
  });

  it("reports the contact and the material that caused it", () => {
    const set = setWith({ x: 100, y: 200, vx: 4096 });
    const ball = only(set);
    let seen = false;
    for (let tick = 0; tick < 60 && !seen; tick += 1) {
      const result = stepBalls(set, WALL_MAP, MATERIALS, WEIGHTLESS);
      const contact = result.contacts.get(ball.id);
      if (contact !== undefined) {
        seen = true;
        expect(contact.dominant).toBe(WALL);
        expect(contact.contacts.length).toBeGreaterThan(0);
        // Contacts on the ball's right-hand side, i.e. near angle 0.
        expect(contact.normalAngle).not.toBeNull();
      }
    }
    expect(seen).toBe(true);
  });

  it("reports its contacts on the one shared probe ring", () => {
    // The simulation used to carry a private ring that disagreed with the
    // exported one about size, radius and angles, so a ringIndex meant nothing
    // without knowing which function produced it. There is now one ring.
    expect(DEFAULT_SIMULATION_OPTIONS.radius).toBe(DEFAULT_PROBE_RADIUS);
    const set = setWith({ x: 100, y: 200, vx: 4096 });
    const ball = only(set);
    let checked = 0;
    for (let tick = 0; tick < 60; tick += 1) {
      const contact = stepBalls(set, WALL_MAP, MATERIALS, WEIGHTLESS).contacts.get(ball.id);
      for (const point of contact?.contacts ?? []) {
        expect(point.ringIndex).toBeLessThan(PROBE_RING_SIZE);
        expect(point.angle).toBe(numberAt(PROBE_RING.angle, point.ringIndex));
        // The contact was logged at whatever centre the substep reached, which
        // is not necessarily where the ball ended the tick, so only the offset
        // between the two is fixed: it must be a ring offset.
        expect(Math.hypot(numberAt(PROBE_RING.dx, point.ringIndex), numberAt(PROBE_RING.dy, point.ringIndex)))
          .toBeGreaterThan(BALL_RADIUS_PIXELS - 0.5);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("bounces off the implicit solid border outside the bitmap", () => {
    const set = setWith({ x: 4, y: 200, vx: -3000 });
    const ball = only(set);
    for (let tick = 0; tick < 100; tick += 1) {
      stepBalls(set, EMPTY_MAP, MATERIALS, WEIGHTLESS);
      expect(q10ToPixel(ball.x)).toBeGreaterThanOrEqual(0);
    }
    expect(ball.velocityX).toBeGreaterThan(0);
  });

  it("does not bounce twice off one wall in a single tick", () => {
    const set = setWith({ x: 100, y: 200, vx: 4096 });
    const ball = only(set);
    let previousSpeed = Math.abs(ball.velocityX);
    for (let tick = 0; tick < 200; tick += 1) {
      stepBalls(set, WALL_MAP, MATERIALS, WEIGHTLESS);
      const speed = Math.abs(ball.velocityX);
      // A double resolve would flip the sign back and stall the ball at the wall.
      expect(speed).toBeLessThanOrEqual(previousSpeed);
      previousSpeed = speed;
    }
    expect(previousSpeed).toBeGreaterThan(0);
  });
});

describe("anti-tunnelling", () => {
  const SPEEDS = [8192, 16384, 24576, 32000];

  for (const speed of SPEEDS) {
    it(`stops a ball moving ${speed} Q10/tick at a 2 px vertical wall`, () => {
      const set = setWith({ x: 40, y: 300, vx: speed });
      const ball = only(set);
      for (let tick = 0; tick < 40; tick += 1) {
        stepBalls(set, THIN_VERTICAL_WALL, MATERIALS, WEIGHTLESS);
        expect(q10ToPixel(ball.x)).toBeLessThan(THIN_WALL_X);
      }
    });

    it(`stops a ball falling at ${speed} Q10/tick at a 2 px horizontal wall`, () => {
      const set = setWith({ x: 150, y: 100, vy: speed });
      const ball = only(set);
      for (let tick = 0; tick < 40; tick += 1) {
        stepBalls(set, THIN_HORIZONTAL_WALL, MATERIALS, WEIGHTLESS);
        expect(q10ToPixel(ball.y)).toBeLessThan(THIN_WALL_Y);
        expect(ball.active).toBe(true);
      }
    });

    it(`stops a ball moving ${speed} Q10/tick at a ONE px vertical wall`, () => {
      const set = setWith({ x: 40, y: 300, vx: speed });
      const ball = only(set);
      for (let tick = 0; tick < 40; tick += 1) {
        stepBalls(set, ONE_PX_VERTICAL_WALL, MATERIALS, WEIGHTLESS);
        expect(q10ToPixel(ball.x)).toBeLessThan(THIN_WALL_X);
      }
    });

    it(`stops a ball falling at ${speed} Q10/tick at a ONE px horizontal wall`, () => {
      const set = setWith({ x: 150, y: 100, vy: speed });
      const ball = only(set);
      for (let tick = 0; tick < 40; tick += 1) {
        stepBalls(set, ONE_PX_HORIZONTAL_WALL, MATERIALS, WEIGHTLESS);
        expect(q10ToPixel(ball.y)).toBeLessThan(THIN_WALL_Y);
        expect(ball.active).toBe(true);
      }
    });
  }

  /**
   * The ring blindness was phase-dependent: a 1-px wall was seen from some
   * starting positions and not from others, so a ball launched from the wrong
   * pixel bounced normally at x=188 and froze solid at x=187. Sweeping the whole
   * approach phase is what makes that visible.
   */
  for (let phase = 0; phase < 16; phase += 1) {
    it(`bounces off a 1 px floor approached from phase ${phase}`, () => {
      const start = THIN_WALL_Y - BALL_RADIUS_PIXELS - 16 + phase;
      const set = setWith({ x: 100, y: start, vy: 4096 });
      const ball = only(set);
      let rebounded = false;
      for (let tick = 0; tick < 40 && !rebounded; tick += 1) {
        stepBalls(set, ONE_PX_HORIZONTAL_WALL, MATERIALS, WEIGHTLESS);
        expect(q10ToPixel(ball.y)).toBeLessThan(THIN_WALL_Y);
        rebounded = ball.velocityY < 0;
      }
      expect(rebounded, "the ball never felt the one-pixel floor").toBe(true);
    });

    it(`bounces off a 1 px wall approached from phase ${phase}`, () => {
      const start = THIN_WALL_X - BALL_RADIUS_PIXELS - 16 + phase;
      const set = setWith({ x: start, y: 300, vx: 4096 });
      const ball = only(set);
      let rebounded = false;
      for (let tick = 0; tick < 40 && !rebounded; tick += 1) {
        stepBalls(set, ONE_PX_VERTICAL_WALL, MATERIALS, WEIGHTLESS);
        expect(q10ToPixel(ball.x)).toBeLessThan(THIN_WALL_X);
        rebounded = ball.velocityX < 0;
      }
      expect(rebounded, "the ball never felt the one-pixel wall").toBe(true);
    });
  }

  it("substeps enough that no single move outruns the probe ring", () => {
    // Half the radius: the guarantee the wall tests above depend on, and it is
    // now met by the machine's own frame rather than by a tunable. Eight
    // substeps of `v >> 3` at the original's own velocity clamp is `4095 >> 1`
    // = 2047 Q10 a substep, a quarter of the probe radius.
    expect(DEFAULT_SIMULATION_OPTIONS.maxSubstepDistance).toBe(
      pixelsToQ10(BALL_RADIUS_PIXELS) >> 1,
    );
    expect(DEFAULT_SIMULATION_OPTIONS.maxSubstepDistance * 2).toBeLessThanOrEqual(
      DEFAULT_SIMULATION_OPTIONS.radius,
    );
    expect(VELOCITY_CLAMP_Q10 >> 3).toBeLessThanOrEqual(
      DEFAULT_SIMULATION_OPTIONS.maxSubstepDistance,
    );
  });

  it("moves a slow ball by the machine's own truncated substep, eight times", () => {
    // THE MACHINE TRUNCATES PER SUBSTEP AND SO DOES THIS. `pos += v >> 1` on a
    // velocity word that is a quarter of this port's Q10 is `pos += v >> 3`, an
    // arithmetic shift, run eight times — so a tick of 100 Q10 advances the ball
    // by `8 * (100 >> 3)` = 96 and not by 100. The four low bits are lost to the
    // shift exactly as the original loses them, and this used to assert the 100
    // that a single whole-tick add produced. Verified against the machine's own
    // RAM: 693 of 703 uniform-acceleration frames of the session-4 traces
    // reproduce their next position exactly under this rule.
    const set = setWith({ x: 100, y: 100, vx: 100 });
    stepBalls(set, EMPTY_MAP, MATERIALS, WEIGHTLESS);
    expect(only(set).x).toBe(pixelsToQ10(100) + 8 * (100 >> 3));
    expect(only(set).x).toBe(pixelsToQ10(100) + 96);

    // ...and it floors for negatives, because `asr` does.
    const back = setWith({ x: 100, y: 100, vx: -100 });
    stepBalls(back, EMPTY_MAP, MATERIALS, WEIGHTLESS);
    expect(only(back).x).toBe(pixelsToQ10(100) + 8 * (-100 >> 3));
    expect(only(back).x).toBe(pixelsToQ10(100) - 104);
  });

  it("never lets the CENTRE into solid material however deep the ring goes", () => {
    // The decoded contact rule deliberately reads the ring from INSIDE the
    // material — that is the whole point of it — so the ring being buried is no
    // longer evidence of anything. The centre is the line that is still held,
    // and `advanceCentre` holds it at every one of the eight substeps.
    for (const speed of [4096, 8192, VELOCITY_CLAMP_Q10]) {
      const set = setWith({ x: 40, y: 300, vx: speed });
      const ball = only(set);
      for (let tick = 0; tick < 60; tick += 1) {
        stepBalls(set, ONE_PX_VERTICAL_WALL, MATERIALS, WEIGHTLESS);
        expect(
          MATERIALS.behaviourFor(ONE_PX_VERTICAL_WALL.materialAt(q10ToPixel(ball.x), q10ToPixel(ball.y)))
            .passable,
          `centre inside the wall at speed ${speed}`,
        ).toBe(true);
      }
    }
  });
});

describe("ball-to-ball collisions", () => {
  it("exchanges momentum along the line of centres", () => {
    const moving = createBall(0, pixelsToQ10(100), pixelsToQ10(300), 1000, 0);
    const resting = createBall(1, pixelsToQ10(115), pixelsToQ10(300), 0, 0);

    resolveBallCollisions([moving, resting], DEFAULT_SIMULATION_OPTIONS.radius);

    expect(moving.velocityX).toBe(0);
    expect(resting.velocityX).toBe(1000);
    expect(moving.velocityY).toBe(0);
    expect(resting.velocityY).toBe(0);
  });

  it("conserves total momentum in a head-on exchange", () => {
    const left = createBall(0, pixelsToQ10(100), pixelsToQ10(300), 900, 0);
    const right = createBall(1, pixelsToQ10(114), pixelsToQ10(300), -500, 0);
    const before = left.velocityX + right.velocityX;

    resolveBallCollisions([left, right], DEFAULT_SIMULATION_OPTIONS.radius);

    expect(left.velocityX + right.velocityX).toBe(before);
    expect(left.velocityX).toBe(-500);
    expect(right.velocityX).toBe(900);
  });

  it("pushes overlapping balls apart", () => {
    const a = createBall(0, pixelsToQ10(100), pixelsToQ10(300));
    const b = createBall(1, pixelsToQ10(104), pixelsToQ10(300));

    resolveBallCollisions([a, b], DEFAULT_SIMULATION_OPTIONS.radius);

    expect(b.x - a.x).toBeGreaterThan(pixelsToQ10(4));
  });

  it("separates two balls spawned on exactly the same pixel", () => {
    const a = createBall(0, pixelsToQ10(100), pixelsToQ10(300));
    const b = createBall(1, pixelsToQ10(100), pixelsToQ10(300));

    resolveBallCollisions([a, b], DEFAULT_SIMULATION_OPTIONS.radius);

    expect(b.x).toBeGreaterThan(a.x);
    expect(a.y).toBe(b.y);
  });

  it("leaves separating balls alone", () => {
    const a = createBall(0, pixelsToQ10(100), pixelsToQ10(300), -600, 0);
    const b = createBall(1, pixelsToQ10(115), pixelsToQ10(300), 600, 0);

    resolveBallCollisions([a, b], DEFAULT_SIMULATION_OPTIONS.radius);

    expect(a.velocityX).toBe(-600);
    expect(b.velocityX).toBe(600);
  });

  it("ignores drained balls", () => {
    const a = createBall(0, pixelsToQ10(100), pixelsToQ10(300), 1000, 0);
    const b = createBall(1, pixelsToQ10(115), pixelsToQ10(300), 0, 0);
    b.active = false;

    resolveBallCollisions([a, b], DEFAULT_SIMULATION_OPTIONS.radius);

    expect(a.velocityX).toBe(1000);
    expect(b.velocityX).toBe(0);
  });

  it("happens during a normal tick, so multiball actually interacts", () => {
    const set = setWith({ x: 100, y: 300, vx: 1024 }, { x: 140, y: 300, vx: -1024 });
    const [a, b] = set.balls;
    if (a === undefined || b === undefined) throw new Error("expected two balls");

    for (let tick = 0; tick < 40; tick += 1) {
      stepBalls(set, EMPTY_MAP, MATERIALS, WEIGHTLESS);
    }

    expect(a.velocityX).toBe(-1024);
    expect(b.velocityX).toBe(1024);
    expect(a.velocityX + b.velocityX).toBe(0);
  });

  it("can be switched off without changing anything else", () => {
    const set = setWith({ x: 100, y: 300, vx: 1024 }, { x: 140, y: 300, vx: -1024 });
    for (let tick = 0; tick < 40; tick += 1) {
      stepBalls(set, EMPTY_MAP, MATERIALS, WEIGHTLESS, { ballToBall: false });
    }
    const [a, b] = set.balls;
    if (a === undefined || b === undefined) throw new Error("expected two balls");
    expect(a.velocityX).toBe(1024);
    expect(b.velocityX).toBe(-1024);
  });

  it("keeps six balls apart without any of them fusing", () => {
    const set = createBallSet();
    for (let i = 0; i < 6; i += 1) {
      spawnBall(set, pixelsToQ10(120 + i * 3), pixelsToQ10(300), 0, 0);
    }
    for (let tick = 0; tick < 200; tick += 1) {
      stepBalls(set, EMPTY_MAP, MATERIALS, WEIGHTLESS);
    }
    const diameter = DEFAULT_SIMULATION_OPTIONS.radius * 2;
    for (let i = 0; i < set.balls.length; i += 1) {
      for (let j = i + 1; j < set.balls.length; j += 1) {
        const a = set.balls[i];
        const b = set.balls[j];
        if (a === undefined || b === undefined) throw new Error("missing ball");
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        expect(integerSqrt(dx * dx + dy * dy)).toBeGreaterThanOrEqual(diameter - 1);
      }
    }
  });

  it("does not bury a stacked ball in the floor it is resting on", () => {
    // The separation push used to test the centre pixel alone, so the weight of
    // the ball above drove the lower one a full radius into the floor.
    const restingCentre = FLOOR_Y - BALL_RADIUS_PIXELS;
    const set = setWith({ x: 100, y: restingCentre }, { x: 100, y: restingCentre - 16 });
    for (let tick = 0; tick < 600; tick += 1) {
      stepBalls(set, FLOOR_MAP, MATERIALS, GRAVITY);
      for (const ball of set.balls) {
        expect(q10ToPixel(ball.y) + BALL_RADIUS_PIXELS).toBeLessThanOrEqual(FLOOR_Y);
      }
    }
  });
});

describe("draining", () => {
  it("reports and deactivates a ball that leaves the bottom", () => {
    const set = setWith({ x: 100, y: BELOW_DRAIN_IN_ONE_TICK, vy: 4096 });
    const ball = only(set);

    const result = stepBalls(set, EMPTY_MAP, MATERIALS, GRAVITY);

    expect(result.drained).toEqual([ball.id]);
    expect(ball.active).toBe(false);
  });

  it("reports each ball exactly once", () => {
    const set = setWith({ x: 100, y: BELOW_DRAIN_IN_ONE_TICK, vy: 4096 });
    stepBalls(set, EMPTY_MAP, MATERIALS, GRAVITY);
    expect(stepBalls(set, EMPTY_MAP, MATERIALS, GRAVITY).drained).toEqual([]);
  });

  it("drains only the balls that actually fell out", () => {
    const set = setWith({ x: 100, y: BELOW_DRAIN_IN_ONE_TICK, vy: 4096 }, { x: 200, y: 100 });
    const [falling, safe] = set.balls;
    if (falling === undefined || safe === undefined) throw new Error("expected two balls");

    const result = stepBalls(set, EMPTY_MAP, MATERIALS, GRAVITY);

    expect(result.drained).toEqual([falling.id]);
    expect(safe.active).toBe(true);
  });

  it("does not bounce off the bottom edge on the way out", () => {
    // The map's out-of-bounds material is solid; the drain must still be open.
    const set = setWith({ x: 100, y: HEIGHT - 10, vy: 8192 });
    const ball = only(set);
    let drained = false;
    for (let tick = 0; tick < 20 && !drained; tick += 1) {
      drained = stepBalls(set, EMPTY_MAP, MATERIALS, GRAVITY).drained.length > 0;
    }
    expect(drained).toBe(true);
    expect(ball.velocityY).toBeGreaterThan(0);
  });

  it("honours an explicit drain line above the map bottom", () => {
    const set = setWith({ x: 100, y: 300, vy: 4096 });
    const result = stepBalls(set, EMPTY_MAP, MATERIALS, GRAVITY, { drainY: pixelsToQ10(302) });
    expect(result.drained).toEqual([only(set).id]);
  });
});

describe("contact probing", () => {
  it("finds nothing in open space", () => {
    const result = probeContacts(EMPTY_MAP, MATERIALS, pixelsToQ10(150), pixelsToQ10(300));
    expect(result.contacts).toEqual([]);
    expect(result.normalAngle).toBeNull();
    expect(result.dominant).toBeNull();
  });

  it("points at the floor when sitting on it", () => {
    const result = probeContacts(
      FLOOR_MAP,
      MATERIALS,
      pixelsToQ10(150),
      pixelsToQ10(FLOOR_Y - BALL_RADIUS_PIXELS),
    );
    // 512 of 2048 units is straight down in the original's angle scale.
    expect(result.normalAngle).toBe(512);
    expect(result.dominant).toBe(WALL);
  });

  it("points at a wall on the right", () => {
    const wallMap = makeMap((x) => (x >= 250 ? WALL : OPEN));
    const result = probeContacts(
      wallMap,
      MATERIALS,
      pixelsToQ10(250 - BALL_RADIUS_PIXELS),
      pixelsToQ10(300),
    );
    expect(result.normalAngle).toBe(0);
  });

  it("treats rows below the map as open, not as border", () => {
    const result = probeContacts(EMPTY_MAP, MATERIALS, pixelsToQ10(150), pixelsToQ10(HEIGHT - 1));
    expect(result.contacts).toEqual([]);
  });
});

describe("determinism", () => {
  /** Walls, a floor, gravity, nudges and six interacting balls: everything at once. */
  function run(): string {
    const map = makeMap((x, y) => {
      if (y >= 560) return WALL;
      if (x < 6 || x >= WIDTH - 6) return WALL;
      if (y >= 300 && y < 302 && x > 80 && x < 260) return WALL;
      return OPEN;
    });

    const set = createBallSet();
    for (let i = 0; i < 6; i += 1) {
      spawnBall(set, pixelsToQ10(60 + i * 34), pixelsToQ10(120 + i * 9), 900 - i * 370, i * 210);
    }

    const drained: number[] = [];
    for (let tick = 0; tick < 500; tick += 1) {
      // A fixed, arbitrary-looking input sequence — no clock, no randomness.
      const nudging = tick % 97 === 0;
      const forces: SimulationForces = {
        gravityY: SIMULATION_GRAVITY,
        nudgeX: nudging ? (tick % 194 === 0 ? 1800 : -1800) : 0,
        nudgeY: 0,
      };
      drained.push(...stepBalls(set, map, MATERIALS, forces).drained);
    }
    return `${snapshot(set)}|${JSON.stringify(drained)}`;
  }

  it("reproduces a long run exactly", () => {
    expect(run()).toBe(run());
  });

  it("keeps every position and velocity an integer throughout", () => {
    const set = setWith({ x: 100, y: 100, vx: 733, vy: -421 });
    for (let tick = 0; tick < 400; tick += 1) {
      stepBalls(set, FLOOR_MAP, MATERIALS, GRAVITY);
      for (const ball of set.balls) {
        expect(Number.isInteger(ball.x)).toBe(true);
        expect(Number.isInteger(ball.y)).toBe(true);
        expect(Number.isInteger(ball.velocityX)).toBe(true);
        expect(Number.isInteger(ball.velocityY)).toBe(true);
      }
    }
  });

  it("keeps velocities inside signed 16-bit range under sustained gravity", () => {
    const set = setWith({ x: 100, y: 100 });
    const ball = only(set);
    for (let tick = 0; tick < 5000; tick += 1) {
      stepBalls(set, EMPTY_MAP, MATERIALS, { gravityY: 900, nudgeX: 0, nudgeY: 0 }, {
        drainY: pixelsToQ10(1_000_000),
      });
      expect(ball.velocityY).toBeLessThanOrEqual(32767);
      expect(ball.velocityY).toBeGreaterThanOrEqual(-32767);
    }
  });
});

describe("integerSqrt", () => {
  it("matches Math.sqrt on exact squares and floors otherwise", () => {
    for (const value of [0, 1, 2, 3, 4, 9, 15, 16, 17, 1023, 1024, 16384 * 16384]) {
      expect(integerSqrt(value)).toBe(Math.floor(Math.sqrt(value)));
    }
  });

  it("is zero for non-positive input", () => {
    expect(integerSqrt(0)).toBe(0);
    expect(integerSqrt(-5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The virtual top wall, on the table that needs it
// ---------------------------------------------------------------------------

function mapForTable(tableId: TableId): TableMap {
  return parseTableMapDocument(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../public/generated/tables/${tableId}.map.json`, import.meta.url)),
        "utf8",
      ),
    ) as TableMapDocument,
  );
}

const LAW_MAP: TableMap = mapForTable("law-n-justice");
const LAW_MATERIALS = materialTableFor("law-n-justice");
const LAW_TOP_WALL = VIRTUAL_TOP_WALL_ROWS["law-n-justice"];

/** Clear of solid material at a radius of 8, in the upper playfield. */
const UPPER_SPAWNS: readonly (readonly [number, number])[] = [
  [60, 40],
  [150, 60],
  [250, 40],
];

/** The same, plus two lower ones, so a 400-tick run reaches the drain. */
const DROP_SPAWNS: readonly (readonly [number, number])[] = [
  ...UPPER_SPAWNS,
  [100, 200],
  [200, 150],
];

describe("the Law 'n Justice top border", () => {
  it("is genuinely missing from the shipped collision layer", () => {
    // The premise of the whole correction. If this ever fails, the map was
    // re-exported and the virtual wall should be reconsidered, not adjusted.
    let solidPixels = 0;
    for (let y = 0; y < LAW_TOP_WALL; y += 1) {
      for (let x = 0; x < LAW_MAP.width; x += 1) {
        if (!LAW_MATERIALS.behaviourFor(LAW_MAP.materialAt(x, y)).passable) solidPixels += 1;
      }
    }
    expect(solidPixels).toBe(0);
  });

  it("is 26 rows on Law 'n Justice and nothing on the other two tables", () => {
    expect(LAW_TOP_WALL).toBe(26);
    expect(VIRTUAL_TOP_WALL_ROWS.babewatch).toBe(0);
    expect(VIRTUAL_TOP_WALL_ROWS["extreme-sports"]).toBe(0);
  });

  it("seals exactly the rows it says and leaves the rest of the map alone", () => {
    const view = playfieldViewFor(LAW_MAP, LAW_TOP_WALL);
    for (const x of [0, 1, 167, 300, 335]) {
      expect(LAW_MATERIALS.behaviourFor(view.materialAt(x, LAW_TOP_WALL - 1)).passable).toBe(false);
      for (let y = LAW_TOP_WALL; y < LAW_TOP_WALL + 40; y += 1) {
        expect(view.materialAt(x, y)).toBe(LAW_MAP.materialAt(x, y));
      }
    }
    // The artwork is untouched: the wall exists for the physics only.
    expect(view.pixels).toBe(LAW_MAP.pixels);
    expect(playfieldViewFor(LAW_MAP, 0)).toBe(LAW_MAP);
  });

  for (const [x, y] of UPPER_SPAWNS) {
    it(`stops a ball fired upward from (${x},${y}) from leaving over the top`, () => {
      const set = createBallSet();
      spawnBall(set, pixelsToQ10(x), pixelsToQ10(y), 0, -8192);
      const ball = only(set);
      for (let tick = 0; tick < 300; tick += 1) {
        stepBalls(set, LAW_MAP, LAW_MATERIALS, GRAVITY);
        if (!ball.active) break;
        expect(
          q10ToPixel(ball.y),
          `tick ${tick}: centre above the virtual wall`,
        ).toBeGreaterThanOrEqual(LAW_TOP_WALL);
      }
    });
  }

  it("is what stops it: without the wall the same ball escapes into the attic", () => {
    // Falsifiability. Rows 0..34 carry no collision line at all, so an unsealed
    // table lets the ball over the arch and across the full width of the map.
    const set = createBallSet();
    spawnBall(set, pixelsToQ10(60), pixelsToQ10(40), 0, -8192);
    const ball = only(set);
    let highest = q10ToPixel(ball.y);
    for (let tick = 0; tick < 300 && ball.active; tick += 1) {
      stepBalls(set, LAW_MAP, LAW_MATERIALS, GRAVITY, { topWallRows: 0 });
      highest = Math.min(highest, q10ToPixel(ball.y));
    }
    expect(highest).toBeLessThan(LAW_TOP_WALL);
  });

  it("does not seal the playfield: balls still fall and still drain", () => {
    const set = createBallSet();
    for (const [x, y] of DROP_SPAWNS) spawnBall(set, pixelsToQ10(x), pixelsToQ10(y));
    const startY = set.balls.map((ball) => ball.y);

    let drained = 0;
    for (let tick = 0; tick < 400; tick += 1) {
      drained += stepBalls(set, LAW_MAP, LAW_MATERIALS, GRAVITY).drained.length;
    }

    expect(set.balls.some((ball, index) => ball.y > (startY[index] ?? 0))).toBe(true);
    expect(drained).toBeGreaterThan(0);
  });

  it("rejects a wall that is not a whole number of rows inside the map", () => {
    const set = setWith({ x: 100, y: 100 });
    for (const rows of [-1, 1.5, HEIGHT]) {
      expect(() => stepBalls(set, EMPTY_MAP, MATERIALS, GRAVITY, { topWallRows: rows })).toThrow(
        RangeError,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The bounce must not depend on how finely the tick is cut
// ---------------------------------------------------------------------------

/**
 * `maxSubstepDistance` used to be the step size, and a substep that found
 * contact was re-run from its own start — so the approach it had already
 * covered was thrown away, and the discarded distance was one substep's worth.
 * Dropping a ball from y = 388 px at vy = 8191 onto a floor at y = 400 ended at
 * 383.001 px with one substep and 389.499 px with two: same start, same
 * velocity, same wall, 6.5 px apart. The outgoing VELOCITY was already
 * independent of the count; the position was not, and the gap appeared at every
 * speed that happened to be a multiple of the substep distance.
 *
 * These fixtures pin the position, so a future change that reintroduces
 * per-substep arithmetic fails here rather than as a mysterious kink in a
 * trajectory.
 */
describe("substep independence", () => {
  /** Values of maxSubstepDistance that used to cut an 8191 Q10 tick into 1..16. */
  const CUTS: readonly number[] = Array.from({ length: 16 }, (_, i) => Math.ceil(8191 / (i + 1)));

  function stateAfter(
    map: TableMap,
    forces: SimulationForces,
    spec: { x: number; y: number; vx?: number; vy?: number },
    cut: number,
    ticks: number,
  ): string {
    const set = setWith(spec);
    for (let tick = 0; tick < ticks; tick += 1) {
      stepBalls(set, map, MATERIALS, forces, { maxSubstepDistance: cut });
    }
    return snapshot(set);
  }

  const CASES: readonly {
    readonly name: string;
    readonly map: TableMap;
    readonly forces: SimulationForces;
    readonly spec: { x: number; y: number; vx?: number; vy?: number };
    readonly ticks: number;
  }[] = [
    {
      name: "a floor bounce",
      map: FLOOR_MAP,
      forces: WEIGHTLESS,
      spec: { x: 100, y: 388, vy: 8191 },
      ticks: 1,
    },
    {
      name: "a wall bounce",
      map: ONE_PX_VERTICAL_WALL,
      forces: WEIGHTLESS,
      spec: { x: 180, y: 300, vx: 8191 },
      ticks: 1,
    },
    {
      name: "a diagonal approach",
      map: FLOOR_MAP,
      forces: GRAVITY,
      spec: { x: 100, y: 380, vx: 5000, vy: 6500 },
      ticks: 1,
    },
    {
      name: "forty ticks of bouncing under gravity",
      map: FLOOR_MAP,
      forces: GRAVITY,
      spec: { x: 100, y: 340, vx: 3000, vy: 8191 },
      ticks: 40,
    },
  ];

  for (const { name, map, forces, spec, ticks } of CASES) {
    it(`puts ${name} in exactly the same place for every substep count`, () => {
      const first = CUTS[0];
      if (first === undefined) throw new Error("expected substep cuts");
      const expected = stateAfter(map, forces, spec, first, ticks);
      for (const cut of CUTS) {
        expect(stateAfter(map, forces, spec, cut, ticks), `maxSubstepDistance ${cut}`).toBe(
          expected,
        );
      }
    });
  }

  it("bounces in these fixtures at all, so the agreement is not agreement on nothing", () => {
    const set = setWith({ x: 100, y: 388, vy: 8191 });
    const ball = only(set);
    stepBalls(set, FLOOR_MAP, MATERIALS, WEIGHTLESS);
    expect(ball.velocityY).toBeLessThan(0);
    // Exactly the wall's restitution applied to the incoming speed, whatever the
    // tick was cut into. Derived from the coefficient as well as pinned to a
    // literal: this file is about the substep count not changing the answer, and
    // the answer moved from -5119 to -2432 when the plain wall stopped being a
    // chosen 0.625 and became the measured 304/1024. See materials.ts.
    const elasticity = MATERIALS.behaviourFor(WALL).elasticity;
    expect(ball.velocityY).toBe(-Math.round((8191 * elasticity) / 1024));
    expect(ball.velocityY).toBe(-2432);
  });

  it("keeps the approach the ball made before the bounce instead of discarding it", () => {
    // The ball falls 4 px onto the floor and rebounds, slower, for what is left
    // of the tick, so it must end BELOW where it started. Re-running the substep
    // from the unmoved position threw the approach away and finished the tick
    // 5 px ABOVE the start — further up than the ball had time to travel.
    const set = setWith({ x: 100, y: 388, vy: 8191 });
    const ball = only(set);
    stepBalls(set, FLOOR_MAP, MATERIALS, WEIGHTLESS);
    expect(ball.y).toBeGreaterThan(pixelsToQ10(388));
  });

  /**
   * THE BOUNCE POSITION IS QUANTISED TO THE MACHINE'S SUBSTEP GRID, AND THAT IS
   * THE POINT RATHER THAN A DEFECT.
   *
   * These two used to assert that the tick's answer is CONTINUOUS in the
   * incoming velocity — that one Q10 unit more speed could not move the bounce
   * by more than a thirtieth of a pixel. That was a true and load-bearing
   * statement about the swept-path integrator, whose whole design was to make
   * the bounce independent of how the tick was cut, and it is a FALSE statement
   * about the machine. The machine evaluates contact at four fixed points on an
   * eight-substep grid; a velocity that moves the contact from one pass to the
   * next moves the bounce by the two substeps between them, and the arch
   * staircase this port was rebuilt around — 14.12 / 10.79 / 17.24 degrees from
   * a quarter pixel of approach phase — is exactly that discreteness seen from
   * the other side (research/ARCH_NORMAL_DECODE.md sections 3 and 6).
   *
   * So the invariant is restated at its real size: the answer may jump, but
   * never by more than the grid it is quantised to. That still catches the
   * defect the originals were written for — a tick cut into a different number
   * of pieces landing somewhere else entirely — because the grid is now fixed at
   * eight and cannot be changed by any option.
   */
  it("moves the bounce by at most the substep grid it is quantised to", () => {
    // Across 8000..8400 the OLD fixed-substep version stepped 6653 units
    // (6.5 px) between 8191 and 8192, where the tick went from one substep to
    // two. The grid bound below is 2 * (8400 >> 3) = 2100 Q10, two substeps of
    // the fastest ball in the sweep; measured worst case is 2650 at the single
    // velocity where the responding pass changes, which is under the three
    // substeps a pass-to-pass move plus its own truncation can cover.
    const grid = 3 * (8400 >> 3);
    let previous: number | null = null;
    let largest = 0;
    for (let velocityY = 8000; velocityY <= 8400; velocityY += 1) {
      const set = setWith({ x: 100, y: 388, vy: velocityY });
      stepBalls(set, FLOOR_MAP, MATERIALS, WEIGHTLESS);
      const y = only(set).y;
      if (previous !== null) largest = Math.max(largest, Math.abs(y - previous));
      previous = y;
    }
    expect(largest).toBeLessThanOrEqual(grid);
    // And it really is a staircase rather than noise: almost every neighbouring
    // pair agrees to within a substep, and only a handful jump at all.
    let jumps = 0;
    previous = null;
    for (let velocityY = 8000; velocityY <= 8400; velocityY += 1) {
      const set = setWith({ x: 100, y: 388, vy: velocityY });
      stepBalls(set, FLOOR_MAP, MATERIALS, WEIGHTLESS);
      const y = only(set).y;
      if (previous !== null && Math.abs(y - previous) > 8400 >> 3) jumps += 1;
      previous = y;
    }
    expect(jumps).toBeLessThanOrEqual(4);
  });

  it("is quantised by the machine's grid and by nothing else", () => {
    // The old cut boundary at 8191/8192 was an artefact of `maxSubstepDistance`
    // and is gone: the answer there is now whatever the fixed eight-substep grid
    // says, and it says the same thing for every value of that option.
    const at = (velocityY: number, cut: number): number => {
      const set = setWith({ x: 100, y: 388, vy: velocityY });
      stepBalls(set, FLOOR_MAP, MATERIALS, WEIGHTLESS, { maxSubstepDistance: cut });
      return only(set).y;
    };
    for (const velocityY of [8191, 8192]) {
      const expected = at(velocityY, 8191);
      for (const cut of CUTS) expect(at(velocityY, cut), `cut ${cut}`).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// No tick may leave the simulation where it found it
// ---------------------------------------------------------------------------

/**
 * The one invariant the integrator may never break: a tick must not leave BOTH
 * the position and the velocity exactly as it found them while the ball still
 * has speed. Such a tick is a fixed point — every later tick recomputes it
 * bit-for-bit — and the ball is lost for the rest of the game while the display
 * insists it is moving.
 */
describe("no tick is a no-op", () => {
  /**
   * Runs one ball until it drains and reports the first state the simulation
   * repeated three times in a row with speed still on the books.
   */
  function firstFixedPoint(
    map: TableMap,
    materials: typeof LAW_MATERIALS,
    x: number,
    y: number,
    velocityX: number,
    velocityY: number,
    ticks: number,
  ): string | null {
    const set = createBallSet();
    const ball = spawnBall(set, pixelsToQ10(x), pixelsToQ10(y), velocityX, velocityY);
    let previous = "";
    let repeats = 0;
    for (let tick = 0; tick < ticks && ball.active; tick += 1) {
      stepBalls(set, map, materials, GRAVITY);
      const state = `${ball.x},${ball.y},${ball.velocityX},${ball.velocityY}`;
      if (state === previous && (ball.velocityX !== 0 || ball.velocityY !== 0)) {
        repeats += 1;
        if (repeats > 2) return `spawn (${x},${y}) v=(${velocityX},${velocityY}) state=${state}`;
      } else {
        repeats = 0;
      }
      previous = state;
    }
    return null;
  }

  it("holds a ball wedged in a channel narrower than itself to a thousandth of a pixel", () => {
    // Law 'n Justice has a slot at (86, 156) between rails at x=76..78 and
    // x=94..96 — 15 px of clear width, and a 16 px ball that finds its way in
    // cannot get out again. It used to drift one Q10 unit down, bounce, drift
    // back up and end every tick on the pixel it started on carrying vy = -1:
    // position and velocity both unchanged, speed still non-zero, forever.
    //
    // The site read (54, 156) until the maps were re-exported on the correct
    // 32 px frame. It is the same slot, 32 columns right; the ROW is untouched,
    // and so is every expectation below, because what this test is about was
    // never about where on the table the slot happens to be.
    // WHAT THIS ASSERTS CHANGED TWICE, AND BOTH CHANGES ARE WORTH READING.
    //
    // At the port's old gravity of 24 the ball came to a dead halt here in ten
    // ticks, velocity exactly zero. At the measured gravity of 128 it stopped
    // doing that and settled into a two-tick cycle instead: one Q10 unit — a
    // thousandth of a pixel — of horizontal rattle, carrying vy = -2 for ever,
    // because a tick of gravity is 128 units against a wedge that hands almost
    // all of it straight back and the residue no longer rounds to nothing.
    //
    // IT IS A DEAD HALT AGAIN, and this site is exactly the shape the contact
    // angle changed on. A ball wedged between two rails touches BOTH, which is a
    // multi-arc contact: the vector mean cancelled to zero and fell back to
    // `contacts[0]` — one wall, arbitrarily — so every tick shoved the ball off
    // that one rail and gravity fed it back. The machine's arithmetic mean of
    // the tabulated bearings has no cancellation and no fallback (see
    // `meanContactAngle`); it answers to both walls at once and the reflection
    // takes the residue out. Measured over the same thousand ticks: ONE distinct
    // state, (88064, 159742) at velocity (0, 0), where the old rule cycled
    // through two.
    //
    // AND NOW IT IS NOT A WEDGE AT ALL. Under the machine's own frame — eight
    // substeps with a contact pass in front of four of them — the ball rattles
    // in the slot for sixteen ticks and then LEAVES it, rolls down the table and
    // comes to a dead halt on row 205. That is the decoded per-contact toll
    // being charged four times a frame instead of once (the ROLLING_SLIP_FRICTION
    // header's own "the bounce runs FOUR times a frame") and the ball reading its
    // contact from wherever the substep grid puts it rather than from exact
    // tangency, which is what stops the slot handing back everything it takes.
    //
    // The defect the test exists for is unchanged and still asserted: a FIXED
    // POINT WITH SPEED STILL ON THE BOOKS, which no tick may leave behind
    // because every later tick then repeats it exactly. There is none on the way
    // out, and the ball ends at velocity exactly zero, which is a ball at rest
    // and is what the ball search's radius-8 box collects.
    const set = createBallSet();
    const ball = spawnBall(set, 88064, 159742, 0, -1);
    expect(
      firstFixedPoint(LAW_MAP, LAW_MATERIALS, 88064, 159742, 0, -1, 2000),
      "a fixed point with speed on the way out of the slot",
    ).toBeNull();

    for (let tick = 0; tick < 2000; tick += 1) stepBalls(set, LAW_MAP, LAW_MATERIALS, GRAVITY);
    const settledX = ball.x;
    const settledY = ball.y;
    expect(ball.velocityX).toBe(0);
    expect(ball.velocityY).toBe(0);
    for (let tick = 0; tick < 1000; tick += 1) {
      stepBalls(set, LAW_MAP, LAW_MATERIALS, GRAVITY);
      expect(ball.x).toBe(settledX);
      expect(ball.y).toBe(settledY);
      expect(ball.velocityX).toBe(0);
      expect(ball.velocityY).toBe(0);
    }
    // It left the slot: row 155 is where it went in, and it is not there now.
    expect(ball.y >> 10).toBeGreaterThan(155);
  });

  it("finds no fixed point anywhere across the real playfield", () => {
    const launches: string[] = [];
    for (let x = 12; x < 330; x += 16) {
      for (const y of [90, 300]) {
        for (const [velocityX, velocityY] of [
          [0, -9000],
          [16000, 16000],
          [-30000, -30000],
        ] as const) {
          const found = firstFixedPoint(LAW_MAP, LAW_MATERIALS, x, y, velocityX, velocityY, 1200);
          if (found !== null) launches.push(found);
        }
      }
    }
    expect(launches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Friction is an impulse, not a percentage
// ---------------------------------------------------------------------------

describe("contact friction", () => {
  /** A plain wall's coefficients, straight out of materials.ts. */
  const wall = MATERIALS.behaviourFor(WALL);
  const REST = DEFAULT_SIMULATION_OPTIONS.restThreshold;

  it("costs a resting contact no more than the friction times one tick of gravity", () => {
    // The bug this replaced took a flat 15% of the ball's WHOLE tangential
    // speed on every tick it was in contact, which for a ball merely lying on a
    // surface is every tick, since `stepBalls` adds gravity before integrating.
    // Coulomb's rule bounds the tangential loss by the normal impulse, and for a
    // resting ball that impulse is one tick of gravity and nothing else.
    const sliding = 4000;
    const ball = createBall(0, 0, 0, sliding, GRAVITY.gravityY);
    // Flat floor: outward normal points straight up.
    reflectVelocity(ball, wall, 0, -1024, REST);

    const lost = sliding - ball.velocityX;
    expect(lost).toBeGreaterThan(0);
    // The bound is DERIVED rather than a round number, because a round number is
    // what let this go stale: it used to read `<= 10`, which was generous room
    // around `friction * 24` = 3.6 and is a hard failure against the measured
    // gravity of 128, where the same rule costs `friction * 128` = 19. What the
    // rule says is the same in both cases — the loss is the friction times ONE
    // TICK OF GRAVITY — so that is what is asserted, plus the one Q10 quantum
    // the scaling can round up by. The percentage model took 600.
    const budget = q10Multiply(WALL_FRICTION, GRAVITY.gravityY);
    expect(lost).toBeLessThanOrEqual(budget + 1);
    expect(lost).toBeLessThan(sliding / 100);
  });

  it("still scrubs a real impact, in proportion to how hard it lands", () => {
    const soft = createBall(0, 0, 0, 8000, 400);
    const hard = createBall(1, 0, 0, 8000, 12000);
    reflectVelocity(soft, wall, 0, -1024, REST);
    reflectVelocity(hard, wall, 0, -1024, REST);
    expect(8000 - soft.velocityX).toBeGreaterThan(0);
    expect(8000 - hard.velocityX).toBeGreaterThan(8000 - soft.velocityX);
  });

  it("never drives the tangential speed past zero into a reversal", () => {
    // A loss bounded by the sliding speed itself. A huge normal impulse against
    // a barely-sliding ball must stop it, not push it backwards.
    const ball = createBall(0, 0, 0, 5, 30000);
    reflectVelocity(ball, wall, 0, -1024, REST);
    expect(ball.velocityX).toBe(0);
  });

  it("always costs at least one unit, so a sliding contact cannot idle forever", () => {
    // Below about seven units of normal impulse `friction * impulse` truncates
    // to nothing, and a ball wedged in a corner sits exactly there: on Law 'n
    // Justice one held v = (-1, 1) for seven hundred consecutive ticks, moving
    // one Q10 unit a tick — half a pixel per ball-search window, which is why
    // the search wrote off a ball that the model said was still moving.
    const ball = createBall(0, 0, 0, 40, 1);
    reflectVelocity(ball, wall, 0, -1024, REST);
    expect(ball.velocityX).toBeLessThan(40);
  });

  it("lets a ball on a slope accelerate instead of settling into a crawl", () => {
    // The whole point. Under the percentage model a ball on any slope reached a
    // terminal `g * sin(theta) * (1 - f) / f` — about 135 * sin(theta) Q10 per
    // tick, a pixel every few seconds — and stayed there for ever. Under
    // Coulomb it keeps gaining speed as long as the slope beats the friction
    // angle. A 45-degree ramp: floor at y = x, so the outward normal is up-left.
    const ramp = makeMap((x, y) => (y >= 300 + (x - 100) ? WALL : OPEN));
    const set = setWith({ x: 100, y: 280 });
    const ball = only(set);

    // The window is shorter than it was — samples at 15/25/35/45 rather than
    // 40/60/80/100 — for the reason this whole change exists: at the measured
    // gravity the ball is 5.3x quicker and had run off the end of the synthetic
    // ramp before the last sample, reporting a speed of zero and failing a test
    // about acceleration for the opposite reason to the one it guards.
    const speeds: number[] = [];
    for (let tick = 0; tick < 50; tick += 1) {
      stepBalls(set, ramp, MATERIALS, GRAVITY);
      if (tick >= 15 && tick % 10 === 5) {
        speeds.push(Math.abs(ball.velocityX) + Math.abs(ball.velocityY));
      }
    }
    expect(speeds.length).toBe(4);
    for (let i = 1; i < speeds.length; i += 1) {
      expect(speeds[i], `speeds ${speeds.join(",")}`).toBeGreaterThan(speeds[i - 1] ?? 0);
    }
    // And it is a real roll, not a crawl: the ball search wants 8 px in 500
    // ticks, i.e. 16 Q10 per tick, and this is orders past that.
    expect(speeds[speeds.length - 1] ?? 0).toBeGreaterThan(1000);
  });
});

describe("the virtual left wall, which was deleted", () => {
  // `VIRTUAL_LEFT_WALL_COLUMNS` sealed nine columns down the left of Extreme
  // Sports. It is gone, and this block is what stops it coming back by feel:
  // both halves of its derivation are re-checked against the CORRECTED maps, and
  // both fail. If either of these tests ever flips, the wall deserves another
  // look — which is the whole reason they are still here.

  it("has no rail at x=0..8 on any table to be named after", () => {
    // The stated derivation was "bit 1 is solid at x=6..8 on EVERY row from
    // y=50 to y=390" on Extreme Sports, i.e. nine columns IS the upper line's
    // own border. On the corrected map that rail is at x=38..40, and there is a
    // second continuous bit-1 line at x=16..18. Neither is inside x=0..8, so
    // there is no continuous upper-line border in the sealed strip at all.
    const longestRun = (map: TableMap, column: number, bit: number): number => {
      let best = 0;
      let current = 0;
      for (let y = 0; y < map.height; y += 1) {
        current = (map.materialAt(column, y) & bit) !== 0 ? current + 1 : 0;
        if (current > best) best = current;
      }
      return best;
    };
    const extreme = mapForTable("extreme-sports");
    for (let column = 0; column <= 8; column += 1) {
      expect(longestRun(extreme, column, LEVEL1_SOLID_BIT), `bit1 column ${column}`)
        .toBeLessThan(100);
    }
    // While the two rails that DO run the height of the table are where the
    // reframe says they are, 32 px right of the columns the wall was named for.
    expect(longestRun(extreme, 17, LEVEL1_SOLID_BIT)).toBeGreaterThan(340);
    expect(longestRun(extreme, 39, LEVEL1_SOLID_BIT)).toBeGreaterThan(340);
  });

  it("is not needed to keep a ball out of the strip, because none goes there", () => {
    // The behavioural half. Over the write-off census in `plays.test.ts` — thirty
    // scripted games a table at every plunge strength — the results with the wall
    // at 0, at 9 and at 19 are identical, and no ball ends anywhere in x<32 on
    // any table. What that census cannot show is whether the strip is reachable
    // at all, so this asserts the stronger thing directly: on Law 'n Justice and
    // BabeWatch the lower-level region a served ball can walk to does not touch
    // the left of the table, so a wall there could never have done anything.
    for (const tableId of ["law-n-justice", "babewatch"] as const) {
      const map = mapForTable(tableId);
      const materials = materialTableFor(tableId);
      const lane = shooterLaneFor(tableId);
      const seedX = (lane.minCentreX + lane.maxCentreX) >> 1;
      const seedY = lane.bottomY - 8;
      const view = playfieldViewFor(map, VIRTUAL_TOP_WALL_ROWS[tableId]);
      const passable = passabilityOf(materials);
      const free = (x: number, y: number): boolean => {
        for (let i = 0; i < PROBE_RING.size; i += 1) {
          const py = y + numberAt(PROBE_RING.dy, i);
          if (py >= view.height) continue;
          if (!passable[view.materialAt(x + numberAt(PROBE_RING.dx, i), py)]) return false;
        }
        return true;
      };
      expect(free(seedX, seedY), `${tableId} serve point`).toBe(true);
      const seen = new Set<number>([seedY * map.width + seedX]);
      const stack: [number, number][] = [[seedX, seedY]];
      let inStrip = 0;
      while (stack.length > 0) {
        const [x, y] = stack.pop() as [number, number];
        if (x < 32) inStrip += 1;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= map.width || ny < 0 || ny >= map.height) continue;
          const key = ny * map.width + nx;
          if (seen.has(key) || !free(nx, ny)) continue;
          seen.add(key);
          stack.push([nx, ny]);
        }
      }
      expect({ tableId, inStrip }).toEqual({ tableId, inStrip: 0 });
    }
  });

  it("returns the map itself when no wall is asked for", () => {
    expect(playfieldViewFor(EMPTY_MAP, 0)).toBe(EMPTY_MAP);
  });
});
