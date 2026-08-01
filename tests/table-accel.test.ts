/**
 * The ramp drive, and the proof that it is the ramps.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COINCIDENCE MEASUREMENT IS A TEST AND NOT A NOTE IN A COMMENT
 * ---------------------------------------------------------------------------
 * A table of small signed numbers is not a finding. Any 3,150-byte window of
 * mostly-zero bytes can be reshaped into a 42x75 grid and described as a
 * per-block acceleration; what makes THIS one the acceleration is that its
 * non-zero blocks land ON the ramps and habitrails of the SAME table's collision
 * map, and that is a claim about two independently exported files agreeing with
 * each other. Two files can only be checked against each other by executing the
 * check, so it is executed here, against `public/generated/tables/*.map.json` and
 * `*.accel.json` exactly as shipped. If either export is ever regenerated on a
 * different framing, this fails instead of the game.
 *
 * The measurement is a LIFT: the fraction of driven blocks that carry the
 * level's own structure artwork, over the fraction of all blocks that do. A lift
 * of 1 is chance. The controls that make it meaningful — a column-major reshape,
 * the wrong level's bit, and a pixel-shift sweep of the registration — were run
 * during the decode and are recorded in `scripts/export-table-accel.mjs`; what is
 * pinned here is the part a re-export could silently break.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { TABLE_IDS, PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../src/game/contracts.js";
import type { TableAccelDocument, TableId } from "../src/game/contracts.js";
import {
  ACCEL_BLOCK_SIZE,
  ACCEL_COLUMNS,
  ACCEL_ROWS,
  ORIGINAL_GRAVITY_PER_SUBSTEP,
  ORIGINAL_SUBSTEPS_PER_FRAME,
  TICKS_PER_ORIGINAL_UNIT,
  clearTableAccelerations,
  parseTableAccelDocument,
  registerTableAcceleration,
  tableAccelerationFor,
  tableAccelUrl,
} from "../src/game/table-accel.js";
import {
  Q10_PER_ORIGINAL_VELOCITY_UNIT,
  SIMULATION_GRAVITY,
} from "../src/game/timebase.js";
import { LEVEL0_STRUCTURE_BIT, LEVEL1_STRUCTURE_BIT } from "../src/game/materials.js";
import { mapFor, accelFor } from "./table-fixtures.js";

function docFor(tableId: TableId): TableAccelDocument {
  const url = new URL(`../public/generated/tables/${tableId}.accel.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as TableAccelDocument;
}

/** The block grid a document declares for one level, expanded from its runs. */
function gridOf(doc: TableAccelDocument, level: 0 | 1): Uint8Array {
  const grid = new Uint8Array(ACCEL_COLUMNS * ACCEL_ROWS);
  const rows = doc.levels[level] as readonly (readonly number[])[];
  rows.forEach((runs, row) => {
    let column = 0;
    for (let pair = 0; pair < runs.length; pair += 2) {
      const end = runs[pair] as number;
      const index = runs[pair + 1] as number;
      grid.fill(index, row * ACCEL_COLUMNS + column, row * ACCEL_COLUMNS + end + 1);
      column = end + 1;
    }
  });
  return grid;
}

/** Blocks in which at least one pixel of the map carries `bit`. */
function blockMaskOf(tableId: TableId, bit: number): Uint8Array {
  const map = mapFor(tableId);
  const mask = new Uint8Array(ACCEL_COLUMNS * ACCEL_ROWS);
  for (let y = 0; y < PLAYFIELD_HEIGHT; y += 1) {
    for (let x = 0; x < PLAYFIELD_WIDTH; x += 1) {
      if ((map.materialAt(x, y) & bit) !== 0) {
        mask[(y >> 3) * ACCEL_COLUMNS + (x >> 3)] = 1;
      }
    }
  }
  return mask;
}

