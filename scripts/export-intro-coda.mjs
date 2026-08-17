// Bakes the boot-intro CODA's one shipped asset — the HD title card — and
// renders the coda's deterministic reference frames for the pixel gate. Run
// locally, where the operator's own disks live; sibling of
// scripts/export-intro.mjs (whose decode this file reuses wholesale) and of
// scripts/export-loading-logo.mjs (the other single-PNG HD card).
//
// No shebang: tests import this file as a module, and vite-node's vm wrapper
// rejects a hashbang that is no longer at byte 0 in a wrapped source.
//
// Usage:  node scripts/export-intro-coda.mjs <segment-dir> [out-dir] [--check]
//   <segment-dir> holds the seg_clean split of intro.bin (see export-intro.mjs)
//   --check re-derives everything and byte-compares without writing.
//
// ---------------------------------------------------------------------------
// WHAT THIS PRODUCES
// ---------------------------------------------------------------------------
//   public/generated/shell/intro/intro-hd.png   (ships, gated)
//       The ILLUSIONS still (seg01+0x3E868, HAM8 640x120) decoded, de-dithered
//       and xBRZ-4x upscaled to 2560x480 — the measured HD recipe of
//       scripts/hd-pipeline.mjs — with a white heavy-sans "HD" (the two
//       ENHANCED glyphs cut from the shipped delta stream, xBRZ-4x'd)
//       hanging off the final S's baseline at lower right, echoing exactly
//       how "AD" hangs off "1995". The browser presenter overlays this PNG
//       during the coda's card hold; the core underneath keeps showing the
//       original still, so a missing card degrades to the original picture.
//   public/generated/shell/intro/intro-hd.json  (ships, gated)
//       The manifest that claims the PNG: sha256, provenance
//       (disk-derived-intro-hd), and the recipe's facts.
//   research/view/intro/coda-frames/c####.png   (research tree, never ships)
//       The coda's reference frames at the pixel-gate checkpoints, rendered by
//       the INDEPENDENT player below — a JS transliteration of
//       research/intro/render.py's machinery plus the coda choreography — so
//       tests/intro-pixels.test.ts can byte-compare the browser core against
//       an implementation that shares none of its code. c = t - 4447.
//
// ---------------------------------------------------------------------------
// THE CODA IS AN ADDITION, NOT A DECODE
// ---------------------------------------------------------------------------
// Everything the coda shows on the text scene is cut at runtime from the
// already-shipped delta stream (the AND NOW and iN tHE yEAR pages verbatim,
// the 1992 digits, the 1995 AD unit and rules); the 0 and 6 are deterministic
// in-face syntheses (6 = the 9 rotated 180°; 0 = the 9's closed bowl
// NN-stretched to full height). The timing envelope is measured off the run
// the coda mirrors. research/INTRO_DECODE.md §9 records all of it.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeIntro } from "./export-intro.mjs";
import {
  XBRZ_TOOL,
  deditherRgb,
  encodePng,
  sha256,
  xbrzScaleRgb,
  xbrzScaleRgba,
} from "./hd-pipeline.mjs";

// ---------------------------------------------------------------------------
// Constants — the coda's authored numbers, mirrored from src/browser/intro.ts.
// The five pixel pins below prove the two copies agree byte for byte.
// ---------------------------------------------------------------------------

const H4_BASE = 0x0500_0000;
const INTRO_WIDTH = 640;
const INTRO_ROWS = 240;

const CODA = {
  startT: 4447,
  endT: 5105,
  canvasWidth: 320,
  canvasHeight: 120,
  sceneInFade: 0x0f9c,
  textOutFade: 0x1108,
  textSetFade: 0x1134,
  digitsDelta: 107,
  enhancedDelta: 149, // "wE eNHANCED yOUR" fully written — the H and D
  andNowDelta: 150,
  adPageDelta: 172,
  letterDeltas: 9,
  rect9: [103, 28, 37, 62],
  rect2: [179, 29, 38, 61],
  rectAd: [233, 66, 30, 23],
  rectH: [115, 47, 17, 25],
  rectD: [246, 47, 17, 25],
  ruleRows: [28, 89],
  bowlRows: 42,
  digitAt: [
    [84, 29, "2"],
    [122, 28, "0"],
    [160, 29, "2"],
    [198, 28, "6"],
  ],
  adAt: [239, 66],
  andNowHoldEnd: 51,
  morphStart: 165,
  morphFrames: 13,
  ruleSweepFrames: 3,
  digitGrowFrames: 9,
  cardCut: 278,
  cardHoldEnd: 632,
  blackTail: 9,
};

/** The pixel gate's coda checkpoints (t), one per coda scene at a clean hold. */
const CODA_PINS = [4487, 4567, 4677, 4847, 5102];

