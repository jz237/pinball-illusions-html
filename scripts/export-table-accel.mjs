#!/usr/bin/env node
// Decodes the RAMP DRIVE out of slot 4 of each table package into the documents
// under public/generated/tables/*.accel.json. Run locally, where the operator's
// own disks live; the JSON it writes is what ships.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS AND WHY IT MATTERS
// ---------------------------------------------------------------------------
// A real ramp or habitrail DRIVES the ball. The reconstruction's static-friction
// angle is atan(154/1024) = 8.55 degrees, so any surface shallower than that is
// an equilibrium — friction exactly cancels gravity and the ball stops dead —
// and the shipped tables are full of such surfaces, most conspicuously Law 'n
// Justice's top arch, whose crown carries contact normals 3.5-4.9 degrees off
// vertical. No coefficient can fix that: raise friction and more places stick,
// lower it and the whole table turns to ice. What fixes it is the per-region
// acceleration the original carried, and this file is where it lives.
//
// ---------------------------------------------------------------------------
// THE STRUCTURE, AND HOW IT IS KNOWN RATHER THAN GUESSED
// ---------------------------------------------------------------------------
// Slot 4 is an Amiga relocatable hunk image:
//
//     [u32 dataLen][hunk data ...][HUNK_RELOC32 blocks ...][u32 0]
//
// so the payload begins at file byte 4 — the project's usual PREAMBLE — and
// `file offset = data offset + 4`. Data offsets are quoted below, matching
// docs/RULES_SPEC.md. The payload opens with THREE structures and nothing else:
//
//     data      0 .. 3149   42 x 75 byte block map, LEVEL 0
//     data   3150 .. 6299   42 x 75 byte block map, LEVEL 1
//     data   6300 ..        (dx, dy) vectors the map bytes index, 4 bytes each
//
// identically on all three tables. Each map byte governs one 8x8 PIXEL block of
// the 336x600 playfield (42*8 = 336, 75*8 = 600), row-major, and is an index
// into the vector list; index 0 is (0,0) and means "no drive".
//
// The consumer is in the shared engine, main.seg00.bin, at hunk-0 address
// 0x00B70A, inside the ball integrator that runs 8x per 50 Hz frame:
//
//     00b722  moveq    #$a, d2
//     00b724  asr.l    d2, d0             ; position >>10 -> whole pixels
//     00b726  asr.l    d2, d1
//     00b728  movem.w  d0-d1, $12(a4)     ; ball top-left
//     00b72e  addq.w   #8, d0             ; + half the 17 px ball -> centre x
//     00b730  addq.w   #8, d1             ;                       -> centre y
//     00b732  moveq    #$3, d2
//     00b734  asr.w    d2, d0             ; cx >> 3   (8 px blocks)
//     00b736  asr.w    d2, d1             ; cy >> 3
//     00b738  move.w   $1c2e(a5,d1.w*2), d1   ; rowTable[blockRow], = 42*k
//     00b73e  add.w    d0, d1                 ; + blockCol
//     00b740  movea.l  $5c(a4), a1            ; the per-level block map
//     00b746  move.b   (a1,d1.w), d0          ; the index byte
//     00b74a  movea.l  $2336(a5), a2          ; the vector list
//     00b74e  movem.w  (a2,d0.w*4), d0-d1     ; two signed words, 4 B stride
//     00b754  add.w    $e8c(a5), d0           ; + global x tilt
//     00b758  add.w    $e86(a5), d1           ; + global gravity
//     00b768  add.w    d0, $e(a4)             ; vx += ax
//     00b76c  add.w    d1, $10(a4)            ; vy += ay
//
// The x42 is a 600-entry lookup table built at 0x0009B2 (`addi.w #$2a,d2` in a
// 600-iteration loop), not a MULU — which is why searching the physics for a
// multiply by 42 found nothing. `$5c(a4)` is one of six per-level pointers that
// the routines at 0x0053C6 and 0x0053F4 swap together as a block, the same six
// that carry the collision plane at `$54(a4)`; that is why the two block maps
// pair with the two collision lines, and why whichever polarity the collision
// planes have (see src/game/materials.ts — it is inferred, not read) the block
// maps inherit it rather than adding a second independent guess.
//
// ---------------------------------------------------------------------------
// FOUR CHECKS, ALL FATAL, EACH SENSITIVE TO A DIFFERENT MISTAKE
// ---------------------------------------------------------------------------
// 1. THE RELOCATION TABLE PARSES TO THE BYTE, and its lowest offset is 6388 /
//    6886 / 6890 — above everything decoded here. So every longword in the
//    region is unambiguously an immediate and not a pointer the loader would
//    rewrite. This is the check that says "these bytes are data".
// 2. THE SLOT-0 DESCRIPTOR DELIMITS ALL THREE STRUCTURES TO THE BYTE. Its
//    big-endian u32 words 10, 19 and 23 read 3150, 6300 and 6360/6352/6356, and
//    the last is exactly `6300 + 4 * (highest index used by EITHER block map +
//    1)`. That is a very tight coincidence: it means the descriptor agrees with
//    the block maps about how many vectors there are, and it only works when
//    BOTH maps are counted — Table001's level-1 map alone tops out at 12 and
//    would predict 6352, not the 6360 the descriptor states. The same
//    descriptor's words 3, 8 and 9 read 52080, 26040 and 77280, which are the
//    slot-2 layer offsets `export-table-maps.mjs` uses, so it is independently
//    known to be a table of payload offsets.
// 3. THE VECTORS ARE SHAPED LIKE A RAMP DRIVE: entry 0 is exactly (0,0), no dy
//    is negative (a ramp steepens the fall line, it does not lift the ball), and
//    every component is small. A misframed read fails all three at once.
// 4. THE BLOCK MAPS ARE MOSTLY ZERO AND SPATIALLY COHERENT: most of a playfield
//    is flat, and a drive region is a connected run along a rail rather than
//    confetti. Both are measured below.
//
// What NO check here can establish is that the non-zero blocks lie ON the ramps.
// That is a claim about two different files agreeing, so it is asserted in
// tests/table-accel.test.ts against the shipped collision maps, where the
// measurement can be re-run whenever either export changes.
//
// Usage:
//   node scripts/export-table-accel.mjs <segment-dir> [out-dir] [--check]
//
// <segment-dir> holds <stem>.seg04.bin for each table, and the slot-0 descriptor
// <stem>.s00.bin either beside them or in a sibling `seg2` directory.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

