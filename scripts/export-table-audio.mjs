#!/usr/bin/env node
// Decodes the SOUND EFFECTS out of the table packages into WAV files and a
// manifest under public/generated/tables/. Run locally, where the operator's own
// disks live; what it writes is what ships.
//
// ---------------------------------------------------------------------------
// SLOTS 7 AND 8 ARE NOT RAW PCM
// ---------------------------------------------------------------------------
// They look like it — a flat byte distribution over the whole slot — but every
// one of them begins with the magic `SNT!`, and the structure behind it is a
// ProTracker module reader at main.seg00 $7BF8:
//
//     +$000 'SNT!'
//     +$004 u32  byte offset of the PCM, relative to the bank base
//     +$008 31 x { u16 length_words, u8 finetune, u8 volume,
//                  u16 repeat_words, u16 repeat_length_words }
//     +$100 u8   song length          +$101 u8 restart
//     +$102 128 x u8 order list       +$282 64 x u16 pattern offsets
//     +$302 packed pattern data (NOT 1024-byte ProTracker patterns)
//     +$004-> the sample PCM, contiguous in table order, 2*length_words each
//
// A slot holds one or more banks back to back and THE SOUND-EFFECT PCM IS
// APPENDED AFTER THE LAST ONE. So the great majority of those bytes are music
// instruments — 1,029,942 of them across the three tables against 150,006 bytes
// of effects — and this exporter takes only the effects and the individual
// instruments the effect records name. THE MUSIC — the banks as MODULES,
// order lists, packed patterns (the cell encoding the front-end round cracked
// at $7F8A-$7FE6) and the engine's cue records — is exported separately by
// scripts/export-table-music.mjs; this exporter stays effects-only.
//
// ---------------------------------------------------------------------------
// THE SOUND RECORD, 26 BYTES
// ---------------------------------------------------------------------------
// Reached by `jsr $6CD0`, which masks the first byte with 7 and indexes the word
// table at $6CE4 SCALED BY TWO (extension word $0206; this is the 68020 AGA
// build, so the scale bits are live). Kind 2 is a PCM sample, kind 5 a bank
// instrument, kind 4 is a MUSIC COMMAND — $6868 posts its +$2/+$4/+$6 words
// to the module player's mailbox; export-table-music.mjs documents that whole
// layer. The layout below is proven by the per-frame
// DMA servicer at $7958, which is handed the record verbatim with a3 = $DFF0D0:
//
//     7962  move.l  a1,(a3)          ; AUD3LC   <- +$16
//     7964  move.w  $8(a0),$4(a3)    ; AUD3LEN  <- +$08
//     796a  move.w  $6(a0),$6(a3)    ; AUD3PER  <- +$06
//     7970  move.w  $4(a0),$8(a3)    ; AUD3VOL  <- +$04
//
//     +$00 u8  kind        +$01 u8  flags       +$02 u16 priority
//     +$04 u16 volume      +$06 u16 period      +$08 u16 chunk (words)
//     +$0C u16 chunks      +$0E u16 loop        +$10 u16 reload
//     +$12 u16 bank        +$14 u16 instrument  +$16 u32 sample
//
//     total length = 2 * chunk * chunks bytes
//
// PERIOD IS A PITCH, and that is measured three ways. The disassembly writes it
// to AUD3PER; every period in every record on all three tables is an exact entry
// of the ProTracker table; and the records that share one sample differ only in
// period and form musical intervals — BabeWatch's $9774/$978E/$97A8/$97C2 are
// 428/404/381/360, which is C-2/C#2/D-2/D#2, a chromatic run handed to four
// adjacent lane-trigger rectangles. So the PAL sample rate is 3546895/period and
// that is the rate written into the WAV.
//
// SIGNEDNESS is proven twice: Paula is 8-bit signed by hardware, and the mean
// absolute first difference of every one of the 33 effect samples is 2 to 4
// times smaller read as signed than read sign-flipped. WAV is unsigned, so the
// bytes are biased by 128 on the way out and nothing else is touched.
//
// ---------------------------------------------------------------------------
// WHAT PLAYS WHAT
// ---------------------------------------------------------------------------
// Seven binding chains, all uniform across the three tables:
//
//     device record        +$08 -> sound record         id device-N
//     bumper record        +$02 -> sound record         id bumper-N
//     slingshot record     +$02 -> sound record         id slingshot-N
//     zone object          +$02 -> sound record         id zone-L-N
//     lock zone object     +$10 -> sound record         id zone-eject-L-N
//     element record       +$10 / +$3C -> sound record  id mode-element-N
//     display record       op-0x10 operand -> record    id mode-element-N /
//                                                          mode-start-N /
//                                                          mode-message-N
//
// They are exported keyed by the SAME id the scoring layer gives an award —
// `device-36`, `bumper-16`, `zone-0-8`, `mode-element-15` — so the browser's
// audio layer can map a tick report to a sound without knowing anything about
// the packages.
//
// THE LOCK-ZONE EJECT VOICE (+$10 on the type-4 zone object) is played by the
// popper at main.seg00 $6FD8-$6FE2/$705A-$7060 during the eject countdown; the
// game loop reports which saucer ejected, and `zone-eject-L-N` is that saucer.
//
// THE ELEMENT AND DISPLAY CHAINS are the award/mode sting layer:
//
//   * element +$10 is the AWARD-path sound the interpreter at $5CF8 plays when
//     an element is AWARDed (the modes exporter's ELEMENT_SOUND_AWARD, whose
//     presence flag ships in the modes document — CHECK 6 below ties the two
//     exports together element by element). +$3C is a second award-path sound
//     slot a few records carry (BabeWatch's jackpot fanfare r96A4 hangs there);
//     it is used only when +$10 is empty.
//   * display records — element +$14 (START path), +$18 (AWARD path), and the
//     message records MESSAGE shows — are programs for the display VM whose
//     opcode table is at main.seg00 $6748, and its op 0x10 ($6940) plays the
//     sound record its operand names. Those operands are found mechanically:
//     every relocated longword whose preceding word is 0x0010 and whose target
//     reads as a sound record (the same period/kind/volume test as CHECK 2).
//     Each site is attributed to the display record it sits inside — the
//     nearest known display start at or below it, always within 0x42 bytes on
//     the shipped tables — and keyed by how the runtime learns that display
//     ran: `mode-message-N` when the record is in the message pool (the mode
//     VM reports every shown message, including the ones element starts and
//     awards push), else `mode-element-N` / `mode-start-N` for the awarding or
//     starting element. One record per trigger: the direct award sound wins
//     over a display sting, and only a container's first site binds — the
//     original can layer several on its one channel, a manifest maps one.
//
// This is how the two universal script stings ship — Law 'n Justice's r9E50
// (28 sites, priority 120) and BabeWatch's r9740 (43 sites) — and Extreme
// Sports' five 0.5-0.8 s mission callouts, none of which any earlier chain
// reached. See research/SOUND_CENSUS.md for the full per-record inventory.
//
// KIND 5 IS DECODED — the resolver the earlier export could not find is in
// main.seg00 at $343E. It runs at table-load time: it walks the whole record
// array from descriptor +$7C (stride 26), and for each kind-5 record indexes
// the per-bank instrument table at $3456 by (instrument - 1), storing the
// resolved sample pointer into the record's own +$16 ($3468) and deriving the
// chunk length from the directory length and the period ($346E-$3486, constant
// $11519 = PAL clock / 50). That is exactly the (bank, instrument) -> address
// rule this exporter applies, so the manifest now labels kind-5 samples
// "decoded" like the rest. The corroboration that used to justify the
// inference — every pair lands on a live sample, the bank-0 discriminating
// case, the instrument-7 rollover scale A-1/C-2/D-2/E-2 — still holds.
//
// ---------------------------------------------------------------------------
// THE CHECKS, ALL FATAL
// ---------------------------------------------------------------------------
// 1. EVERY AUDIO SLOT STARTS WITH `SNT!` and its sample directory sums to a PCM
//    region that fits inside the slot.
// 2. EVERY SOUND RECORD'S PERIOD IS A PROTRACKER PERIOD and its volume is in
//    Paula's 0..64. A record read at the wrong offset fails this immediately.
// 3. EVERY KIND-2 SAMPLE LIES INSIDE ITS SLOT and past the last bank's PCM, i.e.
//    in the effect tail rather than in the middle of a module's instruments.
// 4. EVERY KIND-5 (bank, instrument) PAIR NAMES A LIVE SAMPLE in that bank.
// 5. THE RELOCATION TABLES PARSE TO THE BYTE on every slot of every package.
// 6. THE ELEMENT POOL MATCHES THE SHIPPED MODES DOCUMENT: same element count,
//    and per element the same "has an award sound" / "has a start sound" flags
//    the modes exporter recorded. The `mode-element-N` ids only mean anything
//    because N is the same N the mode VM reports, and this is what pins it.
// 7. EVERY OP-0x10 SITE LIES INSIDE A KNOWN DISPLAY RECORD — between a display
//    or message start and the next known record, never past ATTRIBUTION_SPAN.
//
// Usage:
//   node scripts/export-table-audio.mjs <segment-dir> [out-dir] [--check]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { findScripts, modePools } from "./export-table-modes.mjs";