/** The HD card: the still band at 4x, and where the HD glyph pair lands. */
const CARD_WIDTH = 2560;
const CARD_HEIGHT = 480;
const HD_GLYPH_W = 136; // 17 canvas px = 34 hires columns, x4
const HD_GLYPH_H = 100; // 25 canvas rows of 120, x4
const HD_GAP = 32;
const HD_RIGHT = 2520;
const HD_BASELINE = 400;

/** The text scene's four flats, palette indices 0..3 of the 2-bit canvas. */
const TEXT_FLATS = [
  [0, 0, 0, 0],
  [0x99, 0x88, 0x88, 255],
  [0xff, 0xff, 0xff, 255],
  [0x66, 0x55, 0x44, 255],
];

const MANIFEST_SCHEMA = "pinball-illusions/intro-hd/v1";
const HD_FILE = "intro-hd.png";
const HD_MANIFEST = "intro-hd.json";

const PROVENANCE = {
  sourceClass: "disk-derived-intro-hd",
  description:
    "The boot-intro coda's HD title card: the PINBALL ILLUSIONS still from `intro.bin` " +
    "(HAM8 640x120) decoded and upscaled 4x by the project's measured recipe (exact-checkerboard " +
    "de-dither + xBRZ), with an 'HD' composed from the intro's own ENHANCED glyphs, upscaled the " +
    "same way. A transformation of disk-rendered art, shipped behind the same authorization gate " +
    "as every other disk-derived class.",
  authorizationRequired: true,
};

// ---------------------------------------------------------------------------
// Shared byte helpers
// ---------------------------------------------------------------------------

const readU16 = (bytes, at) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const writeU16 = (bytes, at, value) => {
  bytes[at] = (value >> 8) & 0xff;
  bytes[at + 1] = value & 0xff;
};

// ---------------------------------------------------------------------------
// The glyph cut: deltas 1..172 walked into one cumulative canvas
// ---------------------------------------------------------------------------

function unpackInto(h1, srcAt, into, dstAt) {
  let src = srcAt;
  let dst = dstAt;
  const groups = readU16(h1, src) + 1;
  src += 2;
  for (let group = 0; group < groups; group += 1) {
    const control = h1[src] ?? 0;
    src += 1;
    if (control === 0) {
      dst += readU16(h1, src);
      src += 2;
    } else if ((control & 0x80) !== 0) {
      const run = (control & 0x7f) + 1;
      into.set(h1.subarray(src, src + run), dst);
      src += run;
      dst += run;
    } else {
      into.fill(h1[src] ?? 0, dst, dst + control);
      src += 1;
      dst += control;
    }
  }
  return src;
}

const canvasValue = (planes, planeStride, x, y) => {
  const at = y * (CODA.canvasWidth >> 3) + (x >> 3);
  const bit = 7 - (x & 7);
  return (((planes[at] ?? 0) >> bit) & 1) | ((((planes[planeStride + at] ?? 0) >> bit) & 1) << 1);
};

function cutGlyph(planes, planeStride, [x0, y0, w, h]) {
  const v = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) v[y * w + x] = canvasValue(planes, planeStride, x0 + x, y0 + y);
  }
  return { w, h, v };
}

const glyphPixels = (g) => g.v.reduce((n, value) => n + (value !== 0 ? 1 : 0), 0);

function rot180(g) {
  const v = new Uint8Array(g.w * g.h);
  for (let y = 0; y < g.h; y += 1) {
    for (let x = 0; x < g.w; x += 1) v[y * g.w + x] = g.v[(g.h - 1 - y) * g.w + (g.w - 1 - x)];
  }
  return { w: g.w, h: g.h, v };
}

function stretchBowl(g, bowlRows) {
  const v = new Uint8Array(g.w * g.h);
  for (let y = 0; y < g.h; y += 1) {
    const src = Math.min(bowlRows - 1, Math.floor((y * bowlRows) / g.h));
    for (let x = 0; x < g.w; x += 1) v[y * g.w + x] = g.v[src * g.w + x];
  }
  return { w: g.w, h: g.h, v };
}

/**
 * Walks the delta stream and cuts everything the coda and the card need.
 * FATAL if any snapshot's contents disagree with the decode's measured facts —
 * a drifted rect must refuse, not ship a smeared glyph.
 */
