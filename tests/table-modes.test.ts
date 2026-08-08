/**
 * The shipped mission layer, and the parser that refuses a broken one.
 *
 * The strongest assertions here are about the SHIPPED documents, because that
 * is where a decoding mistake would live: a mission whose script is missing, a
 * branch that lands between two instructions, an element index one past the end.
 * None of those is visible from the outside — the game runs, the mission simply
 * does the wrong thing — so they are checked mechanically on every one of the
 * three tables.
 */

import { describe, expect, it } from "vitest";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { TableModesDocument } from "../src/game/contracts.js";
import { parseTableModesDocument } from "../src/game/table-modes.js";
import { modesFor } from "./table-fixtures.js";

/** Selector missions the engine's own terminator word declares, per table. */
const DECLARED_SELECTOR_MISSIONS: Readonly<Record<string, number>> = {
  // `FF FE 00 08` at h4+0x310A. Eight, not the seventeen secondary sources claim.
  "law-n-justice": 8,
  // One table of five: the lock ladder, terminated by 0xFFFF.
  babewatch: 5,
  // Two tables: the six-mission selector and the five-stage jackpot ladder.
  "extreme-sports": 11,
};

/** The smallest document the parser will accept, as a base for mutation. */
function minimalDocument(): TableModesDocument {
  return {
    schema: "pinball-illusions/table-modes/v1",
    tableId: "law-n-justice",
    displayName: "Law 'n Justice",
    provenance: { sourceClass: "disk-derived-mode-scripts", description: "test", authorizationRequired: true },
    // The real table is dense from 0 to 31 and the parser insists on it, so the
    // fixture is dense too; only the entries these tests use are named.
    opcodes: Array.from({ length: 18 }, (_, index) => {
      const named: Readonly<Record<number, readonly [string, number, string]>> = {
        0: ["END", 2, ""],
        1: ["START", 6, "e"],
        5: ["AWARD", 6, "e"],
        9: ["MODE_START", 6, "s"],
        10: ["JMP", 4, "c"],
        17: ["MESSAGE", 6, "m"],
      };
      const entry = named[index] ?? ([`OP${index}`, 2, ""] as const);
      return { index, name: entry[0], length: entry[1], args: entry[2] };
    }),
    elements: [
      {
        index: 0,
        flags: 0,
        score: 5000,
        bonus: 0,
        effect: 0,
        countdown: -1,
        lampStart: false,
        lampAward: false,
        soundStart: false,
        soundAward: false,
        displayStart: -1,
        displayAward: -1,
        counter: -1,
      },
    ],
    messages: [
      // The geometry the machine's own `$73D0` reads out of the print record:
      // x, the panel scanline, the font and the alignment word.
      { index: 0, lines: ["HELLO"], layout: [{ x: 160, row: 2, font: 1, align: 2 }], holdTicks: 100, priority: 64, priority2: 0 },
    ],
    scripts: [
      {
        index: 0,
        ops: [
          { pc: 0, op: 1, args: [0] },
          { pc: 6, op: 0, args: [] },
        ],
      },
    ],
    missions: [
      { id: 1, selector: 0, selected: true, script: 0, launcher: 0, lamp: true, title: "TEST" },
    ],
    triggers: { devices: [{ level: 0, surfaceId: 32, script: 0 }], zones: [], locks: [] },
  } as unknown as TableModesDocument;
}

/** Deep-clones the minimal document so a mutation cannot leak between tests. */
function mutated(change: (doc: Record<string, unknown>) => void): TableModesDocument {
  const doc = JSON.parse(JSON.stringify(minimalDocument())) as Record<string, unknown>;
  change(doc);
  return doc as unknown as TableModesDocument;
}

