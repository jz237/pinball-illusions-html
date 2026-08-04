// Decodes the INTRO ANIMATION out of `intro.bin` into the shipped asset set
// under public/generated/shell/intro/. Run locally, where the operator's own
// disks live; the two binary blocks and the manifest it writes are what ship.
// Sibling of scripts/export-loading-logo.mjs (the other pre-shell screen) and
// scripts/export-shell-music.mjs (which reads the SAME seg_clean split of the
// SAME file for its seg05 music bank).
//
// Usage:  node scripts/export-intro.mjs <segment-dir> [out-dir] [--check]
//   <segment-dir> holds the seg_clean split of intro.bin
//   (`intro.bin.seg00.bin` .. `intro.bin.seg05.bin`, each `u32 body length` +
//   body + relocation blocks). --check decodes and compares against the files
//   already in <out-dir> without writing.
//
// ---------------------------------------------------------------------------
// WHAT SHIPS, AND WHY THIS PACKING
// ---------------------------------------------------------------------------
// The intro is a timed script over exactly three kinds of material, all of it
// in `intro.bin` (the "$VER: Pinball Illusions INTRO (AGA)" TSL! package on
// disk 1; the full derivation is research/INTRO_DECODE.md, and
// research/intro/render.py is the frame-accurate reference implementation this
// exporter and the player mirror):
//
//   seg01  486,704 B  DATA: the h1 palette block (0x000..0x1BF) followed by
//                     the FOURTEEN packed image streams, back to back — the
//                     176-frame text animation, the purple backdrop, the five
//                     HAM8/256-colour stills, the credits clouds and the six
//                     credits overlays. Ships VERBATIM as intro-data.bin.
//   seg02    7,256 B  the eight copper lists (display formats, palettes and
//                     plane-pointer slots). Ships VERBATIM as intro-copper.bin.
//   seg00   13,000 B  the player CODE. Never ships. What the player needs from
//                     it — the 193-entry (frame, handler) script and the twelve
//                     palette-fade tables — is extracted here into the JSON
//                     manifest, reduced to plain offsets and numbers.
//
// Shipping the packed streams as they are was measured, not assumed: the five
// stills re-encoded as PNGs (research/view/intro/assets/) total 418,911 bytes
// against 351,428 packed, because HAM8 photographs do not deflate well. The
// whole show therefore ships in ~494 KB — the size of the source data hunk —
// and the player carries the three-opcode unpacker instead of a PNG pipeline.
//
// The packed format ("FreeAnim", unpacker at intro.seg00+0x770) is three
// opcodes: `u16 N` then N+1 groups of { 0x00: u16 skip -> dst += skip;
// 0x80|k: copy (k&0x7F)+1 literal bytes; 0x01..0x7F: repeat next byte c
// times }. This exporter WALKS every stream with that unpacker and refuses to
// export unless each one ends exactly where the next begins and writes exactly
// the byte count the display format demands — the same self-checking argument
// as export-table-accel.mjs's "shaped like a ramp drive" gates.
//
// ---------------------------------------------------------------------------
// THE SCRIPT AND THE FADE TABLES, AND HOW THEIR NUMBERS ARE TRUSTED
// ---------------------------------------------------------------------------
// The script at seg00+0x868 is 193 big-endian (u16 frame, u16 routine) pairs;
// dispatch is `jmp (a5,d0.w)` with a5 = h0-4, so handler = h0 + routine - 4.
// The handler set and each handler's constants (which stream, which plane
// slots, which fade table, which copper list) are decoded facts cited to the
// disassembly in research/INTRO_DECODE.md §3; this exporter re-reads the
// script from the bytes, asserts the handler set is EXACTLY the decoded one
// (193 entries, 176 of them the text-animation step, ending in the exit at
// t=2892), and cross-checks every constant it emits against the material it
// names — a still handler must point at a stream that unpacks to its list's
// exact pixel count, a fade table must step palette words that lie inside its
// target copper list.
//
// A fade table (fader at seg00+0x7AE, instant-set at +0x7D8) is
// `u16 repeats, u16 wait`, then 12-byte quads (u32 src, u32 dst, u16 step,
// u16 count-1) to a zero terminator. The src and dst longwords are RELOCATED
// pointers in the original; seg_clean stores the unrelocated file, so the
// stored values are already plain offsets — and the relocation blocks say
// which hunk each one meant. Every src must relocate into h1 (the palette
// block) and every dst into h2 (a copper list palette slot), and this exporter
// checks the relocation target of every longword it extracts rather than
// assuming it.
//
// Nothing else of seg00 is used, and nothing executable ships.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Layout constants. These ARE the decode; see the header and INTRO_DECODE.md.
// ---------------------------------------------------------------------------

