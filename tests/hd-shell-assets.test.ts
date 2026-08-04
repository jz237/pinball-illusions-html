/**
 * The HD SHELL asset set — phase 3 — pinned, reproducible, and honest about
 * what it is.
 *
 * Five proofs over `public/generated/shell/*-hd.*`, built to the pattern
 * `hd-assets.test.ts` set for the playfield set:
 *
 *  1. MANIFEST PINS. Right schema, right rights class,
 *     `authorizationRequired: true`, 4x dimensions, and a sha256 the shipped
 *     bytes actually hash to — pinned here, so a regenerated asset that changes
 *     a single pixel fails until someone re-pins it deliberately.
 *
 *  2. DETERMINISM. The exporter is re-run IN-PROCESS on the shipped native
 *     inputs and must produce byte-identical files. That is what makes the
 *     digests above mean anything.
 *
 *  3. THE INDEX MAPS ARE INDEX MAPS. The strips use only the sixteen page
 *     palette entries and the fonts only the four plane values, because the
 *     runtime looks both up in tables of exactly those sizes. An upscale that
 *     invented a seventeenth colour would index off the end of a palette.
 *
 *  4. REGISTRATION. Box-downsampling an HD map by 4 must land back on the
 *     native map: exact for the majority index of each 4x4 block on nearly
 *     every block, and never a shift — the defect that cost the sibling
 *     project a table-wide audit. Logical (x, y) is HD (4x, 4y).
 *
 *  5. IT ACTUALLY BEATS WHAT IT REPLACES. The shipped vote maps are scored
 *     against the ideal (a direct per-palette xBRZ) and must be closer to it
 *     than plain nearest-4x is, on every strip and every live palette. This is
 *     the claim the whole recipe rests on, checked rather than cited.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  HD_SCALE,
  agaPaletteRgb,
  decodeIndexedPng,
  paintIndices,
  sha256,
  xbrzScaleRgb,
} from "../scripts/hd-pipeline.mjs";
import { buildShellArtHd, VOTING_PALETTES } from "../scripts/export-shell-art-hd.mjs";
import { decodeTruecolorPng } from "../src/game/table-art-hd.js";
import {
  FONT_ATLAS_WIDTH,
  SHELL_PALETTE_COLOURS,
  STRIP_HEIGHT,
  STRIP_WIDTH,
} from "../src/game/shell-art.js";
import { LOADING_LOGO_HEIGHT, LOADING_LOGO_WIDTH } from "../src/game/loading-logo.js";

const DIR = new URL("../public/generated/shell/", import.meta.url);
const read = (name: string): Buffer => readFileSync(new URL(name, DIR));
const readJson = (name: string): Record<string, unknown> =>
  JSON.parse(read(name).toString("utf8")) as Record<string, unknown>;

/** Regenerating with a changed pipeline changes these. Re-pin deliberately. */
const PINNED_SHA256: Record<string, string> = {
  "shell-backdrop-attract-hd.png":
    "5ae468204bc2b1958bff9179756cbe37b6a80a4c82203d05583cc952b7d43a48",
  "shell-backdrop-menu-hd.png": "fa6cf62364154b6f4bb578dc11c099e7170b6836e2ee2be29366d5b726862b8d",
  "shell-backdrop-select-hd.png":
    "69d1fee097017e99763e7cd551c7ebdaced62c0c4589063e6f4cb9a4c9ec5bf7",
  "shell-font1-hd.png": "f445f947b8b643478c7b5bcf5e37de11d28a1f6a03080c65c183bb4c44ab2402",
  "shell-font2-hd.png": "2d5b6119f418a1197cc2746c14f576023ee73eee02786a70aa23fa00a17daf7d",
  "loading-logo-hd.png": "5d99f7563be80f4e45ed529812041f6b49f584bd5b623b81ff017997bb0cf13e",
};

const ROLES = ["attract", "menu", "select"] as const;

