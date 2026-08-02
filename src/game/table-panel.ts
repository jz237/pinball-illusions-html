/**
 * Loader and decoder for the shipped SCORE-PANEL ANIMATION HEAP
 * (`public/generated/tables/*.panel.json`).
 *
 * ---------------------------------------------------------------------------
 * WHAT ARRIVES IN THIS DOCUMENT
 * ---------------------------------------------------------------------------
 * The original's score panel is a 320x16 strip the display queue at $6C2C
 * plays animations on, one at a time, between showings of the score. Slot 5 of
 * each table package is the heap of those animations, and
 * `scripts/export-table-panel.mjs` ships every object in it PACKED — the
 * base64 of the object's own disk bytes — because the disk format is already a
 * compact delta encoding and re-encoding it would only add invention:
 *
 *   OBJECTS   28-byte header {12 runtime bytes zero on disk; +$0C u16 speed
 *             divider (frames per animation step); +$16 u16 WIDTH FIELD, bytes
 *             per row per plane = field/4 ($A0 = the full 320px); +$18 u16
 *             height (16, two 15s); +$1A u16 frame count 1..79}, then frame 0
 *             raw as two plane-sequential bitplanes, then each further frame
 *             as RLE deltas against the previous frame: per plane-row stream,
 *             `00 cnt val` = fill run (cnt 0 = 256), `80|cnt` + bytes =
 *             literal run, `01..7F` = keep that many bytes of the previous
 *             frame. `decodePanelObjectFrames` below applies exactly that and
 *             nothing else.
 *
 *   BLOBS     Law 'n Justice's two headerless blitter blobs (h5+$0 pattern,
 *             h5+$78 mask), stamped by the original as 48x15 indicator glyphs.
 *
 *   WIRING    which objects each mode element queues on START (+$14) and AWARD
 *             (+$18), which each message record shows (same indices as the
 *             modes document's pools), the type-1 device animations (+$06 —
 *             empty on all three shipped tables), the descriptor's +$84
 *             attract/score-trailer objects, and `other` — directive sites (the
 *             credits records) nothing decoded claims, kept factually by their
 *             hunk-4 offsets.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PARSER IS AS SUSPICIOUS AS THE OTHERS
 * ---------------------------------------------------------------------------
 * The packed bytes are the source of truth and the JSON fields beside them are
 * claims about those bytes, so the parser re-reads the header out of `packed`
 * and refuses any disagreement, and the decoder demands every RLE stream land
 * exactly on its row width and the whole object consume exactly its byte
 * range — the property that proved the format in the first place. A stream one
 * byte off would silently shear every following frame; here it throws instead.
 *
 * Decoding is on demand (an 88-object heap decoded eagerly is megabytes of
 * frames nobody may watch), deterministic, and canvas-free: a frame is a plain
 * `Uint8Array` of two plane-sequential bitplanes for the renderer to blit.
 */

import { TABLE_IDS } from "./contracts.js";
import type { TableId } from "./contracts.js";

/** The only document schema this loader understands. */
export const TABLE_PANEL_SCHEMA = "pinball-illusions/table-panel/v1";

/** Where the exported documents live under the site root (Vite serves `public/`). */
export const TABLE_PANEL_BASE_PATH = "generated/tables/";

/** The panel strip the objects are blitted onto. */
export const PANEL_WIDTH = 320;
export const PANEL_HEIGHT = 16;
export const PANEL_PLANES = 2;

/** Object header layout inside `packed`. Byte offsets, u16s big-endian. */
const OBJ_HEADER_BYTES = 0x1c;
const OBJ_RUNTIME_BYTES = 12;
const OBJ_SPEED = 0x0c;
const OBJ_ZERO_TAIL = 0x0e;
const OBJ_WIDTH_FIELD = 0x16;
const OBJ_HEIGHT = 0x18;
const OBJ_FRAMES = 0x1a;

/** Measured field bounds; see the exporter's census. */
const SPEED_MAX = 50;
const FRAMES_MAX = 79;
const WIDTH_FIELD_MAX = 0xa0;

/** One packed animation object. `packed` is the object's own disk bytes. */
export interface PanelObject {
  readonly id: number;
  /** The object's offset in the original slot-5 heap, for provenance joins. */
  readonly offset: number;
  /** Speed divider: frames of delay per animation step. */
  readonly speed: number;
  /** The header's raw width field; bytes per row per plane is `width / 4`. */
  readonly width: number;
  /** Rows per plane: 16, or 15 on two objects. */
  readonly height: number;
  /** Frame count, 1..79. */
  readonly frames: number;
  /** Derived: bytes per row per plane (`width / 4`). */
  readonly bytesPerRow: number;
  /** Derived: the object's width in pixels (`width * 2`). */
  readonly pixelWidth: number;
  /** The full original object bytes: header, raw frame 0, RLE delta frames. */
  readonly packed: Uint8Array;
}