/** Playfield dimensions. Must match PLAYFIELD_WIDTH/HEIGHT in src/game/contracts.ts. */
const WIDTH = 336;
const HEIGHT = 600;

/** Pixels per block edge: the `asr.w #3` on both coordinates at 0x00B734. */
const BLOCK_SIZE = 8;
const COLUMNS = WIDTH / BLOCK_SIZE; // 42, and the row table's stride
const ROWS = HEIGHT / BLOCK_SIZE; // 75
const GRID_BYTES = COLUMNS * ROWS; // 3150

/** Hunk data begins immediately after the u32 length word. See the header. */
const PREAMBLE = 4;

/** Data offset of the first block map, and of the vector list. */
const LEVEL0_GRID = 0;
const LEVEL1_GRID = GRID_BYTES;
const VECTORS = 2 * GRID_BYTES; // 6300

/** Bytes per vector: two big-endian signed words, the `d0.w*4` stride. */
const VECTOR_BYTES = 4;

/**
 * Descriptor word indices that delimit what is decoded here, and what they must
 * say. Word 23 is checked against the block maps rather than against a constant,
 * because that is the part that carries information.
 */
const DESCRIPTOR_LEVEL1_GRID_WORD = 10;
const DESCRIPTOR_VECTORS_WORD = 19;
const DESCRIPTOR_VECTORS_END_WORD = 23;

/** Largest component this decode will accept. See check 3 in the header. */
const MAX_VECTOR_COMPONENT = 63;

const TABLES = [
  { stem: "Table001", tableId: "law-n-justice", displayName: "Law 'n Justice" },
  { stem: "Table002", tableId: "babewatch", displayName: "BabeWatch" },
  { stem: "Table003", tableId: "extreme-sports", displayName: "Extreme Sports" },
];

