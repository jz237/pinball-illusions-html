#!/usr/bin/env node
// Decodes the IN-GAME MUSIC — the tune under the ball on every table — out of
// the table packages into per-table module documents and one WAV per live
// instrument, under public/generated/tables/. Run locally, where the
// operator's own disks live; what it writes is what ships.
//
// ---------------------------------------------------------------------------
// THE IN-GAME MUSIC WAS NEVER music001.bin
// ---------------------------------------------------------------------------
// music001.bin is the shell's own load (`PROGDIR:music001.bin` at main.seg00
// $CAE7) and plays no part in gameplay: rendered and correlated against the
// three gameplay captures it scores +0.010/+0.019/+0.023 waveform — noise.
// The music a table plays is the table's own: the two `SNT!` banks its
// descriptor carries at +$74/+$78 — the same banks the sound-effect exporter
// reads instrument PCM out of — are FULL MODULES, order lists and packed
// patterns included, and the engine plays them with the same replayer that
// plays the front end, through the alternate entry at $7A24 which parses
// [$2378]/[$237C] (the descriptor pointers' a5 copies) instead of the shell's
// cached module.
//
// ---------------------------------------------------------------------------
// HOW THE ORIGINAL DRIVES IT (decoded from main.seg00, verified on film)
// ---------------------------------------------------------------------------
// The player keeps a CURRENT song (state +$108..) and a SAVED song (+$000..),
// and takes commands from a mailbox at $2412/$2416/$2418 (a5:$23FC/$2400/
// $2402) that kind-4 "sound" records post through $6868 — record +$2 is the
// command, +$4 the order position, +$6 the bank:
//
//   cmd > 0   OVERRIDE: start (bank, pos) now, saving the current song with
//             its whole channel state ($815E); when the override hits its Bxx
//             the saved song resumes exactly where it was ($8860 -> $821C).
//   cmd -1    QUEUE: set the saved slot and let the CURRENT section finish —
//             the switch happens at the current section's own Bxx ($7E0C sets
//             $21A; the Bxx handler's $219/$211 path activates the queued
//             song at the loop boundary).
//   cmd -2    SET BACKGROUND: switch now (at the row end) unless an override
//             is sounding, in which case just retarget what it returns to
//             ($7DD2 -> $81B0/$81F8).
//
// Bxx is a RAW 0-based order position ($8182 pre-decrements because the
// position advance re-increments), and a param >= $80 jumps to position
// (param & $7F) of the OTHER bank ($889A-$88B6). F00 stops the player dead
// ($883A sets $21C; $7CC2 silences).  Running off the order list wraps to
// position 0 ($8138-$814A).
//
// The engine fires five registered cue records out of the descriptor
// (+$84..+$94, block-copied to $22EE(a5).. at table load — the $32F6 loop):
//
//   +$88  game start ($49BE) and every next ball ($4FC4):  -2, pos 0, bank 0
//   +$8C  game over  ($4606):   -2 into a per-table outro section
//   +$90  high score ($466E):   -2 into a per-table fanfare section
//   +$94  TILT ($4E32, phase 8 — the census's "state 8", the tilted state):
//         a jingle that ends in F00, the player's STOP — the films' only
//         silent gameplay spans. Its length is the measured tilt-to-silence
//         gap on every filmed tilt: Extreme Sports 104 fields decoded
//         against 101-104 filmed (twice), BabeWatch 184 against 176.
//   +$84  table attract ($43B4): kind 0 — a registered no-op on all three
//
// Descriptor +$80 is a CODE pointer — the table's end-of-ball bonus routine,
// called at $51BE `jsr ([$236e,a5])` — and the kind-4 records relocated just
// around its entry are that routine's own cues. Two are exported: QUEUE MAIN
// (-1, pos 1, bank 0 on all three tables — the queued return to the main
// tune; the nearest such pointer below the entry, since the layout varies
// per table) and, two bytes past the entry on all three, a second stop-type
// record (-2 into an F00 section) whose firing moment is not yet established
// on film; it ships as decoded data under `endStop`, unwired.
//
// So the audible shape of a ball, which the reconstruction reproduces, is:
//
//   serve  -> position 0, a short self-looping vamp (B00 at its end)
//   launch -> the main tune from position 1, entered AT THE VAMP'S NEXT LAP
//             BOUNDARY (queued, -1) — measured exact on six launches across
//             the three tables (BW f391/f1211 on 80-field laps, ES f458/f1418
//             on 96-field laps, LNJ f348 on 144-field laps)
//   tilt   -> the +$94 jingle, then its F00 — digital silence (all three
//             filmed tilts; the two Extreme Sports pre-silence spans are the
//             same sequence both times, waveform NCC +0.91 with each other)
//   ball end / next serve -> main queued back, then the vamp again
//
// ---------------------------------------------------------------------------
// FILM VERIFICATION (the music round's method, applied to gameplay)
// ---------------------------------------------------------------------------
// Offline renders of these banks under the decoded replayer rules, against
// the unresampled 48 kHz audio of the reference captures:
//
//   BabeWatch  take1: serve vamp waveform NCC +0.90 (envelope +0.92); main
//              tune +0.65/+0.56 over the ball WITH effects sounding over it;
//   LNJ        fullgame: vamp +0.73..+0.78 before all three serves; main
//              +0.51 envelope +0.84 at ball 2;
//   Extreme    take1/take3: vamp +0.65/+0.53, main +0.56/+0.56/+0.35;
//   controls:  every cross-table pairing and music001 itself score at noise
//              (+0.01..+0.04 waveform).
//
// ---------------------------------------------------------------------------
// THE BANK AND THE CELLS
// ---------------------------------------------------------------------------
// Layout and packed-cell encoding are the ones proven for the front-end
// module (scripts/export-shell-music.mjs; parser at main.seg00 $7BF8, cell
// decoder at $7F8A-$7FE6). The tiling check is absolute here too: on all six
// banks every pattern decodes to exactly 256 cells consuming exactly its
// offset-table range, and the last pattern ends EXACTLY on the PCM offset.
// The PCM does not run to the slot end — the sound-effect tail documented in
// export-table-audio.mjs follows it — so the containment check is against the
// directory sum, not the slot.
//
// Usage:
//   node scripts/export-table-music.mjs <segment-dir> [out-dir] [--check]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

