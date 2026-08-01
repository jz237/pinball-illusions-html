#!/usr/bin/env node
// Decodes the shell's presentation out of `menudata.bin` into the shipped shell
// artwork under public/generated/shell/. Run locally, where the operator's own
// disks live; the PNGs and manifest it writes are what ship. Sibling of
// scripts/export-table-art.mjs, which does the same job for the playfields.
//
// `menudata.bin` is a five-hunk package. Everything visual lives in two of them
// (offsets below are into the hunk BODIES; in the seg_clean split each
// `menudata.bin.segNN.bin` file is `u32 big-endian body length` + body, and
// hunk 4 carries an 88-byte relocation block after its body):
//
//   hunk 3 (148,788 B)                          hunk 4 (4,376 B)
//   0x00000..0x01697  font1 bitmap              0x000  font1 metrics, 128 x 3 B
//   0x01698..0x01D1F  font2 bitmap              0x180  font2 metrics, 256 x 3 B
//   0x01D20..0x0D527  MENU backdrop             0x480  palette fade table 16x16
//   0x0D528..0x18D2F  TABLE-SELECT backdrop     0x680  sine table, 256 B signed
//   0x18D30..end      ATTRACT backdrop          0x780  4 dissolve tables, 256 B
//                                               0xB80+ attract page scripts
//
// THE FONTS. Both proportional, both metric entries 3 bytes per character:
// (advance-width, height in rows, signed y-offset), read exactly as the walker
// at main.bin h0+0xD80/0xDC6 reads them — byte 0 into the width table at
// main+0x1E16/0x1E96, byte 1 accumulated into the glyph offset (x4 for font1's
// 4-byte rows, x2 for font2's 2-byte rows), byte 2 sign-extended. Font1 glyph
// rows are 4 bytes: big-endian word of plane 0 (fill), then plane 1 (outline),
// 16 px wide. Font2 rows are one 2-byte single-plane word. Glyph start row =
// sum of the heights of every preceding character; the font1 sum lands exactly
// on 0x1698 and the font2 sum on 0x686 of its 0x688-byte region.
//
// THE BACKDROPS. Not 320x256 screens: each block is a 1472x32 animation strip
// in 4 interleaved bitplanes (plane stride 184 B, row stride 736 B), 32 frames
// of a tumbling object at 46 px per frame, stored TWICE as two 0x5C04 chunks
// (4-byte zero header + payload); the second copy is the first shifted 16 px —
// the pre-shifted copy for the Amiga's 32-px hardware-scroll range, which a
// canvas does not need, so only the first copy ships. `assertPreShift` proves
// the copies really are 16 px apart, which is the one check that catches the
// whole block being framed at the wrong offset (the analogue of `assertPhase`
// in export-table-art.mjs). The attract block's file body ends 4 bytes short of
// its second copy's final row; the first copy is complete, so nothing is lost.
//
// THE SHARED PALETTE. One 16-colour palette for all three strips, embedded as
// the fade table at h4+0x480 — 16 colours x 16 fade steps, one AGA 12-bit
// $xRGB word each, colour-major; the final column is the settled palette
// (colour 0 = the 0x36A blue, 1-7 a warm object ramp, 8-9 black, 10-15 white).
//
// WHAT IS DELIBERATELY NOT EXPORTED: the attract PAGE SCRIPTS at h4+0xB84 —
// they are the developers' own credit and greeting prose, and this project
// ships the disk's functional graphics, not its authored text. The fonts, the
// strips, the palette, the sine table and the dissolve orders are all
// functional presentation data and all ship.
//
// Usage:
//   node scripts/export-shell-art.mjs <segment-dir> [out-dir] [--check]
//
// <segment-dir> holds menudata.bin.seg03.bin and menudata.bin.seg04.bin.
// --check decodes and compares against the files already in <out-dir> without
// writing, which is how you confirm the shipped assets are still exactly what
// the disks say.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Layout constants. These ARE the decode; see the header.
// ---------------------------------------------------------------------------

/** Each seg_clean file is a 4-byte big-endian body length, then the body. */
const PREAMBLE = 4;

