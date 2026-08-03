#!/usr/bin/env node
// Decodes the LOADING LOGO out of the boot loader `Pinball` into the shipped
// asset under public/generated/shell/. Run locally, where the operator's own
// disks live; the PNG and manifest it writes are what ship. Sibling of
// scripts/export-shell-art.mjs, which does the same job for menudata.bin's
// fonts and backdrops.
//
// Usage:  node scripts/export-loading-logo.mjs <loader-dir> [out-dir] [--check]
//   <loader-dir> holds `Pinball`, the 25,044-byte loader from disk 1.
//   --check decodes and compares against the files already in <out-dir>
//   without writing, which is how you confirm the shipped asset is still
//   exactly what the disk says.
//
// ---------------------------------------------------------------------------
// WHERE IT IS, AND HOW WE KNOW
// ---------------------------------------------------------------------------
// Not in `menudata.bin`. The word is drawn by the LOADER — `Pinball`, the 25 KB
// AmigaDOS executable the Startup-Sequence runs, `$VER: Pinball_Illusions 1.6
// (24.1.95)` — and it is a copper screen of its own, which is why nothing in the
// shell's own artwork ever accounted for it and why the reconstruction shipped a
// word set in the menu font instead.
//
// `Pinball` is a plain uncompressed HUNK executable and IT CARRIES ITS SYMBOL
// TABLE, so this decode does not have to guess at a single offset. Hunk 1 (the
// 19,588-byte CHIP data hunk) exports:
//
//     LoadingCop      +0x0000   the copper list
//     LoadingBplPtr   +0x0070   where the loader patches the bitplane pointers
//     LoadingGfx      +0x0130   THE BITMAP
//     DiskSwapCop     +0x0E00   the insert-a-disk screen, and its own bitmap
//     DiskSwapGfx     +0x0F30   at +0x0F30. Not exported; nothing shows it here.
//
// This script resolves those names out of HUNK_SYMBOL rather than hard-coding
// file offsets, so a differently-built loader would fail loudly rather than
// decode garbage.
//
// ---------------------------------------------------------------------------
// WHAT THE COPPER LIST SAYS, WHICH IS THE WHOLE SPECIFICATION
// ---------------------------------------------------------------------------
//     DIWSTRT  $8081   display window starts at raster line 128, hpos $81
//     DIWSTOP  $90c1   ... and stops at 144, so the picture is SIXTEEN LINES
//     DDFSTRT  $0038   the standard lores pair for hstart $81: 20 fetches,
//     DDFSTOP  $00d0   i.e. 320 px wide
//     BPL1MOD  $00a0   160 = (5 - 1) * 40, which is what proves both the plane
//     BPL2MOD  $00a0   COUNT and the row INTERLEAVE
//     BPLCON0  $5200   at WAIT vp=$80: five planes on
//     BPLCON0  $0200   at WAIT vp=$90: planes off again
//     COLOR00..COLOR31 thirty-two 12-bit AGA words, in register order
//
// So the bitmap is 320 x 16, five bitplanes, interleaved by ROW (row r plane p
// at LoadingGfx + (r*5 + p) * 40) — 3,200 bytes, ending exactly where the next
// structure begins. The word's ink occupies columns 90..236 (147 px) of the
// 320 and every one of the 16 rows; index 31 ($fd6) is in the palette and is
// never used.
//
// The whole thing is verified against the film as well as against itself:
// research\view\reference\PinballIllusions_Disk1_005.png and _007.png (and three
// more captures in session2 and session3) are byte-identical pictures of this
// screen, and the decode reproduces their 31 distinct colours and their exact
// ink mask.
//
// ---------------------------------------------------------------------------
// WHERE IT GOES ON SCREEN — AND WHY THE FILM CANNOT SAY
// ---------------------------------------------------------------------------
// The copper puts the strip at RASTER LINES 128..143. `main.bin`'s own shell
// display (its copper list at main.bin.seg03 +0xF0, +0x2DC and +0x35C, all three
// identical here) is DIWSTRT $2c81 / DIWSTOP $2cc1 — raster 44..299, i.e. the
// 320 x 256 screen every other page of this shell is drawn on. The logo is
// therefore 128 - 44 = 84 lines below the top of that screen: SHELL ROWS 84..99.
//
// THE FILM MEASURES 120..135 AND THE FILM IS WRONG ABOUT THIS, for a reason that
// has nothing to do with the game. The captures were taken through WinUAE with
// `gfx_center_vertical=smart`, which re-centres the emulated display window in
// the 574-row output every time its height changes. Both filmed displays land on
// the exact centre: the 256-line shell screen at output rows 32..543 = window
// lines 16..271, top margin ceil((287-256)/2) = 16; the 16-line loading screen at
// output rows 272..303 = window lines 136..151, top margin ceil((287-16)/2) =
// 136. The boot take catches the window physically moving across frames
// 4260..4262 between the two. Two displays of different heights both landing
// exactly centred is not a coincidence about the machine; it is the emulator.
//
// The HORIZONTAL is unaffected and the film does confirm it: both displays are
// 320 px at hpos $81, so smart centring puts them in the same columns, and the
// filmed ink runs from output column 234 = shell column 90 exactly as the bitmap
// says. Only the vertical is an artefact, and only because the two displays are
// different heights.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Layout constants. These ARE the decode; see the header.
// ---------------------------------------------------------------------------

