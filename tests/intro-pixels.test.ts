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
 * The checkpoints, chosen as landmarks rather than round numbers:
 *
 *   t=575    "wAY bACK" mid-write — text deltas + backdrop palette (LORES 7bpl)
 *   t=1350   PINBALL DREAMS still           (HIRES HAM8 640x120)
 *   t=1875   PINBALL FANTASIES still        (HIRES HAM8 640x120)
 *   t=2250   21st CENTURY still             (HIRES 8bpl 256-colour 640x201)
 *   t=2400   DIGITAL ILLUSIONS still        (LORES HAM8 320x240)
 *   t=2475   the gag card mid-write         (text scene again, post-stills)
 *   t=2600   PINBALL ILLUSIONS still        (HIRES HAM8 640x120)
 *   t=2925   credits clouds fading in after the white flash (8bpl banks)
 *   t=3150   credits page 1 settled         (the bank compositor at rest)
 *   t=3300   credits page 1 -> 2, ONE FRAME INTO THE CROSSFADE — the
 *            strictest palette-state checkpoint the sampling offers
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

const CHECKPOINTS = [575, 1350, 1875, 2250, 2400, 2475, 2600, 2925, 3150, 3300] as const;

describe.skipIf(!exported || !filmed)(
  "the intro player, byte-identical to the reference render",
  () => {
    it("matches every checkpoint frame exactly", () => {
      const core = new IntroCore(loadShippedAssets());
      let mismatches = 0;
      for (const checkpoint of CHECKPOINTS) {
        while (core.t < checkpoint) {
          if (!core.step()) throw new Error(`show ended at t=${core.t} before checkpoint ${checkpoint}`);
        }
        expect(core.t).toBe(checkpoint);
        const reference = decodeRgbPng(
          readFileSync(`${FRAMES_DIR}t${String(checkpoint).padStart(4, "0")}.png`),
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

    it("runs the whole show to the scripted exit at t=4446", () => {
      const core = new IntroCore(loadShippedAssets());
      let steps = 0;
      while (core.step()) {
        steps += 1;
        if (steps > 6000) throw new Error("the show never ends");
      }
      // The exit entry is timed t=2892 but fires only after the credits
      // choreography returns at t=4445; it dispatches on the NEXT frame,
      // t=4446, which is INTRO_DECODE §6's own exit figure — 88.9 s.
      expect(core.t).toBe(4446);
      expect(core.finished).toBe(true);
      // And it ends on black: the last fade table's targets are all zero.
      const final = core.rgb();
      expect(final.every((byte) => byte === 0)).toBe(true);
    });
  },
);
