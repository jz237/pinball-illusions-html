/**
 * The two collision levels, and the arch that only exists on the upper one.
 *
 * Half of this file is a unit test of the level view and the hand-off rule. The
 * other half asserts the SHIPPED MAP still says what the model was built on: the
 * lane's missing lower-level ceiling, the both-bits hand-off band, the two
 * concentric bit-1 arcs and the row where the arch's left leg stops carrying the
 * ball. If the maps are ever re-exported and one of those changes, the right
 * response is to re-derive `LEVEL_GATES_BY_TABLE`, not to adjust the number here.
 *
 * WHICH IS EXACTLY WHAT HAPPENED. The maps WERE re-exported: slot 2's payload
 * begins at byte 4, not byte 8, and the old export framed every row 32 px left
 * of where it belonged. Every column in this file is therefore 32 larger than it
 * was, and every ROW is untouched — a horizontal reframe cannot move a row,
 * which is the cleanest single check on the correction. One test did more than
 * shift: the arch's left leg does NOT pinch shut, and never did. It only looked
 * that way because the misframed bitmap cut its outboard rail off at column 0.
 * See "runs on down the left of the table" below.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MaterialIndex, TableMap, TableMapDocument } from "../src/game/contracts.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import {
  LEVEL0_SOLID_BIT,
  LEVEL1_SOLID_BIT,
  isLevel0Solid,
  materialTableFor,
} from "../src/game/materials.js";
import {
  LEVEL_GATES_BY_TABLE,
  levelAfterCrossing,
  levelGatesFor,
  nudgeReachesLevel,
  upperLevelIndex,
  upperLevelViewFor,
} from "../src/game/playfield-levels.js";
import type { LevelGate } from "../src/game/playfield-levels.js";
import { PROBE_RING, numberAt } from "../src/game/collision-probe.js";

const LAW: TableMap = parseTableMapDocument(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../public/generated/tables/law-n-justice.map.json", import.meta.url)),
      "utf8",
    ),
  ) as TableMapDocument,
);
const MATERIALS = materialTableFor("law-n-justice");
const UPPER = upperLevelViewFor(LAW);

/** Bounds-checked record lookup, because `noUncheckedIndexedAccess` is on. */
function numberAtKey(record: Record<string, number>, key: string): number {
  const value = record[key];
  if (value === undefined) throw new Error(`no entry for ${key}`);
  return value;
}

const ALL_INDICES: readonly MaterialIndex[] = Array.from(
  { length: 16 },
  (_, index) => index as MaterialIndex,
);

/** Set bits at one pixel of the shipped map. */
function bitsAt(x: number, y: number): number {
  return LAW.materialAt(x, y);
}

/** Columns in `[from, to]` whose pixel has `bit` set, on row y. */
function columnsWith(y: number, bit: number, from: number, to: number): number[] {
  const found: number[] = [];
  for (let x = from; x <= to; x += 1) {
    if ((bitsAt(x, y) & bit) !== 0) found.push(x);
  }
  return found;
}

/** True when a radius-8 ball centred here touches nothing on `map`. */
function centreIsClear(map: TableMap, x: number, y: number): boolean {
  if (!MATERIALS.behaviourFor(map.materialAt(x, y)).passable) return false;
  for (let i = 0; i < PROBE_RING.size; i += 1) {
    const py = y + numberAt(PROBE_RING.dy, i);
    if (py >= LAW.height) continue;
    const material = map.materialAt(x + numberAt(PROBE_RING.dx, i), py);
    if (!MATERIALS.behaviourFor(material).passable) return false;
  }
  return true;
}

