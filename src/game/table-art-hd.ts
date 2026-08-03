/**
 * Loaders for the HD (4x) presentation assets
 * (`public/generated/tables/*-hd.{png,json}`).
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ARE
 * ---------------------------------------------------------------------------
 * Four files per table, all written by `scripts/export-table-art-hd.mjs` and
 * `scripts/export-moving-sprites-hd.mjs` from assets this project already
 * ships — the disks are never re-read:
 *
 *   <t>.art-hd.png    1344x2400 playfield master — the shipped 336x600 art,
 *                     every lamp lit, de-dithered and xBRZ-4x upscaled
 *   <t>.lamps-hd.png  atlas of per-lamp DIM patches cut from the identical
 *                     upscale of the all-dim board, geometry in the JSON
 *   <t>.ball-hd.png   68x68 RGBA ball
 *   <t>.bats-hd.png   atlas of all 64 bat poses at 4x, geometry in the JSON
 *
 * ---------------------------------------------------------------------------
 * PRESENTATION ONLY, AND OPTIONAL
 * ---------------------------------------------------------------------------
 * Nothing under `src/game/` or `src/core/` that the simulation reaches imports
 * this module; it exists for the browser render layer alone, and the sim-hash
 * pin (`tests/sim-hash-pin.test.ts`) is the proof that adding it moved
 * nothing. Loading is TOLERANT AT THE CALL SITE, like the score panel: a table
 * whose HD set is missing renders through the native-resolution path
 * unchanged, loudly, rather than failing to boot. The native artwork remains
 * REQUIRED — HD is a magnifier on the real picture, never a substitute.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PNG IS DECODED BY HAND, AGAIN
 * ---------------------------------------------------------------------------
 * Same two reasons as `table-art.ts`, which this mirrors: a canvas decode may
 * colour-manage the 1995 palette on the way past, and node tests must be able
 * to read the same pixels the browser draws. The HD files are truecolor
 * (type 2 RGB / type 6 RGBA) rather than indexed, so this file carries the
 * truecolor variant of the same strict reader: 8-bit, non-interlaced, all
 * five row filters, nothing else. Every decoded image is dimension-checked
 * against the manifest and the manifest's sha256 is verified over the fetched
 * bytes where the runtime offers `crypto.subtle` (node and every secure
 * browsing context do).
 */

import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "./contracts.js";
import type { TableId } from "./contracts.js";
import { TABLE_ART_BASE_PATH } from "./table-art.js";
import type { TableArtFetch, TableArtResponse } from "./table-art.js";

/** The scale every HD asset is exported at. Mirrors `hd-scale.ts` (browser). */
export const HD_ASSET_SCALE = 4;

export const TABLE_ART_HD_SCHEMA = "pinball-illusions/table-art-hd/v1";
export const TABLE_LAMPS_HD_SCHEMA = "pinball-illusions/table-lamps-hd/v1";
export const TABLE_BALL_HD_SCHEMA = "pinball-illusions/table-ball-hd/v1";
export const FLIPPER_BATS_HD_SCHEMA = "pinball-illusions/flipper-bats-hd/v1";

/** RGBA, matching `ImageData` and the renderer's `PixelTarget`. */
const BYTES_PER_PIXEL = 4;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** A decoded truecolor image, RGBA whatever the file stored. */
export interface HdImage {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA, length width*height*4. */
  readonly data: Uint8ClampedArray;
}

/** The HD playfield master for one table. Satisfies the renderer's `PixelTarget`. */
export interface TableArtHd extends HdImage {
  readonly tableId: TableId;
}

/** One lamp's dim patch: where it sits in the atlas and on the HD board. */
export interface LampPatchHd {
  readonly index: number;
  readonly kind: string;
  readonly atlasX: number;
  readonly atlasY: number;
  /** Top-left of the patch on the HD board, in HD pixels. */
  readonly destX: number;
  readonly destY: number;
  readonly width: number;
  readonly height: number;
}

export interface TableLampsHd {
  readonly tableId: TableId;
  readonly atlas: HdImage;
  readonly patches: readonly LampPatchHd[];
}

export interface TableBallHd extends HdImage {
  readonly tableId: TableId;
}