const PREAMBLE = 4;

/** Descriptor pointers (the +$98-byte header of hunk 0; see $32F6). */
const HEADER_BANK_0 = 0x74;
const HEADER_BANK_1 = 0x78;
const HEADER_BONUS_ROUTINE = 0x80;
const HEADER_CUE_BALL_START = 0x88;
const HEADER_CUE_GAME_OVER = 0x8c;
const HEADER_CUE_HIGH_SCORE = 0x90;
const HEADER_CUE_TILT = 0x94;

/**
 * The bonus routine's end-stop record pointer sits two bytes past its entry
 * on all three tables; the queue-main pointer's spacing varies (entry-6 on
 * two tables, entry-14 on the third), so it is found by value within this
 * span below the entry instead of by a fixed offset.
 */
const BONUS_END_STOP = 0x02;
const BONUS_SCAN_SPAN = 0x40;

/** Kind-4 record fields (posted to the mailbox by $6868). */
const RECORD_KIND = 0x00;
const RECORD_COMMAND = 0x02;
const RECORD_POSITION = 0x04;
const RECORD_BANK = 0x06;
const KIND_MUSIC = 4;

/** SNT! bank layout ($7BF8). */
const BANK_SAMPLES = 31;
const BANK_SAMPLE_ENTRY = 8;
const BANK_DIRECTORY = 0x008;
const BANK_PCM_OFFSET = 0x004;
const BANK_SONG_LENGTH = 0x100;
const BANK_RESTART = 0x101;
const BANK_ORDERS = 0x102;
const BANK_ORDER_SLOTS = 128;
const BANK_PATTERN_OFFSETS = 0x282;
const BANK_PATTERN_SLOTS = 64;
const BANK_PATTERN_DATA = 0x302;

const ROWS_PER_PATTERN = 64;
const CHANNELS = 4;

