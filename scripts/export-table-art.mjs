#!/usr/bin/env node
// Decodes slot 3 of each table package into the shipped playfield artwork under
// public/generated/tables/. Run locally, where the operator's own disks live;
// the PNG and manifest it writes are what ship. Sibling of
// scripts/export-table-maps.mjs, which does the same job for slot 2 geometry.
//
// Slot 3 is a single 336x600 256-colour AGA playfield plus its palette, stored
// as 8 interleaved bitplanes. The layout constants below are the whole point of
// this file:
//
//   offset 0        u32 big-endian = 238848, the payload length
//   offset 4        payload: 622 rows x 384 bytes  (PHASE is 4, not 8 — see below)
//                     row = 8 planes x 48 bytes; only the first 42 bytes
//                     (336 px) of each plane row carry image, bytes 42..47 are
//                     slack and are all but always zero
//                     rows   0..599  the playfield
//                     rows 600..619  blank
//                     the final 768 bytes  256 RGB palette entries
//   offset 238852   4 trailing zero bytes, unused
//
// THE PHASE MATTERS. Every other segment in this set opens with an 8-byte
// preamble (length word + 4 unused), so framing the rows at 8 is the natural
// guess and it is wrong: it puts the 6 slack bytes in the MIDDLE of every plane
// row and wraps the leftmost 32 pixels round to x=352..383 with their bitplanes
// rotated by one, which draws a black column through the middle of the picture.
// The 4 unused bytes of this segment sit at the END, not after the length word.
// `assertPhase` below is what catches that, and it is the only check here that
// is sensitive to the actual bug — see its comment.
//
// The plane bit order is LSB-first: plane 0 contributes bit 0. An independent
// hand-written overlay that ordered the planes the other way produced correct
// shapes with wrong colours. The reference decode, and the source of every
// constant here, is _pinball_research/illusions/art.py; keep the two in step.
//
// Usage:
//   node scripts/export-table-art.mjs <segment-dir> [out-dir] [--check]
//
// <segment-dir> holds <stem>.seg03.bin for each table. --check decodes and
// compares against the files already in <out-dir> without writing, which is how
// you confirm the shipped artwork is still exactly what the disks say.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

/** Playfield dimensions. Must match PLAYFIELD_WIDTH/HEIGHT in src/game/contracts.ts. */
const WIDTH = 336;
const HEIGHT = 600;

/** Bytes per interleaved row: 8 planes of 48 bytes. */
const ROW_BYTES = 384;
const PLANE_BYTES = 48;
/** Of each 48-byte plane row only 42 bytes (336 px) are image; the rest is slack. */
const USED_BYTES = WIDTH / 8;
const PLANES = 8;

/** Row phase. 4, not 8. See the header comment and `assertPhase`. */
const PHASE = 4;
const PAYLOAD = 238848;
const PALETTE_LEN = 768;
const PALETTE_ENTRIES = PALETTE_LEN / 3;

/** Rows in the payload: HEIGHT of playfield, then BLANK_ROWS of nothing. */
const TOTAL_ROWS = 622;
const BLANK_ROWS = 20;

const TABLES = [
  { stem: "Table001", tableId: "law-n-justice", displayName: "Law 'n Justice" },
  { stem: "Table002", tableId: "babewatch", displayName: "BabeWatch" },
  { stem: "Table003", tableId: "extreme-sports", displayName: "Extreme Sports" },
];

// Same shape as the PROVENANCE block in export-table-maps.mjs, with the class
// that describes what this actually is. check-public-build.mjs keys off
// `sourceClass`, and both classes are gated by the same authorization variable.
const PROVENANCE = {
  sourceClass: "disk-derived-playfield-artwork",
  description:
    "256-colour playfield artwork and palette decoded from the operator's own AGA floppy set. " +
    "Still image only: no audio, no executable code.",
  authorizationRequired: true,
};

/**
 * Rejects a segment whose framing does not match the documented layout.
 *
 * Catches a truncated or padded file and nothing subtler: a wrong PHASE passes
 * this untouched, because the payload is the same bytes either way.
 */
function assertLayout(bytes) {
  const declared = bytes.readUInt32BE(0);
  if (declared !== PAYLOAD) {
    throw new Error(`preamble declares ${declared} payload bytes, expected ${PAYLOAD}`);
  }
  if (bytes.length < PHASE + PAYLOAD) {
    throw new Error(
      `file is ${bytes.length} bytes, too short for ${PAYLOAD} bytes of payload at offset ${PHASE}`,
    );
  }
  if (TOTAL_ROWS * ROW_BYTES !== PAYLOAD) {
    throw new Error(`${TOTAL_ROWS} rows of ${ROW_BYTES} bytes is not the ${PAYLOAD}-byte payload`);
  }
  if (HEIGHT + BLANK_ROWS + 2 !== TOTAL_ROWS) {
    throw new Error(
      `${HEIGHT} image rows + ${BLANK_ROWS} blank rows + 2 palette rows is not ${TOTAL_ROWS}`,
    );
  }
}

