#!/usr/bin/env node
// Decodes the SCORE-PANEL ANIMATION HEAP out of the table packages into the
// documents under public/generated/tables/*.panel.json. Run locally, where the
// operator's own disks live; the JSON it writes is what ships. Sibling of
// scripts/export-table-lamps.mjs, whose decode machinery (the package loader,
// the relocation follower and the script/element discovery) it imports — the
// element and message pools here ARE the modes exporter's pools, recomputed and
// cross-checked against the shipped modes.json so the documents can never drift.
//
// ---------------------------------------------------------------------------
// THE HEAP THIS EXPORTS
// ---------------------------------------------------------------------------
// The score panel is a 320x16 three-plane strip (40-byte row stride; plane 0
// fill, plane 1 outline, plane 2 the digits — the originals live at
// main.s05+$500/$780/$A00). SLOT 5 of each table package is its ANIMATION
// HEAP: the mission/award/prize animations the display queue at $6C2C plays on
// it, one at a time, from the second 64-slot pointer ring at $23A2/$239E/$23A0.
//
// ANIMATION OBJECT, verified byte-for-byte against all three packages:
//
//   28-byte header:
//     +$00..$0B  runtime state, ZERO on disk (12 bytes)
//     +$0C u16   speed divider — frames of delay per animation step.
//                MEASURED census: 1..5 everywhere except one 8 (Extreme
//                Sports h5+$7480) and one 50 (BabeWatch h5+$41784)
//     +$0E..$15  zero on disk on every object of every table
//     +$16 u16   WIDTH FIELD: bytes per row per plane = field/4
//                ($A0 = 40 bytes = the full 320px panel; census $30..$A0)
//     +$18 u16   height in rows: 16, except two 15-row objects
//                (BabeWatch h5+$3AF28, Extreme Sports h5+$64EFE)
//     +$1A u16   frame count, census 1..79
//
//   then FRAME 0 RAW: two plane-sequential bitplanes, height rows of
//   (field/4) bytes each — 2*height*(field/4) bytes;
//
//   then frames 1..N-1 as RLE DELTAS against the previous frame. Each frame is
//   2*height independent streams, one per plane-row in frame-buffer order,
//   each producing exactly (field/4) bytes:
//     00 cnt val   FILL: cnt bytes of val (cnt 0 = 256)
//     80|cnt, ...  LITERAL: the next cnt bytes verbatim
//     01..7F       SKIP: keep cnt bytes of the previous frame
//
// The property that PROVED this framing, enforced here on every object: every
// frame of every object consumes exactly its byte range, and the objects (plus
// a single zero pad byte after each odd-length object — all pads verified
// zero) tile slot 5 exactly to its last byte. 49 / 64 / 88 objects.
//
// ENTRY. Objects are entered via relocated longwords in hunk-4 display
// records: a directive word $0001 (or the rarer $000C variant) immediately
// followed by the pointer. Objects NOT directly pointed at chain sequentially
// after pointed ones (2 / 1 / 6 of them). Law 'n Justice alone also carries two
// HEADERLESS blitter blobs at h5+$0 (pattern, $78 bytes) and h5+$78 (mask, $3C
// bytes), stamped as 48x15 indicator glyphs — their only referrers are two
// `lea` instructions in h4 native code at +$8696/+$869C, which is how they are
// told apart from directive entries.
//
// THE REFERENCE MAP. Display records are what the mode VM queues, and they are
// reached from: an element's +$14 (on START) and +$18 (on AWARD), the MESSAGE
// opcode's operand pool (the modes document's `messages`, same indices), and
// the descriptor's +$84 attract/score-trailer record. Type-1 devices carry an
// animation record at +$06 — walked here both on the device record and on its
// mode record, and EMPTY on all three shipped tables (the longword is zero).
// The display VM behind $6C2C is not decoded, so which objects belong to a
// record is a RECONSTRUCTION with the same shape as the modes exporter's
// `messageText`: the record is scanned from its base to the next known record
// base (capped at $60 bytes) for directive-word-preceded relocations into slot
// 5. The offsets and objects are exact; the record membership is the
// reconstructed claim. Directive sites no known record claims — the credits
// records — are exported factually under `other` with their h4 offsets.
//
// ---------------------------------------------------------------------------
// THE CHECKS, ALL FATAL
// ---------------------------------------------------------------------------
// 1. EVERY OBJECT DECODES TO THE BYTE: header bounds as measured above, runtime
//    bytes zero, every RLE stream landing exactly on its row width, every frame
//    consuming exactly its range.
// 2. THE HEAP TILES: blobs (LnJ) + objects + verified-zero pad bytes cover
//    slot 5 from byte 0 to its exact end, with no gap wider than the single
//    alignment byte and no overlap.
// 3. EVERY DIRECTIVE SITE RESOLVES to a decoded object's first byte, and every
//    h4->h5 relocation is accounted for: directive site, blob `lea`, nothing
//    else.
// 4. POOL AGREEMENT: the element and message pools recomputed here match the
//    shipped modes.json in COUNT, and the element display-record pointers match
//    that document's displayStart/displayAward presence per element.
//
// Usage:
//   node scripts/export-table-panel.mjs <segment-dir> [out-dir] [--check]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadPackage,
  findScripts,
  follow,
  key,
  readU16,
  readU32,
} from "./export-table-modes.mjs";

