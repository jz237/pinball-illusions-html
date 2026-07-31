import { describe, expect, it } from "vitest";
import type {
  MaterialBehaviour,
  MaterialIndex,
  MaterialTable,
  TableMap,
} from "../src/game/contracts.js";
import { OPEN_INDEX, SOLID_BORDER_INDEX, materialTableFor } from "../src/game/materials.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";
import {
  ANGLE_HALF_TURN,
  ANGLE_UNITS_PER_TURN,
  BALL_RADIUS_PIXELS,
  DEFAULT_PROBE_RADIUS,
  PROBE_RING,
  PROBE_RING_SIZE,
  angleDelta,
  angleUnitsFor,
  normalizeAngle,
  numberAt,
  probeContacts,
  ringOffsetsFor,
} from "../src/game/collision-probe.js";
import type { RingOffsets } from "../src/game/collision-probe.js";

/** Comfortably bigger than a ball, so the standard centre is clear of the edges. */
const MAP_SIZE = 64;
/** Ball centre used by every scenario. */
const CENTRE = 32;
const WALL: MaterialIndex = SOLID_BORDER_INDEX;
/** Index 14 is a level-1 rail: present in the map but passable on level 0. */
const RAIL: MaterialIndex = 14;

const LAW = materialTableFor("law-n-justice");

/** A square synthetic playfield. Outside it, materialAt reads the solid border. */
function makeMap(paint: (x: number, y: number) => MaterialIndex): TableMap {
  const pixels = new Uint8Array(MAP_SIZE * MAP_SIZE);
  for (let y = 0; y < MAP_SIZE; y += 1) {
    for (let x = 0; x < MAP_SIZE; x += 1) {
      pixels[y * MAP_SIZE + x] = paint(x, y);
    }
  }
  return {
    tableId: "law-n-justice",
    displayName: "synthetic",
    width: MAP_SIZE,
    height: MAP_SIZE,
    pixels,
    materialAt(x: number, y: number): MaterialIndex {
      if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) {
        return SOLID_BORDER_INDEX;
      }
      return (pixels[y * MAP_SIZE + x] ?? SOLID_BORDER_INDEX) as MaterialIndex;
    },
  };
}

const OPEN_MAP = makeMap(() => OPEN_INDEX);

/** Only the listed pixels are solid; everything else is open playfield. */
function mapWithSolidPixels(solid: readonly (readonly [number, number])[]): TableMap {
  const keys = new Set(solid.map(([x, y]) => `${x},${y}`));
  return makeMap((x, y) => (keys.has(`${x},${y}`) ? WALL : OPEN_INDEX));
}

/** A material table where only the listed indices block, with chosen rebound and kick. */
function materialsWithSolids(
  solids: ReadonlyMap<MaterialIndex, { readonly elasticity: number; readonly kick: number }>,
): MaterialTable {
  const behaviours = new Map<MaterialIndex, MaterialBehaviour>();
  for (let raw = 0; raw <= 15; raw += 1) {
    const index = raw as MaterialIndex;
    const solid = solids.get(index);
    behaviours.set(index, {
      index,
      kind: solid === undefined ? "test-open" : "test-solid",
      passable: solid === undefined,
      elasticity: solid?.elasticity ?? 0,
      friction: 0,
      kick: solid?.kick ?? 0,
      confidence: "provisional",
    });
  }
  return {
    tableId: "law-n-justice",
    behaviours,
    behaviourFor(index: MaterialIndex): MaterialBehaviour {
      const behaviour = behaviours.get(index);
      if (behaviour === undefined) {
        throw new RangeError(`no behaviour for ${index}`);
      }
      return behaviour;
    },
  };
}

function probeAtCentre(map: TableMap, materials: MaterialTable = LAW) {
  return probeContacts(map, materials, pixelsToQ10(CENTRE), pixelsToQ10(CENTRE));
}

/** Absolute shortest turn between two angles, so wrap never fakes a failure. */
function angleGap(a: number, b: number): number {
  return Math.abs(angleDelta(a, b));
}

interface RingPoint {
  readonly index: number;
  readonly dx: number;
  readonly dy: number;
  readonly angle: number;
}

function ringPoint(index: number, ring: RingOffsets = PROBE_RING): RingPoint {
  return {
    index,
    dx: numberAt(ring.dx, index),
    dy: numberAt(ring.dy, index),
    angle: numberAt(ring.angle, index),
  };
}

