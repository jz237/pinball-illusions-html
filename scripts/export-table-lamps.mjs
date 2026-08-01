#!/usr/bin/env node
// Decodes the PLAYFIELD LAMP LAYER out of the table packages into the documents
// under public/generated/tables/*.lamps.json. Run locally, where the operator's
// own disks live; the JSON it writes is what ships. Sibling of
// scripts/export-table-modes.mjs, whose decode machinery (the package loader,
// the relocation follower and the script/element discovery) it imports — the
// element pool here IS the modes exporter's element pool, recomputed and then
// cross-checked against the shipped modes.json so the two can never drift.
//
// ---------------------------------------------------------------------------
// THE CHAIN THIS EXPORTS
// ---------------------------------------------------------------------------
// The mission VM's lamp opcodes act on LAMP OBJECTS in hunk 4, reached from a
// playfield element's +$04 (the START path) and +$08 (the AWARD relight path).
// The per-frame scan at main.seg00 $64D0 walks the GROUP TABLE the slot-0
// descriptor names at +$38 — a 0-terminated array of pointers to group records
// {+0 first lamp, +4 flags, +6 event} whose lamp objects chain through +$10 —
// keeps an on-screen shadow, and draws each lamp through the blitter at
// $74D8 (on) / $753A (off). Descriptor +$64 is a second, short list of the
// engine-driven lamps (shoot-again, and Law 'n Justice's RICOCHET).
//
// LAMP OBJECT, 0x14 bytes (offsets from the draw routines and the handlers at
// $6234/$626E/$6312/$6440):
//   +$00..$05  runtime state, zero on disk: per-player lit bits (+0), blink
//              phase (+1), blink countdown (+3), blink reload (+4 — START
//              writes 8, the measured half-period), always-on mask (+5)
//   +$02  u8   flags: bit1 blinking (runtime), bit2 NO-DRAW (a chain dummy),
//              bit3 MASKED-IMAGE lamp (the $754E/$7572 cookie-cut path)
//   +$06  u16  blitter shift word: bits 15-12 = horizontal pixel shift 0-15,
//              ORed into BLTCON0; low 12 bits zero on every shipped lamp
//   +$08  u32  destination byte offset into the slot-3 playfield bitmap
//   +$0C  u32  -> graphic record                +$10 u32 -> next lamp, 0 ends
//
// SIMPLE (plane-7) GRAPHIC RECORD, slot 6: {u16 mod, u16 bltsize, bitmap}.
// bltsize is the Amiga BLTSIZE word, height<<6 | width-in-words; mod is the
// destination modulo and always equals 384 - 2*w, i.e. the blit walks whole
// 384-byte interleaved playfield rows and stays in ONE bitplane. The bitmap is
// (w-1)*2*h bytes — one word narrower than the blit, BLTAMOD = -2, the spare
// word absorbing the shift. The destination offset decomposes over the slot-3
// layout (384-byte rows of 8 x 48-byte planes) as y = dst/384,
// plane = (dst%384)/48, x = 8*((dst%384)%48) + shift, and the plane is 7 for
// every simple lamp on every table: the shipped artwork stores every insert
// LIT in the lower palette half, an OFF blit ($753A, minterm $FC = A|B) SETS
// bit 7 and moves the insert's pixels into the upper half — the dim variants —
// and an ON blit ($74D8, minterm $0C = ~A&B) clears it again. This exporter
// verifies that world-view: every mask pixel of every lamp must sit on a
// bit-7-CLEAR artwork index, and does (0 violations on all three tables).
// The runtime therefore needs no off-state pixels for these lamps: OFF is
// artwork index | 0x80 through the artwork's own palette, so the manifest
// carries only the mask.
//
// MASKED-IMAGE lamps (flags bit3 — Extreme Sports ships six, elements 85-90's
// award lamps) use a 14-byte record at +$0C instead: {u16 shift word, u32 dst,
// u32 -> OFF image, u32 -> ON image}, the lamp object's own +$06/+$08 unused.
// Each image is a slot-6 cookie-cut record {u16 mod, u16 bltsize, u16 maskoff,
// image[maskoff], mask[maskoff]} blitted with minterm $CA (A = mask,
// B = image, C = D = playfield). mod + 2*w = 48 = one full 8-plane playfield
// line, so these are full-colour sprites h/8 display lines tall, and the image
// and mask are again one word narrower than the blit (BLTAMOD = BLTBMOD = -2):
// maskoff = (w-1)*2*h exactly. The manifest carries both states as decoded
// 8-bit palette-index pixels plus the mask.
//
// BLINK TIMING, measured: the START handler writes 8 into the reload byte and
// the servicer decrements the countdown once per frame, toggling the phase —
// 8 frames visible, 8 frames dark, a 16-frame period. Shipped in the manifest
// as `blink.halfPeriodFrames`.
//
// ---------------------------------------------------------------------------
// THE CHECKS
// ---------------------------------------------------------------------------
// 1. STRUCTURAL. Group array 0-terminated within bounds; every chain acyclic;
//    every lamp's runtime bytes zero on disk; every shift word's low 12 bits
//    zero; every graphic pointer lands in the slot its kind requires.
// 2. GEOMETRIC. Simple lamps: mod == 384-2w, plane == 7, record inside slot 6,
//    footprint inside 336x600. Masked lamps: plane == 0, mod == 48-2w,
//    h % 8 == 0, maskoff == (w-1)*2*h, both images the same shape.
// 3. THE LIT-ARTWORK INVARIANT. Every simple-lamp mask pixel must have bit 7
//    clear in the slot-3 artwork index under it. One violation fails the run.
// 4. ELEMENT-POOL AGREEMENT. The element pool recomputed here must match the
//    shipped modes.json in COUNT, and per element the presence of a start-path
//    and an award-path lamp must match its lampStart/lampAward booleans; every
//    non-null lamp pointer must resolve to a lamp this decode walked.
//
// Usage:
//   node scripts/export-table-lamps.mjs <segment-dir> [out-dir] [--check]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadPackage,
  findScripts,
  follow,
  key,
  readU8,
  readU16,
  readU32,
  inBounds,
} from "./export-table-modes.mjs";