/**
 * Fails the export if the rows are framed at the wrong offset.
 *
 * At the correct phase the last 6 bytes of every 48-byte plane row are slack
 * that the artist never touched, so they are essentially all zero: measured
 * across the three shipped tables, 0.38% / 0.29% / 0.31% of those 29,856 bytes
 * are non-zero. Frame the rows anywhere else and those byte positions land on
 * real picture instead, and occupancy jumps to 20-50% (phase 0: 47%, phase 2:
 * 24%, phase 6: 23%, phase 8: 46%). The 5% ceiling sits in the empty middle of
 * that gap.
 *
 * This is the one assertion in this file that would have caught the phase bug,
 * so it is fatal rather than a warning. Note that the obvious alternative — "do
 * the 20 blank rows decode to zero?" — is worthless here: they are zero at phase
 * 8 too, and at phase 0, 2 and 6.
 */
const MAX_SLACK_OCCUPANCY = 0.05;

function assertPhase(bytes) {
  let total = 0;
  let set = 0;
  for (let row = 0; row < TOTAL_ROWS; row += 1) {
    for (let plane = 0; plane < PLANES; plane += 1) {
      const base = PHASE + row * ROW_BYTES + plane * PLANE_BYTES;
      for (let bx = USED_BYTES; bx < PLANE_BYTES; bx += 1) {
        total += 1;
        if (bytes[base + bx] !== 0) set += 1;
      }
    }
  }
  const occupancy = set / total;
  if (occupancy > MAX_SLACK_OCCUPANCY) {
    throw new Error(
      `${(occupancy * 100).toFixed(1)}% of the ${total} slack bytes past x=${WIDTH} are non-zero, ` +
        `above the ${MAX_SLACK_OCCUPANCY * 100}% ceiling. The rows are framed at the wrong offset — ` +
        `PHASE is ${PHASE} for this segment, not the usual 8.`,
    );
  }
  return occupancy;
}

/**
 * Expands one slot-3 segment into one palette index per pixel, row-major, plus
 * the 256-entry RGB palette.
 *
 * Only the first HEIGHT rows are decoded. `blankBits` reports how much is set in
 * the 20 surplus rows below the playfield — slot 2 layers 0 and 1 carry the same
 * 20-row surplus — and should be zero.
 */
function decode(bytes) {
  assertLayout(bytes);
  const slackOccupancy = assertPhase(bytes);

  const pixels = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const rowBase = PHASE + y * ROW_BYTES;
    const pixelBase = y * WIDTH;
    for (let plane = 0; plane < PLANES; plane += 1) {
      const planeBase = rowBase + plane * PLANE_BYTES;
      const bit = 1 << plane;
      for (let bx = 0; bx < USED_BYTES; bx += 1) {
        const byte = bytes[planeBase + bx];
        if (byte === 0) continue;
        const x0 = pixelBase + bx * 8;
        for (let b = 0; b < 8; b += 1) {
          if (byte & (0x80 >> b)) pixels[x0 + b] |= bit;
        }
      }
    }
  }

  let blankBits = 0;
  for (let i = PHASE + HEIGHT * ROW_BYTES; i < PHASE + (HEIGHT + BLANK_ROWS) * ROW_BYTES; i += 1) {
    blankBits += popcount(bytes[i]);
  }

  const end = PHASE + PAYLOAD;
  const palette = Buffer.from(bytes.subarray(end - PALETTE_LEN, end));
  if (palette.length !== PALETTE_LEN) {
    throw new Error(`palette is ${palette.length} bytes, expected ${PALETTE_LEN}`);
  }

  return { pixels, palette, slackOccupancy, blankBits };
}

function popcount(byte) {
  let n = byte;
  let count = 0;
  while (n !== 0) {
    n &= n - 1;
    count += 1;
  }
  return count;
}

/**
 * Fails the export if the decode produced something that cannot be a playfield.
 *
 * Weak by design — a wrong phase sails through it, which is why `assertPhase`
 * exists — but it does catch a segment that is blank, or one where the palette
 * did not land where we think it did.
 */
function assertPicture(pixels, palette) {
  const used = new Set(pixels);
  if (used.size < 32) {
    throw new Error(`only ${used.size} distinct palette indices in the playfield; this is not artwork`);
  }
  let nonBlack = 0;
  for (let i = 0; i < PALETTE_LEN; i += 1) if (palette[i] !== 0) nonBlack += 1;
  if (nonBlack === 0) {
    throw new Error("the 256-entry palette is entirely black; it is not at the end of the payload");
  }
  return used.size;
}

/**
 * Writes an 8-bit indexed PNG: the original palette indices in IDAT and the
 * original 256-entry palette in PLTE, so the shipped file is the disk's own
 * pixels and its own colours rather than a re-quantisation of them.
 *
 * Filter 0 on every row, deflate at a fixed level: byte-for-byte reproducible,
 * which is what `--check` compares.
 */
