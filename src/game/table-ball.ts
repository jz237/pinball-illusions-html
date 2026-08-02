/**
 * Loader for the shipped BALL SPRITE (`public/generated/tables/*.ball.json`).
 *
 * ---------------------------------------------------------------------------
 * WHAT ARRIVES IN THIS DOCUMENT
 * ---------------------------------------------------------------------------
 * The ball is a PER-TABLE 17x17 pixel-art sprite — the last 544 bytes of slot 6,
 * eight line-interleaved bitplanes — and `scripts/export-table-ball.mjs` ships
 * it as 289 bytes of 8-bit PALETTE INDICES into the table's own artwork palette,
 * which `table-art.ts` already holds. No colours travel in this document, so
 * there is no second copy of anyone's palette to drift.
 *
 * SEVENTEEN, NOT SIXTEEN. The disc is odd-sized with a true centre pixel, and
 * `anchor` says where that centre is: the original stores the ball's TOP-LEFT
 * at +$12/+$14 and the physical centre is +8/+8, while this reconstruction
 * stores the centre with `BALL_RADIUS_PIXELS = 8`, so the sprite's top-left is
 * `q10ToPixel(centre) - anchor`. A 16-wide implementation is half a pixel out on
 * one side and cannot be pixel-exact.
 *
 * THE MASK is main.bin's shared 221-pixel disc, and the exporter has already
 * checked that each table's own `index != 0` footprint equals it exactly. It
 * ships anyway because it is what the hardware cookie-cuts with, and because a
 * test that asserts "the drawn ball is exactly these 221 pixels" wants the disc
 * as data rather than as a number.
 *
 * THE OCCLUDERS are the two per-level STRUCTURE bitmaps the original ANDs out
 * of the mask before the blit — bit 2 and bit 3 of the shipped collision map
 * (see `materials.ts`, which identifies bit 2's only consumer as exactly this
 * draw path at main.seg00 +0x00BF3C). That is how a ramp passes in front of the
 * ball: pixels are taken out of the ball, not painted back over it.
 */

import { TABLE_IDS } from "./contracts.js";
import type { TableBallDocument, TableId } from "./contracts.js";

/** The only document schema this loader understands. */
export const TABLE_BALL_SCHEMA = "pinball-illusions/table-ball/v1";

/** Where the exported documents live under the site root (Vite serves `public/`). */
export const TABLE_BALL_BASE_PATH = "generated/tables/";

/** The sprite is 17x17 on every table. Pinned, not read, so a resize is caught. */
export const BALL_SPRITE_SIZE = 17;

/** Set pixels in the shared disc. Pinned for the same reason. */
export const BALL_MASK_PIXELS = 221;

/**
 * Collision-map bits that hide a ball pixel, by playfield level.
 *
 * Bit 2 is the level-0 structure area and bit 3 the level-1 one; see the long
 * adjudication in `materials.ts`. These do NOT block the ball — they only draw
 * in front of it, which is what this module uses them for.
 */
export const STRUCTURE_BIT_BY_LEVEL: readonly number[] = Object.freeze([4, 8]);

export interface TableBall {
  readonly tableId: TableId;
  readonly displayName: string;
  readonly width: number;
  readonly height: number;
  /** The physics centre inside the sprite. */
  readonly centreX: number;
  readonly centreY: number;
  /** Row-major 8-bit palette indices, width*height. 0 is transparent. */
  readonly pixels: Uint8Array;
  /** The shared disc: `ceil(width/8)` bytes a row, bit 0x80 leftmost. */
  readonly mask: Uint8Array;
  readonly maskRowBytes: number;
  readonly maskPixels: number;
  /** Distinct non-zero indices, ascending. Provenance and a cheap assertion. */
  readonly indicesUsed: readonly number[];
  /** sha256 of the 544 source bytes, so a test can pin the raster. */
  readonly sourceSha256: string;
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length ${value.length})`;
  return `${typeof value} ${String(value)}`;
}

function isTableId(value: string): value is TableId {
  return (TABLE_IDS as readonly string[]).includes(value);
}

function requireWholeNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a whole number in ${min}..${max}, got ${describeValue(value)}`);
  }
  return value;
}

