/**
 * Loading the shipped table documents from disk, for tests that drive the real
 * machine.
 *
 * There are THREE documents per table and the game needs all three. The map and
 * the ramp drive both go through their own exporters and both are gated as
 * disk-derived; the artwork is loaded separately by the renderer tests, which is
 * why it is not here.
 *
 * `registerTableAcceleration` is the reason this module exists rather than each
 * test file reading its own JSON. `createGame` obtains the drive from the
 * registry and THROWS when it is absent, deliberately — a table without its ramp
 * drive traps balls on every surface shallower than the 8.55 degree friction
 * angle and looks completely normal doing it (see src/game/table-accel.ts). One
 * helper that always loads both means a test cannot half-arm the machine.
 */

import { readFileSync } from "node:fs";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { parseTableAccelDocument, registerTableAcceleration } from "../src/game/table-accel.js";
import type { TableAcceleration } from "../src/game/table-accel.js";
import type { TableAccelDocument, TableId, TableMap, TableMapDocument } from "../src/game/contracts.js";

function documentUrl(tableId: TableId, kind: "map" | "accel"): URL {
  return new URL(`../public/generated/tables/${tableId}.${kind}.json`, import.meta.url);
}

/** The shipped ramp drive for one table, parsed and registered. */
export function accelFor(tableId: TableId): TableAcceleration {
  const doc = JSON.parse(readFileSync(documentUrl(tableId, "accel"), "utf8")) as TableAccelDocument;
  const acceleration = parseTableAccelDocument(doc);
  registerTableAcceleration(acceleration);
  return acceleration;
}

/**
 * The shipped map for one table, with its ramp drive registered as a side
 * effect so `createGame(mapFor(id))` always gets a fully armed machine.
 */
export function mapFor(tableId: TableId): TableMap {
  accelFor(tableId);
  const doc = JSON.parse(readFileSync(documentUrl(tableId, "map"), "utf8")) as TableMapDocument;
  return parseTableMapDocument(doc);
}
