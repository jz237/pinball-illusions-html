// Decodes THE SCORE PANEL'S OWN FONTS out of `main.bin` into the shipped asset
// set under public/generated/panel-font.json + panel-font.bin. Run locally,
// where the operator's own disks live; the binary block and the manifest it
// writes are what ship.
//
// Usage:  node scripts/export-panel-font.mjs <segment-dir> [out-dir] [--check]
//   <segment-dir> holds the seg_clean split of main.bin
//   (`main.bin.seg00.bin` .. , each `u32 body length` + body + relocations).
//   --check decodes and compares against what is already in <out-dir>.
//
// ---------------------------------------------------------------------------
// WHERE THE TABLE IS
// ---------------------------------------------------------------------------
// SIX entries of `{bitmap.l, metrics.l}` at h0+0x7136, indexed by the print
// record's FONT word. Both readers spell the same base out:
//
//     0071BC  movem.l (0x7136,PC,d5.w*8),a1-a2     ; the NUMBER printer
//     0073E4  movem.l (0x7136,PC,d5.w*8),a1-a2     ; the ASCIIZ printer
//
// Both are full-format PC-relative extensions (`5720`, scale 8, word base
// displacement) and in MOVEM the register mask comes BEFORE the extension word,
// so the PC in the effective address is 0x71C0 / 0x73E8 and both give
// 0x71C0-0x8A = 0x73E8-0x2B2 = 0x7136. a1 is the BITMAP (main hunk 5, which is
// also where the panel's own three bitplanes live, at h5+0x500/0x780/0xA00) and
// a2 the METRICS (hunk 0).
//
// ---------------------------------------------------------------------------
// THE BITMAP
// ---------------------------------------------------------------------------
//     007474  lea     (4,a1,d0.w*2),a4   ; glyph d0's first word
//     00747C  move.b  $60(a2,d0.w),d2    ; its WIDTH IN PIXELS
//     007494  move.w  $0(a1),d0 / sub.w d2,d0 / add.w d0,d0   -> BLTAMOD
//     0074B6  add.w   $2(a1),d2          -> BLTSIZE = (height << 6) | words
//
// so +$0 is the bitmap's row stride IN WORDS, +$2 is `height * 64`, +$4 starts
// the bits, and glyph g lives at WORD COLUMN g of one wide single-bitplane
// strip. `lea (4,a1,d0.w*2),a4` is the instruction Capstone mis-prints: the raw
// bytes are `49f1 0204`, whose brief extension `0204` carries scale bits `01`,
// and Capstone drops index scaling. Every scaled address in this decode was
// read out of the raw bytes for that reason.
//
// ---------------------------------------------------------------------------
// THE METRICS
// ---------------------------------------------------------------------------
//     00743C  move.b  (a2,d0.w),d0       ; d0 = ASCII - $20  -> the GLYPH INDEX
//     007440  bmi     -> add.w -$2(a2),d3 ; a NEGATIVE entry is a blank advance
//     007444  move.b  $60(a2,d0.w),d2    ; the glyph's width
//     0074D4  addq.w  #$2,d3             ; and two pixels of tracking after it
//
// so -$2 is the blank advance, +$00..$5F maps ASCII $20..$7F to a glyph, and
// +$60 onwards are the glyph widths. That the map is `ASCII - $20` is what
// identifies the number printer's separator: `move.b #$C,d0` at 0x72E4 is
// character $2C, a COMMA, so the machine prints 3,197,500 and so does the port.
//
// ---------------------------------------------------------------------------
// WHAT THE SIX ARE
// ---------------------------------------------------------------------------
// | font | bitmap    | metrics   | height | cell | used by the mode corpus at |
// |-----:|-----------|-----------|-------:|-----:|----------------------------|
// | 0    | h5+0x1400 | h0+0xCD54 | 15     | 16px | row 0 (one site)           |
// | 1    | h5+0x1986 | h0+0xCD54 | 12     | 16px | rows 2 and 3               |
// | 2    | h5+0x1DF2 | h0+0xCDE6 | 15     | 12px | never                      |
// | 3    | h5+0x22E2 | h0+0xCDE6 | 12     | 12px | row 2                      |
// | 4    | h5+0x26D6 | h0+0xCE72 | **5**  | 12px | rows 2, 4, 5, 6 and 9      |
// | 5    | h5+0x26D6 | h0+0xCE72 | 5      | 12px | never (same bytes as 4)    |
//
// FONT 4 IS THE FIVE-ROW PANEL FONT the HD round measured from the other side:
// its `+$2` is 0x140, which is 5 << 6, and 5 rows at row 2 is dot rows 2..6 —
// the rows session 5 counted in research/hd/phase23/INDEX.txt §1. Its glyphs
// are twelve pixels wide and DITHERED `#.` horizontally, which is the DMD's own
// two-pixels-to-a-dot: 12 px is six dots, and 160 dots is 320 px.
//
// Only fonts 0, 1, 3 and 4 are named by any shipped print record, and 5 is byte
// for byte 4. All six ship anyway, because the table is what the machine
// indexes and a document that carried four of six would be a document with a
// hole in it.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadPackage, follow } from "./export-table-modes.mjs";

