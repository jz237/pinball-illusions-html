#!/usr/bin/env node
// Decodes the MODE AND MISSION LAYER out of the table packages into the
// documents under public/generated/tables/*.modes.json. Run locally, where the
// operator's own disks live; the JSON it writes is what ships.
//
// ---------------------------------------------------------------------------
// THE EVENT RECORD IS A BYTECODE SCRIPT, NOT A DATA RECORD
// ---------------------------------------------------------------------------
// Everything reached by `jsr $6C10` — from award records at +$1A, from mode
// records at +$16, from trigger zone objects at +$06 and from lock zone objects
// at +$14 — is a PROGRAM. `$6C10` itself is seven instructions and is not an
// interpreter at all; it is a queue append:
//
//     006c10  movea.l $2396(a5),a1
//     006c16  move.w  $2392(a5),d2
//     006c1a  move.l  a0,(a1,d2.w*4)      ; the event record
//     006c1e  clr.l   $4(a1,d2.w)         ; NULL the next slot: self-terminating
//     006c22  addq.w  #1,$2392(a5)
//     006c26  andi.w  #$3f,$2392(a5)      ; a 64-slot ring
//     006c2c  rts
//
// so `$2392` is the write index, `$2394` the read index, and the ring is
// initialised at +0x00400E (`move.l #$245E,$2396(a5)`). Two other queues were
// previously conflated with it and are NOT this one: `$6C2C` feeds a second ring
// at `$23A2` with display/message objects, and `$6CD0` is the sound dispatcher
// (3-bit type in `(a0)`, jump table at $6CE4).
//
// EVENT RECORD, variable length:
//     +$00 u16  reserved, 0x0000 in every instance on all three tables
//     +$02 u16  PC, a byte offset into the code area, cleared on dequeue
//     +$04 ...  the opcode stream. Each instruction is a u16 opcode index
//               followed by its operands; opcode 0x0000 is END.
//
// DISPATCH, and the one correction that unlocked the whole thing:
//     0058fc  movem.w (0x5912,PC,d0.w*4),d0-d1   ; {u16 handler_off, u16 length}
//     005902  add.w   d1,$2(a0)                  ; advance PC by the length
//     005906  jsr     (0x5916,PC,d0.w)           ; handler = 0x5916 + offset
// The index is SCALED BY FOUR — the brief-extension word at 0x5900 is 0x0412 and
// its scale field is 0b10 — so the opcode words are small integers 1..31 rather
// than byte offsets. Capstone renders the base two bytes low and drops the
// scale. The mode interpreter's own copy of the same dispatch at 0x582C uses a
// full-format extension (0x0520, word base displacement 0x00E2 from an extension
// PC of 0x5830) and independently gives table base 0x5912 and handler base
// 0x5916. The table runs 0x5912..0x5991, and 0x5992 is the first handler, so
// there are exactly 31 opcodes.
//
// There are TWO interpreters over that one table: the background queue at
// 0x58BC, which runs one opcode per call from the ring, and the mission
// interpreter at 0x57AC/0x57B0, which runs the record in `$daa(a5)` and owns the
// wait/timeout machinery at 0x57AC-0x5868.
//
// ---------------------------------------------------------------------------
// THE STRUCTURES THIS EXPORTS
// ---------------------------------------------------------------------------
// PLAYFIELD ELEMENT — the operand of most opcodes. Only the fields this decode
// can prove are exported; the mutable ones (+$30..+$3F) are runtime state and
// live in the runtime, not in the file.
//     +$00 b  flags     bit1 suppress relight, bit2 on the active list,
//                       bit4 the mode-lamp bank
//     +$01 b  per-player ARMED bitmask        +$02 b per-player DONE bitmask
//     +$04 l  lamp (START path)               +$08 l lamp (AWARD path)
//     +$0C l  sound (START path)              +$10 l sound (AWARD path)
//     +$14 l  display (START path)            +$18 l display (AWARD path)
//     +$1E..$23  6-byte packed-BCD SCORE      +$26..$2B 6-byte packed-BCD BONUS
//     +$2C u16 award-effect index             +$2E s16 countdown, -1 = none
// The BCD offsets are not guessed. AWARD does `lea $2C(P),a3; jsr $6B96`, and
// $6B96 is `lea $10(a4),a0` then six ABCD backwards, `subq.w #2` on both, then
// six more: with a3 = P+$2C the bonus is P+$26..$2B and the score P+$1E..$23.
// Every element on every table passes the "each nibble is a decimal digit" test
// at those offsets, which is check 2 below.
//
// TRIGGER BINDING — what physically fires a script. This is the part the earlier
// work had not closed, and it is mechanical once the record types are known:
//     device type 0 (target)  -> award record at +$0C -> event record at +$1A
//     device type 1 (mode)    -> mode record  at +$22 -> event record at +$16
//     trigger zone (type 0/1) -> object              -> event record at +$06
//     lock zone (type 4)      -> object              -> event record at +$14
// On Law 'n Justice seventeen of the twenty-one elements the missions WAIT on
// are AWARDed by a script reachable this way — the jail lock's script at
// h4+0x3C20 alone awards nine of them — so the missions are shootable, which is
// the whole point of the exercise. Check 5 asserts it for every mission the
// player can select.
//
// MISSION SELECTOR — 12-byte records {u16 id, u16 pad, u32 launcher, u32 lamp},
// ids ascending from 1, terminated by id 0xFFFE (whose pad word holds the entry
// count) or 0xFFFF. A launcher is a short script containing `MODE_START`.
//
// ---------------------------------------------------------------------------
// WHAT THIS DECODE DOES NOT KNOW, STATED PLAINLY
// ---------------------------------------------------------------------------
// WHICH RECORD AN OPCODE'S POINTER POINTS AT is settled per opcode and only
// twelve of the twenty-four pointer-taking opcodes are settled as ELEMENTS:
// 1, 2, 3, 5, 8, 12, 14, 23, 24, 26 and 28. The rest — KICK_IF, LINK_RESTORE,
// SET_VALUE, RESET_GROUP, RESTORE_POS, CLEAR_BYTE, SET_MAX, SET_COUNT,
// SET_COUNT_SELF — take a record this decode has NOT identified, and calling
// them elements is not a small mistake: their targets fail the packed-BCD test
// outright, which is how they were caught. They are exported as opaque and the
// runtime treats them as no-ops. `SET_COUNT`'s target, for one, is clearly the
// progress-counter record rather than an element, because effect 21's handler
// reaches the same +$06/+$16 words through `a0 = P+$34`.
//
// THE LAST HOP OF A LADDER IS A DYNAMIC LINK. `PUSH` and `PUSH_LINKED` write
// `P1+$34 = P2` and push P1 on the stack at `$23DC`, and nothing that pops that
// stack has been decoded. So some mission shots are wired at run time and cannot
// be seen statically: four of Law 'n Justice's twenty-one WAIT elements, two of
// BabeWatch's twenty-three and four of Extreme Sports' twenty. Every mission the
// selector offers still has shootable waits; the two Extreme Sports STANDALONE
// modes do not, and are reported as a note rather than repaired.
//
// ---------------------------------------------------------------------------
// THE CHECKS
// ---------------------------------------------------------------------------
// 1. EVERY SCRIPT DECODES CLEANLY OR NOT AT ALL. A candidate either walks its
//    whole fall-through graph using opcodes 1..31 with every pointer operand
//    resolving, or it is rejected on the word that broke it.
// 2. EVERY ELEMENT'S SCORE AND BONUS IS PACKED BCD at +$1E and +$26. This is
//    also the test that decides what is an element at all; see `findScripts`.
// 3. NO TWO INSTRUCTIONS OVERLAP, and every branch either lands on an
//    instruction boundary or on a label outside the record — the shared timeout
//    labels several missions use. The second case is exported as -1 and counted.
// 4. EVERY POINTER OPERAND LANDS IN THE POOL ITS OPCODE REQUIRES — element
//    opcodes on elements, MODE_START on a script, MESSAGE on a display record.
// 5. EVERY SELECTABLE MISSION IS SHOOTABLE: its launcher contains MODE_START,
//    and at least one element it WAITs on is AWARDed by a script bound to a
//    device, a zone or a lock.
// 6. THE RELOCATION TABLES PARSE TO THE BYTE on every slot of every package.
//
// `MODES_DEBUG=1` prints every script the prune removes and the operand that
// removed it, which is how the operand-kind table above was settled.
//
// Usage:
//   node scripts/export-table-modes.mjs <segment-dir> [out-dir] [--check]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const PREAMBLE = 4;
const DEVICE_SLOTS = 160;
const DEVICE_ID_BASE = 32;
const ZONE_RECORD_BYTES = 14;
const BCD_BYTES = 6;
/** Entries in the award-effect dispatch table at main.seg00 0x5D0E. */
const MAX_AWARD_EFFECT = 63;