function cutCodaGlyphs(manifest, h1) {
  const stream = manifest.streams.find((s) => s.frames !== undefined);
  if (stream === undefined) throw new Error("no text-anim stream");
  const { size, planeStride } = manifest.anim;
  const canvas = new Uint8Array(size);
  let at = stream.at;
  const out = {};
  for (let delta = 1; delta <= CODA.adPageDelta; delta += 1) {
    at = unpackInto(h1, at, canvas, 0);
    if (delta === CODA.digitsDelta) {
      out.digit9 = cutGlyph(canvas, planeStride, CODA.rect9);
      out.digit2 = cutGlyph(canvas, planeStride, CODA.rect2);
    } else if (delta === CODA.enhancedDelta) {
      out.glyphH = cutGlyph(canvas, planeStride, CODA.rectH);
      out.glyphD = cutGlyph(canvas, planeStride, CODA.rectD);
    } else if (delta === CODA.andNowDelta) {
      out.andNowPlanes = canvas.slice();
      out.animAt = at;
    } else if (delta === CODA.andNowDelta + CODA.letterDeltas) {
      const values = new Uint8Array(CODA.canvasWidth * CODA.canvasHeight);
      for (let y = 0; y < CODA.canvasHeight; y += 1) {
        for (let x = 0; x < CODA.canvasWidth; x += 1) {
          values[y * CODA.canvasWidth + x] = canvasValue(canvas, planeStride, x, y);
        }
      }
      out.yearPage = values;
    } else if (delta === CODA.adPageDelta) {
      out.ad = cutGlyph(canvas, planeStride, CODA.rectAd);
      out.rules = CODA.ruleRows.map((row) => {
        const line = new Uint8Array(CODA.canvasWidth);
        for (let x = 0; x < CODA.canvasWidth; x += 1) line[x] = canvasValue(canvas, planeStride, x, row);
        return line;
      });
    }
  }
  // The measured pixel counts of every cut, from the decode round. A stream
  // or rect that drifted produces different counts and must refuse.
  const expect = (name, got, want) => {
    if (got !== want) throw new Error(`glyph cut ${name}: ${got} pixels, expected ${want}`);
  };
  expect("9", glyphPixels(out.digit9), 1586);
  expect("2", glyphPixels(out.digit2), 1574);
  expect("H", glyphPixels(out.glyphH), 330);
  expect("D", glyphPixels(out.glyphD), 338);
  expect("AD", glyphPixels(out.ad), 268);
  for (const line of out.rules) {
    expect("rule", line.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0), CODA.canvasWidth);
  }
  out.digit0 = stretchBowl(out.digit9, CODA.bowlRows);
  out.digit6 = rot180(out.digit9);
  return out;
}

// ---------------------------------------------------------------------------
// The morph — same authored composition as the player's
// ---------------------------------------------------------------------------

function blitGlyph(page, g, x0, y0, rows) {
  const h = rows ?? g.h;
  const top = y0 + Math.round((g.h - h) / 2);
  for (let y = 0; y < h; y += 1) {
    const src = rows === undefined ? y : Math.min(g.h - 1, Math.floor((y * g.h) / h));
    for (let x = 0; x < g.w; x += 1) {
      const value = g.v[src * g.w + x];
      if (value !== 0) page[(top + y) * CODA.canvasWidth + (x0 + x)] = value;
    }
  }
}

function codaMorphValues(glyphs, k) {
  const page = new Uint8Array(CODA.canvasWidth * CODA.canvasHeight);
  const rules = (cols) => {
    for (let i = 0; i < CODA.ruleRows.length; i += 1) {
      const row = CODA.ruleRows[i];
      const line = glyphs.rules[i];
      for (let x = 0; x < cols; x += 1) page[row * CODA.canvasWidth + x] = line[x];
    }
  };
  if (k <= CODA.ruleSweepFrames) {
    page.set(glyphs.yearPage);
    rules(Math.ceil((CODA.canvasWidth * k) / CODA.ruleSweepFrames));
    return page;
  }
  rules(CODA.canvasWidth);
  const digitFor = (which) =>
    which === "0" ? glyphs.digit0 : which === "6" ? glyphs.digit6 : glyphs.digit2;
  const step = Math.min(CODA.digitGrowFrames, k - CODA.ruleSweepFrames);
  for (const [x, top, which] of CODA.digitAt) {
    const digit = digitFor(which);
    const rows = Math.max(1, Math.round((digit.h * step) / CODA.digitGrowFrames));
    blitGlyph(page, digit, x, top, rows === digit.h ? undefined : rows);
  }
  if (k >= CODA.morphFrames) blitGlyph(page, glyphs.ad, CODA.adAt[0], CODA.adAt[1]);
  return page;
}

// ---------------------------------------------------------------------------
// THE INDEPENDENT PLAYER — a JS transliteration of research/intro/render.py's
// machinery (which src/browser/intro.ts also ports), plus the coda. It shares
// no code with the browser core; the pixel gate compares the two byte for
// byte, which is the whole point of rendering the references here.
// ---------------------------------------------------------------------------

class ReferencePlayer {
  constructor({ manifest, data, copper }) {
    this.manifest = manifest;
    this.h1 = data;
    this.h2 = Uint8Array.from(copper);
    this.h4 = new Uint8Array(manifest.screen.bytes);
    this.t = 0;
    this.coplc = 0;
    this.animAt = manifest.streams.find((s) => s.frames !== undefined).at;
    this.bufA = manifest.anim.bufA;
    this.bufB = manifest.anim.bufB;
    this.fadeByAt = new Map(manifest.fades.map((table) => [table.at, table]));
    this.streamByName = new Map(manifest.streams.map((stream) => [stream.name, stream]));
    this.listByAt = new Map(manifest.lists.map((list) => [list.at, list]));
    this.finished = false;
    this.run = this.script();
  }

