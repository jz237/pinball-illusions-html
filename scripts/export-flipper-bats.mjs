#!/usr/bin/env node
// Decodes the FLIPPER BAT POSE BANK out of `pkg/flipdat1.bin`, and the per-table
// flipper records that say which poses each bat uses, into the single shared
// document `public/generated/flipper-bats.json`. Run locally, where the
// operator's own disks live; the JSON it writes is what ships. Sibling of
// scripts/export-table-lamps.mjs, whose package loader and relocation follower
// it imports for the record half.
//
// ---------------------------------------------------------------------------
// WHAT flipdat1.bin IS — AND THE ONE THING THIS PROJECT HAD WRONG ABOUT IT
// ---------------------------------------------------------------------------
// A raw 136,288-byte file, no container and no compression, SHARED BY ALL THREE
// TABLES. It holds 109 poses of ONE 45-px bat, and it is a THREE-BITPLANE
// sprite bank — not, as this repository believed for five rounds, two planes
// plus a fill mask. The third run in each unit is BITPLANE 2, and it is what
// turns the red outline ramp into the grey body ramp:
//
//     palette index = plane0 | plane1<<1 | plane2<<2,   index 0 = transparent
//
// with plane 2's stored block drawn at row offset +2 relative to the plane-0/1
// block and at the same bit positions. Read as a mask the bat is a red-outlined
// blob; read as a third plane it is the slim grey-bodied bat the original draws.
//
// LAYOUT. Row stride 16 bytes = TWO 8-byte bitplanes of 64 px (columns 55..63
// are dead in BOTH halves across the whole file, which is what identifies the
// split as planes rather than one 128-px raster). One unit, from its first ink
// row:
//
//     plane 0/1 interleaved   H rows x 16 bytes   (plane0 at +0, plane1 at +8)
//     4 blank rows
//     plane 2                 H-4 rows x 16 bytes (data in the FIRST half only)
//     4 blank rows
//   unit stride = 16*(2H+4) bytes
//
// 218 non-blank runs, strictly alternating, so 109 units. The gap after unit 84
// is 48 blank rows rather than 4: that is the bank split, and it is the only
// irregular gap in the file.
//
// POSE -> UNIT. 120 poses to a turn, 3 degrees each, pose p pointing at 3p
// degrees from +x rotating toward +y (clockwise on screen, y down):
//
//     unit = pose        for pose 0..84    (bank 0)
//     unit = pose - 11   for pose 96..119  (bank 1)
//     poses 85..95 are NOT STORED — bearings 255..285, tip pointing up, which
//     no bat on any table ever reaches. Asked for one, this exporter fails
//     rather than substituting a neighbour.
//
// The flipper records' rest and flipped fields are these pose numbers verbatim.
//
// ---------------------------------------------------------------------------
// THE ANCHOR, AND WHY IT IS THE ONE FITTED NUMBER HERE
// ---------------------------------------------------------------------------
// Blocks are trimmed vertically and pre-shifted horizontally to bit 0, so where
// a block goes relative to the pivot is NOT in the file — the engine computes it
// at load time and that code was not disassembled. What is available is the
// anchor MEASURED against filmed WinUAE frames for 37 distinct poses, and a
// closed-form rule that reproduces every one of the 34 tabulated ones exactly:
//
//     A_x(p) = 8 when cos(3p) >= 0 else W-7      (p <= 30 or p >= 90)
//     A_y(p) = 8 when sin(3p) >= 0 else H-7      (p <= 60)
//     block origin on the playfield = (pivotX - A_x, pivotY - A_y)
//
// i.e. the boss cap is 15 px across with its centre one pixel up and left of the
// pivot, so the ink runs 8 px back from the pivot and 6 px past it. The branches
// agree at the crossovers p = 30, 60, 90, so the rule is continuous, and it
// satisfies both symmetry relations the silhouettes themselves obey. The rule is
// written with integer pose comparisons rather than a cosine so a rounding
// change in some future engine cannot move a bat by 33 pixels.
//
// CHECK 9 below pins it: the 34 film-measured anchors ship as a fixture and the
// rule must reproduce all of them.
//
// ---------------------------------------------------------------------------
// NO PALETTE SHIPS HERE
// ---------------------------------------------------------------------------
// The bat writes into playfield bitplanes 0,1,2 and clears 3..7, so its indices
// land in entries 0..7 of the table's OWN 256-colour slot-3 palette, which the
// runtime already holds from `<table-id>.art.png`. That is also why the raster
// is table-independent and ships once: only the palette differs (Extreme Sports
// recolours entry 1, BabeWatch entries 5 and 6). Check 8 asserts the census the
// claim rests on — six colours used, entries 0 and 7 never.
//
// ---------------------------------------------------------------------------
// THE CHECKS
// ---------------------------------------------------------------------------
//  1. 218 non-blank runs, strictly alternating gfx / plane-2.
//  2. Every gap is 4 blank rows except exactly one 48-row gap, the one before run
//     170 — unit 85, the first of bank 1.
//  3. plane2Rows == gfxRows - 4 for all 109 units.
//  4. Plane 1 is empty in every plane-2 run (the third plane is stored alone).
//  5. Unit stride == 16*(2H+4) for every unit but the one across the bank gap.
//  6. No ink in columns 55..63 of either plane, anywhere in the file.
//  7. The union of the three planes at offset +2 is HOLE-FREE — equal to its own
//     flood-filled silhouette — for all 109 units. A wrong plane-2 row offset
//     punches holes in the body, so this is what pins the +2.
//  8. Colour census: exactly indices 1..6 are used; 0 and 7 never are.
//  9. The anchor rule reproduces all 34 film-measured anchors exactly.
// 10. Every table's flipper array parses: four records, three of type 1 and one
//     of type 3, both lower pivots on the same row, and every rest and flipped
//     pose resolves to a stored unit.
// 11. The shipped pose set is DERIVED by walking each bat from rest to flipped,
//     so it cannot drift if a record is ever re-read; and every pose any bat can
//     reach is in it.
// 12. Each record's COIL SIGN agrees with the direction its poses count, which
//     is what says the renderer's `restPose + ((direction * stroke) >> 6)` is
//     the same arithmetic the original's `asr.w #$6` performs.
//
// Usage:
//   node scripts/export-flipper-bats.mjs <segment-dir> [out-dir] [--check]
//     [--flipdat <path to flipdat1.bin>]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { loadPackage, follow, readU8, readU16, readS16 } from "./export-table-modes.mjs";