describe("the ramp drive document", () => {
  it("ships one for every table, and every one parses", () => {
    for (const tableId of TABLE_IDS) {
      const acceleration = accelFor(tableId);
      expect(acceleration.tableId).toBe(tableId);
      expect(acceleration.blocks).toHaveLength(2);
      for (const grid of acceleration.blocks) {
        expect(grid).toHaveLength(ACCEL_COLUMNS * ACCEL_ROWS);
      }
    }
  });

  it("tiles the whole playfield in 8x8 blocks with nothing left over", () => {
    expect(ACCEL_COLUMNS * ACCEL_BLOCK_SIZE).toBe(PLAYFIELD_WIDTH);
    expect(ACCEL_ROWS * ACCEL_BLOCK_SIZE).toBe(PLAYFIELD_HEIGHT);
    expect(ACCEL_COLUMNS * ACCEL_ROWS).toBe(3150);
  });

  it("keeps the disk's own vector shape: entry 0 is null and no dy lifts the ball", () => {
    // A ramp steepens the local fall line; it does not push the ball uphill. Both
    // hold on all three tables and both would fail on a misframed read.
    for (const tableId of TABLE_IDS) {
      const { vectors } = accelFor(tableId);
      expect(vectors[0]).toEqual([0, 0]);
      for (const [dx, dy] of vectors) {
        expect(dy, `${tableId} dy`).toBeGreaterThanOrEqual(0);
        expect(Math.abs(dx), `${tableId} dx`).toBeLessThanOrEqual(63);
        expect(dy, `${tableId} dy`).toBeLessThanOrEqual(63);
      }
    }
  });

  it("uses every vector it declares, and declares every vector it uses", () => {
    // The block maps' highest index is exactly one below the vector count on all
    // three tables — the same fact the slot-0 descriptor states independently in
    // its word 23, which is what pinned the end of the vector list to the byte.
    for (const tableId of TABLE_IDS) {
      const doc = docFor(tableId);
      let highest = 0;
      for (const level of [0, 1] as const) {
        for (const index of gridOf(doc, level)) if (index > highest) highest = index;
      }
      expect(highest + 1, `${tableId} vector count`).toBe(doc.vectors.length);
    }
  });

  it("drives a minority of blocks, in whole regions rather than confetti", () => {
    // Most of a playfield is flat, and a drive region is a run along a rail. Both
    // are properties of ramp data and neither survives a misframed read.
    for (const tableId of TABLE_IDS) {
      const doc = docFor(tableId);
      for (const level of [0, 1] as const) {
        const grid = gridOf(doc, level);
        let driven = 0;
        for (const index of grid) if (index !== 0) driven += 1;
        expect(driven, `${tableId} L${level} driven`).toBeGreaterThan(0);
        expect(driven, `${tableId} L${level} driven`).toBeLessThan(grid.length / 2);

        // Every distinct non-zero index is ONE 4-connected component. Not "mostly"
        // — every one of the forty regions across the six grids, which is what a
        // region on a rail looks like and what a coincidence does not.
        const seen = new Uint8Array(grid.length);
        let components = 0;
        const values = new Set<number>();
        for (let start = 0; start < grid.length; start += 1) {
          const value = grid[start] as number;
          if (value === 0) continue;
          values.add(value);
          if (seen[start] === 1) continue;
          components += 1;
          const stack = [start];
          seen[start] = 1;
          while (stack.length > 0) {
            const cell = stack.pop() as number;
            const row = Math.floor(cell / ACCEL_COLUMNS);
            const column = cell % ACCEL_COLUMNS;
            for (const next of [
              column > 0 ? cell - 1 : -1,
              column < ACCEL_COLUMNS - 1 ? cell + 1 : -1,
              row > 0 ? cell - ACCEL_COLUMNS : -1,
              row < ACCEL_ROWS - 1 ? cell + ACCEL_COLUMNS : -1,
            ]) {
              if (next < 0 || seen[next] === 1 || grid[next] !== value) continue;
              seen[next] = 1;
              stack.push(next);
            }
          }
        }
        expect(components, `${tableId} L${level} regions vs distinct indices`).toBe(values.size);
      }
    }
  });

  it("lands its driven blocks on the ramps, on both levels of all three tables", () => {
    // THE PROOF. Each level's driven blocks against that level's own structure
    // artwork, as a lift over chance. Measured on the shipped files:
    //
    //              L0 bit 2            L1 bit 3
    //   lnj        0.683 / 0.630 1.08  0.634 / 0.245 2.58
    //   babewatch  0.903 / 0.594 1.52  0.818 / 0.275 2.97
    //   extreme    0.636 / 0.572 1.11  0.579 / 0.365 1.59
    //
    // The level-1 lifts are the strong ones and they are the ones that matter:
    // bit 3 is the UPPER structure area, which is the ramp and habitrail network
    // itself, and it covers only 25-37% of the table. Bit 2 covers 57-63% of the
    // table — most of the lower playfield is "structure" — so it is a weak
    // discriminator by construction and is asserted only to be at or above chance
    // rather than to any particular height. Floors are set below the measured
    // values with room for a re-export to move them a little, and well above 1.
    const FLOOR: Readonly<Record<TableId, number>> = {
      "law-n-justice": 2.0,
      babewatch: 2.4,
      "extreme-sports": 1.35,
    };
    for (const tableId of TABLE_IDS) {
      const doc = docFor(tableId);
      for (const [level, bit] of [
        [0, LEVEL0_STRUCTURE_BIT],
        [1, LEVEL1_STRUCTURE_BIT],
      ] as const) {
        const grid = gridOf(doc, level);
        const mask = blockMaskOf(tableId, bit);
        let masked = 0;
        for (const value of mask) masked += value;
        let driven = 0;
        let hit = 0;
        for (let cell = 0; cell < grid.length; cell += 1) {
          if (grid[cell] === 0) continue;
          driven += 1;
          hit += mask[cell] as number;
        }
        const lift = hit / driven / (masked / grid.length);
        // The upper level is the ramp network and must be well above chance; the
        // lower level's bit 2 is most of the table, so chance is the bar there.
        expect(lift, `${tableId} L${level} lift`).toBeGreaterThanOrEqual(
          level === 1 ? (FLOOR[tableId] as number) : 1.0,
        );
      }
    }
  });

  it("puts a downward drive in the two shooter lanes that have one, and none in the third", () => {
    // This is the fact that moved Extreme Sports' full-plunge speed, so it is
    // pinned rather than left in a comment. The lane occupies block columns
    // 39..41 on all three tables.
    const driven = (tableId: TableId): number => {
      const doc = docFor(tableId);
      let count = 0;
      for (const level of [0, 1] as const) {
        const grid = gridOf(doc, level);
        for (let row = 0; row < ACCEL_ROWS; row += 1) {
          for (const column of [39, 40, 41]) {
            if (grid[row * ACCEL_COLUMNS + column] !== 0) count += 1;
          }
        }
      }
      return count;
    };
    expect(driven("law-n-justice")).toBeGreaterThan(20);
    expect(driven("extreme-sports")).toBeGreaterThan(20);
    // BabeWatch's lane is not driven, which is why its launch threshold is the
    // lowest of the three by a wide margin. See plunger.ts.
    expect(driven("babewatch")).toBeLessThan(10);
  });
});

