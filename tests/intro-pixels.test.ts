/**
 * THE INTRO PIXEL GATE: the player's canvas against the reference render.
 *
 * `research/intro/render.py` is the frame-accurate reference implementation of
 * the intro — the one whose output was verified against session 3's boot film
 * at t = film + 1067 within ±2 frames — and `research/view/intro/frames/`
 * holds its every-25th-frame PNGs. `src/browser/intro.ts` claims to be a
 * statement-for-statement port of it, and a claim like that is checkable, so
 * this file checks it: the core is driven to ten checkpoint frames spanning
 * every scene type the show has, and each rasterised 640x240 frame — rows
 * doubled to the reference's 640x480 — must equal the reference PNG BYTE FOR
 * BYTE. Not a similarity metric: the two implementations share their exact
 * integer arithmetic (the three-opcode unpacker, the nibble fader, the AGA
 * palette combine, HAM8), so any inequality at all is a porting bug.
 *
 * THE 2026 SPLICE moved the coda from behind the credits into the
 * announcement arc: it now plays at the credits dispatch (t=2891), between
 * the ILLUSIONS logo's own hold and the credits, so every original frame
 * AFTER the splice keeps its bytes and gains exactly +659 on its clock (the
 * coda's length; the show ends at 4446+659 = 5105). The reference PNGs are
 * still named by the ORIGINAL t they render; checkpoints after the splice
 * drive the core to t+659 and compare against the original-t file:
 *
 *   drive t  reference  what
 *   575      t0575      "wAY bACK" mid-write — text deltas + backdrop palette
 *   1350     t1350      PINBALL DREAMS still           (HIRES HAM8 640x120)
 *   1875     t1875      PINBALL FANTASIES still        (HIRES HAM8 640x120)
 *   2250     t2250      21st CENTURY still             (HIRES 8bpl 256c 640x201)
 *   2400     t2400      DIGITAL ILLUSIONS still        (LORES HAM8 320x240)
 *   2475     t2475      the gag card mid-write         (text scene, post-stills)
 *   2600     t2600      PINBALL ILLUSIONS still        (HIRES HAM8 640x120)
 *   3584     t2925      credits clouds fading in after the white flash (+659)
 *   3809     t3150      credits page 1 settled                         (+659)
 *   3959     t3300      credits page 1 -> 2, ONE FRAME INTO THE CROSSFADE — the
 *                       strictest palette-state checkpoint offered      (+659)
 *
 * The frames live in the operator's research tree beside this repo and are not
 * part of the build, so the whole suite skips — loudly — where that tree is
 * absent. On the machine the round runs on, it runs.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { IntroCore, INTRO_ROWS, INTRO_WIDTH, introManifestFrom } from "../src/browser/intro.js";
import type { IntroAssets } from "../src/browser/intro.js";

const INTRO_DIR = fileURLToPath(new URL("../public/generated/shell/intro/", import.meta.url));
const FRAMES_DIR = fileURLToPath(new URL("../../research/view/intro/frames/", import.meta.url));

const exported = existsSync(`${INTRO_DIR}intro.json`);
const filmed = existsSync(`${FRAMES_DIR}t0575.png`);

function loadShippedAssets(): IntroAssets {
  const manifest = introManifestFrom(
    JSON.parse(readFileSync(`${INTRO_DIR}intro.json`, "utf8")) as unknown,
  );
  return {
    manifest,
    data: new Uint8Array(readFileSync(`${INTRO_DIR}intro-data.bin`)),
    copper: new Uint8Array(readFileSync(`${INTRO_DIR}intro-copper.bin`)),
  };
}

// ---------------------------------------------------------------------------
// A PNG reader for the reference frames: 8-bit RGB, any of the five filters.
// Small and local on purpose — the repo ships no image dependency, and the
// build's own PNGs go through `decodeIndexedPng`; these reference frames are
// truecolour, which nothing in src/ needs to read.
// ---------------------------------------------------------------------------

function decodeRgbPng(bytes: Buffer): { width: number; height: number; rgb: Uint8Array } {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const tag = bytes.toString("latin1", at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (tag === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 2) {
        throw new Error(`reference frame is not 8-bit RGB (depth ${body[8]}, colour ${body[9]})`);
      }
      if (body[12] !== 0) throw new Error("interlaced reference frame");
    } else if (tag === "IDAT") {
      idat.push(body);
    } else if (tag === "IEND") {
      break;
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const rgb = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)] ?? 0;
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const out = row * stride;
    const prior = out - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = line[x] ?? 0;
      const left = x >= 3 ? (rgb[out + x - 3] ?? 0) : 0;
      const up = row > 0 ? (rgb[prior + x] ?? 0) : 0;
      const upLeft = row > 0 && x >= 3 ? (rgb[prior + x - 3] ?? 0) : 0;
      let recon = value;
      if (filter === 1) recon = value + left;
      else if (filter === 2) recon = value + up;
      else if (filter === 3) recon = value + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        recon = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else if (filter !== 0) {
        throw new Error(`unsupported PNG filter ${filter}`);
      }
      rgb[out + x] = recon & 0xff;
    }
  }
  return { width, height, rgb };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** [drive t, reference-file t]: post-splice checkpoints drive to t+659. */