/** Descriptor offsets, as byte offsets into slot 0's body. */
const HEADER_LOWER_DEVICES = 0x10;
const HEADER_LOWER_ZONES = 0x14;
const HEADER_UPPER_DEVICES = 0x28;
const HEADER_UPPER_ZONES = 0x2c;

/** Element record field offsets. Each is quoted to its instruction above. */
const ELEMENT_FLAGS = 0x00;
const ELEMENT_LAMP_START = 0x04;
const ELEMENT_LAMP_AWARD = 0x08;
const ELEMENT_SOUND_START = 0x0c;
const ELEMENT_SOUND_AWARD = 0x10;
const ELEMENT_DISPLAY_START = 0x14;
const ELEMENT_DISPLAY_AWARD = 0x18;
const ELEMENT_SCORE = 0x1e;
const ELEMENT_BONUS = 0x26;
const ELEMENT_EFFECT = 0x2c;
const ELEMENT_COUNTDOWN = 0x2e;
/** Award effect 21's counter record, and the ladder step it queues on reaching its target. */
const ELEMENT_COUNTER = 0x34;
const COUNTER_TARGET = 0x04;
const COUNTER_CONTINUATION = 0x48;
/**
 * Award effect 6's LAUNCHER TABLE, inline at counter record +$50: the decoded
 * multiball-lock dispatch. Handler 0x5E5A takes `a0 = element+$34` (the same
 * counter record family effect 21 uses), increments the per-player counts at
 * +$06 and +$16, and 0x5EAA walks the 12-byte records at +$50 — the mission
 * selector's own `{u16 id, u16 mask, u32 launcher, u32 lamp}` format — comparing
 * the count against each ascending id (`move.w (a1),d1 / cmp.w d1,d0`); on
 * equality the entry's launcher is queued through $6C10. Walking past the 0xFFFE
 * terminator subtracts the word stored after it from the count and re-walks
 * (`move.w $2(a1),d2 / sub.w d2,$16(a0,d6.w)` at 0x5F26), so the table wraps.
 * This is the structure the earlier export could not find: no relocation points
 * at the table base, because it is only ever reached as counter+$50.
 */
const LADDER_TABLE = 0x50;
const LADDER_ENTRY_BYTES = 12;
/** Longest ladder accepted by the scan; the longest shipped is 14 entries. */
const LADDER_MAX_ENTRIES = 64;

/** Where a script hangs off each kind of physical record. */
const AWARD_EVENT = 0x1a;
const MODE_EVENT = 0x16;
const DEVICE_AWARD_POINTER = 0x0c;
const DEVICE_MODE_POINTER = 0x22;
const ZONE_TRIGGER_EVENT = 0x06;
const ZONE_LOCK_EVENT = 0x14;

/** Bytes scanned inside a display record for print records. See `messageText`. */
const MESSAGE_SPAN = 0x40;

/**
 * The 31 opcodes, by index: name, instruction length in bytes, and the operand
 * kinds. Lengths come from the dispatch table at 0x5912 and are checked against
 * every jump target in every script (check 3).
 *
 *   e  element record pointer      s  script (event record) pointer
 *   m  display/message pointer     o  opaque pointer (animation, native code)
 *   w  signed word                 c  a PC inside this script
 *   i  32-bit immediate, packed BCD in the high digits
 */