describe("the unit bridge into this port", () => {
  it("is forced by the original's own integrator, not solved for from this port", () => {
    // THE OLD FORM OF THIS TEST IS THE DEFECT IT MISSED. It asserted
    //
    //     TICKS_PER_ORIGINAL_UNIT * (4 * 8) === PLUNGER_REFERENCE_GRAVITY * 8
    //
    // which cancels to 24/4 and is true for ANY gravity you care to put in it:
    // it checked that the port was self-consistent, and the port was
    // self-consistently 16/3 too floaty. The bridge is now closed against the
    // ORIGINAL: each of its eight substeps moves the ball by v>>1, so one of its
    // velocity units is four Q10 of travel per frame and one unit of per-substep
    // acceleration is eight of those.
    const originalPerFrame = ORIGINAL_GRAVITY_PER_SUBSTEP * ORIGINAL_SUBSTEPS_PER_FRAME;
    expect(originalPerFrame).toBe(32);
    expect(Q10_PER_ORIGINAL_VELOCITY_UNIT).toBe(ORIGINAL_SUBSTEPS_PER_FRAME / 2);
    expect(TICKS_PER_ORIGINAL_UNIT).toBe(
      ORIGINAL_SUBSTEPS_PER_FRAME * Q10_PER_ORIGINAL_VELOCITY_UNIT,
    );
    // Which comes out at exactly 32, and being a whole number is why the
    // simulation path stays integral.
    expect(TICKS_PER_ORIGINAL_UNIT).toBe(32);
    expect(Number.isInteger(TICKS_PER_ORIGINAL_UNIT)).toBe(true);
    // And gravity is then the shipped option through that same bridge, so the
    // two cannot be adjusted independently of one another.
    expect(SIMULATION_GRAVITY).toBe(ORIGINAL_GRAVITY_PER_SUBSTEP * TICKS_PER_ORIGINAL_UNIT);
    expect(SIMULATION_GRAVITY).toBe(128);
  });

  it("converts each vector into Q10 per tick at that scale", () => {
    for (const tableId of TABLE_IDS) {
      const acceleration = accelFor(tableId);
      const doc = docFor(tableId);
      const grid = gridOf(doc, 1);
      // Find a block using the largest-magnitude vector and read its drive back.
      let best = 0;
      let bestCell = -1;
      for (let cell = 0; cell < grid.length; cell += 1) {
        const [dx, dy] = acceleration.vectors[grid[cell] as number] as readonly [number, number];
        const size = Math.abs(dx) + dy;
        if (size > best) {
          best = size;
          bestCell = cell;
        }
      }
      expect(bestCell, `${tableId} has no driven block on level 1`).toBeGreaterThanOrEqual(0);
      const column = bestCell % ACCEL_COLUMNS;
      const row = Math.floor(bestCell / ACCEL_COLUMNS);
      const [dx, dy] = acceleration.vectors[grid[bestCell] as number] as readonly [number, number];
      const drive = acceleration.driveAt(1, column * 8 + 3, row * 8 + 3);
      expect(drive.x).toBe(dx * TICKS_PER_ORIGINAL_UNIT);
      expect(drive.y).toBe(dy * TICKS_PER_ORIGINAL_UNIT);
    }
  });

  it("reads the block a ball CENTRE is in, and nothing off the playfield", () => {
    const acceleration = accelFor("law-n-justice");
    // Every pixel of a block gives that block's drive: the engine's index is
    // `(cy >> 3) * 42 + (cx >> 3)` on the ball centre, with no half-block shift.
    const doc = docFor("law-n-justice");
    const grid = gridOf(doc, 1);
    let cell = -1;
    for (let candidate = 0; candidate < grid.length; candidate += 1) {
      if (grid[candidate] !== 0) {
        cell = candidate;
        break;
      }
    }
    const column = cell % ACCEL_COLUMNS;
    const row = Math.floor(cell / ACCEL_COLUMNS);
    const expected = acceleration.driveAt(1, column * 8, row * 8);
    expect(expected).not.toEqual({ x: 0, y: 0 });
    for (let dy = 0; dy < 8; dy += 1) {
      for (let dx = 0; dx < 8; dx += 1) {
        expect(acceleration.driveAt(1, column * 8 + dx, row * 8 + dy)).toEqual(expected);
      }
    }
    // Off the playfield there is no drive rather than an out-of-range read.
    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [PLAYFIELD_WIDTH, 0],
      [0, PLAYFIELD_HEIGHT],
    ] as const) {
      expect(acceleration.driveAt(0, x, y)).toEqual({ x: 0, y: 0 });
    }
  });
});

