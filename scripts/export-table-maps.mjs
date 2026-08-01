#!/usr/bin/env node
// Decodes slot 2 of each table package into the run-length map documents under
// public/generated/tables/. Run locally, where the operator's own disks live;
// the JSON it writes is what ships.
//
// Slot 2 is NOT four equal bitplanes. It is four independent 1-bit layers whose
// row counts differ, and the layer table below is the whole point of this file:
//
//   bit 0 (1)  level-0 collision line     offset      0   620 rows
//   bit 1 (2)  level-1 collision line     offset  26040   620 rows
//   bit 2 (4)  level-0 structure area     offset  52080   600 rows
//   bit 3 (8)  level-1 structure area     offset  77280   600 rows
//
// THE PHASE MATTERS, exactly as it does for slot 3 in export-table-art.mjs.
// The segment file is 102,488 bytes and the big-endian u32 at offset 0 reads
// 102,480, so there are 8 bytes that are not payload. The natural guess is that
// all 8 sit at the front (length word + 4 unused) and that is WRONG: the payload
// begins at byte 4, immediately after the length word, and the 4 spare bytes sit
// at the END. Reading from byte 8 takes the right number of bytes four too late,
// which slides every 42-byte layer row by 4 bytes — exactly 32 pixels at 1 bpp —
// and wraps the leftmost 32 px of each row round onto the end of the row above.
//
// The proof is in the bytes. Table002.seg02.bin bytes 4..7 are FF FF FF FF, the
// map's top border line and unmistakably data, while its last 4 bytes are
// 00 00 00 00; Table003 likewise ends 07 FF FF FF 00 00 00 00. Independently,
// sweeping the decoded map against the slot-3 artwork's edge field peaks at
// dx=0, dy=0 with the payload framed at 4 (lift 2.17 / 2.06 / 2.02) and is flat
// near zero when framed at 8, where the same peak reappears out at dx=+32.
// See _pinball_research/illusions/reg_phase.py, which runs both framings side by
// side, and the matching header note in export-table-art.mjs: BOTH slots put
// their spare 4 bytes at the end. `assertAlignment` below cannot catch this —
// the 32 px slide is horizontal and hits every layer equally, so containment
// stays high. Only the artwork sweep catches it.
//
// Every layer is 42 bytes (336 px) per row. An earlier decode read this as four
// equal 610-row planes at 0 / 25620 / 51240 / 76860, which slides bit 2 twenty
// rows low and bits 1 and 3 ten rows low and makes the 16 union values mean
// nothing. Nothing structural catches that: both partitions total exactly
// 102,480 bytes AND both tile the payload contiguously, so neither a size check
// nor `assertLayout` below can tell them apart. The check that CAN is
// `assertAlignment`: bit 0 is a collision outline of the body in bit 2, so
// almost every bit-0 pixel must also carry bit 2. Correctly aligned that runs
// 0.98 / 0.97 / 0.98; ten or twenty rows out it collapses to about 0.6. That is
// the only cheap self-check here that is sensitive to the actual bug.
//
// The layer roles, and the evidence that these are the right offsets, are in
// src/game/materials.ts (SLOT2_PLANE_BASES) and docs/DISK_ANALYSIS.md. Keep the
// two tables in step; nothing mechanical can, because this script must run
// without a TypeScript loader.
//
// Usage:
//   node scripts/export-table-maps.mjs <segment-dir> [out-dir] [--check]
//
// <segment-dir> holds <stem>.seg02.bin for each table. --check decodes and
// compares against the files already in <out-dir> without writing, which is how
// you confirm the shipped maps are still exactly what the disks say.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** Playfield dimensions. Must match PLAYFIELD_WIDTH/HEIGHT in src/game/contracts.ts. */
const WIDTH = 336;
const HEIGHT = 600;

/** Bytes per layer row: 336 pixels at 1 bit per pixel. */
const STRIDE = WIDTH / 8;

/**
 * Slot 2 opens with a big-endian u32 payload length and NOTHING else; the
 * segment's 4 spare bytes are at the END, not here. 4, not 8 — see the header
 * comment. This matches PHASE in export-table-art.mjs.
 */
const PREAMBLE = 4;

/** Bytes of slack after the payload. Present, and must be exactly this many. */
const TRAILER = 4;

/** The four layers, in bit order. `bit` is the value ORed into the pixel index. */
const LAYERS = [
  { bit: 0x1, name: "level-0 collision line", offset: 0, rows: 620 },
  { bit: 0x2, name: "level-1 collision line", offset: 26040, rows: 620 },
  { bit: 0x4, name: "level-0 structure area", offset: 52080, rows: 600 },
  { bit: 0x8, name: "level-1 structure area", offset: 77280, rows: 600 },
];