const OPCODES = [
  { index: 0, name: "END", length: 2, args: "" },
  { index: 1, name: "START", length: 6, args: "e" },
  { index: 2, name: "START_TIMED", length: 8, args: "ew" },
  { index: 3, name: "COMPLETE", length: 6, args: "e" },
  { index: 4, name: "KICK_IF", length: 8, args: "ow" },
  { index: 5, name: "AWARD", length: 6, args: "e" },
  { index: 6, name: "LINK_RESTORE", length: 6, args: "o" },
  { index: 7, name: "SET_VALUE", length: 14, args: "oii" },
  { index: 8, name: "PUSH", length: 6, args: "e" },
  { index: 9, name: "MODE_START", length: 6, args: "s" },
  { index: 10, name: "JMP", length: 4, args: "c" },
  { index: 11, name: "SET_INTRO", length: 4, args: "w" },
  { index: 12, name: "CLEAR_DONE", length: 6, args: "e" },
  { index: 13, name: "RESET_GROUP", length: 6, args: "o" },
  { index: 14, name: "LAMP_OFF", length: 6, args: "e" },
  { index: 15, name: "RESTORE_POS", length: 6, args: "o" },
  { index: 16, name: "CLEAR_BYTE", length: 6, args: "o" },
  { index: 17, name: "MESSAGE", length: 6, args: "m" },
  { index: 18, name: "SET_MAX", length: 14, args: "oii" },
  { index: 19, name: "ANIMATE", length: 6, args: "o" },
  { index: 20, name: "NATIVE", length: 6, args: "o" },
  // SET_COUNT's pointer is a progress-counter record. Where that record hosts a
  // decoded effect-6 launcher table the operand is exported as the LADDER index
  // (kind "l"); handler 0x5C64 writes the word to both per-player counts:
  // `move.w $6(a1),$6(a2,d6.w) / move.w $6(a1),$16(a2,d6.w)`.
  { index: 21, name: "SET_COUNT", length: 8, args: "lw" },
  { index: 22, name: "SET_COUNT_SELF", length: 6, args: "o" },
  { index: 23, name: "JMP_IF_UNLIT", length: 8, args: "ec" },
  { index: 24, name: "PUSH_LINKED", length: 10, args: "ee" },
  { index: 25, name: "IF_TWO_PLAYER", length: 2, args: "" },
  { index: 26, name: "BALL_REMOVE", length: 6, args: "e" },
  { index: 27, name: "BALLS_UP_TO", length: 4, args: "w" },
  { index: 28, name: "WAIT", length: 10, args: "ewc" },
  { index: 29, name: "DBNZ", length: 4, args: "c" },
  { index: 30, name: "SET_RESUME", length: 4, args: "c" },
  { index: 31, name: "SET_LOOP", length: 4, args: "w" },
];
const OPCODE_BY_INDEX = new Map(OPCODES.map((op) => [op.index, op]));

const TABLES = [
  { stem: "Table001", tableId: "law-n-justice", displayName: "Law 'n Justice" },
  { stem: "Table002", tableId: "babewatch", displayName: "BabeWatch" },
  { stem: "Table003", tableId: "extreme-sports", displayName: "Extreme Sports" },
];

/**
 * Device slots whose record word 0 is not 0, 1 or 2 and which are therefore
 * linker residue rather than a device. The same slot the device exporter drops.
 */
const RESIDUE_DEVICE_SLOTS = { "extreme-sports": [96] };

const PROVENANCE = {
  sourceClass: "disk-derived-mode-scripts",
  description:
    "Mission and mode bytecode, playfield element records, display text and the " +
    "device/zone bindings that fire them, decoded from the operator's own AGA " +
    "floppy set. Functional rules data only: no artwork, audio or executable code.",
  authorizationRequired: true,
};

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

