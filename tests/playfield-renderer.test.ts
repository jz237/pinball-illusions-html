/**
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS ARE FOR
 * ---------------------------------------------------------------------------
 * The renderer this file covers previously drew a procedural wireframe of the
 * collision map — cyan and yellow lines on near-black — and shipped it to a live
 * URL. Twenty-six tests were green the whole time, because every one of them
 * asserted that the output was DETERMINISTIC. A wrong picture is perfectly
 * deterministic.
 *
 * So the load-bearing test in this file is `the playfield IS the original
 * artwork`: it decodes the shipped `<table>.art.png` with its own reader — node
 * `zlib`, not the `DecompressionStream` path the source uses — applies the PLTE
 * itself, and demands that every pixel the renderer produces is that colour.
 * Not "stable", not "plausible": the same bytes as the disk. Everything else
 * here is scaffolding around that.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import {
  ART_REGISTRATION_OFFSET_X,
  ART_REGISTRATION_OFFSET_Y,
  BYTES_PER_PIXEL,
  RASTER_HEIGHT,
  RASTER_WIDTH,
  createPixelTarget,
  drawPlayfield,
  integerScaleFor,
  invalidatePlayfieldRaster,
  playfieldArtwork,
  playfieldBlitGeometry,
  playfieldRaster,
  renderPlayfield,
  renderPlayfieldInto,
  setPlayfieldArtwork,
} from "../src/browser/playfield-renderer.js";
import type { BlitContext, PixelTarget } from "../src/browser/playfield-renderer.js";
import { CABINET_BLACK } from "../src/browser/palette.js";
import { loadTableArt } from "../src/game/table-art.js";
import type { TableArtFetch } from "../src/game/table-art.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { VIEWPORT_HEIGHT } from "../src/browser/camera.js";
import type { CameraState } from "../src/browser/camera.js";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH, TABLE_IDS } from "../src/game/contracts.js";
import type { TableId, TableMap, TableMapDocument } from "../src/game/contracts.js";

// ---------------------------------------------------------------------------
// The shipped assets
// ---------------------------------------------------------------------------

const TABLES_DIR = fileURLToPath(new URL("../public/generated/tables/", import.meta.url));

function assetBytes(name: string): Buffer {
  return readFileSync(`${TABLES_DIR}${name}`);
}

/** Three colour bytes per pixel, row-major. What the artwork "really is". */
interface ReferenceImage {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
  readonly indices: Uint8Array;
  readonly palette: Uint8Array;
}

/**
 * A second, independent PNG reader.
 *
 * Deliberately not the one in `src/game/table-art.ts`: this one uses node's
 * synchronous `zlib` rather than `DecompressionStream`, walks the chunks with
 * its own loop, and does its own palette lookup. Two implementations that agree
 * on 201,600 pixels are evidence; one implementation compared against itself is
 * not. Assumes filter 0 on every row, and asserts it rather than handling the
 * other four — the exporter writes filter 0, and a file that suddenly did not
 * should fail loudly here.
 */
function decodePngIndependently(bytes: Buffer): ReferenceImage {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) throw new Error("reference decode: not a PNG");
  }

  let offset = signature.length;
  let width = 0;
  let height = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const tag = bytes.toString("latin1", offset + 4, offset + 8);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (tag === "IHDR") {
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      if (payload[8] !== 8 || payload[9] !== 3 || payload[12] !== 0) {
        throw new Error("reference decode: not an 8-bit non-interlaced indexed PNG");
      }
    } else if (tag === "PLTE") {
      palette = Buffer.from(payload);
    } else if (tag === "IDAT") {
      idat.push(Buffer.from(payload));
    } else if (tag === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (palette === null) throw new Error("reference decode: no PLTE");
  const raw = inflateSync(Buffer.concat(idat));
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const at = y * (1 + width);
    if (raw[at] !== 0) throw new Error(`reference decode: row ${y} uses filter ${String(raw[at])}`);
    indices.set(raw.subarray(at + 1, at + 1 + width), y * width);
  }

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < indices.length; i += 1) {
    const entry = (indices[i] ?? 0) * 3;
    rgb[i * 3] = palette[entry] ?? 0;
    rgb[i * 3 + 1] = palette[entry + 1] ?? 0;
    rgb[i * 3 + 2] = palette[entry + 2] ?? 0;
  }

  return { width, height, rgb, indices, palette: new Uint8Array(palette) };
}