/** Descriptor offsets (byte offsets into slot 0's body). */
const HEADER_LAMP_GROUPS = 0x38;
const HEADER_ENGINE_LAMPS = 0x64;

/** Lamp object field offsets. Each is quoted to an instruction in the header. */
const LAMP_FLAGS = 0x02;
const LAMP_SHIFT = 0x06;
const LAMP_DEST = 0x08;
const LAMP_GFX = 0x0c;
const LAMP_NEXT = 0x10;
const LAMP_BYTES = 0x14;
/** Lamp flag bits. */
const FLAG_NO_DRAW = 0x04;
const FLAG_MASKED = 0x08;

/** Masked-record field offsets: {shift.w, dst.l, off.l, on.l}. */
const MASKED_SHIFT = 0x00;
const MASKED_DEST = 0x02;
const MASKED_OFF = 0x06;
const MASKED_ON = 0x0a;

/** Element record lamp pointers, as in export-table-modes.mjs. */
const ELEMENT_LAMP_START = 0x04;
const ELEMENT_LAMP_AWARD = 0x08;

/** The slot-3 playfield layout (see scripts/export-table-art.mjs). */
const ART_SLOT = 3;
const GFX_SLOT = 6;
const WIDTH = 336;
const HEIGHT = 600;
const ROW_BYTES = 384;
const PLANE_BYTES = 48;
const PLANES = 8;
const ART_PHASE = 4;

/** MEASURED: the blink reload the START handler writes. 8 frames per half. */
const BLINK_HALF_PERIOD = 8;

