/**
 * Loader for the shipped scoring layer (`public/generated/tables/*.devices.json`).
 *
 * Three things arrive together in that document because they only make sense
 * together:
 *
 *   1. THE SURFACE-ID MAP, one byte per pixel per playfield level. This is what
 *      the original had that this reconstruction did not: a name for every
 *      pixel of the collision line. Without it "the ball hit a wall" can never
 *      become "the ball hit bumper 2", and no amount of coordinate-guessing
 *      substitutes for it.
 *   2. THE DEVICE, BUMPER AND SLINGSHOT RECORDS the ids index, each with its
 *      packed-BCD award.
 *   3. THE ZONE LIST — rectangles tested against the ball centre, which is where
 *      most of a table's scoring actually lives: outlanes, inlanes, ramp runs,
 *      loops and the locks.
 *
 * `scripts/export-table-devices.mjs` has the disassembly of every consumer and
 * the checks the decode passes; the strongest is that the surface map's non-
 * flipper pixels are EXACTLY the shipped collision map's solid pixels, on both
 * levels of all three tables, decoded from two different package slots by two
 * unrelated routines.
 *
 * The parser is pure and takes an already-parsed document; `loadTableDevices` is
 * the only part that touches the network. As with the ramp drive, everything is
 * re-checked at runtime rather than trusted: a scoring layer that is silently
 * one pixel out awards the wrong device, and that is invisible from the outside.
 */

import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH, TABLE_IDS } from "./contracts.js";
import type {
  PlayfieldLevel,
  TableDevicesDocument,
  TableId,
} from "./contracts.js";
import { DEVICE_ID_BASE } from "./surface-physics.js";

/** The only document schema this loader understands. */
export const TABLE_DEVICES_SCHEMA = "pinball-illusions/table-devices/v1";

/** Where the exported documents live under the site root (Vite serves `public/`). */
export const TABLE_DEVICES_BASE_PATH = "generated/tables/";

/** Longs in one of the engine's per-level device arrays. */
export const DEVICE_SLOTS = 160;

/** What a device record does when its surface is touched. */
export type DeviceKind = "target" | "mode" | "kicker";

/** What a zone record does when the ball centre enters its rectangle. */
export type ZoneKind = "trigger-a" | "trigger-b" | "to-upper" | "to-lower" | "lock";

export const DEVICE_KINDS: readonly DeviceKind[] = Object.freeze(["target", "mode", "kicker"]);
export const ZONE_KINDS: readonly ZoneKind[] = Object.freeze([
  "trigger-a",
  "trigger-b",
  "to-upper",
  "to-lower",
  "lock",
]);

/**
 * One entry of a per-level device array.
 *
 * `level` is the array the record lives in, NOT necessarily where its pixels
 * are: BabeWatch's id 41 sits in the lower array with its pixels on the upper
 * collision line, and the engine consequently never fires it. That is
 * reproduced rather than repaired — see the exporter's CROSS_LEVEL_DEVICE_IDS.
 */
export interface DeviceRecord {
  readonly level: PlayfieldLevel;
  /** Array slot; `surfaceId - 32`. */
  readonly index: number;
  readonly surfaceId: number;
  readonly kind: DeviceKind;
  /** Packed-BCD award, as a decimal number. Zero is a real value here. */
  readonly score: number;
  readonly bonus: number;
  /** Award for a hit after the first. Zero unless the record has a flag byte. */
  readonly repeatScore: number;
  /** True when the record carries the per-player flag byte the repeat path needs. */
  readonly repeatable: boolean;
  /**
   * Kicker only: the velocity written straight over the ball's, in the
   * ORIGINAL'S velocity units as they sit on the disk.
   *
   * Left raw, and nothing reads it yet: the device layer that would apply it is
   * not built. Whoever builds it must put it through `originalVelocityToQ10` in
   * `timebase.ts` — the original's `movem.w $6(a0),d0-d1 / movem.w d0-d1,$e(a4)`
   * at +0x00B6C0 writes the record's words straight into the ball's velocity
   * words, so the conversion is the plain 4x one with no caveat. The only
   * non-zero pair across the three shipped tables is BabeWatch's surface 64,
   * (0, -3000), which is 12,000 Q10 a tick upward and a 549 px ejection.
   */
  readonly velocityX: number;
  readonly velocityY: number;
}