/** `atob` rather than `Buffer`: this runs in the browser and in node tests alike. */
function bytesFromBase64(text: unknown, label: string, expected: number): Uint8Array {
  if (typeof text !== "string") {
    throw new Error(`${label} must be a base64 string, got ${describeValue(text)}`);
  }
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new Error(`${label} is not valid base64`);
  }
  if (binary.length !== expected) {
    throw new Error(`${label} decodes to ${binary.length} bytes, expected ${expected}`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Expands one document into a `TableBall`, checking every cross-reference.
 *
 * The one check worth naming: the sprite's own footprint must equal the shared
 * mask, pixel for pixel. The exporter asserts it against the disk; asserting it
 * again here means a hand-edited document cannot ship a ball with a hole in it
 * or a fringe outside the disc, which is precisely the anti-aliasing defect this
 * round exists to remove.
 */
export function parseTableBallDocument(doc: TableBallDocument): TableBall {
  const raw = doc as unknown as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(`table ball document must be an object, got ${describeValue(doc)}`);
  }
  if (raw["schema"] !== TABLE_BALL_SCHEMA) {
    throw new Error(
      `table ball document has schema ${describeValue(raw["schema"])}, expected "${TABLE_BALL_SCHEMA}"`,
    );
  }
  const tableIdValue = raw["tableId"];
  if (typeof tableIdValue !== "string" || !isTableId(tableIdValue)) {
    throw new Error(`table ball document has unknown tableId ${describeValue(tableIdValue)}`);
  }
  const tableId: TableId = tableIdValue;
  const label = `table ball "${tableId}"`;

  const displayName = raw["displayName"];
  if (typeof displayName !== "string" || displayName.length === 0) {
    throw new Error(`${label} has a non-string or empty displayName`);
  }

  const width = requireWholeNumber(raw["width"], `${label} width`, 1, 64);
  const height = requireWholeNumber(raw["height"], `${label} height`, 1, 64);
  if (width !== BALL_SPRITE_SIZE || height !== BALL_SPRITE_SIZE) {
    throw new Error(`${label} is ${width}x${height}; the decoded ball is ${BALL_SPRITE_SIZE} square`);
  }

  const anchor = raw["anchor"] as Record<string, unknown> | undefined;
  const centreX = requireWholeNumber(anchor?.["centreX"], `${label} anchor.centreX`, 0, width - 1);
  const centreY = requireWholeNumber(anchor?.["centreY"], `${label} anchor.centreY`, 0, height - 1);

  const pixels = bytesFromBase64(raw["pixels"], `${label} pixels`, width * height);

  const mask = raw["mask"] as Record<string, unknown> | undefined;
  const maskRowBytes = requireWholeNumber(mask?.["rowBytes"], `${label} mask.rowBytes`, 1, 8);
  if (maskRowBytes !== Math.ceil(width / 8)) {
    throw new Error(`${label} mask.rowBytes ${maskRowBytes} does not fit a ${width}-pixel row`);
  }
  const maskPixels = requireWholeNumber(mask?.["setPixels"], `${label} mask.setPixels`, 1, width * height);
  if (maskPixels !== BALL_MASK_PIXELS) {
    throw new Error(`${label} mask holds ${maskPixels} pixels; the decoded disc is ${BALL_MASK_PIXELS}`);
  }
  const maskRows = bytesFromBase64(mask?.["rows"], `${label} mask.rows`, maskRowBytes * height);

  // The footprint check, both ways round, on every pixel.
  let set = 0;
  let disagreements = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inMask = ((maskRows[y * maskRowBytes + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0;
      if (inMask) set += 1;
      if (inMask !== ((pixels[y * width + x] ?? 0) !== 0)) disagreements += 1;
    }
  }
  if (set !== maskPixels) {
    throw new Error(`${label} mask declares ${maskPixels} pixels but sets ${set}`);
  }
  if (disagreements > 0) {
    throw new Error(
      `${label}: ${disagreements} pixels disagree between the sprite and its mask; the ball ` +
        `would draw outside the disc or leave a hole in it`,
    );
  }

  const indicesValue = raw["indicesUsed"];
  if (!Array.isArray(indicesValue)) throw new Error(`${label} indicesUsed must be an array`);
  const indicesUsed: number[] = [];
  for (const [at, entry] of indicesValue.entries()) {
    const index = requireWholeNumber(entry, `${label} indicesUsed[${at}]`, 1, 255);
    if (at > 0 && index <= (indicesUsed[at - 1] ?? 0)) {
      throw new Error(`${label} indicesUsed is not strictly ascending at ${at}`);
    }
    indicesUsed.push(index);
  }
  const seen = new Set(pixels);
  seen.delete(0);
  if (seen.size !== indicesUsed.length || indicesUsed.some((index) => !seen.has(index))) {
    throw new Error(`${label} indicesUsed does not match the indices the sprite actually uses`);
  }

  const source = raw["source"] as Record<string, unknown> | undefined;
  const sourceSha256 = source?.["sha256"];
  if (typeof sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(sourceSha256)) {
    throw new Error(`${label} carries no sha256 for its 544 source bytes`);
  }

  return Object.freeze({
    tableId,
    displayName,
    width,
    height,
    centreX,
    centreY,
    pixels,
    mask: maskRows,
    maskRowBytes,
    maskPixels,
    indicesUsed: Object.freeze(indicesUsed),
    sourceSha256,
  });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<TableId, TableBall>();

/** Makes one table's ball sprite available to the renderer. Idempotent. */
export function registerTableBall(ball: TableBall): void {
  REGISTRY.set(ball.tableId, ball);
}

/** Forgets every registration. For tests that need a clean slate. */
export function clearTableBalls(): void {
  REGISTRY.clear();
}

/**
 * One table's ball sprite, or null.
 *
 * Nullable for the same reason the lamp layer is: a synthetic map in a physics
 * test has no sprite and must still simulate. The renderer treats null as "draw
 * the fallback marker", never as an excuse to invent a ball.
 */
export function tableBallFor(tableId: TableId): TableBall | null {
  return REGISTRY.get(tableId) ?? null;
}

/** URL of one table's exported ball sprite, relative to the site root. */
export function tableBallUrl(tableId: TableId, basePath: string = TABLE_BALL_BASE_PATH): string {
  return `${basePath}${tableId}.ball.json`;
}

/** The slice of `Response` this loader needs, so tests can pass a plain object. */
export interface TableBallResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export type TableBallFetch = (url: string) => Promise<TableBallResponse>;

const defaultFetch: TableBallFetch = (url) => fetch(url);

/** Fetches, parses and REGISTERS one table's ball sprite. */
export async function loadTableBall(
  tableId: TableId,
  fetchImpl: TableBallFetch = defaultFetch,
  basePath: string = TABLE_BALL_BASE_PATH,
): Promise<TableBall> {
  const url = tableBallUrl(tableId, basePath);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const doc = (await response.json()) as TableBallDocument;
  const ball = parseTableBallDocument(doc);
  registerTableBall(ball);
  return ball;
}
