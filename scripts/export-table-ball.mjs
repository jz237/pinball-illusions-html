#!/usr/bin/env node
// Decodes the BALL SPRITE out of the table packages into the documents under
// public/generated/tables/*.ball.json. Run locally, where the operator's own
// disks live; the JSON it writes is what ships. Sibling of
// scripts/export-table-lamps.mjs, whose package loader and relocation follower
// it imports.
//
// ---------------------------------------------------------------------------
// WHERE THE BALL IS
// ---------------------------------------------------------------------------
// The ball is a PER-TABLE sprite and it is the LAST 544 BYTES OF SLOT 6 — the
// same slot that holds the lamp graphics. The slot-0 descriptor points at it
// from field +$54, which the engine copies to $2342(a5) and writes into the ball
// object's +$40 once at init (main.seg00 h0+0x34F0) and never again.
//
//   law-n-justice   h6+0xD698 = 54936 of 55480    sha256 5a08c2b6...
//   babewatch       h6+0xA258 = 41560 of 42104    sha256 4a976a40...
//   extreme-sports  h6+0x8490 = 33936 of 34480    sha256 a0451c6c...
//
// `offset + 544 == slot-6 length` on all three: the raster is exactly the tail.
//
// FORMAT. 17 x 17 pixels — not 16; the disc is odd-sized with a true centre
// pixel, and a 16-wide implementation is half a pixel out on one side. Stored 32
// px wide by 17 display rows, 8 bitplanes, LINE-INTERLEAVED: plane p of row r is
// at base + r*32 + p*4, MSB-first, big-endian, 17*32 = 544 bytes. Columns 17..31
// are zero on all three tables — the blitter's shift headroom, not picture.
//
// PALETTE. The table's own slot-3 artwork palette, which descriptor +$50 names
// at h3+0x3A200 = the last 768 bytes of slot 3 — byte-identical to the PLTE
// already shipped in `<table-id>.art.png` (check 7 asserts it). So this document
// carries 8-bit palette INDICES, no colours, and the ball recolours itself for
// free. Indices 48..63 are a byte-identical 16-step greyscale ramp in all three
// palettes: the reserved bank for the shared steel look, which is why the three
// balls share a body and differ only in the tinting of the lower crescent.
//
// THE MASK is shared and lives in main.bin slot 6: 36 rows of 32 bytes, rows
// 2..18 a filled 17x17 disc at bits 0..16, all 8 planes of every row holding the
// same 4 bytes (the mask pre-replicated for the interleaved bitmap). Row widths
// 5,9,11,13,15,15,17,17,17,17,17,15,15,13,11,9,5 = 221 set pixels. Rows 19..35
// are not picture: they are the per-frame shift scratch the draw routine writes
// into. Each table sprite's own `index != 0` footprint IS exactly this disc
// (check 6), so the mask is a cross-check rather than extra data — it ships
// because it is what the hardware cookie-cuts with.
//
// HOW THE ORIGINAL COMPOSITES IT. Per-frame order at h0+0x4B20 is flippers,
// erase balls, lamps, then save-and-draw balls: THE BALL IS DRAWN LAST, over the
// artwork, the lamps and the bats. Address arithmetic at $BF34-$BF52 is
//     dest = artworkBase + y*384 + 2*(x >> 4),  shift = x & 15
// with the ball object's +$12/+$14 the sprite's TOP-LEFT in whole playfield
// pixels, so the physical centre is (x+8, y+8) and there is no sub-pixel
// placement anywhere. The blit is one cookie-cut pass (BLTCON0 $0FCA, minterm
// $CA, BLTSIZE $2202 = 17 rows x 8 planes, 2 words) whose A source is the mask
// with the level's STRUCTURE bitmap removed — that is how ramps draw over the
// ball, by taking pixels out of its mask rather than redrawing anything. The two
// structure layers are descriptor +$08 (level 0) and +$20 (level 1), h2+52080
// and h2+77280, and they ship in `occluders` so the runtime cannot guess wrong.
//
// ---------------------------------------------------------------------------
// THE CHECKS
// ---------------------------------------------------------------------------
// 1. SLOT.        descriptor +$54 lands in slot 6.
// 2. TAIL.        byteOffset + 544 == slot-6 length.
// 3. HEADROOM.    stored columns 17..31 are zero.
// 4. REPLICATION. all 8 planes of every one of main.bin's 36 mask rows are equal.
// 5. DISC.        mask rows 0..1 and 19..35 blank; rows 2..18 have the measured
//                 widths, are horizontally symmetric and are contiguous runs.
// 6. FOOTPRINT.   the sprite's `index != 0` set equals the mask set exactly.
// 7. PALETTE.     descriptor +$50 is the last 768 bytes of slot 3 and those bytes
//                 are byte-identical to the shipped `<id>.art.png` PLTE.
// 8. OCCLUDERS.   descriptor +$08 and +$20 land in slot 2 at 52080 and 77280.
//
// Usage:
//   node scripts/export-table-ball.mjs <segment-dir> [out-dir] [--check]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadPackage, follow, inBounds } from "./export-table-modes.mjs";

