/**
 * The RAMP DRIVE: the per-8x8-block acceleration the original added to the
 * ball's velocity, decoded from slot 4 of each table package.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS, AND WHY NO COEFFICIENT COULD HAVE STOOD IN FOR IT
 * ---------------------------------------------------------------------------
 * The contact model's static-friction angle is `atan(WALL_FRICTION / Q10_ONE)` =
 * atan(154/1024) = 8.55 degrees, and that is not a bug — it is what a Coulomb
 * friction rule with a 0.15 coefficient means. Its consequence is that any
 * surface whose normal is less than 8.55 degrees off vertical is an EQUILIBRIUM:
 * the along-surface component of gravity is smaller than the friction budget, so
 * a ball that arrives there stops dead and stays for the rest of the game.
 *
 * The shipped tables are full of such surfaces, because a real ramp is nearly
 * flat and is not supposed to rely on gravity. Measured on the shipped maps with
 * the engine's own probe ring, the contact normals at the sites where balls
 * actually died:
 *
 *     law-n-justice  (191,17) level 1   4.9 deg off vertical
 *     law-n-justice  (149,18) level 1  -3.5 deg
 *     law-n-justice  (86,156) level 0  -7.9 deg
 *     babewatch      (91,171) level 0  -7.9 deg
 *
 * all inside the friction angle, and every one of them with an OPEN basin — a
 * flood of free ball centres from each of those points runs away across the
 * playfield and reaches the bottom row. They are not sealed pockets that need a
 * kicker. They are shallow surfaces that need a push, and the ball stops on them
 * for a completely correct reason.
 *
 * Raising or lowering the friction coefficient cannot fix that. It was tried:
 * computing the bounce at Q10-scaled precision cured one site arithmetically and
 * moved the balls onto a different pre-existing equilibrium at the Law 'n
 * Justice arch crown, taking write-offs from 0% to 14.4%. The equilibria are a
 * property of the geometry, and the geometry is correct.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE ORIGINAL DID INSTEAD
 * ---------------------------------------------------------------------------
 * It carried a second acceleration beside gravity, looked up from the ball's
 * position. `scripts/export-table-accel.mjs` has the disassembly of the consumer
 * at main.seg00 +0x00B70A and the four structural checks the decode passes; the
 * short version is:
 *
 *   - two 42 x 75 byte maps, one per playfield level, one byte per 8x8 pixel
 *     block of the 336x600 playfield, row-major;
 *   - each byte indexes a short per-table list of signed (dx, dy) word pairs,
 *     entry 0 being (0,0) and meaning "no drive";
 *   - the pair is added to the ball's velocity on every integration substep,
 *     on top of the global gravity and x-tilt.
 *
 * dy is never negative in any entry of any of the three tables and dx is signed
 * both ways, so this models a steeper local fall line plus a sideways component
 * along the rail. It is not a launcher.
 *
 * ---------------------------------------------------------------------------
 * THE UNIT BRIDGE IS FORCED, NOT CHOSEN — AND IT WAS WRONG BY 16/3
 * ---------------------------------------------------------------------------
 * The bridge now lives in `timebase.ts`, which has the disassembly. The short
 * version, and the correction:
 *
 * The original adds its gravity ONCE PER SUBSTEP and runs EIGHT substeps per
 * 50 Hz frame (the unrolled tick at main.seg00 +0x00A660 calls the integrator
 * eight times: four collision passes x two integration sub-steps). Its shipped
 * gravity is 4 — record 1 of the seven 10-byte option records in
 * `PROGDIR:tableNNN.opt` is (min 2, max 8, cur, DEFAULT 4), read at +0x0009FE
 * into $E86(a5) and added at +0x00B758.
 *
 * THIS FILE USED TO CLOSE THE BRIDGE THE WRONG WAY. It said "32 original units
 * per frame == 24 Q10 per tick", i.e. it took the port's own inherited gravity
 * as the reference and solved for the drive. The derivation it wrote,
 *
 *     (PLUNGER_REFERENCE_GRAVITY * 8) / (4 * 8)
 *
 * cancels the eights: it is 24/4 and never used the substep count at all. What
 * it silently asserted is that one original velocity unit is one Q10 per tick.
 * It is FOUR — each substep moves the ball by v>>1 and there are eight of them —
 * so one unit of per-substep acceleration is 8 * 4 = 32 Q10 per tick squared,
 * not 6. That factor of four, times the arbitrary 24/32, is precisely the 16/3
 * by which this simulation was too floaty.
 *
 * So a vector (dx, dy) now contributes `(32*dx, 32*dy)` Q10 per tick, and the
 * number is a property of the ORIGINAL's integrator rather than of this port's
 * gravity: `Q10_PER_ORIGINAL_ACCEL_UNIT` is measured, `SIMULATION_GRAVITY` is
 * measured, and neither is derived from the other. They cannot drift because
 * neither is free.
 *
 * A worked consequence, restated on the corrected scale: Law 'n Justice's arch
 * crown is zone 3, vector (-1, 1), so a ball stalled there gains 32 Q10/tick of
 * leftward velocity every tick while the friction budget on a resting contact
 * takes at most `q10Multiply(154, 128)` = 19 Q10/tick back. The drive wins by 13
 * units a tick where it used to win by 3 — the correction WIDENS the ramp-escape
 * margin rather than threatening it, because gravity and the drive rose by the
 * same factor while the friction budget is bounded by one tick of gravity too.
 *
 * ---------------------------------------------------------------------------
 * THE MAGNITUDE IS THE ORIGINAL'S. THE SAMPLING RATE IS NOT, AND IT NOW SHOWS
 * ---------------------------------------------------------------------------
 * The original re-reads the block under the ball on EVERY sub-step — eight times
 * a frame, at eight points along the path (+0x00B734, `asr.w #3` on both
 * coordinates). This port reads it once per tick, at the position the ball
 * starts the tick in, and applies the whole frame's worth of acceleration there.
 * Those agree exactly whenever the ball stays inside one 8 px block for the
 * frame, and diverge when it does not.
 *
 * At the old gravity that never mattered, because a ball almost never crossed a
 * block in one tick. At the measured gravity it does: a ball in free fall is
 * moving 11.7 px a tick by the time it reaches the flippers and a pop bumper
 * throws one 21 px in a tick, so a fast ball can cross two or three blocks
 * between samples and will pick up the drive of the block it left rather than
 * the ones it crossed. That is a known, stated divergence of the RATE, not of
 * the magnitude, and it is recorded here rather than silently absorbed: closing
 * it means moving the drive lookup inside `integrateBall`'s contact sweep, which
 * is a change to the integrator and not to this decode.
 *
 * ---------------------------------------------------------------------------
 * THE DRIVE IS NOT OPTIONAL AND MUST NOT BE FORGETTABLE
 * ---------------------------------------------------------------------------
 * A table without its ramp drive is a different machine — the arch does not
 * carry the ball, the habitrails do not deliver, and shallow surfaces trap. So
 * `tableAccelerationFor` THROWS for a table nothing has registered, rather than
 * answering a null drive: a silent zero here is exactly the class of bug this
 * project keeps being bitten by, where everything passes and the physics is
 * quietly not the physics. `createGame` calls it, so the only way to run a game
 * without the drive is to be told you have not loaded it.
 */

