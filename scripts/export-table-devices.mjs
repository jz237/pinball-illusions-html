#!/usr/bin/env node
// Decodes the SCORING LAYER out of the table packages into the documents under
// public/generated/tables/*.devices.json. Run locally, where the operator's own
// disks live; the JSON it writes is what ships.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS
// ---------------------------------------------------------------------------
// Everything the original scores with, and the map that says WHERE:
//
//   - the SURFACE-ID map, one byte per pixel per playfield level, which is what
//     turns "the ball touched a wall" into "the ball touched bumper 2";
//   - the DEVICE CHAIN, the per-table array of target / mode / kicker records
//     the surface ids index, with the packed-BCD award beside each one;
//   - the BUMPER and SLINGSHOT record lists, which are a separate family
//     dispatched straight out of the collision responder;
//   - the ZONE LIST, 14-byte rectangles that carry most of the table's scoring
//     (out/inlanes, ramp runs, loops) plus the level transitions and the locks.
//
// None of it was reachable before because the table package's pointer header
// reads as zeros on disk. It is not zeros: every decompressed TSL segment is
//
//     [u32 body_len][body][reloc blocks][u32 0]
//     reloc block = [u32 count][u32 target_hunk][u32 offsets[count]]
//
// and the longword at each listed offset holds the OFFSET INSIDE the target
// hunk. Slot index == hunk number, so applying the tables stitches the package
// into one navigable address space. That is the whole key, and everything below
// follows from it mechanically.
//
// ---------------------------------------------------------------------------
// THE STRUCTURES, AND THE 68000 THAT READS THEM
// ---------------------------------------------------------------------------
// The 152-byte pointer header is the first 38 longs of slot 0's body, which
// main.seg00 block-copies to `$22EE(a5)` at +0x0032F2. Header offset k lands at
// `a5+$22EE+k`; the ones used here:
//
//     +0x10 $22FE LOWER device array      +0x28 $2316 UPPER device array
//     +0x14 $2302 LOWER zone list         +0x2C $231A UPPER zone list
//     +0x30 $231E bumper records          +0x34 $2322 slingshot records
//
// SURFACE-ID MAP (slot 1). Two blocks back to back, one per level. Each is a
// 2400-entry u16 offset table followed by (column, id) byte pairs; the offsets
// are PAIR indices, so list i runs over bytes 2*offs[i] .. 2*offs[i+1] past the
// end of the table. List i is `y = i/4, band = i%4` and a pair's column c is
// `x = c + 84*band`. The consumer is main.seg00 +0x00AD42..0x00AE3E.
//
// DEVICE ARRAYS. 160 longs each, and SPARSE — a NULL entry is a hole, not a
// terminator, because the index is `surface id - 32` and the ids are not dense.
// Law 'n Justice fills 0..4 and 96..97 (ids 32..36 and 128..129); BabeWatch
// fills 0..9 and 32 (ids 32..41 and 64). Dispatch, at +0x000055A0:
//
//     0055a0  move.w  $6c(a4), d0          ; device index = surface id - 32
//     0055a6  movea.l $60(a4), a0          ; the level's device array
//     0055aa  move.l  (a0,d0.w*4), d1      ; the record
//     0055b4  move.w  (a0), d2             ; record word 0 = TYPE
//     0055b6  move.w  $10(pc,d2.w*2), d2   ; the 3-entry table at $55C8
//     0055bc  jsr     $c(pc,d2.w)          ; -> $55CE / $564C / $56B0
//
// so there are exactly three types and word 0 is 0, 1 or 2. Type 0 is a target
// (award record at +$0C), type 1 a mode start (mode record at +$22), type 2 a
// kicker (velocity word pair at +$06 written straight over the ball's).
//
// AWARD ARITHMETIC. Three primitives, each taking A3 = the END of an 8-byte BCD
// field and running `ANDI #$EF,CCR` then six `ABCD`:
//
//     $6B96  bonus += [a3-6..a3-1]  AND  score += [a3-14..a3-9]
//     $6BCC  score += [a3-6..a3-1]
//     $6BEE  bonus += [a3-6..a3-1]
//
// The direction is fixed by the player record rather than assumed: +0x00463E
// does `movem.l (player),d0-d1` and compares against the high-score table at
// `$d48(a5)`, so player+$00..$07 is the SCORE and $6B96's second field — the one
// 8 bytes EARLIER than its first — is the score. Read the other way round every
// award in the corpus is zero or garbage; read this way they are 25,000 /
// 50,000 / 75,000 / 100,000 / 250,000 / 500,000.
//
// A type-0 target takes `lea $12(a1),a3` into $6B96 on a first hit (score at
// award+$04, bonus at award+$0C) and `lea $1A(a1),a3` into $6BCC on a repeat
// (score at award+$14). The repeat path is only reachable when the record has a
// per-player FLAG byte for `bset` to find already set; with a NULL flag pointer
// the branch falls through to the first-hit path every time.
//
// BUMPERS AND SLINGSHOTS are not in the device chain at all. The collision
// responder reads the ball's own device slots and indexes the two lists:
//
//     00b57a  move.b  $4(a4), d3           ; bumper 1..6, set from id-15
//     00b582  cmpi.w  #$ffce, d0           ; needs vn <= -50
//     00b588  subi.w  #$157c, d0           ; +5500 into the inward normal
//     00b590  movea.l $231e(a5), a1
//     00b594  adda.w  -$2(a1,d3.w*2), a1   ; offsets[index-1]
//     00b5a4  lea     $16(a1), a3
//     00b5a8  jsr     $6bcc                ; score at record+$10..$15
//
//     00b5d6  move.b  $5(a4), d3           ; slingshot 1..5, from ((id-22)>>1)+1
//     00b5da  cmpi.w  #$ff9c, d0           ; needs vn <= -100
//     00b5e0  subi.w  #$dac, d0            ; +3500 into the inward normal
//     00b5e4  add.w   $6(a4), d2           ; and +-400 along the surface
//
// Each list is a 0-terminated u16 offset table followed by the records; record
// +$10..$15 is the packed-BCD score.
//
// ZONE LISTS. 14-byte records `{u16 x0,y0,x1,y1; u16 type; u32 object}`,
// terminated by a negative x0, scanned at +0x000052E6 against the ball CENTRE.
// Five types, from the table at $53A8: 0 and 1 trigger, 2 send to upper, 3 send
// to lower, 4 lock. A trigger object holds score at +$10, bonus at +$18 and
// repeat score at +$20; a lock object score at +$1E and bonus at +$26.
//
// ---------------------------------------------------------------------------
// THE CHECKS, ALL FATAL, AND WHY THE FIRST ONE IS THE ONE THAT MATTERS
// ---------------------------------------------------------------------------
// 1. THE SURFACE MAP IS THE COLLISION MAP. Take every pixel the decoded surface
//    map gives an id to, drop the ids 1..4 the engine's own jump table calls
//    flippers (they are the swept footprint of a moving part, not a wall), and
//    the set that remains must be EXACTLY the set of pixels the already-shipped
//    <table>.map.json marks solid on the same level. Not "mostly", not
//    "contains": equal, both ways, on both levels, on all three tables. Two
//    files decoded from two different slots by two unrelated routines agreeing
//    pixel for pixel is not something a framing mistake produces.
// 2. EVERY DEVICE HAS A SURFACE AND EVERY SURFACE A DEVICE. The set of ids >= 32
//    in the map and the set of `index + 32` over the filled device slots must
//    match. Exceptions are listed explicitly below, not tolerated silently.
// 3. THE BUMPER AND SLINGSHOT COUNTS ARE THE MAP'S COUNTS. The number of records
//    in each list must equal the number of distinct bumper (16..21) and
//    slingshot (22..31, paired) ids the map actually carries.
// 4. EVERY BCD FIELD IS BCD. A nibble above 9 anywhere means the field is not
//    where this decode thinks it is.
// 5. THE RELOCATION TABLES PARSE TO THE BYTE on every slot of every package.
//
// Usage:
//   node scripts/export-table-devices.mjs <segment-dir> [out-dir] [--check]
//
// <segment-dir> holds the decompressed package slots as either <stem>.sNN.bin
// (preferred; a sibling `seg2` directory is searched too) or <stem>.segNN.bin.
// The shipped <id>.map.json in <out-dir> is read for check 1 and is required.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

