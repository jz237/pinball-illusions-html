#!/usr/bin/env node
// Decodes the ENGINE'S OWN SOUND EFFECTS — the seven sounds `main.bin` plays
// itself, table-independent — into WAV files and a manifest under
// public/generated/. Run locally, where the operator's own disks live; what it
// writes is what ships.
//
// ---------------------------------------------------------------------------
// WHERE THESE LIVE, AND HOW THAT IS KNOWN
// ---------------------------------------------------------------------------
// `main.bin` hunk 10 is 184 bytes: exactly seven 26-byte sound records (layout
// identical to the table records `export-table-audio.mjs` reads — the header
// there quotes the per-frame DMA servicer at $7958 field by field) plus one pad
// word. Every record's `+$16` sample pointer relocates into hunk 11, a 27,096
// byte PCM pool with no relocations of its own. Ten `lea` operands in
// main.seg00 (at 0x45DC, 0x510C, 0x52B0, 0x5570, 0x6612, 0x7016, 0xA79C,
// 0xA7A4, 0xB254, 0xB26C) carry hunk-10 relocations, and the classification of
// each call site is the census in research/SOUND_CENSUS.md §1.2:
//
//   h10+$00  flipper reaches full raise   $A7A2/$A7C8, on the 0->FF edge of the
//            full-raise flags $23F5 (left) / $23F6 (right)
//   h10+$1A  flipper leaves full raise    $A79A, the FF->0 edge of the same flags
//   h10+$34  ball drain                   $52B4, on each ball's drained flag
//   h10+$4E  ball serve                   $45E0 (game start), $5110 (next ball),
//                                         $6616 (multiball add-a-ball)
//   h10+$68  level transfer up/down       $B258/$B270, the two handlers that
//                                         call the $53C6/$53F4 level movers
//   h10+$82  capture / lock               $5574, handler $552A, via $6CD0
//   h10+$9C  device eject, generic        $701A in the popper $6F72, for held
//                                         objects without their own eject voice
//
// The trigger ids below are those events, and `src/browser/audio.ts` maps the
// game loop's tick report onto them. Nothing here is a table sound: the three
// table packages carry their own records and their own exporter.
//
// ---------------------------------------------------------------------------
// THE CHECKS, ALL FATAL
// ---------------------------------------------------------------------------
// 1. HUNK 10 IS EXACTLY SEVEN RECORDS AND A ZERO PAD WORD. A body of any other
//    shape means the splitter or the disk is not what this decode was built on.
// 2. EVERY RECORD IS KIND 2 (plain PCM) with a ProTracker period, a volume in
//    Paula's 0..64, and no loop. The engine records use no bank instruments.
// 3. EVERY SAMPLE POINTER RELOCATES INTO HUNK 11 and the record's PCM span
//    (2 * chunk * chunks bytes) fits inside it.
// 4. THE RELOCATION TABLES PARSE TO THE BYTE on both segment files.
//
// Usage:
//   node scripts/export-engine-audio.mjs <seg-clean-dir> [out-dir] [--check]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const PREAMBLE = 4;
const RECORD_BYTES = 26;
const RECORD_COUNT = 7;
const RECORDS_HUNK = 10;
const PCM_HUNK = 11;

/** Sound record fields; the quoted instructions are in the table exporter. */
const SOUND_KIND = 0x00;
const SOUND_PRIORITY = 0x02;
const SOUND_VOLUME = 0x04;
const SOUND_PERIOD = 0x06;
const SOUND_CHUNK = 0x08;
const SOUND_CHUNKS = 0x0c;
const SOUND_LOOP = 0x0e;
const SOUND_SAMPLE = 0x16;
const KIND_SAMPLE = 2;

/** PAL colour clock over two: the divisor Paula's period counts down from. */
const PAL_CLOCK = 3546895;

const PROTRACKER_PERIODS = new Set([
  856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
  428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
  214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
]);