/** One bat pose's cell in the HD atlas, in atlas pixels. */
export interface BatCellHd {
  readonly pose: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FlipperBatsHd {
  readonly tableId: TableId;
  readonly atlas: HdImage;
  readonly cells: ReadonlyMap<number, BatCellHd>;
}

// ---------------------------------------------------------------------------
// Truecolor PNG
// ---------------------------------------------------------------------------

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("no DecompressionStream in this runtime; cannot inflate the HD PNG");
  }
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
    if (chunk.value !== undefined) {
      parts.push(chunk.value);
      total += chunk.value.length;
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

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Reverses PNG row filtering at `bpp` bytes per pixel. All five filters. */
function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const expected = height * (1 + stride);
  if (raw.length !== expected) {
    throw new Error(`inflated HD image data is ${raw.length} bytes, expected ${expected}`);
  }
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (1 + stride)] ?? 0;
    const from = y * (1 + stride) + 1;
    const to = y * stride;
    const above = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[from + x] ?? 0;
      const a = x >= bpp ? (out[to + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[above + x] ?? 0) : 0;
      const c = y > 0 && x >= bpp ? (out[above + x - bpp] ?? 0) : 0;
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
 * Decodes an 8-bit truecolor PNG — colour type 2 (RGB) or 6 (RGBA) — to RGBA.
 *
 * Refuses every other kind rather than converting it, exactly as the indexed
 * reader in `table-art.ts` does: these files come from our own exporter, and
 * anything else arriving here means something upstream changed.
 */
export async function decodeTruecolorPng(bytes: Uint8Array): Promise<HdImage> {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new Error("not a PNG: the 8-byte signature is missing");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let header: { width: number; height: number; channels: number } | null = null;
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
    if (tag === "IHDR") {
      const depth = bytes[start + 8];
      const colourType = bytes[start + 9];
      const interlace = bytes[start + 12];
      if (depth !== 8) throw new Error(`HD PNG bit depth is ${depth}; this reader only handles 8`);
      if (colourType !== 2 && colourType !== 6) {
        throw new Error(`HD PNG colour type is ${colourType}; this reader only handles 2 (RGB) and 6 (RGBA)`);
      }
      if (interlace !== 0) throw new Error("HD PNG is interlaced; this reader only handles non-interlaced");
      header = {
        width: view.getUint32(start),
        height: view.getUint32(start + 4),
        channels: colourType === 2 ? 3 : 4,
      };
    } else if (tag === "IDAT") {
      idat.push(bytes.subarray(start, end));
    } else if (tag === "IEND") {
      sawEnd = true;
      break;
    }
    offset = end + 4;
  }

  if (header === null) throw new Error("HD PNG has no IHDR chunk");
  if (idat.length === 0) throw new Error("HD PNG has no IDAT chunk");
  if (!sawEnd) throw new Error("HD PNG has no IEND chunk; the file is truncated");

  let compressedLength = 0;
  for (const part of idat) compressedLength += part.length;
  const compressed = new Uint8Array(compressedLength);
  let at = 0;
  for (const part of idat) {
    compressed.set(part, at);
    at += part.length;
  }

  const raw = unfilter(await inflate(compressed), header.width, header.height, header.channels);
  const data = new Uint8ClampedArray(header.width * header.height * BYTES_PER_PIXEL);
  if (header.channels === 4) {
    data.set(raw);
  } else {
    for (let i = 0; i < header.width * header.height; i += 1) {
      data[i * 4] = raw[i * 3] ?? 0;
      data[i * 4 + 1] = raw[i * 3 + 1] ?? 0;
      data[i * 4 + 2] = raw[i * 3 + 2] ?? 0;
      data[i * 4 + 3] = 255;
    }
  }
  return { width: header.width, height: header.height, data };
}

// ---------------------------------------------------------------------------
// Manifests and fetching
// ---------------------------------------------------------------------------

const defaultFetch: TableArtFetch = (url) => fetch(url);

