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
  cosineUnits,
  meanContactAngle,
  normalizeAngle,
  numberAt,
  outwardNormalOf,
  probeContacts,
  ringIndexForAngle,
  ringOffsetsFor,
  sineUnits,
} from "../src/game/collision-probe.js";
import type { ContactPoint } from "../src/game/contracts.js";
import { Q10_ONE } from "../src/core/fixed-point.js";
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
    for (const values of [PROBE_RING.dx, PROBE_RING.dy, PROBE_RING.angle]) {
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

  it("keeps each offset pointing at its stated angle, to the unit", () => {
    for (const point of ringPoints()) {
      const measured = normalizeAngle(
        Math.round((Math.atan2(point.dy, point.dx) * ANGLE_UNITS_PER_TURN) / (2 * Math.PI)),
      );
      // WAS `<= 1`, because the three-term polynomial atan this ring used to be
      // built from was worth about half a unit. It is an exact equality now: the
      // angles are summed to make a contact normal, so a unit of slack in one of
      // them is a unit of error in a bounce.
      expect(point.angle, `entry (${point.dx}, ${point.dy})`).toBe(measured);
    }
  });

  it("IS THE MACHINE'S OWN ANGLE TABLE, entry for entry", () => {
    // The 44 bearings the ring evaluator adds up, +0x00A9C4..+0x00ACD8. 36 are
    // `addi.w` immediates in the instruction stream (0 at +0x00AB4E and $29,
    // $50, $84, $a9, $e2, $11e, $157, $17c and their mirrors from +0x00AB72 to
    // +0x00AC7A); the other 8 — entries 9-13 and 31-35 — come out of the two
    // 32-entry pre-summed blocks at +0x00A804 and +0x00A8E4.
    //
    // This is the table the reconstruction now sums, so it is pinned literally
    // rather than derived. Eight entries moved by one unit when the polynomial
    // atan was replaced: 5, 6, 16, 17, 27, 28, 38, 39.
    expect([...PROBE_RING.angle]).toEqual([
      0, 41, 80, 132, 169, 226, 286, 343, 380, 432, 471, 512, 553, 592, 644, 681, 738, 798, 855,
      892, 944, 983, 1024, 1065, 1104, 1156, 1193, 1250, 1310, 1367, 1404, 1456, 1495, 1536, 1577,
      1616, 1668, 1705, 1762, 1822, 1879, 1916, 1968, 2007,
    ]);
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

});

describe("the direction table the normal is read out of", () => {
  // This replaces the ring's `unitX`/`unitY` arrays, which were deleted with the
  // vector mean that summed them. The property they were asserting — "every
  // entry is a direction, not a length" — is asserted here instead, over all
  // 2048 bearings rather than the ring's 44, because the normal is now taken at
  // the machine's full 1/2048-turn resolution.
  it("is a unit circle at Q10, at every one of the 2048 bearings", () => {
    let worst = 0;
    for (let angle = 0; angle < ANGLE_UNITS_PER_TURN; angle += 1) {
      const x = cosineUnits(angle);
      const y = sineUnits(angle);
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
      worst = Math.max(worst, Math.abs(Math.hypot(x, y) - Q10_ONE));
    }
    // Measured 0.6384, which is the rounding of two Q10 components and nothing
    // else. A whole unit would mean the table was built wrong.
    expect(worst).toBeLessThan(0.7);
  });

  it("is the correctly rounded table, so no engine's Math.sin can move it", () => {
    for (let angle = 0; angle < ANGLE_UNITS_PER_TURN; angle += 1) {
      const radians = (2 * Math.PI * angle) / ANGLE_UNITS_PER_TURN;
      // `+ 0` on the reference: Math.round produces -0 for a small negative
      // argument and this table deliberately never does.
      expect(sineUnits(angle), `sin ${angle}`).toBe(Math.round(Q10_ONE * Math.sin(radians)) + 0);
      expect(cosineUnits(angle), `cos ${angle}`).toBe(Math.round(Q10_ONE * Math.cos(radians)) + 0);
    }
  });

  it("is exactly mirror-symmetric, so a mirrored bounce is a mirrored bounce", () => {
    for (let angle = 0; angle < ANGLE_UNITS_PER_TURN; angle += 1) {
      expect(sineUnits(-angle)).toBe(-sineUnits(angle) + 0);
      expect(cosineUnits(-angle)).toBe(cosineUnits(angle));
      expect(sineUnits(angle + ANGLE_HALF_TURN)).toBe(-sineUnits(angle) + 0);
      expect(cosineUnits(angle + ANGLE_HALF_TURN)).toBe(-cosineUnits(angle) + 0);
    }
  });

  it("agrees with the disk's own 16384-amplitude table to a unit at Q10", () => {
    // main.bin.seg01 file offset 0xBC is `round(16384 * sin(2*pi*i/2048))` with
    // zero error, reached through the hunk-1 relocations at main.seg00 0xB4BC
    // and 0xB4C2. This port carries the same table at Q10 because that is the
    // scale its vectors are written at; the amplitude cancels out of a rotation.
    let worst = 0;
    for (let angle = 0; angle < ANGLE_UNITS_PER_TURN; angle += 1) {
      const disk = Math.round(16384 * Math.sin((2 * Math.PI * angle) / ANGLE_UNITS_PER_TURN));
      worst = Math.max(worst, Math.abs(sineUnits(angle) - disk / 16));
    }
    expect(worst).toBeLessThanOrEqual(0.5);
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
    // RESTATED, AND TIGHTENED. This used to allow one ring step either side of
    // 768 and then assert `PROBE_RING.angle` contained the answer — a property
    // of the old rule, which snapped the mean onto a ring entry. The machine
    // does not snap: 432+471+512+553+592 + 944+983+1024+1065+1104 = 7680 over
    // ten hits, quadrant mask 0111 so no wrap correction, and 7680/10 is 768 on
    // the nose. 768 is NOT a ring angle — the nearest are 738 and 798 — and that
    // is the point. The exact bisector of a right-angled corner is now
    // reachable, where the old rule had to answer 738 or 798.
    expect(result.normalAngle).toBe(768);
    expect(PROBE_RING.angle).not.toContain(768);
    // ... and the reported contact POINT is still a ring entry, because that is
    // what +0x00AD92 quantises for: round(768 * 44 / 2048) = 17.
    expect(result.contactIndex).toBe(17);
  });
});

describe("probing across the 2047/0 wrap", () => {
  it("reports 0 for contacts either side of the seam, not the naive 1024", () => {
    // Ring point 43 is at angle 2007 and point 1 is at angle 41: a wall dead
    // ahead of a ball moving right, split by the seam. Their raw mean is 1024 —
    // the exact opposite direction, which would fire the ball INTO the wall it
    // just touched. THE MACHINE TAKES THAT RAW MEAN, and then fixes it with one
    // rule: quadrant mask 1001 is one of the three at +0x00ACD8, so every hit
    // below half a turn is re-read as angle + 2048 (`swap` + `ror.l #5` on the
    // count at +0x00ACEA) before the divide. (41 + 2048 + 2007) / 2 = 2048,
    // masked to 11 bits = 0.
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
    // RESTATED FROM `<= 32` TO THE EXACT VALUE. All three lie in quadrant 3, so
    // the mask is 1000, no correction fires, and the answer is the plain
    // truncated mean: (1916 + 1968 + 2007) / 3 = 1963.67 -> 1963. Five units off
    // the middle entry, and that IS the machine's answer, not slop in it.
    expect(result.normalAngle).toBe(1963);
    expect(angleGap(1963, 1968)).toBe(5);
  });

  it("HAS NO BISECTOR IN A CHANNEL, and the machine does not pretend otherwise", () => {
    const channel = makeMap((x) =>
      x >= CENTRE + BALL_RADIUS_PIXELS || x <= CENTRE - BALL_RADIUS_PIXELS ? WALL : OPEN_INDEX,
    );
    const result = probeAtCentre(channel);
    expect(result.contacts).toHaveLength(10);
    expect(result.contacts.map((c) => c.angle)).toEqual([
      0, 41, 80, 944, 983, 1024, 1065, 1104, 1968, 2007,
    ]);

    // RESTATED. This used to assert the answer was `contacts[0].angle` — 0 —
    // which was the old rule's arbitrary-but-deterministic fallback for a
    // cancelling vector sum. The machine has no fallback and no cancellation: it
    // sums, and the quadrant mask here is 1111. FIFTEEN IS THE ONE PATTERN THE
    // WRAP CORRECTION AT +0x00ACD8 DELIBERATELY SKIPS — it tests 1011, 1001 and
    // 1101 and nothing else — so the sum of 9216 is divided raw by 10 and the
    // answer is 921. That is not a bisector of anything, and it is not meant to
    // be; a contact arc round all four quadrants has no mean direction and the
    // machine returns a defined number rather than a meaningful one.
    expect(result.normalAngle).toBe(921);
    expect(result.contacts.reduce((sum, c) => sum + c.angle, 0)).toBe(9216);

    // What must hold is that it is DEFINED and STABLE, which is what the old
    // fallback was there to guarantee.
    expect(Number.isInteger(result.normalAngle)).toBe(true);
    expect(probeAtCentre(channel).normalAngle).toBe(result.normalAngle);
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

describe("the contact-angle producer, +0x00A9C4..+0x00AD04", () => {
  /** A contact set from bare bearings; only `angle` reaches the producer. */
  function contactsAt(angles: readonly number[]): readonly ContactPoint[] {
    return angles.map((angle) => ({
      ringIndex: PROBE_RING.angle.indexOf(angle),
      angle,
      material: WALL,
      x: 0,
      y: 0,
    }));
  }

  it("is a TRUNCATING mean of the tabulated bearings, +0x00ACFE divu.w", () => {
    // Not rounded. `divu.w` keeps the quotient and throws the remainder into the
    // high word, so 5891/3 = 1963.67 is 1963 and never 1964.
    expect(meanContactAngle(contactsAt([1916, 1968, 2007]))).toBe(1963);
    expect(meanContactAngle(contactsAt([0, 41]))).toBe(20);
    expect(meanContactAngle(contactsAt([512]))).toBe(512);
  });

  it("corrects the wrap on masks 1001, 1011 and 1101 — and on nothing else", () => {
    // 1001: quadrants 0 and 3 only.
    expect(meanContactAngle(contactsAt([41, 2007]))).toBe(0);
    // 1011: add a quadrant-1 hit. (41 + 2048 + 592 + 2048 + 2007)/3 = 2245 -> 197.
    expect(meanContactAngle(contactsAt([41, 592, 2007]))).toBe(197);
    // 1101: add a quadrant-2 hit instead. (41+2048 + 1456 + 2007)/3 = 1850.
    expect(meanContactAngle(contactsAt([41, 1456, 2007]))).toBe(1850);
    // 0101 contains quadrants 0 and 2 but not 3: no correction, raw mean.
    expect(meanContactAngle(contactsAt([0, 1024]))).toBe(512);
  });

  it("LEAVES MASK 1111 UNCORRECTED, which is a limit of the rule and not a gap", () => {
    // +0x00ACD8 tests three masks. Fifteen is not one of them, and reproducing
    // that is the difference between porting the machine and improving it.
    expect(meanContactAngle(contactsAt([0, 592, 1024, 1616]))).toBe(808);
    // The whole ring solid: 44032/44 = 1000.7 -> 1000. The old vector mean said
    // 0 here, because 44 symmetric unit vectors sum to nothing.
    expect(meanContactAngle(contactsAt([...PROBE_RING.angle]))).toBe(1000);
  });

  it("has no degenerate case, because the hardware gate guarantees N >= 1", () => {
    // +0x00A7F6 reads DMACONR's BZERO and only enters the evaluator when the
    // AND was non-empty, so +0x00ACFE can never divide by zero. The port keeps
    // the invariant as a throw rather than as a silent fallback.
    expect(() => meanContactAngle([])).toThrow(RangeError);
    // The three sets the old rule had to invent an answer for. All defined now.
    expect(meanContactAngle(contactsAt([0, 1024]))).toBe(512);
    expect(meanContactAngle(contactsAt([512, 1536]))).toBe(1024);
  });

  it("re-quantises onto the ring exactly on every tabulated bearing", () => {
    // +0x00AD92 `mulu.w #$580 / addi.l #$8000 / swap` = round(angle * 44/2048),
    // which assumes the 44 entries are evenly spaced. They are not, quite — so
    // this is a check that the assumption still round-trips all 44 of them.
    for (let i = 0; i < PROBE_RING_SIZE; i += 1) {
      expect(ringIndexForAngle(PROBE_RING, numberAt(PROBE_RING.angle, i))).toBe(i);
    }
    // 2047 lands on 44, which is the machine's 45th table row = the first.
    expect(Math.round((2047 * PROBE_RING_SIZE) / ANGLE_UNITS_PER_TURN)).toBe(44);
    expect(ringIndexForAngle(PROBE_RING, 2047)).toBe(0);
  });

  it("turns a bearing into the OPPOSITE unit vector, at 1/2048-turn resolution", () => {
    // The bearing points into the surface; the normal points out of it.
    expect(outwardNormalOf(0)).toEqual({ x: -Q10_ONE, y: 0 });
    expect(outwardNormalOf(512)).toEqual({ x: 0, y: -Q10_ONE });
    expect(outwardNormalOf(1024)).toEqual({ x: Q10_ONE, y: 0 });
    for (let angle = 0; angle < ANGLE_UNITS_PER_TURN; angle += 1) {
      const normal = outwardNormalOf(angle);
      expect(normal.x).toBe(-cosineUnits(angle) + 0);
      expect(normal.y).toBe(-sineUnits(angle) + 0);
    }
    // 768, the corner bisector the ring cannot express, is expressible here.
    expect(outwardNormalOf(768)).toEqual({ x: 724, y: -724 });
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