/** One of Law 'n Justice's headerless 48x15 indicator glyph blobs. */
export interface PanelBlob {
  readonly id: string;
  readonly offset: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
}

/** Objects a mode element queues, by the modes document's element index. */
export interface PanelElementWiring {
  readonly element: number;
  /** Queued by START, from the element's +$14 display record. */
  readonly start: readonly number[];
  /** Queued by AWARD, from the element's +$18 display record. */
  readonly award: readonly number[];
}

/** Objects a message record shows, by the modes document's message index. */
export interface PanelMessageWiring {
  readonly message: number;
  readonly objects: readonly number[];
}

/** Objects a type-1 device's +$06 animation record names. None shipped. */
export interface PanelDeviceWiring {
  readonly level: number;
  readonly surfaceId: number;
  readonly objects: readonly number[];
}

/** A directive site no decoded record claims (the credits records). */
export interface PanelOtherReference {
  /** The hunk-4 byte offset of the relocated pointer. */
  readonly site: number;
  readonly object: number;
}

export interface PanelReferences {
  readonly elements: readonly PanelElementWiring[];
  readonly messages: readonly PanelMessageWiring[];
  readonly devices: readonly PanelDeviceWiring[];
  /** The descriptor +$84 attract/score-trailer record's objects. */
  readonly trailer: readonly number[];
  readonly other: readonly PanelOtherReference[];
}

export interface TablePanel {
  readonly tableId: TableId;
  readonly displayName: string;
  readonly objects: readonly PanelObject[];
  readonly blobs: readonly PanelBlob[];
  readonly references: PanelReferences;
}