/** Descriptor offsets (byte offsets into slot 0's body). */
const HEADER_BALL_GFX = 0x54;
const HEADER_PALETTE = 0x50;
const HEADER_STRUCTURE_LEVEL0 = 0x08;
const HEADER_STRUCTURE_LEVEL1 = 0x20;

const GFX_SLOT = 6;
const ART_SLOT = 3;
const MAP_SLOT = 2;

/** The sprite: 17 display rows of 8 interleaved planes, 4 bytes each. */
const BALL_WIDTH = 17;
const BALL_HEIGHT = 17;
const STORED_WIDTH = 32;
const PLANES = 8;
const PLANE_ROW_BYTES = 4;
const ROW_BYTES = PLANES * PLANE_ROW_BYTES;
const BALL_BYTES = BALL_HEIGHT * ROW_BYTES;

/** main.bin's shared mask: 36 rows of the same 32-byte shape, disc at 2..18. */
const MASK_ROWS = 36;
const MASK_DISC_FIRST = 2;
const MASK_DISC_WIDTHS = [5, 9, 11, 13, 15, 15, 17, 17, 17, 17, 17, 15, 15, 13, 11, 9, 5];
const MASK_SET_PIXELS = 221;

/** The slot-3 palette: 256 entries of RGB at the tail of the artwork slot. */
const PALETTE_ENTRIES = 256;
const PALETTE_BYTES = PALETTE_ENTRIES * 3;

/** The two per-level structure bitmaps the mask is ANDed against. 42-byte rows. */
const STRUCTURE_ROW_BYTES = 42;
const STRUCTURE_LEVEL0 = 52080;
const STRUCTURE_LEVEL1 = 77280;

const TABLES = [
  { stem: "Table001", tableId: "law-n-justice", displayName: "Law 'n Justice" },
  { stem: "Table002", tableId: "babewatch", displayName: "BabeWatch" },
  { stem: "Table003", tableId: "extreme-sports", displayName: "Extreme Sports" },
];

const PROVENANCE = {
  sourceClass: "disk-derived-ball-sprite",
  description:
    "The 17x17 8-bitplane steel ball sprite, decoded from the operator's own AGA floppy set as " +
    "palette indices into the table's own artwork palette. Still image only: no audio, no " +
    "executable code, and no second copy of anyone's palette.",
  authorizationRequired: true,
};

// ---------------------------------------------------------------------------
// The shared mask, out of main.bin
// ---------------------------------------------------------------------------

/**
 * main.bin's 17x17 disc as one bit per pixel, 3 bytes a row.
 *
 * Read once and handed to every table: it is one bitmap, and the point of
 * checking it here is that every table's own sprite footprint must equal it.
 */
