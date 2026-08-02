#!/usr/bin/env node
// Decodes THE FRONT-END MUSIC — the tune under the attract/credits cycle — out
// of `intro.bin` into a shipped module document and one WAV per live
// instrument, under public/generated/shell/. Run locally, where the operator's
// own disks live; what it writes is what ships.
//
// ---------------------------------------------------------------------------
// THIS FILE EXISTS BECAUSE A PROJECT RULE WAS REVERSED
// ---------------------------------------------------------------------------
// For most of this project's life the rule was: the artwork, maps, lamps, panel
// animations and sound effects ship behind the authorization gate, and the
// MUSIC does not — a wholly new composition was written to stand in for it.
// The operator has reversed that. The original module ships, decoded from his
// own disks, behind PINBALL_ILLUSIONS_DERIVED_AUTHORIZED exactly like every
// other disk-derived class. The stand-in composition has been deleted.
//
// ---------------------------------------------------------------------------
// IT USED TO READ `music001.bin`, AND THAT WAS THE WRONG MODULE
// ---------------------------------------------------------------------------
// `music001.bin` holds a real, byte-faithful `SNT!` module off Disk 3, and the
// shell (`main.seg00` +$CAE7) really does load `PROGDIR:music001.bin`. It is
// the MENU tune. It is NOT the tune the attract/credits cycle plays, and the
// attract/credits cycle is what this reconstruction's front end is.
//
// The capture settles it, and settles it by a margin. Against the continuous
// 399.6 s take in research/view/reference/session3 (48 kHz, unresampled):
//
//   * the film's music loops in EXACTLY 8077 PAL frames — waveform
//     self-correlation +0.997 at lag 8077 and below +0.04 at 8074..8080;
//   * `music001`'s order list laps in 3584 frames (71.68 s) whatever reading
//     of its cells the replayer allows, and rendered through this project's own
//     player it scores +0.0146 waveform and +0.0322 onset-envelope against the
//     take, with an envelope cross-correlation that peaks at +0.2661 against a
//     99th percentile of +0.1973 on the same curve — noise;
//   * the `SNT!` bank in `intro.bin.seg05` laps in EXACTLY 8077 frames under the
//     same rules, and the same render scores +0.7240 waveform and +0.9820
//     onset-envelope over the whole lap, at two places in the take exactly 8077
//     frames apart. That is 50x the waveform figure and 30x the envelope one.
//
// `intro.bin` carries its own second copy of the replayer (intro.seg00 +$117C
// probes for `SNT!`, +$12D2 sets the default speed 6, +$1670 wraps at 64 rows,
// +$1C82 handles F, +$1AC0 E6, +$1CA4 B, +$1C8C D) and its own copper lists,
// each with one `MOVE #$A000,INTREQ` a frame. The two banks share one sample
// outright (descriptor 9 is byte-identical) and a sound library besides, which
// is why per-instrument correlations against the film looked encouraging for
// the wrong module for as long as they did.
//
// `music001` is left on the disks and out of the build. It is the menu tune and
// deserves to ship one day; it is not this asset, and re-pointing this exporter
// back at it would restore a front end that measurably does not match the film.
//
// ---------------------------------------------------------------------------
// THE CONTAINER
// ---------------------------------------------------------------------------
// `intro.bin` is 658,938 bytes on Disk 1: a `TSL!` package (the container
// documented in docs/DISK_ANALYSIS.md, including two BSS descriptors of 512 and
// 249,600 bytes that store no payload). Descriptor 5 is hunk-wrapped pure
// data — u32 body length, body, empty relocation table — so the seg_clean split
// (`intro.bin.seg05.bin`, 260,900 bytes) is `u32 length` + a 260,892-byte body
// + 4 zero bytes, and this exporter reads that split.
//
// ---------------------------------------------------------------------------
// THE BANK: `SNT!`, DICE'S REPACKED PROTRACKER
// ---------------------------------------------------------------------------
// The body is ONE bank holding ONE song. The layout is the one the parser at
// main.seg00 $7BF8 reads — and intro.seg00's own copy reads the same — already
// proven for the in-table slot-7/8 banks by scripts/export-table-audio.mjs:
//
//     +$000 'SNT!'
//     +$004 u32  byte offset of the PCM, relative to the bank base
//     +$008 31 x { u16 length_words, u8 finetune, u8 volume,
//                  u16 repeat_words, u16 repeat_length_words }
//     +$100 u8   song length            +$101 u8 restart
//     +$102 128 x u8 order list         +$282 64 x u16 pattern offsets
//     +$302 packed pattern data
//     +$004-> sample PCM, contiguous in table order, 2*length_words each
//
// This song: 31 sample descriptors of which 28 are live (1-28, all of them
// named by the patterns and none named that is dead), song length 54, restart
// 127, 37 packed patterns filling +$302..+$46E4, and 242,732 bytes of signed
// 8-bit PCM ending 12 pad bytes short of the body.
//
// The program enters the order list at 17, plays 17 and 18 once (576 fields,
// 11.5 s) and then loops orders 19..51 forever on the `B13` at pattern 29 row
// 63; orders 0..16 are never heard and 52 and 53 are dead. That loop is the
// 8077 frames: 23 orders at F03 (64 x 3 = 4416), 9 orders at F06 (64 x 6 =
// 3456), and order 47 / pattern 35 at 205, whose row 46 carries an `F01` that
// lasts a single field and is the reason 8077 is not divisible by 6.
//
// ---------------------------------------------------------------------------
// WHY ORDER 17, AND HOW IT WAS FOUND
// ---------------------------------------------------------------------------
// The replayer takes a START POSITION in d0 ($79EA, and intro.seg00's own
// copy), so where a program enters the order list is the program's business
// and not the module's. The cold-boot take in session3
// (`coldboot-loading-into-first-credits-page-50fps-native.mkv`, 269.8 s, 48 kHz,
// unresampled) shows exactly where this one enters:
//
//   * it is DIGITALLY SILENT for 884 fields, boot fields 3380..4264, while the
//     disk loads;
//   * anchoring on the loop entry, which sits at boot field 4840.516, that
//     silence ends at order 17's first field to within half a field;
//   * order 17 then correlates +0.9389 waveform at an offset of -3 samples and
//     order 18 +0.8758 at -1, over their whole 384 and 192 fields, and the 33
//     orders of the loop follow at +0.56..+0.88;
//   * every order BEFORE 17 correlates at -0.07..+0.09 — noise — and four of
//     them sit against passages where the take is at digital zero and a render
//     from order 0 is at full level.
//
// So a start at 0 would put 90 seconds of music in front of the tune that the
// machine does not play. Two readings fit the recording equally — the loader
// starts the module at 17, or it starts it at 0 with audio DMA off and enables
// DMA at the display switch, which lands on order 17 — and they are audibly
// identical from the first sound onwards, so this ships the audible one.
//
// ---------------------------------------------------------------------------
// THE PACKED CELL ENCODING, FROM THE PLAYBACK DECODER
// ---------------------------------------------------------------------------
// main.seg00 $7F8A-$7FE6, verified bit-exact — all 37 patterns decode to
// exactly 256 cells (4 channels x 64 rows, row-major) and consume exactly their
// offset-table ranges, the last of them ending precisely on the PCM offset:
//
//   * a byte with bit 7 set is ONE WHOLE CELL: 0x80 empty, 0xC0 "repeat this
//     channel's previous event" (cached at channel state $38-$3A);
//   * bit 7 clear opens a THREE-BYTE event:
//         note       = byte0 >> 1        1-based into the 36-note period table
//         instrument = ((byte1 >> 4) << 1) | (byte0 & 1)
//         effect     = byte1 & 0xF
//         param      = byte2
//
// CHECK 3 below re-runs the tiling on every export: 37 patterns have to
// consume exactly the 17,378 bytes between +$302 and the PCM, with 36 interior
// boundaries landing on the offset table's own words.
//
// ---------------------------------------------------------------------------
// WHAT THIS SHIPS, AND WHY IT IS NOT A `.mod`
// ---------------------------------------------------------------------------
//   shell-music.json          the decoded module as a document: order list,
//                             patterns as typed cell arrays, the 31 sample
//                             descriptors, and a samples[] array of
//                             {file, sha256, byteLength} for the live PCM.
//   shell-music-inst NN .wav  one 8-bit mono RIFF/WAVE per live instrument at
//                             the PAL rate its finetuned C-3 period asks for
//                             (3546895 / period), bytes biased by 128 and
//                             nothing else touched — the same convention
//                             export-table-audio.mjs already uses.
//
// `FORBIDDEN_EXT` in check-public-build.mjs contains `.mod`, so a raw module
// file can never ship, and that stays true: what ships is a decoded document
// plus digest-claimed WAVs, under the `disk-derived-shell-music` class.
//
// Usage:
//   node scripts/export-shell-music.mjs <segment-dir> [out-dir] [--check]
//
// <segment-dir> holds intro.bin.seg05.bin. --check decodes and compares
// against what is already in <out-dir> without writing.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Each seg_clean file is a 4-byte big-endian body length, then the body. */
const PREAMBLE = 4;

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