const PREAMBLE = 4;
const DEVICE_SLOTS = 160;
const DEVICE_ID_BASE = 32;
const ZONE_RECORD_BYTES = 14;

const HEADER_LOWER_DEVICES = 0x10;
const HEADER_LOWER_ZONES = 0x14;
const HEADER_UPPER_DEVICES = 0x28;
const HEADER_UPPER_ZONES = 0x2c;
const HEADER_BUMPERS = 0x30;
const HEADER_SLINGSHOTS = 0x34;
/** The two SNT! bank pointers the descriptor carries. */
const HEADER_BANK_0 = 0x74;
const HEADER_BANK_1 = 0x78;

const DEVICE_SOUND = 0x08;
const HIT_SOUND = 0x02;
const ZONE_SOUND = 0x02;
/** The eject voice a type-4 (lock) zone object carries; see the header. */
const ZONE_EJECT_SOUND = 0x10;
/** Zone record: the type word and the lock type the eject chain applies to. */
const ZONE_TYPE = 0x08;
const ZONE_OBJECT = 0x0a;
const ZONE_TYPE_LOCK = 4;

/** Element record sound and display slots (the modes exporter's offsets). */
const ELEMENT_SOUND_START = 0x0c;
const ELEMENT_SOUND_AWARD = 0x10;
const ELEMENT_SOUND_AWARD_ALT = 0x3c;
const ELEMENT_DISPLAY_START = 0x14;
const ELEMENT_DISPLAY_AWARD = 0x18;

