/**
 * The shell artwork loader, proven against the SHIPPED files.
 *
 * `table-art.test.ts` proves the PNG reader; this file proves that the assets
 * `scripts/export-shell-art.mjs` actually wrote — the ones in
 * public/generated/shell/ that the build ships — decode into the fonts and
 * strips the menudata decode measured. Every number asserted here (advances,
 * heights, strip geometry, palette words, sine range) is a measured constant
 * from `menudata.bin`, so a re-export that drifts breaks a test rather than a
 * screen.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import {
  FONT_ATLAS_WIDTH,
  SHELL_ART_BASE_PATH,
  SHELL_ART_MANIFEST,
  STRIP_HEIGHT,
  STRIP_WIDTH,
  alignShellText,
  loadShellArt,
  measureShellText,
  shellArtManifestFrom,
  shellFontFrom,
} from "../src/game/shell-art.js";
import type { ShellArt } from "../src/game/shell-art.js";
import { decodeIndexedPng } from "../src/game/table-art.js";
import type { TableArtFetch } from "../src/game/table-art.js";

const SHELL_DIR = fileURLToPath(new URL("../public/generated/shell/", import.meta.url));

const exported = existsSync(`${SHELL_DIR}${SHELL_ART_MANIFEST}`);

/** A fetch that serves the shipped files off disk, the way the site would. */
const diskFetch: TableArtFetch = (url) => {
  const name = url.slice(url.lastIndexOf("/") + 1);
  const path = `${SHELL_DIR}${name}`;
  if (!existsSync(path)) {
    return Promise.resolve({
      ok: false,
      status: 404,
      statusText: "not on disk",
      arrayBuffer: () => Promise.reject(new Error("missing")),
    });
  }
  const bytes = readFileSync(path);
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  });
};

async function loadShipped(): Promise<ShellArt> {
  return loadShellArt(diskFetch, SHELL_ART_BASE_PATH);
}