/** flipdat1.bin geometry. Every number re-derived by the checks below. */
const STRIDE = 16;
const PLANE_BYTES = 8;
const PLANE_WIDTH = 64;
/** Columns 55..63 are dead in both halves; nothing may draw there. */
const LIVE_WIDTH = 55;
/** Blank rows terminating each block, and the one wider gap at the bank split. */
const GAP_ROWS = 4;
const BANK_GAP_ROWS = 48;
const BANK_SPLIT_RUN = 170;
const STORED_UNITS = 109;
const RUNS = 2 * STORED_UNITS;
/** Plane 2's stored block starts this many rows below the plane-0/1 block. */
const PLANE2_ROW_OFFSET = 2;

/** The pose scale: 120 poses to a turn, 3 degrees each. */
const POSES_PER_TURN = 120;
const DEGREES_PER_POSE = 3;
/** Bank 0 is poses 0..84; bank 1 is poses 96..119, stored 11 units earlier. */
const BANK0_LAST_POSE = 84;
const BANK1_FIRST_POSE = 96;
const UNSTORED_POSES = BANK1_FIRST_POSE - BANK0_LAST_POSE - 1;

/** The bat's own angle scale: 64 units to a drawn pose (main.seg00 +0xBDB8). */
const ANGLE_UNITS_PER_POSE = 64;