function encodeIndexedPng(pixels, palette) {
  const raw = Buffer.alloc(HEIGHT * (1 + WIDTH));
  for (let y = 0; y < HEIGHT; y += 1) {
    const at = y * (1 + WIDTH);
    raw[at] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * WIDTH, WIDTH).copy(raw, at + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // colour type: indexed
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("PLTE", palette),
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

/**
 * The manifest. It is the JSON half of the pair, and it is what
 * check-public-build.mjs reads: the PNG itself has nowhere to carry provenance,
 * so the manifest declares the image by name and by digest and the guard refuses
 * any image it cannot account for.
 */
function buildManifest(table, png, palette, indicesUsed) {
  let paletteUsed = 0;
  for (let i = 0; i < PALETTE_ENTRIES; i += 1) {
    if (palette[i * 3] !== 0 || palette[i * 3 + 1] !== 0 || palette[i * 3 + 2] !== 0) paletteUsed += 1;
  }
  return {
    schema: "pinball-illusions/table-art/v1",
    tableId: table.tableId,
    displayName: table.displayName,
    width: WIDTH,
    height: HEIGHT,
    image: {
      file: `${table.tableId}.art.png`,
      format: "png-indexed-8bit",
      byteLength: png.length,
      sha256: sha256(png),
    },
    palette: {
      entries: PALETTE_ENTRIES,
      nonBlackEntries: paletteUsed,
      indicesUsed,
      sha256: sha256(palette),
    },
    provenance: PROVENANCE,
  };
}

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const segDir = positional[0];
  const outDir = positional[1] ?? "public/generated/tables";

  if (segDir === undefined) {
    console.error("usage: node scripts/export-table-art.mjs <segment-dir> [out-dir] [--check]");
    return 1;
  }
  if (!existsSync(segDir)) {
    console.error(`segment directory not found: ${segDir}`);
    return 1;
  }
  if (!check) mkdirSync(outDir, { recursive: true });

  console.log(check ? "checking table art" : "exporting table art");
  let failures = 0;

  for (const table of TABLES) {
    const seg = join(segDir, `${table.stem}.seg03.bin`);
    if (!existsSync(seg)) {
      console.error(`  ${table.tableId}: ${table.stem}.seg03.bin missing, skipped`);
      failures += 1;
      continue;
    }

    // A layout or phase failure is fatal for this table but must not hide the
    // other two: a framing mistake breaks all three the same way, and seeing
    // that is the diagnosis.
    let decoded;
    let indicesUsed;
    try {
      decoded = decode(readFileSync(seg));
      indicesUsed = assertPicture(decoded.pixels, decoded.palette);
    } catch (error) {
      console.error(
        `  ${table.tableId.padStart(15)}: ${error instanceof Error ? error.message : error}`,
      );
      failures += 1;
      continue;
    }

    const png = encodeIndexedPng(decoded.pixels, decoded.palette);
    const manifest = buildManifest(table, png, decoded.palette, indicesUsed);
    const json = JSON.stringify(manifest);
    const pngPath = join(outDir, `${table.tableId}.art.png`);
    const jsonPath = join(outDir, `${table.tableId}.art.json`);

    if (check) {
      const existingPng = existsSync(pngPath) ? readFileSync(pngPath) : null;
      const existingJson = existsSync(jsonPath) ? readFileSync(jsonPath, "utf8") : null;
      const pngSame = existingPng !== null && existingPng.equals(png);
      const jsonSame = existingJson === json;
      if (pngSame && jsonSame) {
        console.log(`  ${table.tableId.padStart(15)}: identical to ${pngPath}`);
      } else {
        if (!pngSame) {
          console.error(
            `  ${table.tableId.padStart(15)}: DIFFERS from ${pngPath}` +
              (existingPng === null
                ? " (file missing)"
                : ` (${existingPng.length} vs ${png.length} bytes, sha256 ` +
                  `${sha256(existingPng).slice(0, 12)} vs ${manifest.image.sha256.slice(0, 12)})`),
          );
        }
        if (!jsonSame) {
          console.error(
            `  ${table.tableId.padStart(15)}: DIFFERS from ${jsonPath}` +
              (existingJson === null ? " (file missing)" : ""),
          );
        }
        failures += 1;
      }
    } else {
      writeFileSync(pngPath, png);
      writeFileSync(jsonPath, json, "utf8");
      console.log(
        `  ${table.tableId.padStart(15)}: ${WIDTH}x${HEIGHT}, ${indicesUsed} indices -> ` +
          `${png.length.toLocaleString()} bytes`,
      );
    }

    console.log(
      `  ${" ".repeat(15)}  slack occupancy ${(decoded.slackOccupancy * 100).toFixed(2)}% ` +
        `(ceiling ${MAX_SLACK_OCCUPANCY * 100}%)`,
    );
    console.log(
      `  ${" ".repeat(15)}  ${decoded.blankBits} set bits in the ${BLANK_ROWS} blank rows below the playfield`,
    );
    console.log(
      `  ${" ".repeat(15)}  palette ${manifest.palette.nonBlackEntries}/${PALETTE_ENTRIES} non-black, ` +
        `sha256 ${manifest.image.sha256.slice(0, 16)}`,
    );
  }

  if (failures > 0) {
    console.error(`${failures} table(s) ${check ? "differ or are missing" : "could not be exported"}`);
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