const SEG_PREFIX = "intro.bin.seg";

/** Segment body sizes, checked before anything is read out of them. */
const SEG00_BYTES = 13_000;
const SEG01_BYTES = 486_704;
const SEG02_BYTES = 7_256;

/** The screen-memory hunk (h4): BSS, so it exists only as this size. */
const H4_BYTES = 249_600;

/** The h1 palette block: everything below this offset is fade-source words. */
const PALETTE_BLOCK_END = 0x1c0;

/** The script: 193 pairs at seg00+0x868, ending in the exit handler. */
const SCRIPT_AT = 0x868;
const SCRIPT_ENTRIES = 193;
const SCRIPT_END_T = 2892;
const ANIM_ENTRIES = 176;

/** Handler offsets (h0 + routine - 4), the full decoded set. */
const OP_INT_ENABLE = 0x26a;
const OP_ANIM = 0x274;
const OP_CREDITS = 0x2b8;
const OP_BACKDROP_A = 0x46a;
const OP_BACKDROP_B = 0x4d6;
const OP_BACKDROP_C = 0x542;
const OP_STILL_DREAMS = 0x5ae;
const OP_STILL_FANTASIES = 0x5f6;
const OP_STILL_ILLUSIONS = 0x63e;
const OP_STILL_21ST = 0x686;
const OP_STILL_DI = 0x6ce;
const OP_TEXT_FADE_OUT = 0x716;
const OP_TEXT_FADE_IN = 0x722;
const OP_TEXT_SET = 0x72e;
const OP_EXIT = 0x1ce;

const KNOWN_OPS = new Set([
  OP_INT_ENABLE, OP_ANIM, OP_CREDITS,
  OP_BACKDROP_A, OP_BACKDROP_B, OP_BACKDROP_C,
  OP_STILL_DREAMS, OP_STILL_FANTASIES, OP_STILL_ILLUSIONS, OP_STILL_21ST, OP_STILL_DI,
  OP_TEXT_FADE_OUT, OP_TEXT_FADE_IN, OP_TEXT_SET, OP_EXIT,
]);

/** The twelve fade/set tables in seg00, by offset. See research/intro/fades.txt. */
const FADE_TABLES = [
  0x0b6c, // credits: every bank white, applied instantly (the filmed flash)
  0x0c4c, // credits: everything to black (the exit)
  0x0d2c, // credits: clouds only (both overlays' banks painted as clouds)
  0x0e0c, // credits: overlay A's letter shades in, B hidden
  0x0ed4, // credits: overlay B in, A hidden (the crossfade)
  0x0f9c, // text scene in from black (backdrop ramp from [1])
  0x0fe0, // text scene in, variant
  0x1024, // text scene in with colour 0 rising too ("PRESENTS over faint clouds")
  0x1074, // current screen to white ahead of a 120-row still
  0x10b8, // current screen to white ahead of a full-height still (21st / DI)
  0x1108, // text banks to the backdrop ramp (letters hidden)
  0x1134, // text banks to their shades (letters shown)
];

/**
 * The packed streams in h1, in file order. `unpacked` is the byte count the
 * display format demands (width/8 * rows * planes); the text animation is 176
 * chained delta frames over a 0x2580-byte canvas instead of one image.
 */
