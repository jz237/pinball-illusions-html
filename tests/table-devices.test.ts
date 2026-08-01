/**
 * The shipped scoring layer: the surface-id map, the device, bumper and
 * slingshot records, and the zone list.
 *
 * Two kinds of assertion here and they are labelled where it matters. The
 * PARSER contracts are ordinary unit tests on synthetic documents. The DATA
 * contracts are change detectors on numbers that came off the original's disks —
 * award values, device counts, zone rectangles — and they are change detectors
 * on purpose: nothing in this repository may quietly adjust a decoded value to
 * make a ball behave or a score look better. Re-decode the package if one has to
 * move.
 */

import { describe, expect, it } from "vitest";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { TableDevicesDocument, TableId } from "../src/game/contracts.js";
import {
  DEVICE_SLOTS,
  TABLE_DEVICES_SCHEMA,
  clearTableDevices,
  parseTableDevicesDocument,
  registerTableDevices,
  tableDevicesFor,
  tableDevicesUrl,
} from "../src/game/table-devices.js";
import type { TableDevices } from "../src/game/table-devices.js";
import { DEVICE_ID_BASE, isBumperId, isSlingshotId } from "../src/game/surface-physics.js";
import { devicesFor } from "./table-fixtures.js";

const TABLES: Record<TableId, TableDevices> = {
  "law-n-justice": devicesFor("law-n-justice"),
  babewatch: devicesFor("babewatch"),
  "extreme-sports": devicesFor("extreme-sports"),
};

describe("every shipped document parses", () => {
  it("loads all three tables with their own names", () => {
    for (const tableId of TABLE_IDS) {
      const devices = TABLES[tableId];
      expect(devices.tableId).toBe(tableId);
      expect(devices.displayName.length).toBeGreaterThan(0);
    }
  });

  it("names its own file", () => {
    expect(tableDevicesUrl("law-n-justice")).toBe("generated/tables/law-n-justice.devices.json");
  });
});

describe("the parser refuses a document it cannot trust", () => {
  const base = (): Record<string, unknown> => ({
    schema: TABLE_DEVICES_SCHEMA,
    tableId: "law-n-justice",
    displayName: "Law 'n Justice",
    width: 336,
    height: 600,
    devices: [],
    bumpers: [],
    slingshots: [],
    zones: [],
    surfaceIds: [
      Array.from({ length: 600 }, () => [335, 0]),
      Array.from({ length: 600 }, () => [335, 0]),
    ],
  });

  const parse = (doc: Record<string, unknown>): TableDevices =>
    parseTableDevicesDocument(doc as unknown as TableDevicesDocument);

  it("accepts a minimal well-formed document", () => {
    expect(parse(base()).devices).toHaveLength(0);
  });

  it("rejects the wrong schema, the wrong table and the wrong size", () => {
    expect(() => parse({ ...base(), schema: "something/else" })).toThrow(/schema/);
    expect(() => parse({ ...base(), tableId: "not-a-table" })).toThrow(/tableId/);
    expect(() => parse({ ...base(), width: 320 })).toThrow(/336x600/);
  });

  it("rejects a surface row that does not cover the whole width", () => {
    const doc = base();
    (doc["surfaceIds"] as number[][][])[0]![7] = [100, 5];
    expect(() => parse(doc)).toThrow(/stops at x=100/);
  });

  it("rejects a device whose slot disagrees with its surface id", () => {
    // The engine's index IS `id - 32`. A document that says otherwise would
    // award the wrong device, which is invisible from the outside.
    const doc = base();
    doc["devices"] = [
      { level: 0, index: 3, surfaceId: 40, kind: "target", score: 0, bonus: 0, repeatScore: 0 },
    ];
    expect(() => parse(doc)).toThrow(/index IS id - 32/);
  });

  it("rejects two devices in one slot of one level", () => {
    const doc = base();
    const entry = {
      level: 0,
      index: 0,
      surfaceId: 32,
      kind: "target",
      score: 0,
      bonus: 0,
      repeatScore: 0,
    };
    doc["devices"] = [entry, { ...entry }];
    expect(() => parse(doc)).toThrow(/two devices/);
  });
});

describe("the registry", () => {
  it("hands back what was registered and null for what was not", () => {
    clearTableDevices();
    expect(tableDevicesFor("babewatch")).toBeNull();
    registerTableDevices(TABLES["babewatch"]);
    expect(tableDevicesFor("babewatch")).toBe(TABLES["babewatch"]);
    // Left registered for the rest of the suite, which shares a module graph.
    for (const tableId of TABLE_IDS) registerTableDevices(TABLES[tableId]);
  });
});