import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH, TABLE_IDS } from "./contracts.js";
import type { PlayfieldLevel, TableAccelDocument, TableId } from "./contracts.js";
import type { Q10 } from "../core/fixed-point.js";
import {
  ORIGINAL_GRAVITY_DEFAULT,
  ORIGINAL_SUBSTEPS_PER_FRAME as SUBSTEPS_PER_FRAME,
  Q10_PER_ORIGINAL_ACCEL_UNIT,
} from "./timebase.js";

/** The only document schema this loader understands. */
export const TABLE_ACCEL_SCHEMA = "pinball-illusions/table-accel/v1";

/** Where the exported documents live under the site root (Vite serves `public/`). */
export const TABLE_ACCEL_BASE_PATH = "generated/tables/";

/** Pixels per block edge: the `asr.w #3` on both coordinates at +0x00B734. */
export const ACCEL_BLOCK_SIZE = 8;
export const ACCEL_COLUMNS = PLAYFIELD_WIDTH / ACCEL_BLOCK_SIZE; // 42
export const ACCEL_ROWS = PLAYFIELD_HEIGHT / ACCEL_BLOCK_SIZE; // 75

/**
 * The original's gravity, per substep, from record 1 of `tableNNN.opt`
 * (min 2, max 8, default 4) — identical on all three tables.
 */
