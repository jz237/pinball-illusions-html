/**
 * Loader for the shipped FLIPPER BAT POSE BANK
 * (`public/generated/flipper-bats.json`).
 *
 * ---------------------------------------------------------------------------
 * WHAT ARRIVES IN THIS DOCUMENT
 * ---------------------------------------------------------------------------
 * ONE shared document, not one per table: `pkg/flipdat1.bin` is a single
 * 136,288-byte raster bank used by all three tables, and only the PALETTE
 * differs between them. `scripts/export-flipper-bats.mjs` decodes:
 *
 *   POSES   the 64 of 120 three-degree poses some bat on some table actually
 *           reaches, each as THREE BITPLANES — plane 0 and plane 1 `height`
 *           rows, plane 2 `height - 4` rows drawn at row +2 — with the width,
 *           height and blit anchor that place it against a pivot. The pixel is
 *           `plane0 | plane1<<1 | plane2<<2` and index 0 is transparent.
 *
 *   TABLES  each table's three flipper records: pivot in whole playfield
 *           pixels, rest and flipped pose, the direction the poses count, the
 *           sweep in poses, and the stroke constants.
 *
 * NO PALETTE SHIPS HERE. The bat writes into playfield bitplanes 0,1,2 and
 * clears 3..7, so its indices are entries 0..7 of the table's OWN 256-colour
 * artwork palette, which `table-art.ts` already holds. That is the whole reason
 * one raster serves three tables.
 *
 * ---------------------------------------------------------------------------
 * THE SIMULATION AND THE PICTURE NOW AGREE ON EVERY NUMBER
 * ---------------------------------------------------------------------------
 * This block used to say the opposite, and it is worth keeping the shape of the
 * old note so the mistake is not available again.
 *
 * There were two: the records put every lower pivot on ROW 556 and the
 * simulation collided on an inferred row 558, and the records rest at pose 10 /
 * pose 50 — exactly 30 degrees — while the simulation rested at a chosen 26.7.
 * Both were labelled "rendering-only", on the reasoning that the simulation must
 * not be moved to make a picture right. That reasoning was backwards. The
 * picture was the disk's and the simulation's was not, so the drawn bat was
 * correct and the colliding bat was two pixels and three degrees away from it —
 * and because the drawn bat sat ABOVE the colliding one, a ball resting on the
 * flipper the player could see had nothing under it. 33-43% of every approach to
 * a bat was a contact the player saw and the machine did not.
 *
 * `flippers.ts` now builds all nine bats from these same records, and
 * `movingSpritePlacements` blits each pose against the SIMULATION's pivot rather
 * than the record's, so the picture cannot come apart from the physics again
 * without a test failing: `tests/flippers.test.ts` pins every field of
 * `FLIPPER_RECORDS` against this document by equality.
 *
 * AND THE BODY IS THE PICTURE. Each pose carries a `silhouette` — `plane0 |
 * plane1 | plane2`, the same OR the original's own mask builder performs at
 * `+0x003948` — and `flippers.ts` collides a ball's probe ring against exactly
 * those bits, placed at exactly the origin the renderer blits to. There is no
 * second shape and no fallback: `batPoseBody` throws rather than invent one.
 */

import { TABLE_IDS } from "./contracts.js";
import type { FlipperBatsDocument, TableId } from "./contracts.js";

/** The only document schema this loader understands. */
export const FLIPPER_BATS_SCHEMA = "pinball-illusions/flipper-bats/v1";

/** Where the exported document lives under the site root (Vite serves `public/`). */
export const FLIPPER_BATS_PATH = "generated/flipper-bats.json";

/** Poses in a full turn, and degrees between them. Pinned by the parser. */
export const POSES_PER_TURN = 120;
export const DEGREES_PER_POSE = 3;

/**
 * Bat angle units to a drawn pose: 64, the original's `asr.w #6` at
 * main.seg00 +0xBDB8. The same constant `flippers.ts` calls
 * `BAT_ANGLE_UNITS_PER_POSE`; restated here so the parser can refuse a document
 * that disagrees with the simulation about the scale.
 */