/** The display VM's play-record opcode; operand is a relocated longword. */
const OP_PLAY_RECORD = 0x0010;
/**
 * How far past a display record's start an op-0x10 site may sit and still be
 * that record's. The farthest site on the shipped tables is +0x42; anything
 * beyond this is CHECK 7 refusing an attribution rather than guessing one.
 */
const ATTRIBUTION_SPAN = 0x80;

/** Sound record fields. Each is quoted to its instruction in the header. */
const SOUND_KIND = 0x00;
const SOUND_PRIORITY = 0x02;
const SOUND_VOLUME = 0x04;
const SOUND_PERIOD = 0x06;
const SOUND_CHUNK = 0x08;
const SOUND_CHUNKS = 0x0c;
const SOUND_LOOP = 0x0e;
const SOUND_BANK = 0x12;
const SOUND_INSTRUMENT = 0x14;
const SOUND_SAMPLE = 0x16;

const KIND_SAMPLE = 2;
const KIND_INSTRUMENT = 5;

/** PAL colour clock over two: the divisor Paula's period counts down from. */
const PAL_CLOCK = 3546895;

/** Surface ids, matching `surface-physics.ts`. */
const BUMPER_ID_MIN = 16;
const SLINGSHOT_ID_MIN = 22;

/** The whole ProTracker period table. CHECK 2 tests against exactly this set. */
const PROTRACKER_PERIODS = new Set([
  856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
  428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
  214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
]);

/** Samples in an SNT! bank's directory, and the bytes of one entry. */
const BANK_SAMPLES = 31;
const BANK_SAMPLE_ENTRY = 8;
const BANK_DIRECTORY = 0x008;
const BANK_PCM_OFFSET = 0x004;

const TABLES = [
  { stem: "Table001", tableId: "law-n-justice", displayName: "Law 'n Justice" },
  { stem: "Table002", tableId: "babewatch", displayName: "BabeWatch" },
  { stem: "Table003", tableId: "extreme-sports", displayName: "Extreme Sports" },
];

const PROVENANCE = {
  sourceClass: "disk-derived-audio",
  description:
    "Sound-effect samples decoded from the SNT! banks of the operator's own AGA " +
    "floppy set, at the Paula period each sound record names. Effects only: the " +
    "banks as music modules ship separately under disk-derived-table-music.",
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
      const target = raw.readUInt32BE(at);
      at += 4;
      for (let i = 0; i < count; i += 1) {
        relocations.set(`${slot}:${raw.readUInt32BE(at)}`, target);
        at += 4;
      }
    }
    if (raw.length - at > 3) throw new Error(`${path}: relocation blocks do not consume the file`);
  }

  if (bodies.length === 0) throw new Error(`no package slots found for ${stem} under ${segDir}`);
  return { stem, bodies, relocations };
}

function bodyOf(pkg, hunk) {
  const body = pkg.bodies[hunk];
  if (body === undefined) throw new Error(`${pkg.stem}: hunk ${hunk} is not in this package`);
  return body;
}