const TABLES = [
  { stem: "Table001", tableId: "law-n-justice", displayName: "Law 'n Justice" },
  { stem: "Table002", tableId: "babewatch", displayName: "BabeWatch" },
  { stem: "Table003", tableId: "extreme-sports", displayName: "Extreme Sports" },
];

const PROVENANCE = {
  sourceClass: "disk-derived-collision-geometry",
  description:
    "Per-pixel material indices decoded from the operator's own AGA floppy set. " +
    "Functional collision geometry only: no artwork, audio or executable code.",
  authorizationRequired: true,
};

/**
 * Rejects any layer table that does not tile the payload exactly.
 *
 * Catches a mistyped offset or row count, and nothing subtler: the superseded
 * equal-plane layout tiles the payload just as exactly. See `assertAlignment`
 * for the check that is sensitive to which layer landed where.
 */
function assertLayout(payloadLength) {
  let expected = 0;
  for (const layer of LAYERS) {
    if (layer.offset !== expected) {
      throw new Error(
        `layer "${layer.name}" starts at ${layer.offset}, but the previous layer ends at ${expected}; ` +
          `the four layers must tile the payload with no gap or overlap`,
      );
    }
    if (layer.rows < HEIGHT) {
      throw new Error(
        `layer "${layer.name}" has ${layer.rows} rows, fewer than the ${HEIGHT}-row physics area`,
      );
    }
    expected += layer.rows * STRIDE;
  }
  if (expected !== payloadLength) {
    throw new Error(`layers total ${expected} bytes, but the slot-2 payload is ${payloadLength}`);
  }
}

/**
 * Expands one slot-2 segment into one material index per pixel, row-major.
 *
 * Only the first HEIGHT rows of each layer are decoded. Layers 0 and 1 carry 20
 * surplus rows below the physics area, which the engine's collision blit reads
 * as look-ahead (it fetches 17 rows starting at row y, and y may be 600) but
 * which are not playfield. `surplusBits` reports how much is set down there: it
 * should be near zero, and would not be if the offsets were wrong.
 */