const STREAMS = [
  { name: "text-anim", at: 0x001c0, frames: ANIM_ENTRIES, canvas: 0x2580 },
  { name: "credits-clouds", at: 0x1325c, unpacked: 38_400 }, // 4 bpl 640x120
  { name: "backdrop", at: 0x18654, unpacked: 24_000 }, // 5 bpl 320x120
  { name: "still-dreams", at: 0x1d054, unpacked: 76_800 }, // HAM8 640x120
  { name: "still-fantasies", at: 0x2cf0e, unpacked: 76_800 },
  { name: "still-illusions", at: 0x3e868, unpacked: 76_800 },
  { name: "still-21st", at: 0x4fd40, unpacked: 128_640 }, // 8 bpl 640x201
  { name: "still-di", at: 0x61c86, unpacked: 76_800 }, // HAM8 320x240
  { name: "credits-page1", at: 0x72d18, unpacked: 19_200 }, // 2 bpl 640x120
  { name: "credits-page2", at: 0x738c0, unpacked: 19_200 },
  { name: "credits-page3", at: 0x74323, unpacked: 19_200 },
  { name: "credits-page4", at: 0x74d58, unpacked: 19_200 },
  { name: "credits-page5", at: 0x75886, unpacked: 19_200 },
  { name: "credits-page6", at: 0x762b5, unpacked: 19_200 },
];

/**
 * The eight copper lists in h2 and how each one's band rasterises — start
 * offset, resolution, HAM, plane count, and where its rows sit on the 640x240
 * reference canvas (y0 = the list's first WAIT line minus the PAL window top
 * 0x2C). Read off the lists themselves in research/intro/coppers.txt.
 */
const LISTS = [
  { at: 0x0000, kind: "blank" },
  { at: 0x0010, kind: "planar", hires: false, ham: false, planes: 7, y0: 32, rows: 120 },
  { at: 0x02e8, kind: "planar", hires: true, ham: true, planes: 8, y0: 32, rows: 120 },
  { at: 0x05c4, kind: "planar", hires: true, ham: true, planes: 8, y0: 32, rows: 120 },
  { at: 0x08a0, kind: "planar", hires: true, ham: false, planes: 8, y0: 6, rows: 201 },
  { at: 0x11ac, kind: "planar", hires: false, ham: true, planes: 8, y0: 0, rows: 240 },
  { at: 0x148c, kind: "planar", hires: true, ham: false, planes: 8, y0: 32, rows: 120 },
  { at: 0x197c, kind: "planar", hires: true, ham: true, planes: 8, y0: 32, rows: 120 },
];

/**
 * Per-handler constants, cited to the disassembly (INTRO_DECODE.md §3) and
 * cross-checked below: a still's stream must unpack to `stride * rows(list)`
 * exactly, its plane-pointer slot must sit inside its list, and its fade table
 * must exist. The player is entirely table-driven off this block.
 */
const BACKDROP_HANDLERS = [
  { op: OP_BACKDROP_A, fade: 0x0f9c },
  { op: OP_BACKDROP_B, fade: 0x0fe0 },
  { op: OP_BACKDROP_C, fade: 0x1024 },
];

const STILL_HANDLERS = [
  { op: OP_STILL_DREAMS, stream: "still-dreams", slot: 0x035a, stride: 0x2580, fade: 0x1074, list: 0x02e8 },
  { op: OP_STILL_FANTASIES, stream: "still-fantasies", slot: 0x0636, stride: 0x2580, fade: 0x1074, list: 0x05c4 },
  { op: OP_STILL_ILLUSIONS, stream: "still-illusions", slot: 0x19ee, stride: 0x2580, fade: 0x1074, list: 0x197c },
  { op: OP_STILL_21ST, stream: "still-21st", slot: 0x0912, stride: 0x3ed0, fade: 0x10b8, list: 0x08a0 },
  { op: OP_STILL_DI, stream: "still-di", slot: 0x121e, stride: 0x2580, fade: 0x10b8, list: 0x11ac },
];

const TEXT_FADE_HANDLERS = [
  { op: OP_TEXT_FADE_OUT, fade: 0x1108, set: false },
  { op: OP_TEXT_FADE_IN, fade: 0x1134, set: false },
  { op: OP_TEXT_SET, fade: 0x1134, set: true },
];

