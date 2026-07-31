import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  MaterialIndex,
  SimulationForces,
  TableMap,
  TableMapDocument,
} from "../src/game/contracts.js";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../src/game/contracts.js";
import { SOLID_BORDER_INDEX, materialTableFor } from "../src/game/materials.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { pixelsToQ10, q10ToPixel } from "../src/core/fixed-point.js";
import {
  DEFAULT_PROBE_RADIUS,
  PROBE_RING,
  PROBE_RING_SIZE,
  numberAt,
  probeContacts,
} from "../src/game/collision-probe.js";
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

const GRAVITY: SimulationForces = { gravityY: 24, nudgeX: 0, nudgeY: 0 };
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
    // whatever sub-pixel height the next gravity step would push into the
    // contact row — within one pixel of the geometric resting centre, never below it.
    expect(ball.y).toBeLessThanOrEqual(pixelsToQ10(RESTING_CENTRE));
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
    // Half the radius: the guarantee the wall tests above depend on.
    expect(DEFAULT_SIMULATION_OPTIONS.maxSubstepDistance).toBe(
      pixelsToQ10(BALL_RADIUS_PIXELS) >> 1,
    );
    expect(DEFAULT_SIMULATION_OPTIONS.maxSubstepDistance * 2).toBeLessThanOrEqual(
      DEFAULT_SIMULATION_OPTIONS.radius,
    );
  });

  it("a slow ball still takes exactly one substep", () => {
    const set = setWith({ x: 100, y: 100, vx: 100 });
    stepBalls(set, EMPTY_MAP, MATERIALS, WEIGHTLESS);
    expect(only(set).x).toBe(pixelsToQ10(100) + 100);
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
        gravityY: 24,
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

const LAW_MAP_PATH = fileURLToPath(
  new URL("../public/generated/tables/law-n-justice.map.json", import.meta.url),
);
const LAW_MAP: TableMap = parseTableMapDocument(
  JSON.parse(readFileSync(LAW_MAP_PATH, "utf8")) as TableMapDocument,
);
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
    // 84.96% of the incoming speed, whatever the tick was cut into.
    expect(ball.velocityY).toBe(-5119);
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

  it("has no cliff in the trajectory where the substep count used to change", () => {
    // One Q10 unit of extra speed may not move the bounce by a visible amount.
    // Across 8000..8400 the fixed-substep version stepped 6653 units (6.5 px)
    // between 8191 and 8192, where the tick went from one substep to two.
    let previous: number | null = null;
    let largest = 0;
    for (let velocityY = 8000; velocityY <= 8400; velocityY += 1) {
      const set = setWith({ x: 100, y: 388, vy: velocityY });
      stepBalls(set, FLOOR_MAP, MATERIALS, WEIGHTLESS);
      const y = only(set).y;
      if (previous !== null) largest = Math.max(largest, Math.abs(y - previous));
      previous = y;
    }
    // A thirtieth of a pixel. Measured worst case is 6 units.
    expect(largest).toBeLessThanOrEqual(32);
  });

  it("is continuous across the old boundary in particular", () => {
    const at = (velocityY: number): number => {
      const set = setWith({ x: 100, y: 388, vy: velocityY });
      stepBalls(set, FLOOR_MAP, MATERIALS, WEIGHTLESS);
      return only(set).y;
    };
    expect(Math.abs(at(8192) - at(8191))).toBeLessThanOrEqual(32);
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

  it("brings a ball wedged in a channel narrower than itself to a full stop", () => {
    // Law 'n Justice has a slot at (54, 156) that is 13 px of clear width — a
    // 16 px ball that finds its way in cannot get out again. It used to drift one
    // Q10 unit down, bounce, drift back up and end every tick on the pixel it
    // started on carrying vy = -1: position and velocity both unchanged, speed
    // still non-zero, forever.
    const set = createBallSet();
    const ball = spawnBall(set, 55296, 159742, 0, -1);
    for (let tick = 0; tick < 10; tick += 1) stepBalls(set, LAW_MAP, LAW_MATERIALS, GRAVITY);
    expect(ball.velocityX).toBe(0);
    expect(ball.velocityY).toBe(0);
    expect(ball.y).toBe(159742);
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