  step() {
    if (this.finished) return false;
    if (this.run.next().done === true) this.finished = true;
    return !this.finished;
  }

  *frame() {
    this.t += 1;
    yield;
  }

  *script() {
    const { script, ops } = this.manifest;
    const stillByOp = new Map(this.manifest.stills.map((still) => [still.op, still]));
    const backdropByOp = new Map(this.manifest.backdrops.map((entry) => [entry.op, entry]));
    const textFadeByOp = new Map(this.manifest.textFades.map((entry) => [entry.op, entry]));
    let index = 0;
    while (index < script.length) {
      yield* this.frame();
      const entry = script[index];
      if (entry === undefined) break;
      const [startT, op] = entry;
      if (this.t < startT) continue;
      index += 1;
      if (op === ops.intEnable) {
        // Interrupts on.
      } else if (op === ops.anim) {
        this.animFrame();
      } else if (op === ops.credits) {
        yield* this.credits();
      } else if (op === ops.exit) {
        yield* this.coda();
        return;
      } else if (backdropByOp.has(op)) {
        yield* this.showBackdrop(backdropByOp.get(op).fade);
      } else if (stillByOp.has(op)) {
        yield* this.still(stillByOp.get(op));
      } else if (textFadeByOp.has(op)) {
        const textFade = textFadeByOp.get(op);
        if (textFade.set) this.pset(textFade.fade);
        else yield* this.fade(textFade.fade);
      } else {
        throw new Error(`unknown handler 0x${op.toString(16)}`);
      }
    }
  }

  unpack(srcAt, dstAt) {
    return unpackInto(this.h1, srcAt, this.h4, dstAt);
  }

  requireFade(at) {
    const table = this.fadeByAt.get(at);
    if (table === undefined) throw new Error(`no fade table 0x${at.toString(16)}`);
    return table;
  }

  fadePass(table) {
    for (const [src, dst, step, count] of table.quads) {
      for (let i = 0; i < count; i += 1) {
        const target = readU16(this.h1, src + 2 * i);
        const current = readU16(this.h2, dst + step * i);
        let out = 0;
        for (const shift of [0, 4, 8]) {
          const want = (target >> shift) & 0xf;
          let gun = (current >> shift) & 0xf;
          if (gun < want) gun += 1;
          else if (gun > want) gun -= 1;
          out |= gun << shift;
        }
        writeU16(this.h2, dst + step * i, out);
      }
    }
  }

  *fade(at) {
    const table = this.requireFade(at);
    for (let pass = 0; pass < table.repeats; pass += 1) {
      yield* this.frame();
      this.fadePass(table);
    }
  }

  pset(at) {
    const table = this.requireFade(at);
    for (const [src, dst, step, count] of table.quads) {
      for (let i = 0; i < count; i += 1) {
        writeU16(this.h2, dst + step * i, readU16(this.h1, src + 2 * i));
      }
    }
  }

  pokePlanes(slot, baseOffset, stride, planes) {
    let at = slot;
    let address = H4_BASE + baseOffset;
    for (let plane = 0; plane < planes; plane += 1) {
      writeU16(this.h2, at, (address >>> 16) & 0xffff);
      writeU16(this.h2, at + 4, address & 0xffff);
      at += 8;
      address += stride;
    }
  }

  requireStream(name) {
    const stream = this.streamByName.get(name);
    if (stream === undefined) throw new Error(`no stream ${name}`);
    return stream;
  }

  animFrame() {
    const { size, planeStride, textSlot } = this.manifest.anim;
    this.h4.copyWithin(this.bufA, this.bufB, this.bufB + size);
    const shown = this.bufA;
    this.bufA = this.bufB;
    this.bufB = shown;
    this.animAt = this.unpack(this.animAt, this.bufB);
    this.pokePlanes(textSlot, this.bufB, planeStride, 2);
  }

  *showBackdrop(fadeAt) {
    const backdrop = this.manifest.backdrop;
    const { planeStride, textSlot } = this.manifest.anim;
    this.unpack(this.requireStream(backdrop.stream).at, backdrop.dst);
    this.pokePlanes(textSlot, this.bufB, planeStride, 2);
    this.pokePlanes(backdrop.slot, backdrop.dst, backdrop.planeStride, backdrop.planes);
    this.coplc = backdrop.list;
    yield* this.fade(fadeAt);
  }