interface ArtManifest {
  readonly schema: string;
  readonly width: number;
  readonly height: number;
  readonly image: { readonly file: string; readonly sha256: string };
  readonly palette: { readonly indicesUsed: number };
  readonly provenance: { readonly sourceClass: string; readonly authorizationRequired: boolean };
}

function manifestFor(tableId: TableId): ArtManifest {
  return JSON.parse(assetBytes(`${tableId}.art.json`).toString("utf8")) as ArtManifest;
}

function referenceFor(tableId: TableId): ReferenceImage {
  return decodePngIndependently(assetBytes(`${tableId}.art.png`));
}

function realMap(tableId: TableId): TableMap {
  const doc = JSON.parse(assetBytes(`${tableId}.map.json`).toString("utf8")) as TableMapDocument;
  return parseTableMapDocument(doc);
}

/**
 * The production loader, pointed at the files on disk instead of the network.
 *
 * The point of routing through `loadTableArt` rather than reading the PNG
 * straight into the renderer is that the URL it builds, the decode it performs
 * and the size check it applies are all on the path under test — the browser
 * runs the same code with a real `fetch`.
 */
const fileFetch: TableArtFetch = async (url) => {
  const name = url.slice(url.lastIndexOf("/") + 1);
  const bytes = assetBytes(name);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
};

async function loadShippedArt(tableId: TableId): Promise<PixelTarget> {
  return await loadTableArt(tableId, fileFetch, "");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

function pixelAt(target: PixelTarget, x: number, y: number): Rgb {
  const at = (y * target.width + x) * BYTES_PER_PIXEL;
  return [target.data[at] ?? 0, target.data[at + 1] ?? 0, target.data[at + 2] ?? 0];
}

function referencePixelAt(image: ReferenceImage, x: number, y: number): Rgb {
  const at = (y * image.width + x) * 3;
  return [image.rgb[at] ?? 0, image.rgb[at + 1] ?? 0, image.rgb[at + 2] ?? 0];
}

/**
 * Artwork that is obviously not a playfield, for the plumbing tests.
 *
 * Every pixel a different value derived from its coordinates and the seed, so a
 * raster built from one is distinguishable from a raster built from another at
 * any single pixel — which is what the cache-isolation tests need.
 */
function syntheticArtwork(seed: number): PixelTarget {
  const target = createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT);
  for (let y = 0; y < PLAYFIELD_HEIGHT; y += 1) {
    for (let x = 0; x < PLAYFIELD_WIDTH; x += 1) {
      const at = (y * PLAYFIELD_WIDTH + x) * BYTES_PER_PIXEL;
      target.data[at] = (x + seed) & 0xff;
      target.data[at + 1] = (y + seed) & 0xff;
      target.data[at + 2] = (x ^ y ^ seed) & 0xff;
      target.data[at + 3] = 255;
    }
  }
  return target;
}

function mapFixture(tableId: TableId = "law-n-justice"): TableMap {
  const pixels = new Uint8Array(PLAYFIELD_WIDTH * PLAYFIELD_HEIGHT);
  return {
    tableId,
    displayName: "Fixture",
    width: PLAYFIELD_WIDTH,
    height: PLAYFIELD_HEIGHT,
    pixels,
    materialAt: () => 0,
  };
}

// ---------------------------------------------------------------------------
// The correctness test. This is the one that matters.
// ---------------------------------------------------------------------------