const CHECKPOINTS = [
  [575, 575],
  [1350, 1350],
  [1875, 1875],
  [2250, 2250],
  [2400, 2400],
  [2475, 2475],
  [2600, 2600],
  [3584, 2925],
  [3809, 3150],
  [3959, 3300],
] as const;

describe.skipIf(!exported || !filmed)(
  "the intro player, byte-identical to the reference render",
  () => {
    it("matches every checkpoint frame exactly", () => {
      const core = new IntroCore(loadShippedAssets());
      let mismatches = 0;
      for (const [checkpoint, referenceT] of CHECKPOINTS) {
        while (core.t < checkpoint) {
          if (!core.step()) throw new Error(`show ended at t=${core.t} before checkpoint ${checkpoint}`);
        }
        expect(core.t).toBe(checkpoint);
        const reference = decodeRgbPng(
          readFileSync(`${FRAMES_DIR}t${String(referenceT).padStart(4, "0")}.png`),
        );
        expect(reference.width).toBe(INTRO_WIDTH);
        expect(reference.height).toBe(INTRO_ROWS * 2);
        const rendered = core.rgb();
        // The reference PNGs double every row (640x240 -> 640x480 square
        // pixels); compare both copies so a half-row error cannot hide.
        let firstDiff = -1;
        for (let row = 0; row < INTRO_ROWS * 2 && firstDiff < 0; row += 1) {
          const ours = (row >> 1) * INTRO_WIDTH * 3;
          const theirs = row * INTRO_WIDTH * 3;
          for (let x = 0; x < INTRO_WIDTH * 3; x += 1) {
            if (rendered[ours + x] !== reference.rgb[theirs + x]) {
              firstDiff = theirs + x;
              break;
            }
          }
        }
        if (firstDiff >= 0) {
          mismatches += 1;
          const pixel = Math.floor(firstDiff / 3);
          expect.soft(firstDiff, `t=${checkpoint} first differing byte (pixel x=${pixel % INTRO_WIDTH}, y=${Math.floor(pixel / INTRO_WIDTH)})`).toBe(-1);
        }
      }
      expect(mismatches).toBe(0);
    });

    it("hands the coda to the credits at t=3550: card to the last frame, then the flash", () => {
      // The seam-out pin (the equivalent of the retired "original black at
      // t=4446" probe, whose event moved to the show's end below): the coda's
      // card must hold through its very last frame, t=3550, and the credits'
      // own white flash — the original's leaving of this logo, the coda's
      // exit — must land on the next frame, t=3551: the 120-row band (canvas
      // rows 32..151) all white, the borders black.
      const core = new IntroCore(loadShippedAssets());
      while (core.t < 3550) {
        if (!core.step()) throw new Error(`show ended at t=${core.t} before the coda's last frame`);
      }
      expect(core.t).toBe(3550);
      expect(core.codaCard).toBe(true); // the HD overlay window is still open
      core.step();
      expect(core.t).toBe(3551);
      expect(core.codaCard).toBe(false); // and the credits closed it
      const flash = core.rgb();
      for (let row = 0; row < INTRO_ROWS; row += 1) {
        const want = row >= 32 && row < 152 ? 0xff : 0x00;
        for (let at = row * INTRO_WIDTH * 3; at < (row + 1) * INTRO_WIDTH * 3; at += 1) {
          if (flash[at] !== want) {
            throw new Error(`t=3551 is not the credits white flash at byte ${at} (row ${row})`);
          }
        }
      }
    });

    it("plays the spliced show to its exit dispatch at t=5105, on black", () => {
      // The original's exit dispatch, 88.9 s in INTRO_DECODE §6, shifted by
      // the coda's 659 frames: 4446 + 659 = 5105 (102.1 s), still on black —
      // the credits' own 16-pass fade to black is the show's last event.
      const core = new IntroCore(loadShippedAssets());
      let steps = 0;
      while (core.step()) {
        steps += 1;
        if (steps > 6000) throw new Error("the show never ends");
      }
      expect(core.t).toBe(5105);
      expect(core.finished).toBe(true);
      const final = core.rgb();
      expect(final.every((byte) => byte === 0)).toBe(true);
    });
  },
);