/** Bounds on the walks, all far above anything shipped. */
const MAX_GROUPS = 64;
const MAX_CHAIN = 64;
const MAX_ENGINE = 16;

const TABLES = [
  { stem: "Table001", tableId: "law-n-justice", displayName: "Law 'n Justice" },
  { stem: "Table002", tableId: "babewatch", displayName: "BabeWatch" },
  { stem: "Table003", tableId: "extreme-sports", displayName: "Extreme Sports" },
];

const PROVENANCE = {
  sourceClass: "disk-derived-lamp-overlays",
  description:
    "Playfield lamp and insert overlays — positions, shapes and the masked lamps' two image " +
    "states — decoded from the operator's own AGA floppy set, with the wiring from each mode " +
    "element to the lamps its START and AWARD opcodes drive. Functional presentation data " +
    "only: no audio, no executable code.",
  authorizationRequired: true,
};

// ---------------------------------------------------------------------------
// Artwork indices (for check 3)
// ---------------------------------------------------------------------------

/**
 * Decodes the slot-3 playfield to one palette index per pixel.
 *
 * The layout — 384-byte interleaved rows, 8 planes of 48 bytes, LSB-first
 * plane order, payload at phase 4 — is the one export-table-art.mjs documents
 * and ships; this is the minimal index-only reading of the same bytes.
 */
function artworkIndices(pkg) {
  const body = pkg.bodies[ART_SLOT];
  if (body === undefined) throw new Error("no slot 3 in this package");
  const indices = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    // The package loader has already stripped the 4-byte preamble, so rows
    // start at 0 of the body (export-table-art.mjs reads the raw file and
    // starts at ART_PHASE; same bytes).
    const row = y * ROW_BYTES;
    for (let plane = 0; plane < PLANES; plane += 1) {
      const planeRow = row + plane * PLANE_BYTES;
      const bit = 1 << plane;
      for (let bx = 0; bx < WIDTH / 8; bx += 1) {
        const byte = body[planeRow + bx];
        if (byte === 0) continue;
        const x0 = y * WIDTH + bx * 8;
        for (let b = 0; b < 8; b += 1) {
          if (byte & (0x80 >> b)) indices[x0 + b] |= bit;
        }
      }
    }
  }
  void ART_PHASE;
  return indices;
}

// ---------------------------------------------------------------------------
// Lamp discovery
// ---------------------------------------------------------------------------

/** Splits a lamp destination offset over the slot-3 row layout. */
function splitDest(dst) {
  const y = Math.floor(dst / ROW_BYTES);
  const rem = dst % ROW_BYTES;
  return { y, plane: Math.floor(rem / PLANE_BYTES), xByte: rem % PLANE_BYTES };
}

/** Reads a shift word, refusing the low bits nothing shipped ever sets. */
function shiftOf(pkg, at, delta, what) {
  const word = readU16(pkg, at, delta);
  if ((word & 0x0fff) !== 0) {
    throw new Error(`${what}: shift word 0x${word.toString(16)} has non-zero low bits`);
  }
  return word >> 12;
}

/**
 * Decodes one simple (plane-7) graphic record and the lamp's placement.
 *
 * Returns { x, y, width, height, mask } with the mask as row-major bytes,
 * width/8 per row, bit 0x80 the leftmost pixel — the record's own words, only
 * de-interleaved from the blitter's format.
 */