/** The text-animation double buffer and scene plumbing (h4 offsets, h2 slots). */
const ANIM = {
  bufA: 0x2580, // seg00+0x84C initial: the hidden buffer
  bufB: 0x0000, // seg00+0x850 initial: the shown buffer
  size: 0x2580, // two planes x 0x12C0
  planeStride: 0x12c0,
  textSlot: 0x12e, // BPL6/7 pointer slots in the text list
};

const BACKDROP = {
  stream: "backdrop",
  dst: 0x4b00,
  slot: 0x106, // BPL1..5 pointer slots in the text list
  planes: 5,
  planeStride: 0x12c0,
  list: 0x0010,
};

const STILL_DST = 0xe100;

/** The credits choreography (the one blocking handler, seg00+0x2B8). */
const CREDITS = {
  clouds: { stream: "credits-clouds", dst: 0x4b00, slot: 0x14fe, planes: 4, planeStride: 0x2580 },
  overlayA: { dst: 0x33900, slot: 0x151e, planes: 2, planeStride: 0x2580 },
  overlayB: { dst: 0x38400, slot: 0x152e, planes: 2, planeStride: 0x2580 },
  pages: ["credits-page1", "credits-page2", "credits-page3", "credits-page4", "credits-page5", "credits-page6"],
  list: 0x148c,
  whiteSet: 0x0b6c,
  cloudsFade: 0x0d2c,
  showA: 0x0e0c,
  showB: 0x0ed4,
  blackFade: 0x0c4c,
  firstWait: 0xb9, // frames before page 1 (once)
  pageWait: 0xaf, // frames between every later fade
};

const MANIFEST_SCHEMA = "pinball-illusions/intro/v1";
const MANIFEST_FILE = "intro.json";
const DATA_FILE = "intro-data.bin";
const COPPER_FILE = "intro-copper.bin";

// A class of its own: this comes out of `intro.bin`, not out of menudata.bin
// or the loader, and a provenance block should say so. check-public-build.mjs
// keys off `sourceClass`, gates the class behind the same authorization
// variable as every other disk-derived class, and digest-verifies both binary
// blocks through the `data` claims below.
const PROVENANCE = {
  sourceClass: "disk-derived-intro",
  description:
    "The boot intro animation decoded from `intro.bin` on the operator's own AGA floppy " +
    "set: the packed image streams and palettes (seg01, verbatim), the eight copper lists " +
    "(seg02, verbatim), and the player's timed script and palette-fade tables reduced to " +
    "plain numbers. Functional presentation data only — no executable code ships, and the " +
    "music is not here (the intro plays the already-shipped front-end bank).",
  authorizationRequired: true,
};

// ---------------------------------------------------------------------------
// seg_clean segments
// ---------------------------------------------------------------------------

/**
 * One split segment: `u32 body length`, body, then relocation blocks
 * (`u32 count, u32 target hunk, count x u32 offset`) to a zero terminator.
 * Returns the body and a map of longword offset -> target hunk, so a caller
 * can ask what any stored pointer MEANT without applying bases to it.
 */
function readSegment(dir, index, expectedBytes) {
  const path = join(dir, `${SEG_PREFIX}${String(index).padStart(2, "0")}.bin`);
  if (!existsSync(path)) throw new Error(`segment not found: ${path}`);
  const raw = readFileSync(path);
  const length = raw.readUInt32BE(0);
  if (length !== expectedBytes) {
    throw new Error(`${path}: body is ${length} bytes, expected ${expectedBytes}`);
  }
  const body = raw.subarray(4, 4 + length);
  const relocs = new Map();
  let at = 4 + length;
  for (;;) {
    if (at + 4 > raw.length) throw new Error(`${path}: relocation table runs off the file`);
    const count = raw.readUInt32BE(at);
    at += 4;
    if (count === 0) break;
    const target = raw.readUInt32BE(at);
    at += 4;
    for (let i = 0; i < count; i += 1) {
      relocs.set(raw.readUInt32BE(at), target);
      at += 4;
    }
  }
  return { body, relocs };
}

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