  *still(still) {
    this.unpack(this.requireStream(still.stream).at, this.manifest.stillDst);
    this.pokePlanes(still.slot, this.manifest.stillDst, still.stride, 8);
    yield* this.fade(still.fade);
    this.coplc = still.list;
  }

  *credits() {
    const credits = this.manifest.credits;
    const pages = credits.pages;
    this.unpack(this.requireStream(credits.clouds.stream).at, credits.clouds.dst);
    this.unpack(this.requireStream(pages[0]).at, credits.overlayA.dst);
    this.unpack(this.requireStream(pages[1]).at, credits.overlayB.dst);
    this.pokePlanes(credits.clouds.slot, credits.clouds.dst, credits.clouds.planeStride, credits.clouds.planes);
    this.pokePlanes(credits.overlayA.slot, credits.overlayA.dst, credits.overlayA.planeStride, credits.overlayA.planes);
    this.pokePlanes(credits.overlayB.slot, credits.overlayB.dst, credits.overlayB.planeStride, credits.overlayB.planes);
    this.coplc = credits.list;
    this.pset(credits.whiteSet);
    yield* this.fade(credits.cloudsFade);
    yield* this.wait(credits.firstWait);
    yield* this.fade(credits.showA);
    yield* this.wait(credits.pageWait);
    yield* this.fade(credits.showB);
    for (let page = 2; page < pages.length; page += 1) {
      const hidden = page % 2 === 0 ? credits.overlayA : credits.overlayB;
      this.unpack(this.requireStream(pages[page]).at, hidden.dst);
      yield* this.wait(credits.pageWait);
      yield* this.fade(page % 2 === 0 ? credits.showA : credits.showB);
    }
    yield* this.wait(credits.pageWait);
    yield* this.fade(credits.cloudsFade);
    yield* this.wait(credits.pageWait);
    yield* this.fade(credits.blackFade);
  }

  *wait(span) {
    const until = this.t + span;
    while (this.t < until) yield* this.frame();
  }

  *until(t) {
    while (this.t < t) yield* this.frame();
  }

  // -- the coda, mirroring src/browser/intro.ts's #coda step for step --------

  codaBlackenTextList() {
    const h2 = this.h2;
    let at = this.manifest.backdrop.list;
    while (at + 4 <= h2.length) {
      const first = readU16(h2, at);
      const second = readU16(h2, at + 2);
      if (first === 0xffff && second === 0xfffe) break;
      if ((first & 1) === 0) {
        const register = first & 0x1fe;
        if (register >= 0x180 && register <= 0x1be) writeU16(h2, at + 2, 0);
      }
      at += 4;
    }
  }

  codaCanvasFrame(values) {
    const { size, planeStride, textSlot } = this.manifest.anim;
    const shown = this.bufA;
    this.bufA = this.bufB;
    this.bufB = shown;
    const base = this.bufB;
    this.h4.fill(0, base, base + size);
    for (let y = 0; y < CODA.canvasHeight; y += 1) {
      for (let x = 0; x < CODA.canvasWidth; x += 1) {
        const value = values[y * CODA.canvasWidth + x];
        if (value === 0) continue;
        const at = base + y * (CODA.canvasWidth >> 3) + (x >> 3);
        const bit = 0x80 >> (x & 7);
        if ((value & 1) !== 0) this.h4[at] |= bit;
        if ((value & 2) !== 0) this.h4[at + planeStride] |= bit;
      }
    }
    this.pokePlanes(textSlot, this.bufB, planeStride, 2);
  }

  *coda() {
    const glyphs = cutCodaGlyphs(this.manifest, this.h1);
    const c = (frame) => CODA.startT + frame;
    yield* this.frame(); // c=0, black
    this.codaBlackenTextList();
    this.h4.set(glyphs.andNowPlanes, this.bufB);
    this.animAt = glyphs.animAt;
    yield* this.frame(); // c=1
    yield* this.showBackdrop(CODA.sceneInFade); // burns c=2..17
    yield* this.until(c(CODA.andNowHoldEnd));
    yield* this.fade(CODA.textOutFade); // burns c=52..67
    yield* this.frame(); // c=68
    this.animFrame(); // delta 151: the hidden 'i'
    yield* this.frame(); // c=69
    this.pset(CODA.textSetFade); // the pop
    for (let letter = 1; letter < CODA.letterDeltas; letter += 1) {
      yield* this.frame(); // c=70..77
      this.animFrame();
    }
    yield* this.until(c(CODA.morphStart - 1));
    for (let k = 1; k <= CODA.morphFrames; k += 1) {
      yield* this.frame(); // c=165..177
      this.codaCanvasFrame(codaMorphValues(glyphs, k));
    }
    yield* this.until(c(CODA.cardCut));
    const still = this.manifest.stills.find((entry) => entry.stream === "still-illusions");
    if (still === undefined) throw new Error("no still-illusions handler");
    yield* this.still(still); // burns c=279..294; card from c=295
    yield* this.until(c(CODA.cardHoldEnd + 1));
    this.coplc = this.manifest.credits.list;
    this.pset(this.manifest.credits.whiteSet);
    yield* this.fade(this.manifest.credits.blackFade); // burns c=634..649
    yield* this.wait(CODA.blackTail); // ends at t=5105
  }

