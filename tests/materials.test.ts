import { describe, expect, it } from "vitest";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { MaterialBehaviour, MaterialIndex } from "../src/game/contracts.js";
import {
  DEVICE_PRESETS,
  LEVEL0_SOLID_BIT,
  LEVEL0_STRUCTURE_BIT,
  LEVEL1_SOLID_BIT,
  LEVEL1_STRUCTURE_BIT,
  OPEN_INDEX,
  SLOT2_PLANE_BASES,
  SOLID_BORDER_INDEX,
  isLevel0Solid,
  isLevel1Solid,
  materialTableFor,
} from "../src/game/materials.js";

const ALL_INDICES: readonly MaterialIndex[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const CONFIDENCES = ["measured", "inferred", "provisional"] as const;
const Q10_ONE = 1024;

function behavioursOf(tableId: (typeof TABLE_IDS)[number]): MaterialBehaviour[] {
  const table = materialTableFor(tableId);
  return ALL_INDICES.map((index) => table.behaviourFor(index));
}

describe("table completeness", () => {
  it("covers all 16 indices on every table", () => {
    for (const tableId of TABLE_IDS) {
      const table = materialTableFor(tableId);
      expect(table.tableId).toBe(tableId);
      expect(table.behaviours.size).toBe(16);
      for (const index of ALL_INDICES) {
        expect(table.behaviours.has(index)).toBe(true);
      }
    }
  });

  it("keys every entry by its own index, so a lookup cannot return a neighbour", () => {
    for (const tableId of TABLE_IDS) {
      const table = materialTableFor(tableId);
      for (const index of ALL_INDICES) {
        expect(table.behaviourFor(index).index).toBe(index);
      }
    }
  });

  it("throws rather than returning undefined for a value outside 0..15", () => {
    const table = materialTableFor("law-n-justice");
    expect(() => table.behaviourFor(16 as MaterialIndex)).toThrow(RangeError);
    expect(() => table.behaviourFor(-1 as MaterialIndex)).toThrow(RangeError);
  });
});

describe("the open playfield", () => {
  it("has exactly one open index and it is index 0", () => {
    for (const tableId of TABLE_IDS) {
      const open = behavioursOf(tableId).filter((b) => b.kind === "open");
      expect(open).toHaveLength(1);
      expect(open[0]?.index).toBe(OPEN_INDEX);
    }
  });

  it("lets a ball roll and drain: open is passable, unpowered and barely damped", () => {
    for (const tableId of TABLE_IDS) {
      const open = materialTableFor(tableId).behaviourFor(OPEN_INDEX);
      expect(open.passable).toBe(true);
      expect(open.elasticity).toBe(0);
      expect(open.kick).toBe(0);
      // The drain gap on the last physics row is index 0. Too much rolling
      // friction there and the ball never reaches it.
      expect(open.friction).toBeGreaterThan(0);
      expect(open.friction).toBeLessThan(Q10_ONE / 8);
    }
  });
});

describe("passability and coefficients are coherent", () => {
  it("blocks exactly the indices whose level-0 collision bit is set", () => {
    for (const tableId of TABLE_IDS) {
      for (const behaviour of behavioursOf(tableId)) {
        expect(behaviour.passable).toBe(!isLevel0Solid(behaviour.index));
      }
    }
  });

  it("gives passable materials no rebound and no kick", () => {
    for (const tableId of TABLE_IDS) {
      for (const behaviour of behavioursOf(tableId).filter((b) => b.passable)) {
        expect(behaviour.elasticity).toBe(0);
        expect(behaviour.kick).toBe(0);
      }
    }
  });

  it("gives every blocking material a usable but sub-unity rebound", () => {
    for (const tableId of TABLE_IDS) {
      const blocking = behavioursOf(tableId).filter((b) => !b.passable);
      expect(blocking.length).toBeGreaterThan(0);
      for (const behaviour of blocking) {
        // A plain wall sits in the 0.55-0.7 band; nothing in the pixel table
        // may exceed a perfect bounce or it would pump energy in forever.
        expect(behaviour.elasticity).toBeGreaterThanOrEqual(Math.round(0.5 * Q10_ONE));
        expect(behaviour.elasticity).toBeLessThanOrEqual(Q10_ONE);
      }
    }
  });

  it("keeps every coefficient a non-negative Q10 integer", () => {
    for (const tableId of TABLE_IDS) {
      for (const b of behavioursOf(tableId)) {
        for (const value of [b.elasticity, b.friction, b.kick]) {
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(Q10_ONE);
        }
      }
    }
  });

  it("keeps the solid border material solid, since off-map probes read it", () => {
    const border = materialTableFor("law-n-justice").behaviourFor(SOLID_BORDER_INDEX);
    expect(border.passable).toBe(false);
    expect(border.kind).toBe("wall");
  });
});

describe("confidence labelling", () => {
  it("labels every entry, so no guess can hide", () => {
    for (const tableId of TABLE_IDS) {
      for (const behaviour of behavioursOf(tableId)) {
        expect(CONFIDENCES).toContain(behaviour.confidence);
      }
    }
  });

  it("does not claim a measurement for the vanishingly rare bit-overlap classes", () => {
    // Indices 3, 7, 9 and 11 are 0-159 px per table: line crossings, not
    // designed materials. Claiming them measured would be dressing up a guess.
    const table = materialTableFor("law-n-justice");
    for (const index of [3, 7, 9, 11] as const) {
      expect(table.behaviourFor(index).confidence).toBe("provisional");
    }
  });
});

describe("bitfield semantics", () => {
  it("derives the two collision bits independently", () => {
    expect(LEVEL0_SOLID_BIT).toBe(0x1);
    expect(LEVEL1_SOLID_BIT).toBe(0x2);
    expect(isLevel0Solid(5)).toBe(true);
    expect(isLevel0Solid(14)).toBe(false);
    expect(isLevel1Solid(14)).toBe(true);
    expect(isLevel1Solid(5)).toBe(false);
  });

  it("keeps upper-level rails passable on the lower playfield", () => {
    // Index 14 is 8644 px of ramp guide rail on Law 'n Justice and 84% of it is
    // reachable by a ball rolling on the lower playfield. Blocking it there
    // would fence off a large part of the table.
    for (const index of [2, 6, 10, 14] as const) {
      expect(materialTableFor("law-n-justice").behaviourFor(index).passable).toBe(true);
    }
  });

  it("keeps the structure bits out of the lower-level collision test", () => {
    // ADJUDICATED, do not flip this without new evidence. Four independent
    // investigations (two disassembly, two connectivity) agreed that bit 2 does
    // not block. The collision test is a blitter AND over a SINGLE bitplane
    // (main.seg00 +0x00B492, BLTCON0 $0BA0 = `D = A AND C`) whose source stride
    // is 42 bytes = one 336px layer, and whose 17-row look-ahead can only be
    // served by a 620-row layer — bits 2 and 3 are 600-row layers. Bit 2 is read
    // only by the sprite masker at +0x00BF3C. Blocking it seals the plunger lane
    // on two of three tables. See docs/DISK_ANALYSIS.md.
    const table = materialTableFor("law-n-justice");
    for (const index of ALL_INDICES) {
      const withStructure = (index | LEVEL0_STRUCTURE_BIT | LEVEL1_STRUCTURE_BIT) as MaterialIndex;
      expect(table.behaviourFor(withStructure).passable).toBe(table.behaviourFor(index).passable);
    }
    // The four large even indices carrying bit 2 are the ones that matter:
    // index 4 alone is ~33% of Law 'n Justice.
    for (const index of [4, 6, 12, 14] as const) {
      expect(table.behaviourFor(index).passable).toBe(true);
    }
  });

  it("records the corrected slot-2 plane bases the map export must use", () => {
    expect(SLOT2_PLANE_BASES.map((p) => p.offset)).toEqual([0, 26040, 52080, 77280]);
    const total = SLOT2_PLANE_BASES.reduce((sum, p) => sum + p.rows * 42, 0);
    expect(total).toBe(102480);
  });
});

describe("device presets", () => {
  it("keeps rubber bouncier than a wall and gives powered devices a kick", () => {
    const wall = materialTableFor("law-n-justice").behaviourFor(SOLID_BORDER_INDEX);
    const rubber = DEVICE_PRESETS["rubber"];
    const slingshot = DEVICE_PRESETS["slingshot"];
    const bumper = DEVICE_PRESETS["bumper"];
    expect(rubber).toBeDefined();
    expect(slingshot).toBeDefined();
    expect(bumper).toBeDefined();
    expect(rubber?.elasticity).toBeGreaterThan(wall.elasticity);
    expect(rubber?.elasticity).toBeLessThan(Q10_ONE);
    expect(rubber?.kick).toBe(0);
    // Slingshots and bumpers add energy rather than merely reflecting it.
    expect(slingshot?.elasticity).toBeLessThan(wall.elasticity);
    expect(bumper?.elasticity).toBeLessThan(wall.elasticity);
    expect(slingshot?.kick ?? 0).toBeGreaterThan(0);
    expect(bumper?.kick ?? 0).toBeGreaterThan(0);
  });

  it("marks every device preset provisional, because the map cannot encode them", () => {
    for (const preset of Object.values(DEVICE_PRESETS)) {
      expect(preset.confidence).toBe("provisional");
    }
  });
});