/** Paula's PAL master clock. rate = PAL_CLOCK / period. */
const PAL_CLOCK = 3546895;

/**
 * ft0 of the 16 x 36 period table at main.seg00 $A198. Only row 0 is needed
 * here: the WAV rate is a naming convention for the file, and the PLAYER does
 * the finetuned lookup at runtime from the descriptor this document ships.
 */
const PERIOD_FT0 = [
  856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
  428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
  214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
];
/** C-3, note index 25 of 36 — the rate every WAV is written at. */
const WAV_NOTE_INDEX = 24;

const PROVENANCE = {
  sourceClass: "disk-derived-shell-music",
  description:
    "The front-end module decoded from the SNT! bank in intro.bin on the " +
    "operator's own AGA floppy set: the order list, the 37 packed patterns and " +
    "the 28 live PCM instruments, as a document plus one WAV each. Nothing is " +
    "resampled, normalised or faded.",
  authorizationRequired: true,
};

/** The seg_clean split this reads, and the bank inside it. */
const SEGMENT_FILE = "intro.bin.seg05.bin";
const MODULE = "intro.seg05";

/**
 * The order position the PROGRAM enters this module at — a playback parameter,
 * measured off the cold-boot take, not a field of the bank. See the header.
 * The exporter checks it against the decode rather than merely asserting it.
 */