/** The slot holding the panel animation heap. */
const PANEL_SLOT = 5;

/** The panel strip the objects are blitted onto. */
const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 16;
const PANEL_PLANES = 2;

/** Object header offsets and the measured field bounds. */
const OBJ_HEADER_BYTES = 0x1c;
const OBJ_RUNTIME_BYTES = 12;
const OBJ_SPEED = 0x0c;
const OBJ_ZERO_TAIL = 0x0e; // +$0E..$15 zero on disk
const OBJ_WIDTH_FIELD = 0x16;
const OBJ_HEIGHT = 0x18;
const OBJ_FRAMES = 0x1a;
const SPEED_MIN = 1;
const SPEED_MAX = 50; // census: 1..5 plus one 8 and one 50
const HEIGHTS = new Set([15, 16]);
const WIDTH_FIELD_MAX = 0xa0; // the full 320-px panel
const FRAMES_MAX = 79;

/** RLE opcodes. */
const RLE_FILL = 0x00;
const RLE_LITERAL = 0x80;

/** Display-record directive words that precede an animation pointer. */
const DIRECTIVE_WORDS = new Set([0x0001, 0x000c]);
/** Scan cap on a display record whose successor is not adjacent. */
const DISPLAY_SPAN_MAX = 0x60;

/** Element record display pointers, as in export-table-modes.mjs. */
const ELEMENT_DISPLAY_START = 0x14;
const ELEMENT_DISPLAY_AWARD = 0x18;

/** Device walk, as in export-table-devices.mjs / export-table-modes.mjs. */
const HEADER_LOWER_DEVICES = 0x10;
const HEADER_UPPER_DEVICES = 0x28;
const DEVICE_SLOTS = 160;
const DEVICE_ID_BASE = 32;
const DEVICE_ANIMATION = 0x06;
const DEVICE_MODE_POINTER = 0x22;
const MODE_ANIMATION = 0x06;

/** The descriptor long naming the attract/score-trailer display record. */
const HEADER_TRAILER_DISPLAY = 0x84;

/**
 * Law 'n Justice's two headerless indicator blobs, stamped 48x15 by the
 * blitter code that `lea`s them at h4+$8696/+$869C. The mask ends where the
 * first animation object begins (h5+$B4).
 */
const LNJ_BLOBS = [
  { id: "indicator-pattern", offset: 0x000, bytes: 0x78 },
  { id: "indicator-mask", offset: 0x078, bytes: 0x3c },
];
const BLOB_GLYPH_WIDTH = 48;
const BLOB_GLYPH_HEIGHT = 15;

const TABLES = [
  { stem: "Table001", tableId: "law-n-justice", displayName: "Law 'n Justice", blobs: LNJ_BLOBS },
  { stem: "Table002", tableId: "babewatch", displayName: "BabeWatch", blobs: [] },
  { stem: "Table003", tableId: "extreme-sports", displayName: "Extreme Sports", blobs: [] },
];