function ringPoints(ring: RingOffsets = PROBE_RING): readonly RingPoint[] {
  return Array.from({ length: ring.size }, (_unused, index) => ringPoint(index, ring));
}

/** Absolute pixel of a ring point when the ball sits at the standard centre. */
function pixelOf(index: number): readonly [number, number] {
  const point = ringPoint(index);
  return [CENTRE + point.dx, CENTRE + point.dy];
}

describe("the shared probe ring", () => {
  it("is a radius-8 ring of 44 points, built once at module load", () => {
    // 44 is not a tunable: it is however many points a gapless discrete circle
    // of radius 8 has. The ring this module used to export had 24 points at
    // radius 4 and was not the one the simulation ran on.
    expect(BALL_RADIUS_PIXELS).toBe(8);
    expect(DEFAULT_PROBE_RADIUS).toBe(pixelsToQ10(8));
    expect(PROBE_RING_SIZE).toBe(44);
    expect(PROBE_RING.size).toBe(PROBE_RING_SIZE);
    expect(Object.isFrozen(PROBE_RING)).toBe(true);
    expect(Object.isFrozen(PROBE_RING.dx)).toBe(true);
    // Cached, so every ball on every table probes literally the same arrays.
    expect(ringOffsetsFor(DEFAULT_PROBE_RADIUS)).toBe(PROBE_RING);
  });

  it("keeps every parallel array the same length", () => {
    for (const values of [
      PROBE_RING.dx,
      PROBE_RING.dy,
      PROBE_RING.unitX,
      PROBE_RING.unitY,
      PROBE_RING.angle,
    ]) {
      expect(values).toHaveLength(PROBE_RING_SIZE);
    }
  });

  it("SEES A ONE-PIXEL WALL AT EVERY OFFSET: no dx or dy from -r to +r is skipped", () => {
    // The whole reason for a midpoint circle rather than 44 rounded unit
    // vectors. Rounding evenly spaced directions at radius 8 yields components
    // {0, +-2, +-3, +-4, +-6, +-7, +-8} only, so a 1-px wall sitting at offset
    // +-1 or +-5 is invisible and the ball freezes against a wall it cannot
    // feel. Law 'n Justice has 41 horizontal and 11 vertical 1-px solid runs.
    for (const radius of [1, 2, 3, 4, 5, 6, 8, 10, 12, 16]) {
      const ring = ringOffsetsFor(pixelsToQ10(radius));
      const xs = new Set(ring.dx);
      const ys = new Set(ring.dy);
      for (let offset = -radius; offset <= radius; offset += 1) {
        expect(xs.has(offset), `radius ${radius} never probes dx=${offset}`).toBe(true);
        expect(ys.has(offset), `radius ${radius} never probes dy=${offset}`).toBe(true);
      }
    }
  });

  it("is an 8-connected chain, so nothing can slip between two probes", () => {
    const points = ringPoints();
    for (let i = 0; i < points.length; i += 1) {
      const here = ringPoint(i);
      const next = ringPoint((i + 1) % points.length);
      expect(Math.abs(next.dx - here.dx), `gap in x between ${i} and ${i + 1}`).toBeLessThanOrEqual(1);
      expect(Math.abs(next.dy - here.dy), `gap in y between ${i} and ${i + 1}`).toBeLessThanOrEqual(1);
    }
  });

  it("uses whole-pixel offsets that all land near the ball surface", () => {
    for (const point of ringPoints()) {
      expect(Number.isInteger(point.dx)).toBe(true);
      expect(Number.isInteger(point.dy)).toBe(true);
      // -0 would compare unequal to 0 under Object.is and leak into contacts.
      expect(Object.is(point.dx, point.dx + 0)).toBe(true);
      expect(Object.is(point.dy, point.dy + 0)).toBe(true);
      const radius = Math.hypot(point.dx, point.dy);
      expect(radius).toBeGreaterThan(BALL_RADIUS_PIXELS - 0.5);
      expect(radius).toBeLessThan(BALL_RADIUS_PIXELS + 0.5);
    }
  });

  it("tests 44 distinct pixels, so no contact is ever counted twice", () => {
    const offsets = new Set(ringPoints().map((p) => `${p.dx},${p.dy}`));
    expect(offsets.size).toBe(PROBE_RING_SIZE);
  });

  it("orders the points by angle, strictly ascending through one revolution", () => {
    // Not evenly spaced — the points are integer offsets, not sampled
    // directions — so the only guarantee is monotonicity.
    let previous = -1;
    for (const point of ringPoints()) {
      expect(Number.isInteger(point.angle)).toBe(true);
      expect(point.angle).toBeGreaterThan(previous);
      expect(point.angle).toBeLessThan(ANGLE_UNITS_PER_TURN);
      previous = point.angle;
    }
  });

  it("keeps each offset pointing at its stated angle", () => {
    for (const point of ringPoints()) {
      const measured = normalizeAngle(
        Math.round((Math.atan2(point.dy, point.dx) * ANGLE_UNITS_PER_TURN) / (2 * Math.PI)),
      );
      // The polynomial atan is worth about a third of an angle unit; allow one.
      expect(angleGap(measured, point.angle)).toBeLessThanOrEqual(1);
    }
  });

  it("puts the axes exactly on the quarter turns", () => {
    expect(angleUnitsFor(8, 0)).toBe(0);
    expect(angleUnitsFor(0, 8)).toBe(512);
    expect(angleUnitsFor(-8, 0)).toBe(1024);
    expect(angleUnitsFor(0, -8)).toBe(1536);
    // Mirrored offsets must give exactly mirrored angles, or a trajectory and
    // its reflection would not report reflected contacts.
    for (const [dx, dy] of [
      [7, 3],
      [3, 7],
      [5, 6],
    ] as const) {
      expect(angleUnitsFor(dx, -dy)).toBe(normalizeAngle(-angleUnitsFor(dx, dy)));
      expect(angleUnitsFor(-dx, dy)).toBe(ANGLE_HALF_TURN - angleUnitsFor(dx, dy));
    }
  });

  it("is symmetric under a half turn, so opposite probes are true antipodes", () => {
    // This is what makes the outward normal a table lookup rather than a
    // negation: entry i + size/2 is the exact opposite of entry i.
    const negate = (value: number): number => -value + 0;
    for (let i = 0; i < PROBE_RING_SIZE; i += 1) {
      const point = ringPoint(i);
      const opposite = ringPoint((i + PROBE_RING_SIZE / 2) % PROBE_RING_SIZE);
      expect([opposite.dx, opposite.dy]).toEqual([negate(point.dx), negate(point.dy)]);
      expect(angleGap(opposite.angle, point.angle + ANGLE_HALF_TURN)).toBeLessThanOrEqual(1);
    }
  });

  it("carries unit vectors that are directions, not lengths", () => {
    for (let i = 0; i < PROBE_RING_SIZE; i += 1) {
      const ux = numberAt(PROBE_RING.unitX, i);
      const uy = numberAt(PROBE_RING.unitY, i);
      // 1024 is one in Q10; every entry must be a unit vector to within rounding
      // or the mean of a fan would be pulled toward the longer offsets.
      expect(Math.abs(Math.hypot(ux, uy) - 1024)).toBeLessThanOrEqual(1);
      expect(Number.isInteger(ux)).toBe(true);
      expect(Number.isInteger(uy)).toBe(true);
    }
  });
});