const LOADER_FILE = "Pinball";

/** Symbols the decode resolves out of the loader's own HUNK_SYMBOL table. */
const SYMBOL_COPPER = "LoadingCop";
const SYMBOL_BITMAP = "LoadingGfx";

const WIDTH = 320;
const HEIGHT = 16;
const PLANES = 5;
const ROW_BYTES = WIDTH / 8; // 40
const PLANE_ROWS = HEIGHT * PLANES;
const BITMAP_BYTES = PLANE_ROWS * ROW_BYTES; // 3200
const COLOURS = 1 << PLANES; // 32

/** The copper's own words, checked one for one. See the header. */
const EXPECT_DIWSTRT = 0x8081;
const EXPECT_DIWSTOP = 0x90c1;
const EXPECT_DDFSTRT = 0x0038;
const EXPECT_DDFSTOP = 0x00d0;
const EXPECT_MODULO = (PLANES - 1) * ROW_BYTES; // 160
/** BPLCON0 with BPU = 5 and COLOR on, and the same word with BPU = 0. */
const EXPECT_BPLCON0_ON = 0x5200;
const EXPECT_BPLCON0_OFF = 0x0200;

/** The raster line the display window starts on, out of DIWSTRT. */
const RASTER_TOP = EXPECT_DIWSTRT >> 8; // 128
/** `main.bin`'s shell display starts here: DIWSTRT $2c81 in main.bin.seg03. */
const SHELL_RASTER_TOP = 0x2c; // 44
/** So the strip's first row, in the shell's own 320 x 256 screen. */
const SHELL_TOP_ROW = RASTER_TOP - SHELL_RASTER_TOP; // 84

/** The ink box the decode must find, and which the film confirms. */
const INK_LEFT = 90;
const INK_RIGHT = 236;

const MANIFEST_SCHEMA = "pinball-illusions/loading-logo/v1";
const MANIFEST_FILE = "loading.art.json";
const IMAGE_FILE = "loading-logo.png";

// A class of its own rather than a sixth image on the shell-artwork manifest:
// this comes out of the LOADER, not out of menudata.bin, and a provenance block
// should say which file it was read from. check-public-build.mjs keys off
// `sourceClass` and gates every disk-derived class behind the same variable.
const PROVENANCE = {
  sourceClass: "disk-derived-loading-logo",
  description:
    "The 320 x 16 five-bitplane LOADING logo and its 32-colour copper palette, decoded from " +
    "the boot loader `Pinball` on the operator's own AGA floppy set. Functional presentation " +
    "data only: one picture and one palette, no executable code and nothing else from the " +
    "loader.",
  authorizationRequired: true,
};

// ---------------------------------------------------------------------------
// The HUNK executable
// ---------------------------------------------------------------------------

const HUNK_HEADER = 0x3f3;
const HUNK_CODE = 0x3e9;
const HUNK_DATA = 0x3ea;
const HUNK_BSS = 0x3eb;
const HUNK_RELOC32 = 0x3ec;
const HUNK_SYMBOL = 0x3f0;
const HUNK_DEBUG = 0x3f1;
const HUNK_END = 0x3f2;