const PROVENANCE = {
  sourceClass: "disk-derived-panel-animations",
  description:
    "Score-panel animation objects — the mission, award, prize and trailer sequences the " +
    "original's display queue plays on the 320x16 panel strip — decoded from the operator's " +
    "own AGA floppy set and shipped packed in the original object format, with the wiring " +
    "from each mode element, message record and device to the objects it queues. " +
    "Functional presentation data only: no audio, no executable code.",
  authorizationRequired: true,
};

// ---------------------------------------------------------------------------
// Object decoding
// ---------------------------------------------------------------------------

/**
 * CHECK 1 — decodes one animation object at `offset` of the heap, throwing on
 * the first byte that disagrees with the documented format.
 *
 * Returns the object's exact byte extent and header fields. The frames are not
 * kept — the runtime decodes them from the packed bytes — but every frame is
 * WALKED so a stream that does not land exactly on its row width, or a frame
 * that does not consume exactly its range, fails the export rather than the
 * player's browser.
 */
function decodeObject(heap, offset, what) {
  if (offset + OBJ_HEADER_BYTES > heap.length) {
    throw new Error(`${what}: 28-byte header runs out of the heap`);
  }
  for (let i = 0; i < OBJ_RUNTIME_BYTES; i += 1) {
    if (heap[offset + i] !== 0) {
      throw new Error(`${what}: runtime byte +0x${i.toString(16)} is not zero on disk`);
    }
  }
  for (let i = OBJ_ZERO_TAIL; i < OBJ_WIDTH_FIELD; i += 1) {
    if (heap[offset + i] !== 0) {
      throw new Error(`${what}: header byte +0x${i.toString(16)} is not zero on disk`);
    }
  }
  const speed = heap.readUInt16BE(offset + OBJ_SPEED);
  const width = heap.readUInt16BE(offset + OBJ_WIDTH_FIELD);
  const height = heap.readUInt16BE(offset + OBJ_HEIGHT);
  const frames = heap.readUInt16BE(offset + OBJ_FRAMES);
  if (speed < SPEED_MIN || speed > SPEED_MAX) {
    throw new Error(`${what}: speed divider ${speed} outside the measured 1..50`);
  }
  if (width === 0 || width % 4 !== 0 || width > WIDTH_FIELD_MAX) {
    throw new Error(`${what}: width field 0x${width.toString(16)} is not a plausible row width`);
  }
  if (!HEIGHTS.has(height)) {
    throw new Error(`${what}: height ${height} is not the measured 15 or 16`);
  }
  if (frames < 1 || frames > FRAMES_MAX) {
    throw new Error(`${what}: frame count ${frames} outside the measured 1..79`);
  }

  const rowBytes = width / 4;
  const streams = PANEL_PLANES * height;
  let at = offset + OBJ_HEADER_BYTES + streams * rowBytes; // past frame 0 raw
  if (at > heap.length) throw new Error(`${what}: raw frame 0 runs out of the heap`);

  for (let frame = 1; frame < frames; frame += 1) {
    for (let stream = 0; stream < streams; stream += 1) {
      let produced = 0;
      while (produced < rowBytes) {
        if (at >= heap.length) {
          throw new Error(`${what}: frame ${frame} stream ${stream} runs out of the heap`);
        }
        const op = heap[at];
        at += 1;
        if (op === RLE_FILL) {
          if (at + 2 > heap.length) {
            throw new Error(`${what}: frame ${frame} fill run is truncated`);
          }
          const count = heap[at];
          at += 2;
          produced += count === 0 ? 256 : count;
        } else if (op & RLE_LITERAL) {
          const count = op & 0x7f;
          if (count === 0) {
            throw new Error(`${what}: frame ${frame} literal run of zero at 0x${(at - 1).toString(16)}`);
          }
          if (at + count > heap.length) {
            throw new Error(`${what}: frame ${frame} literal run is truncated`);
          }
          at += count;
          produced += count;
        } else {
          produced += op; // SKIP
        }
      }
      if (produced !== rowBytes) {
        throw new Error(
          `${what}: frame ${frame} stream ${stream} produces ${produced} bytes, not the row's ` +
            `${rowBytes} — the RLE reading is wrong or this is not an object`,
        );
      }
    }
  }
  return { offset, end: at, speed, width, height, frames };
}