describe("a one-pixel wall is visible from every approach", () => {
  // Sweeping a single solid row/column across the whole diameter is the direct
  // regression for the ring-blindness bug: with the old ring these failed at
  // offsets +-1 and +-5 and the ball froze against a wall reporting no contact.
  for (let offset = -BALL_RADIUS_PIXELS; offset <= BALL_RADIUS_PIXELS; offset += 1) {
    it(`sees a 1-px horizontal wall at dy=${offset}`, () => {
      const row = CENTRE + offset;
      const map = makeMap((_x, y) => (y === row ? WALL : OPEN_INDEX));
      const result = probeAtCentre(map);
      expect(result.contacts.length).toBeGreaterThan(0);
      for (const contact of result.contacts) expect(contact.y).toBe(row);
    });

    it(`sees a 1-px vertical wall at dx=${offset}`, () => {
      const column = CENTRE + offset;
      const map = makeMap((x) => (x === column ? WALL : OPEN_INDEX));
      const result = probeAtCentre(map);
      expect(result.contacts.length).toBeGreaterThan(0);
      for (const contact of result.contacts) expect(contact.x).toBe(column);
    });
  }
});

describe("angle helpers", () => {
  it("wraps into 0..2047 without producing negative zero", () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(2048)).toBe(0);
    expect(normalizeAngle(-2048)).toBe(0);
    expect(Object.is(normalizeAngle(-2048), 0)).toBe(true);
    expect(normalizeAngle(-1)).toBe(2047);
    expect(normalizeAngle(5000)).toBe(5000 - 2 * ANGLE_UNITS_PER_TURN);
  });

  it("measures the short way round, in both directions", () => {
    expect(angleDelta(2040, 10)).toBe(18);
    expect(angleDelta(10, 2040)).toBe(-18);
    expect(angleDelta(512, 512)).toBe(0);
    expect(angleDelta(0, ANGLE_HALF_TURN)).toBe(ANGLE_HALF_TURN);
  });
});