/** Every clear ball centre a radius-8 ball can walk to from a seed. */
function reachableCentres(map: TableMap, seedX: number, seedY: number): Set<number> {
  const key = (x: number, y: number): number => y * LAW.width + x;
  const seen = new Set<number>();
  if (!centreIsClear(map, seedX, seedY)) return seen;
  const stack: [number, number][] = [[seedX, seedY]];
  seen.add(key(seedX, seedY));
  while (stack.length > 0) {
    const [x, y] = stack.pop() as [number, number];
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= LAW.width || ny < 0 || ny >= LAW.height) continue;
      if (seen.has(key(nx, ny))) continue;
      if (!centreIsClear(map, nx, ny)) continue;
      seen.add(key(nx, ny));
      stack.push([nx, ny]);
    }
  }
  return seen;
}

describe("the upper-level index rewrite", () => {
  it("makes a pixel solid exactly when the upper collision line is set", () => {
    for (const index of ALL_INDICES) {
      const expected = (index & LEVEL1_SOLID_BIT) !== 0;
      expect(isLevel0Solid(upperLevelIndex(index)), `index ${index}`).toBe(expected);
    }
  });

  it("lands on indices the material table already defines, with the right behaviour", () => {
    for (const index of ALL_INDICES) {
      const behaviour = MATERIALS.behaviourFor(upperLevelIndex(index));
      expect(behaviour.passable).toBe((index & LEVEL1_SOLID_BIT) === 0);
      // A rail is a plain wall and open ground is open ground: no upper-level
      // index may pick up a kick or an elasticity the lower level does not have.
      const twin = MATERIALS.behaviourFor(behaviour.passable ? 0 : 5);
      expect(behaviour.elasticity).toBe(twin.elasticity);
      expect(behaviour.friction).toBe(twin.friction);
      expect(behaviour.kick).toBe(twin.kick);
    }
  });

  it("keeps the structure bits, so nothing downstream loses the artwork layers", () => {
    for (const index of ALL_INDICES) {
      expect(upperLevelIndex(index) & 0b1100).toBe(index & 0b1100);
    }
  });
});

describe("the upper-level map view", () => {
  it("rewrites every pixel of the shipped map and shares its bitmap", () => {
    expect(UPPER.pixels).toBe(LAW.pixels);
    expect(UPPER.tableId).toBe(LAW.tableId);
    for (const [x, y] of [
      [0, 0],
      [144, 1],
      [290, 300],
      [290, 126],
      [303, 150],
      [167, 599],
    ] as const) {
      expect(UPPER.materialAt(x, y), `(${x},${y})`).toBe(upperLevelIndex(LAW.materialAt(x, y)));
    }
  });

  it("is solid outside the bitmap, which the plain rewrite could not be", () => {
    // The map answers 5 off-map, and 5 has no upper bit, so a naive rewrite would
    // make the edge of the world passable and lose an upper-level ball forever.
    expect(isLevel0Solid(upperLevelIndex(LAW.materialAt(-1, 100)))).toBe(false);
    for (const [x, y] of [
      [-1, 100],
      [336, 100],
      [100, -1],
      [Number.NaN, 10],
    ] as const) {
      expect(isLevel0Solid(UPPER.materialAt(x, y)), `(${x},${y})`).toBe(true);
    }
  });

  it("is cached, so a per-tick lookup does not allocate", () => {
    expect(upperLevelViewFor(LAW)).toBe(UPPER);
  });
});