/**
 * CHECK 2 — walks the heap into its complete object inventory.
 *
 * Every directive target starts an object; after each object the walk
 * continues at the next even byte, admitting the CHAINED objects nothing
 * points at directly, until the next pointed target or a boundary. The tiling
 * assertions — pads are single zero bytes, the last object ends on the heap's
 * last byte, blobs and objects overlap nothing — are what make "these are all
 * the objects and nothing else is here" a measurement instead of a hope.
 */
function discoverObjects(pkg, stem, targets, blobs) {
  const heap = pkg.bodies[PANEL_SLOT];
  if (heap === undefined) throw new Error(`${stem}: no slot ${PANEL_SLOT} in this package`);
  const blobEnd = blobs.reduce((end, blob) => Math.max(end, blob.offset + blob.bytes), 0);
  for (const blob of blobs) {
    if (blob.offset + blob.bytes > heap.length) {
      throw new Error(`${stem}: blob ${blob.id} runs out of the heap`);
    }
  }

  const pointed = new Set(targets);
  const sortedTargets = [...targets].sort((a, b) => a - b);
  const objects = [];
  const byOffset = new Map();

  for (const target of sortedTargets) {
    let offset = target;
    while (offset < heap.length && !byOffset.has(offset)) {
      if (offset !== target && pointed.has(offset)) break;
      const what = `${stem} h5+0x${offset.toString(16)}${offset === target ? "" : " (chained)"}`;
      const object = decodeObject(heap, offset, what);
      object.pointed = offset === target ? true : false;
      byOffset.set(offset, object);
      objects.push(object);
      offset = object.end + (object.end & 1);
    }
  }
  objects.sort((a, b) => a.offset - b.offset);

  // Chained objects are re-reachable from an earlier pointed target's walk, so
  // a chained flag set on first sight may be stale; recompute from `pointed`.
  for (const object of objects) object.pointed = pointed.has(object.offset);

  // The tiling.
  let cursor = blobEnd;
  for (const object of objects) {
    if (object.offset < cursor) {
      throw new Error(
        `${stem}: object at h5+0x${object.offset.toString(16)} overlaps the previous extent ` +
          `ending 0x${cursor.toString(16)}`,
      );
    }
    if (object.offset > cursor + 1 || (object.offset === cursor + 1 && cursor % 2 === 0)) {
      throw new Error(
        `${stem}: 0x${(object.offset - cursor).toString(16)}-byte gap before h5+0x` +
          `${object.offset.toString(16)} — the heap does not tile`,
      );
    }
    if (object.offset === cursor + 1 && heap[cursor] !== 0) {
      throw new Error(`${stem}: pad byte at h5+0x${cursor.toString(16)} is not zero`);
    }
    cursor = object.end;
  }
  if (cursor !== heap.length) {
    throw new Error(
      `${stem}: last object ends at 0x${cursor.toString(16)} of the 0x` +
        `${heap.length.toString(16)}-byte heap — the walk missed something`,
    );
  }

  objects.forEach((object, id) => {
    object.id = id;
  });
  return { heap, objects, byOffset };
}

// ---------------------------------------------------------------------------
// Reference discovery
// ---------------------------------------------------------------------------

/** The element pool, exactly as export-table-modes.mjs derives it. */
function elementPool(pkg) {
  const scripts = findScripts(pkg);
  const elementKeys = new Set();
  const messageKeys = new Set();
  for (const script of scripts.values()) {
    for (const op of script.ops) {
      for (const arg of op.args) {
        if (arg.target === null || arg.target === undefined) continue;
        if (arg.kind === "e") elementKeys.add(key(arg.target));
        if (arg.kind === "m") messageKeys.add(key(arg.target));
      }
    }
  }
  const byKey = (set) =>
    [...set]
      .map((k) => {
        const [hunk, offset] = k.split(":").map(Number);
        return { hunk, offset };
      })
      .sort((a, b) => a.hunk - b.hunk || a.offset - b.offset);
  return { elements: byKey(elementKeys), messages: byKey(messageKeys) };
}