const START_ORDER = 17;

/**
 * The PCM stops short of the body by a few pad bytes. `music001` carried 2;
 * this bank carries 12 of the 260,892. The budget is 16 — enough for the
 * alignment slack a packer leaves, far too little to hide a second bank.
 */
const MAX_TRAILING_PAD = 16;

// ---------------------------------------------------------------------------
// The bank
// ---------------------------------------------------------------------------

function loadBody(segDir) {
  const path = join(segDir, SEGMENT_FILE);
  if (!existsSync(path)) throw new Error(`not found: ${path}`);
  const raw = readFileSync(path);
  const declared = raw.readUInt32BE(0);
  if (PREAMBLE + declared > raw.length) {
    throw new Error(`${path}: declares a ${declared}-byte body inside a ${raw.length}-byte file`);
  }
  return raw.subarray(PREAMBLE, PREAMBLE + declared);
}

/**
 * CHECK 1 — the magic, and a sample directory whose PCM ends inside the body.
 *
 * The directory is cumulative: sample n starts where sample n-1 ended, from the
 * bank's declared PCM offset. If any length word were misread the running total
 * would miss the end of the body, which is the check that catches a wrong
 * entry stride or a wrong base.
 */
function readBank(body) {
  if (body.length < 0x400 || body.toString("latin1", 0, 4) !== "SNT!") {
    throw new Error(`${MODULE} does not begin with SNT!`);
  }
  const pcmAt = body.readUInt32BE(BANK_PCM_OFFSET);
  const samples = [];
  let cursor = pcmAt;
  for (let i = 0; i < BANK_SAMPLES; i += 1) {
    const entry = BANK_DIRECTORY + BANK_SAMPLE_ENTRY * i;
    const lengthWords = body.readUInt16BE(entry);
    samples.push({
      index: i + 1,
      lengthWords,
      finetune: body.readInt8(entry + 2),
      volume: body.readUInt8(entry + 3),
      repeatWords: body.readUInt16BE(entry + 4),
      repeatLengthWords: body.readUInt16BE(entry + 6),
      offset: cursor,
      byteLength: lengthWords * 2,
    });
    cursor += lengthWords * 2;
  }
  if (cursor > body.length) {
    throw new Error(
      `${MODULE}: the sample directory declares PCM ending at ${cursor}, past the ` +
        `${body.length}-byte body`,
    );
  }
  if (body.length - cursor > MAX_TRAILING_PAD) {
    throw new Error(
      `${MODULE}: ${body.length - cursor} bytes of slack after the PCM; the decode allows at ` +
        `most ${MAX_TRAILING_PAD} pad bytes`,
    );
  }

  const songLength = body.readUInt8(BANK_SONG_LENGTH);
  const restart = body.readUInt8(BANK_RESTART);
  const orders = [];
  for (let i = 0; i < BANK_ORDER_SLOTS; i += 1) orders.push(body.readUInt8(BANK_ORDERS + i));
  const patternOffsets = [];
  for (let i = 0; i < BANK_PATTERN_SLOTS; i += 1) {
    patternOffsets.push(body.readUInt16BE(BANK_PATTERN_OFFSETS + 2 * i));
  }
  return { pcmAt, samples, songLength, restart, orders, patternOffsets };
}