function inBounds(pkg, at, span) {
  const body = pkg.bodies[at.hunk];
  return body !== undefined && at.offset >= 0 && at.offset + span <= body.length;
}

const readU8 = (pkg, at, delta = 0) => bodyOf(pkg, at.hunk).readUInt8(at.offset + delta);
const readU16 = (pkg, at, delta = 0) => bodyOf(pkg, at.hunk).readUInt16BE(at.offset + delta);
const readS16 = (pkg, at, delta = 0) => bodyOf(pkg, at.hunk).readInt16BE(at.offset + delta);
const readU32 = (pkg, at, delta = 0) => bodyOf(pkg, at.hunk).readUInt32BE(at.offset + delta);

function follow(pkg, at, delta = 0) {
  if (!inBounds(pkg, at, delta + 4)) return null;
  const target = pkg.relocations.get(`${at.hunk}:${at.offset + delta}`);
  if (target === undefined) return null;
  const offset = readU32(pkg, at, delta);
  const body = pkg.bodies[target];
  if (body === undefined || offset >= body.length) return null;
  return { hunk: target, offset };
}

const descriptorPointer = (pkg, delta) => follow(pkg, { hunk: 0, offset: 0 }, delta);
const key = (at) => `${at.hunk}:${at.offset}`;

// ---------------------------------------------------------------------------
// The SNT! banks
// ---------------------------------------------------------------------------

/**
 * CHECK 1 — walks the banks in one slot and answers where the effect tail starts.
 *
 * Banks sit back to back, each ending where its own PCM ends, and everything
 * after the last one is the effect pool. A slot that does not start with `SNT!`
 * is not an audio slot at all, which is how the two slot layouts — Extreme
 * Sports has both of its banks in slot 7 and no slot 8 — are told apart without
 * hard-coding either.
 */
function readBanks(pkg, hunk) {
  const body = pkg.bodies[hunk];
  if (body === undefined) return null;
  if (body.length < 0x400 || body.toString("latin1", 0, 4) !== "SNT!") return null;

  const banks = [];
  let at = 0;
  while (at + 0x400 <= body.length && body.toString("latin1", at, at + 4) === "SNT!") {
    const pcmAt = at + body.readUInt32BE(at + BANK_PCM_OFFSET);
    const samples = [];
    let cursor = pcmAt;
    for (let i = 0; i < BANK_SAMPLES; i += 1) {
      const entry = at + BANK_DIRECTORY + BANK_SAMPLE_ENTRY * i;
      const words = body.readUInt16BE(entry);
      const repeatWords = body.readUInt16BE(entry + 4);
      const repeatLength = body.readUInt16BE(entry + 6);
      samples.push({
        index: i + 1,
        offset: cursor,
        bytes: words * 2,
        loop: repeatLength > 1 ? repeatWords * 2 : -1,
        loopBytes: repeatLength > 1 ? repeatLength * 2 : 0,
      });
      cursor += words * 2;
    }
    if (cursor > body.length) {
      throw new Error(
        `${pkg.stem}: SNT! bank at ${at} of hunk ${hunk} declares PCM ending at ${cursor}, past ` +
          `the slot's ${body.length} bytes`,
      );
    }
    banks.push({ base: at, samples, end: cursor });
    at = cursor + (cursor & 1);
  }
  return banks.length === 0 ? null : { banks, tail: at };
}

// ---------------------------------------------------------------------------
// Sound records
// ---------------------------------------------------------------------------

/**
 * CHECK 2 — reads a sound record, or answers null when the address is not one.
 *
 * The period test is what makes this safe: a longword that happens to point at
 * a struct has about a one in eighteen hundred chance of holding a ProTracker
 * period at +$06, and the kind and volume tests are on top of that.
 */
function readSoundRecord(pkg, at) {
  if (!inBounds(pkg, at, 26)) return null;
  const kind = readU8(pkg, at, SOUND_KIND);
  if (kind !== KIND_SAMPLE && kind !== KIND_INSTRUMENT) return null;
  const period = readU16(pkg, at, SOUND_PERIOD);
  if (!PROTRACKER_PERIODS.has(period)) return null;
  const volume = readU16(pkg, at, SOUND_VOLUME);
  if (volume > 64) return null;

  return {
    at,
    kind,
    priority: readU16(pkg, at, SOUND_PRIORITY),
    volume,
    period,
    chunk: readU16(pkg, at, SOUND_CHUNK),
    chunks: readU16(pkg, at, SOUND_CHUNKS),
    loop: readU16(pkg, at, SOUND_LOOP),
    bank: readU16(pkg, at, SOUND_BANK),
    instrument: readU16(pkg, at, SOUND_INSTRUMENT),
    sample: follow(pkg, at, SOUND_SAMPLE),
  };
}