describe("HD shell manifests", () => {
  it("shell.art-hd.json: schema, class, gate, dimensions, pinned digests", () => {
    const manifest = readJson("shell.art-hd.json");
    expect(manifest["schema"]).toBe("pinball-illusions/shell-art-hd/v1");
    expect(manifest["scale"]).toBe(HD_SCALE);
    const provenance = manifest["provenance"] as Record<string, unknown>;
    expect(provenance["sourceClass"]).toBe("disk-derived-shell-artwork-hd");
    expect(provenance["authorizationRequired"]).toBe(true);

    const images = manifest["images"] as Record<string, unknown>[];
    expect(images).toHaveLength(5);
    for (const image of images) {
      const file = image["file"] as string;
      const bytes = read(file);
      expect(bytes.length).toBe(image["byteLength"]);
      const digest = sha256(bytes);
      expect(digest).toBe(image["sha256"]);
      expect(digest).toBe(PINNED_SHA256[file]);

      const decoded = decodeIndexedPng(bytes);
      expect(decoded.width).toBe(image["width"]);
      expect(decoded.height).toBe(image["height"]);
      // The native file the HD one was made from, digest and all.
      const source = image["source"] as Record<string, unknown>;
      expect(sha256(read(source["file"] as string))).toBe(source["sha256"]);
    }

    for (const role of ROLES) {
      const image = images.find((entry) => entry["role"] === role);
      expect(image, `no ${role} strip`).toBeDefined();
      expect(image?.["width"]).toBe(STRIP_WIDTH * HD_SCALE);
      expect(image?.["height"]).toBe(STRIP_HEIGHT * HD_SCALE);
      expect(image?.["colours"]).toBe(SHELL_PALETTE_COLOURS);
    }
    for (const role of ["font1", "font2"]) {
      const image = images.find((entry) => entry["role"] === role);
      expect(image, `no ${role}`).toBeDefined();
      expect(image?.["width"]).toBe(FONT_ATLAS_WIDTH * HD_SCALE);
      expect(image?.["colours"]).toBe(4);
    }
  });

  it("loading.art-hd.json: schema, class, gate, dimensions, pinned digest", async () => {
    const manifest = readJson("loading.art-hd.json");
    expect(manifest["schema"]).toBe("pinball-illusions/loading-logo-hd/v1");
    expect(manifest["scale"]).toBe(HD_SCALE);
    const provenance = manifest["provenance"] as Record<string, unknown>;
    expect(provenance["sourceClass"]).toBe("disk-derived-loading-logo-hd");
    expect(provenance["authorizationRequired"]).toBe(true);
    // The strip's row on the shell page is the NATIVE manifest's, unmoved: HD
    // multiplies pixels, never geometry.
    const placement = manifest["placement"] as Record<string, unknown>;
    const native = readJson("loading.art.json");
    expect(placement["top"]).toBe((native["placement"] as Record<string, unknown>)["top"]);

    const image = manifest["image"] as Record<string, unknown>;
    const bytes = read(image["file"] as string);
    expect(bytes.length).toBe(image["byteLength"]);
    expect(sha256(bytes)).toBe(image["sha256"]);
    expect(sha256(bytes)).toBe(PINNED_SHA256["loading-logo-hd.png"]);
    const decoded = await decodeTruecolorPng(bytes);
    expect(decoded.width).toBe(LOADING_LOGO_WIDTH * HD_SCALE);
    expect(decoded.height).toBe(LOADING_LOGO_HEIGHT * HD_SCALE);
  });
});

describe("the HD shell exporter is deterministic", () => {
  it("re-running it in-process reproduces every shipped byte", () => {
    const { files } = buildShellArtHd();
    expect(files.size).toBe(8);
    for (const [name, bytes] of files) {
      expect(Buffer.from(bytes).equals(read(name)), `${name} differs`).toBe(true);
    }
  });
});

describe("the HD maps are index maps the runtime can look up", () => {
  for (const role of ROLES) {
    it(`${role} uses only the sixteen page-palette entries`, () => {
      const decoded = decodeIndexedPng(read(`shell-backdrop-${role}-hd.png`));
      let highest = 0;
      for (const index of decoded.indices) if (index > highest) highest = index;
      expect(highest).toBeLessThan(SHELL_PALETTE_COLOURS);
    });
  }
  for (const font of ["shell-font1-hd.png", "shell-font2-hd.png"]) {
    it(`${font} uses only the four plane values`, () => {
      const decoded = decodeIndexedPng(read(font));
      let highest = 0;
      for (const index of decoded.indices) if (index > highest) highest = index;
      expect(highest).toBeLessThanOrEqual(3);
    });
  }
});