/**
 * One packed pattern, and CHECK 2 — every high byte is one of the two the
 * decoder knows.
 *
 * `0xC0` repeats the channel's previous event, which is per channel and NOT per
 * cell: the cache lives in the channel state at $38-$3A, so a repeat on channel
 * 2 reaches back to channel 2's last event however many rows ago that was.
 */
function decodePattern(body, base) {
  const cells = [];
  const previous = [null, null, null, null];
  let at = base;
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
            `${MODULE}: unknown whole-cell byte 0x${byte0.toString(16)} at ${at - 1} ` +
              `(pattern base ${base}, row ${row}, channel ${channel})`,
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
 * CHECK 3 — the patterns TILE. Each one consumes exactly the bytes between its
 * own offset and the next, and the last ends exactly on the PCM offset.
 *
 * This is the check that makes the 64-row, 4-channel, row-major reading a
 * measurement rather than an assumption. Ten independent boundaries have to
 * land, and a wrong row count misses the first of them.
 */
function decodePatterns(body, bank) {
  const count = Math.max(...bank.orders.slice(0, bank.songLength)) + 1;
  const patterns = [];
  for (let index = 0; index < count; index += 1) {
    const base = BANK_PATTERN_DATA + bank.patternOffsets[index];
    const { cells, end } = decodePattern(body, base);
    const next =
      index + 1 < count ? BANK_PATTERN_DATA + bank.patternOffsets[index + 1] : bank.pcmAt;
    if (end !== next) {
      throw new Error(
        `${MODULE}: pattern ${index} decoded to ${end} but the next boundary is ${next} ` +
          `(off by ${next - end})`,
      );
    }
    patterns.push(cells);
  }
  return patterns;
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

/** 8-bit mono RIFF/WAVE at the Paula rate, biased by 128 and nothing else. */
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
// The document
// ---------------------------------------------------------------------------

function decode(segDir) {
  const body = loadBody(segDir);
  const bank = readBank(body);
  const patterns = decodePatterns(body, bank);

  const live = bank.samples.filter((sample) => sample.lengthWords > 0);
  const files = [];
  for (const sample of live) {
    const pcm = body.subarray(sample.offset, sample.offset + sample.byteLength);
    const period = PERIOD_FT0[WAV_NOTE_INDEX];
    const rate = Math.round(PAL_CLOCK / period);
    const wav = toWav(pcm, rate);
    files.push({
      instrument: sample.index,
      file: `shell-music-inst${String(sample.index).padStart(2, "0")}.wav`,
      wav,
      sha256: createHash("sha256").update(wav).digest("hex"),
      byteLength: pcm.length,
      rate,
    });
  }

  // CHECK 4 — every instrument the patterns name is one of the live samples. A
  // note on an empty descriptor would be silence at runtime and a decode error
  // here, which is where it belongs.
  const liveIndices = new Set(live.map((sample) => sample.index));
  for (const [at, cells] of patterns.entries()) {
    for (const [cell, event] of cells.entries()) {
      if (event.instrument !== 0 && !liveIndices.has(event.instrument)) {
        throw new Error(
          `${MODULE}: pattern ${at} cell ${cell} names instrument ${event.instrument}, ` +
            `which has no PCM`,
        );
      }
      if (event.note > 36) {
        throw new Error(`${MODULE}: pattern ${at} cell ${cell} has note ${event.note} > 36`);
      }
    }
  }

  // CHECK 5 — the start position names a real order, and the loop the `B13`
  // makes is reachable from it. A start order past the jump target would ship a
  // tune that never enters its own loop.
  if (START_ORDER < 0 || START_ORDER >= bank.songLength) {
    throw new Error(
      `${MODULE}: start order ${START_ORDER} is outside the ${bank.songLength}-order list`,
    );
  }
  const jumps = [];
  for (const [at, cells] of patterns.entries()) {
    for (const [cell, event] of cells.entries()) {
      if (event.effect === 0xb) jumps.push({ pattern: at, row: Math.floor(cell / CHANNELS), to: event.param });
    }
  }
  if (jumps.length !== 1) {
    throw new Error(`${MODULE}: expected exactly one Bxx, found ${jumps.length}`);
  }
  const loopEntry = jumps[0].to;
  if (loopEntry < START_ORDER || loopEntry >= bank.songLength) {
    throw new Error(
      `${MODULE}: the B${loopEntry.toString(16)} loops to order ${loopEntry}, which a start ` +
        `at ${START_ORDER} never reaches`,
    );
  }

  return { bank, patterns, live, files, loopEntry, jump: jumps[0] };
}

function buildDocument(decoded) {
  return {
    schema: "pinball-illusions/shell-music/v1",
    provenance: PROVENANCE,
    // The module, as the bank stores it.
    songLength: decoded.bank.songLength,
    restart: decoded.bank.restart,
    orders: decoded.bank.orders.slice(0, decoded.bank.songLength),
    // The one thing here that is NOT a field of the bank: where the program
    // enters the order list. Measured off the cold-boot take; see the header.
    startOrder: START_ORDER,
    // 31 descriptors, live or not: the player indexes them by the instrument
    // number in a cell, and a sparse array would make that a search.
    instruments: decoded.bank.samples.map((sample) => ({
      index: sample.index,
      lengthWords: sample.lengthWords,
      finetune: sample.finetune,
      volume: sample.volume,
      repeatWords: sample.repeatWords,
      repeatLengthWords: sample.repeatLengthWords,
    })),
    // 4 numbers a cell, row-major, 1024 per pattern. Flat because a document
    // of 37 x 64 x 4 objects is 40x the bytes for the same information.
    patternCells: 4,
    patterns: decoded.patterns.map((cells) =>
      cells.flatMap((cell) => [cell.note, cell.instrument, cell.effect, cell.param]),
    ),
    samples: decoded.files.map(({ wav, ...rest }) => rest),
  };
}

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const segDir = positional[0];
  const outDir = positional[1] ?? "public/generated/shell";

  if (segDir === undefined) {
    console.error("usage: node scripts/export-shell-music.mjs <segment-dir> [out-dir] [--check]");
    return 1;
  }
  if (!existsSync(segDir)) {
    console.error(`segment directory not found: ${segDir}`);
    return 1;
  }

  let decoded;
  try {
    decoded = decode(segDir);
  } catch (error) {
    console.error(`  shell music: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  const json = JSON.stringify(buildDocument(decoded));
  const out = join(outDir, "shell-music.json");

  if (check) {
    let failures = 0;
    const existing = existsSync(out) ? readFileSync(out, "utf8") : null;
    if (existing === json) console.log(`  shell music: identical to ${out}`);
    else {
      console.error(`  shell music: DIFFERS from ${out}`);
      failures += 1;
    }
    for (const file of decoded.files) {
      const path = join(outDir, file.file);
      const bytes = existsSync(path) ? readFileSync(path) : null;
      if (bytes !== null && createHash("sha256").update(bytes).digest("hex") === file.sha256) {
        continue;
      }
      console.error(`  shell music: ${file.file} DIFFERS`);
      failures += 1;
    }
    return failures > 0 ? 1 : 0;
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(out, json, "utf8");
  let total = 0;
  for (const file of decoded.files) {
    writeFileSync(join(outDir, file.file), file.wav);
    total += file.wav.length;
  }
  console.log(
    `  shell music: song length ${decoded.bank.songLength}, restart ${decoded.bank.restart}, ` +
      `${decoded.patterns.length} pattern(s), ${decoded.files.length} instrument(s), ` +
      `${total.toLocaleString()} bytes of WAV -> ${out}`,
  );
  console.log(`               orders [${decoded.bank.orders.slice(0, decoded.bank.songLength)}]`);
  // The order the jump actually fires from: the first use of its pattern at or
  // after the loop entry. Everything past it is unreachable.
  const orders = decoded.bank.orders.slice(0, decoded.bank.songLength);
  const fires = orders.indexOf(decoded.jump.pattern, decoded.loopEntry);
  console.log(
    `               enters at order ${START_ORDER}; pattern ${decoded.jump.pattern} row ` +
      `${decoded.jump.row} carries B${decoded.loopEntry.toString(16).padStart(2, "0")}, so the ` +
      `loop is orders ${decoded.loopEntry}..${fires} and ${decoded.bank.songLength - 1 - fires} ` +
      `order(s) past it are dead`,
  );
  for (const sample of decoded.live) {
    console.log(
      `               #${String(sample.index).padStart(2)} ${String(sample.byteLength).padStart(6)} B  ` +
        `ft ${String(sample.finetune).padStart(2)}  vol ${String(sample.volume).padStart(2)}  ` +
        (sample.repeatLengthWords > 1
          ? `loop ${sample.repeatWords * 2}..${(sample.repeatWords + sample.repeatLengthWords) * 2}`
          : "one-shot"),
    );
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