function readScript(seg00) {
  const script = [];
  let at = SCRIPT_AT;
  const opCounts = new Map();
  for (;;) {
    const t = seg00.readUInt16BE(at);
    const op = seg00.readUInt16BE(at + 2) - 4;
    at += 4;
    if (!KNOWN_OPS.has(op)) {
      throw new Error(`script entry ${script.length} names unknown handler 0x${op.toString(16)}`);
    }
    // NOT monotonicity-checked: the times are deliberately allowed to run
    // BACKWARDS after a blocking handler. The main loop dispatches at most one
    // due entry per frame, and a fade or the credits choreography burns frames
    // internally, after which every past-due entry fires on consecutive frames
    // — e.g. the entries behind the gag card are dated before the "OR IN
    // SHORT" hold that precedes them. Only the range is checked.
    if (t < 1 || t > SCRIPT_END_T) {
      throw new Error(`script entry ${script.length} is timed at ${t}, outside 1..${SCRIPT_END_T}`);
    }
    script.push([t, op]);
    opCounts.set(op, (opCounts.get(op) ?? 0) + 1);
    if (op === OP_EXIT) break;
    if (script.length > SCRIPT_ENTRIES) throw new Error("script runs past its decoded length");
  }
  if (script.length !== SCRIPT_ENTRIES) {
    throw new Error(`script is ${script.length} entries, expected ${SCRIPT_ENTRIES}`);
  }
  const [firstT, firstOp] = script[0];
  if (firstT !== 1 || firstOp !== OP_INT_ENABLE) {
    throw new Error(`script opens (${firstT}, 0x${firstOp.toString(16)}), expected (1, 0x26A)`);
  }
  const [lastT] = script[script.length - 1];
  if (lastT !== SCRIPT_END_T) {
    throw new Error(`script exits at t=${lastT}, expected ${SCRIPT_END_T}`);
  }
  if ((opCounts.get(OP_ANIM) ?? 0) !== ANIM_ENTRIES) {
    throw new Error(`script steps the text animation ${opCounts.get(OP_ANIM) ?? 0} times, expected ${ANIM_ENTRIES}`);
  }
  // The end of the script is the first fade table; a parse that drifted a word
  // would land somewhere else.
  if (SCRIPT_AT + SCRIPT_ENTRIES * 4 !== FADE_TABLES[0]) {
    throw new Error("script does not end exactly at the first fade table");
  }
  return script;
}

// ---------------------------------------------------------------------------
// The fade tables
// ---------------------------------------------------------------------------

function readFadeTable(seg00, relocs, at) {
  const repeats = seg00.readUInt16BE(at);
  const wait = seg00.readUInt16BE(at + 2);
  if (repeats !== 16) throw new Error(`fade table 0x${at.toString(16)}: repeats is ${repeats}, expected 16`);
  const quads = [];
  let offset = at + 4;
  for (;;) {
    // The terminator is a LITERAL zero longword. A quad's src longword can
    // ALSO read as zero here, because seg_clean stores unrelocated values and
    // `h1+0x0` (the black palette, the fade-to-black source) is stored as 0 —
    // what tells the two apart is the relocation table, where every real src
    // has an entry and the terminator has none.
    if (!relocs.has(offset)) {
      if (seg00.readUInt32BE(offset) !== 0) {
        throw new Error(`fade table 0x${at.toString(16)}: unrelocated non-zero longword at 0x${offset.toString(16)}`);
      }
      break;
    }
    const src = seg00.readUInt32BE(offset);
    const dst = seg00.readUInt32BE(offset + 4);
    const step = seg00.readUInt16BE(offset + 8);
    const count = seg00.readUInt16BE(offset + 10) + 1;
    if (relocs.get(offset) !== 1) {
      throw new Error(`fade table 0x${at.toString(16)}: src at 0x${offset.toString(16)} does not relocate into h1`);
    }
    if (relocs.get(offset + 4) !== 2) {
      throw new Error(`fade table 0x${at.toString(16)}: dst at 0x${(offset + 4).toString(16)} does not relocate into h2`);
    }
    if (step !== 4) throw new Error(`fade table 0x${at.toString(16)}: step is ${step}, expected 4`);
    if (src + 2 * count > PALETTE_BLOCK_END) {
      throw new Error(`fade table 0x${at.toString(16)}: src run 0x${src.toString(16)}+${count} leaves the palette block`);
    }
    if (dst + step * count > SEG02_BYTES) {
      throw new Error(`fade table 0x${at.toString(16)}: dst run leaves the copper segment`);
    }
    quads.push([src, dst, step, count]);
    offset += 12;
  }
  if (quads.length === 0) throw new Error(`fade table 0x${at.toString(16)} is empty`);
  return { at, repeats, wait, quads };
}