/** Playfield dimensions. Must match PLAYFIELD_WIDTH/HEIGHT in src/game/contracts.ts. */
const WIDTH = 336;
const HEIGHT = 600;

/** Hunk data begins immediately after the u32 length word. */
const PREAMBLE = 4;

/** Surface-id map: 2400 lists, four 84-pixel bands per row. */
const SURFACE_LISTS = 2400;
const SURFACE_BANDS = 4;
const SURFACE_BAND_WIDTH = WIDTH / SURFACE_BANDS; // 84

/** Header offsets, as byte offsets into slot 0's body. See the note above. */
const HEADER_LOWER_DEVICES = 0x10;
const HEADER_LOWER_ZONES = 0x14;
const HEADER_UPPER_DEVICES = 0x28;
const HEADER_UPPER_ZONES = 0x2c;
const HEADER_BUMPERS = 0x30;
const HEADER_SLINGSHOTS = 0x34;

/** Longs in a device array. Lower base to upper base is exactly 4 * this. */
const DEVICE_SLOTS = 160;

/** Surface ids, from the engine's 32-entry jump table at main.seg00 +0x00AE40. */
const FLIPPER_ID_MIN = 1;
const FLIPPER_ID_MAX = 4;
const BUMPER_ID_MIN = 16;
const BUMPER_ID_MAX = 21;
const SLINGSHOT_ID_MIN = 22;
const SLINGSHOT_ID_MAX = 31;
const DEVICE_ID_BASE = 32;