const MANIFEST_FILE = "panel-font.json";
const DATA_FILE = "panel-font.bin";
const MANIFEST_SCHEMA = 1;
/** `movem.l (0x7136,PC,d5.w*8),a1-a2` at 0x71BC and 0x73E4. */
const FONT_TABLE = 0x7136;
const FONT_COUNT = 6;
/** The map covers ASCII $20..$7F; the widths start at metrics +$60. */
const MAP_BYTES = 0x60;
const WIDTHS = 0x60;
/** `add.w $2(a1),d2` feeds BLTSIZE, whose height field is the top ten bits. */
const BLTSIZE_HEIGHT_SHIFT = 6;
/**
 * A glyph starts at WORD column g (`lea (4,a1,d0.w*2),a4`) and may be WIDER
 * than that word: `M`, `W`, `Q`, `Y` and `?` are 22 or 18 pixels on font 0 and
 * spill into the next column, whose own width byte is then 0 and whose index no
 * character map names. The blit width the machine computes is `(w+31)>>4`
 * words, which is two columns for anything up to 32 pixels, so 32 is the bound.
 */
const GLYPH_CELL = 16;
const GLYPH_MAX_WIDTH = GLYPH_CELL * 2;

const PROVENANCE = {
  sourceClass: "disk-derived-panel-font",
  description:
    "The score panel's six bitmap fonts, decoded from `main.bin` on the operator's own AGA " +
    "floppy set: the six {bitmap, metrics} entries at hunk 0 +0x7136, with the single-plane " +
    "glyph strips copied verbatim out of hunk 5 and the character maps, glyph widths and " +
    "blank advances reduced to plain numbers. Functional presentation data only — no " +
    "executable code ships.",
  authorizationRequired: true,
  note:
    "Font 4 is the machine's five-row panel face: its BLTSIZE word is 0x140, which is 5 << 6, " +
    "and five rows at the records' own row 2 is dot rows 2..6 — the rows the HD round counted " +
    "off native-resolution stills in research/hd/phase23/INDEX.txt.",
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Reads the six entries and copies each distinct bitmap verbatim.
 *
 * REFUSES rather than guesses on every shape the decode depends on: the table
 * entries must be relocated longwords into hunks 5 and 0, the BLTSIZE word must
 * carry no width bits (so `>> 6` really is the height), the bitmap must fit its
 * hunk, and every glyph the map names must have a width that fits the 16-pixel
 * cell the `*2` word index gives it.
 */
function decodePanelFont(segmentDir) {
  const pkg = loadPackage(segmentDir, "main.bin");
  const h0 = pkg.bodies[0];
  const h5 = pkg.bodies[5];
  if (h0 === undefined || h5 === undefined) {
    throw new Error("main.bin package has no hunk 0 / hunk 5; the font table is in both");
  }

  const blocks = new Map(); // bitmap offset -> { at, bytes }
  const chunks = [];
  let cursor = 0;
  const fonts = [];
  for (let index = 0; index < FONT_COUNT; index += 1) {
    const entry = FONT_TABLE + 8 * index;
    const bitmap = follow(pkg, { hunk: 0, offset: entry });
    const metrics = follow(pkg, { hunk: 0, offset: entry + 4 });
    if (bitmap === null || bitmap.hunk !== 5) {
      throw new Error(`font ${index}: +$0 is not a relocated pointer into hunk 5`);
    }
    if (metrics === null || metrics.hunk !== 0) {
      throw new Error(`font ${index}: +$4 is not a relocated pointer into hunk 0`);
    }
    const strideWords = h5.readUInt16BE(bitmap.offset);
    const sizeWord = h5.readUInt16BE(bitmap.offset + 2);
    if ((sizeWord & 0x3f) !== 0) {
      throw new Error(
        `font ${index}: BLTSIZE word 0x${sizeWord.toString(16)} carries width bits, so the ` +
          "height is not simply the top ten; the field is not where this decode thinks it is",
      );
    }
    const height = sizeWord >> BLTSIZE_HEIGHT_SHIFT;
    if (height < 1 || height > 16 || strideWords < 1 || strideWords > 64) {
      throw new Error(`font ${index}: ${strideWords} words x ${height} rows is not a panel font`);
    }
    const rowBytes = strideWords * 2;
    const span = 4 + rowBytes * height;
    if (bitmap.offset + span > h5.length) {
      throw new Error(`font ${index}: bitmap runs past hunk 5`);
    }

    if (metrics.offset < 2 || metrics.offset + WIDTHS > h0.length) {
      throw new Error(`font ${index}: metrics block does not fit hunk 0`);
    }
    const blank = h0.readInt16BE(metrics.offset - 2);
    const map = [];
    let glyphs = 0;
    for (let code = 0; code < MAP_BYTES; code += 1) {
      const glyph = h0.readInt8(metrics.offset + code);
      map.push(glyph);
      if (glyph >= 0 && glyph + 1 > glyphs) glyphs = glyph + 1;
    }
    if (glyphs === 0) throw new Error(`font ${index}: its character map names no glyph`);
    if (glyphs > strideWords) {
      throw new Error(
        `font ${index}: the map names glyph ${glyphs - 1}, past the ${strideWords}-word strip`,
      );
    }
    if (metrics.offset + WIDTHS + glyphs > h0.length) {
      throw new Error(`font ${index}: width table runs past hunk 0`);
    }
    const widths = [];
    for (let glyph = 0; glyph < glyphs; glyph += 1) {
      const width = h0.readUInt8(metrics.offset + WIDTHS + glyph);
      if (width > GLYPH_MAX_WIDTH) {
        throw new Error(
          `font ${index}: glyph ${glyph} is ${width} px, past the two word columns the machine's ` +
            "own `(w+31)>>4` blit width can reach",
        );
      }
      widths.push(width);
    }
    // A glyph a character map NAMES must have pixels. The zero-width entries
    // are the spill columns of the wide glyphs and nothing points at them.
    for (const [code, glyph] of map.entries()) {
      if (glyph >= 0 && widths[glyph] === 0) {
        throw new Error(
          `font ${index}: the map sends ${JSON.stringify(String.fromCharCode(0x20 + code))} to ` +
            `glyph ${glyph}, which is zero pixels wide`,
        );
      }
    }
    if (blank < 0 || blank > GLYPH_MAX_WIDTH) {
      throw new Error(`font ${index}: blank advance ${blank} is not a space`);
    }

    // Fonts 4 and 5 name the same bitmap; it ships once.
    let block = blocks.get(bitmap.offset);
    if (block === undefined) {
      const bytes = Buffer.from(h5.subarray(bitmap.offset, bitmap.offset + span));
      block = { offset: cursor, byteLength: span };
      blocks.set(bitmap.offset, block);
      chunks.push(bytes);
      cursor += span;
    } else if (block.byteLength !== span) {
      throw new Error(`font ${index}: shares a bitmap with a font of a different size`);
    }

    fonts.push({
      index,
      source: { bitmap: bitmap.offset, metrics: metrics.offset },
      height,
      strideWords,
      glyphs,
      blank,
      // Byte offset into panel-font.bin of this font's `{stride.w, size.w, bits}`.
      at: block.offset,
      byteLength: span,
      map,
      widths,
    });
  }

  const data = Buffer.concat(chunks);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    data: [{ file: DATA_FILE, byteLength: data.length, sha256: sha256(data) }],
    // The machine's own strip, so a reader can check the geometry it is handed.
    strip: { width: 320, rows: 16, strideBytes: 40, at: 0x6000a00 },
    fonts,
    provenance: PROVENANCE,
  };
  return { manifest, data };
}

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const segmentDir = positional[0];
  const outDir = positional[1] ?? "public/generated";
  if (segmentDir === undefined) {
    console.error("usage: node scripts/export-panel-font.mjs <segment-dir> [out-dir] [--check]");
    return 2;
  }

  const { manifest, data } = decodePanelFont(segmentDir);
  const json = Buffer.from(JSON.stringify(manifest), "utf8");

  console.log(check ? "checking the panel font" : "exporting the panel font");
  if (!check) mkdirSync(outDir, { recursive: true });

  let failures = 0;
  const emit = (name, bytes) => {
    const path = join(outDir, name);
    if (check) {
      const existing = existsSync(path) ? readFileSync(path) : null;
      if (existing !== null && existing.equals(bytes)) {
        console.log(`  ${name.padStart(16)}: identical to ${path}`);
      } else {
        console.error(`  ${name.padStart(16)}: DIFFERS from ${path}`);
        failures += 1;
      }
    } else {
      writeFileSync(path, bytes);
      console.log(`  ${name.padStart(16)}: ${bytes.length.toLocaleString()} bytes`);
    }
  };

  emit(DATA_FILE, data);
  emit(MANIFEST_FILE, json);
  for (const font of manifest.fonts) {
    console.log(
      `  ${String(`font ${font.index}`).padStart(16)}: ${font.height} rows, ` +
        `${font.glyphs} glyphs, ${font.strideWords} words a row, blank ${font.blank}` +
        `  (h5+0x${font.source.bitmap.toString(16)} / h0+0x${font.source.metrics.toString(16)})`,
    );
  }
  return failures === 0 ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
