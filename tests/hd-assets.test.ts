/**
 * The HD asset set: pinned, reproducible, and seam-free.
 *
 * Four proofs over the shipped `public/generated/tables/*-hd.*` files:
 *
 *  1. MANIFEST PINS. Every HD manifest names the right schema, the right
 *     rights class, `authorizationRequired: true`, the 4x dimensions, and a
 *     sha256 the shipped bytes actually hash to — and those digests are
 *     PINNED here, so a regenerated asset that changes a single pixel fails
 *     this suite until someone re-pins it deliberately.
 *
 *  2. DETERMINISM. The exporters are re-run IN-PROCESS on the shipped native
 *     inputs and must produce byte-identical files. This is what makes the
 *     digests above meaningful: the shipped bytes are the pipeline's own
 *     output, not a hand-touched artifact.
 *
 *  3. THE LAMP PATCH PROOF — the make-or-break of the whole HD lamp model.
 *     Compositing every shipped dim patch over the shipped lit master must
 *     reproduce the freshly computed all-dim upscale EXACTLY: zero differing
 *     pixels, full board. This is the measured xBRZ-locality property
 *     (research/hd/INDEX.txt section 4) that lets a dim lamp be a rectangle
 *     blit instead of a whole-board swap; it is checked on Law 'n Justice
 *     (largest patch set) and Extreme Sports (the table with masked-kind
 *     lamps, whose lit faces live in the master).
 *
 *  4. REGISTRATION. Box-downsampling the master by 4 must land back on the
 *     native lit board within a tight bound, globally and per 24-px tile.
 *     xBRZ is not exactly invertible (measured: global mean |d| about 2.7 of
 *     255, worst tile about 9.4), but a crop or a one-pixel shift — the
 *     defect that cost the sibling project a table-wide audit — blows the
 *     tile bound immediately. Logical (x, y) is HD (4x, 4y), by test.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { decodeTruecolorPng } from "../src/game/table-art-hd.js";
import type { TableId } from "../src/game/contracts.js";
import {
  HD_SCALE,
  NATIVE_HEIGHT,
  NATIVE_WIDTH,
  composeBoardIndices,
  decodeIndexedPng,
  indicesToRgb,
  sha256,
  upscaleBoard,
} from "../scripts/hd-pipeline.mjs";
import { buildTableArtHd } from "../scripts/export-table-art-hd.mjs";
import { buildMovingSpritesHd } from "../scripts/export-moving-sprites-hd.mjs";

const DIR = new URL("../public/generated/tables/", import.meta.url);
const HD_WIDTH = NATIVE_WIDTH * HD_SCALE;
const HD_HEIGHT = NATIVE_HEIGHT * HD_SCALE;

const read = (name: string): Buffer => readFileSync(new URL(name, DIR));
const readJson = (name: string): Record<string, unknown> =>
  JSON.parse(read(name).toString("utf8")) as Record<string, unknown>;

/**
 * The pinned digests of every HD raster. Regenerating with a changed pipeline
 * changes pixels, changes these, and fails here — re-pin only together with
 * the exporter change that justifies it.
 */
const PINNED_SHA256: Record<TableId, Record<string, string>> = {
  "law-n-justice": {
    "art-hd": "408e2712b31e800a544f8193638ec0135ca06fd9e08c277039bb9daa33d11591",
    "lamps-hd": "794471baf2e4700a7902ee249c15e8635710a26b1da2b782e9f165e7ba423b72",
    "ball-hd": "4b58a906e558c3c9274cf3e539a49d0a5c8143df292224c3070d927b1d1dd3af",
    "bats-hd": "e91608d647fca750403a124ca7b6a8d5b573b762ef79b2dbaa1da2b399a579c4",
  },
  "babewatch": {
    "art-hd": "3dc289337659c24214342955cc7020452cf252a6d06e324d338957335b879447",
    "lamps-hd": "eeec5791ed66020ee7685a9014ff3cd18462fbe93a596dd9a74b59ccf81d36eb",
    "ball-hd": "ae74d47414a6b00a1e7fd514870093aec704befc3e7f2ae63bdc0b980c33e2f1",
    "bats-hd": "4af81c8777721bf7f7b229bd80c9b974abb1fe66e293750f41b6d00b8fce0529",
  },
  "extreme-sports": {
    "art-hd": "4501712b1dd681fea97d715f86b0aae8ac206d970e93893eedd3859040c22447",
    "lamps-hd": "ba5770394160bfa95616dad4ea57de27d9d759bf38535080383490da313bfad6",
    "ball-hd": "c09f7101083bbbc7d39ccbf7ba57eb50f4cfd815047cb4fda8a4df4022f51b72",
    "bats-hd": "98339082d47c1e99c94fdd8e24dae1a05dd44b24b98656ab4d4dbb66a2047c9d",
  },
};