describe("the shipped mission layer", () => {
  it("parses on all three tables and carries the missions the engine counts", () => {
    for (const tableId of TABLE_IDS) {
      const modes = modesFor(tableId);
      expect(modes.tableId).toBe(tableId);
      expect(modes.scripts.length, `${tableId} has no scripts`).toBeGreaterThan(0);
      expect(modes.elements.length, `${tableId} has no elements`).toBeGreaterThan(0);
      expect(modes.selectable.length, `${tableId} selector missions`).toBe(
        DECLARED_SELECTOR_MISSIONS[tableId],
      );
    }
  });

  it("names a real script for every mission, and a real mission for every launcher", () => {
    for (const tableId of TABLE_IDS) {
      const modes = modesFor(tableId);
      for (const mission of modes.missions) {
        expect(modes.scripts[mission.script], `${tableId} mission ${mission.id} script`).toBeDefined();
        if (mission.launcher >= 0) {
          expect(modes.scripts[mission.launcher], `${tableId} launcher`).toBeDefined();
        }
      }
    }
  });

  it("keeps every operand inside the pool its opcode names", () => {
    // The parser enforces this, so the test is really "the shipped documents get
    // through the parser without it having to reject anything" — but it is
    // asserted directly as well, because a parser check that is never exercised
    // by real data is a check nobody has tested.
    for (const tableId of TABLE_IDS) {
      const modes = modesFor(tableId);
      for (const script of modes.scripts) {
        const boundaries = new Set(script.ops.map((op) => op.pc));
        for (const op of script.ops) {
          const kinds = modes.opcodes[op.op]?.args ?? [];
          expect(op.args.length, `${tableId} script ${script.index} op ${op.op}`).toBe(kinds.length);
          for (const [at, kind] of kinds.entries()) {
            const value = op.args[at] ?? -1;
            if (kind === "e" && value >= 0) expect(modes.elements[value]).toBeDefined();
            if (kind === "s" && value >= 0) expect(modes.scripts[value]).toBeDefined();
            if (kind === "m" && value >= 0) expect(modes.messages[value]).toBeDefined();
            if (kind === "c" && value >= 0) {
              expect(boundaries.has(value), `${tableId} script ${script.index} branch`).toBe(true);
            }
          }
        }
      }
    }
  });

  it("binds every trigger to a script that exists", () => {
    for (const tableId of TABLE_IDS) {
      const modes = modesFor(tableId);
      let bound = 0;
      for (const level of [0, 1] as const) {
        for (let surfaceId = 32; surfaceId < 256; surfaceId += 1) {
          const script = modes.scriptForDevice(level, surfaceId);
          if (script < 0) continue;
          expect(modes.scripts[script]).toBeDefined();
          bound += 1;
        }
        for (let index = 0; index < 64; index += 1) {
          for (const script of [modes.scriptForZone(level, index), modes.scriptForLock(level, index)]) {
            if (script < 0) continue;
            expect(modes.scripts[script]).toBeDefined();
            bound += 1;
          }
        }
      }
      // Every table binds something, or nothing a ball does could start anything.
      expect(bound, `${tableId} has no physical bindings at all`).toBeGreaterThan(5);
    }
  });

  it("derives mode-arm elements that some physically bound script actually lights", () => {
    // The selector reconstruction hangs off this: if no bound script ever arms an
    // arm element, no mission can ever start on that table.
    for (const tableId of TABLE_IDS) {
      const modes = modesFor(tableId);
      expect(modes.armElements.length, `${tableId} has no arm elements`).toBeGreaterThan(0);

      const bound = new Set<number>();
      for (const level of [0, 1] as const) {
        for (let surfaceId = 32; surfaceId < 256; surfaceId += 1) {
          const script = modes.scriptForDevice(level, surfaceId);
          if (script >= 0) bound.add(script);
        }
        for (let index = 0; index < 64; index += 1) {
          const zone = modes.scriptForZone(level, index);
          if (zone >= 0) bound.add(zone);
          const lock = modes.scriptForLock(level, index);
          if (lock >= 0) bound.add(lock);
        }
      }
      const lights = [...bound].some((script) =>
        (modes.scripts[script]?.ops ?? []).some(
          (op) => (op.op === 1 || op.op === 2) && modes.armElements.includes(op.args[0] ?? -1),
        ),
      );
      expect(lights, `${tableId}: nothing a ball can hit arms a mode-arm element`).toBe(true);
    }
  });

  it("gives every mission a display banner where the original has one", () => {
    // Not every mode announces itself — the jackpot-ladder stages on Extreme
    // Sports share one — but the eight Law 'n Justice missions all do, and their
    // text is the original's, verbatim.
    const titles = modesFor("law-n-justice")
      .selectable.map((at) => modesFor("law-n-justice").missions[at]?.title ?? "")
      .filter((title) => title.length > 0);
    expect(titles).toContain("BLOW ALL BOMBS BEFORE TIMER REACHES ZERO");
    expect(titles).toContain("SHOOT ALL TERRORISTS TO FREE HOSTAGES");
    expect(titles.length).toBe(8);
  });
});

/**
 * THE THREE RESET BITS, pinned as literals off the disassembly.
 *
 * These are the sets the per-game reset at `main.seg00 +0x004052` and the
 * per-ball reset at `+0x003F80` walk out of the descriptor's element table at
 * descriptor +$3C. They are pinned as literals rather than recomputed, because
 * recomputing them from the same `flags` byte the source reads would test
 * nothing: an exporter that shipped the wrong byte would agree with itself.
 */
