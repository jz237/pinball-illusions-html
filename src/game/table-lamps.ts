/**
 * Loader for the shipped playfield LAMP LAYER
 * (`public/generated/tables/*.lamps.json`).
 *
 * ---------------------------------------------------------------------------
 * WHAT ARRIVES IN THIS DOCUMENT
 * ---------------------------------------------------------------------------
 * The lamps are the missing half of the mission machine's conversation with the
 * player: the mode VM arms an element, and on the real table the insert under
 * that shot lights up. `scripts/export-table-lamps.mjs` decodes, per table:
 *
 *   LAMPS     every lamp object the original's per-frame scan (main.seg00
 *             $64D0) can reach, with its decoded playfield position and shape.
 *             Two drawable kinds:
 *
 *             "plane7" — an insert whose pixels the original toggles between
 *             the two halves of the 256-colour palette. THE SHIPPED ARTWORK
 *             STORES EVERY INSERT LIT (verified: all mask pixels on all three
 *             tables sit on bit-7-clear palette indices), and the OFF blit sets
 *             bit 7 of each masked pixel, moving it into the upper palette half
 *             where the artist put the dim variants. So the lamp's off state is
 *             not shipped pixel data at all: it is `artworkIndex | 0x80`
 *             through the artwork's own palette, and this document carries only
 *             the mask saying which pixels take part.
 *
 *             "masked" — a full-colour overlay with explicit OFF and ON images
 *             (Extreme Sports ships six). Both states arrive as 8-bit palette
 *             indices plus the cookie-cut mask.
 *
 *             "none" — a chain dummy the original never draws (flags bit 2).
 *
 *   ELEMENTS  dense, in the SAME element-pool order as `*.modes.json` (the
 *             exporter recomputes the pool and cross-checks it against the
 *             shipped modes document): each element's start-path lamp (+$04,
 *             lit blinking by `START`) and award-path lamp (+$08, relit steady
 *             by `AWARD`), as lamp indices or -1.
 *
 *   BLINK     the measured half-period: the `START` handler writes 8 into the
 *             lamp's blink reload byte, so an armed shot is 8 frames visible,
 *             8 frames dark.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PARSER IS AS SUSPICIOUS AS THE OTHERS
 * ---------------------------------------------------------------------------
 * A lamp quietly one pixel out draws a lit insert over the wrong paint, and a
 * wiring entry one index out lights the wrong shot — both invisible from the
 * outside and both exactly the class of defect this project keeps refusing to
 * ship. Every position, mask length and cross-reference is re-checked here and
 * the first inconsistency throws.
 */

import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH, TABLE_IDS } from "./contracts.js";
import type { TableId, TableLampsDocument } from "./contracts.js";

/** The only document schema this loader understands. */
export const TABLE_LAMPS_SCHEMA = "pinball-illusions/table-lamps/v1";

/** Where the exported documents live under the site root (Vite serves `public/`). */
export const TABLE_LAMPS_BASE_PATH = "generated/tables/";

export type TableLampKind = "plane7" | "masked" | "none";

/** One decoded lamp: an insert overlay at a fixed playfield position. */
export interface TableLamp {
  readonly index: number;
  /** The original's lamp group, or -1 for an engine-list-only lamp. */
  readonly group: number;
  readonly kind: TableLampKind;
  /** Top-left playfield pixel of the overlay. Zero for kind "none". */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Row-major mask, width/8 bytes per row, bit 0x80 the leftmost pixel. */
  readonly mask: Uint8Array;
  /** "masked" only: 8-bit palette indices, width*height, for the OFF state. */
  readonly off: Uint8Array | null;
  /** "masked" only: the same for the ON state. */
  readonly on: Uint8Array | null;
}

/** One element's lamps: indices into `TableLamps.lamps`, or -1. */
export interface LampWiring {
  /** The +$04 lamp `START` lights blinking while the element is armed. */
  readonly start: number;
  /** The +$08 lamp `AWARD` relights steady. */
  readonly award: number;
}

export interface TableLamps {
  readonly tableId: TableId;
  readonly displayName: string;
  /** MEASURED: frames per blink half-period (START writes 8 into the reload). */
  readonly blinkHalfPeriodFrames: number;
  readonly lamps: readonly TableLamp[];
  /** Dense, in the modes document's element-pool order. */
  readonly elements: readonly LampWiring[];
  /** Per lamp, the elements whose START path lights it. Derived, for the renderer. */
  readonly startElementsByLamp: readonly (readonly number[])[];
  /** Per lamp, the elements whose AWARD path relights it. */
  readonly awardElementsByLamp: readonly (readonly number[])[];
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

/**
 * Decodes standard base64 to bytes.
 *
 * `atob` rather than `Buffer`: this file runs in the browser and in node tests
 * alike, and node (16+) has had the global for as long as this project's
 * toolchain requires.
 */
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

/** Expands one document into a `TableLamps`, checking every cross-reference. */
export function parseTableLampsDocument(doc: TableLampsDocument): TableLamps {
  const raw = doc as unknown as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(`table lamps document must be an object, got ${describeValue(doc)}`);
  }
  if (raw["schema"] !== TABLE_LAMPS_SCHEMA) {
    throw new Error(
      `table lamps document has schema ${describeValue(raw["schema"])}, expected "${TABLE_LAMPS_SCHEMA}"`,
    );
  }
  const tableIdValue = raw["tableId"];
  if (typeof tableIdValue !== "string" || !isTableId(tableIdValue)) {
    throw new Error(`table lamps document has unknown tableId ${describeValue(tableIdValue)}`);
  }
  const tableId: TableId = tableIdValue;
  const label = `table lamps "${tableId}"`;