/** The document shape the exporter writes. */
export interface TablePanelDocument {
  readonly schema: string;
  readonly tableId: string;
  readonly displayName: string;
  readonly provenance: {
    readonly sourceClass: string;
    readonly description: string;
    readonly authorizationRequired: boolean;
  };
  readonly panel: { readonly width: number; readonly height: number; readonly planes: number };
  readonly objects: readonly unknown[];
  readonly blobs: readonly unknown[];
  readonly references: unknown;
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
function bytesFromBase64(text: unknown, label: string): Uint8Array {
  if (typeof text !== "string") {
    throw new Error(`${label} must be a base64 string, got ${describeValue(text)}`);
  }
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new Error(`${label} is not valid base64`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}

function readU16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

/** The byte length of one decoded frame of `object`: two planes of rows. */
export function panelFrameBytes(object: Pick<PanelObject, "bytesPerRow" | "height">): number {
  return PANEL_PLANES * object.height * object.bytesPerRow;
}

/**
 * Parses one object entry, holding the JSON fields to the header bytes inside
 * `packed` — the fields are CLAIMS about those bytes and any disagreement is a
 * corrupt document, refused loudly.
 */
function parseObject(entry: unknown, at: number, label: string): PanelObject {
  const item = entry as Record<string, unknown>;
  const where = `${label} object ${at}`;
  const id = requireWholeNumber(item["id"], `${where} id`, 0, 4095);
  if (id !== at) throw new Error(`${where} is filed at slot ${at}; the list must be dense`);
  const offset = requireWholeNumber(item["offset"], `${where} offset`, 0, 0x7fffffff);
  const speed = requireWholeNumber(item["speed"], `${where} speed`, 1, SPEED_MAX);
  const width = requireWholeNumber(item["width"], `${where} width field`, 4, WIDTH_FIELD_MAX);
  if (width % 4 !== 0) {
    throw new Error(`${where} width field ${width} is not a whole number of row bytes`);
  }
  const height = requireWholeNumber(item["height"], `${where} height`, 15, 16);
  const frames = requireWholeNumber(item["frames"], `${where} frames`, 1, FRAMES_MAX);
  const packed = bytesFromBase64(item["packed"], `${where} packed`);

  const bytesPerRow = width / 4;
  const rawBytes = OBJ_HEADER_BYTES + PANEL_PLANES * height * bytesPerRow;
  if (packed.length < rawBytes) {
    throw new Error(
      `${where} packed holds ${packed.length} bytes, fewer than the ${rawBytes} its header ` +
        `and raw frame 0 need`,
    );
  }
  for (let i = 0; i < OBJ_RUNTIME_BYTES; i += 1) {
    if (packed[i] !== 0) throw new Error(`${where} runtime byte +0x${i.toString(16)} is not zero`);
  }
  for (let i = OBJ_ZERO_TAIL; i < OBJ_WIDTH_FIELD; i += 1) {
    if (packed[i] !== 0) throw new Error(`${where} header byte +0x${i.toString(16)} is not zero`);
  }
  const claims: readonly [number, number, string][] = [
    [OBJ_SPEED, speed, "speed"],
    [OBJ_WIDTH_FIELD, width, "width field"],
    [OBJ_HEIGHT, height, "height"],
    [OBJ_FRAMES, frames, "frame count"],
  ];
  for (const [headerAt, declared, name] of claims) {
    const held = readU16(packed, headerAt);
    if (held !== declared) {
      throw new Error(
        `${where} declares ${name} ${declared} but its packed header holds ${held}; ` +
          `the document is corrupt`,
      );
    }
  }
  return Object.freeze({
    id,
    offset,
    speed,
    width,
    height,
    frames,
    bytesPerRow,
    pixelWidth: width * 2,
    packed,
  });
}

/**
 * Decodes an object's complete frame sequence, on demand.
 *
 * Frame 0 is the raw two-plane bitmap after the header; every further frame is
 * the previous frame patched by the documented RLE, stream by stream — one
 * stream per plane-row in frame-buffer order (plane 0 rows first, then plane
 * 1, exactly the raw frame's own layout), each landing exactly on the row
 * width. The final byte of the final frame must be the final byte of `packed`;
 * a document where it is not does not decode a little — it throws.
 *
 * Returns `frames` buffers of `panelFrameBytes(object)` bytes each.
 */
export function decodePanelObjectFrames(object: PanelObject): readonly Uint8Array[] {
  const { packed, bytesPerRow, height, frames } = object;
  const frameBytes = panelFrameBytes(object);
  const streams = PANEL_PLANES * height;
  const what = `panel object ${object.id}`;

  const out: Uint8Array[] = [];
  out.push(packed.slice(OBJ_HEADER_BYTES, OBJ_HEADER_BYTES + frameBytes));
  let at = OBJ_HEADER_BYTES + frameBytes;

  for (let frame = 1; frame < frames; frame += 1) {
    const previous = out[frame - 1] as Uint8Array;
    const next = previous.slice(); // SKIP runs keep the previous frame's bytes
    for (let stream = 0; stream < streams; stream += 1) {
      const rowStart = stream * bytesPerRow;
      let produced = 0;
      while (produced < bytesPerRow) {
        if (at >= packed.length) {
          throw new Error(`${what}: frame ${frame} stream ${stream} runs out of packed bytes`);
        }
        const op = packed[at] as number;
        at += 1;
        if (op === 0x00) {
          if (at + 2 > packed.length) throw new Error(`${what}: frame ${frame} fill run truncated`);
          const count = (packed[at] as number) === 0 ? 256 : (packed[at] as number);
          const value = packed[at + 1] as number;
          at += 2;
          next.fill(value, rowStart + produced, rowStart + produced + count);
          produced += count;
        } else if (op & 0x80) {
          const count = op & 0x7f;
          if (count === 0) {
            throw new Error(`${what}: frame ${frame} literal run of zero bytes`);
          }
          if (at + count > packed.length) {
            throw new Error(`${what}: frame ${frame} literal run truncated`);
          }
          next.set(packed.subarray(at, at + count), rowStart + produced);
          at += count;
          produced += count;
        } else {
          produced += op; // keep `op` bytes of the previous frame
        }
      }
      if (produced !== bytesPerRow) {
        throw new Error(
          `${what}: frame ${frame} stream ${stream} produced ${produced} bytes, not the row's ` +
            `${bytesPerRow} — the object does not decode`,
        );
      }
    }
    out.push(next);
  }

  if (at !== packed.length) {
    throw new Error(
      `${what}: decoding consumed ${at} of ${packed.length} packed bytes; the object's frames ` +
        `must consume its byte range exactly`,
    );
  }
  return out;
}

/**
 * Expands one decoded plane-sequential frame into per-pixel plane bits: one
 * byte per pixel, row-major, bit 0 the plane-0 fill bit and bit 1 the plane-1
 * outline bit — the `ShellFont.pixels` convention the panel renderer's
 * `PanelFrame` consumes. Bits are taken MSB-first within each byte, which is
 * the Amiga bitplane order the raw frames are stored in.
 *
 * Pure and canvas-free like the decoder above; the browser integrator calls
 * it once per frame and caches the result.
 */
export function panelFramePixels(
  object: Pick<PanelObject, "bytesPerRow" | "height" | "pixelWidth">,
  frame: Uint8Array,
): Uint8Array {
  const { bytesPerRow, height, pixelWidth } = object;
  const planeBytes = height * bytesPerRow;
  if (frame.length !== PANEL_PLANES * planeBytes) {
    throw new Error(
      `panel frame holds ${frame.length} bytes, expected ${PANEL_PLANES * planeBytes} ` +
        `for ${PANEL_PLANES} planes of ${height} rows at ${bytesPerRow} bytes`,
    );
  }
  const out = new Uint8Array(pixelWidth * height);
  for (let plane = 0; plane < PANEL_PLANES; plane += 1) {
    const planeBit = 1 << plane;
    const planeBase = plane * planeBytes;
    for (let row = 0; row < height; row += 1) {
      const rowBase = planeBase + row * bytesPerRow;
      const outBase = row * pixelWidth;
      for (let byte = 0; byte < bytesPerRow; byte += 1) {
        const value = frame[rowBase + byte] ?? 0;
        if (value === 0) continue;
        const pixelBase = outBase + byte * 8;
        for (let bit = 0; bit < 8; bit += 1) {
          if ((value & (0x80 >> bit)) !== 0) {
            out[pixelBase + bit] = (out[pixelBase + bit] ?? 0) | planeBit;
          }
        }
      }
    }
  }
  return out;
}

/** Parses an id list, requiring every entry to name a real object. */
function parseObjectIds(value: unknown, label: string, objectCount: number): readonly number[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return Object.freeze(
    value.map((entry, at) => requireWholeNumber(entry, `${label}[${at}]`, 0, objectCount - 1)),
  );
}

/** Parses a wiring list keyed by `field`, requiring strictly ascending keys. */
function parseWiring<T>(
  value: unknown,
  label: string,
  parse: (item: Record<string, unknown>, where: string) => T,
  keyOf: (entry: T) => number,
): readonly T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const out: T[] = [];
  let previous = -1;
  for (const [at, entry] of value.entries()) {
    const parsed = parse(entry as Record<string, unknown>, `${label}[${at}]`);
    const k = keyOf(parsed);
    if (k <= previous) {
      throw new Error(`${label} is not in strictly ascending order at entry ${at}`);
    }
    previous = k;
    out.push(parsed);
  }
  return Object.freeze(out);
}

/** Expands one document into a `TablePanel`, checking every cross-reference. */
export function parseTablePanelDocument(doc: TablePanelDocument): TablePanel {
  const raw = doc as unknown as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(`table panel document must be an object, got ${describeValue(doc)}`);
  }
  if (raw["schema"] !== TABLE_PANEL_SCHEMA) {
    throw new Error(
      `table panel document has schema ${describeValue(raw["schema"])}, expected "${TABLE_PANEL_SCHEMA}"`,
    );
  }
  const tableIdValue = raw["tableId"];
  if (typeof tableIdValue !== "string" || !isTableId(tableIdValue)) {
    throw new Error(`table panel document has unknown tableId ${describeValue(tableIdValue)}`);
  }
  const tableId: TableId = tableIdValue;
  const label = `table panel "${tableId}"`;