// ---------------------------------------------------------------------------
// The unpacker, used here as a verifier
// ---------------------------------------------------------------------------

/**
 * Walks one packed frame, returning where it ended and what it did. Bounds are
 * hard errors: the streams tile the segment exactly, so any overrun means the
 * directory above is wrong and nothing should ship.
 */
function walkFrame(h1, at) {
  let src = at;
  const groups = h1.readUInt16BE(src) + 1;
  src += 2;
  let written = 0;
  let skipped = 0;
  let highest = 0;
  for (let group = 0; group < groups; group += 1) {
    if (src >= h1.length) throw new Error(`stream at 0x${at.toString(16)} runs off the segment`);
    const control = h1[src];
    src += 1;
    if (control === 0) {
      skipped += h1.readUInt16BE(src);
      src += 2;
    } else if ((control & 0x80) !== 0) {
      const run = (control & 0x7f) + 1;
      src += run;
      written += run;
    } else {
      src += 1;
      written += control;
    }
    if (written + skipped > highest) highest = written + skipped;
  }
  if (src > h1.length) throw new Error(`stream at 0x${at.toString(16)} runs off the segment`);
  return { end: src, written, skipped, highest };
}

function verifyStreams(h1) {
  const directory = [];
  for (let index = 0; index < STREAMS.length; index += 1) {
    const stream = STREAMS[index];
    const nextAt = index + 1 < STREAMS.length ? STREAMS[index + 1].at : h1.length;
    if (stream.frames !== undefined) {
      // The delta animation: chained frames over one canvas.
      let at = stream.at;
      for (let frame = 0; frame < stream.frames; frame += 1) {
        const walk = walkFrame(h1, at);
        if (walk.highest > stream.canvas) {
          throw new Error(`${stream.name} frame ${frame} writes past its 0x${stream.canvas.toString(16)} canvas`);
        }
        at = walk.end;
      }
      if (at !== nextAt) {
        throw new Error(
          `${stream.name}: ${stream.frames} frames end at 0x${at.toString(16)}, expected 0x${nextAt.toString(16)}`,
        );
      }
    } else {
      const walk = walkFrame(h1, stream.at);
      if (walk.end !== nextAt) {
        throw new Error(
          `${stream.name}: ends at 0x${walk.end.toString(16)}, expected 0x${nextAt.toString(16)}`,
        );
      }
      if (walk.written !== stream.unpacked || walk.skipped !== 0) {
        throw new Error(
          `${stream.name}: writes ${walk.written} and skips ${walk.skipped}, expected ${stream.unpacked} and 0`,
        );
      }
    }
    directory.push({
      name: stream.name,
      at: stream.at,
      packedBytes: nextAt - stream.at,
      ...(stream.frames !== undefined
        ? { frames: stream.frames, canvasBytes: stream.canvas }
        : { unpackedBytes: stream.unpacked }),
    });
  }
  if (STREAMS[0].at !== PALETTE_BLOCK_END) {
    throw new Error("the first stream does not start at the end of the palette block");
  }
  return directory;
}

// ---------------------------------------------------------------------------
// The copper lists
// ---------------------------------------------------------------------------

/** Walks one list to its FFFF FFFE terminator, returning the end offset. */
function walkCopperList(h2, at) {
  let offset = at;
  for (;;) {
    if (offset + 4 > h2.length) throw new Error(`copper list at 0x${at.toString(16)} has no terminator`);
    const first = h2.readUInt16BE(offset);
    const second = h2.readUInt16BE(offset + 2);
    offset += 4;
    if (first === 0xffff && second === 0xfffe) return offset;
  }
}