function decode(bytes) {
  const declared =
    (bytes[0] << 24 >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
  if (bytes.length !== PREAMBLE + declared + TRAILER) {
    throw new Error(
      `segment is ${bytes.length} bytes; the length word declares ${declared}, so with a ` +
        `${PREAMBLE}-byte preamble and a ${TRAILER}-byte trailer it should be ` +
        `${PREAMBLE + declared + TRAILER}`,
    );
  }
  const payload = bytes.subarray(PREAMBLE, PREAMBLE + declared);

  // The slack is at the end and is zero there. This is a genuine phase check on
  // two of the three tables: framed one word too late, the four bytes treated as
  // slack would be bytes 4..7, which on Table002 are FF FF FF FF (the map's top
  // border) and on Table003 are part of a run of set bits. It is NOT sufficient
  // on its own — Table001's bytes 4..7 happen to be zero too — which is why the
  // artwork registration sweep, not this, is the authority. See the header.
  for (let i = PREAMBLE + declared; i < bytes.length; i += 1) {
    if (bytes[i] !== 0) {
      throw new Error(
        `trailing slack byte ${i} is 0x${bytes[i].toString(16)}, not zero; the payload does not ` +
          `end where PREAMBLE=${PREAMBLE} says it does`,
      );
    }
  }

  assertLayout(payload.length);

  const pixels = new Uint8Array(WIDTH * HEIGHT);
  const surplusBits = [];

  for (const layer of LAYERS) {
    for (let y = 0; y < HEIGHT; y += 1) {
      const rowBase = layer.offset + y * STRIDE;
      const pixelBase = y * WIDTH;
      for (let bx = 0; bx < STRIDE; bx += 1) {
        const byte = payload[rowBase + bx];
        if (byte === 0) continue;
        const x0 = pixelBase + bx * 8;
        for (let b = 0; b < 8; b += 1) {
          if (byte & (0x80 >> b)) pixels[x0 + b] |= layer.bit;
        }
      }
    }

    let set = 0;
    for (let i = layer.offset + HEIGHT * STRIDE; i < layer.offset + layer.rows * STRIDE; i += 1) {
      set += popcount(payload[i]);
    }
    surplusBits.push({ name: layer.name, rows: layer.rows - HEIGHT, set });
  }

  return { pixels, surplusBits };
}

/**
 * Fails the export if the decoded layers are out of vertical registration.
 *
 * Bit 0 is a one-pixel collision outline drawn around the bodies in bit 2, so a
 * correctly aligned decode has nearly every bit-0 pixel sitting inside the bit-2
 * mask. Measured on the three shipped tables that containment is 0.982 / 0.966 /
 * 0.976; under the superseded equal-plane bases it falls to 0.68 / 0.66 / 0.58,
 * because the outline is then twenty rows off its own body. The 0.90 threshold
 * sits in the empty middle of that gap.
 *
 * This is the one assertion in this file that would have caught the original
 * bug, so it is fatal rather than a warning.
 */
const MIN_OUTLINE_CONTAINMENT = 0.9;

function assertAlignment(pixels) {
  let line = 0;
  let inside = 0;
  for (const value of pixels) {
    if ((value & 0x1) === 0) continue;
    line += 1;
    if ((value & 0x4) !== 0) inside += 1;
  }
  if (line === 0) {
    throw new Error("no level-0 collision line decoded at all");
  }
  const containment = inside / line;
  if (containment < MIN_OUTLINE_CONTAINMENT) {
    throw new Error(
      `only ${(containment * 100).toFixed(1)}% of the level-0 collision line lies inside the ` +
        `level-0 structure area, below the ${MIN_OUTLINE_CONTAINMENT * 100}% floor. The layers are ` +
        `vertically misaligned — check the offsets in LAYERS.`,
    );
  }
  return containment;
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
 * Run-length encodes one row as flat [inclusive_end_x, material] pairs, the
 * first run starting at x=0 and the last ending at WIDTH-1. This is the encoding
 * src/game/table-map.ts expands, and it is lossless.
 */
function toRuns(pixels, y) {
  const base = y * WIDTH;
  const runs = [];
  let current = pixels[base];
  for (let x = 1; x < WIDTH; x += 1) {
    const value = pixels[base + x];
    if (value !== current) {
      runs.push(x - 1, current);
      current = value;
    }
  }
  runs.push(WIDTH - 1, current);
  return runs;
}

/** Counts each index present. Zero-count indices are omitted, as the loader expects. */
function histogramOf(pixels) {
  const counts = new Uint32Array(16);
  for (const value of pixels) counts[value] += 1;
  const histogram = {};
  for (let index = 0; index < 16; index += 1) {
    if (counts[index] > 0) histogram[String(index)] = counts[index];
  }
  return histogram;
}

function buildDocument(table, pixels) {
  const rows = [];
  for (let y = 0; y < HEIGHT; y += 1) rows.push(toRuns(pixels, y));
  return {
    schema: "pinball-illusions/table-map/v1",
    tableId: table.tableId,
    displayName: table.displayName,
    width: WIDTH,
    height: HEIGHT,
    provenance: PROVENANCE,
    materialHistogram: histogramOf(pixels),
    rows,
  };
}

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const segDir = positional[0];
  const outDir = positional[1] ?? "public/generated/tables";

  if (segDir === undefined) {
    console.error("usage: node scripts/export-table-maps.mjs <segment-dir> [out-dir] [--check]");
    return 1;
  }
  if (!existsSync(segDir)) {
    console.error(`segment directory not found: ${segDir}`);
    return 1;
  }
  if (!check) mkdirSync(outDir, { recursive: true });

  console.log(check ? "checking table maps" : "exporting table maps");
  let failures = 0;

  for (const table of TABLES) {
    const seg = join(segDir, `${table.stem}.seg02.bin`);
    if (!existsSync(seg)) {
      console.error(`  ${table.tableId}: ${table.stem}.seg02.bin missing, skipped`);
      failures += 1;
      continue;
    }

    // A layout or alignment failure is fatal for this table but must not hide
    // the other two: an offset typo usually breaks all three the same way, and
    // seeing that is the diagnosis.
    let pixels;
    let surplusBits;
    let containment;
    try {
      ({ pixels, surplusBits } = decode(readFileSync(seg)));
      containment = assertAlignment(pixels);
    } catch (error) {
      console.error(`  ${table.tableId.padStart(15)}: ${error instanceof Error ? error.message : error}`);
      failures += 1;
      continue;
    }

    const doc = buildDocument(table, pixels);
    const json = JSON.stringify(doc);
    const out = join(outDir, `${table.tableId}.map.json`);

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
      const runs = doc.rows.reduce((sum, row) => sum + row.length / 2, 0);
      console.log(
        `  ${table.tableId.padStart(15)}: ${runs.toLocaleString()} runs -> ${json.length.toLocaleString()} bytes`,
      );
    }

    const surplus = surplusBits
      .filter((layer) => layer.rows > 0)
      .map((layer) => `${layer.name}: ${layer.set} set bits in ${layer.rows} surplus rows`)
      .join(", ");
    console.log(
      `  ${" ".repeat(15)}  outline containment ${(containment * 100).toFixed(1)}% (floor ${MIN_OUTLINE_CONTAINMENT * 100}%)`,
    );
    console.log(`  ${" ".repeat(15)}  ${surplus}`);
    console.log(
      `  ${" ".repeat(15)}  histogram ${Object.entries(doc.materialHistogram)
        .map(([index, count]) => `${index}=${count}`)
        .join(" ")}`,
    );
  }

  if (failures > 0) {
    console.error(`${failures} table(s) ${check ? "differ or are missing" : "could not be exported"}`);
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