describe("registration: logical (x, y) is HD (4x, 4y)", () => {
  /**
   * The share of native pixels whose HD 4x4 block agrees with them by majority.
   *
   * Not 100%: xBRZ's whole job is to move edge pixels, and a one-pixel-wide
   * diagonal can legitimately end up a minority of its own block. The bound is
   * loose enough for that and nowhere near loose enough for a SHIFT, which is
   * the defect it exists to catch — the check below proves that by measuring a
   * deliberately shifted read and requiring it to score worse.
   */
  const AGREEMENT_FLOOR = 0.9;

  const agreement = (
    native: { width: number; height: number; indices: Uint8Array },
    hd: Uint8Array,
    shiftX: number,
    shiftY: number,
  ): number => {
    const hdWidth = native.width * HD_SCALE;
    let agreed = 0;
    let counted = 0;
    const tally = new Uint16Array(256);
    for (let y = 1; y < native.height - 1; y += 1) {
      for (let x = 1; x < native.width - 1; x += 1) {
        tally.fill(0);
        for (let dy = 0; dy < HD_SCALE; dy += 1) {
          for (let dx = 0; dx < HD_SCALE; dx += 1) {
            const hy = y * HD_SCALE + dy + shiftY;
            const hx = x * HD_SCALE + dx + shiftX;
            const entry = hd[hy * hdWidth + hx] ?? 0;
            tally[entry] = (tally[entry] ?? 0) + 1;
          }
        }
        let best = 0;
        let bestCount = -1;
        for (let entry = 0; entry < 256; entry += 1) {
          if (tally[entry]! > bestCount) {
            bestCount = tally[entry]!;
            best = entry;
          }
        }
        counted += 1;
        if (best === native.indices[y * native.width + x]) agreed += 1;
      }
    }
    return agreed / counted;
  };

  for (const role of ROLES) {
    it(`${role}: the 4x4 block over a native pixel is that pixel, and a shift is worse`, () => {
      const native = decodeIndexedPng(read(`shell-backdrop-${role}.png`));
      const hd = decodeIndexedPng(read(`shell-backdrop-${role}-hd.png`)).indices;
      const straight = agreement(native, hd, 0, 0);
      expect(straight).toBeGreaterThan(AGREEMENT_FLOOR);
      // The instrument proves itself: reading one HD pixel across must score
      // materially worse, or the measurement above is blind to a shift.
      expect(agreement(native, hd, 1, 0)).toBeLessThan(straight);
      expect(agreement(native, hd, 0, 1)).toBeLessThan(straight);
    });
  }
});

describe("the vote beats what it replaces", () => {
  /**
   * The recipe's whole justification: the shipped index map, painted through a
   * live page palette, is CLOSER to that palette's own direct xBRZ than a plain
   * nearest 4x is. Measured here on the shipped bytes rather than quoted from
   * the research log.
   */
  for (const role of ROLES) {
    it(`${role}: closer to the per-palette ideal than nearest 4x, on every palette`, () => {
      const art = readJson("shell.art.json");
      const rows = (art["palettes"] as { rows: { aga: number[] }[] }).rows;
      const native = decodeIndexedPng(read(`shell-backdrop-${role}.png`));
      const shipped = decodeIndexedPng(read(`shell-backdrop-${role}-hd.png`)).indices;
      const hdWidth = native.width * HD_SCALE;
      const hdHeight = native.height * HD_SCALE;

      const nearest = new Uint8Array(hdWidth * hdHeight);
      for (let y = 0; y < hdHeight; y += 1) {
        for (let x = 0; x < hdWidth; x += 1) {
          nearest[y * hdWidth + x] =
            native.indices[
              Math.floor(y / HD_SCALE) * native.width + Math.floor(x / HD_SCALE)
            ] ?? 0;
        }
      }

      const meanError = (map: Uint8Array, palette: Uint8Array, ideal: Uint8Array): number => {
        const painted = paintIndices(map, palette);
        let sum = 0;
        for (let i = 0; i < painted.length; i += 3) {
          sum +=
            Math.abs(painted[i]! - ideal[i]!) +
            Math.abs(painted[i + 1]! - ideal[i + 1]!) +
            Math.abs(painted[i + 2]! - ideal[i + 2]!);
        }
        return sum / (painted.length / 3);
      };

      for (let p = 0; p < VOTING_PALETTES; p += 1) {
        const palette = agaPaletteRgb(rows[p]!.aga);
        const ideal = xbrzScaleRgb(
          paintIndices(native.indices, palette),
          native.width,
          native.height,
        );
        const voted = meanError(shipped, palette, ideal);
        const plain = meanError(nearest, palette, ideal);
        expect(voted, `${role} palette ${p}: vote ${voted} vs nearest ${plain}`).toBeLessThan(
          plain,
        );
      }
    });
  }
});
