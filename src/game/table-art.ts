/**
 * Loader for the shipped playfield ARTWORK (`public/generated/tables/*.art.png`).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * Sibling of `table-map.ts`. That one loads slot 2 — the four-layer collision
 * geometry the physics reads. This one loads slot 3 — the 336x600 256-colour
 * playfield picture the player looks at. They are two independent rasters of the
 * same table and they are registered 1:1 (see `ART_REGISTRATION_OFFSET_*` in the
 * renderer).
 *
 * `scripts/export-table-art.mjs` decodes slot 3 off the operator's own disks and
 * writes an 8-bit indexed PNG that carries the disk's own palette indices in
 * IDAT and the disk's own 256-entry palette in PLTE. This module reads that file
 * back.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DECODES THE PNG BY HAND INSTEAD OF ASKING THE BROWSER
 * ---------------------------------------------------------------------------
 * Handing the file to `Image`/`createImageBitmap` and reading it back off a
 * canvas is fewer lines and it is the wrong answer twice over:
 *
 *  1. COLOUR FIDELITY. A canvas decode is entitled to apply colour management,
 *     and `getImageData` is entitled to hand back premultiplied or
 *     colour-converted bytes. The whole point of this project is that the
 *     playfield on screen is the 1995 artist's own RGB values, so the palette
 *     lookup happens here, in code that cannot silently change a colour.
 *  2. TESTABILITY. Tests run in node with no canvas and no DOM. The failure this
 *     project is recovering from is a renderer that shipped a wrong picture
 *     because nothing ever compared it to the original, so the artwork has to be
 *     loadable — and therefore assertable — in a plain node test. A canvas-based
 *     decode would have put the picture permanently out of reach of the tests.
 *
 * The cost is a PNG reader, which is ~120 lines because our own exporter writes
 * a deliberately dull file: 8-bit indexed, no interlacing, one PLTE. Inflate is
 * `DecompressionStream`, which node (18+) and every target browser both have, so
 * there is one decode path rather than a platform split. Everything except
 * `loadTableArt` is pure and synchronous-in-spirit; only the fetch touches I/O.
 *
 * The reader is strict on purpose: it refuses anything it does not fully
 * understand rather than approximating it. An artwork file that is subtly wrong
 * is exactly as bad as a map that is subtly wrong.
 */

import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "./contracts.js";
import type { TableId } from "./contracts.js";

/** Where the exported artwork lives under the site root (Vite serves `public/`). */
export const TABLE_ART_BASE_PATH = "generated/tables/";

/** The manifest schema written by `scripts/export-table-art.mjs`. */
export const TABLE_ART_SCHEMA = "pinball-illusions/table-art/v1";

/** RGBA, matching `ImageData` and `PixelTarget`. */
const BYTES_PER_PIXEL = 4;

/** One byte per pixel: this reader only handles 8-bit indexed images. */
const BYTES_PER_SAMPLE = 1;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** PNG colour type 3 is "each pixel is a palette index". The only one we accept. */
const COLOUR_TYPE_INDEXED = 3;

/**
 * A decoded playfield picture.
 *
 * `data` is ready to blit; `indices` and `palette` are kept because they are the
 * disk's actual bytes, and a test that wants to prove the shipped picture is the
 * disk's picture needs to see them rather than a derived RGBA buffer.
 */
export interface TableArt {
  readonly tableId: TableId;
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA, length width*height*4, alpha always 255. */
  readonly data: Uint8ClampedArray;
  /** Row-major palette indices, length width*height — the disk's own bytes. */
  readonly indices: Uint8Array;
  /** RGB triples, `paletteEntries * 3` bytes — the disk's own palette. */
  readonly palette: Uint8Array;
  readonly paletteEntries: number;
}

/** An indexed image straight out of a PNG, before the palette is applied. */
export interface IndexedImage {
  readonly width: number;
  readonly height: number;
  readonly indices: Uint8Array;
  readonly palette: Uint8Array;
  readonly paletteEntries: number;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

function bytesMatch(bytes: Uint8Array, expected: readonly number[], at: number): boolean {
  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[at + i] !== expected[i]) return false;
  }
  return true;
}