/**
 * The seven events, by record offset. The ORDER IS THE FILE'S OWN and the ids
 * are the call-site classification quoted in the header; changing either is a
 * decode claim and belongs in the census first.
 */
const EVENTS = [
  { offset: 0x00, id: "flipper-raise" },
  { offset: 0x1a, id: "flipper-rest" },
  { offset: 0x34, id: "drain" },
  { offset: 0x4e, id: "serve" },
  { offset: 0x68, id: "level-transfer" },
  { offset: 0x82, id: "capture" },
  { offset: 0x9c, id: "eject" },
];

const PROVENANCE = {
  sourceClass: "disk-derived-audio",
  description:
    "The engine's own seven sound effects (flipper strokes, serve, drain, level " +
    "transfer, capture, eject), decoded from main.bin hunks 10 and 11 of the " +
    "operator's own AGA floppy set, at the Paula period each sound record names.",
  authorizationRequired: true,
};

// ---------------------------------------------------------------------------
// The two segments
// ---------------------------------------------------------------------------

/**
 * Reads one `u32 length | body | relocation blocks` segment file — the same
 * shape `tabload.load` and the table exporters read, and CHECK 4 is the same:
 * the relocation blocks must consume the file exactly.
 */
function loadSegment(dir, name) {
  const path = join(dir, name);
  if (!existsSync(path)) throw new Error(`segment not found: ${path}`);
  const raw = readFileSync(path);
  const declared = raw.readUInt32BE(0);
  if (PREAMBLE + declared > raw.length) {
    throw new Error(`${path}: declares a ${declared}-byte body inside a ${raw.length}-byte file`);
  }
  const body = raw.subarray(PREAMBLE, PREAMBLE + declared);
  const relocations = new Map();
  let at = PREAMBLE + declared;
  for (;;) {
    if (at + 4 > raw.length) throw new Error(`${path}: relocation blocks run past the file`);
    const count = raw.readUInt32BE(at);
    at += 4;
    if (count === 0) break;
    const target = raw.readUInt32BE(at);
    at += 4;
    for (let i = 0; i < count; i += 1) {
      relocations.set(raw.readUInt32BE(at), target);
      at += 4;
    }
  }
  if (raw.length - at > 3) throw new Error(`${path}: relocation blocks do not consume the file`);
  return { body, relocations };
}

// ---------------------------------------------------------------------------
// WAV — identical to the table exporter's: 8-bit mono at the Paula rate,
// bytes biased by 128 and otherwise untouched.
// ---------------------------------------------------------------------------

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
// The decode
// ---------------------------------------------------------------------------