// ---------------------------------------------------------------------------
// The coda gate: the player against the exporter's INDEPENDENT render.
// `scripts/export-intro-coda.mjs` renders these frames with its own JS
// transliteration of the machinery (no code shared with src/browser/intro.ts),
// so byte-equality here pins the glyph cutting, the 0/6 syntheses, the morph,
// the fades and both seams against an implementation that cannot share a bug.
// c = t - 2892 since the splice; the pins moved with it (old t -> new t):
//
//   c=9    (new)         t=2901  seam-in: pass 8 of the 0xFE0 fade out of the
//                                whiteout's white — the splice's own grammar
//   c=40   4487 -> 2932  AND NOW hold
//   c=120  4567 -> 3012  iN tHE yEAR hold
//   c=230  4677 -> 3122  2026 AD hold
//   c=400  4847 -> 3292  the ILLUSIONS card mid-hold
//   c=658  5102 -> 3550  seam-out: the card's LAST frame (the old c=655 black
//                                tail is retired; the credits flash follows)
// ---------------------------------------------------------------------------

const CODA_START = 2892;
const CODA_PINS = [2901, 2932, 3012, 3122, 3292, 3550] as const;
const CODA_FRAMES_DIR = fileURLToPath(
  new URL("../../research/view/intro/coda-frames/", import.meta.url),
);
const codaFramed = existsSync(`${CODA_FRAMES_DIR}c0040.png`);

describe.skipIf(!exported || !codaFramed)(
  "the coda, byte-identical to the exporter's reference render",
  () => {
    it("matches every coda checkpoint frame exactly", () => {
      const core = new IntroCore(loadShippedAssets());
      let mismatches = 0;
      for (const checkpoint of CODA_PINS) {
        while (core.t < checkpoint) {
          if (!core.step()) throw new Error(`show ended at t=${core.t} before checkpoint ${checkpoint}`);
        }
        expect(core.t).toBe(checkpoint);
        const name = `c${String(checkpoint - CODA_START).padStart(4, "0")}.png`;
        const reference = decodeRgbPng(readFileSync(`${CODA_FRAMES_DIR}${name}`));
        expect(reference.width).toBe(INTRO_WIDTH);
        expect(reference.height).toBe(INTRO_ROWS * 2);
        const rendered = core.rgb();
        let firstDiff = -1;
        for (let row = 0; row < INTRO_ROWS * 2 && firstDiff < 0; row += 1) {
          const ours = (row >> 1) * INTRO_WIDTH * 3;
          const theirs = row * INTRO_WIDTH * 3;
          for (let x = 0; x < INTRO_WIDTH * 3; x += 1) {
            if (rendered[ours + x] !== reference.rgb[theirs + x]) {
              firstDiff = theirs + x;
              break;
            }
          }
        }
        if (firstDiff >= 0) {
          mismatches += 1;
          const pixel = Math.floor(firstDiff / 3);
          expect.soft(firstDiff, `t=${checkpoint} first differing byte (pixel x=${pixel % INTRO_WIDTH}, y=${Math.floor(pixel / INTRO_WIDTH)})`).toBe(-1);
        }
      }
      expect(mismatches).toBe(0);
    });
  },
);