describe("Law 'n Justice's shooter lane, as shipped", () => {
  it("has no lower-level ceiling at all — the bug the arch was hunted for", () => {
    for (let x = 313; x <= 332; x += 1) {
      for (let y = 0; y <= 560; y += 1) {
        expect((bitsAt(x, y) & LEVEL0_SOLID_BIT) === 0, `bit0 at (${x},${y})`).toBe(true);
      }
    }
  });

  it("is capped by the upper collision line instead", () => {
    // Every free column of the lane is crossed by the upper line above y=127.
    for (let x = 313; x <= 332; x += 1) {
      let capped = false;
      for (let y = 0; y < 127 && !capped; y += 1) {
        if ((bitsAt(x, y) & LEVEL1_SOLID_BIT) !== 0) capped = true;
      }
      expect(capped, `no upper-level cap above the lane in column ${x}`).toBe(true);
    }
  });

  it("hands over between the levels on a band where the two lines are identical", () => {
    // y<=126: the walls are upper-only. y=127..175: both. y>=176: lower-only.
    // 308..335 rather than the whole width: an unrelated lower-level rail runs
    // down x=303..305 beside the lane and is not part of the hand-off.
    const wall = (y: number, bit: number): number[] => columnsWith(y, bit, 308, 335);
    expect(wall(126, LEVEL1_SOLID_BIT)).toEqual([310, 311, 312, 333, 334, 335]);
    expect(wall(126, LEVEL0_SOLID_BIT)).toEqual([]);
    for (let y = 127; y <= 175; y += 1) {
      expect(wall(y, LEVEL0_SOLID_BIT), `row ${y}`).toEqual([310, 311, 312, 333, 334, 335]);
      expect(wall(y, LEVEL1_SOLID_BIT), `row ${y}`).toEqual([310, 311, 312, 333, 334, 335]);
    }
    expect(wall(176, LEVEL0_SOLID_BIT)).toEqual([310, 311, 312, 333, 334, 335]);
    expect(wall(176, LEVEL1_SOLID_BIT)).toEqual([]);
  });
});

describe("Law 'n Justice's top arch, as shipped", () => {
  const fromLane = reachableCentres(UPPER, 322, 400);

  it("carries a ball from the lane over the crown of the table", () => {
    const at = (x: number, y: number): boolean => fromLane.has(y * LAW.width + x);
    // Up the right leg, across the crown, down the left.
    expect(at(322, 200), "the lane itself").toBe(true);
    expect(at(262, 34), "the right leg").toBe(true);
    expect(at(176, 11), "the crown").toBe(true);
    expect(at(92, 34), "the left leg").toBe(true);
  });

  it("is a channel barely wider than the ball, which is what makes it a ramp", () => {
    const width = (y: number, from: number, to: number): number => {
      let count = 0;
      for (let x = from; x <= to; x += 1) {
        if (fromLane.has(y * LAW.width + x)) count += 1;
      }
      return count;
    };
    // A 16 px ball in a ~21 px channel leaves about five columns of free centre.
    expect(width(11, 132, 232)).toBeLessThan(40);
    expect(width(34, 232, 292)).toBeLessThan(20);
  });

  it("has no counterpart on the lower line, which is the whole problem", () => {
    // Rows 0..34 carry no lower-level pixel anywhere across the full width, so a
    // lower-level ball that got up there would be in a 336 px empty attic rather
    // than in a channel. That is what the virtual top wall exists to close, and
    // why the arch had to be somewhere else.
    let solid = 0;
    for (let y = 0; y <= 34; y += 1) {
      for (let x = 0; x < LAW.width; x += 1) {
        if ((bitsAt(x, y) & LEVEL0_SOLID_BIT) !== 0) solid += 1;
      }
    }
    expect(solid).toBe(0);
  });

  it("runs on down the left of the table and only ends at y=213", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the opposite was an artefact of
    // the misframed export. It read `rowWidth(91) === 0` and called that the ramp
    // "pinching shut", which is what forced a fabricated release point onto the
    // model. It does not pinch shut. On the corrected map the channel is
    // unbroken from the crown all the way down to y=213 — 122 rows further than
    // the old frame allowed — because the rail that appeared to run off column 0
    // was never at column 0; it was 32 px in from the left edge all along.
    //
    // x starts at 25 rather than 0 because the corrected map has a second thing
    // in the top-left that the old one did not: a strip along the very edge,
    // free centres x=8..14, which is separate from the ramp until they merge.
    const rowWidth = (y: number): number => {
      let count = 0;
      for (let x = 25; x < 120; x += 1) {
        if (fromLane.has(y * LAW.width + x)) count += 1;
      }
      return count;
    };
    // Two to fifteen free centres a row: a channel barely wider than the ball,
    // the whole way down. Never open playfield, never nothing.
    for (let y = 46; y <= 213; y += 1) {
      expect(rowWidth(y), `row ${y}`).toBeGreaterThan(0);
      expect(rowWidth(y), `row ${y}`).toBeLessThan(16);
    }
    // And then the ramp's inboard rail runs out and the channel merges into that
    // edge strip: at y=214 every column from 8 to 29 is one connected run, which
    // is not true one row of the ramp earlier.
    const merged = (y: number): boolean => {
      for (let x = 8; x <= 29; x += 1) if (!fromLane.has(y * LAW.width + x)) return false;
      return true;
    };
    expect(merged(207)).toBe(false);
    expect(merged(213)).toBe(false);
    expect(merged(214)).toBe(true);
  });
});

