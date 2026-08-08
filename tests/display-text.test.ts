/**
 * THE MACHINE'S OWN CAPTIONS: the display records, and the panel that draws them.
 *
 * Two bugs stacked, and this is the test for both.
 *
 * FIRST, the exporter's display pool was MESSAGE-opcode operands only, and each
 * element's own `+$14` / `+$18` pointers were then resolved THROUGH that pool.
 * The three tables carry 229 element display pointers and exactly ONE used to
 * resolve — Law 'n Justice element 84's, and that only because script 168
 * happens to `MESSAGE` the same address. 228 pointers over 165 distinct records
 * shipped as -1. The fix is `modePools` seeding the pool from those pointers,
 * and it is a fix because the machine makes the identical call from all four
 * sites: `jsr $6C2C` with the record in A0, from 0x5A7A (START), 0x5AF6
 * (START_TIMED), 0x5CD6 (AWARD) and 0x5BC0 (the MESSAGE opcode's handler).
 *
 * SECOND, nothing drew any of it. `renderPanelInto` took the score, the bonus
 * and the PLAYER/BALL card; the only reader of `report.messages` in the whole
 * port was a debug HUD line whose own comment called itself instrumentation.
 *
 * Every geometry and timing number asserted here is read off the machine, not
 * chosen: `$73D0` (the ASCIIZ printer) takes `{x, row, font, align}` from the
 * print record and multiplies the row by the 40-byte panel stride; the display
 * interpreter at 0x6642 counts the hold down in `$23B6`, which opcode 7 sets to
 * `seconds x VBlankFrequency`, and refuses to count it at all while an
 * animation holds `$23C8`; and the poster's priority test at 0x6C4E decides
 * what a second record does to the first.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PanelDisplay } from "../src/browser/panel-display.js";
import {
  PANEL_HEIGHT,
  PANEL_WIDTH,
  currentPanelFrame,
  formatPanelFigure,
} from "../src/browser/panel-renderer.js";
import { createPixelTarget } from "../src/browser/playfield-renderer.js";
import { parseTablePanelDocument } from "../src/game/table-panel.js";
import type { TablePanel, TablePanelDocument } from "../src/game/table-panel.js";
import { FONT_ATLAS_WIDTH, shellFontFrom } from "../src/game/shell-art.js";
import type { ShellFont } from "../src/game/shell-art.js";
import type { IndexedImage } from "../src/game/table-art.js";
import type { DisplayValues, GameTickReport } from "../src/browser/game-loop.js";
import type { ModeMessage } from "../src/game/table-modes.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { TableId } from "../src/game/contracts.js";
import { modesFor } from "./table-fixtures.js";
import { parsePanelFontDocument } from "../src/game/panel-font.js";
import type { PanelFont, PanelFontDocument } from "../src/game/panel-font.js";

const TABLES_DIR = fileURLToPath(new URL("../public/generated/tables/", import.meta.url));
const GENERATED_DIR = fileURLToPath(new URL("../public/generated/", import.meta.url));

const PANEL: TablePanel = parseTablePanelDocument(
  JSON.parse(readFileSync(`${TABLES_DIR}law-n-justice.panel.json`, "utf8")) as TablePanelDocument,
);

/** A full-block font over the printable range, so any glyph marks the strip. */
function blockFont(): ShellFont {
  const metrics: number[][] = Array.from({ length: 256 }, () => [0, 0, 0]);
  for (let code = 32; code < 127; code += 1) metrics[code] = [6, 8, 0];
  const rows = metrics.reduce((sum, [, height = 0]) => sum + height, 0);
  const atlas: IndexedImage = {
    width: FONT_ATLAS_WIDTH,
    height: rows,
    indices: new Uint8Array(FONT_ATLAS_WIDTH * rows).fill(1),
    palette: new Uint8Array(0),
    paletteEntries: 0,
  };
  return shellFontFrom(metrics, atlas, "block");
}

const FONT = blockFont();

function reportAt(tick: number, over: Partial<GameTickReport> = {}): GameTickReport {
  return {
    tick,
    stepped: true,
    served: false,
    launched: false,
    drained: [],
    writtenOff: [],
    swallowed: [],
    locked: [],
    ejected: [],
    ejectedFrom: [],
    levelTransfers: [],
    multiballStarted: false,
    missionStarted: -1,
    missionEnded: false,
    awards: [],
    comboPaid: 0,
    elementStarts: [],
    elementAwards: [],
    messagesShown: [],
    musicCues: [],
    justTilted: false,
    gameOver: false,
    bonus: null,
    flipperRaised: [],
    flipperRested: [],
    displayValues: live(),
    ...over,
  };
}

