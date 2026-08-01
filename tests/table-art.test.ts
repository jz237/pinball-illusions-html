/**
 * The artwork loader.
 *
 * `playfield-renderer.test.ts` proves the shipped picture is the disk's picture.
 * This file proves the reader that produces it is a real PNG reader rather than
 * something that happens to work on the one file our own exporter writes: it
 * hand-builds images that use all five row filters, a short palette, an
 * out-of-range index and the wrong colour type, and checks the reader's answer
 * to each. The exporter only ever emits filter 0, so without these the other
 * four branches would be untested code sitting in the path of the one asset the
 * whole project is about.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  TABLE_ART_BASE_PATH,
  applyPalette,
  decodeIndexedPng,
  loadTableArt,
  tableArtFrom,
  tableArtManifestUrl,
  tableArtUrl,
} from "../src/game/table-art.js";
import type { TableArtFetch } from "../src/game/table-art.js";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH, TABLE_IDS } from "../src/game/contracts.js";

const TABLES_DIR = fileURLToPath(new URL("../public/generated/tables/", import.meta.url));

// ---------------------------------------------------------------------------
// A hand-built PNG
// ---------------------------------------------------------------------------

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * One PNG chunk with a zero CRC.
 *
 * The reader deliberately does not verify CRCs — it is reading a file this
 * project just wrote, over a transport that already checksums — so a zero is
 * honest here rather than a shortcut being hidden.
 */
function chunk(tag: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  return Buffer.concat([length, Buffer.from(tag, "latin1"), payload, Buffer.alloc(4)]);
}

function ihdr(width: number, height: number, depth = 8, colourType = 3, interlace = 0): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = depth;
  data[9] = colourType;
  data[12] = interlace;
  return chunk("IHDR", data);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Encodes indices with a chosen filter per row — the inverse of the reader. */