/** Every h4 longword the relocation table sends into the panel heap. */
function panelReferences(pkg) {
  const sites = new Map(); // h4 offset -> h5 target
  for (const [where, target] of pkg.relocations) {
    if (target !== PANEL_SLOT) continue;
    const [hunk, offset] = where.split(":").map(Number);
    if (hunk !== 4) {
      throw new Error(`${pkg.stem}: unexpected h${hunk} reference into the panel heap`);
    }
    sites.set(offset, readU32(pkg, { hunk: 4, offset }));
  }
  return sites;
}

/**
 * CHECK 3, first half — splits the h4->h5 sites into DIRECTIVE sites (preceded
 * by the $0001/$000C display directive word) and the blob `lea` sites, and
 * refuses anything that is neither.
 */
function classifySites(pkg, sites, blobs) {
  const body = pkg.bodies[4];
  const directives = new Map();
  const blobSites = new Map();
  const blobOffsets = new Set(blobs.map((blob) => blob.offset));
  for (const [site, target] of sites) {
    const before = site >= 2 ? body.readUInt16BE(site - 2) : -1;
    if (DIRECTIVE_WORDS.has(before)) {
      directives.set(site, target);
    } else if (blobOffsets.has(target)) {
      blobSites.set(site, target);
    } else {
      throw new Error(
        `${pkg.stem}: h4+0x${site.toString(16)} -> h5+0x${target.toString(16)} is neither a ` +
          `display directive (word before is 0x${before.toString(16)}) nor a blob reference`,
      );
    }
  }
  return { directives, blobSites };
}

function deviceAnimationRecords(pkg) {
  const out = [];
  for (const level of [0, 1]) {
    const base = follow(pkg, { hunk: 0, offset: 0 }, level === 1 ? HEADER_UPPER_DEVICES : HEADER_LOWER_DEVICES);
    if (base === null) continue;
    for (let index = 0; index < DEVICE_SLOTS; index += 1) {
      const record = follow(pkg, base, 4 * index);
      if (record === null) continue;
      if (readU16(pkg, record, 0) !== 1) continue;
      const surfaceId = index + DEVICE_ID_BASE;
      const direct = follow(pkg, record, DEVICE_ANIMATION);
      if (direct !== null) out.push({ level, surfaceId, at: direct, via: "device" });
      const mode = follow(pkg, record, DEVICE_MODE_POINTER);
      if (mode !== null) {
        const viaMode = follow(pkg, mode, MODE_ANIMATION);
        if (viaMode !== null) out.push({ level, surfaceId, at: viaMode, via: "mode" });
      }
    }
  }
  return out;
}

/**
 * The display-record scan — the documented RECONSTRUCTION. Records are scanned
 * from base to the next known base (capped at $60); a directive site inside
 * the span claims its objects for the record, in site order.
 */
function scanDisplays(pkg, displays, directives, byOffset) {
  const bases = [...new Set(displays.map((display) => display.at.offset))].sort((a, b) => a - b);
  const nextBase = new Map();
  for (const [i, base] of bases.entries()) {
    nextBase.set(base, i + 1 < bases.length ? bases[i + 1] : Number.POSITIVE_INFINITY);
  }
  const claimed = new Map(); // site -> object id
  const perDisplay = new Map(); // display base -> object ids in site order
  for (const base of bases) {
    const span = Math.min(DISPLAY_SPAN_MAX, nextBase.get(base) - base, pkg.bodies[4].length - base);
    const ids = [];
    for (let delta = 0; delta + 4 <= span; delta += 2) {
      const site = base + delta;
      if (!directives.has(site)) continue;
      const target = directives.get(site);
      const object = byOffset.get(target);
      if (object === undefined) {
        throw new Error(
          `${pkg.stem}: display record h4+0x${base.toString(16)} directive at +0x` +
            `${delta.toString(16)} -> h5+0x${target.toString(16)}, which is not an object start`,
        );
      }
      if (claimed.has(site)) {
        throw new Error(`${pkg.stem}: directive site h4+0x${site.toString(16)} claimed twice`);
      }
      claimed.set(site, object.id);
      ids.push(object.id);
      delta += 2; // past the pointer's second word
    }
    perDisplay.set(base, ids);
  }
  return { claimed, perDisplay };
}

