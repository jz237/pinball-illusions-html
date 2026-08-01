/**
 * Loading the shipped table documents from disk, for tests that drive the real
 * machine.
 *
 * There are FOUR documents per table and the game needs three of them. The map,
 * the ramp drive and the scoring layer each go through their own exporter and
 * each is gated as disk-derived; the artwork is loaded separately by the
 * renderer tests, which is why it is not here.
 *
 * The registries are why this module exists rather than each test file reading
 * its own JSON. `createGame` obtains the drive from the registry and THROWS when
 * it is absent, deliberately — a table without its ramp drive traps balls on
 * every surface shallower than the 8.55 degree friction angle and looks
 * completely normal doing it (see src/game/table-accel.ts). The scoring layer
 * does not throw, but leaving it out is just as much a half-armed machine: it
 * carries the SURFACE-ID MAP, which is what the contact model reads restitution
 * out of and what makes a bumper a bumper rather than a wall. One helper that
 * always loads all three means a test cannot half-arm anything.
 */

import { readFileSync } from "node:fs";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { parseTableAccelDocument, registerTableAcceleration } from "../src/game/table-accel.js";
import type { TableAcceleration } from "../src/game/table-accel.js";
import { parseTableDevicesDocument, registerTableDevices } from "../src/game/table-devices.js";
import type { TableDevices } from "../src/game/table-devices.js";
import type {
  TableAccelDocument,
  TableDevicesDocument,
  TableId,
  TableMap,
  TableMapDocument,
} from "../src/game/contracts.js";

function documentUrl(tableId: TableId, kind: "map" | "accel" | "devices"): URL {
  return new URL(`../public/generated/tables/${tableId}.${kind}.json`, import.meta.url);
}

/** The shipped ramp drive for one table, parsed and registered. */
export function accelFor(tableId: TableId): TableAcceleration {
  const doc = JSON.parse(readFileSync(documentUrl(tableId, "accel"), "utf8")) as TableAccelDocument;
  const acceleration = parseTableAccelDocument(doc);
  registerTableAcceleration(acceleration);
  return acceleration;
}

/** The shipped scoring layer for one table, parsed and registered. */
export function devicesFor(tableId: TableId): TableDevices {
  const doc = JSON.parse(
    readFileSync(documentUrl(tableId, "devices"), "utf8"),
  ) as TableDevicesDocument;
  return parseTableDevicesDocument(doc);
}

/**
 * The shipped map for one table, with its ramp drive and its scoring layer
 * registered as a side effect, so `createGame(mapFor(id))` always gets a fully
 * armed machine.
 */
export function mapFor(tableId: TableId): TableMap {
  accelFor(tableId);
  registerTableDevices(devicesFor(tableId));
  const doc = JSON.parse(readFileSync(documentUrl(tableId, "map"), "utf8")) as TableMapDocument;
  return parseTableMapDocument(doc);
}