export const ORIGINAL_GRAVITY_PER_SUBSTEP = ORIGINAL_GRAVITY_DEFAULT;

/**
 * Integration substeps the original ran per 50 Hz frame: four collision passes
 * times two integration sub-steps, unrolled at main.seg00 +0x00A660.
 */
export const ORIGINAL_SUBSTEPS_PER_FRAME = SUBSTEPS_PER_FRAME;

/**
 * Q10 per tick squared contributed by one unit of the original's per-substep
 * acceleration: THIRTY-TWO, measured. See `timebase.ts`, and see the header for
 * the 6 this used to be and why it was six times too small in the direction that
 * mattered.
 */
export const TICKS_PER_ORIGINAL_UNIT: Q10 = Q10_PER_ORIGINAL_ACCEL_UNIT;

/** One block's drive, already in the port's Q10-per-tick. */
export interface RampDriveVector {
  readonly x: Q10;
  readonly y: Q10;
}

const NO_DRIVE: RampDriveVector = Object.freeze({ x: 0, y: 0 });

/** One table's ramp drive, ready for the integrator. */
export interface TableAcceleration {
  readonly tableId: TableId;
  readonly displayName: string;
  /**
   * The drive at a ball CENTRE, in Q10 per tick.
   *
   * The centre, because that is what the original indexes with: it stores the
   * ball's top-left and adds 8 — half the 17 px ball — before the shift. This
   * port's `BallState.x/y` already IS the centre, so the block is
   * `(pixelY >> 3) * 42 + (pixelX >> 3)` with no further adjustment. Off the
   * playfield there is no drive; the integrator's walls make that unreachable
   * anyway, but a spawn or a device kick must not index out of the grid.
   */
  driveAt(level: PlayfieldLevel, pixelX: number, pixelY: number): RampDriveVector;
  /** The raw disk vectors, in the original's per-substep units, for tests. */
  readonly vectors: readonly (readonly [number, number])[];
  /** Block index per level, row-major, `ACCEL_COLUMNS * ACCEL_ROWS` long. */
  readonly blocks: readonly Uint8Array[];
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

function expectInteger(label: string, field: string, value: unknown, expected: number): void {
  if (value !== expected) {
    throw new Error(`${label} has ${field} ${describeValue(value)}, expected ${expected}`);
  }
}

/**
 * Expands one document into a `TableAcceleration`.
 *
 * Pure, and throws on the first inconsistency rather than repairing anything: a
 * drive that is silently wrong in one block is a ball that behaves oddly in one
 * corner of one table, which is close to untraceable.
 */
export function parseTableAccelDocument(doc: TableAccelDocument): TableAcceleration {
  const raw = doc as unknown as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(`table accel document must be an object, got ${describeValue(doc)}`);
  }

  const schema = raw["schema"];
  if (schema !== TABLE_ACCEL_SCHEMA) {
    throw new Error(
      `table accel document has schema ${describeValue(schema)}, expected "${TABLE_ACCEL_SCHEMA}"`,
    );
  }