function decodeSimple(pkg, lamp, what) {
  const gfx = follow(pkg, lamp.at, LAMP_GFX);
  if (gfx === null || gfx.hunk !== GFX_SLOT) {
    throw new Error(`${what}: graphic pointer does not land in slot ${GFX_SLOT}`);
  }
  const mod = readU16(pkg, gfx, 0);
  const bltsize = readU16(pkg, gfx, 2);
  const h = bltsize >> 6;
  const w = bltsize & 0x3f;
  if (h === 0 || w < 2) throw new Error(`${what}: degenerate BLTSIZE 0x${bltsize.toString(16)}`);
  if (mod !== ROW_BYTES - 2 * w) {
    throw new Error(`${what}: modulo ${mod} is not ${ROW_BYTES}-2*${w}; not a playfield lamp record`);
  }
  const bitmapBytes = (w - 1) * 2 * h;
  if (!inBounds(pkg, gfx, 4 + bitmapBytes)) {
    throw new Error(`${what}: ${bitmapBytes}-byte bitmap runs out of slot ${GFX_SLOT}`);
  }
  const dst = readU32(pkg, lamp.at, LAMP_DEST);
  const shift = shiftOf(pkg, lamp.at, LAMP_SHIFT, what);
  const { y, plane, xByte } = splitDest(dst);
  if (plane !== 7) throw new Error(`${what}: destination plane is ${plane}, expected 7`);
  const x = 8 * xByte + shift;
  const width = (w - 1) * 16;
  if (x + width > WIDTH || y + h > HEIGHT) {
    throw new Error(`${what}: ${width}x${h} footprint at (${x},${y}) leaves the playfield`);
  }
  const body = pkg.bodies[GFX_SLOT];
  const mask = Buffer.from(body.subarray(gfx.offset + 4, gfx.offset + 4 + bitmapBytes));
  return { x, y, width, height: h, mask };
}

/** Decodes one cookie-cut image record: full-colour pixels plus a mask. */
function decodeMaskedImage(pkg, at, what) {
  if (at === null || at.hunk !== GFX_SLOT) {
    throw new Error(`${what}: image pointer does not land in slot ${GFX_SLOT}`);
  }
  const mod = readU16(pkg, at, 0);
  const bltsize = readU16(pkg, at, 2);
  const maskoff = readU16(pkg, at, 4);
  const h = bltsize >> 6;
  const w = bltsize & 0x3f;
  if (h === 0 || w < 2 || h % PLANES !== 0) {
    throw new Error(`${what}: BLTSIZE 0x${bltsize.toString(16)} is not a whole-line sprite`);
  }
  if (mod !== PLANE_BYTES - 2 * w) {
    throw new Error(`${what}: modulo ${mod} is not ${PLANE_BYTES}-2*${w}; not a cookie-cut record`);
  }
  const bytes = (w - 1) * 2 * h;
  if (maskoff !== bytes) {
    throw new Error(`${what}: maskoff ${maskoff} is not the ${bytes}-byte image size`);
  }
  if (!inBounds(pkg, at, 6 + 2 * bytes)) {
    throw new Error(`${what}: image+mask run out of slot ${GFX_SLOT}`);
  }
  const body = pkg.bodies[GFX_SLOT];
  const image = body.subarray(at.offset + 6, at.offset + 6 + bytes);
  const mask = body.subarray(at.offset + 6 + bytes, at.offset + 6 + 2 * bytes);

  // De-interleave: h plane-rows in plane order 0..7 per display line,
  // LSB-first plane weights, (w-1) words per row.
  const lines = h / PLANES;
  const width = (w - 1) * 16;
  const rowBytes = (w - 1) * 2;
  const pixels = Buffer.alloc(width * lines);
  const maskRows = Buffer.alloc(rowBytes * lines);
  for (let line = 0; line < lines; line += 1) {
    for (let plane = 0; plane < PLANES; plane += 1) {
      const row = (line * PLANES + plane) * rowBytes;
      const bit = 1 << plane;
      for (let bx = 0; bx < rowBytes; bx += 1) {
        const imageByte = image[row + bx];
        // The cookie-cut mask must agree across the 8 planes of a line, or the
        // blit would tear colours apart; OR them together and verify below.
        maskRows[line * rowBytes + bx] |= mask[row + bx];
        if (mask[row + bx] !== mask[line * PLANES * rowBytes + bx]) {
          throw new Error(`${what}: mask differs between planes on line ${line}`);
        }
        if (imageByte === 0) continue;
        for (let b = 0; b < 8; b += 1) {
          if (imageByte & (0x80 >> b)) pixels[line * width + bx * 8 + b] |= bit;
        }
      }
    }
  }
  return { width, height: lines, pixels, mask: maskRows };
}

