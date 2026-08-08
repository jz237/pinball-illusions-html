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
import { PANEL_HEIGHT, PANEL_WIDTH, currentPanelFrame } from "../src/browser/panel-renderer.js";
import { createPixelTarget } from "../src/browser/playfield-renderer.js";
import { parseTablePanelDocument } from "../src/game/table-panel.js";
import type { TablePanel, TablePanelDocument } from "../src/game/table-panel.js";
import { FONT_ATLAS_WIDTH, shellFontFrom } from "../src/game/shell-art.js";
import type { ShellFont } from "../src/game/shell-art.js";
import type { IndexedImage } from "../src/game/table-art.js";
import type { GameTickReport } from "../src/browser/game-loop.js";
import type { ModeMessage } from "../src/game/table-modes.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { TableId } from "../src/game/contracts.js";
import { modesFor } from "./table-fixtures.js";

const TABLES_DIR = fileURLToPath(new URL("../public/generated/tables/", import.meta.url));

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
): ModeMessage {
  return { index, lines, layout, holdTicks, priority, priority2 };
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
    // animation and live-value programs — and 35 more print and END on the same
    // frame, which is the machine re-posting a status screen by a route this
    // port has not decoded. Neither takes the strip.
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
      { top: "PLAYER 1", bottom: "BALL 1", score: 0 },
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
