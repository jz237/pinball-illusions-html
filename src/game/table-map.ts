/**
 * Loader for the shipped playfield maps (`public/generated/tables/*.map.json`).
 *
 * The export is run-length encoded per row: each row is a flat list of
 * `[inclusive_end_x, material]` pairs, the first run starting at x=0 and the
 * last ending exactly at width-1. That is a lossless encoding of the four
 * bitplanes decoded from slot 2, so expansion here must be exact — a map that
 * is silently one pixel wrong anywhere produces a table where the ball tunnels
 * through a wall, and that failure is almost impossible to trace back to the
 * loader. Hence: validate everything, throw on the first inconsistency, and
 * never repair a malformed document by guessing.
 *
 * The parser is pure and takes an already-parsed document; `loadTableMap` is
 * the only part that touches the network.
 */

import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH, TABLE_IDS } from "./contracts.js";
import type { MaterialIndex, TableId, TableMap, TableMapDocument } from "./contracts.js";
import { SOLID_BORDER_INDEX } from "./materials.js";

/** The only document schema this loader understands. */
export const TABLE_MAP_SCHEMA = "pinball-illusions/table-map/v1";

/** Four bitplanes OR together into 0..15, so nothing outside that range is legal. */
export const MAX_MATERIAL_INDEX = 15;

/** Where the exported maps live under the site root (Vite serves `public/` there). */
export const TABLE_MAP_BASE_PATH = "generated/tables/";

/**
 * The material an off-map probe reads.
 *
 * `SOLID_BORDER_INDEX` is 5, the level-0 collision line inside the structure
 * mask — the same index as the real outer table wall (see materials.ts). Two
 * reasons it is the right answer for out-of-bounds:
 *
 *  1. Bit 0 is set, so every material table marks it non-passable. The collision
 *     probe therefore treats the edge of the bitmap as wall and a ball can never
 *     leave the map, whatever velocity a nudge or a bumper gives it.
 *  2. It is an *existing* index rather than a synthetic sentinel, so callers can
 *     hand it straight to `behaviourFor()` without a special case.
 *
 * This does not close the drain. The drain is the index-0 gap on the last
 * physics row (y=599); the ball simulation detects it by comparing y against the
 * physics bound, which is a deliberate exit. Out-of-bounds is the *undefined*
 * case, and there the safe answer is solid: a ball lost off the side of the
 * bitmap can never be recovered, whereas a ball stopped at the edge merely
 * looks slightly wrong for one tick.
 */
export const OUT_OF_BOUNDS_MATERIAL: MaterialIndex = SOLID_BORDER_INDEX;

function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `array(length ${value.length})`;
  }
  return `${typeof value} ${String(value)}`;
}

function isTableId(value: string): value is TableId {
  return (TABLE_IDS as readonly string[]).includes(value);
}

/**
 * Expands one document into a `TableMap`.
 *
 * Throws a descriptive `Error` on any inconsistency rather than producing a map
 * that is quietly wrong. The document is typed, but it comes from `JSON.parse`,
 * so the annotation guarantees nothing at runtime and every field is re-checked.
 */
export function parseTableMapDocument(doc: TableMapDocument): TableMap {
  const raw = doc as unknown as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(`table map document must be an object, got ${describeValue(doc)}`);
  }

  const schema = raw["schema"];
  if (schema !== TABLE_MAP_SCHEMA) {
    throw new Error(
      `table map document has schema ${describeValue(schema)}, expected "${TABLE_MAP_SCHEMA}"`,
    );
  }

  const tableIdValue = raw["tableId"];
  if (typeof tableIdValue !== "string" || !isTableId(tableIdValue)) {
    throw new Error(
      `table map document has unknown tableId ${describeValue(tableIdValue)}; expected one of ${TABLE_IDS.join(", ")}`,
    );
  }
  const tableId: TableId = tableIdValue;
  const label = `table map "${tableId}"`;

  const displayName = raw["displayName"];
  if (typeof displayName !== "string" || displayName.length === 0) {
    throw new Error(`${label} has a non-string or empty displayName: ${describeValue(displayName)}`);
  }

  const declaredWidth = raw["width"];
  if (declaredWidth !== PLAYFIELD_WIDTH) {
    throw new Error(`${label} has width ${describeValue(declaredWidth)}, expected ${PLAYFIELD_WIDTH}`);
  }
  const declaredHeight = raw["height"];
  if (declaredHeight !== PLAYFIELD_HEIGHT) {
    throw new Error(
      `${label} has height ${describeValue(declaredHeight)}, expected ${PLAYFIELD_HEIGHT}`,
    );
  }
  // Use the constants from here on: the document only ever gets to agree with
  // them, so the rest of the expansion needs no narrowing of the raw values.
  const width = PLAYFIELD_WIDTH;
  const height = PLAYFIELD_HEIGHT;

  const rows = raw["rows"];
  if (!Array.isArray(rows)) {
    throw new Error(`${label} has non-array rows: ${describeValue(rows)}`);
  }
  if (rows.length !== height) {
    throw new Error(`${label} has ${rows.length} rows, expected exactly ${height}`);
  }

  const pixels = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const row: unknown = rows[y];
    if (!Array.isArray(row)) {
      throw new Error(`${label} row ${y} is not an array: ${describeValue(row)}`);
    }
    if (row.length === 0) {
      throw new Error(`${label} row ${y} is empty; every row must cover x 0..${width - 1}`);
    }
    if (row.length % 2 !== 0) {
      throw new Error(
        `${label} row ${y} has ${row.length} values; runs are [end_x, material] pairs so the count must be even`,
      );
    }

    const rowBase = y * width;
    // -1 rather than 0 so the first run is required to start at x=0 by the same
    // strictly-increasing rule that separates every later run.
    let previousEnd = -1;

    for (let i = 0; i < row.length; i += 2) {
      const endValue: unknown = row[i];
      const materialValue: unknown = row[i + 1];

      if (typeof endValue !== "number" || !Number.isInteger(endValue)) {
        throw new Error(
          `${label} row ${y} run ${i / 2} has a non-integer end_x: ${describeValue(endValue)}`,
        );
      }
      if (endValue <= previousEnd) {
        throw new Error(
          `${label} row ${y} run ${i / 2} ends at x=${endValue}, which does not advance past the previous run's end x=${previousEnd}; ends must strictly increase`,
        );
      }
      if (endValue > width - 1) {
        throw new Error(
          `${label} row ${y} run ${i / 2} ends at x=${endValue}, past the last column ${width - 1}`,
        );
      }
      if (typeof materialValue !== "number" || !Number.isInteger(materialValue)) {
        throw new Error(
          `${label} row ${y} run ${i / 2} has a non-integer material: ${describeValue(materialValue)}`,
        );
      }
      if (materialValue < 0 || materialValue > MAX_MATERIAL_INDEX) {
        throw new Error(
          `${label} row ${y} run ${i / 2} has material ${materialValue}, outside 0..${MAX_MATERIAL_INDEX}`,
        );
      }

      pixels.fill(materialValue, rowBase + previousEnd + 1, rowBase + endValue + 1);
      previousEnd = endValue;
    }

    if (previousEnd !== width - 1) {
      throw new Error(
        `${label} row ${y} ends at x=${previousEnd}, leaving columns ${previousEnd + 1}..${width - 1} undefined; the last run must end at ${width - 1}`,
      );
    }
  }

  return makeTableMap(tableId, displayName, width, height, pixels);
}