describe("probing free space", () => {
  it("reports nothing when every probe is over open playfield", () => {
    const result = probeAtCentre(OPEN_MAP);
    expect(result.contacts).toEqual([]);
    expect(result.normalAngle).toBeNull();
    expect(result.dominant).toBeNull();
  });

  it("ignores materials that are present but passable, such as upper rails", () => {
    // Index 14 is 8644 px of ramp guide rail on Law 'n Justice; a level-0 ball
    // rolls straight under it. Blocking it here would fence off the table.
    const railMap = makeMap(() => RAIL);
    const result = probeAtCentre(railMap);
    expect(result.contacts).toEqual([]);
    expect(result.dominant).toBeNull();
  });
});

describe("probing a flat floor below the ball", () => {
  const floor = makeMap((_x, y) => (y >= CENTRE + BALL_RADIUS_PIXELS ? WALL : OPEN_INDEX));

  it("touches the five lowest probes and points straight down", () => {
    const result = probeAtCentre(floor);
    // The five entries with dy = 8; the dy = 7 entries are one row clear.
    expect(result.contacts.map((c) => c.ringIndex)).toEqual([9, 10, 11, 12, 13]);
    // +y is down the screen, so 512 (a quarter turn from +x) is downward.
    expect(result.normalAngle).toBe(512);
    expect(result.dominant).toBe(WALL);
  });

  it("records the touched pixel and material on every contact", () => {
    const result = probeAtCentre(floor);
    for (const contact of result.contacts) {
      const point = ringPoint(contact.ringIndex);
      expect(contact.x).toBe(CENTRE + point.dx);
      expect(contact.y).toBe(CENTRE + point.dy);
      expect(contact.angle).toBe(point.angle);
      expect(contact.material).toBe(WALL);
      expect(floor.materialAt(contact.x, contact.y)).toBe(WALL);
    }
  });

  it("returns contacts in ring order", () => {
    const result = probeAtCentre(floor);
    const indices = result.contacts.map((c) => c.ringIndex);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });
});

describe("probing a wall to the left", () => {
  const leftWall = makeMap((x) => (x <= CENTRE - BALL_RADIUS_PIXELS ? WALL : OPEN_INDEX));

  it("points at half a turn, straight into the wall", () => {
    const result = probeAtCentre(leftWall);
    expect(result.contacts.map((c) => c.ringIndex)).toEqual([20, 21, 22, 23, 24]);
    expect(result.normalAngle).toBe(ANGLE_HALF_TURN);
    expect(result.dominant).toBe(WALL);
  });

  it("does not touch it one pixel further right", () => {
    const result = probeContacts(leftWall, LAW, pixelsToQ10(CENTRE + 1), pixelsToQ10(CENTRE));
    expect(result.contacts).toEqual([]);
  });
});

describe("probing a corner", () => {
  it("bisects the floor and the wall", () => {
    const corner = makeMap((x, y) =>
      y >= CENTRE + BALL_RADIUS_PIXELS || x <= CENTRE - BALL_RADIUS_PIXELS ? WALL : OPEN_INDEX,
    );
    const result = probeAtCentre(corner);
    expect(result.contacts).toHaveLength(10);
    expect(result.contacts.map((c) => c.ringIndex)).toEqual([9, 10, 11, 12, 13, 20, 21, 22, 23, 24]);
    // Down is 512, left is 1024, and the two arcs are equally strong, so the
    // mean direction is 768. The answer is always a ring entry, and 768 falls
    // exactly between two of them (739 and 797), so allow one ring step.
    expect(angleGap(result.normalAngle ?? -1, 768)).toBeLessThanOrEqual(32);
    expect(PROBE_RING.angle).toContain(result.normalAngle);
  });
});