const CLASSES: Record<string, { schema: string; sourceClass: string }> = {
  "art-hd": {
    schema: "pinball-illusions/table-art-hd/v1",
    sourceClass: "disk-derived-playfield-artwork-hd",
  },
  "lamps-hd": {
    schema: "pinball-illusions/table-lamps-hd/v1",
    sourceClass: "disk-derived-lamp-overlays-hd",
  },
  "ball-hd": {
    schema: "pinball-illusions/table-ball-hd/v1",
    sourceClass: "disk-derived-ball-sprite-hd",
  },
  "bats-hd": {
    schema: "pinball-illusions/flipper-bats-hd/v1",
    sourceClass: "disk-derived-flipper-sprites-hd",
  },
};

const TABLES = Object.keys(PINNED_SHA256) as TableId[];

describe("HD manifests", () => {
  for (const tableId of TABLES) {
    for (const [kind, expectation] of Object.entries(CLASSES)) {
      it(`${tableId} ${kind}: schema, class, gate, dimensions, pinned digest`, async () => {
        const manifest = readJson(`${tableId}.${kind}.json`);
        expect(manifest["schema"]).toBe(expectation.schema);
        expect(manifest["tableId"]).toBe(tableId);
        expect(manifest["scale"]).toBe(HD_SCALE);
        const provenance = manifest["provenance"] as Record<string, unknown>;
        expect(provenance["sourceClass"]).toBe(expectation.sourceClass);
        expect(provenance["authorizationRequired"]).toBe(true);

        const image = manifest["image"] as Record<string, unknown>;
        expect(image["file"]).toBe(`${tableId}.${kind}.png`);
        const bytes = read(`${tableId}.${kind}.png`);
        expect(bytes.length).toBe(image["byteLength"]);
        const digest = sha256(bytes);
        expect(digest).toBe(image["sha256"]);
        expect(digest).toBe(PINNED_SHA256[tableId][kind]);

        // The raster's own header must agree with the manifest's geometry.
        const decoded = await decodeTruecolorPng(bytes);
        if (kind === "art-hd") {
          expect(manifest["width"]).toBe(HD_WIDTH);
          expect(manifest["height"]).toBe(HD_HEIGHT);
          expect(decoded.width).toBe(HD_WIDTH);
          expect(decoded.height).toBe(HD_HEIGHT);
        } else if (kind === "ball-hd") {
          expect(decoded.width).toBe(manifest["width"]);
          expect(decoded.height).toBe(manifest["height"]);
          expect(decoded.width).toBe(17 * HD_SCALE);
        } else {
          const atlas = manifest["atlas"] as Record<string, unknown>;
          expect(decoded.width).toBe(atlas["width"]);
          expect(decoded.height).toBe(atlas["height"]);
        }

        // Every patch and cell must read inside the atlas it names.
        if (kind === "lamps-hd") {
          const patches = manifest["patches"] as readonly Record<string, number>[];
          expect(patches.length).toBeGreaterThan(0);
          for (const patch of patches) {
            expect(patch["atlasX"]! + patch["width"]!).toBeLessThanOrEqual(decoded.width);
            expect(patch["atlasY"]! + patch["height"]!).toBeLessThanOrEqual(decoded.height);
            expect(patch["destX"]! + patch["width"]!).toBeLessThanOrEqual(HD_WIDTH);
            expect(patch["destY"]! + patch["height"]!).toBeLessThanOrEqual(HD_HEIGHT);
          }
        }
        if (kind === "bats-hd") {
          const cells = manifest["cells"] as readonly Record<string, number>[];
          expect(cells.length).toBe(64);
          for (const cell of cells) {
            expect(cell["x"]! + cell["width"]!).toBeLessThanOrEqual(decoded.width);
            expect(cell["y"]! + cell["height"]!).toBeLessThanOrEqual(decoded.height);
          }
        }
      });
    }
  }
});

describe("exporter determinism", () => {
  it("re-running the playfield exporter in-process reproduces the shipped bytes", () => {
    const built = buildTableArtHd(
      "law-n-justice",
      read("law-n-justice.art.png"),
      read("law-n-justice.lamps.json"),
    );
    expect(built.artHdPng.equals(read("law-n-justice.art-hd.png"))).toBe(true);
    expect(built.lampsHdPng.equals(read("law-n-justice.lamps-hd.png"))).toBe(true);
  });

  it("re-running the sprite exporter in-process reproduces the shipped bytes", () => {
    const built = buildMovingSpritesHd(
      "law-n-justice",
      read("law-n-justice.art.png"),
      read("law-n-justice.ball.json"),
      readFileSync(new URL("../public/generated/flipper-bats.json", import.meta.url)),
    );
    expect(built.ballHdPng.equals(read("law-n-justice.ball-hd.png"))).toBe(true);
    expect(built.batsHdPng.equals(read("law-n-justice.bats-hd.png"))).toBe(true);
  });
});