/** Paula's PAL master clock; WAVs are written at the C-3 rate, ft 0. */
const PAL_CLOCK = 3546895;
const WAV_PERIOD_C3 = 214;

/** The position the queue-main cue must name: the main tune's entry. */
const MAIN_POSITION = 1;

const TABLES = [
  { stem: "Table001", tableId: "law-n-justice", displayName: "Law 'n Justice" },
  { stem: "Table002", tableId: "babewatch", displayName: "BabeWatch" },
  { stem: "Table003", tableId: "extreme-sports", displayName: "Extreme Sports" },
];

export const TABLE_MUSIC_SCHEMA = "pinball-illusions/table-music/v1";

const PROVENANCE = {
  sourceClass: "disk-derived-table-music",
  description:
    "The in-game music modules decoded from the two SNT! banks each table " +
    "package carries: order lists, packed patterns and the live PCM " +
    "instruments, as a document plus one WAV per instrument, with the " +
    "engine's decoded cue records naming the serve vamp, the main tune and " +
    "the tilt stop. Nothing is resampled, normalised or faded.",
  authorizationRequired: true,
};

// ---------------------------------------------------------------------------
// The package (the loader export-table-audio.mjs uses, trimmed to this need)
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

function follow(pkg, hunk, offset) {
  const target = pkg.relocations.get(`${hunk}:${offset}`);
  if (target === undefined) return null;
  const body = pkg.bodies[hunk];
  if (body === undefined || offset + 4 > body.length) return null;
  const value = body.readUInt32BE(offset);
  const targetBody = pkg.bodies[target];
  if (targetBody === undefined || value >= targetBody.length) return null;
  return { hunk: target, offset: value };
}

const descriptorPointer = (pkg, delta) => follow(pkg, 0, delta);

// ---------------------------------------------------------------------------
// The bank
// ---------------------------------------------------------------------------

/**
 * CHECK 1 — magic, and a cumulative sample directory whose PCM stays inside
 * the slot. Unlike the front-end module there is NO trailing-pad budget: the
 * sound-effect tail follows the last bank in the same slot by design.
 */
function readBank(pkg, at, label) {
  const body = pkg.bodies[at.hunk];
  const base = at.offset;
  if (body === undefined || base + 0x400 > body.length) {
    throw new Error(`${label}: bank pointer outside its hunk`);
  }
  if (body.toString("latin1", base, base + 4) !== "SNT!") {
    throw new Error(`${label} does not begin with SNT!`);
  }
  const pcmAt = body.readUInt32BE(base + BANK_PCM_OFFSET);
  const samples = [];
  let cursor = base + pcmAt;
  for (let i = 0; i < BANK_SAMPLES; i += 1) {
    const entry = base + BANK_DIRECTORY + BANK_SAMPLE_ENTRY * i;
    const lengthWords = body.readUInt16BE(entry);
    // The finetune byte is ProTracker's nibble: the player masks it with $F
    // and indexes the period table's sixteen rows, rows 8..15 being the
    // negative finetunes ($7C1C `moveq #$f / and.b (a1)+`). The document
    // carries the SIGNED convention the tracker core declares (-8..7); the
    // core's `finetune & 15` maps it back to the same row. The table banks —
    // unlike the front-end module, which never exercised the negative half —
    // do carry rows 8..15.
    const finetuneNibble = body.readUInt8(entry + 2) & 0x0f;
    samples.push({
      index: i + 1,
      lengthWords,
      finetune: finetuneNibble < 8 ? finetuneNibble : finetuneNibble - 16,
      volume: body.readUInt8(entry + 3),
      repeatWords: body.readUInt16BE(entry + 4),
      repeatLengthWords: body.readUInt16BE(entry + 6),
      offset: cursor,
      byteLength: lengthWords * 2,
    });
    cursor += lengthWords * 2;
  }
  if (cursor > body.length) {
    throw new Error(`${label}: sample directory runs ${cursor - body.length} bytes past the slot`);
  }

  const songLength = body.readUInt8(base + BANK_SONG_LENGTH);
  const restart = body.readUInt8(base + BANK_RESTART);
  if (songLength === 0 || songLength > BANK_ORDER_SLOTS) {
    throw new Error(`${label}: song length ${songLength}`);
  }
  const orders = [];
  for (let i = 0; i < songLength; i += 1) orders.push(body.readUInt8(base + BANK_ORDERS + i));
  const patternOffsets = [];
  for (let i = 0; i < BANK_PATTERN_SLOTS; i += 1) {
    patternOffsets.push(body.readUInt16BE(base + BANK_PATTERN_OFFSETS + 2 * i));
  }
  return { body, base, pcmAt, samples, songLength, restart, orders, patternOffsets, label };
}