describe("the playfield IS the original artwork", () => {
  for (const tableId of TABLE_IDS) {
    it(`draws ${tableId} pixel for pixel as the exported playfield artwork`, async () => {
      invalidatePlayfieldRaster();
      const reference = referenceFor(tableId);
      const map = realMap(tableId);
      setPlayfieldArtwork(map, await loadShippedArt(tableId));
      const raster = playfieldRaster(map);

      expect(reference.width).toBe(RASTER_WIDTH);
      expect(reference.height).toBe(RASTER_HEIGHT);

      // Compared through the declared registration offset rather than at 0,0, so
      // this test still states the truth if the offset ever becomes non-zero.
      let compared = 0;
      let matched = 0;
      let firstMiss: string | null = null;
      for (let y = 0; y < RASTER_HEIGHT; y += 1) {
        const sourceY = y - ART_REGISTRATION_OFFSET_Y;
        if (sourceY < 0 || sourceY >= reference.height) continue;
        for (let x = 0; x < RASTER_WIDTH; x += 1) {
          const sourceX = x - ART_REGISTRATION_OFFSET_X;
          if (sourceX < 0 || sourceX >= reference.width) continue;
          compared += 1;
          const drawn = pixelAt(raster, x, y);
          const original = referencePixelAt(reference, sourceX, sourceY);
          if (drawn[0] === original[0] && drawn[1] === original[1] && drawn[2] === original[2]) {
            matched += 1;
          } else if (firstMiss === null) {
            firstMiss = `at (${x}, ${y}) the renderer drew ${drawn.join()} where the disk says ${original.join()}`;
          }
        }
      }

      expect(compared).toBe(RASTER_WIDTH * RASTER_HEIGHT);
      expect(firstMiss).toBeNull();
      expect(matched / compared).toBeGreaterThanOrEqual(0.9999);
      expect(matched).toBe(compared);
    });

    it(`draws ${tableId} as a full-colour picture, not a drawing of the collision map`, async () => {
      invalidatePlayfieldRaster();
      const map = realMap(tableId);
      setPlayfieldArtwork(map, await loadShippedArt(tableId));
      const raster = playfieldRaster(map);

      // The procedural renderer this replaced had thirteen colours in the whole
      // table and exactly TWO over bare deck, because it painted by material
      // bit. Real artwork cannot be described that way: the paint varies where
      // the collision map is uniform, which is the difference between a picture
      // of the table and a diagram of it.
      const everywhere = new Set<number>();
      const overBareDeck = new Set<number>();
      let bareDeckPixels = 0;
      for (let y = 0; y < RASTER_HEIGHT; y += 1) {
        for (let x = 0; x < RASTER_WIDTH; x += 1) {
          const [r, g, b] = pixelAt(raster, x, y);
          const key = (r << 16) | (g << 8) | b;
          everywhere.add(key);
          if (map.materialAt(x, y) === 0) {
            overBareDeck.add(key);
            bareDeckPixels += 1;
          }
        }
      }

      expect(everywhere.size).toBeGreaterThanOrEqual(150);
      expect(bareDeckPixels).toBeGreaterThan(50_000);
      expect(overBareDeck.size).toBeGreaterThanOrEqual(100);
    });
  }

  it("ships artwork that still matches the manifest it was exported with", () => {
    for (const tableId of TABLE_IDS) {
      const manifest = manifestFor(tableId);
      const png = assetBytes(`${tableId}.art.png`);
      const reference = referenceFor(tableId);

      expect(manifest.schema).toBe("pinball-illusions/table-art/v1");
      expect(manifest.image.file).toBe(`${tableId}.art.png`);
      expect(createHash("sha256").update(png).digest("hex")).toBe(manifest.image.sha256);
      expect(manifest.width).toBe(RASTER_WIDTH);
      expect(manifest.height).toBe(RASTER_HEIGHT);
      expect(new Set(reference.indices).size).toBe(manifest.palette.indicesUsed);

      // The artwork is disk-derived and gated by the same marker as the maps.
      // A build guard that can be walked around by deleting a field is not a
      // guard, so the field is asserted here as well as in the build script.
      expect(manifest.provenance.sourceClass).toBe("disk-derived-playfield-artwork");
      expect(manifest.provenance.authorizationRequired).toBe(true);
    }
  });

  it("keeps the collision map out of the picture entirely", async () => {
    // Two different maps, one artwork: the pixels must be identical. If anything
    // in the renderer ever consults `materialAt` again, this fails.
    invalidatePlayfieldRaster();
    const artwork = await loadShippedArt("law-n-justice");
    const lawMap = realMap("law-n-justice");
    const babeMap = realMap("babewatch");
    setPlayfieldArtwork(lawMap, artwork);
    setPlayfieldArtwork(babeMap, artwork);
    expect(playfieldRaster(babeMap).data).toEqual(playfieldRaster(lawMap).data);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("states a whole-pixel offset between the artwork and the map", () => {
    expect(Number.isInteger(ART_REGISTRATION_OFFSET_X)).toBe(true);
    expect(Number.isInteger(ART_REGISTRATION_OFFSET_Y)).toBe(true);
    // Sub-pixel registration would mean resampling, which would destroy the
    // chunky 1:1 look the whole renderer exists to preserve.
    expect(Math.abs(ART_REGISTRATION_OFFSET_X)).toBeLessThan(RASTER_WIDTH);
    expect(Math.abs(ART_REGISTRATION_OFFSET_Y)).toBeLessThan(RASTER_HEIGHT);
  });

  it("places the artwork at exactly that offset", () => {
    const artwork = syntheticArtwork(7);
    const raster = renderPlayfield(artwork);
    for (const [x, y] of [
      [0, 0],
      [17, 3],
      [200, 401],
      [RASTER_WIDTH - 1, RASTER_HEIGHT - 1],
    ] as const) {
      const sourceX = x - ART_REGISTRATION_OFFSET_X;
      const sourceY = y - ART_REGISTRATION_OFFSET_Y;
      const inside =
        sourceX >= 0 && sourceX < artwork.width && sourceY >= 0 && sourceY < artwork.height;
      expect(pixelAt(raster, x, y)).toEqual(
        inside ? pixelAt(artwork, sourceX, sourceY) : [...CABINET_BLACK],
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Raster shape
// ---------------------------------------------------------------------------

describe("raster shape", () => {
  it("rasterises exactly one pixel per playfield pixel", () => {
    const raster = renderPlayfield(syntheticArtwork(1));
    expect(raster.width).toBe(PLAYFIELD_WIDTH);
    expect(raster.height).toBe(PLAYFIELD_HEIGHT);
    expect(raster.data.length).toBe(PLAYFIELD_WIDTH * PLAYFIELD_HEIGHT * BYTES_PER_PIXEL);
  });

  it("leaves every pixel fully opaque", () => {
    const raster = renderPlayfield(syntheticArtwork(2));
    let transparent = 0;
    for (let i = 3; i < raster.data.length; i += BYTES_PER_PIXEL) {
      if (raster.data[i] !== 255) transparent += 1;
    }
    expect(transparent).toBe(0);
  });

  it("refuses a target that is not the playfield's size, rather than scaling", () => {
    const wrong = createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT - 1);
    expect(() => renderPlayfieldInto(syntheticArtwork(3), wrong)).toThrow(/1:1/);
  });

  it("fills the target it was given", () => {
    const artwork = syntheticArtwork(4);
    const target = createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT);
    expect(renderPlayfieldInto(artwork, target)).toBe(target);
    expect(pixelAt(target, 10, 10)).toEqual(pixelAt(artwork, 10, 10));
  });
});

// ---------------------------------------------------------------------------
// Supplying the artwork
// ---------------------------------------------------------------------------

describe("the artwork a map is drawn with", () => {
  it("refuses to invent a playfield when no artwork has been loaded", () => {
    invalidatePlayfieldRaster();
    const map = mapFixture();
    expect(playfieldArtwork(map)).toBeNull();
    // No procedural fallback and no blank table: an unloaded asset has to be
    // loud, because a plausible-looking substitute is how the wrong picture
    // shipped in the first place.
    expect(() => playfieldRaster(map)).toThrow(/no playfield artwork registered/);
  });

  it("refuses artwork that is not the playfield's size", () => {
    invalidatePlayfieldRaster();
    const map = mapFixture();
    const small = createPixelTarget(PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT - 1);
    expect(() => setPlayfieldArtwork(map, small)).toThrow(/expected 336x600/);
  });

  it("hands back the artwork it was given", () => {
    invalidatePlayfieldRaster();
    const map = mapFixture();
    const artwork = syntheticArtwork(5);
    setPlayfieldArtwork(map, artwork);
    expect(playfieldArtwork(map)).toBe(artwork);
  });

  it("rebuilds when different artwork is registered for the same map", () => {
    invalidatePlayfieldRaster();
    const map = mapFixture();
    setPlayfieldArtwork(map, syntheticArtwork(6));
    const before = pixelAt(playfieldRaster(map), 40, 40);
    setPlayfieldArtwork(map, syntheticArtwork(9));
    const after = pixelAt(playfieldRaster(map), 40, 40);
    expect(after).not.toEqual(before);
  });
});

describe("the static cache", () => {
  it("returns the identical raster twice", () => {
    invalidatePlayfieldRaster();
    const map = mapFixture();
    setPlayfieldArtwork(map, syntheticArtwork(10));
    const first = playfieldRaster(map);
    expect(playfieldRaster(map)).toBe(first);
  });

  it("rebuilds byte-for-byte identical pixels after invalidation", () => {
    invalidatePlayfieldRaster();
    const map = mapFixture();
    setPlayfieldArtwork(map, syntheticArtwork(11));
    const before = playfieldRaster(map);
    const snapshot = Uint8ClampedArray.from(before.data);
    invalidatePlayfieldRaster(map);
    const after = playfieldRaster(map);
    expect(after).not.toBe(before);
    expect(after.data).toEqual(snapshot);
  });

  it("does not hand one map's pixels to another", () => {
    invalidatePlayfieldRaster();
    const one = mapFixture("law-n-justice");
    const other = mapFixture("babewatch");
    setPlayfieldArtwork(one, syntheticArtwork(12));
    setPlayfieldArtwork(other, syntheticArtwork(13));
    expect(playfieldRaster(other)).not.toBe(playfieldRaster(one));
    expect(pixelAt(playfieldRaster(other), 10, 10)).not.toEqual(pixelAt(playfieldRaster(one), 10, 10));
  });

  it("forgets the artwork too when everything is invalidated", () => {
    invalidatePlayfieldRaster();
    const map = mapFixture();
    setPlayfieldArtwork(map, syntheticArtwork(14));
    invalidatePlayfieldRaster();
    expect(playfieldArtwork(map)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Blitting
// ---------------------------------------------------------------------------

describe("blitting", () => {
  const scrolling: CameraState = { scrollY: 200, mode: "scrolling" };
  const fullTable: CameraState = { scrollY: 0, mode: "full-table" };
  const map = mapFixture();

  it("picks the largest whole magnification that fits, never below 1", () => {
    expect(integerScaleFor(PLAYFIELD_WIDTH * 3, VIEWPORT_HEIGHT * 3)).toBe(3);
    expect(integerScaleFor(PLAYFIELD_WIDTH * 3, VIEWPORT_HEIGHT * 2)).toBe(2);
    expect(integerScaleFor(10, 10)).toBe(1);
    expect(Number.isInteger(integerScaleFor(1000, 700))).toBe(true);
  });

  it("reads a viewport-sized window at the camera's scroll position", () => {
    const geometry = playfieldBlitGeometry(map, scrolling, 2);
    expect(geometry.sourceY).toBe(200);
    expect(geometry.sourceWidth).toBe(PLAYFIELD_WIDTH);
    expect(geometry.sourceHeight).toBe(VIEWPORT_HEIGHT);
    expect(geometry.destWidth).toBe(PLAYFIELD_WIDTH * 2);
    expect(geometry.destHeight).toBe(VIEWPORT_HEIGHT * 2);
  });

  it("clamps a scroll position that never went through the camera", () => {
    const geometry = playfieldBlitGeometry(map, { scrollY: 9999, mode: "scrolling" }, 1);
    expect(geometry.sourceY).toBe(PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT);
  });

  it("shows the whole table in multiball, scaled to the viewport height", () => {
    const geometry = playfieldBlitGeometry(map, fullTable, 1);
    expect(geometry.sourceY).toBe(0);
    expect(geometry.sourceHeight).toBe(PLAYFIELD_HEIGHT);
    expect(geometry.destHeight).toBeCloseTo(VIEWPORT_HEIGHT);
    expect(geometry.destWidth).toBeLessThan(PLAYFIELD_WIDTH);
  });

  it("turns smoothing off every frame, because the context is shared", () => {
    invalidatePlayfieldRaster();
    const target = mapFixture();
    setPlayfieldArtwork(target, syntheticArtwork(15));
    let drawn = 0;
    const context: BlitContext = {
      imageSmoothingEnabled: true,
      drawImage(): void {
        drawn += 1;
      },
    };
    // Uploading the raster needs a canvas, which node has not got. The flag is
    // set before the upload is attempted, which is what this asserts.
    expect(() => drawPlayfield(context, target, scrolling, 2)).toThrow(/canvas/);
    expect(context.imageSmoothingEnabled).toBe(false);
    expect(drawn).toBe(0);
  });
});