/**
 * Walks the loader's hunks far enough to find each one's body and its symbols.
 *
 * Deliberately a real walk rather than a search: the symbol table is what makes
 * this decode self-locating, and a symbol value is an offset into ITS OWN HUNK,
 * so the hunk boundaries have to be right before a name means anything.
 */
function readHunks(bytes) {
  const u32 = (at) => bytes.readUInt32BE(at);
  if (u32(0) !== HUNK_HEADER) throw new Error(`${LOADER_FILE} is not a HUNK executable`);
  let at = 4;
  if (u32(at) !== 0) throw new Error("loader declares resident library names");
  at += 4;
  const table = u32(at);
  const first = u32(at + 4);
  const last = u32(at + 8);
  at += 12 + 4 * (last - first + 1);
  if (table !== last - first + 1) throw new Error(`hunk table is ${table}, first..last ${first}..${last}`);

  const hunks = [];
  let index = 0;
  while (at < bytes.length) {
    const kind = u32(at) & 0x3fffffff;
    at += 4;
    if (kind === HUNK_END) {
      index += 1;
      continue;
    }
    const longs = u32(at);
    at += 4;
    if (kind === HUNK_CODE || kind === HUNK_DATA) {
      hunks[index] ??= { body: null, length: 0, symbols: new Map() };
      hunks[index].body = at;
      hunks[index].length = longs * 4;
      at += longs * 4;
      continue;
    }
    if (kind === HUNK_BSS) continue;
    if (kind === HUNK_DEBUG) {
      at += longs * 4;
      continue;
    }
    if (kind === HUNK_RELOC32) {
      at -= 4;
      for (;;) {
        const count = u32(at);
        at += 4;
        if (count === 0) break;
        at += 4 + 4 * count;
      }
      continue;
    }
    if (kind === HUNK_SYMBOL) {
      at -= 4;
      hunks[index] ??= { body: null, length: 0, symbols: new Map() };
      for (;;) {
        const nameLongs = u32(at);
        at += 4;
        if (nameLongs === 0) break;
        const name = bytes
          .subarray(at, at + nameLongs * 4)
          .toString("latin1")
          .replace(/\0+$/, "");
        at += nameLongs * 4;
        hunks[index].symbols.set(name, u32(at));
        at += 4;
      }
      continue;
    }
    throw new Error(`unexpected hunk type 0x${kind.toString(16)} at ${at - 8}`);
  }
  return hunks;
}

/** The file offset of a named symbol, and which hunk carried it. */
function locate(hunks, name) {
  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index];
    if (hunk === undefined || hunk.body === null) continue;
    const value = hunk.symbols.get(name);
    if (value === undefined) continue;
    return { hunk: index, offset: value, file: hunk.body + value, length: hunk.length };
  }
  throw new Error(`${LOADER_FILE} exports no symbol named ${name}`);
}

// ---------------------------------------------------------------------------
// The copper list
// ---------------------------------------------------------------------------

/**
 * Reads the display registers and the palette out of `LoadingCop`, checking
 * every one of them against the header's table.
 *
 * This is the framing proof — the analogue of `assertPhase` in
 * export-table-art.mjs. A bitmap read at the wrong stride or with the wrong
 * plane count still produces a picture; a copper list that does not say
 * 320 x 16 x 5 planes with a 160-byte modulo says the reading is wrong.
 */