/** Decodes a masked (flags bit3) lamp's record and both image states. */
function decodeMasked(pkg, lamp, what) {
  const record = follow(pkg, lamp.at, LAMP_GFX);
  if (record === null) throw new Error(`${what}: no masked record pointer`);
  const dst = readU32(pkg, record, MASKED_DEST);
  const shift = shiftOf(pkg, record, MASKED_SHIFT, what);
  const { y, plane, xByte } = splitDest(dst);
  if (plane !== 0) throw new Error(`${what}: masked destination plane is ${plane}, expected 0`);
  const off = decodeMaskedImage(pkg, follow(pkg, record, MASKED_OFF), `${what} off-image`);
  const on = decodeMaskedImage(pkg, follow(pkg, record, MASKED_ON), `${what} on-image`);
  if (off.width !== on.width || off.height !== on.height) {
    throw new Error(`${what}: off and on images differ in shape`);
  }
  const x = 8 * xByte + shift;
  if (x + off.width > WIDTH || y + off.height > HEIGHT) {
    throw new Error(`${what}: ${off.width}x${off.height} footprint at (${x},${y}) leaves the playfield`);
  }
  return { x, y, width: off.width, height: off.height, off, on };
}

/**
 * Walks the group table and the engine list into the full lamp inventory.
 *
 * Order is the scan's own: groups in table order, each chain first-to-last,
 * then any engine-list lamp not already seen (none shipped — both lists on all
 * three tables name lamps the groups already contain; the walk keeps them
 * anyway so a package where that stops being true still exports).
 */
function discoverLamps(pkg, stem) {
  const descriptor = { hunk: 0, offset: 0 };
  const groupsBase = follow(pkg, descriptor, HEADER_LAMP_GROUPS);
  if (groupsBase === null) throw new Error(`${stem}: descriptor +0x38 names no lamp group table`);

  const lamps = [];
  const byKey = new Map();

  const admit = (at, group, what) => {
    if (byKey.has(key(at))) return byKey.get(key(at));
    if (!inBounds(pkg, at, LAMP_BYTES)) throw new Error(`${what}: lamp object out of bounds`);
    for (const delta of [0x00, 0x01, 0x03, 0x04, 0x05]) {
      if (readU8(pkg, at, delta) !== 0) {
        throw new Error(`${what}: runtime byte +0x${delta.toString(16)} is not zero on disk`);
      }
    }
    const lamp = {
      index: lamps.length,
      at,
      group,
      flags: readU8(pkg, at, LAMP_FLAGS),
    };
    byKey.set(key(at), lamp);
    lamps.push(lamp);
    return lamp;
  };

  for (let g = 0; ; g += 1) {
    if (g > MAX_GROUPS) throw new Error(`${stem}: lamp group table is not terminated`);
    if (!inBounds(pkg, groupsBase, g * 4 + 4) || readU32(pkg, groupsBase, g * 4) === 0) break;
    const record = follow(pkg, groupsBase, g * 4);
    if (record === null) throw new Error(`${stem}: group ${g} pointer is not relocated`);
    let cursor = follow(pkg, record, 0);
    for (let n = 0; cursor !== null; n += 1) {
      if (n > MAX_CHAIN) throw new Error(`${stem}: group ${g} lamp chain does not terminate`);
      const what = `${stem} group ${g} lamp ${n} (${key(cursor)})`;
      const lamp = admit(cursor, g, what);
      cursor = readU32(pkg, lamp.at, LAMP_NEXT) === 0 ? null : follow(pkg, lamp.at, LAMP_NEXT);
    }
  }

  const engineBase = follow(pkg, descriptor, HEADER_ENGINE_LAMPS);
  if (engineBase !== null) {
    for (let i = 0; ; i += 1) {
      if (i > MAX_ENGINE) throw new Error(`${stem}: engine lamp list is not terminated`);
      if (!inBounds(pkg, engineBase, i * 4 + 4) || readU32(pkg, engineBase, i * 4) === 0) break;
      const at = follow(pkg, engineBase, i * 4);
      // The list's terminator is not pinned: the longs after the genuine
      // entries are neither zero nor relocated (whatever record follows the
      // list starts there), so the walk stops at the first long the relocation
      // table does not claim. Every entry it yields IS a lamp object, and on
      // all three shipped tables every one is already in the group table, so
      // this list changes nothing there — it is kept for a package where the
      // engine lamps are NOT group-reachable, which would otherwise vanish.
      if (at === null) break;
      admit(at, -1, `${stem} engine lamp ${i} (${key(at)})`);
    }
  }

  return { lamps, byKey };
}