const HUNK3_BODY = 148788;
const HUNK4_BODY = 4376;

const FONT1_BITMAP = 0x0000;
const FONT1_BITMAP_END = 0x1698;
const FONT2_BITMAP = 0x1698;
const FONT2_BITMAP_END = 0x1d20;

const FONT1_METRICS = 0x000;
const FONT1_CHARS = 128;
const FONT2_METRICS = 0x180;
const FONT2_CHARS = 256;

const FADE_TABLE = 0x480;
const FADE_COLOURS = 16;
const FADE_STEPS = 16;

const SINE_TABLE = 0x680;
const SINE_LENGTH = 256;

const DISSOLVE_TABLES = 0x780;
const DISSOLVE_COUNT = 4;
const DISSOLVE_CELLS = 256;

/** The three strips, in hunk-3 order, keyed by the shell state that shows each. */
const BACKDROPS = [
  { role: "menu", offset: 0x1d20 },
  { role: "select", offset: 0xd528 },
  { role: "attract", offset: 0x18d30 },
];

/** One stored copy: 4-byte zero header + 32 rows x 4 planes x 184 bytes. */
const STRIP_CHUNK = 0x5c04;
const STRIP_HEADER = 4;
const STRIP_WIDTH = 1472;
const STRIP_HEIGHT = 32;
const STRIP_PLANES = 4;
const STRIP_PLANE_BYTES = STRIP_WIDTH / 8; // 184
const STRIP_ROW_BYTES = STRIP_PLANES * STRIP_PLANE_BYTES; // 736
/** 32 pre-rendered rotation frames, 46 px apart. */
const STRIP_FRAMES = 32;
const STRIP_FRAME_WIDTH = 46;

/**
 * The attract block's second (pre-shifted) copy is 4 bytes short in the file:
 * the body ends at 0x24534 where the block needs 0x24538. Only the first copy
 * ships, so the truncation costs nothing, but the pre-shift proof must know to
 * stop 4 bytes early on that block.
 */
const ATTRACT_TRUNCATED_BYTES = 4;

const FONT_WIDTH = 16;

const MANIFEST_SCHEMA = "pinball-illusions/shell-art/v1";
const MANIFEST_FILE = "shell.art.json";

// Same shape as the PROVENANCE block in export-table-art.mjs.
// check-public-build.mjs keys off `sourceClass`, and every disk-derived class is
// gated by the same authorization variable.
const PROVENANCE = {
  sourceClass: "disk-derived-shell-artwork",
  description:
    "Menu fonts, backdrop animation strips, palette, sine and dissolve tables decoded from " +
    "menudata.bin on the operator's own AGA floppy set. Functional presentation data only: " +
    "no audio, no executable code, and none of the disk's authored credit or greeting text.",
  authorizationRequired: true,
};

// ---------------------------------------------------------------------------
// Reading the hunks
// ---------------------------------------------------------------------------