function verifyLists(h2) {
  let expected = 0;
  for (const list of LISTS) {
    if (list.at !== expected) {
      throw new Error(`copper list at 0x${list.at.toString(16)} does not start where the last one ended`);
    }
    expected = walkCopperList(h2, list.at);
  }
  if (expected !== SEG02_BYTES) {
    throw new Error(`the eight lists end at 0x${expected.toString(16)}, expected 0x${SEG02_BYTES.toString(16)}`);
  }
}

// ---------------------------------------------------------------------------
// Cross-checks between the handler constants and the material they name
// ---------------------------------------------------------------------------

function verifyHandlers(fadeByAt, streamsByName) {
  const requireFade = (at, where) => {
    if (!fadeByAt.has(at)) throw new Error(`${where} names missing fade table 0x${at.toString(16)}`);
  };
  const listByAt = new Map(LISTS.map((list) => [list.at, list]));
  for (const handler of BACKDROP_HANDLERS) requireFade(handler.fade, `backdrop 0x${handler.op.toString(16)}`);
  for (const handler of TEXT_FADE_HANDLERS) requireFade(handler.fade, `text fade 0x${handler.op.toString(16)}`);
  for (const still of STILL_HANDLERS) {
    requireFade(still.fade, `still 0x${still.op.toString(16)}`);
    const stream = streamsByName.get(still.stream);
    if (stream === undefined) throw new Error(`still 0x${still.op.toString(16)} names missing stream ${still.stream}`);
    const list = listByAt.get(still.list);
    if (list === undefined || list.kind !== "planar") {
      throw new Error(`still 0x${still.op.toString(16)} names missing copper list 0x${still.list.toString(16)}`);
    }
    // Eight planes of `stride` bytes each must be exactly the unpacked image,
    // and the plane row must fit the list's width.
    if (stream.unpackedBytes !== still.stride * 8) {
      throw new Error(`still ${still.stream}: ${stream.unpackedBytes} bytes is not 8 planes of 0x${still.stride.toString(16)}`);
    }
    const rowBytes = (list.hires ? 640 : 320) / 8;
    if (still.stride !== rowBytes * list.rows) {
      throw new Error(`still ${still.stream}: stride 0x${still.stride.toString(16)} does not match its list's band`);
    }
    if (STILL_DST + stream.unpackedBytes > H4_BYTES) {
      throw new Error(`still ${still.stream} would overflow screen memory`);
    }
  }
  for (const fade of [CREDITS.whiteSet, CREDITS.cloudsFade, CREDITS.showA, CREDITS.showB, CREDITS.blackFade]) {
    requireFade(fade, "credits");
  }
  for (const page of CREDITS.pages) {
    const stream = streamsByName.get(page);
    if (stream === undefined || stream.unpackedBytes !== CREDITS.overlayA.planes * CREDITS.overlayA.planeStride) {
      throw new Error(`credits page stream ${page} is missing or the wrong shape`);
    }
  }
  const clouds = streamsByName.get(CREDITS.clouds.stream);
  if (clouds === undefined || clouds.unpackedBytes !== CREDITS.clouds.planes * CREDITS.clouds.planeStride) {
    throw new Error("credits clouds stream is missing or the wrong shape");
  }
  const backdrop = streamsByName.get(BACKDROP.stream);
  if (backdrop === undefined || backdrop.unpackedBytes !== BACKDROP.planes * BACKDROP.planeStride) {
    throw new Error("backdrop stream is missing or the wrong shape");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Decodes everything, in memory. Exported so a test can re-run it in-process. */
export function decodeIntro(segmentDir) {
  const seg00 = readSegment(segmentDir, 0, SEG00_BYTES);
  const seg01 = readSegment(segmentDir, 1, SEG01_BYTES);
  const seg02 = readSegment(segmentDir, 2, SEG02_BYTES);
  // seg01 and seg02 must be position-independent to ship verbatim: image data
  // never relocates, and the copper plane-pointer slots are POKED at runtime
  // rather than initialised, which is why their relocation tables are empty.
  if (seg01.relocs.size !== 0) throw new Error("seg01 carries relocations; it would not ship verbatim");
  if (seg02.relocs.size !== 0) throw new Error("seg02 carries relocations; it would not ship verbatim");

  const script = readScript(seg00.body);
  const fades = FADE_TABLES.map((at) => readFadeTable(seg00.body, seg00.relocs, at));
  const fadeByAt = new Map(fades.map((table) => [table.at, table]));
  const streams = verifyStreams(seg01.body);
  const streamsByName = new Map(streams.map((stream) => [stream.name, stream]));
  verifyLists(seg02.body);
  verifyHandlers(fadeByAt, streamsByName);

  const manifest = {
    schema: MANIFEST_SCHEMA,
    data: [
      { file: DATA_FILE, byteLength: seg01.body.length, sha256: sha256(seg01.body) },
      { file: COPPER_FILE, byteLength: seg02.body.length, sha256: sha256(seg02.body) },
    ],
    screen: { bytes: H4_BYTES },
    paletteBlockEnd: PALETTE_BLOCK_END,
    script,
    fades,
    streams,
    lists: LISTS,
    anim: ANIM,
    backdrop: BACKDROP,
    stillDst: STILL_DST,
    stills: STILL_HANDLERS,
    backdrops: BACKDROP_HANDLERS,
    textFades: TEXT_FADE_HANDLERS,
    credits: CREDITS,
    ops: { intEnable: OP_INT_ENABLE, anim: OP_ANIM, credits: OP_CREDITS, exit: OP_EXIT },
    source: {
      file: "intro.bin",
      version: "Pinball Illusions INTRO (AGA)",
      disk: 1,
      segments: { data: 1, copper: 2, script: 0 },
      scriptAt: SCRIPT_AT,
    },
    // Frame numbering: t counts PAL frames from the interrupt-enable at t=1;
    // session 3's boot film matches at t = film frame + 1067, within +-2
    // frames across nine checkpoints. See research/INTRO_DECODE.md §6.
    timing: { tickHz: 50, endT: SCRIPT_END_T, filmOffset: 1067 },
    provenance: PROVENANCE,
  };
  return { manifest, data: seg01.body, copper: seg02.body };
}

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const segmentDir = positional[0];
  const outDir = positional[1] ?? "public/generated/shell/intro";
  if (segmentDir === undefined) {
    console.error("usage: node scripts/export-intro.mjs <segment-dir> [out-dir] [--check]");
    return 2;
  }

  const { manifest, data, copper } = decodeIntro(segmentDir);
  const json = Buffer.from(JSON.stringify(manifest), "utf8");

  console.log(check ? "checking intro" : "exporting intro");
  if (!check) mkdirSync(outDir, { recursive: true });

  let failures = 0;
  const emit = (name, bytes) => {
    const path = join(outDir, name);
    if (check) {
      const existing = existsSync(path) ? readFileSync(path) : null;
      if (existing !== null && existing.equals(bytes)) {
        console.log(`  ${name.padStart(18)}: identical to ${path}`);
      } else {
        console.error(
          `  ${name.padStart(18)}: DIFFERS from ${path}` +
            (existing === null
              ? " (file missing)"
              : ` (${existing.length} vs ${bytes.length} bytes, sha256 ` +
                `${sha256(existing).slice(0, 12)} vs ${sha256(bytes).slice(0, 12)})`),
        );
        failures += 1;
      }
    } else {
      writeFileSync(path, bytes);
      console.log(`  ${name.padStart(18)}: ${bytes.length.toLocaleString()} bytes`);
    }
  };

  emit(DATA_FILE, data);
  emit(COPPER_FILE, copper);
  emit(MANIFEST_FILE, json);
  console.log(
    `  ${" ".repeat(18)}  ${manifest.script.length}-entry script, ${manifest.fades.length} fade tables, ` +
      `${manifest.streams.length} streams, ${manifest.lists.length} copper lists; ` +
      `show ends at t=${SCRIPT_END_T} (${(SCRIPT_END_T / 50).toFixed(1)} s of script, ` +
      `${((4445 - 1) / 50).toFixed(1)} s on screen with the credits choreography)`,
  );

  if (failures > 0) {
    console.error(`${failures} file(s) differ or are missing`);
    return 1;
  }
  return 0;
}

// Importable for tests; a direct run executes.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  process.exit(main(process.argv.slice(2)));
}