export const ANGLE_UNITS_PER_POSE = 64;

/** The same constant as a shift, which is the form the original uses. */
export const ANGLE_SHIFT_PER_POSE = 6;
if (1 << ANGLE_SHIFT_PER_POSE !== ANGLE_UNITS_PER_POSE) {
  throw new Error("the flipper pose shift and the pose size have drifted apart");
}

/**
 * ONE POSE'S COLLISION BODY: every pixel the pose draws, packed one bit each.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIVES BESIDE THE RASTER AND NOT IN `flippers.ts`
 * ---------------------------------------------------------------------------
 * The original collides against the bat's OWN pixels. `main.seg00 +0x00B2A2`
 * walks the flipper records before it looks at the map at all; when the ball's
 * top-left is inside the pose's box it points the collision blit at the bat's
 * per-pose MASK BITMAP (record+$30, per-pose offsets at +$B8/+$F8, 12-byte
 * rows) instead of the playfield plane, and `+0x003948` builds that mask by
 * OR-ing the three drawn planes together — `BLTCON0 = $0FFE`, minterm `$FE` =
 * A OR B OR C, run once over the plane-0/1 block and again over plane 2. So
 * the machine's collision silhouette IS `plane0 | plane1 | plane2`, and there
 * is exactly one shape in the machine for a pose.
 *
 * Building it here, in the loader, next to the raster the renderer draws, is
 * what keeps that true of the reconstruction: there is one decode of one
 * document, and the picture and the physics read the same bits. A silhouette
 * built in `flippers.ts` would be a second decode able to drift from the first,
 * which is the mistake `FLIPPER_PLACEMENT_NOTE` records for the pivots.
 *
 * PLANE 2 IS PLACED WHERE THE PICTURE PUTS IT, at row `plane2RowOffset`, and
 * the machine's own mask does not: its second blit is `h+2` rows tall against a
 * plane-2 run of `h-4`, so the mask carries plane 2 two rows high and, on the
 * ten shipped poses of height <= 17, drags one or two inked rows of the NEXT
 * stored unit in underneath. That is a blit-height bug — reproducing it would
 * put phantom collision pixels fifteen rows below the pivot — and the drawn
 * placement is used instead. `tests/flippers.test.ts` pins the choice.
 */
export interface FlipperBatSilhouette {
  readonly width: number;
  readonly height: number;
  /** Bytes a row: `ceil(width / 8)`, bit 0x80 leftmost, same as the planes. */
  readonly rowBytes: number;
  readonly bits: Uint8Array;
  /** Tight bounds of the solid pixels in block coordinates, inclusive. */
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  /** Solid pixels, so a census can state its budget. */
  readonly count: number;
}