/** Record field offsets. Every one is quoted to its instruction in the header. */
const AWARD_FIRST_SCORE = 0x04;
const AWARD_FIRST_BONUS = 0x0c;
const AWARD_REPEAT_SCORE = 0x14;
const MODE_SCORE = 0x08;
const MODE_BONUS = 0x10;
const DEVICE_AWARD_POINTER = 0x0c;
const DEVICE_FLAG_POINTER = 0x04;
const DEVICE_MODE_POINTER = 0x22;
const DEVICE_KICK_VELOCITY = 0x06;
const HIT_RECORD_SCORE = 0x10;
const ZONE_RECORD_BYTES = 14;
const ZONE_TRIGGER_SCORE = 0x10;
const ZONE_TRIGGER_BONUS = 0x18;
const ZONE_TRIGGER_REPEAT = 0x20;
const ZONE_TRIGGER_FLAG = 0x0a;
const ZONE_LOCK_SCORE = 0x1e;
const ZONE_LOCK_BONUS = 0x26;

/** Packed-BCD award fields are six bytes, twelve digits, like the player score. */
const BCD_BYTES = 6;

const ZONE_KINDS = ["trigger-a", "trigger-b", "to-upper", "to-lower", "lock"];
const DEVICE_KINDS = ["target", "mode", "kicker"];

const TABLES = [
  { stem: "Table001", tableId: "law-n-justice", displayName: "Law 'n Justice" },
  { stem: "Table002", tableId: "babewatch", displayName: "BabeWatch" },
  { stem: "Table003", tableId: "extreme-sports", displayName: "Extreme Sports" },
];

/**
 * Device slots that are filled but whose surface id is nowhere in the map, and
 * are therefore unreachable in the shipped data. Listed rather than tolerated:
 * a NEW one appearing must fail the export, because it would mean a device the
 * player can hit that this decode is silently dropping.
 *
 * Extreme Sports slot 96 is surface id 128 and Extreme Sports' map has no id
 * above 36 at all. Its record's word 0 reads 0, i.e. it looks like a target, but
 * nothing can dispatch to it. Linker residue.
 */
const UNREACHABLE_DEVICE_SLOTS = { "extreme-sports": [96] };

/**
 * Devices whose surface id lives on the OTHER level from the array holding
 * their record, and which the engine therefore never fires.
 *
 * BabeWatch id 41 is a stand-up target below the CASINO ramp exit, drawn on the
 * upper collision line at (95,97)-(104,106), and its 75,000 record sits at index
 * 9 of the LOWER array. On the upper level the ball's `$60(a4)` is `$2316(a5)`,
 * whose every slot is NULL on all three tables, so the dispatch at +0x000055AA
 * reads NULL and returns. This is reproduced rather than repaired: the export
 * ships the record on the level whose array holds it, the runtime looks it up
 * the way the engine does, and the target stays dead. Repairing it would be
 * inventing a rule the original does not have.
 */
const CROSS_LEVEL_DEVICE_IDS = { babewatch: [41] };

const PROVENANCE = {
  sourceClass: "disk-derived-scoring-devices",
  description:
    "Per-pixel surface-id map, device and award records, bumper and slingshot " +
    "records and the zone list, decoded from the operator's own AGA floppy set. " +
    "Functional rules data only: no artwork, audio or executable code.",
  authorizationRequired: true,
};

// ---------------------------------------------------------------------------
// The package: slots, relocation, and a flat address space
// ---------------------------------------------------------------------------

/**
 * One loaded table package.
 *
 * `bodies[h]` is hunk h's payload and `relocations` maps a `(hunk, offset)` key
 * to the hunk the longword there points into. A pointer is therefore a
 * `{ hunk, offset }` pair and following one is a map lookup plus a u32 read —
 * no address arithmetic and no synthetic bases, so a pointer that was never
 * relocated is impossible to confuse with one that was.
 */