function message(
  index: number,
  lines: string[],
  layout: { x: number; row: number; font: number; align: number }[],
  holdTicks: number,
  priority = 64,
  priority2 = 0,
  over: Partial<ModeMessage> = {},
): ModeMessage {
  return {
    index,
    lines,
    layout,
    values: [],
    latched: false,
    holdTicks,
    priority,
    priority2,
    ...over,
  };
}

/** A live-value channel with the fields a test wants and zeros elsewhere. */
function live(over: Partial<DisplayValues> = {}): DisplayValues {
  return {
    score: 0,
    missionSeconds: 0,
    counterAccumulators: [],
    counterSteps: [],
    counterCounts: [],
    rampValues: [],
    rampPaid: [],
    ...over,
  };
}

/**
 * Message indices the Law 'n Justice panel document wires NO animation objects
 * to, so a caption test is a test of the caption and not of the art queued
 * beside it. 73 of that table's 93 records do queue objects.
 */
const QUIET = 7;
const QUIET_THREE = [9, 10, 11] as const;

/** A pool of textless records, so an index can be addressed without wiring one. */
function blanks(count: number): ModeMessage[] {
  return Array.from({ length: count }, (_, index) => message(index, [], [], 0));
}

/** Which panel rows carry any lit pixel, and which columns, for a drawn strip. */
function marks(display: PanelDisplay): { rows: number[]; columns: number[] } {
  const target = display.renderInto(createPixelTarget(PANEL_WIDTH, PANEL_HEIGHT), 0, FONT);
  const rows: number[] = [];
  const columns = new Set<number>();
  for (let y = 0; y < PANEL_HEIGHT; y += 1) {
    let lit = false;
    for (let x = 0; x < PANEL_WIDTH; x += 1) {
      const at = (y * PANEL_WIDTH + x) * 4;
      // Anything that is not the unlit glass. `PANEL_UNLIT` is (26,12,4).
      if (target.data[at] !== 26 || target.data[at + 1] !== 12 || target.data[at + 2] !== 4) {
        lit = true;
        columns.add(x);
      }
    }
    if (lit) rows.push(y);
  }
  return { rows, columns: [...columns].sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

describe("the shipped display records", () => {
  it("resolves every element display pointer, where one used to resolve", () => {
    // The 229 element display pointers, by table. `probe-dropped.mjs` in
    // research/parity-ledger counted these off the packages and got the same
    // 84 / 78 / 67 with 1 / 0 / 0 resolving.
    const expected: Record<TableId, { pointers: number; records: number; pool: number }> = {
      "law-n-justice": { pointers: 84, records: 61, pool: 93 },
      "babewatch": { pointers: 78, records: 55, pool: 104 },
      "extreme-sports": { pointers: 67, records: 50, pool: 91 },
    };
    let pointers = 0;
    for (const tableId of TABLE_IDS) {
      const modes = modesFor(tableId);
      const named = new Set<number>();
      let count = 0;
      for (const element of modes.elements) {
        for (const field of [element.displayStart, element.displayAward]) {
          if (field < 0) continue;
          count += 1;
          named.add(field);
          // Resolving is not enough: it has to name a record in the pool.
          expect(modes.messages[field]).toBeDefined();
        }
      }
      expect({ pointers: count, records: named.size, pool: modes.messages.length }).toEqual(
        expected[tableId],
      );
      pointers += count;
    }
    expect(pointers).toBe(229);
  });

  it("carries the captions the machine shows on shots the player already takes", () => {
    // Read off the packages by research/display-text/decode-display.mjs, which
    // runs the machine's own display dispatch over all 288 records and walks
    // every one of them to a clean END. Each entry: table, element, which path,
    // and what `$73D0` prints.
    const cases: [TableId, number, "displayStart" | "displayAward", string[]][] = [
      ["babewatch", 65, "displayStart", ["THE CASINO IS OPEN"]],
      ["babewatch", 60, "displayAward", ["2ND GEAR"]],
      ["babewatch", 64, "displayAward", ["6TH GEAR"]],
      ["babewatch", 7, "displayStart", ["EXTRA BALL IS LIT"]],
      ["law-n-justice", 21, "displayStart", ["EXTRA BALL IS LIT"]],
      ["law-n-justice", 36, "displayStart", ["JACKPOT"]],
      ["law-n-justice", 44, "displayAward", ["BUMPER VALUE"]],
      ["law-n-justice", 82, "displayAward", ["HURRY UP"]],
      ["law-n-justice", 84, "displayAward", ["JAILBREAK BONUS"]],
      ["extreme-sports", 83, "displayStart", ["MODES ENABLED"]],
      ["extreme-sports", 33, "displayAward", ["SPLIT"]],
      ["extreme-sports", 37, "displayAward", ["LOOP"]],
      ["extreme-sports", 98, "displayStart", ["GATE SAVE ENABLED"]],
      ["extreme-sports", 99, "displayStart", ["SAVED BY THE GATE"]],
      ["extreme-sports", 51, "displayAward", ["STAGE COMPLETE"]],
    ];
    for (const [tableId, element, path, lines] of cases) {
      const modes = modesFor(tableId);
      const index = modes.elements[element]![path];
      expect(`${tableId} e${element} ${path}`).toBeTruthy();
      expect(index).toBeGreaterThanOrEqual(0);
      expect(modes.messages[index]!.lines).toEqual(lines);
    }
  });

  it("gives every line the geometry $73D0 reads, and every record a decoded hold", () => {
    for (const tableId of TABLE_IDS) {
      const modes = modesFor(tableId);
      for (const record of modes.messages) {
        // Index-parallel by construction: both come off the same TEXT op.
        expect(record.layout.length).toBe(record.lines.length);
        for (const line of record.layout) {
          // Every value in the shipped corpus, and they are the machine's:
          // a 320-px strip's columns, its own sixteen scanlines, six fonts
          // (h0+0x7136) and the three-way alignment test at 0x740A.
          expect(line.x).toBeLessThanOrEqual(320);
          expect(line.row).toBeLessThan(PANEL_HEIGHT);
          expect(line.font).toBeLessThan(6);
          expect([0, 1, 2]).toContain(line.align);
        }
      }
    }
  });

  it("puts its two text lines eight rows apart, exactly where the film measured them", () => {
    // Session 5 filmed the panel at native resolution and counted the pixels:
    // the caption on dot rows 2..6 and the figure on 10..14, a five-row font at
    // an eight-row pitch (research/hd/phase23/INDEX.txt section 1). The records'
    // own TEXT rows say the same thing from the other side: 0/2/4/5/6 for the
    // top line and 9 for the bottom, never anything between 7 and 8 and never
    // above 9.
    const rows = new Set<number>();
    for (const tableId of TABLE_IDS) {
      for (const record of modesFor(tableId).messages) {
        for (const line of record.layout) rows.add(line.row);
      }
    }
    expect([...rows].sort((a, b) => a - b)).toEqual([0, 2, 4, 5, 6, 9]);
  });

  it("holds a caption for the seconds its own program counts", () => {
    // BabeWatch's "KICKBACK ENABLED" is the corpus's commonest shape:
    //   SET_LOOP 2 / SOUND / TEXT / WAIT 10 / CLEAR_1 / WAIT 10 / LOOP /
    //   SOUND / TEXT / WAIT_SECONDS 1
    // Two flashes of 20 frames each plus a one-second hold is 90 ticks, and
    // that is what the exporter's unroll produces.
    const bw = modesFor("babewatch");
    const kickback = bw.messages.findIndex((one) => one.lines[0] === "KICKBACK ENABLED");
    expect(bw.messages[kickback]!.holdTicks).toBe(90);

    // And Extreme Sports' mission banners are the other shape: two TEXT
    // instructions and one `WAIT_SECONDS 3`, so three seconds flat.
    const es = modesFor("extreme-sports");
    const jump = es.messages.find((one) => one.lines[0] === "GIMME YOUR BEST")!;
    expect(jump.lines).toEqual(["GIMME YOUR BEST", "RUBBERBAND JUMP"]);
    expect(jump.holdTicks).toBe(150);
    expect(jump.layout.map((line) => line.row)).toEqual([2, 9]);
  });
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

describe("the panel draws the machine's captions", () => {
  it("places a line on the machine's own column and alignment", () => {
    // Three records, one per alignment, all with the same six-pixel-per-glyph
    // font so the columns are arithmetic: LEFT at x pens AT x, RIGHT pens at
    // x - width, CENTRE at x - width/2. That is 0x740A / 0x7410 / 0x7416.
    const at = (align: number): number => {
      const display = new PanelDisplay(PANEL, () => FONT, undefined, [
        ...blanks(QUIET),
        message(QUIET, ["AB"], [{ x: 100, row: 2, font: 1, align }], 50),
      ]);
      display.observe(reportAt(0, { messagesShown: [QUIET] }));
      return marks(display).columns[0]!;
    };
    expect(at(0)).toBe(100);
    expect(at(1)).toBe(100 - 12);
    expect(at(2)).toBe(100 - 6);
  });

  it("puts a row-2 line on the top half and a row-9 line on the bottom", () => {
    // The one place this port cannot match the machine and says so: its font is
    // eight rows where the machine's is five, so the machine's rows 2 and 9
    // become this strip's two halves. The PITCH is the machine's; the height
    // is not. See `PanelMessageView`.
    const display = new PanelDisplay(PANEL, () => FONT, undefined, [
      ...blanks(QUIET),
      message(
        QUIET,
        ["TOP", "BOTTOM"],
        [
          { x: 160, row: 2, font: 4, align: 2 },
          { x: 160, row: 9, font: 4, align: 2 },
        ],
        50,
      ),
    ]);
    display.observe(reportAt(0, { messagesShown: [QUIET] }));
    expect(marks(display).rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("holds for the record's own ticks and then gives the strip back", () => {
    const display = new PanelDisplay(PANEL, () => FONT, undefined, [
      ...blanks(QUIET),
      message(QUIET, ["HOLD"], [{ x: 0, row: 2, font: 1, align: 0 }], 3),
    ]);
    display.observe(reportAt(0, { messagesShown: [QUIET] }));
    // The caption is pinned to the left edge and the idle score view is
    // right-aligned at x=300, so the leftmost lit column says which is up
    // without asking the strip to be blank — it never is, the score is on it.
    expect(marks(display).columns[0]).toBe(0);
    for (let tick = 1; tick <= 3; tick += 1) {
      display.observe(reportAt(tick));
      expect(marks(display).columns[0]).toBe(0);
    }
    display.observe(reportAt(4));
    expect(marks(display).columns[0]).toBeGreaterThan(200);
  });

  it("waits behind an animation exactly as the interpreter's $23C8 test does", () => {
    // 0x664E: `tst.l $23C8(a5) / bne` — the hold does not age while an
    // ANIM_BLOCK is running, so within one record the art plays and the caption
    // follows. Law 'n Justice's message 4 queues objects 20 then 17; here the
    // same index also carries text, and the text must not appear until they
    // have finished.
    const wiring = PANEL.references.messages.find((one) => one.objects.length > 0)!;
    const ticks = wiring.objects.reduce((sum, id) => {
      const object = PANEL.objects[id]!;
      return sum + object.frames * object.speed;
    }, 0);
    expect(ticks).toBeGreaterThan(2);
    const records: ModeMessage[] = [];
    for (let index = 0; index <= wiring.message; index += 1) {
      records.push(message(index, [], [], 0));
    }
    records[wiring.message] = message(
      wiring.message,
      ["AFTER"],
      [{ x: 0, row: 2, font: 1, align: 0 }],
      4,
    );
    const display = new PanelDisplay(PANEL, () => FONT, undefined, records);
    display.observe(reportAt(0, { messagesShown: [wiring.message] }));
    // While the animation plays the caption is not on the strip AND its clock
    // has not started — so it is still there in full once the queue drains.
    for (let tick = 1; tick <= ticks; tick += 1) {
      // The art is what is on the strip: `renderPanelInto` draws the frame and
      // returns before it reaches the caption at all.
      expect(currentPanelFrame(display.state)).not.toBeNull();
      display.observe(reportAt(tick));
    }
    expect(display.idle).toBe(true);
    // ...and its four ticks of hold are all still there, unspent.
    expect(marks(display).columns[0]).toBe(0);
  });

  it("drops a lower-priority record and lets a higher one take the strip", () => {
    // 0x6C58: `cmp.b $23B2(a5),d0 / bcs -> drop / bhi -> flush and take over`.
    const [a, b, c] = QUIET_THREE;
    const records = blanks(Math.max(a, b, c) + 1);
    records[a] = message(a, ["HIGH"], [{ x: 8, row: 2, font: 1, align: 0 }], 100, 96);
    records[b] = message(b, ["LOW"], [{ x: 200, row: 2, font: 1, align: 0 }], 100, 32);
    records[c] = message(c, ["TOP"], [{ x: 260, row: 2, font: 1, align: 0 }], 100, 128);
    const display = new PanelDisplay(PANEL, () => FONT, undefined, records);
    display.observe(reportAt(0, { messagesShown: [a] }));
    expect(marks(display).columns[0]).toBe(8);
    // Lower primary: dropped outright, never shown.
    display.observe(reportAt(1, { messagesShown: [b] }));
    expect(marks(display).columns[0]).toBe(8);
    // Higher primary: takes the strip.
    display.observe(reportAt(2, { messagesShown: [c] }));
    expect(marks(display).columns[0]).toBe(260);
  });

  it("shows nothing for a record with no text and nothing for a zero hold", () => {
    // 114 of the 288 records print no words at all — they are the pure
    // animation programs — and a record whose hold is zero and whose latch bit
    // is clear prints and ENDs on the same frame with nothing to re-post it.
    // Neither takes the caption channel. (Every zero-hold record in the SHIPPED
    // corpus does carry the latch bit; see the latch tests below.)
    const [a, b] = QUIET_THREE;
    const records = blanks(Math.max(a, b) + 1);
    records[a] = message(a, [], [], 100);
    records[b] = message(b, ["NOW"], [{ x: 0, row: 2, font: 1, align: 0 }], 0);
    const display = new PanelDisplay(PANEL, () => FONT, undefined, records);
    display.observe(reportAt(0, { messagesShown: [a, b] }));
    // Nothing at the left edge: the strip is the idle score view.
    expect(marks(display).columns[0]).toBeGreaterThan(200);
  });

  it("keeps the bonus and the card above it, as the machine's own clears do", () => {
    const display = new PanelDisplay(PANEL, () => FONT, undefined, [
      ...blanks(QUIET),
      message(QUIET, ["UNDER"], [{ x: 0, row: 2, font: 1, align: 0 }], 100),
    ]);
    display.observe(reportAt(0, { messagesShown: [QUIET] }));
    const target = display.renderInto(
      createPixelTarget(PANEL_WIDTH, PANEL_HEIGHT),
      0,
      FONT,
      {
        lines: [
          { x: 0, row: 2, font: 4, align: 0, text: "PLAYER 1" },
          { x: 0, row: 8, font: 4, align: 0, text: "BALL 1" },
        ],
        score: 0,
      },
    );
    // The card's own top line starts at x=0 too, so the check is that the
    // BOTTOM half is written — the caption never writes there — which only the
    // card does.
    let bottom = 0;
    for (let y = 8; y < PANEL_HEIGHT; y += 1) {
      for (let x = 0; x < PANEL_WIDTH; x += 1) {
        const at = (y * PANEL_WIDTH + x) * 4;
        if (target.data[at] !== 26) bottom += 1;
      }
    }
    expect(bottom).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// THE LIVE-VALUE OPCODES
// ---------------------------------------------------------------------------

describe("the figures a display record prints", () => {
  it("names a decoded field for every live-value opcode but two, and says which", () => {
    // Six of the 26 display opcodes print a figure. Which field each one reads
    // is the address it points at, because both number printers read BACKWARDS
    // from the pointer: `$71BA` takes the six BCD bytes below it (0x72CA tests
    // `-$6(a0)`, 0x72D0 loads `-$4(a0)`) and `$716E` the word at `-$2(a0)`. So a
    // pointer is always one past the end of a record's value slot, and the
    // classification is exact rather than a guess.
    //
    // Counted off the packages by research/display-text/probe-values.mjs.
    const expected: Record<TableId, Record<string, number>> = {
      "law-n-justice": {
        counterAccumulator: 13,
        counterCount: 3,
        counterStep: 1,
        missionSeconds: 11,
        rampPaid: 6,
        rampValue: 2,
        score: 10,
        unknown: 2,
      },
      "babewatch": {
        counterStep: 13,
        elementScore: 5,
        missionSeconds: 10,
        rampPaid: 5,
        rampValue: 1,
        score: 7,
      },
      "extreme-sports": {
        counterAccumulator: 1,
        counterCount: 1,
        counterStep: 12,
        elementScore: 6,
        missionSeconds: 17,
        rampPaid: 6,
        rampValue: 8,
        score: 8,
      },
    };
    let unknown = 0;
    for (const tableId of TABLE_IDS) {
      const modes = modesFor(tableId);
      const histogram: Record<string, number> = {};
      for (const record of modes.messages) {
        for (const value of record.values) {
          histogram[value.source] = (histogram[value.source] ?? 0) + 1;
          if (value.source === "unknown") unknown += 1;
          // Every source that needs an index has one that reaches its pool.
          if (value.source === "counterAccumulator" || value.source === "counterStep") {
            expect(modes.counters[value.index]).toBeDefined();
          }
          if (value.source === "rampValue" || value.source === "rampPaid") {
            expect(modes.ramps[value.index]).toBeDefined();
          }
          if (value.source === "elementScore") {
            expect(modes.elements[value.index]?.score).toBe(value.value);
          }
        }
      }
      expect(histogram).toEqual(expected[tableId]);
    }
    // THE ONLY TWO THIS DECODE REFUSES, and they are the same field twice: Law
    // 'n Justice's "YOU SHOT 00 BAD GUYS" and "EXCELLENT" records print six
    // bytes of a NATIVE scratch record at h4+0x8900 that the table's own 68000
    // code at h4+0x85F8 clears and this port does not run. Approximating them
    // would be inventing a figure, so nothing is drawn for them.
    expect(unknown).toBe(2);
  });

  it("puts the figure the caption is about on the strip beside it", () => {
    // A "BUMPER VALUE"-shaped record: the caption on the machine's row 2 and
    // `counterAccumulator` on its row 9. The value's own x/row/font/align are
    // the four words after the opcode — `movem.w $6(a1),d3-d6`.
    const [a] = QUIET_THREE;
    const records = blanks(a + 1);
    records[a] = message(a, ["BUMPER VALUE"], [{ x: 160, row: 2, font: 4, align: 2 }], 100, 64, 0, {
      values: [
        { source: "counterAccumulator", index: 3, value: 0, x: 160, row: 9, font: 4, align: 2 },
      ],
    });
    const display = new PanelDisplay(PANEL, () => FONT, undefined, records);
    const counters = [0, 0, 0, 750_000];
    display.observe(
      reportAt(0, { messagesShown: [a], displayValues: live({ counterAccumulators: counters }) }),
    );
    const { rows } = marks(display);
    expect(rows.some((row) => row < 8), "the caption is on the top half").toBe(true);
    expect(rows.some((row) => row >= 8), "the figure is on the bottom half").toBe(true);
  });

  it("groups a figure in threes the way the machine's own comma does", () => {
    // 0x72E0's `lsr.l #$1,d7` on 0x24924924 sets the carry every third digit,
    // and glyph $0C is a COMMA because the character map at 0x743C is indexed
    // by `ASCII - $20`. The loop stops the moment the shifted value is zero
    // (0x72DE), so nothing is zero-padded and zero itself is one digit.
    expect(formatPanelFigure(0)).toBe("0");
    expect(formatPanelFigure(5)).toBe("5");
    expect(formatPanelFigure(999)).toBe("999");
    expect(formatPanelFigure(1_000)).toBe("1,000");
    expect(formatPanelFigure(3_197_500)).toBe("3,197,500");
    expect(formatPanelFigure(100_000_000)).toBe("100,000,000");
  });

  it("leaves an undecoded figure off the strip rather than drawing a zero", () => {
    const [a] = QUIET_THREE;
    const records = blanks(a + 1);
    records[a] = message(a, [], [], 100, 64, 0, {
      values: [{ source: "unknown", index: -1, value: 0, x: 160, row: 2, font: 4, align: 2 }],
    });
    const display = new PanelDisplay(PANEL, () => FONT, undefined, records);
    display.observe(reportAt(0, { messagesShown: [a] }));
    // Nothing but the idle score view, which lives at the right-hand edge.
    expect(marks(display).columns[0]).toBeGreaterThan(200);
  });

  it("reads a ring record's figure once and a latched record's every tick", () => {
    // The interpreter advances a ring record ONE INSTRUCTION A FRAME (0x66AC)
    // and what it drew stays in the bitplane; a LATCHED record's whole program
    // re-runs every frame (`bra 0x6700` at 0x6728, PC reset at 0x672A), so its
    // figures are live. Same value, two records, different answers.
    const [a, b] = QUIET_THREE;
    const value = { source: "counterStep" as const, index: 0, value: 0, x: 160, row: 2, font: 4, align: 1 };
    const records = blanks(Math.max(a, b) + 1);
    records[a] = message(a, [], [], 100, 64, 0, { values: [value] });
    records[b] = message(b, [], [], 0, 64, 0, { values: [value], latched: true });

    const steps = [1];
    const ring = new PanelDisplay(PANEL, () => FONT, undefined, records);
    ring.observe(reportAt(0, { messagesShown: [a], displayValues: live({ counterSteps: steps }) }));
    const ringBefore = marks(ring).columns.length;
    steps[0] = 1_000_000;
    ring.observe(reportAt(1, { displayValues: live({ counterSteps: steps }) }));
    expect(marks(ring).columns.length, "the ring record's figure is frozen").toBe(ringBefore);

    steps[0] = 1;
    const latched = new PanelDisplay(PANEL, () => FONT, undefined, records);
    latched.observe(
      reportAt(0, { messagesShown: [b], displayValues: live({ counterSteps: steps }) }),
    );
    const latchedBefore = marks(latched).columns.length;
    steps[0] = 1_000_000;
    latched.observe(reportAt(1, { displayValues: live({ counterSteps: steps }) }));
    expect(marks(latched).columns.length, "the latched record's figure is live").toBeGreaterThan(
      latchedBefore,
    );
  });
});

// ---------------------------------------------------------------------------
// THE LATCH — what re-posts a record whose hold is zero
// ---------------------------------------------------------------------------

describe("the latched record", () => {
  it("is exactly the set of shipped records whose hold is zero", () => {
    // MEASURED both ways over all three tables: of the records carrying words,
    // every one with a hold of zero has the latch bit and every one with the
    // latch bit has a hold of zero. Not one disagreement, which is what makes
    // "a hold of zero" a decoded fact rather than a shrug.
    // research/display-text/probe-latched.mjs.
    const expected: Record<TableId, { withWords: number; zero: number }> = {
      "law-n-justice": { withWords: 51, zero: 12 },
      "babewatch": { withWords: 63, zero: 6 },
      "extreme-sports": { withWords: 46, zero: 12 },
    };
    let zero = 0;
    for (const tableId of TABLE_IDS) {
      let withWords = 0;
      let zeroHold = 0;
      for (const record of modesFor(tableId).messages) {
        if (record.lines.length === 0) continue;
        withWords += 1;
        if (record.holdTicks === 0) zeroHold += 1;
        expect(
          record.holdTicks === 0,
          `${tableId} message ${record.index} [${record.lines.join(" | ")}]`,
        ).toBe(record.latched);
      }
      expect({ withWords, zero: zeroHold }).toEqual(expected[tableId]);
      zero += zeroHold;
    }
    expect(zero).toBe(30);
  });

  it("holds the strip until a ring record covers it, then comes back", () => {
    // 0x66E8: the latched path is reached only on a frame the ring has DRAINED,
    // so a message covers the status screen for its hold and the screen returns
    // when the hold runs out.
    const [a, b] = QUIET_THREE;
    const records = blanks(Math.max(a, b) + 1);
    records[a] = message(a, ["STATUS"], [{ x: 8, row: 2, font: 4, align: 0 }], 0, 64, 0, {
      latched: true,
    });
    records[b] = message(b, ["OVER"], [{ x: 260, row: 2, font: 4, align: 0 }], 3);
    const display = new PanelDisplay(PANEL, () => FONT, undefined, records);
    display.observe(reportAt(0, { messagesShown: [a] }));
    expect(marks(display).columns[0], "the status screen is up").toBe(8);
    display.observe(reportAt(1, { messagesShown: [b] }));
    expect(marks(display).columns[0], "the message covers it").toBe(260);
    for (let tick = 2; tick < 8; tick += 1) display.observe(reportAt(tick));
    expect(marks(display).columns[0], "and the status screen comes back").toBe(8);
  });

  it("goes away with the mode that put it up", () => {
    // `clr.l $23D0(a5)` at 0x584C and 0x5DB6, the two mission teardowns; the
    // other two are new game (0x404C) and ball start (0x41DE), which `reset` is.
    const [a] = QUIET_THREE;
    const records = blanks(a + 1);
    records[a] = message(a, ["STATUS"], [{ x: 8, row: 2, font: 4, align: 0 }], 0, 64, 0, {
      latched: true,
    });
    const display = new PanelDisplay(PANEL, () => FONT, undefined, records);
    display.observe(reportAt(0, { messagesShown: [a] }));
    expect(marks(display).columns[0]).toBe(8);
    display.observe(reportAt(1, { missionEnded: true }));
    expect(marks(display).columns[0]).toBeGreaterThan(200);

    display.observe(reportAt(2, { messagesShown: [a] }));
    expect(marks(display).columns[0]).toBe(8);
    display.reset();
    expect(marks(display).columns[0]).toBeGreaterThan(200);
  });

  it("never takes part in the caption channel's arbitration", () => {
    // 0x6C2C tests the latch bit BEFORE it loads either priority byte, so a
    // status screen neither drops a message nor is dropped by one.
    const [a, b] = QUIET_THREE;
    const records = blanks(Math.max(a, b) + 1);
    records[a] = message(a, ["MESSAGE"], [{ x: 260, row: 2, font: 4, align: 0 }], 100, 128);
    records[b] = message(b, ["STATUS"], [{ x: 8, row: 2, font: 4, align: 0 }], 0, 0, 0, {
      latched: true,
    });
    const display = new PanelDisplay(PANEL, () => FONT, undefined, records);
    display.observe(reportAt(0, { messagesShown: [a] }));
    // A primary of 0 against one of 128 would be dropped outright as a message.
    display.observe(reportAt(1, { messagesShown: [b] }));
    expect(marks(display).columns[0], "the message still owns the strip").toBe(260);
    for (let tick = 2; tick < 110; tick += 1) display.observe(reportAt(tick));
    expect(marks(display).columns[0], "and the status screen was latched anyway").toBe(8);
  });
});

// ---------------------------------------------------------------------------
// THE MACHINE'S OWN FACE ON THE MACHINE'S OWN ROWS
// ---------------------------------------------------------------------------

describe("the panel drawing captions in the machine's own font", () => {
  const PANEL_FONT: PanelFont = parsePanelFontDocument(
    JSON.parse(readFileSync(`${GENERATED_DIR}panel-font.json`, "utf8")) as PanelFontDocument,
    new Uint8Array(readFileSync(`${GENERATED_DIR}panel-font.bin`)),
  );

  function withFace(records: ModeMessage[]): PanelDisplay {
    const display = new PanelDisplay(PANEL, () => FONT, undefined, records);
    display.usePanelFont(() => PANEL_FONT);
    return display;
  }

  it("puts a row-2 caption on rows 2..6 and a row-9 figure on 9..13", () => {
    // The whole of item 3. The rows are the print record's own, `mulu.w #$28,d4`
    // multiplying them by the strip's 40-byte stride, and they land where they
    // land because font 4 is five rows tall rather than eight.
    const [a] = QUIET_THREE;
    const records = blanks(a + 1);
    records[a] = message(a, ["BUMPER VALUE"], [{ x: 160, row: 2, font: 4, align: 2 }], 100, 64, 0, {
      values: [
        { source: "counterAccumulator", index: 0, value: 0, x: 160, row: 9, font: 4, align: 2 },
      ],
    });
    const display = withFace(records);
    display.observe(
      reportAt(0, { messagesShown: [a], displayValues: live({ counterAccumulators: [750_000] }) }),
    );
    expect(marks(display).rows).toEqual([2, 3, 4, 5, 6, 9, 10, 11, 12, 13]);
  });

  it("still draws in the shell font when the face table has not arrived", () => {
    // A build that ships no derived assets has no panel font to fetch, and the
    // panel falls back to what it drew before: the shell face on the two halves.
    const [a] = QUIET_THREE;
    const records = blanks(a + 1);
    records[a] = message(a, ["BUMPER VALUE"], [{ x: 160, row: 2, font: 4, align: 2 }], 100);
    const display = new PanelDisplay(PANEL, () => FONT, undefined, records);
    display.observe(reportAt(0, { messagesShown: [a] }));
    const rows = marks(display).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row < 8)).toBe(true);
  });
});