/**
 * Inflates a zlib stream.
 *
 * `DecompressionStream("deflate")` is the zlib-wrapped format, which is what a
 * PNG IDAT is; "deflate-raw" would be the unwrapped one and would fail on the
 * two-byte header.
 */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("no DecompressionStream in this runtime; cannot inflate the artwork PNG");
  }
  // Typed as the `BufferSource` the transform's writable side accepts, so the
  // pipe lines up without a cast.
  // Copied into a view of its own: the writable side takes a `BufferSource`,
  // which excludes a view onto a `SharedArrayBuffer`, and the caller's array
  // makes no promise about which kind of buffer is under it.
  const owned = new Uint8Array(data.length);
  owned.set(data);
  const source = new ReadableStream<BufferSource>({
    start(controller): void {
      controller.enqueue(owned);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream("deflate")).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const value = chunk.value;
    if (value !== undefined) {
      parts.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The Paeth predictor, verbatim from the PNG specification. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Reverses PNG row filtering in place, one scanline at a time.
 *
 * Our exporter writes filter 0 on every row, but a PNG optimiser run over the
 * shipped file would legitimately re-filter it, and a decoder that only handled
 * the case its own writer emits is a trap. All five filters, one byte per pixel.
 */
function unfilter(raw: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * BYTES_PER_SAMPLE;
  const expected = height * (1 + stride);
  if (raw.length !== expected) {
    throw new Error(`inflated image data is ${raw.length} bytes, expected ${expected}`);
  }
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (1 + stride)] ?? 0;
    const from = y * (1 + stride) + 1;
    const to = y * stride;
    const above = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[from + x] ?? 0;
      const a = x >= BYTES_PER_SAMPLE ? (out[to + x - BYTES_PER_SAMPLE] ?? 0) : 0;
      const b = y > 0 ? (out[above + x] ?? 0) : 0;
      const c = y > 0 && x >= BYTES_PER_SAMPLE ? (out[above + x - BYTES_PER_SAMPLE] ?? 0) : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + a;
          break;
        case 2:
          restored = value + b;
          break;
        case 3:
          restored = value + ((a + b) >> 1);
          break;
        case 4:
          restored = value + paeth(a, b, c);
          break;
        default:
          throw new Error(`unknown PNG filter type ${filter} on row ${y}`);
      }
      out[to + x] = restored & 0xff;
    }
  }
  return out;
}

/**
 * Decodes an 8-bit indexed, non-interlaced PNG.
 *
 * Refuses every other kind of PNG rather than converting it: this reader exists
 * to read one specific file that this project writes, and a truecolour or
 * 16-bit image arriving here means something upstream changed and should be
 * looked at, not quietly accommodated.
 */
export async function decodeIndexedPng(bytes: Uint8Array): Promise<IndexedImage> {
  if (bytes.length < PNG_SIGNATURE.length || !bytesMatch(bytes, [...PNG_SIGNATURE], 0)) {
    throw new Error("not a PNG: the 8-byte signature is missing");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let header: { width: number; height: number } | null = null;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let sawEnd = false;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const tag = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) {
      throw new Error(`PNG chunk ${tag} claims ${length} bytes, past the end of the file`);
    }
    const payload = bytes.subarray(start, end);

    if (tag === "IHDR") {
      if (length !== 13) throw new Error(`PNG IHDR is ${length} bytes, expected 13`);
      const width = view.getUint32(start);
      const height = view.getUint32(start + 4);
      const depth = payload[8];
      const colourType = payload[9];
      const interlace = payload[12];
      if (depth !== 8) {
        throw new Error(`PNG bit depth is ${depth}; this reader only handles 8`);
      }
      if (colourType !== COLOUR_TYPE_INDEXED) {
        throw new Error(
          `PNG colour type is ${colourType}; this reader only handles ${COLOUR_TYPE_INDEXED} (indexed)`,
        );
      }
      if (interlace !== 0) {
        throw new Error("PNG is interlaced; this reader only handles non-interlaced images");
      }
      if (width <= 0 || height <= 0) {
        throw new Error(`PNG declares a ${width}x${height} image`);
      }
      header = { width, height };
    } else if (tag === "PLTE") {
      if (length === 0 || length % 3 !== 0 || length > 768) {
        throw new Error(`PNG PLTE is ${length} bytes, which is not 3..768 RGB triples`);
      }
      palette = Uint8Array.from(payload);
    } else if (tag === "IDAT") {
      idat.push(payload);
    } else if (tag === "IEND") {
      sawEnd = true;
      break;
    }

    offset = end + 4; // skip the chunk's CRC
  }

  if (header === null) throw new Error("PNG has no IHDR chunk");
  if (palette === null) throw new Error("PNG has no PLTE chunk; an indexed image must carry one");
  if (idat.length === 0) throw new Error("PNG has no IDAT chunk");
  if (!sawEnd) throw new Error("PNG has no IEND chunk; the file is truncated");

  let compressedLength = 0;
  for (const part of idat) compressedLength += part.length;
  const compressed = new Uint8Array(compressedLength);
  let at = 0;
  for (const part of idat) {
    compressed.set(part, at);
    at += part.length;
  }

  const indices = unfilter(await inflate(compressed), header.width, header.height);
  const paletteEntries = palette.length / 3;
  for (const index of indices) {
    if (index >= paletteEntries) {
      throw new Error(`PNG uses palette index ${index} but PLTE has only ${paletteEntries} entries`);
    }
  }

  return {
    width: header.width,
    height: header.height,
    indices,
    palette,
    paletteEntries,
  };
}

