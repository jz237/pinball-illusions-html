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
  SHELL_PALETTE_COLOURS,
  SHELL_PALETTE_COUNT,
  SHELL_PALETTE_LIVE,
  STRIP_HEIGHT,
  STRIP_OBJECTS,
  STRIP_PITCH,
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

  it("ships the three 1472x32 strips as 46 objects on a 32-px pitch", async () => {
    const art = await loadShipped();
    for (const role of ["attract", "menu", "select"] as const) {
      const strip = art.backdrops[role];
      expect(strip.pixels).toHaveLength(STRIP_WIDTH * STRIP_HEIGHT);
      // 4 bitplanes: nothing above 15, and the strip is not blank.
      expect(Math.max(...strip.pixels)).toBeLessThanOrEqual(15);
      expect(new Set(strip.pixels).size).toBeGreaterThan(4);
      // Index 0 is the black field, and it is most of the strip: 35-48% on the
      // three blocks. A strip whose background index had stopped being the
      // majority would mean the planes had been read wrong.
      const background = strip.pixels.reduce((n, value) => n + (value === 0 ? 1 : 0), 0);
      expect(background / strip.pixels.length, role).toBeGreaterThan(0.3);
    }
    expect(STRIP_OBJECTS).toBe(46);
    expect(STRIP_PITCH).toBe(32);
    expect(STRIP_OBJECTS * STRIP_PITCH).toBe(STRIP_WIDTH);
  });

  /**
   * The palette block, pinned byte for byte.
   *
   * This is where the shipped artwork was wrong: the same 512 bytes read
   * COLUMN-major look like "16 colours x 16 fade steps", and the final column of
   * that reading — one entry from each of eight DIFFERENT palettes — shipped as
   * a single palette whose colour 0 was $36a blue and whose indices 10-15 were
   * white. It drew white objects on a blue field with the text lost in them.
   * Every assertion below fails under that reading.
   */
  it("carries sixteen page palettes read row-major, eight of them page tints", async () => {
    const art = await loadShipped();
    expect(art.palettes).toHaveLength(SHELL_PALETTE_COUNT);
    for (const palette of art.palettes) {
      expect(palette.aga).toHaveLength(SHELL_PALETTE_COLOURS);
      expect(palette.rgb).toHaveLength(SHELL_PALETTE_COLOURS * 3);
    }
    // The eight page tints, index 15 of rows 0..7, then the black crossfade row.
    expect(art.palettes.slice(0, SHELL_PALETTE_LIVE).map((p) => p.aga[15])).toEqual([
      0x36a, 0x377, 0x582, 0x980, 0xa60, 0xb20, 0xa27, 0x809, 0x000,
    ]);
    // Two filmed rows in full: teal, which the main menu was caught in, and
    // purple, which the title page was.
    expect(art.palettes[1]?.aga).toEqual([
      0x000, 0x000, 0x011, 0x011, 0x021, 0x022, 0x132, 0x133, 0x143, 0x144, 0x254, 0x255, 0x265,
      0x266, 0x376, 0x377,
    ]);
    expect(art.palettes[7]?.aga).toEqual([
      0x000, 0x001, 0x102, 0x102, 0x203, 0x203, 0x304, 0x305, 0x405, 0x406, 0x506, 0x507, 0x607,
      0x708, 0x709, 0x809,
    ]);
    // Row 8 is the all-black crossfade; 9 is black too and 10-15 are all white,
    // and none of those seven is ever indexed.
    expect(art.palettes[8]?.aga.every((word) => word === 0x000)).toBe(true);
    expect(art.palettes[9]?.aga.every((word) => word === 0x000)).toBe(true);
    for (let p = 10; p < SHELL_PALETTE_COUNT; p += 1) {
      expect(art.palettes[p]?.aga.every((word) => word === 0xfff), `palette ${p}`).toBe(true);
    }
  });

  it("keeps every live palette a black-rooted monotone ramp", async () => {
    const art = await loadShipped();
    for (let p = 0; p < SHELL_PALETTE_LIVE; p += 1) {
      const row = art.palettes[p]?.aga ?? [];
      // Colour 0 is the object field. Black on every page of the original, and
      // never written by the fader, which is why it cannot be anything else.
      expect(row[0], `palette ${p} colour 0`).toBe(0x000);
      expect([...(art.palettes[p]?.rgb.slice(0, 3) ?? [])]).toEqual([0, 0, 0]);
      for (let i = 1; i < SHELL_PALETTE_COLOURS; i += 1) {
        for (let shift = 0; shift <= 8; shift += 4) {
          const before = ((row[i - 1] ?? 0) >> shift) & 0xf;
          const after = ((row[i] ?? 0) >> shift) & 0xf;
          expect(after, `palette ${p} colour ${i} channel ${shift}`).toBeGreaterThanOrEqual(before);
        }
      }
    }
  });

  /**
   * The legibility invariant.
   *
   * The shell's text is $fff over the backdrop with no outline and no knockout,
   * so it is only readable as long as nothing in the page palette comes near
   * white. Every colour of every live palette is checked, not just the tint: the
   * shipped-wrong palette had SIX entries at $fff — contrast 1.00, invisible
   * text — and the darkest margin any real page leaves is 3.57, on gold.
   */
  it("leaves white text at least 3:1 against every colour of every live page", async () => {
    const art = await loadShipped();
    let worst = Infinity;
    for (let p = 0; p < SHELL_PALETTE_LIVE; p += 1) {
      const rgb = art.palettes[p]?.rgb ?? new Uint8Array();
      for (let i = 0; i < SHELL_PALETTE_COLOURS; i += 1) {
        const ratio = contrastWithWhite(rgb[i * 3] ?? 0, rgb[i * 3 + 1] ?? 0, rgb[i * 3 + 2] ?? 0);
        expect(ratio, `palette ${p} colour ${i}`).toBeGreaterThanOrEqual(3);
        worst = Math.min(worst, ratio);
      }
    }
    // The gold page's own tint, $980. Pinned so a palette that got brighter
    // would have to move this number rather than slip past the floor.
    expect(worst).toBeGreaterThan(3.5);
    expect(worst).toBeLessThan(3.7);
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

/**
 * WCAG relative luminance, and the contrast ratio of a colour against white.
 *
 * The same arithmetic any accessibility checker runs: linearise each channel,
 * weight, and take (lighter + 0.05) / (darker + 0.05). Written out here rather
 * than eyeballed so "the text still reads" is a number a future palette change
 * has to keep.
 */
function contrastWithWhite(r: number, g: number, b: number): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return 1.05 / (luminance + 0.05);
}

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