describe("the registry", () => {
  it("refuses to answer for a table nothing has loaded, rather than answering zero", () => {
    // A table quietly running without its ramp drive is a different machine, and
    // the failure is invisible from the outside: the arch stops carrying the ball
    // and shallow surfaces trap it. So this throws, and `createGame` calls it.
    clearTableAccelerations();
    expect(() => tableAccelerationFor("law-n-justice")).toThrow(/no ramp drive registered/);
    // And says what to load.
    expect(() => tableAccelerationFor("law-n-justice")).toThrow(/law-n-justice\.accel\.json/);
    registerTableAcceleration(parseTableAccelDocument(docFor("law-n-justice")));
    expect(tableAccelerationFor("law-n-justice").tableId).toBe("law-n-justice");
  });

  it("names the document it expects", () => {
    expect(tableAccelUrl("babewatch")).toBe("generated/tables/babewatch.accel.json");
  });
});

describe("the parser refuses a malformed document", () => {
  const good = (): TableAccelDocument => docFor("law-n-justice");

  it("rejects a wrong schema", () => {
    expect(() => parseTableAccelDocument({ ...good(), schema: "nope" } as never)).toThrow(/schema/);
  });

  it("rejects a vector 0 that is not the null drive", () => {
    const doc = good();
    const vectors = [[1, 1], ...doc.vectors.slice(1)];
    expect(() => parseTableAccelDocument({ ...doc, vectors } as never)).toThrow(/no drive/);
  });

  it("rejects a vector that would lift the ball", () => {
    const doc = good();
    const vectors = [...doc.vectors];
    vectors[1] = [0, -5];
    expect(() => parseTableAccelDocument({ ...doc, vectors } as never)).toThrow(/negative/);
  });

  it("rejects a block index with no vector behind it", () => {
    const doc = good();
    const levels = [doc.levels[0]?.map((_, row) => (row === 0 ? [41, 99] : [41, 0])), doc.levels[1]];
    expect(() => parseTableAccelDocument({ ...doc, levels } as never)).toThrow(/outside the/);
  });

  it("rejects a row that does not cover every column", () => {
    const doc = good();
    const levels = [doc.levels[0]?.map((_, row) => (row === 0 ? [30, 0] : [41, 0])), doc.levels[1]];
    expect(() => parseTableAccelDocument({ ...doc, levels } as never)).toThrow(/covers 31 columns/);
  });

  it("rejects a document that does not carry exactly two levels", () => {
    const doc = good();
    expect(() => parseTableAccelDocument({ ...doc, levels: [doc.levels[0]] } as never)).toThrow(
      /exactly two levels/,
    );
  });
});