function loadPackage(segDir, stem) {
  const bodies = [];
  const relocations = new Map();
  const seg2 = join(dirname(resolve(segDir)), "seg2");

  for (let slot = 0; ; slot += 1) {
    const candidates = [
      join(seg2, `${stem}.s${String(slot).padStart(2, "0")}.bin`),
      join(segDir, `${stem}.s${String(slot).padStart(2, "0")}.bin`),
      join(segDir, `${stem}.seg${String(slot).padStart(2, "0")}.bin`),
    ];
    const path = candidates.find((candidate) => existsSync(candidate));
    if (path === undefined) break;

    const raw = readFileSync(path);
    if (raw.length < PREAMBLE + 4) throw new Error(`${path}: too short to be a segment`);
    const declared = raw.readUInt32BE(0);
    if (PREAMBLE + declared > raw.length) {
      throw new Error(`${path}: declares a ${declared}-byte body inside a ${raw.length}-byte file`);
    }
    bodies.push(raw.subarray(PREAMBLE, PREAMBLE + declared));

    // CHECK 5 — the relocation blocks must consume the tail exactly.
    let at = PREAMBLE + declared;
    for (;;) {
      if (at + 4 > raw.length) throw new Error(`${path}: relocation blocks run past the file`);
      const count = raw.readUInt32BE(at);
      at += 4;
      if (count === 0) break;
      if (at + 4 + count * 4 > raw.length) {
        throw new Error(`${path}: relocation block of ${count} entries overruns the file`);
      }
      const target = raw.readUInt32BE(at);
      at += 4;
      for (let i = 0; i < count; i += 1) {
        relocations.set(`${slot}:${raw.readUInt32BE(at)}`, target);
        at += 4;
      }
    }
    // A trailing partial longword is the padding the packer leaves; more than
    // that means the tail is not a relocation table.
    if (raw.length - at > 3) {
      throw new Error(
        `${path}: relocation blocks end at byte ${at} of ${raw.length}; they must consume the ` +
          `file or this is not the format this decode assumes`,
      );
    }
  }

  if (bodies.length === 0) {
    throw new Error(
      `no package slots found for ${stem}. Looked for ${stem}.sNN.bin and ${stem}.segNN.bin ` +
        `under ${segDir} and ${seg2}.`,
    );
  }
  return { stem, bodies, relocations };
}

function bodyOf(pkg, hunk) {
  const body = pkg.bodies[hunk];
  if (body === undefined) throw new Error(`${pkg.stem}: hunk ${hunk} is not in this package`);
  return body;
}

function readU8(pkg, at, delta = 0) {
  return bodyOf(pkg, at.hunk).readUInt8(at.offset + delta);
}
function readU16(pkg, at, delta = 0) {
  return bodyOf(pkg, at.hunk).readUInt16BE(at.offset + delta);
}
function readS16(pkg, at, delta = 0) {
  return bodyOf(pkg, at.hunk).readInt16BE(at.offset + delta);
}
function readU32(pkg, at, delta = 0) {
  return bodyOf(pkg, at.hunk).readUInt32BE(at.offset + delta);
}

/** Follows the relocated longword at `at + delta`, or null when it is not a pointer. */
function follow(pkg, at, delta = 0) {
  const target = pkg.relocations.get(`${at.hunk}:${at.offset + delta}`);
  if (target === undefined) return null;
  const offset = readU32(pkg, at, delta);
  const body = bodyOf(pkg, target);
  if (offset >= body.length) {
    throw new Error(
      `${pkg.stem}: pointer at hunk ${at.hunk}+${at.offset + delta} lands at hunk ${target}+` +
        `${offset}, past that hunk's ${body.length} bytes`,
    );
  }
  return { hunk: target, offset };
}