/** Flipper record layout; see src/game/flippers.ts for the full field map. */
const RECORD_BYTES = 0x1fa;
const RECORD_SLOTS = 4;
const RECORD_TYPE_ACTIVE = 1;
const RECORD_TYPE_UNUSED = 3;
const REC_TYPE = 0x00;
const REC_HANDLER = 0x01;
const REC_PIVOT_X = 0x02;
const REC_PIVOT_Y = 0x04;
const REC_REST_POSE = 0x06;
const REC_FLIPPED_POSE = 0x08;
const REC_KEY = 0x0a;
const REC_SPRING_ACCEL = 0x0c;
const REC_SPRING_CAP = 0x0e;
const REC_COIL_ACCEL = 0x16;
const REC_COIL_CAP = 0x18;
const REC_BANK = 0x1c;
/** Descriptor +$58 is the flipper array — `$2346(a5)` in the original. */
const HEADER_FLIPPERS = 0x58;

const TABLES = [
  { stem: "Table001", tableId: "law-n-justice", displayName: "Law 'n Justice" },
  { stem: "Table002", tableId: "babewatch", displayName: "BabeWatch" },
  { stem: "Table003", tableId: "extreme-sports", displayName: "Extreme Sports" },
];

const PROVENANCE = {
  sourceClass: "disk-derived-flipper-sprites",
  description:
    "The flipper bat pose bank — 3-bitplane sprites of one bat at 3-degree steps, with the " +
    "per-table pivot and rest/flipped pose of every bat — decoded from the operator's own AGA " +
    "floppy set. Still images and placement data only: no audio, no executable code, and no " +
    "palette (the bat draws through the table's own artwork palette, which already ships).",
  authorizationRequired: true,
};

/**
 * CHECK 9's fixture: the anchors measured pixel-exact against filmed WinUAE
 * frames and native screenshots. 34 poses, `pose: [anchorX, anchorY]`.
 */
const FILM_ANCHORS = new Map([
  [0, [8, 8]], [2, [8, 8]], [3, [8, 8]], [4, [8, 8]], [5, [8, 8]], [6, [8, 8]],
  [8, [8, 8]], [9, [8, 8]], [10, [8, 8]], [23, [8, 8]],
  [50, [41, 8]], [51, [42, 8]], [52, [43, 8]], [54, [45, 8]], [55, [46, 8]],
  [56, [47, 8]], [57, [48, 8]], [58, [48, 8]], [60, [48, 8]], [61, [48, 8]],
  [62, [48, 9]], [63, [48, 11]], [64, [47, 13]], [65, [46, 15]], [66, [45, 17]],
  [67, [44, 20]], [68, [43, 22]],
  [112, [8, 22]], [113, [8, 20]], [114, [8, 17]], [115, [8, 15]], [116, [8, 13]],
  [117, [8, 11]], [119, [8, 8]],
]);

// ---------------------------------------------------------------------------
// flipdat1.bin
// ---------------------------------------------------------------------------

/** True when raster row `row` is entirely blank. */
function blankRow(data, row) {
  const at = row * STRIDE;
  for (let i = 0; i < STRIDE; i += 1) if (data[at + i] !== 0) return false;
  return true;
}

/** One bit of one plane of one raster row. */
function bitAt(data, row, plane, x) {
  const byte = data[row * STRIDE + plane * PLANE_BYTES + (x >> 3)] ?? 0;
  return (byte & (0x80 >> (x & 7))) !== 0 ? 1 : 0;
}

/** Runs of consecutive non-blank rows: [{ row, height }]. CHECK 1/2 read these. */
function findRuns(data) {
  if (data.length % STRIDE !== 0) {
    throw new Error(`flipdat1.bin is ${data.length} bytes, not a whole number of ${STRIDE}-byte rows`);
  }
  const rows = data.length / STRIDE;
  const runs = [];
  for (let row = 0; row < rows; ) {
    if (blankRow(data, row)) {
      row += 1;
      continue;
    }
    const start = row;
    while (row < rows && !blankRow(data, row)) row += 1;
    runs.push({ row: start, height: row - start });
  }
  return runs;
}

/**
 * Decodes the whole bank into 109 units of palette indices.
 *
 * Returns [{ unit, width, height, gfxOffset, plane2Offset, planes: [p0,p1,p2] }]
 * with each plane packed to ceil(width/8) bytes a row — planes 0 and 1 `height`
 * rows, plane 2 `height - 4` rows drawn at row +2.
 */