/** A bumper or slingshot record: an index into its list, and a score. */
export interface HitRecord {
  /** 1-based, as the collision responder indexes it. */
  readonly index: number;
  readonly score: number;
}

/** One rectangle of a per-level zone list. */
export interface ZoneRecord {
  readonly level: PlayfieldLevel;
  readonly index: number;
  readonly kind: ZoneKind;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly score: number;
  readonly bonus: number;
  readonly repeatScore: number;
  readonly repeatable: boolean;
}

/** One table's scoring layer, expanded and indexed. */
export interface TableDevices {
  readonly tableId: TableId;
  readonly displayName: string;
  readonly devices: readonly DeviceRecord[];
  readonly bumpers: readonly HitRecord[];
  readonly slingshots: readonly HitRecord[];
  readonly zones: readonly ZoneRecord[];
  /** Surface id at a pixel on one level; 0 outside the map. */
  surfaceIdAt(level: PlayfieldLevel, x: number, y: number): number;
  /**
   * The device a surface id fires on one level, or null.
   *
   * Looked up the way the engine does it — index the level's own array — so a
   * record filed under the other level answers null, exactly as the original's
   * dispatch reads a NULL slot and returns.
   */
  deviceFor(level: PlayfieldLevel, surfaceId: number): DeviceRecord | null;
  bumperFor(index: number): HitRecord | null;
  slingshotFor(index: number): HitRecord | null;
  /**
   * The level a `to-upper` or `to-lower` zone at this point hands the ball to,
   * or null when no such zone covers it.
   *
   * THIS IS THE ENGINE'S OWN LEVEL-CHANGE MECHANISM and it is why the zone list
   * had to be decoded before the ramps could be trusted. Types 2 and 3 of the
   * five-entry dispatch table at +0x0053A8 do nothing but swap the ball's plane
   * pointers — `$22EE/$22FE/$2302` for the lower level, `$2306/$2316/$231A` for
   * the upper — so a hand-off is a RECTANGLE, twenty pixels on a side, and not a
   * row of three columns that a ball can miss by one pixel.
   *
   * `playfield-levels.ts` reconstructs the same thing from map geometry and
   * still runs, because it covers hand-offs the zone list does not: the plunger
   * lane's mouth is a gate on every table and no zone names it. The two are
   * complementary and the measured one is applied second, so where they disagree
   * the shipped data wins.
   */
  levelChangeAt(level: PlayfieldLevel, x: number, y: number): PlayfieldLevel | null;
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

function requireLevel(value: unknown, label: string): PlayfieldLevel {
  const level = requireWholeNumber(value, label, 0, 1);
  return level === 1 ? 1 : 0;
}

/** Expands one level's run-length encoded surface ids into a byte per pixel. */
function expandSurfaceRows(rows: unknown, label: string): Uint8Array {
  if (!Array.isArray(rows) || rows.length !== PLAYFIELD_HEIGHT) {
    throw new Error(
      `${label} has ${Array.isArray(rows) ? rows.length : "non-array"} rows, expected ${PLAYFIELD_HEIGHT}`,
    );
  }
  const pixels = new Uint8Array(PLAYFIELD_WIDTH * PLAYFIELD_HEIGHT);
  for (let y = 0; y < PLAYFIELD_HEIGHT; y += 1) {
    const runs: unknown = rows[y];
    if (!Array.isArray(runs) || runs.length === 0 || runs.length % 2 !== 0) {
      throw new Error(`${label} row ${y} is not a non-empty list of [end_x, id] pairs`);
    }
    const base = y * PLAYFIELD_WIDTH;
    let previousEnd = -1;
    for (let pair = 0; pair < runs.length; pair += 2) {
      const end = runs[pair];
      const id = runs[pair + 1];
      if (typeof end !== "number" || !Number.isInteger(end) || end <= previousEnd || end >= PLAYFIELD_WIDTH) {
        throw new Error(
          `${label} row ${y} run ${pair / 2} ends at ${describeValue(end)}; ends must strictly ` +
            `increase and stay inside 0..${PLAYFIELD_WIDTH - 1}`,
        );
      }
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id > 255) {
        throw new Error(`${label} row ${y} run ${pair / 2} has surface id ${describeValue(id)}`);
      }
      pixels.fill(id, base + previousEnd + 1, base + end + 1);
      previousEnd = end;
    }
    if (previousEnd !== PLAYFIELD_WIDTH - 1) {
      throw new Error(`${label} row ${y} stops at x=${previousEnd}, not ${PLAYFIELD_WIDTH - 1}`);
    }
  }
  return pixels;
}