/** Draws every shipped patch onto a copy of the master; returns the composite. */
async function compositePatches(tableId: TableId): Promise<{
  composite: Uint8ClampedArray;
  master: Uint8ClampedArray;
}> {
  const master = (await decodeTruecolorPng(read(`${tableId}.art-hd.png`))).data;
  const atlasDoc = readJson(`${tableId}.lamps-hd.json`);
  const atlas = await decodeTruecolorPng(read(`${tableId}.lamps-hd.png`));
  const composite = Uint8ClampedArray.from(master);
  for (const patch of atlasDoc["patches"] as readonly Record<string, number>[]) {
    for (let y = 0; y < patch["height"]!; y += 1) {
      for (let x = 0; x < patch["width"]!; x += 1) {
        const from = ((patch["atlasY"]! + y) * atlas.width + patch["atlasX"]! + x) * 4;
        const to = ((patch["destY"]! + y) * HD_WIDTH + patch["destX"]! + x) * 4;
        composite[to] = atlas.data[from]!;
        composite[to + 1] = atlas.data[from + 1]!;
        composite[to + 2] = atlas.data[from + 2]!;
      }
    }
  }
  return { composite, master };
}

describe("the lamp dim-patch model is exact", () => {
  // Law 'n Justice: the largest plane-7 patch set. Extreme Sports: the table
  // whose six masked-kind lamps make the master's polarity non-trivial.
  for (const tableId of ["law-n-justice", "extreme-sports"] as TableId[]) {
    it(`${tableId}: shipped patches over the shipped master == the true all-dim upscale`, async () => {
      const { composite } = await compositePatches(tableId);
      const art = decodeIndexedPng(read(`${tableId}.art.png`));
      const lampsDoc = JSON.parse(read(`${tableId}.lamps.json`).toString("utf8"));
      const dim = upscaleBoard(composeBoardIndices(art, lampsDoc, false), art.palette).rgb;
      let differing = 0;
      for (let i = 0; i < HD_WIDTH * HD_HEIGHT; i += 1) {
        if (
          composite[i * 4] !== dim[i * 3] ||
          composite[i * 4 + 1] !== dim[i * 3 + 1] ||
          composite[i * 4 + 2] !== dim[i * 3 + 2]
        ) {
          differing += 1;
        }
      }
      expect(differing).toBe(0);
    });
  }
});

describe("registration — logical (x, y) is HD (4x, 4y)", () => {
  // Measured on the shipped masters: global mean |d| 2.63..2.76, worst
  // 24-px-tile mean 6.8..9.4 (xBRZ's non-invertibility). A crop or a
  // one-pixel shift multiplies the tile figure severalfold, which is the
  // failure this pins out.
  const GLOBAL_MEAN_BOUND = 4;
  const TILE_MEAN_BOUND = 12;
  const TILE = 24;

  for (const tableId of TABLES) {
    it(`${tableId}: the master box-downsamples onto the native lit board`, async () => {
      const master = (await decodeTruecolorPng(read(`${tableId}.art-hd.png`))).data;
      const art = decodeIndexedPng(read(`${tableId}.art.png`));
      const lampsDoc = JSON.parse(read(`${tableId}.lamps.json`).toString("utf8"));
      const lit = indicesToRgb(composeBoardIndices(art, lampsDoc, true), art.palette);

      const tilesX = NATIVE_WIDTH / TILE;
      const tilesY = NATIVE_HEIGHT / TILE;
      const tileSum = new Float64Array(tilesX * tilesY);
      let globalSum = 0;
      for (let y = 0; y < NATIVE_HEIGHT; y += 1) {
        for (let x = 0; x < NATIVE_WIDTH; x += 1) {
          // Mean of the 4x4 HD block per channel, against the native pixel.
          let dr = 0;
          let dg = 0;
          let db = 0;
          for (let sy = 0; sy < HD_SCALE; sy += 1) {
            for (let sx = 0; sx < HD_SCALE; sx += 1) {
              const at = ((y * HD_SCALE + sy) * HD_WIDTH + x * HD_SCALE + sx) * 4;
              dr += master[at]!;
              dg += master[at + 1]!;
              db += master[at + 2]!;
            }
          }
          const at = (y * NATIVE_WIDTH + x) * 3;
          const d =
            (Math.abs(dr / 16 - lit[at]!) +
              Math.abs(dg / 16 - lit[at + 1]!) +
              Math.abs(db / 16 - lit[at + 2]!)) /
            3;
          globalSum += d;
          const tile = Math.floor(y / TILE) * tilesX + Math.floor(x / TILE);
          tileSum[tile] = (tileSum[tile] ?? 0) + d;
        }
      }
      expect(globalSum / (NATIVE_WIDTH * NATIVE_HEIGHT)).toBeLessThan(GLOBAL_MEAN_BOUND);
      for (const sum of tileSum) {
        expect(sum / (TILE * TILE)).toBeLessThan(TILE_MEAN_BOUND);
      }
    });
  }
});