/** One packed pattern; CHECK 2 — only the two whole-cell bytes exist. */
function decodePattern(bank, patternBase) {
  const { body } = bank;
  const cells = [];
  const previous = [null, null, null, null];
  let at = patternBase;
  for (let row = 0; row < ROWS_PER_PATTERN; row += 1) {
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const byte0 = body.readUInt8(at);
      if ((byte0 & 0x80) !== 0) {
        at += 1;
        if (byte0 === 0x80) {
          cells.push({ note: 0, instrument: 0, effect: 0, param: 0 });
        } else if (byte0 === 0xc0) {
          const held = previous[channel];
          cells.push(held === null ? { note: 0, instrument: 0, effect: 0, param: 0 } : held);
        } else {
          throw new Error(
            `${bank.label}: unknown whole-cell byte 0x${byte0.toString(16)} at +0x${(at - 1 - bank.base).toString(16)}`,
          );
        }
        continue;
      }
      const byte1 = body.readUInt8(at + 1);
      const byte2 = body.readUInt8(at + 2);
      at += 3;
      const event = {
        note: byte0 >> 1,
        instrument: ((byte1 >> 4) << 1) | (byte0 & 1),
        effect: byte1 & 0xf,
        param: byte2,
      };
      previous[channel] = event;
      cells.push(event);
    }
  }
  return { cells, end: at };
}

/**
 * CHECK 3 — the patterns TILE: each consumes exactly the bytes between its
 * own offset and the next, and the LAST ends exactly on the PCM offset. This
 * held with zero slack on all six shipped banks, so it is asserted, not
 * tolerated.
 */
function decodePatterns(bank) {
  const count = Math.max(...bank.orders) + 1;
  const patterns = [];
  for (let index = 0; index < count; index += 1) {
    const patternBase = bank.base + BANK_PATTERN_DATA + bank.patternOffsets[index];
    const { cells, end } = decodePattern(bank, patternBase);
    const next =
      index + 1 < count
        ? bank.base + BANK_PATTERN_DATA + bank.patternOffsets[index + 1]
        : bank.base + bank.pcmAt;
    if (end !== next) {
      throw new Error(
        `${bank.label}: pattern ${index} decoded to +0x${(end - bank.base).toString(16)} but the ` +
          `next boundary is +0x${(next - bank.base).toString(16)}`,
      );
    }
    patterns.push(cells);
  }
  return patterns;
}

/**
 * CHECK 4 — every instrument the patterns name is live, notes are in range,
 * and every Bxx target is a real position: below the song length in this
 * bank, or (param & $7F) below the OTHER bank's song length for the
 * cross-bank form.
 */
