/**
 * THE MACHINE'S OWN PANEL FONT — the six faces at main hunk 0 +0x7136, and the
 * printer that lays them out.
 *
 * Until this round the port set its captions in the FRONT DOOR's font, which is
 * eight rows tall, so a display record's rows 2 and 9 had to be collapsed onto
 * the strip's two eight-row halves and every caption sat two rows high. The
 * machine's own caption face is FIVE rows — font 4's BLTSIZE word is 0x140,
 * which is 5 << 6 — and five rows at row 2 is dot rows 2..6, which is where the
 * HD round counted it on native-resolution stills.
 *
 * Everything asserted here is read off the machine:
 *
 *   0071BC / 0073E4  movem.l (0x7136,PC,d5.w*8),a1-a2   the six-entry table
 *   007474           lea (4,a1,d0.w*2),a4               glyph g at word column g
 *   00747C           move.b $60(a2,d0.w),d2             its width in pixels
 *   0074D4           addq.w #$2,d3                      two pixels of tracking
 *   00743C           move.b (a2,d0.w),d0                the map is ASCII - $20
 *   00742E-007452                                       the measure loop
 *   007404-00742C                                       the three alignments
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PANEL_FONT_STRIP_ROWS,
  PANEL_FONT_STRIP_WIDTH,
  measurePanelText,
  panelFace,
  panelGlyphPixel,
  panelTextPen,
  panelTextRun,
  parsePanelFontDocument,
} from "../src/game/panel-font.js";
import type { PanelFont, PanelFontDocument } from "../src/game/panel-font.js";

const GENERATED = fileURLToPath(new URL("../public/generated/", import.meta.url));

const RAW = JSON.parse(readFileSync(`${GENERATED}panel-font.json`, "utf8")) as PanelFontDocument & {
  data: { file: string; sha256: string; byteLength: number }[];
  fonts: { source: { bitmap: number; metrics: number } }[];
};
const DATA = new Uint8Array(readFileSync(`${GENERATED}panel-font.bin`));
const FONT: PanelFont = parsePanelFontDocument(RAW, DATA);

/** Renders one string into a strip-shaped bitmap, the way the panel does. */
function stamp(faceIndex: number, text: string, x: number, row: number, align: number): boolean[][] {
  const face = panelFace(FONT, faceIndex);
  const grid = Array.from({ length: PANEL_FONT_STRIP_ROWS }, () =>
    Array.from({ length: PANEL_FONT_STRIP_WIDTH }, () => false),
  );
  const pen = panelTextPen(face, text, x, align);
  if (pen === null) return grid;
  for (const run of panelTextRun(face, text, pen)) {
    for (let line = 0; line < face.height; line += 1) {
      const y = row + line;
      if (y < 0 || y >= PANEL_FONT_STRIP_ROWS) continue;
      for (let column = 0; column < run.width; column += 1) {
        const px = run.pen + column;
        if (px < 0 || px >= PANEL_FONT_STRIP_WIDTH) continue;
        if (panelGlyphPixel(face, run.glyph, column, line)) grid[y]![px] = true;
      }
    }
  }
  return grid;
}

const litRows = (grid: boolean[][]): number[] =>
  grid.flatMap((row, y) => (row.some(Boolean) ? [y] : []));