  const displayName = raw["displayName"];
  if (typeof displayName !== "string" || displayName.length === 0) {
    throw new Error(`${label} has a non-string or empty displayName`);
  }

  const panel = raw["panel"] as Record<string, unknown> | undefined;
  if (
    panel?.["width"] !== PANEL_WIDTH ||
    panel?.["height"] !== PANEL_HEIGHT ||
    panel?.["planes"] !== PANEL_PLANES
  ) {
    throw new Error(
      `${label} declares a panel other than the ${PANEL_WIDTH}x${PANEL_HEIGHT}x${PANEL_PLANES} ` +
        `this decoder implements`,
    );
  }

  const objectsValue = raw["objects"];
  if (!Array.isArray(objectsValue) || objectsValue.length === 0) {
    throw new Error(`${label} objects must be a non-empty array`);
  }
  const objects = objectsValue.map((entry, at) => parseObject(entry, at, label));

  const blobsValue = raw["blobs"];
  if (!Array.isArray(blobsValue)) throw new Error(`${label} blobs must be an array`);
  const blobIds = new Set<string>();
  const blobs = blobsValue.map((entry, at) => {
    const item = entry as Record<string, unknown>;
    const where = `${label} blob ${at}`;
    const id = item["id"];
    if (typeof id !== "string" || id.length === 0 || blobIds.has(id)) {
      throw new Error(`${where} has a missing or duplicate id`);
    }
    blobIds.add(id);
    const bytes = bytesFromBase64(item["bytes"], `${where} bytes`);
    if (bytes.length === 0) throw new Error(`${where} carries no bytes`);
    return Object.freeze({
      id,
      offset: requireWholeNumber(item["offset"], `${where} offset`, 0, 0x7fffffff),
      width: requireWholeNumber(item["width"], `${where} width`, 1, PANEL_WIDTH),
      height: requireWholeNumber(item["height"], `${where} height`, 1, PANEL_HEIGHT),
      bytes,
    });
  });