  const displayName = raw["displayName"];
  if (typeof displayName !== "string" || displayName.length === 0) {
    throw new Error(`${label} has a non-string or empty displayName`);
  }

  const blink = raw["blink"] as Record<string, unknown> | undefined;
  const blinkHalfPeriodFrames = requireWholeNumber(
    blink?.["halfPeriodFrames"],
    `${label} blink.halfPeriodFrames`,
    1,
    255,
  );

  const lampsValue = raw["lamps"];
  if (!Array.isArray(lampsValue)) throw new Error(`${label} lamps must be an array`);
  const lamps: TableLamp[] = [];
  for (const [at, entry] of lampsValue.entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} lamp ${at}`;
    const index = requireWholeNumber(item["index"], `${where} index`, 0, 4095);
    if (index !== at) throw new Error(`${where} is filed at slot ${at}; the list must be dense`);
    const group = requireWholeNumber(item["group"], `${where} group`, -1, 255);
    const kind = item["kind"];
    if (kind === "none") {
      lamps.push(
        Object.freeze({
          index,
          group,
          kind,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          mask: new Uint8Array(0),
          off: null,
          on: null,
        }),
      );
      continue;
    }
    if (kind !== "plane7" && kind !== "masked") {
      throw new Error(`${where} has unknown kind ${describeValue(kind)}`);
    }
    const width = requireWholeNumber(item["width"], `${where} width`, 8, PLAYFIELD_WIDTH);
    const height = requireWholeNumber(item["height"], `${where} height`, 1, PLAYFIELD_HEIGHT);
    if (width % 8 !== 0) throw new Error(`${where} width ${width} is not a whole number of bytes`);
    const x = requireWholeNumber(item["x"], `${where} x`, 0, PLAYFIELD_WIDTH - width);
    const y = requireWholeNumber(item["y"], `${where} y`, 0, PLAYFIELD_HEIGHT - height);
    const mask = bytesFromBase64(item["mask"], `${where} mask`, (width / 8) * height);
    let off: Uint8Array | null = null;
    let on: Uint8Array | null = null;
    if (kind === "masked") {
      off = bytesFromBase64(item["off"], `${where} off image`, width * height);
      on = bytesFromBase64(item["on"], `${where} on image`, width * height);
    }
    lamps.push(Object.freeze({ index, group, kind, x, y, width, height, mask, off, on }));
  }

  const elementsValue = raw["elements"];
  if (!Array.isArray(elementsValue)) throw new Error(`${label} elements must be an array`);
  const elements: LampWiring[] = [];
  const startElementsByLamp: number[][] = lamps.map(() => []);
  const awardElementsByLamp: number[][] = lamps.map(() => []);
  for (const [at, entry] of elementsValue.entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} element ${at}`;
    const start = requireWholeNumber(item["start"], `${where} start lamp`, -1, lamps.length - 1);
    const award = requireWholeNumber(item["award"], `${where} award lamp`, -1, lamps.length - 1);
    if (start >= 0) startElementsByLamp[start]?.push(at);
    if (award >= 0) awardElementsByLamp[award]?.push(at);
    elements.push(Object.freeze({ start, award }));
  }

  return Object.freeze({
    tableId,
    displayName,
    blinkHalfPeriodFrames,
    lamps: Object.freeze(lamps),
    elements: Object.freeze(elements),
    startElementsByLamp: Object.freeze(startElementsByLamp.map((list) => Object.freeze(list))),
    awardElementsByLamp: Object.freeze(awardElementsByLamp.map((list) => Object.freeze(list))),
  });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<TableId, TableLamps>();

/** Makes one table's lamp layer available to `createGame`. Idempotent. */
export function registerTableLamps(lamps: TableLamps): void {
  REGISTRY.set(lamps.tableId, lamps);
}

/** Forgets every registration. For tests that need a clean slate. */
export function clearTableLamps(): void {
  REGISTRY.clear();
}

/**
 * One table's lamp layer, or null.
 *
 * Nullable for the same reason the mission layer is: a table without lamp
 * overlays rolls exactly the same ball and merely shows the static artwork,
 * and every physics test on a synthetic map must go on working. The renderer
 * treats null as "draw nothing extra", never as an excuse to invent a lamp.
 */
export function tableLampsFor(tableId: TableId): TableLamps | null {
  return REGISTRY.get(tableId) ?? null;
}

/** URL of one table's exported lamp layer, relative to the site root. */
export function tableLampsUrl(tableId: TableId, basePath: string = TABLE_LAMPS_BASE_PATH): string {
  return `${basePath}${tableId}.lamps.json`;
}

/** The slice of `Response` this loader needs, so tests can pass a plain object. */
export interface TableLampsResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export type TableLampsFetch = (url: string) => Promise<TableLampsResponse>;

const defaultFetch: TableLampsFetch = (url) => fetch(url);

/** Fetches, parses and REGISTERS one table's lamp layer. */
export async function loadTableLamps(
  tableId: TableId,
  fetchImpl: TableLampsFetch = defaultFetch,
  basePath: string = TABLE_LAMPS_BASE_PATH,
): Promise<TableLamps> {
  const url = tableLampsUrl(tableId, basePath);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const doc = (await response.json()) as TableLampsDocument;
  const lamps = parseTableLampsDocument(doc);
  registerTableLamps(lamps);
  return lamps;
}