function decodeBank(data) {
  const runs = findRuns(data);
  // CHECK 1 — 218 runs, strictly alternating.
  if (runs.length !== RUNS) {
    throw new Error(`flipdat1.bin holds ${runs.length} non-blank runs, expected ${RUNS}`);
  }
  // CHECK 2 — every gap 4 rows but one 48-row gap at the bank split.
  let wideGaps = 0;
  for (let i = 1; i < runs.length; i += 1) {
    const previous = runs[i - 1];
    const gap = runs[i].row - (previous.row + previous.height);
    if (gap === GAP_ROWS) continue;
    if (gap === BANK_GAP_ROWS && i === BANK_SPLIT_RUN) {
      wideGaps += 1;
      continue;
    }
    throw new Error(`flipdat1.bin: gap of ${gap} rows before run ${i}; expected ${GAP_ROWS}`);
  }
  if (wideGaps !== 1) {
    throw new Error(`flipdat1.bin: ${wideGaps} bank-split gaps, expected exactly 1`);
  }

  const units = [];
  for (let unit = 0; unit < STORED_UNITS; unit += 1) {
    const gfx = runs[2 * unit];
    const plane2 = runs[2 * unit + 1];
    // CHECK 3 — plane 2 is four rows shorter than the plane-0/1 block.
    if (plane2.height !== gfx.height - GAP_ROWS) {
      throw new Error(
        `flipdat1.bin unit ${unit}: plane 2 is ${plane2.height} rows against ${gfx.height} of ` +
          `planes 0/1; expected ${gfx.height - GAP_ROWS}`,
      );
    }
    // CHECK 4 — plane 1 is empty in the plane-2 run.
    for (let row = 0; row < plane2.height; row += 1) {
      for (let i = PLANE_BYTES; i < STRIDE; i += 1) {
        if (data[(plane2.row + row) * STRIDE + i] !== 0) {
          throw new Error(`flipdat1.bin unit ${unit}: plane-2 run has ink in the second plane`);
        }
      }
    }
    // CHECK 5 — the unit stride, everywhere but across the bank gap.
    if (unit + 1 < STORED_UNITS && 2 * unit + 2 !== BANK_SPLIT_RUN) {
      const stride = (runs[2 * unit + 2].row - gfx.row) * STRIDE;
      const expected = STRIDE * (2 * gfx.height + GAP_ROWS);
      if (stride !== expected) {
        throw new Error(
          `flipdat1.bin unit ${unit}: stride ${stride} is not 16*(2*${gfx.height}+4) = ${expected}`,
        );
      }
    }
    // CHECK 6 — nothing draws in columns 55..63 of either plane.
    for (const run of [gfx, plane2]) {
      for (let row = 0; row < run.height; row += 1) {
        for (let plane = 0; plane < 2; plane += 1) {
          for (let x = LIVE_WIDTH; x < PLANE_WIDTH; x += 1) {
            if (bitAt(data, run.row + row, plane, x) !== 0) {
              throw new Error(`flipdat1.bin unit ${unit}: ink at dead column ${x}`);
            }
          }
        }
      }
    }

    // Expand to palette indices at the drawn geometry: `height` rows, with
    // plane 2 contributing bit 2 from row PLANE2_ROW_OFFSET down.
    const height = gfx.height;
    const indices = new Uint8Array(height * PLANE_WIDTH);
    for (let row = 0; row < height; row += 1) {
      for (let x = 0; x < LIVE_WIDTH; x += 1) {
        indices[row * PLANE_WIDTH + x] =
          bitAt(data, gfx.row + row, 0, x) | (bitAt(data, gfx.row + row, 1, x) << 1);
      }
    }
    for (let row = 0; row < plane2.height; row += 1) {
      const target = row + PLANE2_ROW_OFFSET;
      for (let x = 0; x < LIVE_WIDTH; x += 1) {
        if (bitAt(data, plane2.row + row, 0, x) !== 0) {
          indices[target * PLANE_WIDTH + x] |= 4;
        }
      }
    }

    let width = 0;
    for (let row = 0; row < height; row += 1) {
      for (let x = LIVE_WIDTH - 1; x >= width; x -= 1) {
        if (indices[row * PLANE_WIDTH + x] !== 0) {
          width = x + 1;
          break;
        }
      }
    }
    if (width === 0) throw new Error(`flipdat1.bin unit ${unit}: no ink at all`);

    // CHECK 7 — the drawn silhouette is hole-free. Flood the background in from
    // the border of a one-pixel-wider frame; any zero pixel the flood cannot
    // reach is an interior hole, which is what a wrong plane-2 offset produces.
    holeFree(indices, width, height, unit);

    units.push({ unit, width, height, indices, gfxOffset: gfx.row * STRIDE, plane2Offset: plane2.row * STRIDE, plane2Rows: plane2.height });
  }
  return units;
}