function readCopper(bytes, start) {
  const moves = new Map();
  const bplcon0 = [];
  let at = start;
  let waited = -1;
  for (let step = 0; step < 4096; step += 1) {
    const first = bytes.readUInt16BE(at);
    const second = bytes.readUInt16BE(at + 2);
    at += 4;
    if (first === 0xffff && second === 0xfffe) break;
    if ((first & 1) !== 0) {
      waited = first >> 8;
      continue;
    }
    const register = first & 0x1fe;
    if (register === 0x100) bplcon0.push({ line: waited, value: second });
    else moves.set(register, second);
  }

  const want = (register, expected, label) => {
    const seen = moves.get(register);
    if (seen !== expected) {
      throw new Error(
        `${label}: copper writes $${(seen ?? 0).toString(16)}, expected $${expected.toString(16)}`,
      );
    }
  };
  want(0x08e, EXPECT_DIWSTRT, "DIWSTRT");
  want(0x090, EXPECT_DIWSTOP, "DIWSTOP");
  want(0x092, EXPECT_DDFSTRT, "DDFSTRT");
  want(0x094, EXPECT_DDFSTOP, "DDFSTOP");
  want(0x108, EXPECT_MODULO, "BPL1MOD");
  want(0x10a, EXPECT_MODULO, "BPL2MOD");

  // Three: the list opens with the planes OFF before any WAIT, turns them on at
  // the top of the strip and off again at the bottom.
  if (bplcon0.length !== 3) throw new Error(`expected 3 BPLCON0 writes, saw ${bplcon0.length}`);
  const [initial, on, off] = bplcon0;
  if (initial.value !== EXPECT_BPLCON0_OFF || initial.line !== -1) {
    throw new Error(`BPLCON0 opens as $${initial.value.toString(16)} at line ${initial.line}`);
  }
  if (on.value !== EXPECT_BPLCON0_ON || on.line !== RASTER_TOP) {
    throw new Error(`BPLCON0 turns on as $${on.value.toString(16)} at line ${on.line}`);
  }
  if (off.value !== EXPECT_BPLCON0_OFF || off.line !== (EXPECT_DIWSTOP >> 8)) {
    throw new Error(`BPLCON0 turns off as $${off.value.toString(16)} at line ${off.line}`);
  }

  const aga = [];
  for (let index = 0; index < COLOURS; index += 1) {
    const word = moves.get(0x180 + index * 2);
    if (word === undefined) throw new Error(`copper never writes COLOR${index}`);
    if (word > 0x0fff) throw new Error(`COLOR${index} is $${word.toString(16)}, not a 12-bit word`);
    aga.push(word);
  }
  return aga;
}

// ---------------------------------------------------------------------------
// The bitmap
// ---------------------------------------------------------------------------

/** Row-interleaved planes: row r plane p at `start + (r*PLANES + p) * ROW_BYTES`. */
function readBitmap(bytes, start) {
  const pixels = new Uint8Array(WIDTH * HEIGHT);
  for (let row = 0; row < HEIGHT; row += 1) {
    for (let plane = 0; plane < PLANES; plane += 1) {
      const base = start + (row * PLANES + plane) * ROW_BYTES;
      for (let byte = 0; byte < ROW_BYTES; byte += 1) {
        const bits = bytes[base + byte];
        if (bits === 0) continue;
        for (let bit = 0; bit < 8; bit += 1) {
          if ((bits & (0x80 >> bit)) === 0) continue;
          pixels[row * WIDTH + byte * 8 + bit] |= 1 << plane;
        }
      }
    }
  }
  return pixels;
}

/** Everything the picture must be for the framing to be right. */
function assertPicture(pixels) {
  let left = WIDTH;
  let right = -1;
  let top = HEIGHT;
  let bottom = -1;
  const used = new Set();
  for (let row = 0; row < HEIGHT; row += 1) {
    for (let column = 0; column < WIDTH; column += 1) {
      const index = pixels[row * WIDTH + column];
      used.add(index);
      if (index === 0) continue;
      if (column < left) left = column;
      if (column > right) right = column;
      if (row < top) top = row;
      if (row > bottom) bottom = row;
    }
  }
  if (left !== INK_LEFT || right !== INK_RIGHT) {
    throw new Error(`ink spans columns ${left}..${right}, expected ${INK_LEFT}..${INK_RIGHT}`);
  }
  if (top !== 0 || bottom !== HEIGHT - 1) {
    throw new Error(`ink spans rows ${top}..${bottom}, expected 0..${HEIGHT - 1}`);
  }
  // Thirty-one of the thirty-two, which is what the five filmed captures show.
  // A wrong plane count would use 16 (four planes) or 64+ (six).
  if (used.size !== COLOURS - 1 || used.has(COLOURS - 1)) {
    throw new Error(`picture uses ${used.size} indices${used.has(COLOURS - 1) ? " including 31" : ""}`);
  }
  return { left, right, top, bottom, width: right - left + 1 };
}

// ---------------------------------------------------------------------------
// PNG (identical writer to export-shell-art.mjs: fixed filter, fixed level,
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