function decodeMask(mainPkg) {
  const body = mainPkg.bodies[GFX_SLOT];
  if (body === undefined || body.length !== MASK_ROWS * ROW_BYTES) {
    throw new Error(
      `main.bin slot ${GFX_SLOT} is ${body?.length ?? "absent"} bytes, expected ` +
        `${MASK_ROWS * ROW_BYTES}`,
    );
  }
  const rows = [];
  for (let row = 0; row < MASK_ROWS; row += 1) {
    const first = body.readUInt32BE(row * ROW_BYTES);
    // CHECK 4 — the mask is pre-replicated across all eight planes.
    for (let plane = 1; plane < PLANES; plane += 1) {
      const word = body.readUInt32BE(row * ROW_BYTES + plane * PLANE_ROW_BYTES);
      if (word !== first) {
        throw new Error(`main.bin mask row ${row}: plane ${plane} differs from plane 0`);
      }
    }
    rows.push(first);
  }
  // CHECK 5 — the disc, and nothing outside it.
  for (const row of [0, 1, ...Array.from({ length: MASK_ROWS - 19 }, (_, i) => 19 + i)]) {
    if (rows[row] !== 0) {
      throw new Error(`main.bin mask row ${row} is not blank; the disc is rows 2..18`);
    }
  }
  const mask = Buffer.alloc(BALL_HEIGHT * Math.ceil(BALL_WIDTH / 8));
  const rowBytes = Math.ceil(BALL_WIDTH / 8);
  let set = 0;
  for (let y = 0; y < BALL_HEIGHT; y += 1) {
    const word = rows[MASK_DISC_FIRST + y] ?? 0;
    // The disc lives in bits 0..16 of the longword; bits 17..31 are headroom.
    if ((word & 0x00007fff) !== 0) {
      throw new Error(`main.bin mask row ${MASK_DISC_FIRST + y}: ink outside columns 0..16`);
    }
    const columns = [];
    for (let x = 0; x < BALL_WIDTH; x += 1) {
      if ((word & (0x80000000 >>> x)) !== 0) {
        columns.push(x);
        mask[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
        set += 1;
      }
    }
    if (columns.length !== MASK_DISC_WIDTHS[y]) {
      throw new Error(
        `main.bin mask row ${MASK_DISC_FIRST + y} is ${columns.length} px wide, expected ` +
          `${MASK_DISC_WIDTHS[y]}`,
      );
    }
    const lo = columns[0];
    const hi = columns[columns.length - 1];
    if (hi - lo + 1 !== columns.length) {
      throw new Error(`main.bin mask row ${MASK_DISC_FIRST + y} is not one contiguous run`);
    }
    if (lo + hi !== BALL_WIDTH - 1) {
      throw new Error(
        `main.bin mask row ${MASK_DISC_FIRST + y} spans ${lo}..${hi}, which is not symmetric ` +
          `about column ${(BALL_WIDTH - 1) / 2}`,
      );
    }
  }
  if (set !== MASK_SET_PIXELS) {
    throw new Error(`main.bin mask holds ${set} set pixels, expected ${MASK_SET_PIXELS}`);
  }
  return { mask, rowBytes, setPixels: set };
}

// ---------------------------------------------------------------------------
// One table
// ---------------------------------------------------------------------------

/** The PLTE chunk of a PNG, for check 7. */
function readPlte(path) {
  const png = readFileSync(path);
  let at = 8;
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at);
    const tag = png.toString("latin1", at + 4, at + 8);
    if (tag === "PLTE") return png.subarray(at + 8, at + 8 + length);
    at += 12 + length;
  }
  throw new Error(`${path}: no PLTE chunk; the artwork is not a palette PNG`);
}