function loadPackage(segDir, stem) {
  const bodies = [];
  const relocations = new Map();
  const seg2 = join(dirname(resolve(segDir)), "seg2");

  for (let slot = 0; ; slot += 1) {
    const pad = String(slot).padStart(2, "0");
    const candidates = [
      join(seg2, `${stem}.s${pad}.bin`),
      join(segDir, `${stem}.s${pad}.bin`),
      join(segDir, `${stem}.seg${pad}.bin`),
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

    // CHECK 6 — the relocation blocks must consume the tail exactly.
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
    if (raw.length - at > 3) {
      throw new Error(
        `${path}: relocation blocks end at byte ${at} of ${raw.length}; they must consume the file`,
      );
    }
  }

  if (bodies.length === 0) throw new Error(`no package slots found for ${stem} under ${segDir}`);
  return { stem, bodies, relocations };
}

function bodyOf(pkg, hunk) {
  const body = pkg.bodies[hunk];
  if (body === undefined) throw new Error(`${pkg.stem}: hunk ${hunk} is not in this package`);
  return body;
}

const key = (at) => `${at.hunk}:${at.offset}`;

function inBounds(pkg, at, span) {
  const body = pkg.bodies[at.hunk];
  return body !== undefined && at.offset >= 0 && at.offset + span <= body.length;
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

/** Follows the relocated longword at `at + delta`, or null when it is not one. */
function follow(pkg, at, delta = 0) {
  if (!inBounds(pkg, at, delta + 4)) return null;
  const target = pkg.relocations.get(`${at.hunk}:${at.offset + delta}`);
  if (target === undefined) return null;
  const offset = readU32(pkg, at, delta);
  const body = pkg.bodies[target];
  if (body === undefined || offset >= body.length) return null;
  return { hunk: target, offset };
}

/** CHECK 2 — a six-byte packed-BCD field as a decimal number. */
function readBcd(pkg, at, delta, what) {
  const body = bodyOf(pkg, at.hunk);
  let value = 0;
  for (let i = 0; i < BCD_BYTES; i += 1) {
    const byte = body.readUInt8(at.offset + delta + i);
    if (byte >> 4 > 9 || (byte & 0x0f) > 9) {
      throw new Error(
        `${pkg.stem}: ${what} at hunk ${at.hunk}+${at.offset + delta} holds byte 0x` +
          `${byte.toString(16).padStart(2, "0")}, which is not two decimal digits; the field is ` +
          `not where this decode thinks it is`,
      );
    }
    value = value * 100 + (byte >> 4) * 10 + (byte & 0x0f);
  }
  return value;
}

/** Every distinct target of a relocated longword, sorted so runs are stable. */
function relocationTargets(pkg) {
  const seen = new Map();
  for (const [where, target] of pkg.relocations) {
    const [hunk, offset] = where.split(":").map(Number);
    const body = pkg.bodies[target];
    if (body === undefined) continue;
    const value = bodyOf(pkg, hunk).readUInt32BE(offset);
    if (value >= body.length) continue;
    seen.set(`${target}:${value}`, { hunk: target, offset: value });
  }
  return [...seen.values()].sort((a, b) => a.hunk - b.hunk || a.offset - b.offset);
}

// ---------------------------------------------------------------------------
// The bytecode
// ---------------------------------------------------------------------------

/**
 * CHECK 1 — decodes an event record, or answers null.
 *
 * The reserved word at +$00 must be zero, every instruction must be one this
 * table knows, and every pointer operand must resolve through the relocation
 * table. A candidate that fails any of those fails on the word that broke it and
 * produces nothing; there is no partial decode.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A GRAPH WALK AND NOT A LINEAR SCAN
 * ---------------------------------------------------------------------------
 * A script may contain an END in the middle of itself and be branched over it.
 * BabeWatch's `top-lane` lock script (h4+0x3A22) is the clean example: it ends
 * at +$3C, and its `JMP_IF_UNLIT` at +$0C jumps to +$3E, which is four more
 * instructions and a second END. Decoding until the first END loses that tail
 * and then reports the branch as landing off the end of the script — which is
 * exactly what a wrong instruction-length table would look like, so a linear
 * decoder cannot tell the two apart. Following the branches instead makes CHECK
 * 3 meaningful: every decoded instruction must be disjoint from every other, so
 * a length that is one word wrong shows up as two instructions overlapping.
 */
function decodeScript(pkg, at) {
  if (!inBounds(pkg, at, 6)) return null;
  if (readU16(pkg, at, 0) !== 0) return null;

  const decoded = new Map();
  // Only the FALL-THROUGH path may reject the record. A branch target that does
  // not decode is recorded as dangling and the script survives: several missions
  // share one timeout label that sits outside the record's own code — Law 'n
  // Justice's six terrorist waits all branch to +$C8 — and refusing the whole
  // mission because one label leaves the record would throw away eight working
  // missions to protect a check the overlap test already makes.
  const dangling = [];
  const fallThrough = [0];
  const branches = [];

  const step = (pc, viaBranch) => {
    if (decoded.has(pc)) return true;
    if (pc < 0 || pc % 2 !== 0) return false;
    if (decoded.size > 512) return false;
    if (!inBounds(pkg, at, 4 + pc + 2)) return false;

    const index = readU16(pkg, at, 4 + pc);
    if (index === 0) {
      decoded.set(pc, { pc, index: 0, name: "END", args: [], length: 2 });
      return true;
    }
    const op = OPCODE_BY_INDEX.get(index);
    if (op === undefined) return false;
    if (!inBounds(pkg, at, 4 + pc + op.length)) return false;

    const args = [];
    let delta = 2;
    for (const kind of op.args) {
      if (kind === "i") {
        args.push({ kind, value: readU32(pkg, at, 4 + pc + delta) });
        delta += 4;
      } else if (kind === "w") {
        args.push({ kind, value: readS16(pkg, at, 4 + pc + delta) });
        delta += 2;
      } else if (kind === "c") {
        const value = readS16(pkg, at, 4 + pc + delta);
        if (value < 0 || value % 2 !== 0) return false;
        args.push({ kind, value });
        branches.push(value);
        delta += 2;
      } else {
        const raw = readU32(pkg, at, 4 + pc + delta);
        const target = follow(pkg, at, 4 + pc + delta);
        if (raw !== 0 && target === null) return false;
        args.push({ kind, target });
        delta += 4;
      }
    }
    decoded.set(pc, { pc, index, name: op.name, args, length: op.length });
    if (viaBranch || index !== 0) fallThrough.push(pc + op.length);
    return true;
  };

  while (fallThrough.length > 0 || branches.length > 0) {
    if (fallThrough.length > 0) {
      const pc = fallThrough.pop();
      if (!step(pc, false)) return null;
      continue;
    }
    const pc = branches.pop();
    if (!step(pc, true)) dangling.push(pc);
  }

  const ops = [...decoded.values()].sort((a, b) => a.pc - b.pc);
  if (ops.length === 0) return null;
  // CHECK 3 — no two instructions may overlap. This is what makes the branch
  // targets evidence for the length table rather than merely consistent with it.
  for (let i = 1; i < ops.length; i += 1) {
    if (ops[i - 1].pc + ops[i - 1].length > ops[i].pc) return null;
  }
  return {
    at,
    ops,
    dangling: [...new Set(dangling)].sort((a, b) => a - b),
    endPc: ops[ops.length - 1].pc + ops[ops.length - 1].length,
  };
}

/**
 * Decodes the effect-6 launcher table inline at a counter record's +$50, or
 * answers null.
 *
 * This is the MULTIBALL LOCK DISPATCH — the structure that runs the Nth
 * launcher on the Nth lock — and the parse is strict the way `decodeScript` is:
 * ids must ascend from at least 1, every launcher longword must be a genuine
 * relocation entry resolving to a script that survived the prune, and the run
 * must end on 0xFFFE (whose following word is the WRAP subtracted from the
 * count when the walk runs off the end — decoded at 0x5F26, not inferred) or on
 * 0xFFFF (no wrap: the handler's `bmi` ends the walk and only 0xFFFE re-enters
 * it). A record that fails any of that yields nothing rather than a partial
 * table.
 *
 * On the shipped tables this recovers BabeWatch's h4+0x49F8 (ids 1..10, wrap
 * 10: lock tiers of 1/2/3/4 captures launching scripts 110/114/117/119, the
 * four multiball modes, with the "n MORE TO START MODE" alternates at the
 * intermediate ids) and Law 'n Justice's h4+0x40F4 (ids 1..14, wrap 5: tiers of
 * 2/3/4/5 jail locks, multiball at ids 2/5/9/14), plus the smaller count-driven
 * ladders each table uses for its own features.
 */
function ladderOf(pkg, record, scriptIndex) {
  const entries = [];
  let delta = LADDER_TABLE;
  let previousId = 0;
  for (;;) {
    if (!inBounds(pkg, record, delta + 4)) return null;
    const id = readU16(pkg, record, delta);
    if (id === 0xfffe || id === 0xffff) {
      if (entries.length === 0) return null;
      return {
        wrap: id === 0xfffe ? readU16(pkg, record, delta + 2) : 0,
        entries,
      };
    }
    if (id <= previousId || entries.length >= LADDER_MAX_ENTRIES) return null;
    previousId = id;
    const launcher = follow(pkg, record, delta + 4);
    const script = launcher === null ? undefined : scriptIndex.get(key(launcher));
    if (script === undefined) return null;
    entries.push({ id, script });
    delta += LADDER_ENTRY_BYTES;
  }
}

/** The progress-counter continuation an element's award effect 21 queues. */
function counterScriptOf(pkg, element) {
  const record = follow(pkg, element, ELEMENT_COUNTER);
  if (record === null) return null;
  return follow(pkg, record, COUNTER_CONTINUATION);
}

/**
 * True when a record can be a playfield element at all.
 *
 * Not a decode, a REFUTATION: both packed-BCD fields must be packed BCD, the
 * award-effect index must be inside the dispatch table at 0x5D0E, and the
 * countdown must be -1 (no timer) or a plausible frame count. This is the test
 * that tells a real element from a longword that a false-positive script
 * happened to hand to `AWARD`, and it is the pivot the pruning below turns on.
 */
function elementLooksReal(pkg, at) {
  if (!inBounds(pkg, at, ELEMENT_COUNTDOWN + 2)) return false;
  const body = bodyOf(pkg, at.hunk);
  for (const field of [ELEMENT_SCORE, ELEMENT_BONUS]) {
    for (let i = 0; i < BCD_BYTES; i += 1) {
      const byte = body.readUInt8(at.offset + field + i);
      if (byte >> 4 > 9 || (byte & 0x0f) > 9) return false;
    }
  }
  return readU16(pkg, at, ELEMENT_EFFECT) <= MAX_AWARD_EFFECT;
}

/**
 * Discovers the event records.
 *
 * Discovery is broad — every distinct relocation target is tried, then closed
 * over `MODE_START` and over the progress-counter continuation at element
 * +$34 -> +$48 — because the scripts are reached by too many routes for any
 * single seed set to be complete. Some hang off award records, some off zone
 * objects, some off a mission's own counter record, some are only ever branched
 * to from inside another script, and BabeWatch's second selector table mixes
 * mission launchers with plain award scripts.
 *
 * A broad scan does pick up false positives, and they matter: a 26- or 38-byte
 * record whose first word happens to be zero and whose following words happen to
 * be small integers decodes as a short script often enough, because the opcode
 * set covers 1..31. So the scan is followed by a PRUNE, and the prune turns on
 * the one thing a false positive cannot fake — the records it claims are
 * elements are not elements:
 *
 *   - a script with an operand that cannot be an element is not a script;
 *   - an address a surviving script uses as an element is not a script either.
 *
 * Both rules only ever remove, so the fixpoint is reached and is unique. What
 * survives on the three tables is 94 / 109 / 77 scripts, every element of which
 * passes the packed-BCD check that `readBcd` then applies for real.
 */
function findScripts(pkg) {
  const scripts = new Map();
  const admit = (at, frontier) => {
    if (at === null || scripts.has(key(at))) return;
    const script = decodeScript(pkg, at);
    if (script === null) return;
    scripts.set(key(at), script);
    if (frontier !== undefined) frontier.push(script);
  };

  for (const at of relocationTargets(pkg)) admit(at);
  const frontier = [...scripts.values()];
  while (frontier.length > 0) {
    const script = frontier.pop();
    for (const op of script.ops) {
      for (const arg of op.args) {
        if (arg.target === null) continue;
        if (arg.kind === "s") admit(arg.target, frontier);
        if (arg.kind === "e") admit(counterScriptOf(pkg, arg.target), frontier);
      }
    }
  }

  for (;;) {
    let removed = 0;
    for (const [k, script] of [...scripts]) {
      const bad = script.ops.some((op) =>
        op.args.some(
          (arg) =>
            arg.target !== null &&
            ((arg.kind === "e" && !elementLooksReal(pkg, arg.target)) ||
              (arg.kind === "s" && !scripts.has(key(arg.target)))),
        ),
      );
      if (bad && scripts.delete(k)) {
        removed += 1;
        if (process.env.MODES_DEBUG) {
          const why = script.ops
            .flatMap((op) =>
              op.args
                .filter((arg) => arg.target !== null && ((arg.kind === "e" && !elementLooksReal(pkg, arg.target)) || (arg.kind === "s" && !scripts.has(key(arg.target)))))
                .map((arg) => `${op.name}@${op.pc} ${arg.kind}=${key(arg.target)}`),
            );
          console.error(`  prune operand ${k}: ${why.join(", ")}`);
        }
      }
    }
    const elements = new Set();
    for (const script of scripts.values()) {
      for (const op of script.ops) {
        for (const arg of op.args) {
          if (arg.kind === "e" && arg.target !== null) elements.add(key(arg.target));
        }
      }
    }
    for (const k of elements) {
      if (scripts.delete(k)) {
        removed += 1;
        if (process.env.MODES_DEBUG) console.error(`  prune as-element ${k}`);
      }
    }
    if (removed === 0) return scripts;
  }
}

// ---------------------------------------------------------------------------
// Display records
// ---------------------------------------------------------------------------

/**
 * One print record: `{u16 x, u16 row, u16 font, u16 align, ASCIIZ}`.
 *
 * The bounds on the four header words are what stops a random longword being
 * read as text: a display line is somewhere on a 336-pixel screen in one of a
 * handful of fonts, and the string that follows is printable ASCII.
 */
function printRecord(pkg, at) {
  if (!inBounds(pkg, at, 10)) return null;
  const x = readU16(pkg, at, 0);
  const row = readU16(pkg, at, 2);
  const font = readU16(pkg, at, 4);
  const align = readU16(pkg, at, 6);
  if (x > 400 || row > 200 || font > 32 || align > 8) return null;

  const body = bodyOf(pkg, at.hunk);
  let text = "";
  for (let i = at.offset + 8; i < body.length && text.length < 64; i += 1) {
    const byte = body.readUInt8(i);
    if (byte === 0) break;
    if (byte < 32 || byte > 126) return null;
    text += String.fromCharCode(byte);
  }
  return text.length >= 2 ? text : null;
}

/**
 * RECONSTRUCTION — the lines a display record shows, in record order.
 *
 * The display VM behind `$6C2C` is not decoded, so this does not run it: it
 * walks the longwords of the record over a fixed span and keeps the ones that
 * point at a well-formed print record. The OFFSETS are exact and the strings are
 * verbatim; what is reconstructed is the claim that these lines belong to this
 * record and appear in this order. The step is two bytes rather than four
 * because the records are not longword aligned — Law 'n Justice's mission titles
 * live at +$1E and +$24 of a record whose own address is 2 mod 4, and a
 * four-byte walk finds the second line and misses the first.
 */
function messageText(pkg, at) {
  const lines = [];
  const seen = new Set();
  for (let delta = 0; delta < MESSAGE_SPAN; delta += 2) {
    const target = follow(pkg, at, delta);
    if (target === null) continue;
    const text = printRecord(pkg, target);
    if (text === null || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The physical bindings
// ---------------------------------------------------------------------------

function descriptorPointer(pkg, delta) {
  return follow(pkg, { hunk: 0, offset: 0 }, delta);
}

function deviceBindings(pkg, residue) {
  const out = [];
  for (const level of [0, 1]) {
    const base = descriptorPointer(pkg, level === 1 ? HEADER_UPPER_DEVICES : HEADER_LOWER_DEVICES);
    if (base === null) continue;
    for (let index = 0; index < DEVICE_SLOTS; index += 1) {
      const record = follow(pkg, base, 4 * index);
      if (record === null) continue;
      if (residue.has(index)) continue;
      const type = readU16(pkg, record, 0);
      let event = null;
      if (type === 0) {
        const award = follow(pkg, record, DEVICE_AWARD_POINTER);
        event = award === null ? null : follow(pkg, award, AWARD_EVENT);
      } else if (type === 1) {
        const mode = follow(pkg, record, DEVICE_MODE_POINTER);
        event = mode === null ? null : follow(pkg, mode, MODE_EVENT);
      }
      if (event !== null) {
        out.push({ level, surfaceId: index + DEVICE_ID_BASE, event });
      }
    }
  }
  return out;
}

function zoneBindings(pkg) {
  const triggers = [];
  const locks = [];
  for (const level of [0, 1]) {
    const base = descriptorPointer(pkg, level === 1 ? HEADER_UPPER_ZONES : HEADER_LOWER_ZONES);
    if (base === null) continue;
    for (let index = 0; ; index += 1) {
      const at = { hunk: base.hunk, offset: base.offset + ZONE_RECORD_BYTES * index };
      if (!inBounds(pkg, at, ZONE_RECORD_BYTES)) break;
      if (readS16(pkg, at, 0) < 0) break;
      if (index > 200) throw new Error(`${pkg.stem}: zone list on level ${level} is not terminated`);
      const type = readU16(pkg, at, 8);
      const object = follow(pkg, at, 10);
      if (object === null) continue;
      if (type === 0 || type === 1) {
        const event = follow(pkg, object, ZONE_TRIGGER_EVENT);
        if (event !== null) triggers.push({ level, index, event });
      } else if (type === 4) {
        const event = follow(pkg, object, ZONE_LOCK_EVENT);
        // The OBJECT is kept alongside the event: it is the lock DEVICE record,
        // and the scripts hand that same record to PUSH / PUSH_LINKED /
        // BALL_REMOVE (the element pool files it as an "element", a
        // misclassification the runtime needs to see through — PUSH's handler
        // 0x5BFC pushes the device onto the popper stack at $23DC(a5) and the
        // popper 0x7078 physically ejects the ball the device is holding).
        if (event !== null) locks.push({ level, index, event, object });
      }
    }
  }
  return { triggers, locks };
}

/**
 * The mission selector tables: 12-byte records with ids ascending from 1.
 *
 * Found by scanning rather than by a pointer, because nothing in the image
 * points at them — the earlier investigation could not find a referrer either
 * and the reader is presumably in the per-table native code in slot 6. Scanning
 * is safe here because the shape is heavily constrained: the ids must be
 * 1, 2, 3, ... with no gap, every +$04 must be a script containing MODE_START,
 * and the run must end on 0xFFFE or 0xFFFF.
 */
function scanSelectorTables(pkg) {
  const launcherCache = new Map();
  const launcherMission = (at) => {
    const k = key(at);
    if (launcherCache.has(k)) return launcherCache.get(k);
    const script = decodeScript(pkg, at);
    let mission = null;
    if (script !== null) {
      const start = script.ops.find((op) => op.index === 9 && op.args[0].target !== null);
      if (start !== undefined && decodeScript(pkg, start.args[0].target) !== null) {
        mission = start.args[0].target;
      }
    }
    launcherCache.set(k, mission);
    return mission;
  };

  const found = [];
  for (let hunk = 0; hunk < pkg.bodies.length; hunk += 1) {
    const body = pkg.bodies[hunk];
    for (let offset = 0; offset + 12 <= body.length; offset += 2) {
      if (body.readUInt16BE(offset) !== 1) continue;
      const entries = [];
      let at = offset;
      let want = 1;
      let ok = true;
      for (;;) {
        if (at + 12 > body.length) {
          ok = false;
          break;
        }
        const id = body.readUInt16BE(at);
        if (id === 0xfffe || id === 0xffff) break;
        if (id !== want) {
          ok = false;
          break;
        }
        const launcher = follow(pkg, { hunk, offset: at }, 4);
        const mission = launcher === null ? null : launcherMission(launcher);
        if (mission === null) {
          ok = false;
          break;
        }
        entries.push({
          id,
          launcher,
          mission,
          lamp: follow(pkg, { hunk, offset: at }, 8) !== null,
        });
        at += 12;
        want += 1;
      }
      if (!ok || entries.length < 3) continue;
      found.push({
        hunk,
        offset,
        entries,
        terminator: body.readUInt16BE(at),
        declaredCount: body.readUInt16BE(at + 2),
      });
    }
  }
  // Overlapping candidates cannot both be a table; keep the earliest and skip
  // anything starting inside it, so the result does not depend on scan order.
  found.sort((a, b) => a.hunk - b.hunk || a.offset - b.offset);
  const kept = [];
  for (const table of found) {
    const clash = kept.find(
      (other) =>
        other.hunk === table.hunk &&
        table.offset < other.offset + other.entries.length * 12 + 4 &&
        table.offset >= other.offset,
    );
    if (clash === undefined) kept.push(table);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Assembling one table
// ---------------------------------------------------------------------------

function decode(pkg, table) {
  const residue = new Set(RESIDUE_DEVICE_SLOTS[table.tableId] ?? []);
  const scripts = findScripts(pkg);

  // Pools. Elements and display records are whatever the opcodes point at, and
  // an address may not be two different things — check 4 is what proves the
  // opcode table's operand kinds are right.
  const elementKeys = new Set();
  const messageKeys = new Set();
  for (const script of scripts.values()) {
    for (const op of script.ops) {
      for (const arg of op.args) {
        if (arg.target === null) continue;
        if (arg.kind === "e") elementKeys.add(key(arg.target));
        if (arg.kind === "m") messageKeys.add(key(arg.target));
      }
    }
  }
  for (const k of elementKeys) {
    if (messageKeys.has(k)) {
      throw new Error(
        `${pkg.stem}: ${k} is used both as an element and as a display record; the operand kinds ` +
          `in the opcode table cannot both be right`,
      );
    }
    if (scripts.has(k)) {
      throw new Error(`${pkg.stem}: ${k} is used both as an element and as an event record`);
    }
  }

  const byKey = (set) =>
    [...set]
      .map((k) => {
        const [hunk, offset] = k.split(":").map(Number);
        return { hunk, offset };
      })
      .sort((a, b) => a.hunk - b.hunk || a.offset - b.offset);

  const elementList = byKey(elementKeys);
  const messageList = byKey(messageKeys);
  const scriptList = [...scripts.values()].sort(
    (a, b) => a.at.hunk - b.at.hunk || a.at.offset - b.at.offset,
  );

  const elementIndex = new Map(elementList.map((at, i) => [key(at), i]));
  const messageIndex = new Map(messageList.map((at, i) => [key(at), i]));
  const scriptIndex = new Map(scriptList.map((script, i) => [key(script.at), i]));

  // The LOCK LADDERS: award effect 6 (handler 0x5E5A). Every element whose
  // award effect is 6 carries a counter record at +$34, and the launcher table
  // inline at that record's +$50 is the decoded count dispatch — see
  // `ladderOf`. Elements sharing one record share one ladder (BabeWatch's three
  // lock-lit lamps 29/30/31 all point at h4+0x49A8), so the ladders are pooled
  // by record and each element carries an index into the pool.
  const EFFECT_COUNT_DISPATCH = 6;
  const ladders = [];
  const ladderIndexByKey = new Map();
  const ladderIndexOf = (record) => {
    if (record === null) return -1;
    const k = key(record);
    const cached = ladderIndexByKey.get(k);
    if (cached !== undefined) return cached;
    const ladder = ladderOf(pkg, record, scriptIndex);
    const index = ladder === null ? -1 : ladders.length;
    ladderIndexByKey.set(k, index);
    if (ladder !== null) ladders.push({ index, wrap: ladder.wrap, entries: ladder.entries });
    return index;
  };
  const elementLadder = elementList.map((at) =>
    readU16(pkg, at, ELEMENT_EFFECT) === EFFECT_COUNT_DISPATCH
      ? ladderIndexOf(follow(pkg, at, ELEMENT_COUNTER))
      : -1,
  );

  // The progress counter. AWARD effect 21 (handler 0x5FA8) takes `a0 = P+$34`,
  // increments the per-player counters there and, when the target at `a0+$04` is
  // reached, queues the script at `a0+$48` through $6C10. That is how a mission
  // ladder advances itself, and it is the route by which Law 'n Justice's
  // h4+0x66FC and h4+0x6CA4 — the only awarders of two of its WAIT elements —
  // are reached at all.
  const counters = elementList.map((at) => {
    const record = follow(pkg, at, ELEMENT_COUNTER);
    const continuation = counterScriptOf(pkg, at);
    const found = continuation === null ? undefined : scriptIndex.get(key(continuation));
    if (record === null || found === undefined) return { script: -1, target: 0 };
    return { script: found, target: readU16(pkg, record, COUNTER_TARGET) };
  });

  const elements = elementList.map((at, index) => ({
    index,
    flags: readU8(pkg, at, ELEMENT_FLAGS),
    score: readBcd(pkg, at, ELEMENT_SCORE, "element score"),
    bonus: readBcd(pkg, at, ELEMENT_BONUS, "element bonus"),
    effect: readU16(pkg, at, ELEMENT_EFFECT),
    countdown: readS16(pkg, at, ELEMENT_COUNTDOWN),
    lampStart: follow(pkg, at, ELEMENT_LAMP_START) !== null,
    lampAward: follow(pkg, at, ELEMENT_LAMP_AWARD) !== null,
    soundStart: follow(pkg, at, ELEMENT_SOUND_START) !== null,
    soundAward: follow(pkg, at, ELEMENT_SOUND_AWARD) !== null,
    displayStart: messageIndex.get(keyOrNull(follow(pkg, at, ELEMENT_DISPLAY_START))) ?? -1,
    displayAward: messageIndex.get(keyOrNull(follow(pkg, at, ELEMENT_DISPLAY_AWARD))) ?? -1,
    counterScript: counters[index].script,
    counterTarget: counters[index].target,
    ladder: elementLadder[index],
  }));

  const messages = messageList.map((at, index) => ({ index, lines: messageText(pkg, at) }));

  let dangled = 0;
  const scriptDocs = scriptList.map((script, index) => {
    const boundaries = new Set(script.ops.map((op) => op.pc));
    boundaries.add(script.endPc);
    const ops = script.ops.map((op) => {
      const args = op.args.map((arg) => {
        if (arg.kind === "i" || arg.kind === "w") return arg.value;
        if (arg.kind === "c") {
          // CHECK 3 — a branch must land on an instruction boundary, or on a
          // label this record does not contain. The second case is -1, which the
          // runtime treats as "the script is over"; see `dangling` above.
          if (!boundaries.has(arg.value)) {
            if (!script.dangling.includes(arg.value)) {
              throw new Error(
                `${pkg.stem}: script ${index} (${key(script.at)}) op ${op.name} at +0x` +
                  `${op.pc.toString(16)} branches to +0x${arg.value.toString(16)}, which is not an ` +
                  `instruction boundary; the opcode length table is wrong`,
              );
            }
            dangled += 1;
            return -1;
          }
          return arg.value;
        }
        if (arg.target === null) return -1;
        // A SET_COUNT whose record hosts a decoded ladder names the ladder;
        // one whose record does not is exported unresolved, exactly as the
        // other opaque pointers are.
        if (arg.kind === "l") return ladderIndexOf(arg.target);
        // CHECK 4 — the operand must be in the pool its opcode requires.
        const pool =
          arg.kind === "e" ? elementIndex : arg.kind === "m" ? messageIndex : arg.kind === "s" ? scriptIndex : null;
        if (pool === null) return -1; // opaque: animation and native records
        const resolved = pool.get(key(arg.target));
        if (resolved === undefined) {
          throw new Error(
            `${pkg.stem}: script ${index} op ${op.name} operand ${key(arg.target)} is not in the ` +
              `${arg.kind} pool`,
          );
        }
        return resolved;
      });
      return { pc: op.pc, op: op.index, args };
    });
    return { index, ops, endPc: script.endPc };
  });

  const bindScript = (event) => {
    const at = scriptIndex.get(key(event));
    return at === undefined ? -1 : at;
  };

  const devices = deviceBindings(pkg, residue)
    .map((entry) => ({ level: entry.level, surfaceId: entry.surfaceId, script: bindScript(entry.event) }))
    .filter((entry) => entry.script >= 0);
  const zoneBind = zoneBindings(pkg);
  const zones = zoneBind.triggers
    .map((entry) => ({ level: entry.level, index: entry.index, script: bindScript(entry.event) }))
    .filter((entry) => entry.script >= 0);
  const locks = zoneBind.locks
    .map((entry) => ({
      level: entry.level,
      index: entry.index,
      script: bindScript(entry.event),
      // The lock DEVICE record's slot in the element pool, or -1. This is the
      // join the runtime needs to honour PUSH / PUSH_LINKED / BALL_REMOVE on a
      // lock: those opcodes name the device record, the pool filed it as an
      // element, and matching the addresses here is what turns "push element
      // 24" back into "eject the ball the jail is holding".
      element: elementIndex.get(key(entry.object)) ?? -1,
    }))
    .filter((entry) => entry.script >= 0);

  // Missions. The selector tables first, then every other MODE_START target, so
  // a mode the selector does not list — the wizard multiballs, Bumper Mania — is
  // still in the file and still labelled for what it is.
  const selectors = scanSelectorTables(pkg);
  const missions = [];
  const claimed = new Set();
  for (const [selector, entry] of selectors.entries()) {
    for (const record of entry.entries) {
      const script = bindScript(record.mission);
      if (script < 0) continue;
      claimed.add(script);
      missions.push({
        id: record.id,
        selector,
        selected: true,
        script,
        launcher: bindScript(record.launcher),
        lamp: record.lamp,
        title: missionTitle(scriptDocs[script], messages),
      });
    }
  }
  for (const script of scriptList) {
    for (const op of script.ops) {
      if (op.index !== 9 || op.args[0].target === null) continue;
      const target = bindScript(op.args[0].target);
      if (target < 0 || claimed.has(target)) continue;
      claimed.add(target);
      missions.push({
        id: 0,
        selector: -1,
        selected: false,
        script: target,
        launcher: scriptIndex.get(key(script.at)) ?? -1,
        lamp: false,
        title: missionTitle(scriptDocs[target], messages),
      });
    }
  }
  missions.sort((a, b) => a.selector - b.selector || a.id - b.id || a.script - b.script);

  // CHECK 5 — every selector mission must be launched by a MODE_START, and every
  // element a mission waits on must be awarded from something a ball can hit.
  const shootable = new Set();
  for (const binding of [...devices, ...zones, ...locks]) {
    collectAwards(scriptDocs, elements, binding.script, shootable, new Set());
  }
  const waited = new Set();
  const blind = [];
  for (const mission of missions) {
    const waits = new Set();
    for (const op of scriptDocs[mission.script].ops) {
      if (op.op === 28 && op.args[0] >= 0) waits.add(op.args[0]);
    }
    for (const element of waits) waited.add(element);
    if (waits.size > 0 && ![...waits].some((element) => shootable.has(element))) {
      blind.push({ script: mission.script, selected: mission.selected });
    }
  }
  const unreachable = [...waited].filter((element) => !shootable.has(element)).sort((a, b) => a - b);

  return {
    elements,
    messages,
    scripts: scriptDocs,
    missions,
    ladders,
    triggers: { devices, zones, locks },
    selectors: selectors.map((entry, index) => ({
      index,
      entries: entry.entries.length,
      declaredCount: entry.terminator === 0xfffe ? entry.declaredCount : entry.entries.length,
    })),
    stats: {
      dangled,
      waited: waited.size,
      shootable: shootable.size,
      unreachable,
      blind,
    },
  };
}

function keyOrNull(at) {
  return at === null ? "" : key(at);
}

/**
 * Elements AWARDed by a script, by anything it starts, and by the progress
 * counters those awards drive.
 *
 * The counter edge matters: a mission's later shots are often awarded by a
 * continuation script the ladder queues rather than by the shot itself, so
 * without following `element -> counter script` the reachability check reports
 * false alarms on missions that in fact work.
 */
function collectAwards(scripts, elements, index, into, seen) {
  if (index < 0 || seen.has(index)) return;
  seen.add(index);
  for (const op of scripts[index].ops) {
    if (op.op === 5 && op.args[0] >= 0) {
      into.add(op.args[0]);
      collectAwards(scripts, elements, elements[op.args[0]].counterScript, into, seen);
    }
    if (op.op === 9 && op.args[0] >= 0) collectAwards(scripts, elements, op.args[0], into, seen);
  }
}

/** The first display record a mission shows, which is its title banner. */
function missionTitle(script, messages) {
  for (const op of script.ops) {
    if (op.op !== 17 || op.args[0] < 0) continue;
    const lines = messages[op.args[0]].lines;
    if (lines.length > 0) return lines.join(" ");
  }
  return "";
}

function buildDocument(table, decoded) {
  return {
    schema: "pinball-illusions/table-modes/v1",
    tableId: table.tableId,
    displayName: table.displayName,
    provenance: PROVENANCE,
    opcodes: OPCODES.map((op) => ({ index: op.index, name: op.name, length: op.length, args: op.args })),
    elements: decoded.elements,
    messages: decoded.messages,
    scripts: decoded.scripts,
    missions: decoded.missions,
    ladders: decoded.ladders,
    triggers: decoded.triggers,
  };
}

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const segDir = positional[0];
  const outDir = positional[1] ?? "public/generated/tables";

  if (segDir === undefined) {
    console.error("usage: node scripts/export-table-modes.mjs <segment-dir> [out-dir] [--check]");
    return 1;
  }
  if (!existsSync(segDir)) {
    console.error(`segment directory not found: ${segDir}`);
    return 1;
  }
  if (!check) mkdirSync(outDir, { recursive: true });

  console.log(check ? "checking table modes and missions" : "exporting table modes and missions");
  let failures = 0;

  for (const table of TABLES) {
    let decoded;
    try {
      decoded = decode(loadPackage(segDir, table.stem), table);
    } catch (error) {
      console.error(`  ${table.tableId.padStart(15)}: ${error instanceof Error ? error.message : error}`);
      failures += 1;
      continue;
    }

    const blindSelected = decoded.stats.blind.filter((entry) => entry.selected);
    if (blindSelected.length > 0) {
      console.error(
        `  ${table.tableId.padStart(15)}: ${blindSelected.length} SELECTABLE mission(s) wait on ` +
          `shots nothing can award: script ${blindSelected.map((e) => e.script).join(", ")}`,
      );
      failures += 1;
      continue;
    }

    const json = JSON.stringify(buildDocument(table, decoded));
    const out = join(outDir, `${table.tableId}.modes.json`);
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
    const selected = decoded.missions.filter((mission) => mission.selected).length;
    for (const entry of decoded.stats.blind) {
      console.log(
        `  ${pad}  NOTE: standalone mode ${entry.script} waits only on shots this decode cannot ` +
          `reach statically; see the dynamic-link note in the header`,
      );
    }
    console.log(
      `  ${pad}  ${decoded.scripts.length} scripts, ${decoded.elements.length} elements, ` +
        `${decoded.messages.length} display records, ${decoded.ladders.length} count ladders`,
    );
    console.log(
      `  ${pad}  ${decoded.missions.length} modes (${selected} on ${decoded.selectors.length} ` +
        `selector table(s)), ${decoded.triggers.devices.length} device / ` +
        `${decoded.triggers.zones.length} zone / ${decoded.triggers.locks.length} lock bindings`,
    );
    console.log(
      `  ${pad}  ${decoded.stats.waited} elements waited on, ` +
        `${decoded.stats.waited - decoded.stats.unreachable.length} of them awarded by a shot ` +
        `(${decoded.stats.shootable} shootable elements in all)`,
    );
    for (const mission of decoded.missions) {
      const where = mission.selected ? `sel ${mission.selector}.${mission.id}` : "standalone ";
      console.log(
        `  ${pad}    ${where.padEnd(12)} script ${String(mission.script).padStart(3)}  ` +
          `${decoded.scripts[mission.script].ops.length} ops  ${mission.title}`,
      );
    }
  }

  if (failures > 0) {
    console.error(`${failures} table(s) ${check ? "differ or are missing" : "could not be exported"}`);
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