/** An AGA 12-bit $0RGB word as an [r, g, b] triple, each nibble spread to 8 bits. */
function agaRgb(word) {
  return [((word >> 8) & 0xf) * 17, ((word >> 4) & 0xf) * 17, (word & 0xf) * 17];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Decodes everything, in memory. Exported so a test can re-run it in-process. */
export function decodeLoadingLogo(loaderBytes) {
  const hunks = readHunks(loaderBytes);
  const copper = locate(hunks, SYMBOL_COPPER);
  const bitmap = locate(hunks, SYMBOL_BITMAP);
  if (bitmap.hunk !== copper.hunk) {
    throw new Error(`${SYMBOL_BITMAP} and ${SYMBOL_COPPER} are in different hunks`);
  }
  if (bitmap.offset + BITMAP_BYTES > bitmap.length) {
    throw new Error(`${SYMBOL_BITMAP} + ${BITMAP_BYTES} runs past the end of its hunk`);
  }
  const aga = readCopper(loaderBytes, copper.file);
  const pixels = readBitmap(loaderBytes, bitmap.file);
  const ink = assertPicture(pixels);
  const png = encodeIndexedPng(pixels, WIDTH, HEIGHT, aga.flatMap(agaRgb));
  const manifest = {
    schema: MANIFEST_SCHEMA,
    image: {
      file: IMAGE_FILE,
      width: WIDTH,
      height: HEIGHT,
      byteLength: png.length,
      sha256: sha256(png),
    },
    planes: PLANES,
    // Where it goes on the shell's own 320 x 256 screen. See the header for why
    // this is read off two copper lists and not off the film.
    placement: {
      top: SHELL_TOP_ROW,
      rasterTop: RASTER_TOP,
      shellRasterTop: SHELL_RASTER_TOP,
    },
    ink: { left: ink.left, right: ink.right, top: ink.top, bottom: ink.bottom },
    palette: { aga, rgb: aga.flatMap(agaRgb) },
    source: {
      file: LOADER_FILE,
      copperSymbol: SYMBOL_COPPER,
      bitmapSymbol: SYMBOL_BITMAP,
      copperOffset: copper.offset,
      bitmapOffset: bitmap.offset,
      hunk: bitmap.hunk,
    },
    provenance: PROVENANCE,
  };
  return { png, manifest, pixels, aga, ink };
}

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const loaderDir = positional[0];
  const outDir = positional[1] ?? "public/generated/shell";
  if (loaderDir === undefined) {
    console.error("usage: export-loading-logo.mjs <loader-dir> [out-dir] [--check]");
    return 2;
  }

  const loaderPath = join(loaderDir, LOADER_FILE);
  if (!existsSync(loaderPath)) {
    console.error(`loader not found: ${loaderPath}`);
    return 2;
  }
  const { png, manifest, ink } = decodeLoadingLogo(readFileSync(loaderPath));
  const json = JSON.stringify(manifest);

  console.log(check ? "checking loading logo" : "exporting loading logo");
  if (!check) mkdirSync(outDir, { recursive: true });

  let failures = 0;
  const emit = (name, bytes) => {
    const path = join(outDir, name);
    if (check) {
      const existing = existsSync(path) ? readFileSync(path) : null;
      if (existing !== null && existing.equals(bytes)) {
        console.log(`  ${name.padStart(22)}: identical to ${path}`);
      } else {
        console.error(
          `  ${name.padStart(22)}: DIFFERS from ${path}` +
            (existing === null
              ? " (file missing)"
              : ` (${existing.length} vs ${bytes.length} bytes, sha256 ` +
                `${sha256(existing).slice(0, 12)} vs ${sha256(bytes).slice(0, 12)})`),
        );
        failures += 1;
      }
    } else {
      writeFileSync(path, bytes);
      console.log(`  ${name.padStart(22)}: ${bytes.length.toLocaleString()} bytes`);
    }
  };

  emit(IMAGE_FILE, png);
  emit(MANIFEST_FILE, Buffer.from(json, "utf8"));
  console.log(
    `  ${" ".repeat(22)}  ${WIDTH}x${HEIGHT}, ${PLANES} planes, ink ${ink.width} px wide at ` +
      `x ${ink.left}..${ink.right}, shell rows ${SHELL_TOP_ROW}..${SHELL_TOP_ROW + HEIGHT - 1} ` +
      `(raster ${RASTER_TOP})`,
  );

  if (failures > 0) {
    console.error(`${failures} file(s) differ or are missing`);
    return 1;
  }
  return 0;
}

// Importable for tests; a direct run executes.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  process.exit(main(process.argv.slice(2)));
}