function decode(pkg, table, shared, outDir) {
  const descriptor = { hunk: 0, offset: 0 };

  // CHECK 1 / 2 — the sprite is the tail of slot 6.
  const gfx = follow(pkg, descriptor, HEADER_BALL_GFX);
  if (gfx === null || gfx.hunk !== GFX_SLOT) {
    throw new Error(`descriptor +0x54 does not land in slot ${GFX_SLOT}`);
  }
  const body = pkg.bodies[GFX_SLOT];
  if (gfx.offset + BALL_BYTES !== body.length) {
    throw new Error(
      `the sprite at ${gfx.offset} + ${BALL_BYTES} is not the tail of the ${body.length}-byte ` +
        `slot ${GFX_SLOT}`,
    );
  }
  if (!inBounds(pkg, gfx, BALL_BYTES)) throw new Error("the sprite runs out of slot 6");
  const raw = body.subarray(gfx.offset, gfx.offset + BALL_BYTES);

  // De-interleave to one palette index per pixel.
  const stored = new Uint8Array(BALL_HEIGHT * STORED_WIDTH);
  for (let y = 0; y < BALL_HEIGHT; y += 1) {
    for (let plane = 0; plane < PLANES; plane += 1) {
      const word = raw.readUInt32BE(y * ROW_BYTES + plane * PLANE_ROW_BYTES);
      if (word === 0) continue;
      const bit = 1 << plane;
      for (let x = 0; x < STORED_WIDTH; x += 1) {
        if ((word & (0x80000000 >>> x)) !== 0) stored[y * STORED_WIDTH + x] |= bit;
      }
    }
  }
  // CHECK 3 — columns 17..31 are the blitter's shift headroom, not picture.
  for (let y = 0; y < BALL_HEIGHT; y += 1) {
    for (let x = BALL_WIDTH; x < STORED_WIDTH; x += 1) {
      if (stored[y * STORED_WIDTH + x] !== 0) {
        throw new Error(`the sprite has ink at stored column ${x}, row ${y}; that is headroom`);
      }
    }
  }
  const pixels = Buffer.alloc(BALL_WIDTH * BALL_HEIGHT);
  for (let y = 0; y < BALL_HEIGHT; y += 1) {
    for (let x = 0; x < BALL_WIDTH; x += 1) {
      pixels[y * BALL_WIDTH + x] = stored[y * STORED_WIDTH + x] ?? 0;
    }
  }

  // CHECK 6 — the sprite's own footprint IS the shared disc, with no exceptions.
  let disagreements = 0;
  for (let y = 0; y < BALL_HEIGHT; y += 1) {
    for (let x = 0; x < BALL_WIDTH; x += 1) {
      const inMask =
        ((shared.mask[y * shared.rowBytes + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0;
      const inSprite = pixels[y * BALL_WIDTH + x] !== 0;
      if (inMask !== inSprite) disagreements += 1;
    }
  }
  if (disagreements > 0) {
    throw new Error(
      `${disagreements} of ${BALL_WIDTH * BALL_HEIGHT} pixels disagree between the sprite's ` +
        `footprint and main.bin's mask`,
    );
  }

  // CHECK 7 — the palette the sprite draws through is the one already shipped.
  const palette = follow(pkg, descriptor, HEADER_PALETTE);
  if (palette === null || palette.hunk !== ART_SLOT) {
    throw new Error(`descriptor +0x50 does not land in slot ${ART_SLOT}`);
  }
  const artBody = pkg.bodies[ART_SLOT];
  if (palette.offset + PALETTE_BYTES !== artBody.length) {
    throw new Error(
      `the palette at ${palette.offset} + ${PALETTE_BYTES} is not the tail of the ` +
        `${artBody.length}-byte slot ${ART_SLOT}`,
    );
  }
  const artPath = join(outDir, `${table.tableId}.art.png`);
  if (!existsSync(artPath)) {
    throw new Error(`no ${artPath}; export the artwork first — check 7 needs its palette`);
  }
  const plte = readPlte(artPath);
  const disk = artBody.subarray(palette.offset, palette.offset + PALETTE_BYTES);
  if (plte.length !== PALETTE_BYTES || !plte.equals(disk)) {
    throw new Error(
      `the shipped ${table.tableId}.art.png palette is not the slot-3 palette the ball draws ` +
        `through; the two have drifted`,
    );
  }

  // CHECK 8 — the two per-level structure bitmaps the mask is cut against.
  const occluders = {};
  for (const [name, delta, expected] of [
    ["level0", HEADER_STRUCTURE_LEVEL0, STRUCTURE_LEVEL0],
    ["level1", HEADER_STRUCTURE_LEVEL1, STRUCTURE_LEVEL1],
  ]) {
    const at = follow(pkg, descriptor, delta);
    if (at === null || at.hunk !== MAP_SLOT || at.offset !== expected) {
      throw new Error(
        `descriptor +0x${delta.toString(16)} is ${at === null ? "not relocated" : `h${at.hunk}+${at.offset}`}, ` +
          `expected h${MAP_SLOT}+${expected}`,
      );
    }
    occluders[name] = { slot: at.hunk, byteOffset: at.offset };
  }

  const indicesUsed = [...new Set(pixels)].filter((index) => index !== 0).sort((a, b) => a - b);

  return {
    byteOffset: gfx.offset,
    sha256: createHash("sha256").update(raw).digest("hex"),
    pixels,
    indicesUsed,
    occluders,
  };
}

function buildDocument(table, decoded, shared) {
  return {
    schema: "pinball-illusions/table-ball/v1",
    tableId: table.tableId,
    displayName: table.displayName,
    provenance: PROVENANCE,
    width: BALL_WIDTH,
    height: BALL_HEIGHT,
    /** The physics centre inside the sprite: the true centre pixel of a 17x17 disc. */
    anchor: { centreX: (BALL_WIDTH - 1) / 2, centreY: (BALL_HEIGHT - 1) / 2 },
    source: {
      slot: GFX_SLOT,
      byteOffset: decoded.byteOffset,
      byteLength: BALL_BYTES,
      planes: PLANES,
      rowBytes: ROW_BYTES,
      storedWidth: STORED_WIDTH,
      sha256: decoded.sha256,
    },
    mask: {
      source: "main.bin slot 6, bytes 0x40..0x260",
      setPixels: shared.setPixels,
      rowBytes: shared.rowBytes,
      rows: shared.mask.toString("base64"),
    },
    pixels: decoded.pixels.toString("base64"),
    indicesUsed: decoded.indicesUsed,
    occluders: { ...decoded.occluders, rowBytes: STRUCTURE_ROW_BYTES },
  };
}

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const segDir = positional[0];
  const outDir = positional[1] ?? "public/generated/tables";

  if (segDir === undefined) {
    console.error("usage: node scripts/export-table-ball.mjs <segment-dir> [out-dir] [--check]");
    return 1;
  }
  if (!existsSync(segDir)) {
    console.error(`segment directory not found: ${segDir}`);
    return 1;
  }
  if (!check) mkdirSync(outDir, { recursive: true });

  console.log(check ? "checking table balls" : "exporting table balls");
  let failures = 0;
  let shared;
  try {
    shared = decodeMask(loadPackage(segDir, "main"));
    console.log(
      `  ${" ".repeat(15)}  shared mask: ${shared.setPixels} px, rows ` +
        `${MASK_DISC_WIDTHS.join(",")}`,
    );
  } catch (error) {
    console.error(`  main.bin: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  for (const table of TABLES) {
    let decoded;
    try {
      decoded = decode(loadPackage(segDir, table.stem), table, shared, outDir);
    } catch (error) {
      console.error(`  ${table.tableId.padStart(15)}: ${error instanceof Error ? error.message : error}`);
      failures += 1;
      continue;
    }

    const json = JSON.stringify(buildDocument(table, decoded, shared));
    const out = join(outDir, `${table.tableId}.ball.json`);
    if (check) {
      const existing = existsSync(out) ? readFileSync(out, "utf8") : null;
      if (existing === json) {
        console.log(`  ${table.tableId.padStart(15)}: identical to ${out}`);
      } else {
        console.error(
          `  ${table.tableId.padStart(15)}: DIFFERS from ${out}` +
            (existing === null ? " (file missing)" : ` (${existing.length} vs ${json.length} bytes)`),
        );
        failures += 1;
      }
    } else {
      writeFileSync(out, json, "utf8");
      console.log(`  ${table.tableId.padStart(15)}: ${json.length.toLocaleString()} bytes -> ${out}`);
    }
    console.log(
      `  ${" ".repeat(15)}  slot 6 +${decoded.byteOffset}, sha256 ${decoded.sha256.slice(0, 16)}, ` +
        `${decoded.indicesUsed.length} distinct palette indices, footprint == the 221 px disc`,
    );
  }

  if (failures > 0) {
    console.error(`${failures} table(s) ${check ? "differ or are missing" : "could not be exported"}`);
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