  const tableIdValue = raw["tableId"];
  if (typeof tableIdValue !== "string" || !isTableId(tableIdValue)) {
    throw new Error(
      `table accel document has unknown tableId ${describeValue(tableIdValue)}; ` +
        `expected one of ${TABLE_IDS.join(", ")}`,
    );
  }
  const tableId: TableId = tableIdValue;
  const label = `table accel "${tableId}"`;

  const displayName = raw["displayName"];
  if (typeof displayName !== "string" || displayName.length === 0) {
    throw new Error(`${label} has a non-string or empty displayName: ${describeValue(displayName)}`);
  }

  expectInteger(label, "blockSize", raw["blockSize"], ACCEL_BLOCK_SIZE);
  expectInteger(label, "columns", raw["columns"], ACCEL_COLUMNS);
  expectInteger(label, "rows", raw["rows"], ACCEL_ROWS);

  const rawVectors = raw["vectors"];
  if (!Array.isArray(rawVectors) || rawVectors.length === 0) {
    throw new Error(`${label} has no vectors: ${describeValue(rawVectors)}`);
  }
  const vectors: (readonly [number, number])[] = [];
  const drives: RampDriveVector[] = [];
  for (const [index, entry] of rawVectors.entries()) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`${label} vector ${index} is not a [dx, dy] pair: ${describeValue(entry)}`);
    }
    const [dx, dy] = entry as [unknown, unknown];
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) {
      throw new Error(`${label} vector ${index} is not a pair of whole numbers: (${String(dx)}, ${String(dy)})`);
    }
    const x = dx as number;
    const y = dy as number;
    // The disk's own shape, restated so a re-export that broke framing cannot
    // reach the integrator. See check 3 in the exporter.
    if (index === 0 && (x !== 0 || y !== 0)) {
      throw new Error(`${label} vector 0 is (${x},${y}); index 0 must mean "no drive"`);
    }
    if (y < 0) {
      throw new Error(
        `${label} vector ${index} is (${x},${y}) and its dy is negative; a ramp steepens the ` +
          `local fall line, it does not lift the ball`,
      );
    }
    vectors.push(Object.freeze([x, y] as const));
    drives.push(
      Object.freeze({ x: x * TICKS_PER_ORIGINAL_UNIT, y: y * TICKS_PER_ORIGINAL_UNIT }),
    );
  }

  const rawLevels = raw["levels"];
  if (!Array.isArray(rawLevels) || rawLevels.length !== 2) {
    throw new Error(`${label} must carry exactly two levels, got ${describeValue(rawLevels)}`);
  }

  const blocks: Uint8Array[] = [];
  for (const [level, rawRows] of rawLevels.entries()) {
    if (!Array.isArray(rawRows) || rawRows.length !== ACCEL_ROWS) {
      throw new Error(
        `${label} level ${level} has ${Array.isArray(rawRows) ? rawRows.length : "non-array"} rows, ` +
          `expected ${ACCEL_ROWS}`,
      );
    }
    const grid = new Uint8Array(ACCEL_COLUMNS * ACCEL_ROWS);
    for (const [row, runs] of rawRows.entries()) {
      if (!Array.isArray(runs) || runs.length === 0 || runs.length % 2 !== 0) {
        throw new Error(
          `${label} level ${level} row ${row} is not a non-empty list of [end, index] pairs: ` +
            describeValue(runs),
        );
      }
      let column = 0;
      for (let pair = 0; pair < runs.length; pair += 2) {
        const end = runs[pair] as unknown;
        const index = runs[pair + 1] as unknown;
        if (!Number.isInteger(end) || (end as number) < column || (end as number) >= ACCEL_COLUMNS) {
          throw new Error(
            `${label} level ${level} row ${row} run ${pair / 2} ends at ${describeValue(end)}; ` +
              `runs must advance and stay inside 0..${ACCEL_COLUMNS - 1}`,
          );
        }
        if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= vectors.length) {
          throw new Error(
            `${label} level ${level} row ${row} run ${pair / 2} has index ${describeValue(index)}, ` +
              `outside the ${vectors.length} vectors this table declares`,
          );
        }
        const last = end as number;
        grid.fill(index as number, row * ACCEL_COLUMNS + column, row * ACCEL_COLUMNS + last + 1);
        column = last + 1;
      }
      if (column !== ACCEL_COLUMNS) {
        throw new Error(
          `${label} level ${level} row ${row} covers ${column} columns, expected ${ACCEL_COLUMNS}`,
        );
      }
    }
    blocks.push(grid);
  }

  const frozenVectors = Object.freeze(vectors);
  const frozenBlocks = Object.freeze(blocks);
  const frozenDrives = Object.freeze(drives);

  return Object.freeze({
    tableId,
    displayName,
    vectors: frozenVectors,
    blocks: frozenBlocks,
    driveAt(level: PlayfieldLevel, pixelX: number, pixelY: number): RampDriveVector {
      if (pixelX < 0 || pixelX >= PLAYFIELD_WIDTH || pixelY < 0 || pixelY >= PLAYFIELD_HEIGHT) {
        return NO_DRIVE;
      }
      const grid = frozenBlocks[level === 1 ? 1 : 0];
      if (grid === undefined) return NO_DRIVE;
      const cell = (pixelY >> 3) * ACCEL_COLUMNS + (pixelX >> 3);
      return frozenDrives[grid[cell] as number] ?? NO_DRIVE;
    },
  });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<TableId, TableAcceleration>();