  const refs = raw["references"] as Record<string, unknown> | null | undefined;
  if (refs === null || refs === undefined || typeof refs !== "object") {
    throw new Error(`${label} references must be an object`);
  }
  const count = objects.length;
  const references: PanelReferences = Object.freeze({
    elements: parseWiring(
      refs["elements"],
      `${label} references.elements`,
      (item, where) =>
        Object.freeze({
          element: requireWholeNumber(item["element"], `${where} element`, 0, 4095),
          start: parseObjectIds(item["start"], `${where} start`, count),
          award: parseObjectIds(item["award"], `${where} award`, count),
        }),
      (entry) => entry.element,
    ),
    messages: parseWiring(
      refs["messages"],
      `${label} references.messages`,
      (item, where) =>
        Object.freeze({
          message: requireWholeNumber(item["message"], `${where} message`, 0, 4095),
          objects: parseObjectIds(item["objects"], `${where} objects`, count),
        }),
      (entry) => entry.message,
    ),
    devices: parseWiring(
      refs["devices"],
      `${label} references.devices`,
      (item, where) =>
        Object.freeze({
          level: requireWholeNumber(item["level"], `${where} level`, 0, 1),
          surfaceId: requireWholeNumber(item["surfaceId"], `${where} surfaceId`, 32, 191),
          objects: parseObjectIds(item["objects"], `${where} objects`, count),
        }),
      (entry) => entry.level * 256 + entry.surfaceId,
    ),
    trailer: parseObjectIds(refs["trailer"], `${label} references.trailer`, count),
    other: parseWiring(
      refs["other"],
      `${label} references.other`,
      (item, where) =>
        Object.freeze({
          site: requireWholeNumber(item["site"], `${where} site`, 0, 0x7fffffff),
          object: requireWholeNumber(item["object"], `${where} object`, 0, count - 1),
        }),
      (entry) => entry.site,
    ),
  });

  return Object.freeze({
    tableId,
    displayName,
    objects: Object.freeze(objects),
    blobs: Object.freeze(blobs),
    references,
  });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<TableId, TablePanel>();

/** Makes one table's panel heap available to the presentation layer. Idempotent. */
export function registerTablePanel(panel: TablePanel): void {
  REGISTRY.set(panel.tableId, panel);
}

/** Forgets every registration. For tests that need a clean slate. */
export function clearTablePanel(): void {
  REGISTRY.clear();
}

/**
 * One table's panel heap, or null.
 *
 * Nullable for the same reason the lamp layer is: a table without panel
 * animations rolls exactly the same ball and merely shows the score as text,
 * and every physics test on a synthetic map must go on working. The renderer
 * treats null as "draw nothing extra", never as an excuse to invent a frame.
 */
export function tablePanelFor(tableId: TableId): TablePanel | null {
  return REGISTRY.get(tableId) ?? null;
}

/** URL of one table's exported panel heap, relative to the site root. */
export function tablePanelUrl(tableId: TableId, basePath: string = TABLE_PANEL_BASE_PATH): string {
  return `${basePath}${tableId}.panel.json`;
}

/** The slice of `Response` this loader needs, so tests can pass a plain object. */
export interface TablePanelResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export type TablePanelFetch = (url: string) => Promise<TablePanelResponse>;

const defaultFetch: TablePanelFetch = (url) => fetch(url);

/** Fetches, parses and REGISTERS one table's panel heap. */
export async function loadTablePanel(
  tableId: TableId,
  fetchImpl: TablePanelFetch = defaultFetch,
  basePath: string = TABLE_PANEL_BASE_PATH,
): Promise<TablePanel> {
  const url = tablePanelUrl(tableId, basePath);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const doc = (await response.json()) as TablePanelDocument;
  const panel = parseTablePanelDocument(doc);
  registerTablePanel(panel);
  return panel;
}