describe("probing across the 2047/0 wrap", () => {
  it("reports 0 for contacts either side of the seam, not the naive 1024", () => {
    // Ring point 43 is at angle 2007 and point 1 is at angle 41: a wall dead
    // ahead of a ball moving right, split by the seam. Their arithmetic mean is
    // 1024 — the exact opposite direction, which would fire the ball INTO the
    // wall it just touched.
    const seam = mapWithSolidPixels([pixelOf(43), pixelOf(1)]);
    const result = probeAtCentre(seam);
    expect(result.contacts.map((c) => c.angle)).toEqual([41, 2007]);
    expect((41 + 2007) / 2).toBe(1024);
    expect(result.normalAngle).toBe(0);
  });

  it("holds for a whole right-hand wall spanning the seam", () => {
    const rightWall = makeMap((x) => (x >= CENTRE + BALL_RADIUS_PIXELS ? WALL : OPEN_INDEX));
    const result = probeAtCentre(rightWall);
    expect(result.contacts.map((c) => c.ringIndex)).toEqual([0, 1, 2, 42, 43]);
    expect(result.normalAngle).toBe(0);
  });

  it("holds for a wall sitting just off the seam", () => {
    const seam = mapWithSolidPixels([pixelOf(41), pixelOf(42), pixelOf(43)]);
    const result = probeAtCentre(seam);
    expect(result.contacts.map((c) => c.angle)).toEqual([1916, 1968, 2007]);
    // Centred on 1968; a naive mean of the three would say 1963-ish only by
    // luck, and adding entry 0 would swing it to 1472.
    expect(angleGap(result.normalAngle ?? -1, 1968)).toBeLessThanOrEqual(32);
  });

  it("stays sane in a channel where both sides cancel", () => {
    const channel = makeMap((x) =>
      x >= CENTRE + BALL_RADIUS_PIXELS || x <= CENTRE - BALL_RADIUS_PIXELS ? WALL : OPEN_INDEX,
    );
    const result = probeAtCentre(channel);
    expect(result.contacts).toHaveLength(10);
    const normal = result.normalAngle;
    expect(normal).not.toBeNull();
    expect(Number.isNaN(normal)).toBe(false);
    // Nothing sensible exists here; the first contact keeps it deterministic.
    expect(normal).toBe(result.contacts[0]?.angle);
  });
});

describe("the edges of the bitmap", () => {
  it("reads the solid border, so a ball cannot leave through the side or the top", () => {
    const nearCorner = probeContacts(OPEN_MAP, LAW, pixelsToQ10(2), pixelsToQ10(2));
    expect(nearCorner.contacts.length).toBeGreaterThan(0);
    for (const contact of nearCorner.contacts) {
      expect(contact.material).toBe(SOLID_BORDER_INDEX);
      expect(contact.x < 0 || contact.y < 0).toBe(true);
    }
    // Up-left: past 1024 (left) and before 1536 (up).
    expect(nearCorner.normalAngle ?? -1).toBeGreaterThan(ANGLE_HALF_TURN);
    expect(nearCorner.normalAngle ?? -1).toBeLessThan(1536);
  });

  it("treats the rows past the bottom as open, because that is the drain", () => {
    // The other three sides are solid out of bounds; the bottom must not be, or
    // the ball bounces off the drain and the ball-in-play never ends. The
    // now-deleted second copy of this probe got this backwards.
    const result = probeContacts(
      OPEN_MAP,
      LAW,
      pixelsToQ10(CENTRE),
      pixelsToQ10(MAP_SIZE - 1),
    );
    expect(result.contacts).toEqual([]);
    expect(result.normalAngle).toBeNull();
  });
});

describe("sub-pixel positions", () => {
  const floor = makeMap((_x, y) => (y >= CENTRE + BALL_RADIUS_PIXELS ? WALL : OPEN_INDEX));

  it("probes the same pixels anywhere inside one pixel", () => {
    const whole = probeContacts(floor, LAW, pixelsToQ10(CENTRE), pixelsToQ10(CENTRE));
    for (const fraction of [1, 512, 1023]) {
      const partial = probeContacts(
        floor,
        LAW,
        pixelsToQ10(CENTRE) + fraction,
        pixelsToQ10(CENTRE) + fraction,
      );
      expect(partial.contacts).toEqual(whole.contacts);
      expect(partial.normalAngle).toBe(whole.normalAngle);
    }
  });

  it("truncates toward the top-left, so one unit above the boundary misses", () => {
    const justAbove = probeContacts(floor, LAW, pixelsToQ10(CENTRE), pixelsToQ10(CENTRE) - 1);
    expect(justAbove.contacts).toEqual([]);
  });
});