const PROVENANCE = {
  sourceClass: "disk-derived-ramp-acceleration",
  description:
    "Per-8x8-block ramp drive decoded from the operator's own AGA floppy set. " +
    "Functional physics data only: no artwork, audio or executable code.",
  authorizationRequired: true,
};

/**
 * Parses the HUNK_RELOC32 blocks that follow the payload and returns the lowest
 * data offset any of them rewrites.
 *
 * Throws unless the blocks consume the file exactly. That is the point: a
 * relocation table that parses to the byte classifies every longword in the
 * module as pointer or immediate, and only then is it honest to read the front
 * of the payload as a table of numbers.
 */
function lowestRelocation(bytes, payloadLength) {
  let at = PREAMBLE + payloadLength;
  let lowest = Infinity;
  let total = 0;
  const blocks = [];
  for (;;) {
    if (at + 4 > bytes.length) {
      throw new Error(
        `relocation blocks run past the end of the file at byte ${at} of ${bytes.length}; ` +
          `the payload length ${payloadLength} does not frame this module`,
      );
    }
    const count = bytes.readUInt32BE(at);
    at += 4;
    if (count === 0) break;
    if (at + 4 + count * 4 > bytes.length) {
      throw new Error(`relocation block of ${count} entries at byte ${at - 4} overruns the file`);
    }
    const hunk = bytes.readUInt32BE(at);
    at += 4;
    blocks.push(`->hunk${hunk} x${count}`);
    total += count;
    for (let i = 0; i < count; i += 1) {
      const offset = bytes.readUInt32BE(at);
      at += 4;
      if (offset < lowest) lowest = offset;
    }
  }
  if (at !== bytes.length) {
    throw new Error(
      `relocation blocks end at byte ${at} but the file is ${bytes.length} bytes; ` +
        `they must consume it exactly or the module is not framed the way this decode assumes`,
    );
  }
  return { lowest, total, summary: blocks.join(" ") };
}

/** The slot-0 descriptor, as big-endian u32 words. */
function descriptorWords(segDir, stem) {
  const candidates = [
    join(segDir, `${stem}.s00.bin`),
    join(dirname(resolve(segDir)), "seg2", `${stem}.s00.bin`),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) {
    throw new Error(
      `slot-0 descriptor not found. Looked for:\n    ${candidates.join("\n    ")}\n` +
        `  It delimits every structure decoded here to the byte and is not optional.`,
    );
  }
  const bytes = readFileSync(path);
  const words = [];
  for (let at = 0; at + 4 <= bytes.length; at += 4) words.push(bytes.readUInt32BE(at));
  return words;
}