// ---------------------------------------------------------------------------
// Assembling one table
// ---------------------------------------------------------------------------

function decode(pkg, table, modesDoc) {
  const sites = panelReferences(pkg);
  const { directives, blobSites } = classifySites(pkg, sites, table.blobs);
  // Each blob is referenced exactly once, by its own `lea` in the h4 code.
  if (blobSites.size !== table.blobs.length) {
    throw new Error(`${table.stem}: ${blobSites.size} blob references for ${table.blobs.length} blobs`);
  }
  const targets = new Set(directives.values());
  const { heap, objects, byOffset } = discoverObjects(pkg, table.stem, targets, table.blobs);

  // CHECK 4 — pool agreement with the shipped modes document.
  const pools = elementPool(pkg);
  if (!Array.isArray(modesDoc.elements) || modesDoc.elements.length !== pools.elements.length) {
    throw new Error(
      `${table.stem}: element pool has ${pools.elements.length} entries but the shipped ` +
        `modes.json has ${Array.isArray(modesDoc.elements) ? modesDoc.elements.length : "no"} — ` +
        `the two exporters have drifted`,
    );
  }
  if (!Array.isArray(modesDoc.messages) || modesDoc.messages.length !== pools.messages.length) {
    throw new Error(
      `${table.stem}: message pool has ${pools.messages.length} entries but the shipped ` +
        `modes.json has ${Array.isArray(modesDoc.messages) ? modesDoc.messages.length : "no"}`,
    );
  }

  // The display records, each with its owner.
  const displays = [];
  pools.elements.forEach((at, index) => {
    for (const [delta, path] of [
      [ELEMENT_DISPLAY_START, "start"],
      [ELEMENT_DISPLAY_AWARD, "award"],
    ]) {
      const display = follow(pkg, at, delta);
      const shipped = modesDoc.elements[index][path === "start" ? "displayStart" : "displayAward"];
      // The modes document files an element display under `messages` only when
      // a MESSAGE opcode also names it; presence beyond that cannot be
      // cross-checked there, so only the positive direction is held.
      if (shipped >= 0 && display === null) {
        throw new Error(
          `${table.stem}: element ${index} ${path} display disagrees with the shipped modes.json`,
        );
      }
      if (display !== null) {
        if (display.hunk !== 4) {
          throw new Error(`${table.stem}: element ${index} ${path} display is not in hunk 4`);
        }
        displays.push({ owner: { kind: path, element: index }, at: display });
      }
    }
  });
  pools.messages.forEach((at, index) => {
    displays.push({ owner: { kind: "message", message: index }, at });
  });
  const trailer = follow(pkg, { hunk: 0, offset: 0 }, HEADER_TRAILER_DISPLAY);
  if (trailer === null || trailer.hunk !== 4) {
    throw new Error(`${table.stem}: descriptor +0x84 names no hunk-4 trailer display record`);
  }
  displays.push({ owner: { kind: "trailer" }, at: trailer });

  const deviceRecords = deviceAnimationRecords(pkg);
  for (const record of deviceRecords) {
    if (record.at.hunk === PANEL_SLOT) {
      // A device animation pointing straight into the heap would be an object.
      const object = byOffset.get(record.at.offset);
      if (object === undefined) {
        throw new Error(
          `${table.stem}: device ${record.surfaceId} animation h5+0x` +
            `${record.at.offset.toString(16)} is not an object start`,
        );
      }
      record.objects = [object.id];
    } else {
      displays.push({ owner: { kind: "device", record }, at: record.at });
    }
  }

  const { claimed, perDisplay } = scanDisplays(pkg, displays, directives, byOffset);

  // Assemble the reference map in pool order.
  const elementRefs = [];
  pools.elements.forEach((at, index) => {
    const paths = { start: [], award: [] };
    for (const display of displays) {
      if (display.owner.element === index) {
        paths[display.owner.kind] = perDisplay.get(display.at.offset) ?? [];
      }
    }
    if (paths.start.length > 0 || paths.award.length > 0) {
      elementRefs.push({ element: index, start: paths.start, award: paths.award });
    }
  });
  const messageRefs = [];
  pools.messages.forEach((at, index) => {
    const ids = perDisplay.get(at.offset) ?? [];
    if (ids.length > 0) messageRefs.push({ message: index, objects: ids });
  });
  const deviceRefs = deviceRecords
    .map((record) => ({
      level: record.level,
      surfaceId: record.surfaceId,
      objects: record.objects ?? perDisplay.get(record.at.offset) ?? [],
    }))
    .filter((entry) => entry.objects.length > 0);
  const trailerRefs = perDisplay.get(trailer.offset) ?? [];

  // CHECK 3, second half — every directive site is claimed or exported as
  // `other`, factually, with its h4 offset. Nothing simply vanishes.
  const other = [];
  for (const [site, target] of [...directives].sort((a, b) => a[0] - b[0])) {
    if (claimed.has(site)) continue;
    const object = byOffset.get(target);
    if (object === undefined) {
      throw new Error(
        `${table.stem}: unclaimed directive h4+0x${site.toString(16)} -> h5+0x` +
          `${target.toString(16)} is not an object start`,
      );
    }
    other.push({ site, object: object.id });
  }

  return {
    heap,
    objects,
    references: {
      elements: elementRefs,
      messages: messageRefs,
      devices: deviceRefs,
      trailer: trailerRefs,
      other,
    },
    stats: {
      directives: directives.size,
      claimed: claimed.size,
      pointed: objects.filter((object) => object.pointed).length,
    },
  };
}