describe("the dominant material", () => {
  const floorAndWall = makeMap((x, y) => {
    if (y >= CENTRE + BALL_RADIUS_PIXELS) return 15;
    if (x <= CENTRE - BALL_RADIUS_PIXELS) return 5;
    return OPEN_INDEX;
  });

  it("prefers a powered surface over a merely bouncy one", () => {
    // A slingshot clipped in the same tick as a wall must fire like the
    // slingshot even though the wall rebounds harder on its own.
    const poweredFloor = materialsWithSolids(
      new Map([
        [5 as MaterialIndex, { elasticity: 900, kick: 0 }],
        [15 as MaterialIndex, { elasticity: 512, kick: 420 }],
      ]),
    );
    expect(probeAtCentre(floorAndWall, poweredFloor).dominant).toBe(15);
  });

  it("falls back to the bounciest surface when nothing is powered", () => {
    const bouncyFloor = materialsWithSolids(
      new Map([
        [5 as MaterialIndex, { elasticity: 640, kick: 0 }],
        [15 as MaterialIndex, { elasticity: 900, kick: 0 }],
      ]),
    );
    expect(probeAtCentre(floorAndWall, bouncyFloor).dominant).toBe(15);

    const bouncyWall = materialsWithSolids(
      new Map([
        [5 as MaterialIndex, { elasticity: 900, kick: 0 }],
        [15 as MaterialIndex, { elasticity: 640, kick: 0 }],
      ]),
    );
    expect(probeAtCentre(floorAndWall, bouncyWall).dominant).toBe(5);
  });

  it("breaks ties by material index, not by where the ring starts", () => {
    // Every solid index in the real table shares one wall restitution and no
    // kick at all, so the tie-break is what actually decides the answer there.
    const tied = materialsWithSolids(
      new Map([
        [5 as MaterialIndex, { elasticity: 640, kick: 0 }],
        [15 as MaterialIndex, { elasticity: 640, kick: 0 }],
      ]),
    );
    expect(probeAtCentre(floorAndWall, tied).dominant).toBe(5);
    expect(probeAtCentre(floorAndWall).dominant).toBe(5);
  });

  it("is chosen from touched materials only", () => {
    const result = probeAtCentre(floorAndWall);
    const touched = new Set(result.contacts.map((c) => c.material));
    expect(result.dominant).not.toBeNull();
    expect(touched.has(result.dominant as MaterialIndex)).toBe(true);
  });

  it("can be a zero-elasticity solid when that is all there is", () => {
    // A dead solid must still be reported, or the responder would see contacts
    // with no material to respond with.
    const dead = materialsWithSolids(new Map([[5 as MaterialIndex, { elasticity: 0, kick: 0 }]]));
    const leftWall = makeMap((x) => (x <= CENTRE - BALL_RADIUS_PIXELS ? WALL : OPEN_INDEX));
    const result = probeAtCentre(leftWall, dead);
    expect(result.contacts).toHaveLength(5);
    expect(result.dominant).toBe(5);
  });
});

describe("probing at a non-default radius", () => {
  it("uses a smaller ring that still covers every offset", () => {
    const ring = ringOffsetsFor(pixelsToQ10(4));
    expect(ring.size).toBeLessThan(PROBE_RING_SIZE);
    const floor = makeMap((_x, y) => (y >= CENTRE + 4 ? WALL : OPEN_INDEX));
    // At radius 4 the floor is touched; at radius 8 the same floor is four
    // pixels inside the ring, so the ring indices cannot mean the same thing —
    // which is exactly why there must only ever be one ring in play at a time.
    const small = probeContacts(floor, LAW, pixelsToQ10(CENTRE), pixelsToQ10(CENTRE), pixelsToQ10(4));
    expect(small.normalAngle).toBe(512);
    for (const contact of small.contacts) {
      expect(contact.ringIndex).toBeLessThan(ring.size);
      expect(contact.angle).toBe(numberAt(ring.angle, contact.ringIndex));
    }
  });
});

describe("determinism", () => {
  it("gives byte-identical results for the same inputs", () => {
    const map = makeMap((x, y) => ((x * 7 + y * 13) % 11 === 0 ? WALL : OPEN_INDEX));
    const first = probeAtCentre(map);
    const second = probeAtCentre(map);
    expect(second).toEqual(first);
    expect(Number.isInteger(first.normalAngle ?? 0)).toBe(true);
  });
});