/** The PCM one sound record plays, as signed bytes, or null. */
function pcmFor(pkg, record, audio) {
  if (record.kind === KIND_SAMPLE) {
    const at = record.sample;
    // CHECK 3 — a kind-2 sample lives in the effect tail, past every bank's PCM.
    if (at === null) return null;
    const slot = audio.get(at.hunk);
    if (slot === undefined) {
      throw new Error(`${pkg.stem}: sample at hunk ${at.hunk} is not an SNT! slot`);
    }
    const bytes = 2 * record.chunk * record.chunks;
    if (bytes <= 0 || !inBounds(pkg, at, bytes)) {
      throw new Error(
        `${pkg.stem}: sound record ${key(record.at)} claims ${bytes} bytes at ${key(at)}, which ` +
          `does not fit in the slot`,
      );
    }
    if (at.offset < slot.tail) {
      throw new Error(
        `${pkg.stem}: sound record ${key(record.at)} points at ${at.offset}, inside a module's ` +
          `instruments rather than in the effect tail that starts at ${slot.tail}`,
      );
    }
    return bodyOf(pkg, at.hunk).subarray(at.offset, at.offset + bytes);
  }

  // CHECK 4 — a kind-5 record names a live sample in the bank it names.
  const bankBase = descriptorPointer(pkg, record.bank === 0 ? HEADER_BANK_0 : HEADER_BANK_1);
  if (bankBase === null) return null;
  const slot = audio.get(bankBase.hunk);
  if (slot === undefined) return null;
  const bank = slot.banks.find((candidate) => candidate.base === bankBase.offset);
  if (bank === undefined) return null;
  const sample = bank.samples.find((candidate) => candidate.index === record.instrument);
  if (sample === undefined || sample.bytes <= 0) {
    throw new Error(
      `${pkg.stem}: sound record ${key(record.at)} names bank ${record.bank} instrument ` +
        `${record.instrument}, which is not a live sample`,
    );
  }
  return bodyOf(pkg, bankBase.hunk).subarray(sample.offset, sample.offset + sample.bytes);
}

// ---------------------------------------------------------------------------
// The bindings
// ---------------------------------------------------------------------------

/**
 * Everything that plays a sound, keyed the way `scoring.ts` keys an award.
 *
 * That key is the whole point of doing it here: the browser's audio layer gets a
 * tick report full of `Award`s and needs a sample, and if the two sides derived
 * their names separately they would drift.
 */