/** Counts 4-connected components of equal non-zero index. See check 4. */
function componentsOf(grid) {
  const seen = new Uint8Array(GRID_BYTES);
  let components = 0;
  for (let start = 0; start < GRID_BYTES; start += 1) {
    if (grid[start] === 0 || seen[start] === 1) continue;
    components += 1;
    const value = grid[start];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const cell = stack.pop();
      const row = Math.floor(cell / COLUMNS);
      const column = cell % COLUMNS;
      const neighbours = [
        column > 0 ? cell - 1 : -1,
        column < COLUMNS - 1 ? cell + 1 : -1,
        row > 0 ? cell - COLUMNS : -1,
        row < ROWS - 1 ? cell + COLUMNS : -1,
      ];
      for (const next of neighbours) {
        if (next < 0 || seen[next] === 1 || grid[next] !== value) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
  }
  return components;
}

/**
 * Run-length encodes one block-map row as flat [inclusive_end_column, index]
 * pairs, the first run starting at column 0 and the last ending at COLUMNS-1.
 * The same encoding `table-map.ts` expands for pixel rows, and lossless.
 */
function toRuns(grid, row) {
  const base = row * COLUMNS;
  const runs = [];
  let current = grid[base];
  for (let column = 1; column < COLUMNS; column += 1) {
    const value = grid[base + column];
    if (value !== current) {
      runs.push(column - 1, current);
      current = value;
    }
  }
  runs.push(COLUMNS - 1, current);
  return runs;
}

function decode(bytes, descriptor, stem) {
  const declared = bytes.readUInt32BE(0);
  if (declared < VECTORS + VECTOR_BYTES || PREAMBLE + declared > bytes.length) {
    throw new Error(
      `slot 4 declares a ${declared}-byte payload, which cannot hold two ${GRID_BYTES}-byte ` +
        `block maps and a vector list inside a ${bytes.length}-byte file`,
    );
  }
  const payload = bytes.subarray(PREAMBLE, PREAMBLE + declared);

  // CHECK 1 — these bytes are immediates, not pointers.
  const reloc = lowestRelocation(bytes, declared);

  const grids = [
    payload.subarray(LEVEL0_GRID, LEVEL0_GRID + GRID_BYTES),
    payload.subarray(LEVEL1_GRID, LEVEL1_GRID + GRID_BYTES),
  ];

  let highest = 0;
  for (const grid of grids) {
    for (const value of grid) if (value > highest) highest = value;
  }
  const vectorCount = highest + 1;
  const vectorsEnd = VECTORS + vectorCount * VECTOR_BYTES;

  if (reloc.lowest <= vectorsEnd) {
    throw new Error(
      `a relocation rewrites data offset ${reloc.lowest}, inside the region decoded here ` +
        `(0..${vectorsEnd - 1}); these bytes would be pointers, not numbers`,
    );
  }

  // CHECK 2 — the slot-0 descriptor agrees, to the byte, about all three.
  const stated = (index) => {
    if (index >= descriptor.length) {
      throw new Error(`slot-0 descriptor has only ${descriptor.length} words; word ${index} wanted`);
    }
    return descriptor[index];
  };
  if (stated(DESCRIPTOR_LEVEL1_GRID_WORD) !== LEVEL1_GRID) {
    throw new Error(
      `slot-0 descriptor word ${DESCRIPTOR_LEVEL1_GRID_WORD} is ` +
        `${stated(DESCRIPTOR_LEVEL1_GRID_WORD)}, not the ${LEVEL1_GRID} this decode expects for ` +
        `the second block map`,
    );
  }
  if (stated(DESCRIPTOR_VECTORS_WORD) !== VECTORS) {
    throw new Error(
      `slot-0 descriptor word ${DESCRIPTOR_VECTORS_WORD} is ${stated(DESCRIPTOR_VECTORS_WORD)}, ` +
        `not the ${VECTORS} this decode expects for the vector list`,
    );
  }
  if (stated(DESCRIPTOR_VECTORS_END_WORD) !== vectorsEnd) {
    throw new Error(
      `slot-0 descriptor word ${DESCRIPTOR_VECTORS_END_WORD} ends the vector list at ` +
        `${stated(DESCRIPTOR_VECTORS_END_WORD)}, but the block maps use indices up to ${highest}, ` +
        `which needs ${vectorCount} vectors and ends at ${vectorsEnd}. The descriptor and the ` +
        `block maps disagree about how many vectors there are.`,
    );
  }

  // CHECK 3 — the vectors are shaped like a ramp drive.
  const vectors = [];
  for (let index = 0; index < vectorCount; index += 1) {
    const at = VECTORS + index * VECTOR_BYTES;
    vectors.push([payload.readInt16BE(at), payload.readInt16BE(at + 2)]);
  }
  if (vectors[0][0] !== 0 || vectors[0][1] !== 0) {
    throw new Error(
      `vector 0 is (${vectors[0]}), not (0,0). Index 0 is the commonest block-map byte by far ` +
        `and must mean "no drive"; a non-zero entry 0 means the list is framed wrongly.`,
    );
  }
  for (let index = 0; index < vectors.length; index += 1) {
    const [dx, dy] = vectors[index];
    if (dy < 0) {
      throw new Error(
        `vector ${index} is (${dx},${dy}) and its dy is negative. A ramp steepens the local fall ` +
          `line; it does not lift the ball. A negative dy means this is not the vector list.`,
      );
    }
    if (Math.abs(dx) > MAX_VECTOR_COMPONENT || dy > MAX_VECTOR_COMPONENT) {
      throw new Error(
        `vector ${index} is (${dx},${dy}), larger than the ${MAX_VECTOR_COMPONENT} cap. These are ` +
          `per-substep velocity increments beside a gravity of 4; a large one is a misframed read.`,
      );
    }
  }

  // CHECK 4 — the block maps are mostly zero and spatially coherent.
  const stats = grids.map((grid, level) => {
    let nonZero = 0;
    for (const value of grid) if (value !== 0) nonZero += 1;
    const components = componentsOf(grid);
    if (nonZero === 0) {
      throw new Error(`level-${level} block map is entirely zero; it would drive nothing anywhere`);
    }
    if (nonZero > GRID_BYTES / 2) {
      throw new Error(
        `level-${level} block map has ${nonZero} of ${GRID_BYTES} blocks driven. Most of a ` +
          `playfield is flat; a majority-driven map is a misframed read.`,
      );
    }
    // A drive region is a run along a rail. Confetti would give one component
    // per cell; the shipped maps give one per zone.
    if (components > nonZero / 4) {
      throw new Error(
        `level-${level} block map breaks into ${components} components over ${nonZero} driven ` +
          `blocks — too fragmented to be regions on a rail`,
      );
    }
    return { nonZero, components };
  });

  return { grids, vectors, stats, reloc, highest };
}

function buildDocument(table, decoded) {
  return {
    schema: "pinball-illusions/table-accel/v1",
    tableId: table.tableId,
    displayName: table.displayName,
    provenance: PROVENANCE,
    blockSize: BLOCK_SIZE,
    columns: COLUMNS,
    rows: ROWS,
    // The vectors exactly as the disk stores them: signed word pairs in the
    // original's per-substep velocity units. The conversion into the port's
    // Q10-per-tick is in src/game/table-accel.ts, with its derivation, because
    // it is a fact about this reconstruction rather than about the disk.
    vectors: decoded.vectors,
    // Index 0 is level 0, index 1 is level 1 — the file order, which is also the
    // order the engine's two per-level pointer groups are laid out in.
    levels: decoded.grids.map((grid) => {
      const rows = [];
      for (let row = 0; row < ROWS; row += 1) rows.push(toRuns(grid, row));
      return rows;
    }),
  };
}

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const segDir = positional[0];
  const outDir = positional[1] ?? "public/generated/tables";

  if (segDir === undefined) {
    console.error("usage: node scripts/export-table-accel.mjs <segment-dir> [out-dir] [--check]");
    return 1;
  }
  if (!existsSync(segDir)) {
    console.error(`segment directory not found: ${segDir}`);
    return 1;
  }
  if (!check) mkdirSync(outDir, { recursive: true });

  console.log(check ? "checking table ramp drive" : "exporting table ramp drive");
  let failures = 0;

  for (const table of TABLES) {
    const seg = join(segDir, `${table.stem}.seg04.bin`);
    if (!existsSync(seg)) {
      console.error(`  ${table.tableId}: ${table.stem}.seg04.bin missing, skipped`);
      failures += 1;
      continue;
    }

    // One table's failure must not hide the other two: a framing mistake usually
    // breaks all three the same way, and seeing that is the diagnosis.
    let decoded;
    try {
      decoded = decode(readFileSync(seg), descriptorWords(segDir, table.stem), table.stem);
    } catch (error) {
      console.error(
        `  ${table.tableId.padStart(15)}: ${error instanceof Error ? error.message : error}`,
      );
      failures += 1;
      continue;
    }

    const doc = buildDocument(table, decoded);
    const json = JSON.stringify(doc);
    const out = join(outDir, `${table.tableId}.accel.json`);

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
      `  ${" ".repeat(15)}  ${decoded.vectors.length} vectors, highest index used ${decoded.highest}; ` +
        `relocations ${decoded.reloc.summary} (${decoded.reloc.total}), lowest at ${decoded.reloc.lowest}`,
    );
    for (const [level, stat] of decoded.stats.entries()) {
      console.log(
        `  ${" ".repeat(15)}  level ${level}: ${stat.nonZero}/${GRID_BYTES} blocks driven ` +
          `(${((stat.nonZero / GRID_BYTES) * 100).toFixed(1)}%) in ${stat.components} regions`,
      );
    }
    console.log(
      `  ${" ".repeat(15)}  vectors ${decoded.vectors.map(([x, y]) => `(${x},${y})`).join(" ")}`,
    );
  }

  if (failures > 0) {
    console.error(`${failures} table(s) ${check ? "differ or are missing" : "could not be exported"}`);
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
