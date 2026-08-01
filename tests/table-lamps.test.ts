/**
 * The shipped LAMP LAYER documents and their loader.
 *
 * Three kinds of assertion, deliberately different in provenance:
 *
 *   1. THE SHIPPED DOCUMENTS AGREE WITH EVERYTHING ELSE SHIPPED. The wiring is
 *      dense over the modes document's element pool and its lamp-presence
 *      booleans match element by element; every mask pixel of every plane-7
 *      lamp sits on a bit-7-CLEAR index of the shipped artwork — the invariant
 *      the whole render model stands on (the artwork stores every insert LIT;
 *      OFF is `index | 0x80` into the upper palette half).
 *   2. DECODED POSITIONS MATCH THE INDEPENDENT DECODE. The lamp chain was
 *      decoded twice — once by the research tooling that disassembled the draw
 *      routines, once by the exporter — and a handful of its hard numbers are
 *      pinned here (the SHOOT JAIL arrow, the jail lock lamp, the shoot-again
 *      badge) so a regression in either shows up as a coordinate, not a vibe.
 *   3. THE PARSER REFUSES what it does not fully understand, like every other
 *      loader in this project.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TABLE_LAMPS_SCHEMA,
  clearTableLamps,
  loadTableLamps,
  parseTableLampsDocument,
  registerTableLamps,
  tableLampsFor,
  tableLampsUrl,
} from "../src/game/table-lamps.js";
import type { TableLamps } from "../src/game/table-lamps.js";
import { decodeIndexedPng, tableArtFrom } from "../src/game/table-art.js";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH, TABLE_IDS } from "../src/game/contracts.js";
import type { TableId, TableLampsDocument } from "../src/game/contracts.js";
import { lampsFor, modesFor } from "./table-fixtures.js";

const TABLES_DIR = fileURLToPath(new URL("../public/generated/tables/", import.meta.url));

function shippedDocument(tableId: TableId): TableLampsDocument {
  return JSON.parse(
    readFileSync(`${TABLES_DIR}${tableId}.lamps.json`, "utf8"),
  ) as TableLampsDocument;
}

async function shippedArt(tableId: TableId) {
  const bytes = readFileSync(`${TABLES_DIR}${tableId}.art.png`);
  return tableArtFrom(tableId, await decodeIndexedPng(new Uint8Array(bytes)));
}

describe("the shipped lamp documents", () => {
  it("parse for every table and declare the gated provenance class", () => {
    for (const tableId of TABLE_IDS) {
      const doc = shippedDocument(tableId);
      expect(doc.provenance.sourceClass).toBe("disk-derived-lamp-overlays");
      expect(doc.provenance.authorizationRequired).toBe(true);
      const lamps = parseTableLampsDocument(doc);
      expect(lamps.tableId).toBe(tableId);
      expect(lamps.lamps.length).toBeGreaterThan(30);
      // MEASURED: the START handler writes 8 into the blink reload byte.
      expect(lamps.blinkHalfPeriodFrames).toBe(8);
    }
  });

  it("carry the decoded inventory: 39 / 42 / 37 lamps, six masked on extreme-sports", () => {
    const counts = new Map<TableId, { total: number; masked: number; none: number }>([
      ["law-n-justice", { total: 39, masked: 0, none: 1 }],
      ["babewatch", { total: 42, masked: 0, none: 0 }],
      ["extreme-sports", { total: 37, masked: 6, none: 0 }],
    ]);
    for (const tableId of TABLE_IDS) {
      const lamps = lampsFor(tableId);
      const expected = counts.get(tableId);
      expect(lamps.lamps.length).toBe(expected?.total);
      expect(lamps.lamps.filter((lamp) => lamp.kind === "masked").length).toBe(expected?.masked);
      expect(lamps.lamps.filter((lamp) => lamp.kind === "none").length).toBe(expected?.none);
    }
  });

  it("wire the element pool densely and in agreement with the modes document", () => {
    for (const tableId of TABLE_IDS) {
      const lamps = lampsFor(tableId);
      const modes = modesFor(tableId);
      expect(lamps.elements.length).toBe(modes.elements.length);
      for (const [index, wiring] of lamps.elements.entries()) {
        // The exporter proves presence against the package; here the two
        // SHIPPED documents are held to agree with each other.
        expect(wiring.start >= 0).toBe(modes.elements[index]?.lampStart ?? false);
        expect(wiring.award >= 0).toBe(modes.elements[index]?.lampAward ?? false);
      }
    }
  });

  it("keep every drawable lamp inside the playfield with a well-formed mask", () => {
    for (const tableId of TABLE_IDS) {
      for (const lamp of lampsFor(tableId).lamps) {
        if (lamp.kind === "none") continue;
        expect(lamp.x + lamp.width).toBeLessThanOrEqual(PLAYFIELD_WIDTH);
        expect(lamp.y + lamp.height).toBeLessThanOrEqual(PLAYFIELD_HEIGHT);
        expect(lamp.mask.length).toBe((lamp.width / 8) * lamp.height);
        expect(lamp.mask.some((byte) => byte !== 0)).toBe(true);
        if (lamp.kind === "masked") {
          expect(lamp.off?.length).toBe(lamp.width * lamp.height);
          expect(lamp.on?.length).toBe(lamp.width * lamp.height);
        } else {
          expect(lamp.off).toBeNull();
          expect(lamp.on).toBeNull();
        }
      }
    }
  });

  it("agree with the independent research decode on pinned positions", () => {
    const lamps = lampsFor("law-n-justice");
    // The SHOOT JAIL arrow insert every jail mission arms: lamp at (110,217),
    // 16x28, decoded independently from the draw-routine disassembly.
    expect(
      lamps.lamps.some(
        (lamp) => lamp.x === 110 && lamp.y === 217 && lamp.width === 16 && lamp.height === 28,
      ),
    ).toBe(true);
    // The jail multiball LOCK-LIT lamp at (68,305), 16x28.
    expect(
      lamps.lamps.some(
        (lamp) => lamp.x === 68 && lamp.y === 305 && lamp.width === 16 && lamp.height === 28,
      ),
    ).toBe(true);
    // ARREST AGAIN, the police-badge shoot-again lamp: 32x43 at (127,550).
    expect(
      lamps.lamps.some(
        (lamp) => lamp.x === 127 && lamp.y === 550 && lamp.width === 32 && lamp.height === 43,
      ),
    ).toBe(true);
  });

  it("holds the lit-artwork invariant: every plane-7 mask pixel is bit-7-clear art", async () => {
    for (const tableId of TABLE_IDS) {
      const art = await shippedArt(tableId);
      let pixels = 0;
      for (const lamp of lampsFor(tableId).lamps) {
        if (lamp.kind !== "plane7") continue;
        const rowBytes = lamp.width / 8;
        for (let py = 0; py < lamp.height; py += 1) {
          for (let px = 0; px < lamp.width; px += 1) {
            const byte = lamp.mask[py * rowBytes + (px >> 3)] ?? 0;
            if ((byte & (0x80 >> (px & 7))) === 0) continue;
            pixels += 1;
            const index = art.indices[(lamp.y + py) * art.width + lamp.x + px] ?? 0;
            expect(index & 0x80).toBe(0);
          }
        }
      }
      // ~11,000 pixels per table take part; a mask that matched nothing would
      // pass the loop above by never asserting.
      expect(pixels).toBeGreaterThan(9000);
    }
  });
});

describe("the parser's refusals", () => {
  const base = shippedDocument("law-n-justice");

  it("refuses a wrong schema", () => {
    expect(() =>
      parseTableLampsDocument({ ...base, schema: "pinball-illusions/table-lamps/v0" } as never),
    ).toThrow(/schema/);
    expect(TABLE_LAMPS_SCHEMA).toBe("pinball-illusions/table-lamps/v1");
  });

  it("refuses a mask whose bytes do not match the declared shape", () => {
    const lamps = structuredClone(base.lamps) as Record<string, unknown>[];
    const victim = lamps.find((lamp) => lamp["kind"] === "plane7");
    expect(victim).toBeDefined();
    if (victim !== undefined) victim["mask"] = "AAAA";
    expect(() => parseTableLampsDocument({ ...base, lamps } as never)).toThrow(/decodes to/);
  });

  it("refuses a non-dense lamp list and out-of-range wiring", () => {
    const reversed = structuredClone(base.lamps).slice().reverse();
    expect(() => parseTableLampsDocument({ ...base, lamps: reversed } as never)).toThrow(/dense/);

    const elements = structuredClone(base.elements) as Record<string, unknown>[];
    elements[0] = { start: base.lamps.length, award: -1 };
    expect(() => parseTableLampsDocument({ ...base, elements } as never)).toThrow(/start lamp/);
  });
});

describe("the registry and the loader", () => {
  it("registers, answers and clears", () => {
    clearTableLamps();
    expect(tableLampsFor("law-n-justice")).toBeNull();
    const lamps = lampsFor("law-n-justice");
    registerTableLamps(lamps);
    expect(tableLampsFor("law-n-justice")).toBe(lamps);
    clearTableLamps();
    expect(tableLampsFor("law-n-justice")).toBeNull();
  });

  it("loads through a fetch and registers the result", async () => {
    clearTableLamps();
    const doc = shippedDocument("babewatch");
    const fetched: string[] = [];
    const loaded: TableLamps = await loadTableLamps("babewatch", (url) => {
      fetched.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(doc),
      });
    });
    expect(fetched).toEqual([tableLampsUrl("babewatch")]);
    expect(loaded.tableId).toBe("babewatch");
    expect(tableLampsFor("babewatch")).toBe(loaded);
    clearTableLamps();
  });

  it("throws on a failed fetch", async () => {
    await expect(
      loadTableLamps("law-n-justice", () =>
        Promise.resolve({
          ok: false,
          status: 404,
          statusText: "Not Found",
          json: () => Promise.resolve({}),
        }),
      ),
    ).rejects.toThrow(/404/);
  });
});
