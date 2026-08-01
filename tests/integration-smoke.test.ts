/**
 * End-to-end smoke test on GENUINE table geometry.
 *
 * Every other test in this repo runs the simulation against a hand-drawn
 * fixture, which proves each module is self-consistent but proves nothing about
 * whether they agree with each other or with the real data. This one loads the
 * actual exported Law 'n Justice map off disk, builds the real material table,
 * and runs the real integrator over it. It is the first check that the four
 * independently written modules — table-map, materials, the probe and the ball
 * simulation — compose into something that does not fall apart on the 336x600
 * playfield the disks actually contain.
 *
 * The assertions are deliberately about INVARIANTS, not trajectories. Nobody has
 * measured what the 1995 game's ball does yet (see materials.ts: not one
 * elasticity, friction or kick number is measured), so asserting specific
 * positions would be asserting today's arbitrary constants and would break the
 * moment anyone tunes them. What must hold regardless of tuning is: the
 * simulation never crashes, the state stays integral, and a ball never leaves
 * the bitmap except through the drain at the bottom.
 *
 * ON THE DATA. The map loaded here is the corrected export: the four slot-2
 * layers decoded at offsets 0 / 26040 / 52080 / 77280 with row counts
 * 620 / 620 / 600 / 600, so its indices mean what the material table says. (An
 * earlier export assumed four equal 610-row planes and had three of the four
 * layers 10-20 rows out of registration. `scripts/export-table-maps.mjs
 * --check` re-decodes the disks and confirms the shipped files still match.)
 * What this test proves is nevertheless the PLUMBING — that real run-length
 * data expands, feeds the probe, and drives the integrator without escaping or
 * going non-integer. It does NOT claim the table plays like the 1995 game;
 * nobody has measured that, and materials.ts's coefficients are all chosen.
 */

import { describe, expect, it } from "vitest";

import { SIMULATION_GRAVITY } from "../src/game/timebase.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  BallState,
  MaterialIndex,
  SimulationForces,
  TableMap,
  TableMapDocument,
} from "../src/game/contracts.js";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../src/game/contracts.js";
import { materialTableFor } from "../src/game/materials.js";
import { materialHistogramOf, parseTableMapDocument } from "../src/game/table-map.js";
import { pixelsToQ10, q10ToPixel } from "../src/core/fixed-point.js";
import { createBallSet, spawnBall, stepBalls } from "../src/game/ball-physics.js";
import type { BallSet } from "../src/game/ball-physics.js";

const MAP_PATH = fileURLToPath(
  new URL("../public/generated/tables/law-n-justice.map.json", import.meta.url),
);

const DOCUMENT = JSON.parse(readFileSync(MAP_PATH, "utf8")) as TableMapDocument;

/** The real map, expanded through the real loader. Parsed once; it is read-only. */
const MAP: TableMap = parseTableMapDocument(DOCUMENT);
const MATERIALS = materialTableFor("law-n-justice");

/** Downward acceleration per tick. A chosen value, matching the unit tests. */
const GRAVITY: SimulationForces = { gravityY: SIMULATION_GRAVITY, nudgeX: 0, nudgeY: 0 };

const TICKS = 400;

/** Signed 16-bit, the range the integrator refuses to exceed. */
const VELOCITY_LIMIT = 32767;

/**
 * Spawn points, all verified to have a clear 8 px radius on the real map, spread
 * across the upper playfield so the balls fall through genuinely different
 * geometry rather than all tracing one lane.
 */
const SPAWNS: readonly (readonly [number, number])[] = [
  [60, 40],
  [150, 60],
  [250, 40],
  [100, 200],
  [200, 150],
];

/**
 * Asserts the invariants that must hold on every tick for every live ball.
 *
 * Checked inside the tick loop rather than only at the end: a ball that escapes
 * on tick 12 and is dragged back by tick 400 would otherwise pass, and that is
 * exactly the ball-to-ball separation bug this file was written to catch.
 */
function expectSaneBall(ball: BallState, where: string): void {
  expect(Number.isInteger(ball.x), `${where}: x must stay an integer, got ${ball.x}`).toBe(true);
  expect(Number.isInteger(ball.y), `${where}: y must stay an integer, got ${ball.y}`).toBe(true);
  expect(
    Number.isInteger(ball.velocityX),
    `${where}: velocityX must stay an integer, got ${ball.velocityX}`,
  ).toBe(true);
  expect(
    Number.isInteger(ball.velocityY),
    `${where}: velocityY must stay an integer, got ${ball.velocityY}`,
  ).toBe(true);
  expect(Math.abs(ball.velocityX), `${where}: velocityX out of signed 16-bit range`).toBeLessThanOrEqual(
    VELOCITY_LIMIT,
  );
  expect(Math.abs(ball.velocityY), `${where}: velocityY out of signed 16-bit range`).toBeLessThanOrEqual(
    VELOCITY_LIMIT,
  );

  if (!ball.active) return;

  // A live ball is contained on three sides. The fourth, the bottom, is the
  // drain: `stepBalls` deactivates a ball the moment it passes the last row, so
  // any ball still active must be above it.
  const px = q10ToPixel(ball.x);
  const py = q10ToPixel(ball.y);
  expect(px, `${where}: escaped past the left edge`).toBeGreaterThanOrEqual(0);
  expect(px, `${where}: escaped past the right edge`).toBeLessThan(MAP.width);
  expect(py, `${where}: escaped past the top edge`).toBeGreaterThanOrEqual(0);
  expect(py, `${where}: still active below the drain line`).toBeLessThan(MAP.height);
}

function runTicks(set: BallSet, ticks: number, forces: SimulationForces, label: string): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    stepBalls(set, MAP, MATERIALS, forces);
    for (const ball of set.balls) {
      expectSaneBall(ball, `${label} ball ${ball.id} tick ${tick}`);
    }
  }
}