/** CHECK 4 — a six-byte packed-BCD field as a decimal number. */
function readBcd(pkg, at, delta) {
  const body = bodyOf(pkg, at.hunk);
  let value = 0;
  for (let i = 0; i < BCD_BYTES; i += 1) {
    const byte = body.readUInt8(at.offset + delta + i);
    const high = byte >> 4;
    const low = byte & 0x0f;
    if (high > 9 || low > 9) {
      throw new Error(
        `${pkg.stem}: BCD field at hunk ${at.hunk}+${at.offset + delta} contains byte ` +
          `0x${byte.toString(16).padStart(2, "0")}, which is not two decimal digits; the field ` +
          `is not where this decode thinks it is`,
      );
    }
    value = value * 100 + high * 10 + low;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Slot 1: the surface-id map
// ---------------------------------------------------------------------------

/**
 * Parses one of the two surface-id blocks, returning its pixels and the byte
 * offset just past it.
 *
 * The assertions are the framing proof. Offsets must be monotonic (they delimit
 * consecutive slices of one byte array), each list's columns must ascend and
 * stay inside the 84-pixel band, and the second block must finish within a
 * padding longword of the body's end. A block read at the wrong offset fails the
 * first of those immediately.
 */
function decodeSurfaceBlock(body, start) {
  const offsets = new Array(SURFACE_LISTS);
  for (let i = 0; i < SURFACE_LISTS; i += 1) {
    offsets[i] = body.readUInt16BE(start + 2 * i);
    if (i > 0 && offsets[i] < offsets[i - 1]) {
      throw new Error(
        `surface-id block at ${start}: offset ${i} is ${offsets[i]}, before offset ${i - 1}'s ` +
          `${offsets[i - 1]}; the offset table must be monotonic`,
      );
    }
  }
  const base = start + 2 * SURFACE_LISTS;
  const pixels = new Uint8Array(WIDTH * HEIGHT);
  let painted = 0;

  for (let i = 0; i < SURFACE_LISTS - 1; i += 1) {
    const y = Math.floor(i / SURFACE_BANDS);
    const bandBase = (i % SURFACE_BANDS) * SURFACE_BAND_WIDTH;
    let previousColumn = -1;
    for (let pair = offsets[i]; pair < offsets[i + 1]; pair += 1) {
      const column = body.readUInt8(base + 2 * pair);
      const id = body.readUInt8(base + 2 * pair + 1);
      if (column <= previousColumn || column >= SURFACE_BAND_WIDTH) {
        throw new Error(
          `surface-id block at ${start}: list ${i} has column ${column} after ${previousColumn}; ` +
            `columns must ascend and stay under ${SURFACE_BAND_WIDTH}`,
        );
      }
      previousColumn = column;
      pixels[y * WIDTH + bandBase + column] = id;
      painted += 1;
    }
  }
  return { pixels, painted, end: base + 2 * offsets[SURFACE_LISTS - 1] };
}

function decodeSurfaceMap(pkg) {
  const body = bodyOf(pkg, 1);
  const lower = decodeSurfaceBlock(body, 0);
  const upper = decodeSurfaceBlock(body, lower.end);
  if (body.length - upper.end > 2) {
    throw new Error(
      `${pkg.stem}: ${body.length - upper.end} bytes left over after the second surface-id ` +
        `block; slot 1 is exactly two blocks and nothing else`,
    );
  }
  return [lower, upper];
}

// ---------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------

/** The 152-byte pointer header: the first 38 longs of slot 0's body. */
function headerPointer(pkg, offset) {
  return follow(pkg, { hunk: 0, offset: 0 }, offset);
}

function decodeDevices(pkg, arrayBase, level, unreachable) {
  if (arrayBase === null) return [];
  const out = [];
  for (let index = 0; index < DEVICE_SLOTS; index += 1) {
    const record = follow(pkg, arrayBase, 4 * index);
    if (record === null) continue; // A hole. The array is sparse; see the header.
    // Residue: the slot is filled but no pixel carries its id, so nothing can
    // dispatch to it. Recorded so the checks below can insist the map agrees,
    // but NOT dereferenced — Extreme Sports' slot 96 points at bytes that are
    // not a device record and reading them would fail for the right reason on
    // the wrong record.
    if (unreachable.has(index)) {
      out.push({ level, index, surfaceId: index + DEVICE_ID_BASE, kind: "residue" });
      continue;
    }
    const type = readU16(pkg, record);
    const kind = DEVICE_KINDS[type];
    if (kind === undefined) {
      throw new Error(
        `${pkg.stem}: device slot ${index} (surface id ${index + DEVICE_ID_BASE}) has record type ` +
          `${type}; the dispatch table at $55C8 has exactly ${DEVICE_KINDS.length} entries`,
      );
    }

    const device = { level, index, surfaceId: index + DEVICE_ID_BASE, kind };
    if (type === 0) {
      const award = follow(pkg, record, DEVICE_AWARD_POINTER);
      if (award === null) {
        throw new Error(`${pkg.stem}: target device ${index} has no award record at +$0C`);
      }
      device.score = readBcd(pkg, award, AWARD_FIRST_SCORE);
      device.bonus = readBcd(pkg, award, AWARD_FIRST_BONUS);
      // The repeat award is only reachable when the record carries a per-player
      // flag byte for `bset` to find already set. With a NULL flag pointer the
      // handler falls through to the first-hit path every time, so the field is
      // inert data and shipping it as a live value would invent scoring.
      const repeatable = follow(pkg, record, DEVICE_FLAG_POINTER) !== null;
      device.repeatScore = repeatable ? readBcd(pkg, award, AWARD_REPEAT_SCORE) : 0;
      device.repeatable = repeatable;
    } else if (type === 1) {
      const mode = follow(pkg, record, DEVICE_MODE_POINTER);
      if (mode === null) {
        throw new Error(`${pkg.stem}: mode device ${index} has no mode record at +$22`);
      }
      device.score = readBcd(pkg, mode, MODE_SCORE);
      device.bonus = readBcd(pkg, mode, MODE_BONUS);
      device.repeatScore = 0;
      device.repeatable = false;
    } else {
      device.score = 0;
      device.bonus = 0;
      device.repeatScore = 0;
      device.repeatable = false;
      device.velocityX = readS16(pkg, record, DEVICE_KICK_VELOCITY);
      device.velocityY = readS16(pkg, record, DEVICE_KICK_VELOCITY + 2);
    }
    out.push(device);
  }
  return out;
}

/** A bumper or slingshot list: 0-terminated u16 offsets, then the records. */
function decodeHitRecords(pkg, base, label) {
  if (base === null) throw new Error(`${pkg.stem}: no ${label} list in the pointer header`);
  const out = [];
  for (let i = 0; ; i += 1) {
    const offset = readU16(pkg, base, 2 * i);
    if (offset === 0) break;
    if (i >= DEVICE_SLOTS) throw new Error(`${pkg.stem}: ${label} offset list is not terminated`);
    out.push({
      index: i + 1,
      score: readBcd(pkg, { hunk: base.hunk, offset: base.offset + offset }, HIT_RECORD_SCORE),
    });
  }
  return out;
}

function decodeZones(pkg, base, level) {
  if (base === null) return [];
  const out = [];
  for (let index = 0; ; index += 1) {
    const at = { hunk: base.hunk, offset: base.offset + ZONE_RECORD_BYTES * index };
    const minX = readU16(pkg, at);
    if (minX >= 0x8000) break; // A negative x0 terminates the list.
    if (index > 200) throw new Error(`${pkg.stem}: zone list on level ${level} is not terminated`);

    const type = readU16(pkg, at, 8);
    const kind = ZONE_KINDS[type];
    if (kind === undefined) {
      throw new Error(
        `${pkg.stem}: zone ${index} on level ${level} has type ${type}; the table at $53A8 has ` +
          `exactly ${ZONE_KINDS.length} entries`,
      );
    }
    const zone = {
      level,
      index,
      kind,
      minX,
      minY: readU16(pkg, at, 2),
      maxX: readU16(pkg, at, 4),
      maxY: readU16(pkg, at, 6),
      score: 0,
      bonus: 0,
      repeatScore: 0,
    };
    if (zone.maxX < zone.minX || zone.maxY < zone.minY) {
      throw new Error(
        `${pkg.stem}: zone ${index} on level ${level} is (${zone.minX},${zone.minY})-` +
          `(${zone.maxX},${zone.maxY}), which is inside out`,
      );
    }

    const object = follow(pkg, at, 10);
    if (type === 0 || type === 1) {
      if (object === null) throw new Error(`${pkg.stem}: trigger zone ${index} has no object`);
      zone.score = readBcd(pkg, object, ZONE_TRIGGER_SCORE);
      zone.bonus = readBcd(pkg, object, ZONE_TRIGGER_BONUS);
      const repeatable = follow(pkg, object, ZONE_TRIGGER_FLAG) !== null;
      zone.repeatScore = repeatable ? readBcd(pkg, object, ZONE_TRIGGER_REPEAT) : 0;
      zone.repeatable = repeatable;
    } else if (type === 4) {
      if (object === null) throw new Error(`${pkg.stem}: lock zone ${index} has no object`);
      zone.score = readBcd(pkg, object, ZONE_LOCK_SCORE);
      zone.bonus = readBcd(pkg, object, ZONE_LOCK_BONUS);
      zone.repeatable = false;
    } else {
      // A level transition carries no object and no award.
      zone.repeatable = false;
    }
    out.push(zone);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checks that cross two files
// ---------------------------------------------------------------------------

/** Expands a shipped <id>.map.json into one bit per pixel for the given level. */
function solidPixelsOf(mapDocument, level, label) {
  const rows = mapDocument.rows;
  if (!Array.isArray(rows) || rows.length !== HEIGHT) {
    throw new Error(`${label}: shipped map has ${rows?.length} rows, expected ${HEIGHT}`);
  }
  const bit = level === 0 ? 1 : 2;
  const solid = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const row = rows[y];
    let previousEnd = -1;
    for (let i = 0; i < row.length; i += 2) {
      const end = row[i];
      const material = row[i + 1];
      if ((material & bit) !== 0) solid.fill(1, y * WIDTH + previousEnd + 1, y * WIDTH + end + 1);
      previousEnd = end;
    }
  }
  return solid;
}

/**
 * CHECK 1 — the surface map and the collision map are the same geometry.
 *
 * The ids the engine's jump table calls flippers (1..4) are excluded: they mark
 * the swept footprint of the bats, which is not on either collision line. What
 * is left must be exactly the shipped map's solid set for that level.
 */
function checkAgainstCollisionMap(surfacePixels, solid, label) {
  let onlySurface = 0;
  let onlyMap = 0;
  let both = 0;
  let flippers = 0;
  let firstMismatch = null;
  for (let i = 0; i < surfacePixels.length; i += 1) {
    const id = surfacePixels[i];
    if (id >= FLIPPER_ID_MIN && id <= FLIPPER_ID_MAX) {
      flippers += 1;
      continue;
    }
    const hasId = id !== 0;
    const isSolid = solid[i] === 1;
    if (hasId && isSolid) both += 1;
    else if (hasId) {
      onlySurface += 1;
      firstMismatch ??= `(${i % WIDTH},${Math.floor(i / WIDTH)}) has surface id ${id} but is not solid`;
    } else if (isSolid) {
      onlyMap += 1;
      firstMismatch ??= `(${i % WIDTH},${Math.floor(i / WIDTH)}) is solid but has no surface id`;
    }
  }
  if (onlySurface !== 0 || onlyMap !== 0) {
    throw new Error(
      `${label}: the surface-id map and the shipped collision map disagree — ${both} pixels in ` +
        `both, ${onlySurface} with an id only, ${onlyMap} solid only. First: ${firstMismatch}`,
    );
  }
  return { both, flippers };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Run-length encodes one surface-id row as flat [inclusive_end_x, id] pairs. */
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

function histogramOf(pixels) {
  const counts = new Map();
  for (const value of pixels) counts.set(value, (counts.get(value) ?? 0) + 1);
  const out = {};
  for (const id of [...counts.keys()].sort((a, b) => a - b)) {
    if (id !== 0) out[String(id)] = counts.get(id);
  }
  return out;
}

function distinctIdsIn(pixels, min, max) {
  const seen = new Set();
  for (const value of pixels) if (value >= min && value <= max) seen.add(value);
  return [...seen].sort((a, b) => a - b);
}

function decode(pkg, table, mapDocument) {
  const surfaces = decodeSurfaceMap(pkg);

  // CHECK 1, on both levels.
  const agreement = surfaces.map((surface, level) =>
    checkAgainstCollisionMap(
      surface.pixels,
      solidPixelsOf(mapDocument, level, table.tableId),
      `${table.tableId} level ${level}`,
    ),
  );

  const unreachable = new Set(UNREACHABLE_DEVICE_SLOTS[table.tableId] ?? []);
  const devices = [
    ...decodeDevices(pkg, headerPointer(pkg, HEADER_LOWER_DEVICES), 0, unreachable),
    ...decodeDevices(pkg, headerPointer(pkg, HEADER_UPPER_DEVICES), 1, unreachable),
  ];
  const zones = [
    ...decodeZones(pkg, headerPointer(pkg, HEADER_LOWER_ZONES), 0),
    ...decodeZones(pkg, headerPointer(pkg, HEADER_UPPER_ZONES), 1),
  ];
  const bumpers = decodeHitRecords(pkg, headerPointer(pkg, HEADER_BUMPERS), "bumper");
  const slingshots = decodeHitRecords(pkg, headerPointer(pkg, HEADER_SLINGSHOTS), "slingshot");

  // CHECK 2 — the device slots and the map's device ids are the same set.
  const mapDeviceIds = new Set();
  for (const surface of surfaces) {
    for (const id of distinctIdsIn(surface.pixels, DEVICE_ID_BASE, 255)) mapDeviceIds.add(id);
  }
  const recordIds = new Set();
  for (const device of devices) {
    if (unreachable.has(device.index)) continue;
    recordIds.add(device.surfaceId);
  }
  for (const device of devices) {
    if (!unreachable.has(device.index)) continue;
    if (mapDeviceIds.has(device.surfaceId)) {
      throw new Error(
        `${table.tableId}: device slot ${device.index} is listed as unreachable residue but ` +
          `surface id ${device.surfaceId} is on the map after all`,
      );
    }
  }
  const missingRecord = [...mapDeviceIds].filter((id) => !recordIds.has(id));
  const missingSurface = [...recordIds].filter((id) => !mapDeviceIds.has(id));
  if (missingRecord.length > 0 || missingSurface.length > 0) {
    throw new Error(
      `${table.tableId}: device ids on the map without a record ${JSON.stringify(missingRecord)}; ` +
        `records without a surface ${JSON.stringify(missingSurface)}`,
    );
  }

  // CHECK 3 — the hit-record counts are the map's own counts.
  const bumperIds = new Set();
  const slingshotIds = new Set();
  for (const surface of surfaces) {
    for (const id of distinctIdsIn(surface.pixels, BUMPER_ID_MIN, BUMPER_ID_MAX)) bumperIds.add(id);
    for (const id of distinctIdsIn(surface.pixels, SLINGSHOT_ID_MIN, SLINGSHOT_ID_MAX)) {
      slingshotIds.add((id - SLINGSHOT_ID_MIN) >> 1);
    }
  }
  if (bumperIds.size !== bumpers.length) {
    throw new Error(
      `${table.tableId}: the map carries ${bumperIds.size} bumper ids but the record list has ` +
        `${bumpers.length} entries`,
    );
  }
  if (slingshotIds.size !== slingshots.length) {
    throw new Error(
      `${table.tableId}: the map carries ${slingshotIds.size} slingshot pairs but the record list ` +
        `has ${slingshots.length} entries`,
    );
  }

  // The cross-level devices are stated, so a new one shows up as a failure
  // rather than as a target that silently never scores.
  const declaredCrossLevel = new Set(CROSS_LEVEL_DEVICE_IDS[table.tableId] ?? []);
  for (const device of devices) {
    if (unreachable.has(device.index)) continue;
    const onItsLevel = distinctIdsIn(surfaces[device.level].pixels, DEVICE_ID_BASE, 255).includes(
      device.surfaceId,
    );
    if (onItsLevel === declaredCrossLevel.has(device.surfaceId)) {
      throw new Error(
        `${table.tableId}: device id ${device.surfaceId} is ${onItsLevel ? "on" : "not on"} the ` +
          `level ${device.level} surface map, which contradicts CROSS_LEVEL_DEVICE_IDS`,
      );
    }
  }

  return {
    surfaces,
    agreement,
    devices: devices.filter((device) => !unreachable.has(device.index)),
    droppedDevices: devices.filter((device) => unreachable.has(device.index)).length,
    zones,
    bumpers,
    slingshots,
    bumperIds: [...bumperIds].sort((a, b) => a - b),
  };
}

function buildDocument(table, decoded) {
  return {
    schema: "pinball-illusions/table-devices/v1",
    tableId: table.tableId,
    displayName: table.displayName,
    provenance: PROVENANCE,
    width: WIDTH,
    height: HEIGHT,
    devices: decoded.devices,
    bumpers: decoded.bumpers,
    slingshots: decoded.slingshots,
    zones: decoded.zones,
    surfaceHistogram: decoded.surfaces.map((surface) => histogramOf(surface.pixels)),
    // Index 0 is the playfield line and index 1 the ramp line, matching
    // `PlayfieldLevel` and the order the two blocks appear in slot 1.
    surfaceIds: decoded.surfaces.map((surface) => {
      const rows = [];
      for (let y = 0; y < HEIGHT; y += 1) rows.push(toRuns(surface.pixels, y));
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
    console.error("usage: node scripts/export-table-devices.mjs <segment-dir> [out-dir] [--check]");
    return 1;
  }
  if (!existsSync(segDir)) {
    console.error(`segment directory not found: ${segDir}`);
    return 1;
  }
  if (!check) mkdirSync(outDir, { recursive: true });

  console.log(check ? "checking table devices and awards" : "exporting table devices and awards");
  let failures = 0;

  for (const table of TABLES) {
    const mapPath = join(outDir, `${table.tableId}.map.json`);
    if (!existsSync(mapPath)) {
      console.error(
        `  ${table.tableId.padStart(15)}: ${mapPath} missing. The shipped collision map is what ` +
          `the surface-id decode is checked against and is not optional.`,
      );
      failures += 1;
      continue;
    }

    let decoded;
    try {
      decoded = decode(
        loadPackage(segDir, table.stem),
        table,
        JSON.parse(readFileSync(mapPath, "utf8")),
      );
    } catch (error) {
      console.error(
        `  ${table.tableId.padStart(15)}: ${error instanceof Error ? error.message : error}`,
      );
      failures += 1;
      continue;
    }

    const json = JSON.stringify(buildDocument(table, decoded));
    const out = join(outDir, `${table.tableId}.devices.json`);
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

    const pad = " ".repeat(15);
    for (const [level, agree] of decoded.agreement.entries()) {
      console.log(
        `  ${pad}  level ${level}: ${agree.both} pixels agree with the collision map exactly, ` +
          `${agree.flippers} more carry a flipper id`,
      );
    }
    console.log(
      `  ${pad}  ${decoded.devices.length} devices (${decoded.droppedDevices} unreachable slot(s) ` +
        `dropped), ${decoded.bumpers.length} bumpers ${JSON.stringify(decoded.bumperIds)}, ` +
        `${decoded.slingshots.length} slingshots, ${decoded.zones.length} zones`,
    );
    for (const device of decoded.devices) {
      console.log(
        `  ${pad}    L${device.level} id ${String(device.surfaceId).padStart(3)} ${device.kind.padEnd(6)} ` +
          `score ${device.score} bonus ${device.bonus} repeat ${device.repeatScore}` +
          (device.kind === "kicker" ? ` v=(${device.velocityX},${device.velocityY})` : ""),
      );
    }
    console.log(
      `  ${pad}    bumpers ${decoded.bumpers.map((b) => b.score).join("/")}  ` +
        `slingshots ${decoded.slingshots.map((s) => s.score).join("/")}`,
    );
  }

  if (failures > 0) {
    console.error(
      `${failures} table(s) ${check ? "differ or are missing" : "could not be exported"}`,
    );
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