/** True when the pose draws the pixel at (x, y) of its own block. */
export function batSilhouetteSolid(
  silhouette: FlipperBatSilhouette,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || x >= silhouette.width || y >= silhouette.height) return false;
  return (
    ((silhouette.bits[y * silhouette.rowBytes + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0
  );
}

/** Packs `plane0 | plane1 | plane2` into one bit a pixel. */
function silhouetteOf(
  width: number,
  height: number,
  plane2RowOffset: number,
  plane0: Uint8Array,
  plane1: Uint8Array,
  plane2: Uint8Array,
): FlipperBatSilhouette {
  const rowBytes = Math.ceil(width / 8);
  const plane2Rows = height - 2 * plane2RowOffset;
  const bits = new Uint8Array(rowBytes * height);
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    const body = y - plane2RowOffset;
    for (let byte = 0; byte < rowBytes; byte += 1) {
      const at = y * rowBytes + byte;
      let merged = (plane0[at] ?? 0) | (plane1[at] ?? 0);
      if (body >= 0 && body < plane2Rows) merged |= plane2[body * rowBytes + byte] ?? 0;
      if (merged === 0) continue;
      bits[at] = merged;
      for (let bit = 0; bit < 8; bit += 1) {
        if ((merged & (0x80 >> bit)) === 0) continue;
        const x = byte * 8 + bit;
        // The last byte of a row can carry bits past the pose's own width; they
        // are padding, not bat, and must not widen the body.
        if (x >= width) continue;
        count += 1;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return Object.freeze({
    width,
    height,
    rowBytes,
    bits,
    left,
    right,
    top,
    bottom,
    count,
  });
}

/** One drawn pose: three bitplanes and where they go against a pivot. */
export interface FlipperBatPose {
  /** 0..119; the bat points at `3 * pose` degrees from +x, rotating toward +y. */
  readonly pose: number;
  /** The stored unit in flipdat1.bin, for provenance. */
  readonly unit: number;
  readonly bearingDeg: number;
  readonly width: number;
  readonly height: number;
  /** Subtract from the pivot to get the block's top-left playfield pixel. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** `height` rows of ceil(width/8) bytes, bit 0x80 leftmost. */
  readonly plane0: Uint8Array;
  readonly plane1: Uint8Array;
  /** `height - 4` rows, drawn at row `plane2RowOffset`. */
  readonly plane2: Uint8Array;
  /** The three planes OR-ed together: the pose's collision body. */
  readonly silhouette: FlipperBatSilhouette;
}

/** One bat's record: where it is, and which poses its stroke walks. */
export interface FlipperBatRecord {
  /** Matches the simulation's `FlipperConfig.id`: lower-left / lower-right / upper. */
  readonly id: string;
  readonly role: "left" | "right";
  readonly slot: number;
  /** Whole playfield pixels, straight off the record. */
  readonly pivotX: number;
  readonly pivotY: number;
  readonly restPose: number;
  readonly flippedPose: number;
  /** +1 when the poses count up from rest, -1 when they count down. */
  readonly direction: 1 | -1;
  readonly sweepPoses: number;
  /** MEASURED at +0xBD6C: which shift key fires this bat. */
  readonly button: "left" | "right";
  readonly handlerFamily: number;
  readonly springAcceleration: number;
  readonly springCap: number;
  readonly coilAcceleration: number;
  readonly coilCap: number;
}

export interface FlipperBats {
  readonly posesPerTurn: number;
  readonly degreesPerPose: number;
  readonly angleUnitsPerPose: number;
  readonly plane2RowOffset: number;
  /** Keyed by pose number; only the poses some bat reaches are shipped. */
  readonly poses: ReadonlyMap<number, FlipperBatPose>;
  /** Per table, keyed by the simulation's flipper id. */
  readonly tables: ReadonlyMap<TableId, ReadonlyMap<string, FlipperBatRecord>>;
  /** sha256 of `flipdat1.bin`, so a test can pin the raster it came from. */
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
 * Expands one document into a `FlipperBats`, checking every cross-reference.
 *
 * As suspicious as the other loaders, for the same reason: a bat one pixel out
 * or one pose off looks entirely plausible and is exactly the class of defect
 * this project keeps refusing to ship.
 */
export function parseFlipperBatsDocument(doc: FlipperBatsDocument): FlipperBats {
  const raw = doc as unknown as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error(`flipper bats document must be an object, got ${describeValue(doc)}`);
  }
  if (raw["schema"] !== FLIPPER_BATS_SCHEMA) {
    throw new Error(
      `flipper bats document has schema ${describeValue(raw["schema"])}, expected "${FLIPPER_BATS_SCHEMA}"`,
    );
  }
  const posesPerTurn = requireWholeNumber(raw["posesPerTurn"], "posesPerTurn", 1, 4096);
  if (posesPerTurn !== POSES_PER_TURN) {
    throw new Error(`flipper bats document has ${posesPerTurn} poses to a turn, expected ${POSES_PER_TURN}`);
  }
  const degreesPerPose = requireWholeNumber(raw["degreesPerPose"], "degreesPerPose", 1, 90);
  if (degreesPerPose * posesPerTurn !== 360) {
    throw new Error(`${posesPerTurn} poses of ${degreesPerPose} degrees is not a full turn`);
  }
  const angleUnitsPerPose = requireWholeNumber(raw["angleUnitsPerPose"], "angleUnitsPerPose", 1, 4096);
  if (angleUnitsPerPose !== ANGLE_UNITS_PER_POSE) {
    throw new Error(
      `flipper bats document steps ${angleUnitsPerPose} bat units to a pose; the simulation ` +
        `steps ${ANGLE_UNITS_PER_POSE}`,
    );
  }
  const planes = requireWholeNumber(raw["planes"], "planes", 3, 3);
  const plane2RowOffset = requireWholeNumber(raw["plane2RowOffset"], "plane2RowOffset", 0, 8);
  void planes;

  const source = raw["source"] as Record<string, unknown> | undefined;
  const sourceSha256 = source?.["sha256"];
  if (typeof sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(sourceSha256)) {
    throw new Error("flipper bats document carries no sha256 for flipdat1.bin");
  }

  const posesValue = raw["poses"];
  if (!Array.isArray(posesValue)) throw new Error("flipper bats poses must be an array");
  const poses = new Map<number, FlipperBatPose>();
  for (const [at, entry] of posesValue.entries()) {
    const item = entry as Record<string, unknown>;
    const where = `flipper bat pose ${at}`;
    const pose = requireWholeNumber(item["pose"], `${where} pose`, 0, posesPerTurn - 1);
    if (poses.has(pose)) throw new Error(`${where}: pose ${pose} appears twice`);
    const width = requireWholeNumber(item["width"], `${where} width`, 1, 64);
    const height = requireWholeNumber(item["height"], `${where} height`, plane2RowOffset + 1, 64);
    const rowBytes = Math.ceil(width / 8);
    const bearingDeg = requireWholeNumber(item["bearingDeg"], `${where} bearingDeg`, 0, 359);
    if (bearingDeg !== pose * degreesPerPose) {
      throw new Error(`${where}: bearing ${bearingDeg} is not ${degreesPerPose} * pose ${pose}`);
    }
    const plane0 = bytesFromBase64(item["plane0"], `${where} plane0`, rowBytes * height);
    const plane1 = bytesFromBase64(item["plane1"], `${where} plane1`, rowBytes * height);
    // Plane 2 is the BODY inside the outline, and it is inset by
    // `plane2RowOffset` rows top and bottom — stored four rows shorter and
    // drawn two rows down — which is the outline being 2 px thick.
    const plane2 = bytesFromBase64(
      item["plane2"],
      `${where} plane2`,
      rowBytes * (height - 2 * plane2RowOffset),
    );
    const silhouette = silhouetteOf(width, height, plane2RowOffset, plane0, plane1, plane2);
    poses.set(
      pose,
      Object.freeze({
        pose,
        unit: requireWholeNumber(item["unit"], `${where} unit`, 0, 511),
        bearingDeg,
        width,
        height,
        anchorX: requireWholeNumber(item["anchorX"], `${where} anchorX`, 0, width),
        anchorY: requireWholeNumber(item["anchorY"], `${where} anchorY`, 0, height),
        plane0,
        plane1,
        plane2,
        silhouette,
      }),
    );
  }

  const tablesValue = raw["tables"];
  if (!Array.isArray(tablesValue)) throw new Error("flipper bats tables must be an array");
  const tables = new Map<TableId, ReadonlyMap<string, FlipperBatRecord>>();
  for (const [at, entry] of tablesValue.entries()) {
    const item = entry as Record<string, unknown>;
    const tableIdValue = item["tableId"];
    if (typeof tableIdValue !== "string" || !isTableId(tableIdValue)) {
      throw new Error(`flipper bats table ${at} has unknown tableId ${describeValue(tableIdValue)}`);
    }
    const batsValue = item["bats"];
    if (!Array.isArray(batsValue)) throw new Error(`flipper bats "${tableIdValue}" bats must be an array`);
    const bats = new Map<string, FlipperBatRecord>();
    for (const batEntry of batsValue) {
      const bat = batEntry as Record<string, unknown>;
      const id = bat["id"];
      if (typeof id !== "string" || id.length === 0) {
        throw new Error(`flipper bats "${tableIdValue}" has a bat with no id`);
      }
      const where = `flipper bat "${tableIdValue}" ${id}`;
      const role = bat["role"];
      if (role !== "left" && role !== "right") {
        throw new Error(`${where} has unknown role ${describeValue(role)}`);
      }
      const restPose = requireWholeNumber(bat["restPose"], `${where} restPose`, 0, posesPerTurn - 1);
      const flippedPose = requireWholeNumber(
        bat["flippedPose"],
        `${where} flippedPose`,
        0,
        posesPerTurn - 1,
      );
      const direction = bat["direction"];
      if (direction !== 1 && direction !== -1) {
        throw new Error(`${where} has direction ${describeValue(direction)}, expected 1 or -1`);
      }
      const sweepPoses = requireWholeNumber(bat["sweepPoses"], `${where} sweepPoses`, 1, posesPerTurn / 2);
      // Every pose the stroke can land on must be in the shipped bank: an
      // absent one is a bat that vanishes at some point in its swing.
      for (let step = 0; step <= sweepPoses; step += 1) {
        const pose = (((restPose + direction * step) % posesPerTurn) + posesPerTurn) % posesPerTurn;
        if (!poses.has(pose)) {
          throw new Error(`${where} sweeps through pose ${pose}, which the document does not carry`);
        }
      }
      if ((((restPose + direction * sweepPoses) % posesPerTurn) + posesPerTurn) % posesPerTurn !== flippedPose) {
        throw new Error(`${where}: ${sweepPoses} poses from ${restPose} is not ${flippedPose}`);
      }
      const button = bat["button"];
      if (button !== "left" && button !== "right") {
        throw new Error(`${where} has unknown button ${describeValue(button)}`);
      }
      if (bats.has(id)) throw new Error(`${where} appears twice`);
      bats.set(
        id,
        Object.freeze({
          id,
          role,
          slot: requireWholeNumber(bat["slot"], `${where} slot`, 0, 15),
          pivotX: requireWholeNumber(bat["pivotX"], `${where} pivotX`, 0, 4095),
          pivotY: requireWholeNumber(bat["pivotY"], `${where} pivotY`, 0, 4095),
          restPose,
          flippedPose,
          direction,
          sweepPoses,
          button,
          handlerFamily: requireWholeNumber(bat["handlerFamily"], `${where} handlerFamily`, 0, 7),
          springAcceleration: requireWholeNumber(
            bat["springAcceleration"],
            `${where} springAcceleration`,
            -4096,
            4096,
          ),
          springCap: requireWholeNumber(bat["springCap"], `${where} springCap`, -4096, 4096),
          coilAcceleration: requireWholeNumber(
            bat["coilAcceleration"],
            `${where} coilAcceleration`,
            -4096,
            4096,
          ),
          coilCap: requireWholeNumber(bat["coilCap"], `${where} coilCap`, -4096, 4096),
        }),
      );
    }
    if (tables.has(tableIdValue)) throw new Error(`flipper bats table "${tableIdValue}" appears twice`);
    tables.set(tableIdValue, bats);
  }

  return Object.freeze({
    posesPerTurn,
    degreesPerPose,
    angleUnitsPerPose,
    plane2RowOffset,
    poses,
    tables,
    sourceSha256,
  });
}

// ---------------------------------------------------------------------------
// Stroke to pose
// ---------------------------------------------------------------------------

/**
 * The pose a bat draws at, from the simulation's stroke.
 *
 * THIS IS THE ORIGINAL'S OWN ARITHMETIC, not a rounding of it. The stroke
 * routine stores a SIGNED angle at $12(a0) and derives the pose offset with
 * `asr.w #$6` at main.seg00 +0xBDB8 — an arithmetic shift, which floors toward
 * minus infinity. The signed angle is `direction * stroke`: the left bats' coil
 * cap is -120 and the right bats' +120, so a left bat's angle runs 0 down to
 * -1152 while a right bat's runs 0 up to +1152, and the exporter checks that
 * the sign of each record's coil cap agrees with the direction its poses count.
 *
 * So `pose = restPose + ((direction * stroke) >> 6)`, and the asymmetry is the
 * original's: a left bat one unit into its stroke has already advanced a pose,
 * a right bat has not. Rounding instead would be a pose out on one bat at
 * fifteen sixteenths of the stroke, which at the tip is nearly a pixel.
 *
 * WHY THIS CLAMPS RATHER THAN THROWS, AND WHAT THAT IS HIDING.
 *
 * It used to throw outside 0..sweep, to stop a bat wired to the wrong record
 * hiding behind a plausible picture. That is a good instinct in an exporter and
 * the wrong one here: this runs inside the render loop on live simulation state,
 * and a renderer that throws takes the whole game down. It did. `tickFlipper`
 * skips its near stop while the button is held (`stroke <= 0 && !held`), so
 * re-pressing a bat that is still falling drives the stroke below zero — an
 * ordinary double-tap, measured at stroke -58 from a 4-tick hold, a 6-tick gap
 * and a re-press, which is 120 ms apart.
 *
 * The pose arithmetic itself handles those values correctly: at -58 a left bat
 * gives `(-1 * -58) >> 6 = 0` and a right bat `-58 >> 6 = -1`, i.e. the rest
 * pose and one step below it, both of which the bank stores. So the clamp is not
 * papering over a bad pose, only over a stroke the simulation should arguably
 * never have produced.
 *
 * THAT IS THE OPEN QUESTION, recorded here rather than silently absorbed: a real
 * bat cannot travel past its rest stop, there is a physical stop there, and the
 * original carries a stroke position cap at record +$14 which is zero on disk and
 * patched at load — undecoded. If that cap is the near stop enforced on both
 * paths, then `&& !held` is wrong and the simulation should clamp at zero. That
 * is a physics change that moves ticks, so it belongs in its own verified round;
 * it is NOT fixed by this clamp, and this comment is the marker.
 *
 * A stroke outside the range by more than one full sweep is still a wiring error
 * rather than a spring overshoot, and still throws.
 *
 * WIDENED to the four fields it actually reads, so the SIMULATION can call it
 * with its own `FlipperConfig` and the renderer with the drawn record, and the
 * pose the bat collides on is by construction the pose the bat draws. A
 * `FlipperBatRecord` still satisfies the shape, so every existing caller is
 * unchanged.
 */
export interface BatStrokeShape {
  readonly id: string;
  readonly restPose: number;
  readonly direction: 1 | -1;
  readonly sweepPoses: number;
}

export function batPoseForStroke(bat: BatStrokeShape, stroke: number, sweepUnits: number): number {
  if (!Number.isInteger(stroke) || stroke < -sweepUnits || stroke > 2 * sweepUnits) {
    throw new RangeError(
      `flipper "${bat.id}" stroke ${stroke} is nowhere near 0..${sweepUnits}; ` +
        `the record is mis-wired rather than the spring overshooting`,
    );
  }
  stroke = Math.min(sweepUnits, Math.max(0, stroke));
  if (sweepUnits !== bat.sweepPoses * ANGLE_UNITS_PER_POSE) {
    throw new RangeError(
      `flipper "${bat.id}" sweeps ${sweepUnits} bat units but its record sweeps ` +
        `${bat.sweepPoses} poses (${bat.sweepPoses * ANGLE_UNITS_PER_POSE} units)`,
    );
  }
  const offset = (bat.direction * stroke) >> ANGLE_SHIFT_PER_POSE;
  return (((bat.restPose + offset) % POSES_PER_TURN) + POSES_PER_TURN) % POSES_PER_TURN;
}

/**
 * Top-left playfield pixel of a pose blitted against a pivot.
 *
 * Takes a PIVOT rather than a record, and that is the whole point: the renderer
 * hands it the SIMULATION's pivot, so the bat that is drawn and the bat that
 * collides are the same object by construction rather than by agreement. A
 * record satisfies the shape, so a caller that has one may still pass it, and
 * the two are pinned equal by `tests/flippers.test.ts`.
 */
export function batBlockOrigin(
  pivot: { readonly pivotX: number; readonly pivotY: number },
  pose: FlipperBatPose,
): { readonly x: number; readonly y: number } {
  return { x: pivot.pivotX - pose.anchorX, y: pivot.pivotY - pose.anchorY };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

let registered: FlipperBats | null = null;

/** Makes the pose bank available to the renderer. Idempotent. */
export function registerFlipperBats(bats: FlipperBats): void {
  registered = bats;
}

/** Forgets the registration. For tests that need a clean slate. */
export function clearFlipperBats(): void {
  registered = null;
}

/**
 * The pose bank, or null.
 *
 * Nullable because the RENDERER has to survive a document that will not fetch:
 * it treats null as "draw the fallback marker", which is deliberately
 * unmistakable rather than quietly plausible — see `moving-sprites.ts`.
 *
 * The PHYSICS does not have that option, which is what `batPoseBody` below is
 * about.
 */
export function flipperBats(): FlipperBats | null {
  return registered;
}

/** A pose's body placed against a pivot: what a ball is actually tested against. */
export interface BatPoseBody {
  readonly pose: number;
  readonly silhouette: FlipperBatSilhouette;
  /** Top-left playfield pixel of the block. */
  readonly originX: number;
  readonly originY: number;
}

/**
 * The collision body of one pose, placed against one pivot.
 *
 * THROWS rather than returning null, and that is the whole design. The bat the
 * ball meets has to be the bat the player sees; if the document that carries
 * that shape is not here there is no second shape to fall back to, and inventing
 * one is exactly how the drawn bat and the colliding bat came apart before (see
 * `FLIPPER_PLACEMENT_NOTE`). A caller that reaches this without the bank
 * registered is mis-assembled, and it says so at the first tick rather than
 * playing a whole game against a shape nobody chose.
 */
export function batPoseBody(
  bat: BatStrokeShape,
  stroke: number,
  sweepUnits: number,
  pivotX: number,
  pivotY: number,
): BatPoseBody {
  const bank = registered;
  if (bank === null) {
    throw new Error(
      `flipper "${bat.id}" has no collision body: the flipper bat pose bank is not ` +
        `registered. Call loadFlipperBats() (or registerFlipperBats) before the ` +
        `simulation runs; there is no fallback shape and there must not be one.`,
    );
  }
  const pose = batPoseForStroke(bat, stroke, sweepUnits);
  const entry = bank.poses.get(pose);
  if (entry === undefined) {
    throw new RangeError(
      `flipper "${bat.id}" reaches pose ${pose}, which the shipped bank does not draw`,
    );
  }
  const origin = batBlockOrigin({ pivotX, pivotY }, entry);
  return { pose, silhouette: entry.silhouette, originX: origin.x, originY: origin.y };
}

/** True when the placed body draws the PLAYFIELD pixel (x, y). */
export function batBodySolid(body: BatPoseBody, x: number, y: number): boolean {
  return batSilhouetteSolid(body.silhouette, x - body.originX, y - body.originY);
}

/** The slice of `Response` this loader needs, so tests can pass a plain object. */
export interface FlipperBatsResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

export type FlipperBatsFetch = (url: string) => Promise<FlipperBatsResponse>;

const defaultFetch: FlipperBatsFetch = (url) => fetch(url);

/** Fetches, parses and REGISTERS the pose bank. */
export async function loadFlipperBats(
  fetchImpl: FlipperBatsFetch = defaultFetch,
  url: string = FLIPPER_BATS_PATH,
): Promise<FlipperBats> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const doc = (await response.json()) as FlipperBatsDocument;
  const bats = parseFlipperBatsDocument(doc);
  registerFlipperBats(bats);
  return bats;
}