/** The element pool, exactly as export-table-modes.mjs derives it. */
function elementPool(pkg) {
  const scripts = findScripts(pkg);
  const keys = new Set();
  for (const script of scripts.values()) {
    for (const op of script.ops) {
      for (const arg of op.args) {
        if (arg.kind === "e" && arg.target !== null) keys.add(key(arg.target));
      }
    }
  }
  return [...keys]
    .map((k) => {
      const [hunk, offset] = k.split(":").map(Number);
      return { hunk, offset };
    })
    .sort((a, b) => a.hunk - b.hunk || a.offset - b.offset);
}

// ---------------------------------------------------------------------------
// Assembling one table
// ---------------------------------------------------------------------------

function decode(pkg, table, modesDoc) {
  const { lamps, byKey } = discoverLamps(pkg, table.stem);
  const indices = artworkIndices(pkg);

  // Decode every lamp's graphics and verify the lit-artwork invariant.
  let litViolations = 0;
  let maskPixels = 0;
  const docs = lamps.map((lamp) => {
    const what = `${table.stem} lamp ${lamp.index} (${key(lamp.at)})`;
    if (lamp.flags & FLAG_NO_DRAW) {
      return { index: lamp.index, group: lamp.group, kind: "none" };
    }
    if (lamp.flags & FLAG_MASKED) {
      const m = decodeMasked(pkg, lamp, what);
      return {
        index: lamp.index,
        group: lamp.group,
        kind: "masked",
        x: m.x,
        y: m.y,
        width: m.width,
        height: m.height,
        mask: m.off.mask.toString("base64"),
        off: Buffer.from(m.off.pixels).toString("base64"),
        on: Buffer.from(m.on.pixels).toString("base64"),
      };
    }
    const s = decodeSimple(pkg, lamp, what);
    // CHECK 3 — every mask pixel sits on a bit-7-clear artwork index.
    const rowBytes = s.width / 8;
    for (let row = 0; row < s.height; row += 1) {
      for (let bx = 0; bx < rowBytes; bx += 1) {
        const byte = s.mask[row * rowBytes + bx];
        if (byte === 0) continue;
        for (let b = 0; b < 8; b += 1) {
          if ((byte & (0x80 >> b)) === 0) continue;
          maskPixels += 1;
          const artIndex = indices[(s.y + row) * WIDTH + s.x + bx * 8 + b];
          if ((artIndex & 0x80) !== 0) litViolations += 1;
        }
      }
    }
    return {
      index: lamp.index,
      group: lamp.group,
      kind: "plane7",
      x: s.x,
      y: s.y,
      width: s.width,
      height: s.height,
      mask: s.mask.toString("base64"),
    };
  });
  if (litViolations > 0) {
    throw new Error(
      `${table.stem}: ${litViolations} of ${maskPixels} lamp mask pixels sit on artwork with ` +
        `bit 7 already set; the shipped-artwork-stores-lit reading is wrong somewhere`,
    );
  }

  // CHECK 4 — the element pool must agree with the shipped modes document.
  const elements = elementPool(pkg);
  const shipped = modesDoc.elements;
  if (!Array.isArray(shipped) || shipped.length !== elements.length) {
    throw new Error(
      `${table.stem}: element pool has ${elements.length} entries but the shipped modes.json ` +
        `has ${Array.isArray(shipped) ? shipped.length : "no"} — the two exporters have drifted`,
    );
  }
  const wiring = elements.map((at, index) => {
    const resolve = (delta, flag, name) => {
      const target = follow(pkg, at, delta);
      if ((target !== null) !== Boolean(shipped[index][flag])) {
        throw new Error(
          `${table.stem}: element ${index} ${name} presence disagrees with the shipped modes.json`,
        );
      }
      if (target === null) return -1;
      const lamp = byKey.get(key(target));
      if (lamp === undefined) {
        throw new Error(
          `${table.stem}: element ${index} ${name} -> ${key(target)} is not a lamp the group ` +
            `table reaches; the runtime could never draw it`,
        );
      }
      return lamp.index;
    };
    return {
      start: resolve(ELEMENT_LAMP_START, "lampStart", "start lamp"),
      award: resolve(ELEMENT_LAMP_AWARD, "lampAward", "award lamp"),
    };
  });

  return { lamps: docs, elements: wiring, maskPixels };
}