  // -- the rasteriser --------------------------------------------------------

  rgb() {
    const pixels = new Uint8Array(INTRO_WIDTH * INTRO_ROWS * 3);
    const meta = this.listByAt.get(this.coplc);
    if (meta === undefined || meta.kind !== "planar") return pixels;
    const { pal, planes } = this.walkList(this.coplc);
    const planeCount = meta.planes ?? 0;
    const rows = meta.rows ?? 0;
    const hires = meta.hires === true;
    const width = hires ? 640 : 320;
    const rowBytes = width >> 3;
    const indices = new Uint8Array(rows * width);
    for (let plane = 0; plane < planeCount; plane += 1) {
      const address = planes[plane] ?? 0;
      if (address === 0) continue;
      const offset = address - H4_BASE;
      if (offset < 0 || offset + rowBytes * rows > this.h4.length) continue;
      const bit = 1 << plane;
      for (let row = 0; row < rows; row += 1) {
        const rowAt = offset + row * rowBytes;
        const outAt = row * width;
        for (let byte = 0; byte < rowBytes; byte += 1) {
          const bits = this.h4[rowAt + byte];
          if (bits === 0) continue;
          for (let b = 0; b < 8; b += 1) {
            if ((bits & (0x80 >> b)) !== 0) indices[outAt + (byte << 3) + b] |= bit;
          }
        }
      }
    }
    const y0 = meta.y0 ?? 0;
    if (meta.ham === true) this.blitHam8(pixels, pal, indices, width, rows, y0, hires);
    else this.blitIndexed(pixels, pal, indices, width, rows, y0, hires);
    return pixels;
  }

  walkList(startAt) {
    const h2 = this.h2;
    const palHi = new Uint16Array(256);
    const palLo = new Int32Array(256).fill(-1);
    const planes = new Array(8).fill(0);
    let bank = 0;
    let loct = false;
    let at = startAt;
    while (at + 4 <= h2.length) {
      const first = readU16(h2, at);
      const second = readU16(h2, at + 2);
      if (first === 0xffff && second === 0xfffe) break;
      if ((first & 1) === 0) {
        const register = first & 0x1fe;
        if (register === 0x106) {
          bank = (second >> 13) & 7;
          loct = (second & 0x200) !== 0;
        } else if (register >= 0x180 && register <= 0x1be) {
          const index = bank * 32 + ((register - 0x180) >> 1);
          if (loct) palLo[index] = second;
          else palHi[index] = second;
        } else if (register >= 0xe0 && register <= 0xfe) {
          const plane = (register - 0xe0) >> 2;
          if (register % 4 === 0) planes[plane] |= second << 16;
          else planes[plane] |= second;
        }
      }
      at += 4;
    }
    const pal = new Uint8Array(256 * 3);
    for (let index = 0; index < 256; index += 1) {
      const hi = palHi[index];
      const loWord = palLo[index];
      const lo = loWord === -1 ? hi : loWord;
      pal[index * 3] = (((hi >> 8) & 0xf) << 4) | ((lo >> 8) & 0xf);
      pal[index * 3 + 1] = (((hi >> 4) & 0xf) << 4) | ((lo >> 4) & 0xf);
      pal[index * 3 + 2] = ((hi & 0xf) << 4) | (lo & 0xf);
    }
    return { pal, planes };
  }

  blitIndexed(out, pal, indices, width, rows, y0, hires) {
    for (let row = 0; row < rows; row += 1) {
      let at = (y0 + row) * INTRO_WIDTH * 3;
      const rowStart = row * width;
      for (let x = 0; x < width; x += 1) {
        const palAt = indices[rowStart + x] * 3;
        const r = pal[palAt];
        const g = pal[palAt + 1];
        const b = pal[palAt + 2];
        out[at] = r;
        out[at + 1] = g;
        out[at + 2] = b;
        at += 3;
        if (!hires) {
          out[at] = r;
          out[at + 1] = g;
          out[at + 2] = b;
          at += 3;
        }
      }
    }
  }