describe("the surface-id map", () => {
  it("answers 0 outside the playfield rather than throwing", () => {
    const devices = TABLES["law-n-justice"];
    expect(devices.surfaceIdAt(0, -1, 10)).toBe(0);
    expect(devices.surfaceIdAt(0, 10, 600)).toBe(0);
    expect(devices.surfaceIdAt(1, 336, 10)).toBe(0);
  });

  it("puts every device id on pixels of the map, and every id on a level", () => {
    for (const tableId of TABLE_IDS) {
      const devices = TABLES[tableId];
      const present = new Set<number>();
      for (let level = 0 as 0 | 1; level <= 1; level = (level + 1) as 0 | 1) {
        for (let y = 0; y < 600; y += 1) {
          for (let x = 0; x < 336; x += 1) {
            const id = devices.surfaceIdAt(level, x, y);
            if (id >= DEVICE_ID_BASE) present.add(id);
          }
        }
        if (level === 1) break;
      }
      for (const device of devices.devices) {
        expect(present.has(device.surfaceId), `${tableId} id ${device.surfaceId}`).toBe(true);
      }
    }
  });

  it("indexes a device on the level its record was filed under, and only there", () => {
    // BabeWatch's id 41 is the case that forced this: its record is entry 9 of
    // the LOWER array while its pixels are on the UPPER collision line, so the
    // engine's dispatch reads a NULL and returns. Reproduced, not repaired.
    const babewatch = TABLES["babewatch"];
    expect(babewatch.deviceFor(0, 41)?.score).toBe(75000);
    expect(babewatch.deviceFor(1, 41)).toBeNull();
    const onUpper = (() => {
      for (let y = 0; y < 600; y += 1) {
        for (let x = 0; x < 336; x += 1) if (babewatch.surfaceIdAt(1, x, y) === 41) return true;
      }
      return false;
    })();
    expect(onUpper).toBe(true);
    expect(babewatch.deviceFor(1, 41)).toBeNull();
  });

  it("has no device outside the 160-long array the engine walks", () => {
    for (const tableId of TABLE_IDS) {
      for (const device of TABLES[tableId].devices) {
        expect(device.index).toBeGreaterThanOrEqual(0);
        expect(device.index).toBeLessThan(DEVICE_SLOTS);
      }
    }
  });
});

describe("the awards, exactly as they were read off the disks", () => {
  it("keeps Law 'n Justice's device chain", () => {
    const devices = TABLES["law-n-justice"];
    expect(devices.devices.map((d) => [d.surfaceId, d.kind, d.score])).toEqual([
      [32, "target", 50000],
      [33, "target", 50000],
      [34, "target", 75000],
      [35, "target", 75000],
      [36, "target", 75000],
      [128, "mode", 500000],
      [129, "mode", 500000],
    ]);
    expect(devices.bumpers.map((b) => b.score)).toEqual([50000, 50000, 50000]);
    expect(devices.slingshots.map((b) => b.score)).toEqual([25000, 25000]);
  });

  it("keeps BabeWatch's progressive bumpers, which no other table has", () => {
    expect(TABLES["babewatch"].bumpers.map((b) => b.score)).toEqual([10000, 20000, 40000]);
    expect(TABLES["extreme-sports"].bumpers.map((b) => b.score)).toEqual([
      50000, 50000, 50000, 50000,
    ]);
  });

  it("keeps the outlanes worth five times an inlane on every table", () => {
    // The shape of a pinball table's lane scoring, and it falls out of the data
    // rather than being imposed: 100,000 / 20,000 on Law 'n Justice and
    // 50,000 / 10,000 on the other two.
    const lanes = (tableId: TableId): number[] =>
      TABLES[tableId].zones
        .filter((z) => z.level === 0 && z.minY >= 445 && z.maxY <= 480 && z.score > 0)
        .map((z) => z.score);
    expect(lanes("law-n-justice")).toEqual([100000, 20000, 20000, 20000, 100000]);
    expect(lanes("extreme-sports")).toEqual([50000, 10000, 10000, 10000, 50000]);
  });

  it("finds a non-zero repeat award only where a flag byte makes it reachable", () => {
    // The repeat path is taken only when `bset` finds the player's bit already
    // set, so a record with no flag byte can never reach its repeat field. The
    // only reachable repeats in the whole corpus are BabeWatch's three top
    // rollovers, 50,000 then 5,000.
    const reachable: number[] = [];
    for (const tableId of TABLE_IDS) {
      const devices = TABLES[tableId];
      for (const record of [...devices.devices, ...devices.zones]) {
        if (record.repeatable && record.repeatScore > 0) reachable.push(record.repeatScore);
      }
    }
    expect(reachable).toEqual([5000, 5000, 5000]);
  });

  it("has no non-zero BONUS anywhere, on any table", () => {
    // A decisive negative and worth a test of its own: $6B96 is called all over
    // the engine but no shipped record puts anything in the bonus half. The
    // bonus ladder comes from the mission-script VM, which is not decoded.
    for (const tableId of TABLE_IDS) {
      const devices = TABLES[tableId];
      for (const record of [...devices.devices, ...devices.zones]) {
        expect(record.bonus, `${tableId} ${record.kind}`).toBe(0);
      }
    }
  });
});