describe("the real Law 'n Justice map loads and agrees with the material table", () => {
  it("expands to the dimensions the rest of the engine assumes", () => {
    expect(MAP.tableId).toBe("law-n-justice");
    expect(MAP.width).toBe(PLAYFIELD_WIDTH);
    expect(MAP.height).toBe(PLAYFIELD_HEIGHT);
    expect(MAP.pixels.length).toBe(PLAYFIELD_WIDTH * PLAYFIELD_HEIGHT);
  });

  it("round-trips its own histogram, so the run-length expansion is exact", () => {
    // The exporter wrote the histogram from the raw bitplanes; recomputing it
    // from the expanded pixels checks the whole encode/decode path end to end.
    expect(materialHistogramOf(MAP)).toEqual(DOCUMENT.materialHistogram);
  });

  it("has a behaviour for every index that actually occurs on the table", () => {
    // The two modules were written independently; this is the seam between them.
    for (const key of Object.keys(DOCUMENT.materialHistogram)) {
      const index = Number(key) as MaterialIndex;
      expect(() => MATERIALS.behaviourFor(index), `index ${index} occurs but has no behaviour`).not.toThrow();
    }
  });

  it("is bounded by solid material once the probe reads outside the bitmap", () => {
    // Containment on this table does not come from a painted border — the edge
    // columns are mostly passable artwork — it comes from `materialAt` answering
    // with the solid border index outside the bitmap. Worth pinning explicitly,
    // because a loader change that returned "open" out of bounds would leak every
    // ball off the table and the physics tests would not notice.
    for (const [x, y] of [
      [-1, 300],
      [MAP.width, 300],
      [100, -1],
    ] as const) {
      expect(MATERIALS.behaviourFor(MAP.materialAt(x, y)).passable).toBe(false);
    }
  });
});

describe("balls dropped on the real playfield", () => {
  it("survive several hundred ticks without escaping or going non-integer", () => {
    const set = createBallSet();
    for (const [x, y] of SPAWNS) {
      spawnBall(set, pixelsToQ10(x), pixelsToQ10(y));
    }
    expect(set.balls).toHaveLength(SPAWNS.length);

    const startY = set.balls.map((ball) => ball.y);

    // The invariant checks live inside this call, so a violation is reported on
    // the tick it happened rather than 400 ticks later.
    runTicks(set, TICKS, GRAVITY, "drop");

    // Gravity has to actually do something: a simulation where every ball
    // instantly wedged would satisfy every invariant above and be useless.
    const movedDown = set.balls.filter((ball, index) => ball.y > (startY[index] ?? 0));
    expect(movedDown.length, "no ball moved downward under gravity").toBeGreaterThan(0);
  });

  it("reach the drain rather than hanging up forever", () => {
    // Not an invariant of the final tuning, but if NOTHING on the real map can
    // ever fall out, the geometry or the passability flags are wrong in a way
    // no unit test would show.
    const set = createBallSet();
    for (const [x, y] of SPAWNS) {
      spawnBall(set, pixelsToQ10(x), pixelsToQ10(y));
    }
    let totalDrained = 0;
    for (let tick = 0; tick < TICKS; tick += 1) {
      totalDrained += stepBalls(set, MAP, MATERIALS, GRAVITY).drained.length;
    }
    expect(totalDrained, "not one ball found the drain in 400 ticks").toBeGreaterThan(0);
  });

  it("stay contained when nudged hard while multiball is in play", () => {
    const set = createBallSet();
    for (const [x, y] of SPAWNS) {
      spawnBall(set, pixelsToQ10(x), pixelsToQ10(y), 900, -700);
    }
    for (let tick = 0; tick < TICKS; tick += 1) {
      // Alternating hard nudges: the cheapest way to drive balls into the walls
      // from every direction without hand-picking trajectories.
      const forces: SimulationForces = {
        gravityY: SIMULATION_GRAVITY,
        nudgeX: tick % 5 === 0 ? (tick % 10 === 0 ? 1800 : -1800) : 0,
        nudgeY: tick % 7 === 0 ? -1200 : 0,
      };
      stepBalls(set, MAP, MATERIALS, forces);
      for (const ball of set.balls) {
        expectSaneBall(ball, `nudge ball ${ball.id} tick ${tick}`);
      }
    }
  });

  it("are never pushed off the table by ball-to-ball separation", () => {
    // Regression. `resolveBallCollisions` used to write positions with no bounds
    // or map check, so six balls spawned on the same pixel two columns from the
    // left edge — a plausible multiball release — shoved each other clean out of
    // the bitmap to x = -30, where every probe reads solid and the ball can never
    // move again. Stacks are placed hard against each edge because that is the
    // only place the unchecked push was observable.
    const spots: (readonly [number, number])[] = [];
    for (let y = 20; y < 560; y += 20) {
      spots.push([1, y], [2, y], [333, y], [334, y]);
    }
    for (let x = 4; x < 332; x += 20) {
      spots.push([x, 1], [x, 2]);
    }

    for (const [sx, sy] of spots) {
      const set = createBallSet();
      for (let i = 0; i < 6; i += 1) {
        spawnBall(set, pixelsToQ10(sx), pixelsToQ10(sy));
      }
      runTicks(set, 120, GRAVITY, `stack at (${sx},${sy})`);
    }
    // The budget is 30 s rather than the default 5 because the work grew with
    // the timebase and not with the test: `integrateBall` probes the path a
    // pixel at a time, and at the measured gravity a falling ball covers 16 px
    // in a tick where it used to cover 3, so the same 140 stacks of six balls
    // cost about five times as many probes. Nothing about what is asserted
    // changed.
  }, 30_000);
});