function bindings(pkg) {
  const found = [];

  for (const level of [0, 1]) {
    const base = descriptorPointer(pkg, level === 1 ? HEADER_UPPER_DEVICES : HEADER_LOWER_DEVICES);
    if (base !== null) {
      for (let index = 0; index < DEVICE_SLOTS; index += 1) {
        const record = follow(pkg, base, 4 * index);
        if (record === null) continue;
        const sound = follow(pkg, record, DEVICE_SOUND);
        if (sound !== null) found.push({ id: `device-${index + DEVICE_ID_BASE}`, sound });
      }
    }
    const zones = descriptorPointer(pkg, level === 1 ? HEADER_UPPER_ZONES : HEADER_LOWER_ZONES);
    if (zones === null) continue;
    for (let index = 0; ; index += 1) {
      const at = { hunk: zones.hunk, offset: zones.offset + ZONE_RECORD_BYTES * index };
      if (!inBounds(pkg, at, ZONE_RECORD_BYTES) || readS16(pkg, at, 0) < 0) break;
      if (index > 200) throw new Error(`${pkg.stem}: zone list on level ${level} is not terminated`);
      const object = follow(pkg, at, ZONE_OBJECT);
      if (object === null) continue;
      const sound = follow(pkg, object, ZONE_SOUND);
      if (sound !== null) found.push({ id: `zone-${level}-${index}`, sound });
      // The lock's eject voice, on the saucer's own object. Only a type-4 zone
      // is a lock; on every other type +$10 is not a sound slot.
      if (readU16(pkg, at, ZONE_TYPE) === ZONE_TYPE_LOCK) {
        const eject = follow(pkg, object, ZONE_EJECT_SOUND);
        if (eject !== null) found.push({ id: `zone-eject-${level}-${index}`, sound: eject });
      }
    }
  }

  // Bumpers and slingshots: a 0-terminated u16 offset table then the records,
  // indexed as `offsets[index - 1]` by `adda.w -$2(a1,d3.w*2),a1` at +0x00B594.
  for (const [delta, prefix, idBase] of [
    [HEADER_BUMPERS, "bumper", BUMPER_ID_MIN],
    [HEADER_SLINGSHOTS, "slingshot", SLINGSHOT_ID_MIN],
  ]) {
    const base = descriptorPointer(pkg, delta);
    if (base === null) continue;
    for (let index = 0; index < 16; index += 1) {
      const offset = readU16(pkg, base, 2 * index);
      if (offset === 0) break;
      const record = { hunk: base.hunk, offset: base.offset + offset };
      const sound = follow(pkg, record, HIT_SOUND);
      if (sound === null) continue;
      // A slingshot has two faces and therefore two surface ids per record; the
      // responder's index is `((id - 22) >> 1) + 1`, so both faces get the sound.
      if (prefix === "slingshot") {
        found.push({ id: `slingshot-${idBase + 2 * index}`, sound });
        found.push({ id: `slingshot-${idBase + 2 * index + 1}`, sound });
      } else {
        found.push({ id: `bumper-${idBase + index}`, sound });
      }
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// The mode bindings: element sounds and display-script stings
// ---------------------------------------------------------------------------

/**
 * Everything the award/mode layer plays, keyed the way the mode VM reports it:
 * `mode-element-N` fires with the element's award (it is already an award id
 * in the tick report), `mode-start-N` with `elementStarts`, `mode-message-N`
 * with `messagesShown`. See the header for the two chains and CHECKs 6 and 7.
 *
 * `modesDoc` is the SHIPPED modes document, and it is required: the element
 * indices here are only meaningful because they are derived by exactly the
 * walk `export-table-modes.mjs` ships, and CHECK 6 refuses to export against a
 * document that disagrees.
 */
function modeBindings(pkg, modesDoc) {
  const scripts = findScripts(pkg);

  // The pools, IMPORTED from the modes exporter rather than rebuilt: this file
  // used to carry its own copy of the rule and so did the panel exporter, and a
  // copy that drifts is a `mode-message-N` naming a different record from the
  // one the mode document numbered. `modePools` now seeds the display pool from
  // every element's own +$14 / +$18 as well as from the MESSAGE operands, which
  // is why the message pool below is far larger than it was and why nearly
  // every `mode-element-N` / `mode-start-N` binding has become a
  // `mode-message-N`. Same record, same moment, same sample: `startElement` and
  // `awardElement` push the display onto `messagesShown` at exactly the point
  // they used to report only the element, which is what the note under
  // "Containers" below has always said would happen.
  const { elements, messages } = modePools(pkg, scripts);
  const messageIndex = new Map(messages.map((at, index) => [key(at), index]));

  // CHECK 6 — this pool must be the modes document's pool, element for element.
  const shipped = Array.isArray(modesDoc?.elements) ? modesDoc.elements : null;
  if (shipped === null || shipped.length !== elements.length) {
    throw new Error(
      `${pkg.stem}: derived ${elements.length} elements but the modes document ships ` +
        `${shipped === null ? "none" : shipped.length}; re-run export-table-modes.mjs first`,
    );
  }
  for (const [index, at] of elements.entries()) {
    const start = follow(pkg, at, ELEMENT_SOUND_START) !== null;
    const award = follow(pkg, at, ELEMENT_SOUND_AWARD) !== null;
    if (Boolean(shipped[index].soundStart) !== start || Boolean(shipped[index].soundAward) !== award) {
      throw new Error(
        `${pkg.stem}: element ${index} sound flags (start ${start}, award ${award}) disagree ` +
          `with the shipped modes document; the two exports are not looking at the same pool`,
      );
    }
  }

  // Containers: every display record the runtime can report having run, keyed
  // by the id it reports. The message pool claims an address first — the mode
  // VM pushes an element's display onto `messagesShown` whenever that display
  // is in the pool, so binding it as a message avoids firing twice.
  const containers = new Map();
  const admit = (at, id) => {
    if (at !== null && !containers.has(key(at))) containers.set(key(at), { at, id });
  };
  for (const [index, at] of messages.entries()) admit(at, `mode-message-${index}`);
  for (const [index, at] of elements.entries()) {
    const award = follow(pkg, at, ELEMENT_DISPLAY_AWARD);
    if (award !== null && !messageIndex.has(key(award))) admit(award, `mode-element-${index}`);
    const start = follow(pkg, at, ELEMENT_DISPLAY_START);
    if (start !== null && !messageIndex.has(key(start))) admit(start, `mode-start-${index}`);
  }
  const containersByHunk = new Map();
  for (const container of containers.values()) {
    const list = containersByHunk.get(container.at.hunk) ?? [];
    list.push(container);
    containersByHunk.set(container.at.hunk, list);
  }
  for (const list of containersByHunk.values()) list.sort((a, b) => a.at.offset - b.at.offset);

  // Every op-0x10 site: a relocated longword whose preceding word is the
  // play-record opcode and whose target reads as a sound record. The record
  // test is what makes the scan safe — see `readSoundRecord`.
  const sites = [];
  for (const where of pkg.relocations.keys()) {
    const [hunk, offset] = where.split(":").map(Number);
    if (offset < 2) continue;
    const at = { hunk, offset };
    if (!inBounds(pkg, at, 4)) continue;
    if (readU16(pkg, { hunk, offset: offset - 2 }) !== OP_PLAY_RECORD) continue;
    const target = follow(pkg, at, 0);
    if (target === null || readSoundRecord(pkg, target) === null) continue;
    sites.push({ hunk, offset: offset - 2, target });
  }
  sites.sort((a, b) => a.hunk - b.hunk || a.offset - b.offset);

  const found = [];
  // The direct element sounds first, so they win the id over a display sting.
  for (const [index, at] of elements.entries()) {
    const award = follow(pkg, at, ELEMENT_SOUND_AWARD) ?? follow(pkg, at, ELEMENT_SOUND_AWARD_ALT);
    if (award !== null) found.push({ id: `mode-element-${index}`, sound: award });
    const start = follow(pkg, at, ELEMENT_SOUND_START);
    if (start !== null) found.push({ id: `mode-start-${index}`, sound: start });
  }

  // Then the display stings, first site per container.
  const claimed = new Set();
  let layered = 0;
  for (const site of sites) {
    let holder = null;
    for (const container of containersByHunk.get(site.hunk) ?? []) {
      if (container.at.offset <= site.offset) holder = container;
      else break;
    }
    // CHECK 7 — a site outside every known display record would mean the
    // display pools are incomplete, and guessing an id would wire a sound to
    // an event that never fires (or the wrong one).
    if (holder === null || site.offset - holder.at.offset >= ATTRIBUTION_SPAN) {
      throw new Error(
        `${pkg.stem}: op-0x10 site at hunk ${site.hunk}+${site.offset} is not inside any known ` +
          `display record; the nearest starts ${holder === null ? "nowhere" : `${site.offset - holder.at.offset} bytes back`}`,
      );
    }
    if (claimed.has(key(holder.at))) {
      layered += 1; // a second sting in one display: the manifest maps one.
      continue;
    }
    claimed.add(key(holder.at));
    found.push({ id: holder.id, sound: site.target });
  }

  return { found, stats: { elements: elements.length, messages: messages.length, sites: sites.length, layered } };
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

/**
 * An 8-bit mono RIFF/WAVE at the Paula rate.
 *
 * The bytes are biased by 128 and nothing else is done to them: no resampling,
 * no normalisation, no fades. A resampler here would be this project inventing
 * audio, and the browser can play a 6 kHz buffer perfectly well.
 */
function toWav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28); // byte rate: one channel, one byte a frame
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits
  header.write("data", 36, "latin1");
  header.writeUInt32LE(pcm.length, 40);

  const body = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) body[i] = (pcm[i] + 128) & 0xff;
  return Buffer.concat([header, body]);
}

// ---------------------------------------------------------------------------
// Assembling one table
// ---------------------------------------------------------------------------

function decode(pkg, table, modesDoc) {
  const audio = new Map();
  for (let hunk = 0; hunk < pkg.bodies.length; hunk += 1) {
    const slot = readBanks(pkg, hunk);
    if (slot !== null) audio.set(hunk, slot);
  }
  if (audio.size === 0) throw new Error(`${pkg.stem}: no SNT! slot in this package`);

  const samples = [];
  const byRecord = new Map();
  /** id -> sample index; FIRST binding of an id wins, so the direct chains
   * (and among the mode chains, the award interpreter's own slot) take
   * precedence over later stings on the same id. */
  const triggerById = new Map();
  const modes = modeBindings(pkg, modesDoc);

  for (const binding of [...bindings(pkg), ...modes.found]) {
    const record = readSoundRecord(pkg, binding.sound);
    if (record === null) continue;
    if (triggerById.has(binding.id)) continue;
    const recordKey = key(binding.sound);
    let index = byRecord.get(recordKey);
    if (index === undefined) {
      const pcm = pcmFor(pkg, record, audio);
      if (pcm === null || pcm.length === 0) continue;
      index = samples.length;
      byRecord.set(recordKey, index);
      const rate = Math.round(PAL_CLOCK / record.period);
      const wav = toWav(pcm, rate);
      samples.push({
        index,
        file: `${table.tableId}.snd-${String(index).padStart(2, "0")}.wav`,
        wav,
        sha256: createHash("sha256").update(wav).digest("hex"),
        bytes: pcm.length,
        rate,
        period: record.period,
        // Paula's 0..64 taken to a plain gain, because that is what the volume
        // register is: a linear multiplier on the sample byte.
        volume: record.volume,
        priority: record.priority,
        kind: record.kind === KIND_SAMPLE ? "sample" : "instrument",
        milliseconds: Math.round((pcm.length / rate) * 1000),
        // Both kinds are decoded: kind 2's pointer is a relocation this walk
        // follows, and kind 5's (bank, instrument) rule is the loader at
        // main.seg00 $343E — see the header.
        provenance: "decoded",
      });
    }
    triggerById.set(binding.id, index);
  }

  const triggers = [...triggerById.entries()]
    .map(([id, sample]) => ({ id, sample }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { samples, triggers, banks: [...audio.values()], modeStats: modes.stats };
}

function buildDocument(table, decoded) {
  return {
    schema: "pinball-illusions/table-audio/v1",
    tableId: table.tableId,
    displayName: table.displayName,
    provenance: PROVENANCE,
    sampleRateNote:
      "Each sample is written at 3546895 / period Hz, the PAL rate its Paula period asks for. " +
      "Nothing is resampled, normalised or faded.",
    samples: decoded.samples.map(({ wav, ...rest }) => rest),
    triggers: decoded.triggers,
  };
}

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const segDir = positional[0];
  const outDir = positional[1] ?? "public/generated/tables";

  if (segDir === undefined) {
    console.error("usage: node scripts/export-table-audio.mjs <segment-dir> [out-dir] [--check]");
    return 1;
  }
  if (!existsSync(segDir)) {
    console.error(`segment directory not found: ${segDir}`);
    return 1;
  }
  if (!check) mkdirSync(outDir, { recursive: true });

  console.log(check ? "checking table audio" : "exporting table audio");
  let failures = 0;

  for (const table of TABLES) {
    let decoded;
    try {
      // The shipped modes document pins the element/message indices the mode
      // triggers are keyed by (CHECK 6), so it must exist before this runs.
      const modesPath = join(outDir, `${table.tableId}.modes.json`);
      if (!existsSync(modesPath)) {
        throw new Error(`${modesPath} is missing; run export-table-modes.mjs first`);
      }
      const modesDoc = JSON.parse(readFileSync(modesPath, "utf8"));
      decoded = decode(loadPackage(segDir, table.stem), table, modesDoc);
    } catch (error) {
      console.error(`  ${table.tableId.padStart(15)}: ${error instanceof Error ? error.message : error}`);
      failures += 1;
      continue;
    }

    if (decoded.samples.length === 0) {
      console.error(`  ${table.tableId.padStart(15)}: nothing bound to a playable sound`);
      failures += 1;
      continue;
    }

    const json = JSON.stringify(buildDocument(table, decoded));
    const out = join(outDir, `${table.tableId}.audio.json`);
    if (check) {
      const existing = existsSync(out) ? readFileSync(out, "utf8") : null;
      if (existing === json) {
        console.log(`  ${table.tableId.padStart(15)}: identical to ${out}`);
      } else {
        console.error(`  ${table.tableId.padStart(15)}: DIFFERS from ${out}`);
        failures += 1;
      }
      continue;
    }

    writeFileSync(out, json, "utf8");
    let total = 0;
    for (const sample of decoded.samples) {
      writeFileSync(join(outDir, sample.file), sample.wav);
      total += sample.wav.length;
    }
    console.log(
      `  ${table.tableId.padStart(15)}: ${decoded.samples.length} sample(s), ` +
        `${total.toLocaleString()} bytes of WAV, ${decoded.triggers.length} binding(s) -> ${out}`,
    );
    const pad = " ".repeat(15);
    console.log(
      `  ${pad}  mode layer: ${decoded.modeStats.sites} op-0x10 site(s) over ` +
        `${decoded.modeStats.elements} elements / ${decoded.modeStats.messages} messages` +
        (decoded.modeStats.layered > 0
          ? `, ${decoded.modeStats.layered} layered sting(s) beyond the first per display`
          : ""),
    );
    for (const sample of decoded.samples) {
      console.log(
        `  ${pad}    ${String(sample.index).padStart(2)} ${sample.kind.padEnd(10)} ` +
          `period ${String(sample.period).padStart(3)} = ${sample.rate} Hz  ` +
          `${String(sample.bytes).padStart(6)} B  ${String(sample.milliseconds).padStart(4)} ms  ` +
          `prio ${sample.priority} vol ${sample.volume} (${sample.provenance})`,
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