function decode(segDir) {
  const records = loadSegment(segDir, `main.bin.seg${RECORDS_HUNK}.bin`);
  const pool = loadSegment(segDir, `main.bin.seg${PCM_HUNK}.bin`);

  // CHECK 1 — seven records, one zero pad word, nothing else.
  const expected = RECORD_COUNT * RECORD_BYTES;
  if (records.body.length !== expected + 2 || records.body.readUInt16BE(expected) !== 0) {
    throw new Error(
      `main.bin hunk ${RECORDS_HUNK} is ${records.body.length} bytes; expected ${expected} ` +
        `(7 x 26-byte sound records) plus a zero pad word`,
    );
  }
  if (pool.relocations.size !== 0) {
    throw new Error(`main.bin hunk ${PCM_HUNK} carries relocations; it should be a plain PCM pool`);
  }

  const samples = [];
  const triggers = [];
  for (const [index, event] of EVENTS.entries()) {
    const at = event.offset;
    const kind = records.body.readUInt8(at + SOUND_KIND);
    const priority = records.body.readUInt16BE(at + SOUND_PRIORITY);
    const volume = records.body.readUInt16BE(at + SOUND_VOLUME);
    const period = records.body.readUInt16BE(at + SOUND_PERIOD);
    const chunk = records.body.readUInt16BE(at + SOUND_CHUNK);
    const chunks = records.body.readUInt16BE(at + SOUND_CHUNKS);
    const loop = records.body.readUInt16BE(at + SOUND_LOOP);
    const sample = records.body.readUInt32BE(at + SOUND_SAMPLE);
    const bytes = 2 * chunk * chunks;

    // CHECK 2 — a mis-read record fails the period test immediately.
    if (kind !== KIND_SAMPLE) throw new Error(`record ${event.id}: kind ${kind}, expected 2`);
    if (!PROTRACKER_PERIODS.has(period)) {
      throw new Error(`record ${event.id}: period ${period} is not a ProTracker period`);
    }
    if (volume > 64) throw new Error(`record ${event.id}: volume ${volume} is not Paula's 0..64`);
    if (loop !== 0) throw new Error(`record ${event.id}: loop ${loop}; engine records do not loop`);

    // CHECK 3 — the pointer relocates into the PCM pool and the span fits.
    if (records.relocations.get(at + SOUND_SAMPLE) !== PCM_HUNK) {
      throw new Error(`record ${event.id}: +$16 does not relocate into hunk ${PCM_HUNK}`);
    }
    if (bytes <= 0 || sample + bytes > pool.body.length) {
      throw new Error(
        `record ${event.id}: claims ${bytes} bytes at hunk ${PCM_HUNK}+${sample}, which does not ` +
          `fit in the ${pool.body.length}-byte pool`,
      );
    }

    const rate = Math.round(PAL_CLOCK / period);
    const wav = toWav(pool.body.subarray(sample, sample + bytes), rate);
    samples.push({
      index,
      file: `engine.snd-${String(index).padStart(2, "0")}.wav`,
      wav,
      sha256: createHash("sha256").update(wav).digest("hex"),
      bytes,
      rate,
      period,
      volume,
      priority,
      kind: "sample",
      milliseconds: Math.round((bytes / rate) * 1000),
      provenance: "decoded",
    });
    triggers.push({ id: event.id, sample: index });
  }
  return { samples, triggers };
}

function buildDocument(decoded) {
  return {
    schema: "pinball-illusions/engine-audio/v1",
    displayName: "Engine",
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
  const outDir = positional[1] ?? "public/generated";

  if (segDir === undefined) {
    console.error("usage: node scripts/export-engine-audio.mjs <seg-clean-dir> [out-dir] [--check]");
    return 1;
  }
  if (!existsSync(segDir)) {
    console.error(`segment directory not found: ${segDir}`);
    return 1;
  }
  if (!check) mkdirSync(outDir, { recursive: true });

  console.log(check ? "checking engine audio" : "exporting engine audio");
  let decoded;
  try {
    decoded = decode(segDir);
  } catch (error) {
    console.error(`  engine: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  const json = JSON.stringify(buildDocument(decoded));
  const out = join(outDir, "engine.audio.json");
  if (check) {
    const existing = existsSync(out) ? readFileSync(out, "utf8") : null;
    if (existing === json) {
      console.log(`  engine: identical to ${out}`);
      return 0;
    }
    console.error(`  engine: DIFFERS from ${out}`);
    return 1;
  }

  writeFileSync(out, json, "utf8");
  let total = 0;
  for (const sample of decoded.samples) {
    writeFileSync(join(outDir, sample.file), sample.wav);
    total += sample.wav.length;
  }
  console.log(
    `  engine: ${decoded.samples.length} sample(s), ${total.toLocaleString()} bytes of WAV, ` +
      `${decoded.triggers.length} binding(s) -> ${out}`,
  );
  for (const [at, sample] of decoded.samples.entries()) {
    console.log(
      `      ${String(sample.index).padStart(2)} ${decoded.triggers[at].id.padEnd(14)} ` +
        `period ${String(sample.period).padStart(3)} = ${sample.rate} Hz  ` +
        `${String(sample.bytes).padStart(6)} B  ${String(sample.milliseconds).padStart(4)} ms  ` +
        `prio ${sample.priority} vol ${sample.volume}`,
    );
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