function makeTableMap(
  tableId: TableId,
  displayName: string,
  width: number,
  height: number,
  pixels: Uint8Array,
): TableMap {
  return Object.freeze({
    tableId,
    displayName,
    width,
    height,
    pixels,
    materialAt(x: number, y: number): MaterialIndex {
      // Floor, not round or truncate: pixel (0,0) owns the half-open square
      // [0,1)x[0,1), and flooring matches `q10ToPixel`'s arithmetic shift for
      // negative values too, so probe coordinates convert consistently.
      const px = Math.floor(x);
      const py = Math.floor(y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) {
        return OUT_OF_BOUNDS_MATERIAL;
      }
      if (px < 0 || px >= width || py < 0 || py >= height) {
        return OUT_OF_BOUNDS_MATERIAL;
      }
      const value = pixels[py * width + px];
      // Parsing rejected anything outside 0..15, so the cast is sound; the
      // undefined branch is unreachable and exists only to keep the bounds
      // logic the single source of truth.
      return value === undefined ? OUT_OF_BOUNDS_MATERIAL : (value as MaterialIndex);
    },
  });
}

/**
 * Counts each material present in an expanded map.
 *
 * Zero-count indices are omitted, mirroring the exporter — Law 'n Justice has no
 * index 3 at all and its document simply has no "3" key. Comparing this against
 * `document.materialHistogram` is an end-to-end check of the run encoding.
 */
export function materialHistogramOf(map: TableMap): Record<string, number> {
  const counts = new Uint32Array(MAX_MATERIAL_INDEX + 1);
  for (const value of map.pixels) {
    const slot = counts[value];
    if (slot === undefined) {
      throw new Error(`map ${map.tableId} contains material ${value}, outside 0..${MAX_MATERIAL_INDEX}`);
    }
    counts[value] = slot + 1;
  }
  const histogram: Record<string, number> = {};
  for (let index = 0; index <= MAX_MATERIAL_INDEX; index += 1) {
    const count = counts[index] ?? 0;
    if (count > 0) {
      histogram[String(index)] = count;
    }
  }
  return histogram;
}

/** URL of one table's exported map, relative to the site root. */
export function tableMapUrl(tableId: TableId, basePath: string = TABLE_MAP_BASE_PATH): string {
  return `${basePath}${tableId}.map.json`;
}

/** The slice of `Response` this loader needs, so tests can pass a plain object. */
export interface TableMapResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export type TableMapFetch = (url: string) => Promise<TableMapResponse>;

// Wrapped rather than passing `fetch` itself: an unbound reference to the global
// throws "Illegal invocation" in browsers.
const defaultFetch: TableMapFetch = (url) => fetch(url);

/**
 * Fetches and parses one table's map.
 *
 * Deliberately thin, and the only network-touching function in this module, so
 * the parser above can be tested exhaustively without any I/O. Results are not
 * cached here — a map is ~200KB and the caller decides how long to hold it.
 */
export async function loadTableMap(
  tableId: TableId,
  fetchImpl: TableMapFetch = defaultFetch,
  basePath: string = TABLE_MAP_BASE_PATH,
): Promise<TableMap> {
  const url = tableMapUrl(tableId, basePath);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const doc = (await response.json()) as TableMapDocument;
  return parseTableMapDocument(doc);
}