describe("the hand-off gates", () => {
  const gates = levelGatesFor("law-n-justice");
  const gate = (id: string): LevelGate => {
    const found = gates.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`no gate ${id}`);
    return found;
  };

  it("puts the lane gate inside the band where both lines agree", () => {
    const lane = gate("lane-mouth");
    expect(lane.y).toBeGreaterThanOrEqual(127);
    expect(lane.y).toBeLessThanOrEqual(175);
    // And it spans the free ball centres of the lane at that row, so no launch
    // slips past it: a ball outside 321..324 there is inside a lane wall.
    expect(lane.minX).toBeLessThanOrEqual(321);
    expect(lane.maxX).toBeGreaterThanOrEqual(324);
    expect(lane.whenRising).toBe(1);
    expect(lane.whenFalling).toBe(0);
  });

  it("puts the ramp end on the last row the wireform can hand the ball over", () => {
    // Replaces "puts the arch exit above the point where the ramp pinches shut".
    // The ramp does not pinch shut (see above), so the gate that existed to
    // rescue a ball from a ramp that had run off the edge of the bitmap is gone.
    // `ramp-end` is read off the map instead: the LAST row on which the whole
    // upper channel is also free on the lower line, so the hand-off cannot put
    // the ball inside a wall, and one row before the ramp opens out.
    const exit = gate("ramp-end");
    expect(exit.whenRising).toBeNull();
    expect(exit.whenFalling).toBe(0);

    const fromLane = reachableCentres(UPPER, 322, 400);
    const channelAt = (y: number): number[] => {
      const found: number[] = [];
      for (let x = 25; x < 120; x += 1) if (fromLane.has(y * LAW.width + x)) found.push(x);
      return found;
    };
    // The gate is exactly the ramp channel on its row, no wider and no narrower.
    const channel = channelAt(exit.y);
    expect(channel.length).toBeGreaterThan(0);
    expect(exit.minX).toBe(Math.min(...channel));
    expect(exit.maxX).toBe(Math.max(...channel));

    // Every column of it is free on the LOWER line too...
    for (const x of channel) {
      expect(centreIsClear(LAW, x, exit.y), `lower line at (${x},${exit.y})`).toBe(true);
    }
    // ...and one row further down that stops being true, which is what makes
    // this the last row rather than a preference.
    expect(channelAt(exit.y + 1).some((x) => !centreIsClear(LAW, x, exit.y + 1))).toBe(true);
  });

  it("gives every table a lane hand-off, because every table needs one", () => {
    // This used to assert the opposite — that BabeWatch and Extreme Sports were
    // left empty because their hand-off "could not be resolved". Both are now
    // derived by the same rule Law 'n Justice's is; see `level-scan.test.ts`,
    // which re-runs that derivation against the shipped maps.
    for (const tableId of TABLE_IDS) {
      expect(LEVEL_GATES_BY_TABLE[tableId]).toBe(levelGatesFor(tableId));
      const ids = levelGatesFor(tableId).map((entry) => entry.id);
      expect(ids).toContain("lane-mouth");
      // Ids are what a failing test names, so they have to be unique per table.
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("never sends a ball onto a level whose lane walls are missing there", () => {
    // The hazard that would lose a ball silently: BabeWatch and Extreme Sports
    // have NO upper-line lane walls below y=457 and y=480, so a ball put on
    // level 1 down there would pass straight through the lane and be gone. Every
    // gate that can put a ball on level 1 must therefore sit above that.
    const lowestUpperLaneRow: Record<string, number> = {
      "law-n-justice": 600,
      babewatch: 457,
      "extreme-sports": 480,
    };
    for (const tableId of TABLE_IDS) {
      for (const entry of levelGatesFor(tableId)) {
        if (entry.whenRising === 1 || entry.whenFalling === 1) {
          expect(
            entry.y,
            `${tableId}/${entry.id} would put a ball on the ramp line below its rails`,
          ).toBeLessThanOrEqual(numberAtKey(lowestUpperLaneRow, tableId));
        }
      }
    }
  });
});

describe("crossing a gate", () => {
  const gates: readonly LevelGate[] = [
    { id: "two-way", minX: 10, maxX: 20, y: 100, whenRising: 1, whenFalling: 0 },
    { id: "one-way", minX: 30, maxX: 40, y: 200, whenRising: null, whenFalling: 0 },
  ];

  it("changes level only when the row is actually crossed", () => {
    expect(levelAfterCrossing(gates, 0, 15, 120, 15, 90)).toBe(1);
    expect(levelAfterCrossing(gates, 1, 15, 90, 15, 120)).toBe(0);
    // Moving within one side of the line changes nothing.
    expect(levelAfterCrossing(gates, 0, 15, 120, 15, 101)).toBe(0);
    expect(levelAfterCrossing(gates, 1, 15, 90, 15, 99)).toBe(1);
  });

  it("counts a ball sitting exactly on the row as below it", () => {
    // Otherwise a ball that ends a tick on the line never crosses at all: the
    // next tick starts above it and the crossing is lost for good.
    expect(levelAfterCrossing(gates, 0, 15, 100, 15, 99)).toBe(1);
    expect(levelAfterCrossing(gates, 1, 15, 99, 15, 100)).toBe(0);
  });

  it("ignores a crossing outside the gate's columns", () => {
    expect(levelAfterCrossing(gates, 0, 9, 120, 9, 90)).toBe(0);
    expect(levelAfterCrossing(gates, 0, 21, 120, 21, 90)).toBe(0);
  });

  it("takes the column at the crossing, not the column the tick ended on", () => {
    // A gate is a LINE the ball goes through, and a fast diagonal can begin the
    // tick left of the gate's columns and end it right of them having passed
    // straight through the middle. Sampling only the end column loses that:
    // Extreme Sports' crown mouth is two columns wide at its lowest row and a
    // ball rolling down the arc covers six rows in one tick.
    expect(levelAfterCrossing(gates, 0, 5, 120, 25, 90)).toBe(1);
    expect(levelAfterCrossing(gates, 1, 5, 90, 25, 120)).toBe(0);
    // A path whose crossing really is outside the columns still misses.
    expect(levelAfterCrossing(gates, 0, 25, 120, 45, 90)).toBe(0);
  });

  it("leaves the level alone in a direction the gate does not define", () => {
    expect(levelAfterCrossing(gates, 0, 35, 220, 35, 180)).toBe(0);
    expect(levelAfterCrossing(gates, 1, 35, 220, 35, 180)).toBe(1);
    expect(levelAfterCrossing(gates, 1, 35, 180, 35, 220)).toBe(0);
  });

  it("does nothing at all when a table has no gates", () => {
    expect(levelAfterCrossing([], 1, 15, 120, 15, 90)).toBe(1);
  });
});

describe("what a shove reaches", () => {
  it("reaches the playfield and not the ramps", () => {
    // A habitrail is a tube; the cabinet does not reach into it. The measured
    // consequence of getting this wrong is in `nudgeReachesLevel`.
    expect(nudgeReachesLevel(0)).toBe(true);
    expect(nudgeReachesLevel(1)).toBe(false);
  });
});