/**
 * Applies the palette: one index per pixel in, opaque RGBA out.
 *
 * The only place a palette index becomes a colour. Pure, so the mapping is
 * assertable byte for byte against the PLTE the disk supplied.
 */
export function applyPalette(image: IndexedImage): Uint8ClampedArray {
  const data = new Uint8ClampedArray(image.width * image.height * BYTES_PER_PIXEL);
  for (let i = 0; i < image.indices.length; i += 1) {
    const entry = (image.indices[i] ?? 0) * 3;
    const at = i * BYTES_PER_PIXEL;
    data[at] = image.palette[entry] ?? 0;
    data[at + 1] = image.palette[entry + 1] ?? 0;
    data[at + 2] = image.palette[entry + 2] ?? 0;
    data[at + 3] = 255;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Turns decoded PNG bytes into one table's artwork.
 *
 * The size check is the one that matters: the renderer blits this 1:1 over the
 * collision map's coordinate space, so a picture that is not exactly
 * 336x600 is not a picture of this playfield and must not be shown.
 */
export function tableArtFrom(tableId: TableId, image: IndexedImage): TableArt {
  if (image.width !== PLAYFIELD_WIDTH || image.height !== PLAYFIELD_HEIGHT) {
    throw new Error(
      `artwork for ${tableId} is ${image.width}x${image.height}, expected ${PLAYFIELD_WIDTH}x${PLAYFIELD_HEIGHT}`,
    );
  }
  return {
    tableId,
    width: image.width,
    height: image.height,
    data: applyPalette(image),
    indices: image.indices,
    palette: image.palette,
    paletteEntries: image.paletteEntries,
  };
}

/** URL of one table's exported artwork, relative to the site root. */
export function tableArtUrl(tableId: TableId, basePath: string = TABLE_ART_BASE_PATH): string {
  return `${basePath}${tableId}.art.png`;
}

/** URL of the manifest that declares that artwork's provenance and digest. */
export function tableArtManifestUrl(
  tableId: TableId,
  basePath: string = TABLE_ART_BASE_PATH,
): string {
  return `${basePath}${tableId}.art.json`;
}

/** The slice of `Response` this loader needs, so a test can pass a plain object. */
export interface TableArtResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type TableArtFetch = (url: string) => Promise<TableArtResponse>;

// Wrapped rather than passing `fetch` itself: an unbound reference to the global
// throws "Illegal invocation" in browsers.
const defaultFetch: TableArtFetch = (url) => fetch(url);

/**
 * Fetches and decodes one table's playfield artwork.
 *
 * The only network-touching function in this module, and deliberately thin, so
 * everything above it is testable with no I/O at all.
 */
export async function loadTableArt(
  tableId: TableId,
  fetchImpl: TableArtFetch = defaultFetch,
  basePath: string = TABLE_ART_BASE_PATH,
): Promise<TableArt> {
  const url = tableArtUrl(tableId, basePath);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return tableArtFrom(tableId, await decodeIndexedPng(bytes));
}