/** Makes one table's drive available to `createGame`. Idempotent. */
export function registerTableAcceleration(acceleration: TableAcceleration): void {
  REGISTRY.set(acceleration.tableId, acceleration);
}

/** Forgets every registration. For tests that need a clean slate. */
export function clearTableAccelerations(): void {
  REGISTRY.clear();
}

/**
 * One table's drive, or a thrown error naming what to load.
 *
 * Never a null drive. See the header: a table quietly running without its ramp
 * drive is a different machine, and the failure is invisible from the outside.
 */
export function tableAccelerationFor(tableId: TableId): TableAcceleration {
  const found = REGISTRY.get(tableId);
  if (found === undefined) {
    throw new Error(
      `no ramp drive registered for "${tableId}". Load ${tableAccelUrl(tableId)} and pass it to ` +
        `registerTableAcceleration() before creating a game: without it the ramps do not carry ` +
        `the ball and shallow surfaces trap it.`,
    );
  }
  return found;
}

/** URL of one table's exported drive, relative to the site root. */
export function tableAccelUrl(tableId: TableId, basePath: string = TABLE_ACCEL_BASE_PATH): string {
  return `${basePath}${tableId}.accel.json`;
}

/** The slice of `Response` this loader needs, so tests can pass a plain object. */
export interface TableAccelResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export type TableAccelFetch = (url: string) => Promise<TableAccelResponse>;

// Wrapped rather than passing `fetch` itself: an unbound reference to the global
// throws "Illegal invocation" in browsers.
const defaultFetch: TableAccelFetch = (url) => fetch(url);

/**
 * Fetches, parses and REGISTERS one table's drive.
 *
 * Registering here rather than leaving it to the caller is deliberate: there is
 * no legitimate reason to load a drive and not use it, and a caller that forgot
 * the second call would get a game that looks fine and traps balls.
 */
export async function loadTableAcceleration(
  tableId: TableId,
  fetchImpl: TableAccelFetch = defaultFetch,
  basePath: string = TABLE_ACCEL_BASE_PATH,
): Promise<TableAcceleration> {
  const url = tableAccelUrl(tableId, basePath);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const doc = (await response.json()) as TableAccelDocument;
  const acceleration = parseTableAccelDocument(doc);
  registerTableAcceleration(acceleration);
  return acceleration;
}