/**
 * Expands one document into a `TableDevices`.
 *
 * Throws on the first inconsistency. A malformed scoring document is never
 * repaired by guessing: an award that lands on the wrong device is worse than a
 * game that refuses to start.
 */
export function parseTableDevicesDocument(doc: TableDevicesDocument): TableDevices {
  const raw = doc as unknown as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(`table devices document must be an object, got ${describeValue(doc)}`);
  }
  if (raw["schema"] !== TABLE_DEVICES_SCHEMA) {
    throw new Error(
      `table devices document has schema ${describeValue(raw["schema"])}, expected "${TABLE_DEVICES_SCHEMA}"`,
    );
  }
  const tableIdValue = raw["tableId"];
  if (typeof tableIdValue !== "string" || !isTableId(tableIdValue)) {
    throw new Error(`table devices document has unknown tableId ${describeValue(tableIdValue)}`);
  }
  const tableId: TableId = tableIdValue;
  const label = `table devices "${tableId}"`;

  const displayName = raw["displayName"];
  if (typeof displayName !== "string" || displayName.length === 0) {
    throw new Error(`${label} has a non-string or empty displayName`);
  }
  if (raw["width"] !== PLAYFIELD_WIDTH || raw["height"] !== PLAYFIELD_HEIGHT) {
    throw new Error(
      `${label} is ${describeValue(raw["width"])}x${describeValue(raw["height"])}, expected ` +
        `${PLAYFIELD_WIDTH}x${PLAYFIELD_HEIGHT}`,
    );
  }

  const surfaceRows = raw["surfaceIds"];
  if (!Array.isArray(surfaceRows) || surfaceRows.length !== 2) {
    throw new Error(`${label} must carry exactly two surface-id levels`);
  }
  const surfaces = surfaceRows.map((rows, level) =>
    expandSurfaceRows(rows, `${label} level ${level} surface ids`),
  );

  const devices: DeviceRecord[] = [];
  const rawDevices = raw["devices"];
  if (!Array.isArray(rawDevices)) throw new Error(`${label} has non-array devices`);
  for (const [at, entry] of rawDevices.entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} device ${at}`;
    const kind = item["kind"];
    if (typeof kind !== "string" || !(DEVICE_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`${where} has kind ${describeValue(kind)}`);
    }
    const index = requireWholeNumber(item["index"], `${where} index`, 0, DEVICE_SLOTS - 1);
    const surfaceId = requireWholeNumber(item["surfaceId"], `${where} surfaceId`, DEVICE_ID_BASE, 255);
    if (surfaceId !== index + DEVICE_ID_BASE) {
      throw new Error(
        `${where} has surface id ${surfaceId} at slot ${index}; the engine's index IS ` +
          `id - ${DEVICE_ID_BASE} and nothing else`,
      );
    }
    devices.push(
      Object.freeze({
        level: requireLevel(item["level"], `${where} level`),
        index,
        surfaceId,
        kind: kind as DeviceKind,
        score: requireWholeNumber(item["score"], `${where} score`, 0, Number.MAX_SAFE_INTEGER),
        bonus: requireWholeNumber(item["bonus"], `${where} bonus`, 0, Number.MAX_SAFE_INTEGER),
        repeatScore: requireWholeNumber(
          item["repeatScore"],
          `${where} repeatScore`,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        repeatable: item["repeatable"] === true,
        velocityX: typeof item["velocityX"] === "number" ? item["velocityX"] : 0,
        velocityY: typeof item["velocityY"] === "number" ? item["velocityY"] : 0,
      }),
    );
  }

  const readHitList = (key: string): readonly HitRecord[] => {
    const list = raw[key];
    if (!Array.isArray(list)) throw new Error(`${label} has non-array ${key}`);
    return Object.freeze(
      list.map((entry, at) => {
        const item = entry as Record<string, unknown>;
        return Object.freeze({
          index: requireWholeNumber(item["index"], `${label} ${key} ${at} index`, 1, 8),
          score: requireWholeNumber(
            item["score"],
            `${label} ${key} ${at} score`,
            0,
            Number.MAX_SAFE_INTEGER,
          ),
        });
      }),
    );
  };
  const bumpers = readHitList("bumpers");
  const slingshots = readHitList("slingshots");

  const zones: ZoneRecord[] = [];
  const rawZones = raw["zones"];
  if (!Array.isArray(rawZones)) throw new Error(`${label} has non-array zones`);
  for (const [at, entry] of rawZones.entries()) {
    const item = entry as Record<string, unknown>;
    const where = `${label} zone ${at}`;
    const kind = item["kind"];
    if (typeof kind !== "string" || !(ZONE_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`${where} has kind ${describeValue(kind)}`);
    }
    const minX = requireWholeNumber(item["minX"], `${where} minX`, 0, 0xffff);
    const minY = requireWholeNumber(item["minY"], `${where} minY`, 0, 0xffff);
    const maxX = requireWholeNumber(item["maxX"], `${where} maxX`, minX, 0xffff);
    const maxY = requireWholeNumber(item["maxY"], `${where} maxY`, minY, 0xffff);
    zones.push(
      Object.freeze({
        level: requireLevel(item["level"], `${where} level`),
        index: requireWholeNumber(item["index"], `${where} index`, 0, 1000),
        kind: kind as ZoneKind,
        minX,
        minY,
        maxX,
        maxY,
        score: requireWholeNumber(item["score"], `${where} score`, 0, Number.MAX_SAFE_INTEGER),
        bonus: requireWholeNumber(item["bonus"], `${where} bonus`, 0, Number.MAX_SAFE_INTEGER),
        repeatScore: requireWholeNumber(
          item["repeatScore"],
          `${where} repeatScore`,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        repeatable: item["repeatable"] === true,
      }),
    );
  }

  // Indexed the way the engine indexes: one sparse array per level, slot =
  // id - 32. Two levels because a record filed under the wrong one must answer
  // null rather than fire.
  const byLevel: (DeviceRecord | null)[][] = [
    new Array<DeviceRecord | null>(DEVICE_SLOTS).fill(null),
    new Array<DeviceRecord | null>(DEVICE_SLOTS).fill(null),
  ];
  for (const device of devices) {
    const slots = byLevel[device.level];
    if (slots === undefined) continue;
    if (slots[device.index] !== null) {
      throw new Error(`${label} has two devices in level ${device.level} slot ${device.index}`);
    }
    slots[device.index] = device;
  }

  const bumperByIndex = new Map(bumpers.map((record) => [record.index, record]));
  const slingshotByIndex = new Map(slingshots.map((record) => [record.index, record]));

  const frozenDevices = Object.freeze(devices);
  const frozenZones = Object.freeze(zones);
  // Pulled out once rather than filtered per lookup: this runs for every ball
  // on every tick.
  const levelChanges = frozenZones.filter(
    (zone) => zone.kind === "to-upper" || zone.kind === "to-lower",
  );

  return Object.freeze({
    tableId,
    displayName,
    devices: frozenDevices,
    bumpers,
    slingshots,
    zones: frozenZones,
    surfaceIdAt(level: PlayfieldLevel, x: number, y: number): number {
      const px = Math.floor(x);
      const py = Math.floor(y);
      if (px < 0 || px >= PLAYFIELD_WIDTH || py < 0 || py >= PLAYFIELD_HEIGHT) return 0;
      const pixels = surfaces[level === 1 ? 1 : 0];
      return pixels === undefined ? 0 : (pixels[py * PLAYFIELD_WIDTH + px] ?? 0);
    },
    deviceFor(level: PlayfieldLevel, surfaceId: number): DeviceRecord | null {
      const slots = byLevel[level === 1 ? 1 : 0];
      if (slots === undefined) return null;
      return slots[surfaceId - DEVICE_ID_BASE] ?? null;
    },
    bumperFor(index: number): HitRecord | null {
      return bumperByIndex.get(index) ?? null;
    },
    slingshotFor(index: number): HitRecord | null {
      return slingshotByIndex.get(index) ?? null;
    },
    levelChangeAt(level: PlayfieldLevel, x: number, y: number): PlayfieldLevel | null {
      const here = level === 1 ? 1 : 0;
      for (const zone of levelChanges) {
        if (zone.level !== here) continue;
        if (x < zone.minX || x > zone.maxX || y < zone.minY || y > zone.maxY) continue;
        return zone.kind === "to-upper" ? 1 : 0;
      }
      return null;
    },
  });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<TableId, TableDevices>();

/** Makes one table's scoring layer available to `createGame`. Idempotent. */
export function registerTableDevices(devices: TableDevices): void {
  REGISTRY.set(devices.tableId, devices);
}

/** Forgets every registration. For tests that need a clean slate. */
export function clearTableDevices(): void {
  REGISTRY.clear();
}

/**
 * One table's scoring layer, or null.
 *
 * Nullable where the ramp drive is not, and the difference is deliberate. A
 * missing ramp drive silently changes the PHYSICS — balls stall on surfaces that
 * should carry them — so `tableAccelerationFor` throws. A missing scoring layer
 * changes only what the score reads: the ball still rolls the same path, and
 * every physics test in this project builds a game on a synthetic map that has
 * no devices at all and must go on working. So this answers null and the caller
 * plays a table that scores nothing.
 */
export function tableDevicesFor(tableId: TableId): TableDevices | null {
  return REGISTRY.get(tableId) ?? null;
}

/** URL of one table's exported scoring layer, relative to the site root. */
export function tableDevicesUrl(tableId: TableId, basePath: string = TABLE_DEVICES_BASE_PATH): string {
  return `${basePath}${tableId}.devices.json`;
}

/** The slice of `Response` this loader needs, so tests can pass a plain object. */
export interface TableDevicesResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export type TableDevicesFetch = (url: string) => Promise<TableDevicesResponse>;

// Wrapped rather than passing `fetch` itself: an unbound reference to the global
// throws "Illegal invocation" in browsers.
const defaultFetch: TableDevicesFetch = (url) => fetch(url);

/** Fetches, parses and REGISTERS one table's scoring layer. */
export async function loadTableDevices(
  tableId: TableId,
  fetchImpl: TableDevicesFetch = defaultFetch,
  basePath: string = TABLE_DEVICES_BASE_PATH,
): Promise<TableDevices> {
  const url = tableDevicesUrl(tableId, basePath);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const doc = (await response.json()) as TableDevicesDocument;
  const devices = parseTableDevicesDocument(doc);
  registerTableDevices(devices);
  return devices;
}