function buildDocument(table, decoded) {
  const toBase64 = (bytes) => Buffer.from(bytes).toString("base64");
  return {
    schema: "pinball-illusions/table-panel/v1",
    tableId: table.tableId,
    displayName: table.displayName,
    provenance: PROVENANCE,
    panel: { width: PANEL_WIDTH, height: PANEL_HEIGHT, planes: PANEL_PLANES },
    objects: decoded.objects.map((object) => ({
      id: object.id,
      offset: object.offset,
      speed: object.speed,
      width: object.width,
      height: object.height,
      frames: object.frames,
      packed: toBase64(decoded.heap.subarray(object.offset, object.end)),
    })),
    blobs: table.blobs.map((blob) => ({
      id: blob.id,
      offset: blob.offset,
      width: BLOB_GLYPH_WIDTH,
      height: BLOB_GLYPH_HEIGHT,
      bytes: toBase64(decoded.heap.subarray(blob.offset, blob.offset + blob.bytes)),
    })),
    references: decoded.references,
  };
}

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const segDir = positional[0];
  const outDir = positional[1] ?? "public/generated/tables";

  if (segDir === undefined) {
    console.error("usage: node scripts/export-table-panel.mjs <segment-dir> [out-dir] [--check]");
    return 1;
  }
  if (!existsSync(segDir)) {
    console.error(`segment directory not found: ${segDir}`);
    return 1;
  }
  if (!check) mkdirSync(outDir, { recursive: true });

  console.log(check ? "checking table panel animations" : "exporting table panel animations");
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
    const out = join(outDir, `${table.tableId}.panel.json`);
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

    const refs = decoded.references;
    const wired = refs.elements.length;
    console.log(
      `  ${" ".repeat(15)}  ${decoded.objects.length} objects (${decoded.stats.pointed} pointed, ` +
        `${decoded.objects.length - decoded.stats.pointed} chained), ${table.blobs.length} blobs, ` +
        `${decoded.stats.directives} directive sites (${decoded.stats.claimed} claimed, ` +
        `${refs.other.length} other)`,
    );
    console.log(
      `  ${" ".repeat(15)}  wiring: ${wired} elements, ${refs.messages.length} messages, ` +
        `${refs.devices.length} devices, ${refs.trailer.length} trailer objects`,
    );
  }

  if (failures > 0) {
    console.error(`${failures} table(s) ${check ? "differ or are missing" : "could not be exported"}`);
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