/** CHECK 7's flood fill. Throws with the hole count when the shape is not solid. */
function holeFree(indices, width, height, unit) {
  const w = width + 2;
  const h = height + 2;
  const seen = new Uint8Array(w * h);
  const stack = [0];
  seen[0] = 1;
  while (stack.length > 0) {
    const at = stack.pop();
    const x = at % w;
    const y = (at - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const next = ny * w + nx;
      if (seen[next] === 1) continue;
      const inside = nx >= 1 && ny >= 1 && nx <= width && ny <= height;
      if (inside && indices[(ny - 1) * PLANE_WIDTH + (nx - 1)] !== 0) continue;
      seen[next] = 1;
      stack.push(next);
    }
  }
  let holes = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (indices[y * PLANE_WIDTH + x] !== 0) continue;
      if (seen[(y + 1) * w + (x + 1)] === 0) holes += 1;
    }
  }
  if (holes > 0) {
    throw new Error(
      `flipdat1.bin unit ${unit}: ${holes} interior hole(s) in the drawn silhouette; ` +
        `plane 2 is not at row offset ${PLANE2_ROW_OFFSET}`,
    );
  }
}

/** The stored unit for a pose, or null for the 11 the file does not carry. */
function unitForPose(pose) {
  const p = ((pose % POSES_PER_TURN) + POSES_PER_TURN) % POSES_PER_TURN;
  if (p <= BANK0_LAST_POSE) return p;
  if (p >= BANK1_FIRST_POSE) return p - UNSTORED_POSES;
  return null;
}

/**
 * The blit anchor for a pose, from the block's own width and height.
 *
 * Integer pose comparisons rather than a cosine: cos(3p) >= 0 is p <= 30 or
 * p >= 90, and sin(3p) >= 0 is p <= 60, both exact on the 120-pose scale, and
 * both branches agree at the crossovers. See the header.
 */
function anchorFor(pose, width, height) {
  const p = ((pose % POSES_PER_TURN) + POSES_PER_TURN) % POSES_PER_TURN;
  return {
    x: p <= 30 || p >= 90 ? 8 : width - 7,
    y: p <= 60 ? 8 : height - 7,
  };
}