  blitHam8(out, pal, indices, width, rows, y0, hires) {
    for (let row = 0; row < rows; row += 1) {
      let r = pal[0];
      let g = pal[1];
      let b = pal[2];
      let at = (y0 + row) * INTRO_WIDTH * 3;
      const rowStart = row * width;
      for (let x = 0; x < width; x += 1) {
        const index = indices[rowStart + x];
        const control = index & 3;
        const value = index >> 2;
        if (control === 0) {
          const palAt = value * 3;
          r = pal[palAt];
          g = pal[palAt + 1];
          b = pal[palAt + 2];
        } else if (control === 1) {
          b = (value << 2) | (b & 3);
        } else if (control === 2) {
          r = (value << 2) | (r & 3);
        } else {
          g = (value << 2) | (g & 3);
        }
        out[at] = r;
        out[at + 1] = g;
        out[at + 2] = b;
        at += 3;
        if (!hires) {
          out[at] = r;
          out[at + 1] = g;
          out[at + 2] = b;
          at += 3;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The HD card
// ---------------------------------------------------------------------------

/** The ILLUSIONS still decoded to 640x120 RGB through its own list's palette. */
function decodeIllusionsStill(assets) {
  const { manifest, data } = assets;
  const still = manifest.stills.find((entry) => entry.stream === "still-illusions");
  if (still === undefined) throw new Error("no still-illusions handler");
  const stream = manifest.streams.find((entry) => entry.name === "still-illusions");
  const unpacked = new Uint8Array(still.stride * 8);
  unpackInto(data, stream.at, unpacked, 0);
  // A throwaway player instance provides the list walker over PRISTINE h2 —
  // no fade has run, which is also the state the coda's cut shows the card in.
  const player = new ReferencePlayer(assets);
  const { pal } = player.walkList(still.list);
  const rowBytes = 640 >> 3;
  const rows = still.stride / rowBytes;
  if (rows !== 120) throw new Error(`still stride gives ${rows} rows, expected 120`);
  const indices = new Uint8Array(640 * rows);
  for (let plane = 0; plane < 8; plane += 1) {
    const bit = 1 << plane;
    for (let row = 0; row < rows; row += 1) {
      const rowAt = plane * still.stride + row * rowBytes;
      for (let byte = 0; byte < rowBytes; byte += 1) {
        const bits = unpacked[rowAt + byte];
        if (bits === 0) continue;
        const outAt = row * 640 + (byte << 3);
        for (let b = 0; b < 8; b += 1) {
          if ((bits & (0x80 >> b)) !== 0) indices[outAt + b] |= bit;
        }
      }
    }
  }
  const rgb = new Uint8Array(640 * rows * 3);
  for (let row = 0; row < rows; row += 1) {
    let r = pal[0];
    let g = pal[1];
    let b = pal[2];
    for (let x = 0; x < 640; x += 1) {
      const index = indices[row * 640 + x];
      const control = index & 3;
      const value = index >> 2;
      if (control === 0) {
        r = pal[value * 3];
        g = pal[value * 3 + 1];
        b = pal[value * 3 + 2];
      } else if (control === 1) {
        b = (value << 2) | (b & 3);
      } else if (control === 2) {
        r = (value << 2) | (r & 3);
      } else {
        g = (value << 2) | (g & 3);
      }
      const at = (row * 640 + x) * 3;
      rgb[at] = r;
      rgb[at + 1] = g;
      rgb[at + 2] = b;
    }
  }
  return rgb;
}

/** One 17x25 text glyph -> 136x100 RGBA: xBRZ 4x, then NN 2x horizontally
 * (canvas pixels are lores — two hires columns each — so the card needs 8x
 * across and 4x down). */
function hdGlyph(glyph) {
  const rgba = new Uint8Array(glyph.w * glyph.h * 4);
  for (let i = 0; i < glyph.v.length; i += 1) {
    const flat = TEXT_FLATS[glyph.v[i]];
    rgba[i * 4] = flat[0];
    rgba[i * 4 + 1] = flat[1];
    rgba[i * 4 + 2] = flat[2];
    rgba[i * 4 + 3] = flat[3];
  }
  const scaled = xbrzScaleRgba(rgba, glyph.w, glyph.h); // 68x100
  const w4 = glyph.w * 4;
  const h4 = glyph.h * 4;
  const out = new Uint8Array(w4 * 2 * h4 * 4);
  for (let y = 0; y < h4; y += 1) {
    for (let x = 0; x < w4; x += 1) {
      const from = (y * w4 + x) * 4;
      for (const dx of [0, 1]) {
        const to = (y * w4 * 2 + x * 2 + dx) * 4;
        out[to] = scaled[from];
        out[to + 1] = scaled[from + 1];
        out[to + 2] = scaled[from + 2];
        out[to + 3] = scaled[from + 3];
      }
    }
  }
  return { w: w4 * 2, h: h4, rgba: out };
}

function buildHdCard(assets, glyphs) {
  const native = decodeIllusionsStill(assets);
  const { rgb: flat } = deditherRgb(native, 640, 120);
  const card = xbrzScaleRgb(flat, 640, 120); // 2560x480
  const h = hdGlyph(glyphs.glyphH);
  const d = hdGlyph(glyphs.glyphD);
  if (h.w !== HD_GLYPH_W || h.h !== HD_GLYPH_H) {
    throw new Error(`HD glyph is ${h.w}x${h.h}, expected ${HD_GLYPH_W}x${HD_GLYPH_H}`);
  }
  const composite = (glyph, x0, y0) => {
    for (let y = 0; y < glyph.h; y += 1) {
      for (let x = 0; x < glyph.w; x += 1) {
        const from = (y * glyph.w + x) * 4;
        if (glyph.rgba[from + 3] < 128) continue; // hard rim, the fonts' own rule
        const to = ((y0 + y) * CARD_WIDTH + x0 + x) * 3;
        card[to] = glyph.rgba[from];
        card[to + 1] = glyph.rgba[from + 1];
        card[to + 2] = glyph.rgba[from + 2];
      }
    }
  };
  const top = HD_BASELINE - HD_GLYPH_H;
  composite(h, HD_RIGHT - HD_GLYPH_W * 2 - HD_GAP, top);
  composite(d, HD_RIGHT - HD_GLYPH_W, top);
  return encodePng(card, CARD_WIDTH, CARD_HEIGHT, 3);
}

// ---------------------------------------------------------------------------
// The reference frames
// ---------------------------------------------------------------------------

function renderCodaPins(assets) {
  const player = new ReferencePlayer(assets);
  const wanted = new Set(CODA_PINS);
  const frames = new Map();
  let blackAt4446 = false;
  while (player.step()) {
    if (player.t === 4446) {
      blackAt4446 = player.rgb().every((byte) => byte === 0);
    }
    if (wanted.has(player.t)) {
      const rgb = player.rgb();
      const doubled = new Uint8Array(INTRO_WIDTH * INTRO_ROWS * 2 * 3);
      for (let row = 0; row < INTRO_ROWS * 2; row += 1) {
        doubled.set(
          rgb.subarray((row >> 1) * INTRO_WIDTH * 3, ((row >> 1) + 1) * INTRO_WIDTH * 3),
          row * INTRO_WIDTH * 3,
        );
      }
      frames.set(player.t, encodePng(doubled, INTRO_WIDTH, INTRO_ROWS * 2, 3));
    }
  }
  // Fatal self-checks: the show must still end black at t=4446, the coda must
  // end at exactly t=5105 on black, and every pin must have been reached.
  if (!blackAt4446) throw new Error("the original show does not end on black at t=4446");
  if (player.t !== CODA.endT) throw new Error(`the coda ends at t=${player.t}, expected ${CODA.endT}`);
  if (!player.rgb().every((byte) => byte === 0)) throw new Error("the coda does not end on black");
  for (const pin of CODA_PINS) {
    if (!frames.has(pin)) throw new Error(`pin t=${pin} was never rendered`);
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const check = argv.includes("--check");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const segmentDir = positional[0];
  const outDir = positional[1] ?? "public/generated/shell/intro";
  if (segmentDir === undefined) {
    console.error("usage: node scripts/export-intro-coda.mjs <segment-dir> [out-dir] [--check]");
    return 2;
  }
  const codaFramesDir = fileURLToPath(
    new URL("../../research/view/intro/coda-frames/", import.meta.url),
  );

  const assets = decodeIntro(segmentDir);
  const glyphs = cutCodaGlyphs(assets.manifest, assets.data);
  const png = buildHdCard(assets, glyphs);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    scale: 4,
    card: { y0: 32, rows: 120 },
    image: {
      file: HD_FILE,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      byteLength: png.length,
      sha256: sha256(png),
    },
    hd: { tool: XBRZ_TOOL, dedither: "exact-checkerboard prepass" },
    source: {
      file: "intro-data.bin",
      sha256: sha256(assets.data),
      still: "still-illusions",
      glyphs: "text-anim deltas 1..149 (ENHANCED H at 115,47 and D at 246,47, 17x25 each)",
    },
    coda: { startT: CODA.startT, endT: CODA.endT, pins: CODA_PINS },
    provenance: PROVENANCE,
  };
  const json = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const frames = renderCodaPins(assets);

  console.log(check ? "checking intro coda" : "exporting intro coda");
  if (!check) {
    mkdirSync(outDir, { recursive: true });
    mkdirSync(codaFramesDir, { recursive: true });
  }

  let failures = 0;
  const emit = (dir, name, bytes) => {
    const path = join(dir, name);
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

  emit(outDir, HD_FILE, png);
  emit(outDir, HD_MANIFEST, json);
  for (const [t, bytes] of frames) {
    emit(codaFramesDir, `c${String(t - CODA.startT).padStart(4, "0")}.png`, bytes);
  }
  console.log(
    `  ${" ".repeat(18)}  coda t=${CODA.startT}..${CODA.endT} ` +
      `(${((CODA.endT - CODA.startT + 1) / 50).toFixed(2)} s), card ${CARD_WIDTH}x${CARD_HEIGHT}, ` +
      `${frames.size} reference frames`,
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