function encodeIndexed(
  width: number,
  height: number,
  indices: Uint8Array,
  palette: Uint8Array,
  filters: readonly number[],
): Buffer {
  const raw = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y += 1) {
    const filter = filters[y] ?? 0;
    raw[y * (1 + width)] = filter;
    for (let x = 0; x < width; x += 1) {
      const value = indices[y * width + x] ?? 0;
      const a = x > 0 ? (indices[y * width + x - 1] ?? 0) : 0;
      const b = y > 0 ? (indices[(y - 1) * width + x] ?? 0) : 0;
      const c = y > 0 && x > 0 ? (indices[(y - 1) * width + x - 1] ?? 0) : 0;
      let encoded: number;
      switch (filter) {
        case 1:
          encoded = value - a;
          break;
        case 2:
          encoded = value - b;
          break;
        case 3:
          encoded = value - ((a + b) >> 1);
          break;
        case 4:
          encoded = value - paeth(a, b, c);
          break;
        default:
          encoded = value;
      }
      raw[y * (1 + width) + 1 + x] = encoded & 0xff;
    }
  }
  return Buffer.concat([
    SIGNATURE,
    ihdr(width, height),
    chunk("PLTE", Buffer.from(palette)),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const TINY_WIDTH = 4;
const TINY_HEIGHT = 5;
// Deliberately not a gradient: neighbouring pixels differ in both directions, so
// a filter applied in the wrong direction cannot accidentally reproduce it.
const TINY_INDICES = Uint8Array.from([
  0, 1, 2, 3,
  3, 0, 1, 2,
  1, 3, 0, 2,
  2, 2, 3, 1,
  0, 3, 1, 0,
]);
const TINY_PALETTE = Uint8Array.from([
  10, 20, 30,
  200, 0, 0,
  0, 200, 0,
  0, 0, 200,
]);
/** One row per filter type, so a single decode exercises all five. */
const TINY_FILTERS = [0, 1, 2, 3, 4];

// ---------------------------------------------------------------------------

describe("the PNG reader", () => {
  it("reproduces a hand-built image through all five row filters", async () => {
    const png = encodeIndexed(TINY_WIDTH, TINY_HEIGHT, TINY_INDICES, TINY_PALETTE, TINY_FILTERS);
    const image = await decodeIndexedPng(png);
    expect(image.width).toBe(TINY_WIDTH);
    expect(image.height).toBe(TINY_HEIGHT);
    expect(image.paletteEntries).toBe(4);
    expect([...image.indices]).toEqual([...TINY_INDICES]);
  });

  it("turns indices into the palette's own colours, with opaque alpha", async () => {
    const png = encodeIndexed(TINY_WIDTH, TINY_HEIGHT, TINY_INDICES, TINY_PALETTE, TINY_FILTERS);
    const rgba = applyPalette(await decodeIndexedPng(png));
    expect(rgba.length).toBe(TINY_WIDTH * TINY_HEIGHT * 4);
    for (let i = 0; i < TINY_INDICES.length; i += 1) {
      const entry = (TINY_INDICES[i] ?? 0) * 3;
      expect([...rgba.slice(i * 4, i * 4 + 4)]).toEqual([
        TINY_PALETTE[entry],
        TINY_PALETTE[entry + 1],
        TINY_PALETTE[entry + 2],
        255,
      ]);
    }
  });

  it("refuses something that is not a PNG at all", async () => {
    await expect(decodeIndexedPng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))).rejects.toThrow(
      /not a PNG/,
    );
  });

  it("refuses a PNG this project does not write", async () => {
    const body = Buffer.concat([
      chunk("PLTE", Buffer.from(TINY_PALETTE)),
      chunk("IDAT", deflateSync(Buffer.alloc(8))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    await expect(
      decodeIndexedPng(Buffer.concat([SIGNATURE, ihdr(4, 4, 8, 2), body])),
    ).rejects.toThrow(/colour type/);
    await expect(
      decodeIndexedPng(Buffer.concat([SIGNATURE, ihdr(4, 4, 16, 3), body])),
    ).rejects.toThrow(/bit depth/);
    await expect(
      decodeIndexedPng(Buffer.concat([SIGNATURE, ihdr(4, 4, 8, 3, 1), body])),
    ).rejects.toThrow(/interlaced/);
  });

  it("refuses an indexed image with no palette", async () => {
    const png = Buffer.concat([
      SIGNATURE,
      ihdr(1, 1),
      chunk("IDAT", deflateSync(Buffer.from([0, 0]))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    await expect(decodeIndexedPng(png)).rejects.toThrow(/PLTE/);
  });

  it("refuses an index the palette cannot resolve", async () => {
    // Four colours in PLTE, an index of 9 in the image: silently clamping that
    // would put an invented colour on the playfield.
    const indices = Uint8Array.from([0, 9, 1, 2]);
    const png = encodeIndexed(2, 2, indices, TINY_PALETTE, [0, 0]);
    await expect(decodeIndexedPng(png)).rejects.toThrow(/palette index 9/);
  });

  it("refuses a truncated file", async () => {
    const png = encodeIndexed(TINY_WIDTH, TINY_HEIGHT, TINY_INDICES, TINY_PALETTE, TINY_FILTERS);
    await expect(decodeIndexedPng(png.subarray(0, png.length - 12))).rejects.toThrow(/IEND/);
  });
});

describe("the shipped artwork", () => {
  const fileFetch: TableArtFetch = async (url) => {
    const bytes = readFileSync(`${TABLES_DIR}${url.slice(url.lastIndexOf("/") + 1)}`);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  };

  for (const tableId of TABLE_IDS) {
    it(`decodes ${tableId} into a ${PLAYFIELD_WIDTH}x${PLAYFIELD_HEIGHT} palette image`, async () => {
      const art = await loadTableArt(tableId, fileFetch, "");
      expect(art.tableId).toBe(tableId);
      expect(art.width).toBe(PLAYFIELD_WIDTH);
      expect(art.height).toBe(PLAYFIELD_HEIGHT);
      expect(art.indices.length).toBe(PLAYFIELD_WIDTH * PLAYFIELD_HEIGHT);
      expect(art.data.length).toBe(PLAYFIELD_WIDTH * PLAYFIELD_HEIGHT * 4);
      expect(art.paletteEntries).toBe(256);
      // A real 1995 playfield uses most of its 256 entries. A decode that had
      // gone wrong — wrong plane order, wrong phase — collapses this number.
      expect(new Set(art.indices).size).toBeGreaterThan(100);
    });
  }

  it("builds the URLs the site actually serves", () => {
    expect(TABLE_ART_BASE_PATH).toBe("generated/tables/");
    expect(tableArtUrl("law-n-justice")).toBe("generated/tables/law-n-justice.art.png");
    expect(tableArtManifestUrl("babewatch")).toBe("generated/tables/babewatch.art.json");
  });

  it("reports a failed fetch rather than rendering nothing", async () => {
    const missing: TableArtFetch = async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(loadTableArt("law-n-justice", missing)).rejects.toThrow(/404/);
  });

  it("refuses artwork that is not playfield-sized", async () => {
    const png = encodeIndexed(TINY_WIDTH, TINY_HEIGHT, TINY_INDICES, TINY_PALETTE, TINY_FILTERS);
    const image = await decodeIndexedPng(png);
    expect(() => tableArtFrom("law-n-justice", image)).toThrow(/expected 336x600/);
  });
});