/** Strips the length preamble after checking it declares the documented body. */
function bodyOf(bytes, expected, name) {
  const declared = bytes.readUInt32BE(0);
  if (declared !== expected) {
    throw new Error(`${name} declares a ${declared}-byte body, expected ${expected}`);
  }
  if (bytes.length < PREAMBLE + expected) {
    throw new Error(`${name} is ${bytes.length} bytes, too short for its declared body`);
  }
  return bytes.subarray(PREAMBLE, PREAMBLE + expected);
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/**
 * Reads one metrics table: `chars` entries of (advance, height, signed y-offset).
 *
 * The cross-check against `bitmapBytes` is the framing proof for the whole
 * font: the sum of every height times the row size must land exactly on the
 * bitmap region the descriptor gives that font (font2's region carries 2 slack
 * bytes, hence `slack`). A table read at the wrong offset — the failure mode
 * this exporter actually had during development, when the preamble was taken as
 * 8 bytes rather than 4 — misses by hundreds of rows and dies here.
 */
function readMetrics(h4, at, chars, rowBytes, bitmapBytes, slack, name) {
  const metrics = [];
  let rows = 0;
  for (let c = 0; c < chars; c += 1) {
    const o = at + c * 3;
    const advance = h4[o];
    const height = h4[o + 1];
    const yOffset = (h4[o + 2] << 24) >> 24;
    metrics.push([advance, height, yOffset]);
    rows += height;
  }
  const used = rows * rowBytes;
  if (used > bitmapBytes || bitmapBytes - used > slack) {
    throw new Error(
      `${name}: heights sum to ${used} bitmap bytes, region is ${bitmapBytes} ` +
        `(allowed slack ${slack}) — the metrics are framed at the wrong offset`,
    );
  }
  return { metrics, rows };
}

/**
 * Expands a font bitmap into one byte per pixel, 16 px wide, `rows` tall.
 *
 * Font1 rows are [plane0 word][plane1 word]: pixel = fill bit + 2x outline bit,
 * values 0..3. Font2 rows are a single word: values 0..1. Row `r` of the image
 * is row `r` of the bitmap, so a glyph's rows sit at the cumulative-height
 * offsets the metrics table implies — the atlas IS the disk's layout.
 */
function decodeFontBitmap(h3, at, rows, planes) {
  const pixels = new Uint8Array(FONT_WIDTH * rows);
  const rowBytes = planes * 2;
  for (let r = 0; r < rows; r += 1) {
    const o = at + r * rowBytes;
    for (let p = 0; p < planes; p += 1) {
      const word = (h3[o + p * 2] << 8) | h3[o + p * 2 + 1];
      if (word === 0) continue;
      const bit = 1 << p;
      for (let x = 0; x < FONT_WIDTH; x += 1) {
        if (word & (0x8000 >> x)) pixels[r * FONT_WIDTH + x] |= bit;
      }
    }
  }
  return pixels;
}

// ---------------------------------------------------------------------------
// Backdrop strips
// ---------------------------------------------------------------------------

/**
 * Proves a block is framed correctly: its second stored copy must be the first
 * shifted exactly 16 px (2 bytes) left, byte for byte. Nothing subtler than a
 * framing mistake survives 23 KB of that. `short` trims the comparison for the
 * attract block's truncated tail.
 */
function assertPreShift(h3, offset, short, role) {
  const first = offset + STRIP_HEADER;
  const second = offset + STRIP_CHUNK + STRIP_HEADER;
  let mismatches = 0;
  let tested = 0;
  const lastByte = STRIP_HEIGHT * STRIP_ROW_BYTES - short;
  for (let row = 0; row < STRIP_HEIGHT; row += 1) {
    for (let plane = 0; plane < STRIP_PLANES; plane += 1) {
      const base = row * STRIP_ROW_BYTES + plane * STRIP_PLANE_BYTES;
      for (let x = 0; x < STRIP_PLANE_BYTES - 2; x += 1) {
        if (base + x >= lastByte) continue;
        tested += 1;
        if (h3[second + base + x] !== h3[first + base + x + 2]) mismatches += 1;
      }
    }
  }
  if (mismatches > 0) {
    throw new Error(
      `${role} backdrop: ${mismatches} of ${tested} bytes break the 16-px pre-shift ` +
        `relation between the two stored copies — the block is framed at the wrong offset`,
    );
  }
}

/** Expands one strip's first copy into one 4-bit palette index per pixel. */
function decodeStrip(h3, offset) {
  const pixels = new Uint8Array(STRIP_WIDTH * STRIP_HEIGHT);
  const base = offset + STRIP_HEADER;
  for (let row = 0; row < STRIP_HEIGHT; row += 1) {
    for (let plane = 0; plane < STRIP_PLANES; plane += 1) {
      const planeBase = base + row * STRIP_ROW_BYTES + plane * STRIP_PLANE_BYTES;
      const bit = 1 << plane;
      for (let bx = 0; bx < STRIP_PLANE_BYTES; bx += 1) {
        const byte = h3[planeBase + bx];
        if (byte === 0) continue;
        const x0 = row * STRIP_WIDTH + bx * 8;
        for (let b = 0; b < 8; b += 1) {
          if (byte & (0x80 >> b)) pixels[x0 + b] |= bit;
        }
      }
    }
  }
  return pixels;
}

// ---------------------------------------------------------------------------
// Palette, sine, dissolve
// ---------------------------------------------------------------------------

/** An AGA 12-bit $xRGB word as an [r, g, b] triple, each nibble spread to 8 bits. */
function agaRgb(word) {
  return [((word >> 8) & 0xf) * 17, ((word >> 4) & 0xf) * 17, (word & 0xf) * 17];
}

/** The 16x16 fade table, colour-major, one AGA word per step. */
function readFadeTable(h4) {
  const fade = [];
  for (let colour = 0; colour < FADE_COLOURS; colour += 1) {
    const steps = [];
    for (let step = 0; step < FADE_STEPS; step += 1) {
      steps.push(h4.readUInt16BE(FADE_TABLE + colour * FADE_STEPS * 2 + step * 2));
    }
    fade.push(steps);
  }
  return fade;
}

function readSine(h4) {
  const sine = [];
  for (let i = 0; i < SINE_LENGTH; i += 1) {
    const value = (h4[SINE_TABLE + i] << 24) >> 24;
    if (value < -64 || value > 64) {
      throw new Error(`sine table entry ${i} is ${value}, outside the ±64 the copper uses`);
    }
    sine.push(value);
  }
  return sine;
}

/** The four 16x16 dissolve orders. Each must be a permutation of 0..255. */
function readDissolve(h4) {
  const tables = [];
  for (let t = 0; t < DISSOLVE_COUNT; t += 1) {
    const order = [...h4.subarray(DISSOLVE_TABLES + t * DISSOLVE_CELLS, DISSOLVE_TABLES + (t + 1) * DISSOLVE_CELLS)];
    if (new Set(order).size !== DISSOLVE_CELLS) {
      throw new Error(`dissolve table ${t} is not a permutation of 0..255; wrong offset`);
    }
    tables.push(order);
  }
  return tables;
}

// ---------------------------------------------------------------------------
// PNG (identical writer to export-table-art.mjs: fixed filter, fixed level,
// byte-for-byte reproducible, which is what --check compares)
// ---------------------------------------------------------------------------

function encodeIndexedPng(pixels, width, height, palette) {
  const raw = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y += 1) {
    const at = y * (1 + width);
    raw[at] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width, width).copy(raw, at + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // colour type: indexed
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("PLTE", Buffer.from(palette)),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(tag, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(tag, "latin1"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (CRC_TABLE === null) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const segDir = positional[0];
  const outDir = positional[1] ?? "public/generated/shell";

  if (segDir === undefined) {
    console.error("usage: node scripts/export-shell-art.mjs <segment-dir> [out-dir] [--check]");
    return 1;
  }
  if (!existsSync(segDir)) {
    console.error(`segment directory not found: ${segDir}`);
    return 1;
  }

  const seg3Path = join(segDir, "menudata.bin.seg03.bin");
  const seg4Path = join(segDir, "menudata.bin.seg04.bin");
  for (const path of [seg3Path, seg4Path]) {
    if (!existsSync(path)) {
      console.error(`segment missing: ${path}`);
      return 1;
    }
  }

  const h3 = bodyOf(readFileSync(seg3Path), HUNK3_BODY, "menudata.bin.seg03.bin");
  const h4 = bodyOf(readFileSync(seg4Path), HUNK4_BODY, "menudata.bin.seg04.bin");

  // Fonts. The metrics/bitmap cross-check inside readMetrics is the framing
  // proof; see its comment.
  const font1 = readMetrics(
    h4, FONT1_METRICS, FONT1_CHARS, 4, FONT1_BITMAP_END - FONT1_BITMAP, 0, "font1");
  const font2 = readMetrics(
    h4, FONT2_METRICS, FONT2_CHARS, 2, FONT2_BITMAP_END - FONT2_BITMAP, 2, "font2");
  const font1Pixels = decodeFontBitmap(h3, FONT1_BITMAP, font1.rows, 2);
  const font2Pixels = decodeFontBitmap(h3, FONT2_BITMAP, font2.rows, 1);

  // The shared 16-colour palette: the fade table's final column.
  const fade = readFadeTable(h4);
  const paletteWords = fade.map((steps) => steps[FADE_STEPS - 1]);
  const paletteRgb = paletteWords.flatMap(agaRgb);
  const sine = readSine(h4);
  const dissolve = readDissolve(h4);

  // The strips, proven and decoded.
  const strips = [];
  for (const backdrop of BACKDROPS) {
    const short = backdrop.role === "attract" ? ATTRACT_TRUNCATED_BYTES : 0;
    assertPreShift(h3, backdrop.offset, short, backdrop.role);
    strips.push({ ...backdrop, pixels: decodeStrip(h3, backdrop.offset) });
  }

  // Font atlases carry a viewing palette only — the loader reads indices, not
  // colours: 0 empty, 1 fill, 2 outline, 3 both planes (fill wins).
  const fontPalette = [0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255];
  const images = [
    {
      file: "shell-font1.png",
      role: "font1",
      width: FONT_WIDTH,
      height: font1.rows,
      png: encodeIndexedPng(font1Pixels, FONT_WIDTH, font1.rows, fontPalette),
    },
    {
      file: "shell-font2.png",
      role: "font2",
      width: FONT_WIDTH,
      height: font2.rows,
      png: encodeIndexedPng(font2Pixels, FONT_WIDTH, font2.rows, fontPalette.slice(0, 6)),
    },
    ...strips.map((strip) => ({
      file: `shell-backdrop-${strip.role}.png`,
      role: `backdrop-${strip.role}`,
      width: STRIP_WIDTH,
      height: STRIP_HEIGHT,
      png: encodeIndexedPng(strip.pixels, STRIP_WIDTH, STRIP_HEIGHT, paletteRgb),
    })),
  ];

  const manifest = {
    schema: MANIFEST_SCHEMA,
    images: images.map((image) => ({
      file: image.file,
      role: image.role,
      width: image.width,
      height: image.height,
      byteLength: image.png.length,
      sha256: sha256(image.png),
    })),
    font1: { chars: FONT1_CHARS, rows: font1.rows, metrics: font1.metrics },
    font2: { chars: FONT2_CHARS, rows: font2.rows, metrics: font2.metrics },
    palette: { aga: paletteWords, rgb: paletteRgb },
    fade: fade,
    sine,
    dissolve,
    strip: { frames: STRIP_FRAMES, frameWidth: STRIP_FRAME_WIDTH },
    provenance: PROVENANCE,
  };
  const json = JSON.stringify(manifest);

  console.log(check ? "checking shell art" : "exporting shell art");
  if (!check) mkdirSync(outDir, { recursive: true });

  let failures = 0;
  const emit = (name, bytes) => {
    const path = join(outDir, name);
    if (check) {
      const existing = existsSync(path) ? readFileSync(path) : null;
      if (existing !== null && existing.equals(bytes)) {
        console.log(`  ${name.padStart(26)}: identical to ${path}`);
      } else {
        console.error(
          `  ${name.padStart(26)}: DIFFERS from ${path}` +
            (existing === null
              ? " (file missing)"
              : ` (${existing.length} vs ${bytes.length} bytes, sha256 ` +
                `${sha256(existing).slice(0, 12)} vs ${sha256(bytes).slice(0, 12)})`),
        );
        failures += 1;
      }
    } else {
      writeFileSync(path, bytes);
      console.log(`  ${name.padStart(26)}: ${bytes.length.toLocaleString()} bytes`);
    }
  };

  for (const image of images) emit(image.file, image.png);
  emit(MANIFEST_FILE, Buffer.from(json, "utf8"));

  console.log(
    `  ${" ".repeat(26)}  font1 ${font1.rows} rows, font2 ${font2.rows} rows, ` +
      `3 strips ${STRIP_WIDTH}x${STRIP_HEIGHT}, palette [${paletteWords
        .map((w) => w.toString(16).padStart(3, "0"))
        .join(" ")}]`,
  );

  if (failures > 0) {
    console.error(`${failures} file(s) differ or are missing`);
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