/** Packs one bitplane of a unit to ceil(width/8) bytes a row. */
function packPlane(unit, plane, rows, rowOffset) {
  const rowBytes = Math.ceil(unit.width / 8);
  const out = Buffer.alloc(rowBytes * rows);
  const bit = 1 << plane;
  for (let row = 0; row < rows; row += 1) {
    for (let x = 0; x < unit.width; x += 1) {
      const index = unit.indices[(row + rowOffset) * PLANE_WIDTH + x] ?? 0;
      if ((index & bit) !== 0) out[row * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The per-table flipper records
// ---------------------------------------------------------------------------

/**
 * Reads one table's four flipper records and names the three active ones.
 *
 * The ids are the simulation's own — "lower-left", "lower-right", "upper" — and
 * are assigned mechanically: the two active records sharing the table's lowest
 * pivot row are the lower pair, left the smaller column; whatever active record
 * is left is the upper bat. CHECK 10 refuses anything else.
 */
function readFlipperRecords(pkg, table) {
  const array = follow(pkg, { hunk: 0, offset: 0 }, HEADER_FLIPPERS);
  if (array === null) {
    throw new Error(`${table.stem}: descriptor +0x58 names no flipper array`);
  }
  const records = [];
  for (let slot = 0; slot < RECORD_SLOTS; slot += 1) {
    const at = { hunk: array.hunk, offset: array.offset + slot * RECORD_BYTES };
    const type = readU8(pkg, at, REC_TYPE);
    if (type === RECORD_TYPE_UNUSED) {
      records.push({ slot, type });
      continue;
    }
    if (type !== RECORD_TYPE_ACTIVE) {
      throw new Error(`${table.stem}: flipper slot ${slot} has type byte ${type}, expected 1 or 3`);
    }
    const restPose = readU16(pkg, at, REC_REST_POSE);
    const flippedPose = readU16(pkg, at, REC_FLIPPED_POSE);
    const up = (flippedPose - restPose + POSES_PER_TURN) % POSES_PER_TURN;
    const direction = up <= POSES_PER_TURN / 2 ? 1 : -1;
    const sweepPoses = direction === 1 ? up : POSES_PER_TURN - up;
    // CHECK 12 — the coil drives the bat the way its poses count. The original
    // stores a SIGNED angle and derives the pose with `asr.w #$6`, so a bat
    // whose poses count DOWN must have a negative coil cap and a positive
    // spring cap. If these ever disagree, the renderer's pose arithmetic would
    // swing the drawn bat the wrong way and look merely odd.
    const coilCap = readS16(pkg, at, REC_COIL_CAP);
    const springCap = readS16(pkg, at, REC_SPRING_CAP);
    if (Math.sign(coilCap) !== direction || Math.sign(springCap) !== -direction) {
      throw new Error(
        `${table.stem} flipper slot ${slot}: poses run ${restPose} -> ${flippedPose} ` +
          `(direction ${direction}) but the coil cap is ${coilCap} and the spring cap ${springCap}`,
      );
    }
    const bank = follow(pkg, at, REC_BANK);
    records.push({
      slot,
      type,
      handlerFamily: readU8(pkg, at, REC_HANDLER),
      pivotX: readS16(pkg, at, REC_PIVOT_X),
      pivotY: readS16(pkg, at, REC_PIVOT_Y),
      restPose,
      flippedPose,
      direction,
      sweepPoses,
      /** MEASURED at +0xBD6C: 1 selects the LEFT button, 0 the RIGHT. */
      button: readU16(pkg, at, REC_KEY) === 0 ? "right" : "left",
      springAcceleration: readS16(pkg, at, REC_SPRING_ACCEL),
      springCap,
      coilAcceleration: readS16(pkg, at, REC_COIL_ACCEL),
      coilCap,
      /** hunk2+0 on every main-level bat, hunk2+26040 on a raised-level one. */
      bankOffset: bank === null ? -1 : bank.offset,
      bankHunk: bank === null ? -1 : bank.hunk,
    });
  }

  // CHECK 10 — three active records and one unused slot.
  const active = records.filter((record) => record.type === RECORD_TYPE_ACTIVE);
  const unused = records.filter((record) => record.type === RECORD_TYPE_UNUSED);
  if (active.length !== 3 || unused.length !== 1) {
    throw new Error(
      `${table.stem}: ${active.length} active flipper records and ${unused.length} unused; ` +
        `expected 3 and 1`,
    );
  }
  const lowestRow = Math.max(...active.map((record) => record.pivotY));
  const lower = active.filter((record) => record.pivotY === lowestRow);
  if (lower.length !== 2) {
    throw new Error(
      `${table.stem}: ${lower.length} bats sit on the bottom row ${lowestRow}; expected the pair`,
    );
  }
  lower.sort((a, b) => a.pivotX - b.pivotX);
  const upper = active.find((record) => !lower.includes(record));
  if (upper === undefined) throw new Error(`${table.stem}: no upper bat left over`);
  const named = [
    { id: "lower-left", role: "left", ...lower[0] },
    { id: "lower-right", role: "right", ...lower[1] },
    { id: "upper", role: upper.direction === 1 ? "right" : "left", ...upper },
  ];
  for (const bat of named) {
    if (unitForPose(bat.restPose) === null || unitForPose(bat.flippedPose) === null) {
      throw new Error(
        `${table.stem} ${bat.id}: pose ${bat.restPose}/${bat.flippedPose} is one of the 11 the ` +
          `bank does not store`,
      );
    }
    if (bat.direction === -1 !== (bat.role === "left")) {
      throw new Error(`${table.stem} ${bat.id}: pose direction disagrees with its handedness`);
    }
  }
  return named;
}

/** Every pose a bat passes through, rest to flipped inclusive. */
function posesOf(bat) {
  const poses = [];
  for (let step = 0; step <= bat.sweepPoses; step += 1) {
    poses.push(
      ((bat.restPose + bat.direction * step) % POSES_PER_TURN + POSES_PER_TURN) % POSES_PER_TURN,
    );
  }
  return poses;
}

// ---------------------------------------------------------------------------
// Assembling the document
// ---------------------------------------------------------------------------

function build(units, tables) {
  // CHECK 11 — the shipped pose set is derived from the records, not listed.
  const wanted = new Set();
  for (const table of tables) for (const bat of table.bats) for (const pose of posesOf(bat)) wanted.add(pose);
  const poses = [...wanted].sort((a, b) => a - b);

  // CHECK 8 — the colour census, over the whole 109-unit bank.
  const census = new Array(8).fill(0);
  for (const unit of units) {
    for (let row = 0; row < unit.height; row += 1) {
      for (let x = 0; x < unit.width; x += 1) {
        census[unit.indices[row * PLANE_WIDTH + x] ?? 0] += 1;
      }
    }
  }
  const drawn = census.slice(1).reduce((sum, n) => sum + n, 0);
  if (census[7] !== 0) {
    throw new Error(`flipdat1.bin: palette entry 7 is used ${census[7]} times; no pose should`);
  }
  for (let index = 1; index <= 6; index += 1) {
    if (census[index] === 0) throw new Error(`flipdat1.bin: palette entry ${index} is never used`);
  }

  // CHECK 9 — the anchor rule against the film-measured anchors.
  let anchorsChecked = 0;
  for (const [pose, [ax, ay]] of FILM_ANCHORS) {
    const unit = units[unitForPose(pose)];
    if (unit === undefined) throw new Error(`film anchor pose ${pose} is not stored`);
    const anchor = anchorFor(pose, unit.width, unit.height);
    if (anchor.x !== ax || anchor.y !== ay) {
      throw new Error(
        `anchor rule gives (${anchor.x},${anchor.y}) for pose ${pose}; film measured (${ax},${ay})`,
      );
    }
    anchorsChecked += 1;
  }

  const documents = poses.map((pose) => {
    const unit = units[unitForPose(pose)];
    const anchor = anchorFor(pose, unit.width, unit.height);
    return {
      pose,
      unit: unit.unit,
      bearingDeg: pose * DEGREES_PER_POSE,
      width: unit.width,
      height: unit.height,
      anchorX: anchor.x,
      anchorY: anchor.y,
      gfxOffset: unit.gfxOffset,
      plane2Offset: unit.plane2Offset,
      plane0: packPlane(unit, 0, unit.height, 0).toString("base64"),
      plane1: packPlane(unit, 1, unit.height, 0).toString("base64"),
      plane2: packPlane(unit, 2, unit.plane2Rows, PLANE2_ROW_OFFSET).toString("base64"),
    };
  });

  return { poses: documents, census, drawn, anchorsChecked };
}

function main(argv) {
  const check = argv.includes("--check");
  const flipdatFlag = argv.indexOf("--flipdat");
  const positional = argv.filter(
    (arg, at) => !arg.startsWith("--") && !(flipdatFlag >= 0 && at === flipdatFlag + 1),
  );
  const segDir = positional[0];
  const outDir = positional[1] ?? "public/generated";
  const flipdatPath =
    flipdatFlag >= 0
      ? argv[flipdatFlag + 1]
      : segDir === undefined
        ? undefined
        : join(dirname(resolve(segDir)), "pkg", "flipdat1.bin");

  if (segDir === undefined) {
    console.error(
      "usage: node scripts/export-flipper-bats.mjs <segment-dir> [out-dir] [--check] " +
        "[--flipdat <path>]",
    );
    return 1;
  }
  if (!existsSync(segDir)) {
    console.error(`segment directory not found: ${segDir}`);
    return 1;
  }
  if (flipdatPath === undefined || !existsSync(flipdatPath)) {
    console.error(`flipdat1.bin not found: ${flipdatPath ?? "(none)"}`);
    return 1;
  }
  if (!check) mkdirSync(outDir, { recursive: true });

  console.log(check ? "checking flipper bats" : "exporting flipper bats");

  let document;
  let summary;
  try {
    const raw = readFileSync(flipdatPath);
    const units = decodeBank(raw);
    const tables = TABLES.map((table) => {
      const pkg = loadPackage(segDir, table.stem);
      return {
        tableId: table.tableId,
        displayName: table.displayName,
        bats: readFlipperRecords(pkg, table),
      };
    });
    const built = build(units, tables);
    summary = built;
    document = {
      schema: "pinball-illusions/flipper-bats/v1",
      provenance: PROVENANCE,
      source: {
        file: "flipdat1.bin",
        byteLength: raw.length,
        sha256: createHash("sha256").update(raw).digest("hex"),
        storedUnits: units.length,
      },
      posesPerTurn: POSES_PER_TURN,
      degreesPerPose: DEGREES_PER_POSE,
      angleUnitsPerPose: ANGLE_UNITS_PER_POSE,
      planes: 3,
      plane2RowOffset: PLANE2_ROW_OFFSET,
      paletteIndexBase: 0,
      poses: built.poses,
      tables: tables.map((table) => ({
        tableId: table.tableId,
        displayName: table.displayName,
        bats: table.bats.map((bat) => ({
          id: bat.id,
          role: bat.role,
          slot: bat.slot,
          pivotX: bat.pivotX,
          pivotY: bat.pivotY,
          restPose: bat.restPose,
          flippedPose: bat.flippedPose,
          direction: bat.direction,
          sweepPoses: bat.sweepPoses,
          button: bat.button,
          handlerFamily: bat.handlerFamily,
          springAcceleration: bat.springAcceleration,
          springCap: bat.springCap,
          coilAcceleration: bat.coilAcceleration,
          coilCap: bat.coilCap,
          bankHunk: bat.bankHunk,
          bankOffset: bat.bankOffset,
        })),
      })),
    };
  } catch (error) {
    console.error(`  ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  const json = JSON.stringify(document);
  const out = join(outDir, "flipper-bats.json");
  if (check) {
    const existing = existsSync(out) ? readFileSync(out, "utf8") : null;
    if (existing !== json) {
      console.error(
        `  DIFFERS from ${out}` +
          (existing === null ? " (file missing)" : ` (${existing.length} vs ${json.length} bytes)`),
      );
      return 1;
    }
    console.log(`  identical to ${out}`);
  } else {
    writeFileSync(out, json, "utf8");
    console.log(`  ${json.length.toLocaleString()} bytes -> ${out}`);
  }

  const percent = (n) => `${((100 * n) / summary.drawn).toFixed(2)}%`;
  console.log(
    `  ${summary.poses.length} of ${POSES_PER_TURN} poses shipped, derived from the records; ` +
      `${STORED_UNITS} stored in the bank`,
  );
  console.log(
    `  census over all ${STORED_UNITS} poses, ${summary.drawn.toLocaleString()} drawn pixels: ` +
      [1, 2, 3, 4, 5, 6].map((i) => `idx${i} ${percent(summary.census[i])}`).join(", ") +
      `; idx0 and idx7 unused`,
  );
  console.log(`  anchor rule reproduces ${summary.anchorsChecked} film-measured anchors exactly`);
  for (const table of document.tables) {
    console.log(
      `  ${table.tableId.padStart(15)}: ` +
        table.bats
          .map((bat) => `${bat.id} (${bat.pivotX},${bat.pivotY}) ${bat.restPose}->${bat.flippedPose}`)
          .join("; "),
    );
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