describe("the level-change zones", () => {
  it("sends a ball up only from the lower list and down only from the upper", () => {
    // Self-proving, and it is the check that fixes the level labelling: nothing
    // forced it, and it holds on all three tables with no exceptions.
    for (const tableId of TABLE_IDS) {
      for (const zone of TABLES[tableId].zones) {
        if (zone.kind === "to-upper") expect(zone.level, `${tableId}`).toBe(0);
        if (zone.kind === "to-lower") expect(zone.level, `${tableId}`).toBe(1);
      }
    }
  });

  it("answers with the level a hand-off box sends the ball to", () => {
    const devices = TABLES["law-n-justice"];
    // The left ramp exit: a level-1 box 21 pixels on a side, where this project
    // previously had a three-column gate row that a ball could miss by a pixel.
    expect(devices.levelChangeAt(1, 35, 190)).toBe(0);
    expect(devices.levelChangeAt(1, 24, 190)).toBeNull();
    expect(devices.levelChangeAt(0, 35, 190)).toBeNull();
    // And a lower-level ramp mouth.
    expect(devices.levelChangeAt(0, 65, 140)).toBe(1);
  });

  it("answers null everywhere a trigger or a lock sits, so scoring is not routing", () => {
    for (const tableId of TABLE_IDS) {
      const devices = TABLES[tableId];
      for (const zone of devices.zones) {
        if (zone.kind === "to-upper" || zone.kind === "to-lower") continue;
        const x = Math.floor((zone.minX + zone.maxX) / 2);
        const y = Math.floor((zone.minY + zone.maxY) / 2);
        const change = devices.levelChangeAt(zone.level, x, y);
        // A hand-off box may legitimately overlap a trigger; what must never
        // happen is a hand-off being INVENTED by a scoring record.
        if (change !== null) {
          const overlapping = devices.zones.some(
            (other) =>
              (other.kind === "to-upper" || other.kind === "to-lower") &&
              other.level === zone.level &&
              x >= other.minX &&
              x <= other.maxX &&
              y >= other.minY &&
              y <= other.maxY,
          );
          expect(overlapping, `${tableId} ${zone.kind} ${zone.index}`).toBe(true);
        }
      }
    }
  });
});

describe("bumper and slingshot lookup", () => {
  it("resolves every id the surface map carries to a record", () => {
    for (const tableId of TABLE_IDS) {
      const devices = TABLES[tableId];
      const ids = new Set<number>();
      for (let level = 0; level <= 1; level += 1) {
        for (let y = 0; y < 600; y += 1) {
          for (let x = 0; x < 336; x += 1) {
            const id = devices.surfaceIdAt(level === 1 ? 1 : 0, x, y);
            if (isBumperId(id) || isSlingshotId(id)) ids.add(id);
          }
        }
      }
      expect(ids.size).toBeGreaterThan(0);
      for (const id of ids) {
        const record = isBumperId(id)
          ? devices.bumperFor(id - 15)
          : devices.slingshotFor(((id - 22) >> 1) + 1);
        expect(record, `${tableId} id ${id}`).not.toBeNull();
      }
    }
  });

  it("answers null for an index no record covers", () => {
    expect(TABLES["law-n-justice"].bumperFor(6)).toBeNull();
    expect(TABLES["law-n-justice"].slingshotFor(5)).toBeNull();
  });
});