describe("the panel font table", () => {
  it("is the machine's six faces at the addresses the two printers name", () => {
    // Read out of the package by research/display-text/probe-font.mjs. The
    // table base is 0x7136 both times, which is `PC - 0x8A` at 0x71C0 and
    // `PC - 0x2B2` at 0x73E8 — the PC being the EXTENSION word, which in MOVEM
    // comes after the register mask.
    const expected = [
      { bitmap: 0x1400, metrics: 0xcd54, height: 15, glyphs: 47 },
      { bitmap: 0x1986, metrics: 0xcd54, height: 12, glyphs: 47 },
      { bitmap: 0x1df2, metrics: 0xcde6, height: 15, glyphs: 42 },
      { bitmap: 0x22e2, metrics: 0xcde6, height: 12, glyphs: 42 },
      { bitmap: 0x26d6, metrics: 0xce72, height: 5, glyphs: 39 },
      { bitmap: 0x26d6, metrics: 0xce72, height: 5, glyphs: 39 },
    ];
    expect(RAW.fonts.length).toBe(6);
    for (const [index, want] of expected.entries()) {
      const font = RAW.fonts[index]!;
      expect({
        bitmap: font.source.bitmap,
        metrics: font.source.metrics,
        height: FONT.faces[index]!.height,
        glyphs: FONT.faces[index]!.widths.length,
      }).toEqual(want);
    }
  });

  it("has a FIVE-ROW caption face, which is why a caption used to sit two rows high", () => {
    // The one number this whole item turns on. Font 4 is the face nearly every
    // shipped print record names, and 5 rows at row 2 is rows 2..6.
    expect(FONT.faces[4]!.height).toBe(5);
    expect(litRows(stamp(4, "JACKPOT", 160, 2, 2))).toEqual([2, 3, 4, 5, 6]);
    // And its second line, on the records' own row 9, clears the first.
    expect(litRows(stamp(4, "1,000,000", 160, 9, 2))).toEqual([9, 10, 11, 12, 13]);
  });

  it("draws two lines at rows 2 and 9 without them touching", () => {
    const top = stamp(4, "BUMPER VALUE", 160, 2, 2);
    const bottom = stamp(4, "750,000", 160, 9, 2);
    for (let y = 0; y < PANEL_FONT_STRIP_ROWS; y += 1) {
      for (let x = 0; x < PANEL_FONT_STRIP_WIDTH; x += 1) {
        expect(top[y]![x] && bottom[y]![x]).toBe(false);
      }
    }
    expect(litRows(top)).toEqual([2, 3, 4, 5, 6]);
    expect(litRows(bottom)).toEqual([9, 10, 11, 12, 13]);
  });

  it("keeps every face inside the sixteen rows it is drawn on", () => {
    // Font 0 is fifteen rows and the one record that uses it puts it on row 0;
    // font 1 is twelve on row 2. Both fit, and that they do is the check that
    // the heights are read right.
    expect(litRows(stamp(0, "0", 8, 0, 0))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(litRows(stamp(1, "0", 8, 2, 0)).at(-1)).toBe(13);
  });

  it("measures a string the way 0x742E does, starting at minus two", () => {
    // `moveq #$FE,d1` then `+2 + width` a glyph, so the trailing tracking of the
    // last glyph is not counted.
    const face = panelFace(FONT, 4);
    const widthOf = (code: string): number => face.widths[face.map[code.charCodeAt(0) - 0x20]!]!;
    expect(measurePanelText(face, "")).toBe(-2);
    expect(measurePanelText(face, "0")).toBe(widthOf("0"));
    expect(measurePanelText(face, "00")).toBe(2 * widthOf("0") + 2);
    // A character the map refuses costs the blank advance and no tracking.
    expect(measurePanelText(face, " ")).toBe(face.blank - 2);
  });

  it("puts the pen where the three alignments put it, and bails on a negative", () => {
    const face = panelFace(FONT, 4);
    const width = measurePanelText(face, "JACKPOT");
    expect(panelTextPen(face, "JACKPOT", 40, 0)).toBe(40);
    expect(panelTextPen(face, "JACKPOT", 300, 1)).toBe(300 - width);
    expect(panelTextPen(face, "JACKPOT", 160, 2)).toBe(160 - (((width >> 1) + 1) & 0xfffe));
    // 0x7422 / 0x742A: `bmi -> bail`, so a string too wide for its anchor is
    // not clamped to the left edge, it is not drawn at all.
    expect(panelTextPen(face, "JACKPOT", 4, 1)).toBeNull();
  });

  it("advances by the glyph's own width plus two, never by a fixed cell", () => {
    // 0x7480 `add.w d2,d3` then 0x74D4 `addq.w #$2,d3`. Font 0's comma is four
    // pixels and its `M` is twenty-two, so a fixed advance would be visible.
    const face = panelFace(FONT, 0);
    const run = panelTextRun(face, "M,M", 0);
    expect(run.map((glyph) => glyph.width)).toEqual([22, 4, 22]);
    expect(run.map((glyph) => glyph.pen)).toEqual([0, 24, 30]);
  });

  it("maps characters by ASCII minus $20, which is what makes $0C a comma", () => {
    // `subi.w #$20,d0 / move.b (a2,d0.w),d0` at 0x7438. The number printer's
    // separator is `move.b #$C,d0` — index $0C — and $0C + $20 is $2C.
    for (const face of FONT.faces) {
      expect(face.map[",".charCodeAt(0) - 0x20]).toBeGreaterThanOrEqual(0);
      expect(face.map[" ".charCodeAt(0) - 0x20]).toBeLessThan(0);
      // Every digit and every capital is present on all six faces.
      for (const code of "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        expect(face.map[code.charCodeAt(0) - 0x20], `${code} on face ${face.index}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("refuses a document whose block header does not match its manifest", () => {
    // The two header words travel with the bitmap so the block stays a verbatim
    // copy; disagreeing with them means the offsets are wrong, and a font that
    // is one word out draws a different alphabet.
    const broken = new Uint8Array(DATA);
    broken[0] = (broken[0] ?? 0) ^ 0xff;
    expect(() => parsePanelFontDocument(RAW, broken)).toThrow(/block header/);
  });

  it("refuses a document that is not six faces on a 320x16 strip", () => {
    expect(() =>
      parsePanelFontDocument({ ...RAW, fonts: RAW.fonts.slice(0, 4) } as PanelFontDocument, DATA),
    ).toThrow(/six/);
    expect(() =>
      parsePanelFontDocument({ ...RAW, strip: { width: 336, rows: 16 } } as PanelFontDocument, DATA),
    ).toThrow(/320x16/);
  });
});