function validatePatterns(bank, patterns, otherSongLength) {
  const live = new Set(bank.samples.filter((s) => s.lengthWords > 0).map((s) => s.index));
  for (const [at, cells] of patterns.entries()) {
    for (const [cell, event] of cells.entries()) {
      if (event.instrument !== 0 && !live.has(event.instrument)) {
        throw new Error(`${bank.label}: pattern ${at} cell ${cell} names dead instrument ${event.instrument}`);
      }
      if (event.note > 36) {
        throw new Error(`${bank.label}: pattern ${at} cell ${cell} has note ${event.note} > 36`);
      }
      if (event.effect === 0xb) {
        const target = event.param;
        const ok =
          target < bank.songLength || (target >= 0x80 && (target & 0x7f) < otherSongLength);
        if (!ok) {
          throw new Error(`${bank.label}: pattern ${at} carries B${target.toString(16)} with no target`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The cue records
// ---------------------------------------------------------------------------

/** Reads a kind-4 record at a followed pointer as {command, position, bank}. */
function readCue(pkg, at, label) {
  if (at === null) throw new Error(`${label}: cue pointer missing`);
  const body = pkg.bodies[at.hunk];
  if (body === undefined || at.offset + 8 > body.length) {
    throw new Error(`${label}: cue record out of bounds`);
  }
  const kind = body.readUInt8(at.offset + RECORD_KIND);
  const command = body.readInt16BE(at.offset + RECORD_COMMAND);
  const position = body.readUInt16BE(at.offset + RECORD_POSITION);
  const bank = body.readUInt16BE(at.offset + RECORD_BANK);
  return { kind, command, position, bank, hunk: at.hunk, offset: at.offset };
}

function expectCue(cue, label, expect) {
  if (cue.kind !== KIND_MUSIC) throw new Error(`${label}: kind ${cue.kind}, expected 4`);
  if (expect.command !== undefined && cue.command !== expect.command) {
    throw new Error(`${label}: command ${cue.command}, expected ${expect.command}`);
  }
  if (expect.position !== undefined && cue.position !== expect.position) {
    throw new Error(`${label}: position ${cue.position}, expected ${expect.position}`);
  }
  if (expect.bank !== undefined && cue.bank !== expect.bank) {
    throw new Error(`${label}: bank ${cue.bank}, expected ${expect.bank}`);
  }
  return cue;
}

/** A record pointer at a fixed offset from the bonus routine's entry. */
function bonusCue(pkg, bonusAt, delta, label) {
  if (bonusAt === null) throw new Error(`${label}: descriptor +$80 missing`);
  return readCue(pkg, follow(pkg, bonusAt.hunk, bonusAt.offset + delta), label);
}

/**
 * The queue-main cue: the NEAREST pointer below the bonus routine's entry
 * whose target decodes to exactly {-1, pos 1, bank 0}. Found by value
 * because the layout differs between packages; requiring the exact record
 * shape keeps a coincidental pointer from qualifying.
 */
function findQueueMainCue(pkg, bonusAt, label) {
  if (bonusAt === null) throw new Error(`${label}: descriptor +$80 missing`);
  for (let delta = -2; delta >= -BONUS_SCAN_SPAN; delta -= 2) {
    const at = follow(pkg, bonusAt.hunk, bonusAt.offset + delta);
    if (at === null) continue;
    let cue;
    try {
      cue = readCue(pkg, at, label);
    } catch {
      continue;
    }
    if (cue.kind === KIND_MUSIC && cue.command === -1 && cue.position === MAIN_POSITION && cue.bank === 0) {
      return cue;
    }
  }
  throw new Error(`${label}: no {-1, pos 1, bank 0} record within ${BONUS_SCAN_SPAN} bytes below the entry`);
}

/**
 * CHECK 5 — the stop cue lands on a section that actually stops: walking the
 * order list from its position must reach an F00 before any Bxx and before
 * the order list wraps.
 */
function assertStopsWithF00(banks, cue, label) {
  const bank = banks[cue.bank];
  let position = cue.position;
  for (let guard = 0; guard < bank.orders.length + 1; guard += 1) {
    if (position >= bank.orders.length) {
      throw new Error(`${label}: ran off the order list without an F00`);
    }
    const pattern = bank.patterns[bank.orders[position]];
    for (const event of pattern) {
      if (event.effect === 0xf && event.param === 0) return;
      if (event.effect === 0xb) {
        throw new Error(`${label}: hit B${event.param.toString(16)} before any F00`);
      }
    }
    position += 1;
  }
  throw new Error(`${label}: no F00 within the order list`);
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

function toWav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(pcm.length, 40);
  const body = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) body[i] = (pcm[i] + 128) & 0xff;
  return Buffer.concat([header, body]);
}

// ---------------------------------------------------------------------------
// One table
// ---------------------------------------------------------------------------

function decodeTable(pkg, table) {
  const bank0At = descriptorPointer(pkg, HEADER_BANK_0);
  const bank1At = descriptorPointer(pkg, HEADER_BANK_1);
  if (bank0At === null || bank1At === null) {
    throw new Error(`${table.stem}: descriptor bank pointers missing`);
  }
  const raw0 = readBank(pkg, bank0At, `${table.stem} bank 0`);
  const raw1 = readBank(pkg, bank1At, `${table.stem} bank 1`);
  const banks = [raw0, raw1].map((bank) => ({
    ...bank,
    patterns: decodePatterns(bank),
  }));
  validatePatterns(banks[0], banks[0].patterns, banks[1].songLength);
  validatePatterns(banks[1], banks[1].patterns, banks[0].songLength);

  // The cues. Every expectation here is a decoded fact of all three shipped
  // tables; a package that violates one is a package this exporter does not
  // understand, and refusing is the correct output.
  const ballStart = expectCue(
    readCue(pkg, descriptorPointer(pkg, HEADER_CUE_BALL_START), `${table.stem} ball-start cue`),
    `${table.stem} ball-start cue`,
    { command: -2, position: 0, bank: 0 },
  );
  const bonusAt = descriptorPointer(pkg, HEADER_BONUS_ROUTINE);
  const queueMain = findQueueMainCue(pkg, bonusAt, `${table.stem} queue-main cue`);

  // The tilt cue must reach an F00 — silence is the tilt's penalty, and a
  // record here that does not stop the player is a record this exporter has
  // misread.
  const tilt = readCue(pkg, descriptorPointer(pkg, HEADER_CUE_TILT), `${table.stem} tilt cue`);
  if (tilt.kind !== KIND_MUSIC) throw new Error(`${table.stem} tilt cue: kind ${tilt.kind}`);
  assertStopsWithF00(banks, tilt, `${table.stem} tilt cue`);

  // Decoded but not yet driven by the runtime: the game-over and high-score
  // cues, and the bonus routine's own end-stop record. Shipped as data so
  // the next round starts from facts.
  const gameOver = readCue(pkg, descriptorPointer(pkg, HEADER_CUE_GAME_OVER), `${table.stem} game-over cue`);
  const highScore = readCue(pkg, descriptorPointer(pkg, HEADER_CUE_HIGH_SCORE), `${table.stem} high-score cue`);
  const endStop = expectCue(
    bonusCue(pkg, bonusAt, BONUS_END_STOP, `${table.stem} end-stop record`),
    `${table.stem} end-stop record`,
    { command: -2 },
  );
  assertStopsWithF00(banks, endStop, `${table.stem} end-stop record`);

  // The WAVs, one per live instrument per bank.
  const files = [];
  for (const [bankIndex, bank] of banks.entries()) {
    for (const sample of bank.samples) {
      if (sample.lengthWords === 0) continue;
      const pcm = bank.body.subarray(sample.offset, sample.offset + sample.byteLength);
      const rate = Math.round(PAL_CLOCK / WAV_PERIOD_C3);
      const wav = toWav(pcm, rate);
      files.push({
        bank: bankIndex,
        instrument: sample.index,
        file: `${table.tableId}-music-b${bankIndex}-inst${String(sample.index).padStart(2, "0")}.wav`,
        wav,
        sha256: createHash("sha256").update(wav).digest("hex"),
        byteLength: sample.byteLength,
        rate,
      });
    }
  }

  return { banks, cues: { ballStart, queueMain, tilt, gameOver, highScore, endStop }, files };
}

function cueDocument(cue) {
  return { command: cue.command, position: cue.position, bank: cue.bank };
}

function buildDocument(table, decoded) {
  return {
    schema: TABLE_MUSIC_SCHEMA,
    tableId: table.tableId,
    displayName: table.displayName,
    provenance: PROVENANCE,
    banks: decoded.banks.map((bank, index) => ({
      index,
      songLength: bank.songLength,
      restart: bank.restart,
      orders: bank.orders,
      instruments: bank.samples.map((sample) => ({
        index: sample.index,
        lengthWords: sample.lengthWords,
        finetune: sample.finetune,
        volume: sample.volume,
        repeatWords: sample.repeatWords,
        repeatLengthWords: sample.repeatLengthWords,
      })),
      patternCells: 4,
      patterns: bank.patterns.map((cells) =>
        cells.flatMap((cell) => [cell.note, cell.instrument, cell.effect, cell.param]),
      ),
    })),
    /**
     * The decoded engine cues. `vamp`, `main` and `tilt` are what the
     * runtime drives; the rest ship as decoded data for rounds that wire
     * the screens they belong to.
     */
    cues: {
      // `vamp` and `main` restate the ball-start and queue-main records under
      // the names the runtime enters them by; same decoded values.
      vamp: cueDocument(decoded.cues.ballStart),
      main: cueDocument(decoded.cues.queueMain),
      ballStart: cueDocument(decoded.cues.ballStart),
      queueMain: cueDocument(decoded.cues.queueMain),
      tilt: cueDocument(decoded.cues.tilt),
      gameOver: cueDocument(decoded.cues.gameOver),
      highScore: cueDocument(decoded.cues.highScore),
      endStop: cueDocument(decoded.cues.endStop),
    },
    samples: decoded.files.map(({ wav, ...rest }) => rest),
  };
}

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const segDir = positional[0];
  const outDir = positional[1] ?? "public/generated/tables";

  if (segDir === undefined) {
    console.error("usage: node scripts/export-table-music.mjs <segment-dir> [out-dir] [--check]");
    return 1;
  }
  if (!existsSync(segDir)) {
    console.error(`segment directory not found: ${segDir}`);
    return 1;
  }

  let failures = 0;
  for (const table of TABLES) {
    let decoded;
    try {
      decoded = decodeTable(loadPackage(segDir, table.stem), table);
    } catch (error) {
      console.error(`  ${table.tableId} music: ${error instanceof Error ? error.message : error}`);
      failures += 1;
      continue;
    }
    const json = JSON.stringify(buildDocument(table, decoded));
    const out = join(outDir, `${table.tableId}.music.json`);

    if (check) {
      const existing = existsSync(out) ? readFileSync(out, "utf8") : null;
      if (existing !== json) {
        console.error(`  ${table.tableId} music: DIFFERS from ${out}`);
        failures += 1;
      } else {
        console.log(`  ${table.tableId} music: identical to ${out}`);
      }
      for (const file of decoded.files) {
        const path = join(outDir, file.file);
        const bytes = existsSync(path) ? readFileSync(path) : null;
        if (bytes !== null && createHash("sha256").update(bytes).digest("hex") === file.sha256) continue;
        console.error(`  ${table.tableId} music: ${file.file} DIFFERS`);
        failures += 1;
      }
      continue;
    }

    mkdirSync(outDir, { recursive: true });
    writeFileSync(out, json, "utf8");
    let total = 0;
    for (const file of decoded.files) {
      writeFileSync(join(outDir, file.file), file.wav);
      total += file.wav.length;
    }
    const [b0, b1] = decoded.banks;
    console.log(
      `  ${table.tableId} music: bank0 ${b0.songLength} orders / ${b0.patterns.length} patterns, ` +
        `bank1 ${b1.songLength} / ${b1.patterns.length}, ${decoded.files.length} instrument WAVs ` +
        `(${total.toLocaleString()} bytes) -> ${out}`,
    );
    console.log(
      `               cues: ball-start -2/${decoded.cues.ballStart.position}/b${decoded.cues.ballStart.bank}, ` +
        `queue-main -1/${decoded.cues.queueMain.position}/b${decoded.cues.queueMain.bank}, ` +
        `tilt ${decoded.cues.tilt.command}/${decoded.cues.tilt.position}/b${decoded.cues.tilt.bank}, ` +
        `game-over ${decoded.cues.gameOver.command}/${decoded.cues.gameOver.position}/b${decoded.cues.gameOver.bank}, ` +
        `high-score ${decoded.cues.highScore.command}/${decoded.cues.highScore.position}/b${decoded.cues.highScore.bank}, ` +
        `end-stop ${decoded.cues.endStop.command}/${decoded.cues.endStop.position}/b${decoded.cues.endStop.bank}`,
    );
  }
  return failures > 0 ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