async function fetchBytes(url: string, fetchImpl: TableArtFetch): Promise<Uint8Array> {
  const response: TableArtResponse = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Verifies fetched bytes against the manifest's sha256 where the runtime can.
 *
 * `crypto.subtle` exists in node and in every secure browsing context; where
 * it does not (plain-http dev hosts), the dimension checks still hold and the
 * build guard has already verified the digest at publish time.
 */
async function verifySha256(bytes: Uint8Array, expected: unknown, what: string): Promise<void> {
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`${what}: manifest carries no sha256 claim`);
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return;
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  const digest = new Uint8Array(await subtle.digest("SHA-256", owned));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  if (hex !== expected) {
    throw new Error(`${what}: sha256 ${hex.slice(0, 16)}… does not match the manifest's ${expected.slice(0, 16)}…`);
  }
}

function requireSchema(doc: Record<string, unknown>, schema: string, url: string): void {
  if (doc["schema"] !== schema) {
    throw new Error(`${url}: schema is ${String(doc["schema"])}, expected ${schema}`);
  }
}

function requireTable(doc: Record<string, unknown>, tableId: TableId, url: string): void {
  if (doc["tableId"] !== tableId) {
    throw new Error(`${url}: names table ${String(doc["tableId"])}, expected ${tableId}`);
  }
}

function wholeNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${what} is not a whole number: ${String(value)}`);
  }
  return value;
}

interface ManifestImage {
  readonly file: string;
  readonly sha256: unknown;
}

function manifestImage(doc: Record<string, unknown>, url: string): ManifestImage {
  const image = doc["image"] as Record<string, unknown> | undefined;
  const file = image?.["file"];
  if (typeof file !== "string" || !/^[A-Za-z0-9._-]+$/.test(file)) {
    throw new Error(`${url}: manifest does not name its image file`);
  }
  return { file, sha256: image?.["sha256"] };
}

async function loadManifest(
  url: string,
  fetchImpl: TableArtFetch,
): Promise<Record<string, unknown>> {
  const bytes = await fetchBytes(url, fetchImpl);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/** Fetches a manifest and its claimed image, digest-verified and decoded. */
async function loadManifestedImage(
  manifestUrl: string,
  basePath: string,
  fetchImpl: TableArtFetch,
): Promise<{ doc: Record<string, unknown>; image: HdImage }> {
  const doc = await loadManifest(manifestUrl, fetchImpl);
  const claim = manifestImage(doc, manifestUrl);
  const bytes = await fetchBytes(`${basePath}${claim.file}`, fetchImpl);
  await verifySha256(bytes, claim.sha256, `${basePath}${claim.file}`);
  return { doc, image: await decodeTruecolorPng(bytes) };
}

/**
 * Fetches and decodes one table's HD playfield master.
 *
 * The size check is the registration invariant: logical (x, y) is HD
 * (4x, 4y), no crop, no letterbox, so a master that is not exactly
 * 1344x2400 is not a picture of this playfield and must not be shown.
 */
export async function loadTableArtHd(
  tableId: TableId,
  fetchImpl: TableArtFetch = defaultFetch,
  basePath: string = TABLE_ART_BASE_PATH,
): Promise<TableArtHd> {
  const url = `${basePath}${tableId}.art-hd.json`;
  const { doc, image } = await loadManifestedImage(url, basePath, fetchImpl);
  requireSchema(doc, TABLE_ART_HD_SCHEMA, url);
  requireTable(doc, tableId, url);
  const expectedWidth = PLAYFIELD_WIDTH * HD_ASSET_SCALE;
  const expectedHeight = PLAYFIELD_HEIGHT * HD_ASSET_SCALE;
  if (image.width !== expectedWidth || image.height !== expectedHeight) {
    throw new Error(
      `HD artwork for ${tableId} is ${image.width}x${image.height}, expected ${expectedWidth}x${expectedHeight}`,
    );
  }
  return { tableId, width: image.width, height: image.height, data: image.data };
}

/** Fetches and decodes one table's HD lamp dim-patch atlas. */
export async function loadTableLampsHd(
  tableId: TableId,
  fetchImpl: TableArtFetch = defaultFetch,
  basePath: string = TABLE_ART_BASE_PATH,
): Promise<TableLampsHd> {
  const url = `${basePath}${tableId}.lamps-hd.json`;
  const { doc, image } = await loadManifestedImage(url, basePath, fetchImpl);
  requireSchema(doc, TABLE_LAMPS_HD_SCHEMA, url);
  requireTable(doc, tableId, url);
  const rawPatches = doc["patches"];
  if (!Array.isArray(rawPatches) || rawPatches.length === 0) {
    throw new Error(`${url}: manifest carries no patches`);
  }
  const patches: LampPatchHd[] = rawPatches.map((raw, i) => {
    const patch = raw as Record<string, unknown>;
    const what = `${url} patch ${i}`;
    const entry: LampPatchHd = {
      index: wholeNumber(patch["index"], `${what} index`),
      kind: typeof patch["kind"] === "string" ? patch["kind"] : "plane7",
      atlasX: wholeNumber(patch["atlasX"], `${what} atlasX`),
      atlasY: wholeNumber(patch["atlasY"], `${what} atlasY`),
      destX: wholeNumber(patch["destX"], `${what} destX`),
      destY: wholeNumber(patch["destY"], `${what} destY`),
      width: wholeNumber(patch["width"], `${what} width`),
      height: wholeNumber(patch["height"], `${what} height`),
    };
    if (entry.atlasX + entry.width > image.width || entry.atlasY + entry.height > image.height) {
      throw new Error(`${what} reads outside the ${image.width}x${image.height} atlas`);
    }
    if (
      entry.destX + entry.width > PLAYFIELD_WIDTH * HD_ASSET_SCALE ||
      entry.destY + entry.height > PLAYFIELD_HEIGHT * HD_ASSET_SCALE
    ) {
      throw new Error(`${what} lands outside the HD board`);
    }
    return entry;
  });
  return { tableId, atlas: image, patches };
}

/** Fetches and decodes one table's HD ball sprite. */
export async function loadTableBallHd(
  tableId: TableId,
  fetchImpl: TableArtFetch = defaultFetch,
  basePath: string = TABLE_ART_BASE_PATH,
): Promise<TableBallHd> {
  const url = `${basePath}${tableId}.ball-hd.json`;
  const { doc, image } = await loadManifestedImage(url, basePath, fetchImpl);
  requireSchema(doc, TABLE_BALL_HD_SCHEMA, url);
  requireTable(doc, tableId, url);
  if (image.width !== wholeNumber(doc["width"], `${url} width`) ||
      image.height !== wholeNumber(doc["height"], `${url} height`)) {
    throw new Error(`${url}: image is ${image.width}x${image.height}, not the manifest's size`);
  }
  return { tableId, width: image.width, height: image.height, data: image.data };
}