describe("the game-start and per-ball reset sets", () => {
  const LIT_AT_GAME_START: Readonly<Record<string, readonly number[]>> = {
    "law-n-justice": [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 18, 19, 20, 27, 39, 43, 53, 54, 55, 56, 57, 60,
      61, 62, 63, 64, 66, 67, 68, 69, 70, 71, 72, 73, 74, 82, 92, 93, 100, 109,
    ],
    babewatch: [
      0, 1, 2, 3, 4, 5, 6, 14, 15, 16, 17, 18, 19, 20, 28, 35, 36, 37, 56, 66, 68, 69, 70, 71,
      72, 74, 86, 87, 106, 108, 116, 123,
    ],
    "extreme-sports": [
      13, 21, 29, 30, 45, 46, 48, 49, 50, 73, 74, 75, 82, 85, 86, 87, 88, 89, 90, 91, 92, 93,
      94, 95, 97,
    ],
  };
  const KEEP_ARMED: Readonly<Record<string, readonly number[]>> = {
    "law-n-justice": [10, 11, 14, 21, 47, 65],
    babewatch: [
      7, 13, 21, 22, 23, 24, 25, 29, 30, 31, 59, 65, 67, 116, 117, 118, 119, 120, 121, 122, 124,
    ],
    "extreme-sports": [14, 58, 84, 96],
  };
  const KEEP_DONE: Readonly<Record<string, readonly number[]>> = {
    "law-n-justice": [9, 10, 13, 26],
    babewatch: [15, 56, 59, 65, 123],
    "extreme-sports": [12, 13, 82, 83],
  };

  for (const tableId of TABLE_IDS) {
    it(`${tableId}: flags bit 1 gives the elements armed at game start`, () => {
      expect(modesFor(tableId).litAtGameStart).toEqual(LIT_AT_GAME_START[tableId]);
    });

    it(`${tableId}: flags bits 0 and 5 give what survives a ball`, () => {
      expect(modesFor(tableId).keepArmedAcrossBall).toEqual(KEEP_ARMED[tableId]);
      expect(modesFor(tableId).keepDoneAcrossBall).toEqual(KEEP_DONE[tableId]);
    });
  }

  it("counts 43 / 32 / 25, which is what the reset walk arms", () => {
    expect(modesFor("law-n-justice").litAtGameStart.length).toBe(43);
    expect(modesFor("babewatch").litAtGameStart.length).toBe(32);
    expect(modesFor("extreme-sports").litAtGameStart.length).toBe(25);
  });

  it("lights exactly two inserts, both on BabeWatch: elements 15 and 56", () => {
    // Only an element that owns a START lamp at +$04 puts a light on the glass.
    // The film agrees: every insert is dark at the serve on Law 'n Justice and
    // Extreme Sports, and BabeWatch shows exactly two blinking.
    for (const tableId of TABLE_IDS) {
      const modes = modesFor(tableId);
      const withLamps = modes.litAtGameStart.filter(
        (index) => modes.elements[index]?.lampStart === true,
      );
      expect(withLamps, tableId).toEqual(tableId === "babewatch" ? [15, 56] : []);
    }
  });

  it("no longer arms BabeWatch's lock ladder, which was the census outlier", () => {
    // 21..25 and 29..31 have flags $01 and $09 — bit 1 clear in all of them.
    // The retired reconstruction armed 23, 25, 29, 30 and 31 at game start and
    // the first capture paid their own scores: 25,000,000 + 5,000,000 is the
    // whole of the 30,850,000 and 42,245,000 games the census kept finding.
    const lit = new Set(modesFor("babewatch").litAtGameStart);
    for (const element of [21, 22, 23, 24, 25, 29, 30, 31]) {
      expect(lit.has(element), `BabeWatch element ${element}`).toBe(false);
    }
  });
});

describe("the mission-layer parser refuses", () => {
  it("a document it does not know the schema of", () => {
    expect(() => parseTableModesDocument(mutated((doc) => { doc["schema"] = "nope"; }))).toThrow(
      /schema/,
    );
  });

  it("an unknown table", () => {
    expect(() => parseTableModesDocument(mutated((doc) => { doc["tableId"] = "pinball-dreams"; }))).toThrow(
      /tableId/,
    );
  });

  it("an element operand past the end of the element pool", () => {
    expect(() =>
      parseTableModesDocument(
        mutated((doc) => {
          (doc["scripts"] as { ops: { args: number[] }[] }[])[0]!.ops[0]!.args = [7];
        }),
      ),
    ).toThrow(/names element 7/);
  });

  it("a branch that lands between two instructions", () => {
    expect(() =>
      parseTableModesDocument(
        mutated((doc) => {
          const script = (doc["scripts"] as { ops: { pc: number; op: number; args: number[] }[] }[])[0]!;
          script.ops[0] = { pc: 0, op: 10, args: [3] };
        }),
      ),
    ).toThrow(/branches to/);
  });

  it("a mission whose script is not in the document", () => {
    expect(() =>
      parseTableModesDocument(
        mutated((doc) => {
          (doc["missions"] as { script: number }[])[0]!.script = 9;
        }),
      ),
    ).toThrow(/script/);
  });

  it("an opcode table with a hole in it", () => {
    expect(() =>
      parseTableModesDocument(
        mutated((doc) => {
          (doc["opcodes"] as { index: number }[])[1]!.index = 4;
        }),
      ),
    ).toThrow(/dense/);
  });

  it("two triggers claiming the same surface", () => {
    expect(() =>
      parseTableModesDocument(
        mutated((doc) => {
          const triggers = doc["triggers"] as { devices: unknown[] };
          triggers.devices.push({ level: 0, surfaceId: 32, script: 0 });
        }),
      ),
    ).toThrow(/twice/);
  });
});