function buildDocument(table, decoded) {
  return {
    schema: "pinball-illusions/table-lamps/v1",
    tableId: table.tableId,
    displayName: table.displayName,
    provenance: PROVENANCE,
    blink: { halfPeriodFrames: BLINK_HALF_PERIOD },
    lamps: decoded.lamps,
    elements: decoded.elements,
  };
}

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const segDir = positional[0];
  const outDir = positional[1] ?? "public/generated/tables";

  if (segDir === undefined) {
    console.error("usage: node scripts/export-table-lamps.mjs <segment-dir> [out-dir] [--check]");
    return 1;
  }
  if (!existsSync(segDir)) {
    console.error(`segment directory not found: ${segDir}`);
    return 1;
  }
  if (!check) mkdirSync(outDir, { recursive: true });

  console.log(check ? "checking table lamps" : "exporting table lamps");
  let failures = 0;

  for (const table of TABLES) {
    let decoded;
    try {
      const modesPath = join(outDir, `${table.tableId}.modes.json`);
      if (!existsSync(modesPath)) {
        throw new Error(`no ${modesPath}; export the modes first — check 4 needs them`);
      }
      const modesDoc = JSON.parse(readFileSync(modesPath, "utf8"));
      decoded = decode(loadPackage(segDir, table.stem), table, modesDoc);
    } catch (error) {
      console.error(`  ${table.tableId.padStart(15)}: ${error instanceof Error ? error.message : error}`);
      failures += 1;
      continue;
    }

    const json = JSON.stringify(buildDocument(table, decoded));
    const out = join(outDir, `${table.tableId}.lamps.json`);
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

    const kinds = { plane7: 0, masked: 0, none: 0 };
    for (const lamp of decoded.lamps) kinds[lamp.kind] += 1;
    const wired = decoded.elements.filter((e) => e.start >= 0 || e.award >= 0).length;
    console.log(
      `  ${" ".repeat(15)}  ${decoded.lamps.length} lamps (${kinds.plane7} plane-7, ` +
        `${kinds.masked} masked, ${kinds.none} no-draw), ${decoded.maskPixels} mask pixels all ` +
        `on lit artwork, ${wired}/${decoded.elements.length} elements wired to a lamp`,
    );
  }

  if (failures > 0) {
    console.error(`${failures} table(s) ${check ? "differ or are missing" : "could not be exported"}`);
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