/** Fetches and decodes one table's HD flipper bat pose atlas. */
export async function loadFlipperBatsHd(
  tableId: TableId,
  fetchImpl: TableArtFetch = defaultFetch,
  basePath: string = TABLE_ART_BASE_PATH,
): Promise<FlipperBatsHd> {
  const url = `${basePath}${tableId}.bats-hd.json`;
  const { doc, image } = await loadManifestedImage(url, basePath, fetchImpl);
  requireSchema(doc, FLIPPER_BATS_HD_SCHEMA, url);
  requireTable(doc, tableId, url);
  const rawCells = doc["cells"];
  if (!Array.isArray(rawCells) || rawCells.length === 0) {
    throw new Error(`${url}: manifest carries no atlas cells`);
  }
  const cells = new Map<number, BatCellHd>();
  for (const [i, raw] of rawCells.entries()) {
    const cell = raw as Record<string, unknown>;
    const what = `${url} cell ${i}`;
    const entry: BatCellHd = {
      pose: wholeNumber(cell["pose"], `${what} pose`),
      x: wholeNumber(cell["x"], `${what} x`),
      y: wholeNumber(cell["y"], `${what} y`),
      width: wholeNumber(cell["width"], `${what} width`),
      height: wholeNumber(cell["height"], `${what} height`),
    };
    if (entry.x + entry.width > image.width || entry.y + entry.height > image.height) {
      throw new Error(`${what} reads outside the ${image.width}x${image.height} atlas`);
    }
    if (cells.has(entry.pose)) throw new Error(`${what} repeats pose ${entry.pose}`);
    cells.set(entry.pose, entry);
  }
  return { tableId, atlas: image, cells };
}