describe.skipIf(!exported)("the shipped shell artwork", () => {
  it("loads, and every image matches the digest its manifest records", async () => {
    const manifest = JSON.parse(readFileSync(`${SHELL_DIR}${SHELL_ART_MANIFEST}`, "utf8")) as {
      images: readonly { file: string; sha256: string }[];
      provenance: { sourceClass: string; authorizationRequired: boolean };
    };
    // The guard's own rule, applied here so a digest drift fails in CI and not
    // only at build time.
    expect(manifest.images).toHaveLength(5);
    for (const image of manifest.images) {
      const digest = createHash("sha256")
        .update(readFileSync(`${SHELL_DIR}${image.file}`))
        .digest("hex");
      expect(digest, image.file).toBe(image.sha256);
    }
    expect(manifest.provenance.sourceClass).toBe("disk-derived-shell-artwork");
    expect(manifest.provenance.authorizationRequired).toBe(true);

    const art = await loadShipped();
    expect(art.font1.glyphs).toHaveLength(128);
    expect(art.font2.glyphs).toHaveLength(256);
  });

  it("carries font1 with the measured metrics: T=14, 0=13, l=4, space=10, caps 19 tall", async () => {
    const art = await loadShipped();
    const glyph = (c: string) => art.font1.glyphs[c.charCodeAt(0)];
    expect(glyph("T")?.advance).toBe(14);
    expect(glyph("0")?.advance).toBe(13);
    expect(glyph("l")?.advance).toBe(4);
    expect(glyph(" ")?.advance).toBe(10);
    expect(glyph(" ")?.height).toBe(0);
    for (const c of "ABCT0123456789") {
      expect(glyph(c)?.height, `height of ${c}`).toBe(19);
    }
    // The comma sits low: a positive y-offset, near the baseline.
    expect(glyph(",")?.yOffset).toBe(16);
  });

  it("carries font2 with the ladder template's own advances: digits 7, comma 3", async () => {
    const art = await loadShipped();
    const glyph = (c: string) => art.font2.glyphs[c.charCodeAt(0)];
    for (const c of "0123456789") expect(glyph(c)?.advance, `advance of ${c}`).toBe(7);
    expect(glyph(",")?.advance).toBe(3);
    // The template at main hunk-0 0x1836 computes the score column as
    // 300 - (3*commas + 7*digits); alignShellText must be the same sum.
    const score = "12,345,670";
    expect(measureShellText(art.font2, score)).toBe(3 * 2 + 7 * 8);
    expect(alignShellText(art.font2, score, 300, "right")).toBe(300 - (3 * 2 + 7 * 8));
  });

  it("centres with the original's truncating integer arithmetic", async () => {
    const art = await loadShipped();
    const word = "Tables";
    const width = measureShellText(art.font1, word);
    expect(width).toBeGreaterThan(0);
    expect(alignShellText(art.font1, word, 160, "center")).toBe(160 - Math.floor(width / 2));
    expect(alignShellText(art.font1, word, 160, "left")).toBe(160);
  });

  it("has glyph atlases whose rows are exactly the metric heights' sum", async () => {
    const art = await loadShipped();
    for (const font of [art.font1, art.font2]) {
      let rows = 0;
      for (const glyph of font.glyphs) rows += glyph.height;
      expect(rows).toBe(font.rows);
      expect(font.pixels).toHaveLength(FONT_ATLAS_WIDTH * font.rows);
    }
    // Two planes for font1, one for font2: the pixel values say so.
    expect(Math.max(...art.font1.pixels)).toBeGreaterThan(1);
    expect(Math.max(...art.font2.pixels)).toBe(1);
  });

  it("draws real letters: 'A' has ink in both planes, at its measured rows", async () => {
    const art = await loadShipped();
    const glyph = art.font1.glyphs["A".charCodeAt(0)];
    expect(glyph).toBeDefined();
    if (glyph === undefined) return;
    let fill = 0;
    let outline = 0;
    for (let r = glyph.top; r < glyph.top + glyph.height; r += 1) {
      for (let x = 0; x < FONT_ATLAS_WIDTH; x += 1) {
        const value = art.font1.pixels[r * FONT_ATLAS_WIDTH + x] ?? 0;
        if (value & 1) fill += 1;
        if (value & 2) outline += 1;
      }
    }
    expect(fill).toBeGreaterThan(30);
    expect(outline).toBeGreaterThan(10);
  });

  it("ships the three 1472x32 strips over the 16-colour palette, blue at 0", async () => {
    const art = await loadShipped();
    for (const role of ["attract", "menu", "select"] as const) {
      const strip = art.backdrops[role];
      expect(strip.pixels).toHaveLength(STRIP_WIDTH * STRIP_HEIGHT);
      // 4 bitplanes: nothing above 15, and the strip is not blank.
      expect(Math.max(...strip.pixels)).toBeLessThanOrEqual(15);
      expect(new Set(strip.pixels).size).toBeGreaterThan(4);
    }
    // Colour 0 is the AGA word 0x36A: nibbles spread to 51,102,170.
    expect([art.palette[0], art.palette[1], art.palette[2]]).toEqual([51, 102, 170]);
    expect(art.palette).toHaveLength(48);
  });

  it("ships the copper's sine (±64) and four dissolve permutations", async () => {
    const art = await loadShipped();
    expect(art.sine).toHaveLength(256);
    for (const value of art.sine) {
      expect(value).toBeGreaterThanOrEqual(-64);
      expect(value).toBeLessThanOrEqual(64);
    }
    expect(art.dissolve).toHaveLength(4);
    for (const order of art.dissolve) {
      expect(new Set(order).size).toBe(256);
    }
    // The first table is the linear reveal, which pins the table ORDER — the
    // renderer picks the shuffle by index.
    expect(art.dissolve[0]?.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(art.dissolve[2]?.slice(0, 4)).not.toEqual([0, 1, 2, 3]);
  });
});

describe("shell art validation", () => {
  it("refuses a manifest with the wrong schema", () => {
    expect(() => shellArtManifestFrom({ schema: "something-else" })).toThrow(/schema/);
  });

  it("refuses a manifest that is not an object", () => {
    expect(() => shellArtManifestFrom(null)).toThrow(/not an object/);
  });

  it("refuses metrics that disagree with the atlas height", async () => {
    const atlas = await decodeIndexedPng(tinyAtlasPng());
    // One glyph 2 rows tall against a 3-row atlas: off by one row.
    expect(() => shellFontFrom([[5, 2, 0]], atlas, "font1")).toThrow(/sum to 2/);
    // And the matching table is accepted.
    const font = shellFontFrom([[5, 3, 1]], atlas, "font1");
    expect(font.glyphs[0]).toEqual({ advance: 5, height: 3, yOffset: 1, top: 0 });
  });

  it("refuses an atlas that is not 16 px wide", async () => {
    const atlas = await decodeIndexedPng(tinyAtlasPng(8));
    expect(() => shellFontFrom([[5, 3, 0]], atlas, "font2")).toThrow(/16/);
  });
});

/** A minimal valid indexed PNG: `width` x 3, filter 0, two palette entries. */
function tinyAtlasPng(width = 16): Uint8Array {
  // Built with the same fixed-layout writer the exporter uses, inlined.
  const height = 3;
  const raw = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y += 1) raw[y * (1 + width) + 1] = 1;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const chunk = (tag: string, payload: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    // CRC left zero: the reader does not verify it, by design.
    return Buffer.concat([length, Buffer.from(tag, "latin1"), payload, Buffer.alloc(4)]);
  };
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("PLTE", Buffer.from([0, 0, 0, 255, 255, 255])),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
