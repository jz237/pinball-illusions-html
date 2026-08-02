/**
 * THE FLIPPER BAT POSE BANK: the decode, the placement and the stroke mapping.
 *
 * The assertions that matter most, in order:
 *
 *   1. THE RASTER IS THE DISK'S. `flipdat1.bin`'s sha256 and a digest over
 *      every shipped bitplane are pinned, so a re-export that changed a pixel
 *      fails here rather than in somebody's eyes six months later.
 *   2. THE POSES ARE THREE BITPLANES, NOT TWO PLUS A MASK. Reading the third
 *      run as a fill mask gives a red-outlined blob; reading it as bitplane 2
 *      gives the slim grey-bodied bat the original draws. Asserted as the
 *      colour census: entries 1..6 of the table's own palette, entry 5 (light
 *      grey) the most common at 42%, and nothing at all in entries 0 or 7.
 *   3. EVERY BAT RESTS WHERE ITS RECORD SAYS. Pivot, rest pose and flipped
 *      pose per bat per table, pinned against the disk — including the three
 *      upper bats, which is where this reconstruction has historically been
 *      weakest.
 *   4. THE STROKE MAPS TO A POSE THE ORIGINAL'S OWN WAY. `asr.w #$6` on the
 *      SIGNED angle, which floors toward minus infinity and is therefore NOT
 *      symmetric between a left bat and a right one.
 *   5. THE ANCHOR RULE REPRODUCES THE FILM. The 34 anchors measured
 *      pixel-exact off filmed WinUAE frames ship here as a fixture.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ANGLE_SHIFT_PER_POSE,
  ANGLE_UNITS_PER_POSE,
  DEGREES_PER_POSE,
  FLIPPER_BATS_SCHEMA,
  POSES_PER_TURN,
  batBlockOrigin,
  batPoseForStroke,
  clearFlipperBats,
  flipperBats,
  loadFlipperBats,
  parseFlipperBatsDocument,
  registerFlipperBats,
} from "../src/game/flipper-bats.js";
import type { FlipperBatsDocument, TableId } from "../src/game/contracts.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import {
  BAT_ANGLE_UNITS_PER_POSE,
  FLIPPER_RECORDS,
  FLIPPER_SWEEP_POSES,
  UPPER_FLIPPER_RECORDS,
  flipperConfigsFor,
  flipperRecordFor,
  poseToAngleUnits,
} from "../src/game/flippers.js";
import { flipperBatsFixture } from "./table-fixtures.js";

const bats = flipperBatsFixture();

/** MEASURED: what the four decoded records say, per table. */
const RECORDS: Record<
  TableId,
  Record<string, { pivot: [number, number]; rest: number; flipped: number; sweep: number; direction: 1 | -1 }>
> = {
  "law-n-justice": {
    "lower-left": { pivot: [86, 556], rest: 10, flipped: 112, sweep: 18, direction: -1 },
    "lower-right": { pivot: [199, 556], rest: 50, flipped: 68, sweep: 18, direction: 1 },
    upper: { pivot: [37, 302], rest: 23, flipped: 12, sweep: 11, direction: -1 },
  },
  babewatch: {
    "lower-left": { pivot: [112, 556], rest: 10, flipped: 112, sweep: 18, direction: -1 },
    "lower-right": { pivot: [227, 556], rest: 50, flipped: 68, sweep: 18, direction: 1 },
    upper: { pivot: [205, 115], rest: 35, flipped: 48, sweep: 13, direction: 1 },
  },
  "extreme-sports": {
    "lower-left": { pivot: [113, 556], rest: 10, flipped: 112, sweep: 18, direction: -1 },
    "lower-right": { pivot: [227, 556], rest: 50, flipped: 68, sweep: 18, direction: 1 },
    upper: { pivot: [182, 194], rest: 50, flipped: 68, sweep: 18, direction: 1 },
  },
};

/** Anchors measured pixel-exact against filmed WinUAE frames. `pose: [ax, ay]`. */
const FILM_ANCHORS: readonly (readonly [number, number, number])[] = [
  [0, 8, 8], [2, 8, 8], [3, 8, 8], [4, 8, 8], [5, 8, 8], [6, 8, 8],
  [8, 8, 8], [9, 8, 8], [10, 8, 8], [23, 8, 8],
  [50, 41, 8], [51, 42, 8], [52, 43, 8], [54, 45, 8], [55, 46, 8],
  [56, 47, 8], [57, 48, 8], [58, 48, 8], [60, 48, 8], [61, 48, 8],
  [62, 48, 9], [63, 48, 11], [64, 47, 13], [65, 46, 15], [66, 45, 17],
  [67, 44, 20], [68, 43, 22],
  [112, 8, 22], [113, 8, 20], [114, 8, 17], [115, 8, 15], [116, 8, 13],
  [117, 8, 11], [119, 8, 8],
];

/** Pinned dimensions of the poses the film verified, plus the two bank ends. */
const POSE_GEOMETRY: readonly (readonly [number, number, number, number])[] = [
  // pose, unit, width, height
  [0, 0, 55, 15],
  [10, 10, 48, 32],
  [23, 23, 26, 51],
  [35, 35, 23, 53],
  [48, 48, 46, 36],
  [50, 50, 48, 32],
  [68, 68, 50, 29],
  [112, 101, 50, 29],
  [119, 108, 55, 15],
];

function poseAt(pose: number) {
  const entry = bats.poses.get(pose);
  if (entry === undefined) throw new Error(`pose ${pose} is not shipped`);
  return entry;
}

/** Palette indices of one pose, composited the way the renderer does. */
function poseIndices(pose: number): Uint8Array {
  const entry = poseAt(pose);
  const rowBytes = Math.ceil(entry.width / 8);
  const out = new Uint8Array(entry.width * entry.height);
  const bit = (plane: Uint8Array, row: number, x: number): number =>
    ((plane[row * rowBytes + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0 ? 1 : 0;
  for (let y = 0; y < entry.height; y += 1) {
    for (let x = 0; x < entry.width; x += 1) {
      let index = bit(entry.plane0, y, x) | (bit(entry.plane1, y, x) << 1);
      const body = y - bats.plane2RowOffset;
      if (body >= 0 && body < entry.height - 2 * bats.plane2RowOffset && bit(entry.plane2, body, x) !== 0) {
        index |= 4;
      }
      out[y * entry.width + x] = index;
    }
  }
  return out;
}

describe("the shipped pose bank", () => {
  it("is the disk's raster, byte for byte", () => {
    expect(bats.sourceSha256).toBe(
      "968036ad0cd2ac354fa0e137e71b6cab69ee0187421c0ac10b6a17afb820d306",
    );
    const digest = createHash("sha256");
    for (const pose of [...bats.poses.keys()].sort((a, b) => a - b)) {
      const entry = poseAt(pose);
      digest.update(entry.plane0);
      digest.update(entry.plane1);
      digest.update(entry.plane2);
    }
    expect(digest.digest("hex")).toBe(
      "f1423a6230159bf137368532070bf40b3943d41f57ede548e4ec8bb0ee672071",
    );
  });

  it("ships the 64 poses the records reach, out of 120 in a turn", () => {
    expect(bats.poses.size).toBe(64);
    expect(bats.posesPerTurn).toBe(POSES_PER_TURN);
    expect(bats.degreesPerPose).toBe(DEGREES_PER_POSE);
    expect(bats.posesPerTurn * bats.degreesPerPose).toBe(360);
    // Derived from the records rather than listed: the four arcs, unioned.
    const wanted = new Set<number>();
    for (const records of bats.tables.values()) {
      for (const bat of records.values()) {
        for (let step = 0; step <= bat.sweepPoses; step += 1) {
          wanted.add(((bat.restPose + bat.direction * step) % 120 + 120) % 120);
        }
      }
    }
    expect([...bats.poses.keys()].sort((a, b) => a - b)).toEqual([...wanted].sort((a, b) => a - b));
  });

  it("does not ship the eleven poses the bank has no units for", () => {
    // Bearings 255..285, tip pointing up and to the left. No bat reaches them,
    // so their absence is a fact about the disk rather than a gap.
    for (let pose = 85; pose <= 95; pose += 1) {
      expect(bats.poses.has(pose)).toBe(false);
    }
  });

  it("keeps each pose's measured width, height and stored unit", () => {
    for (const [pose, unit, width, height] of POSE_GEOMETRY) {
      const entry = poseAt(pose);
      expect([pose, entry.unit, entry.width, entry.height]).toEqual([pose, unit, width, height]);
      expect(entry.bearingDeg).toBe(pose * DEGREES_PER_POSE);
      // Plane 2 is inset two rows top and bottom — the outline is 2 px thick.
      const rowBytes = Math.ceil(width / 8);
      expect(entry.plane0.length).toBe(rowBytes * height);
      expect(entry.plane1.length).toBe(rowBytes * height);
      expect(entry.plane2.length).toBe(rowBytes * (height - 4));
    }
  });

  it("is a THREE-plane sprite: six colours, none in entries 0 or 7", () => {
    const tally = new Map<number, number>();
    for (const pose of bats.poses.keys()) {
      for (const index of poseIndices(pose)) tally.set(index, (tally.get(index) ?? 0) + 1);
    }
    const count = (index: number): number => tally.get(index) ?? 0;
    const drawn = [1, 2, 3, 4, 5, 6].reduce((sum, index) => sum + count(index), 0);
    expect(count(7)).toBe(0);
    for (let index = 1; index <= 6; index += 1) expect(count(index)).toBeGreaterThan(0);
    // The body ramp dominates, which is what says plane 2 is a plane and not a
    // fill mask: read as a mask the same pixels would all be outline red.
    expect(count(5) / drawn).toBeGreaterThan(0.4);
    expect(count(1) / drawn).toBeGreaterThan(0.25);
    expect(count(1) / drawn).toBeLessThan(0.35);
  });

  it("draws a solid bat: no interior holes in any shipped pose", () => {
    for (const pose of bats.poses.keys()) {
      const entry = poseAt(pose);
      const indices = poseIndices(pose);
      const w = entry.width + 2;
      const h = entry.height + 2;
      const seen = new Uint8Array(w * h);
      const stack = [0];
      seen[0] = 1;
      while (stack.length > 0) {
        const at = stack.pop() as number;
        const x = at % w;
        const y = (at - x) / w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const next = ny * w + nx;
          if (seen[next] === 1) continue;
          const inside = nx >= 1 && ny >= 1 && nx <= entry.width && ny <= entry.height;
          if (inside && (indices[(ny - 1) * entry.width + (nx - 1)] ?? 0) !== 0) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
      let holes = 0;
      for (let y = 0; y < entry.height; y += 1) {
        for (let x = 0; x < entry.width; x += 1) {
          if ((indices[y * entry.width + x] ?? 0) !== 0) continue;
          if (seen[(y + 1) * w + (x + 1)] === 0) holes += 1;
        }
      }
      expect([pose, holes]).toEqual([pose, 0]);
    }
  });
});

describe("the anchor", () => {
  it("reproduces every anchor measured off the film", () => {
    for (const [pose, ax, ay] of FILM_ANCHORS) {
      const entry = poseAt(pose);
      expect([pose, entry.anchorX, entry.anchorY]).toEqual([pose, ax, ay]);
    }
    expect(FILM_ANCHORS.length).toBe(34);
  });

  it("follows the closed-form rule on every shipped pose", () => {
    for (const [pose, entry] of bats.poses) {
      // cos(3p) >= 0 is p <= 30 or p >= 90; sin(3p) >= 0 is p <= 60.
      expect(entry.anchorX).toBe(pose <= 30 || pose >= 90 ? 8 : entry.width - 7);
      expect(entry.anchorY).toBe(pose <= 60 ? 8 : entry.height - 7);
    }
  });

  it("places the two lower bats where the film has them", () => {
    // The block origins measured against research/view/compare/<id>-original.png
    // at 587 of 587 pixels each, on all three tables.
    const expected: Record<TableId, readonly [number, number][]> = {
      "law-n-justice": [[78, 548], [158, 548]],
      babewatch: [[104, 548], [186, 548]],
      "extreme-sports": [[105, 548], [186, 548]],
    };
    for (const tableId of TABLE_IDS as readonly TableId[]) {
      const records = bats.tables.get(tableId);
      if (records === undefined) throw new Error(`no records for ${tableId}`);
      const origins = ["lower-left", "lower-right"].map((id) => {
        const bat = records.get(id);
        if (bat === undefined) throw new Error(`${tableId} has no ${id}`);
        const origin = batBlockOrigin(bat, poseAt(bat.restPose));
        return [origin.x, origin.y] as const;
      });
      expect(origins).toEqual(expected[tableId]);
    }
  });
});

describe("the records", () => {
  it("carries three bats per table at their measured pivots and poses", () => {
    for (const tableId of TABLE_IDS as readonly TableId[]) {
      const records = bats.tables.get(tableId);
      if (records === undefined) throw new Error(`no records for ${tableId}`);
      expect([...records.keys()].sort()).toEqual(["lower-left", "lower-right", "upper"]);
      for (const [id, want] of Object.entries(RECORDS[tableId])) {
        const bat = records.get(id);
        if (bat === undefined) throw new Error(`${tableId} has no ${id}`);
        expect([tableId, id, bat.pivotX, bat.pivotY]).toEqual([tableId, id, ...want.pivot]);
        expect([tableId, id, bat.restPose, bat.flippedPose]).toEqual([
          tableId,
          id,
          want.rest,
          want.flipped,
        ]);
        expect([tableId, id, bat.sweepPoses, bat.direction]).toEqual([
          tableId,
          id,
          want.sweep,
          want.direction,
        ]);
      }
    }
  });

  it("IS the geometry flippers.ts simulates — all nine bats, every field, by equality", () => {
    // WIDENED FROM THE UPPER BATS TO ALL NINE. This used to check the three
    // upper records field for field and the six lower ones only by pivot,
    // against a `MEASURED_FLIPPER_PIVOTS` table that the simulation did not
    // read — the simulation ran on inferred pivots two rows away, and the
    // safeguard for THAT lived in flippers.test.ts and allowed two pixels of
    // slack. The inferred placement is gone; this is now the whole cross-check
    // between the picture and the physics, and it has no slack at all.
    for (const tableId of TABLE_IDS as readonly TableId[]) {
      const records = bats.tables.get(tableId);
      if (records === undefined) throw new Error(`no records for ${tableId}`);
      expect(records.size).toBe(FLIPPER_RECORDS[tableId].length);
      for (const simulated of FLIPPER_RECORDS[tableId]) {
        const drawn = records.get(simulated.id);
        if (drawn === undefined) throw new Error(`${tableId} has no ${simulated.id}`);
        expect({ tableId, id: simulated.id, drawn: [
          drawn.pivotX, drawn.pivotY, drawn.restPose, drawn.flippedPose, drawn.sweepPoses,
          drawn.role, drawn.handlerFamily, drawn.coilAcceleration, Math.abs(drawn.coilCap),
          drawn.springAcceleration, Math.abs(drawn.springCap),
        ] }).toEqual({ tableId, id: simulated.id, drawn: [
          simulated.pivotXPixels, simulated.pivotYPixels, simulated.restPose,
          simulated.flippedPose, simulated.sweepPoses, simulated.role,
          simulated.handlerFamily, simulated.upAcceleration, simulated.upMaxRate,
          simulated.downAcceleration, simulated.downMaxRate,
        ] });
      }
      // The upper view still resolves, since the dossier cites it by name.
      expect(UPPER_FLIPPER_RECORDS[tableId]).toBe(flipperRecordFor(tableId, "upper"));
      // Every lower bat rests at exactly 30 degrees below horizontal — pose 10
      // mirrored to pose 50 — which is what the film adjudicated.
      expect(records.get("lower-left")?.restPose).toBe(10);
      expect(records.get("lower-right")?.restPose).toBe(50);
      expect(poseToAngleUnits(10) + poseToAngleUnits(50)).toBe(1024);
    }
  });

  it("names exactly the bats the simulation configures, with the same sweeps", () => {
    for (const tableId of TABLE_IDS as readonly TableId[]) {
      const records = bats.tables.get(tableId);
      if (records === undefined) throw new Error(`no records for ${tableId}`);
      for (const config of flipperConfigsFor(tableId)) {
        const bat = records.get(config.id);
        if (bat === undefined) throw new Error(`${tableId} draws no bat for "${config.id}"`);
        // The pose bank and the simulation must agree about how far the bat
        // travels, or the drawn pose and the colliding one part company.
        expect([tableId, config.id, config.sweep]).toEqual([
          tableId,
          config.id,
          bat.sweepPoses * BAT_ANGLE_UNITS_PER_POSE,
        ]);
        expect(bat.direction).toBe(config.direction);
      }
      expect(records.get("lower-left")?.sweepPoses).toBe(FLIPPER_SWEEP_POSES);
    }
  });

  it("keeps the coil's sign and the pose direction in step", () => {
    // The original stores a SIGNED angle and derives the pose with `asr.w #$6`,
    // so a bat whose poses count down must be driven negative. If these two ever
    // disagree the drawn bat swings the wrong way.
    for (const records of bats.tables.values()) {
      for (const bat of records.values()) {
        expect(Math.sign(bat.coilCap)).toBe(bat.direction);
        expect(Math.sign(bat.springCap)).toBe(-bat.direction);
      }
    }
  });
});

describe("stroke to pose", () => {
  const lnj = bats.tables.get("law-n-justice");
  if (lnj === undefined) throw new Error("no Law 'n Justice records");
  const left = lnj.get("lower-left");
  const right = lnj.get("lower-right");
  const upper = lnj.get("upper");
  if (left === undefined || right === undefined || upper === undefined) {
    throw new Error("Law 'n Justice is missing a bat");
  }
  const sweep = (poses: number): number => poses * ANGLE_UNITS_PER_POSE;

  it("rests on the record's rest pose and ends on its flipped pose", () => {
    for (const bat of [left, right, upper]) {
      expect(batPoseForStroke(bat, 0, sweep(bat.sweepPoses))).toBe(bat.restPose);
      expect(batPoseForStroke(bat, sweep(bat.sweepPoses), sweep(bat.sweepPoses))).toBe(
        bat.flippedPose,
      );
    }
  });

  it("walks one pose per 64 bat units, in the record's direction", () => {
    for (let step = 0; step <= 18; step += 1) {
      expect(batPoseForStroke(right, step * 64, sweep(18))).toBe((50 + step) % 120);
      expect(batPoseForStroke(left, step * 64, sweep(18))).toBe((10 - step + 120) % 120);
    }
  });

  it("is the original's `asr.w #$6`, which is NOT symmetric between the bats", () => {
    // A right bat's angle runs 0..+1152 and floors; a left bat's runs 0..-1152
    // and an arithmetic shift of a negative number floors AWAY from zero. So one
    // unit into the stroke the left bat has already advanced a pose and the
    // right one has not. Rounding both would be a pose out on one of them for
    // fifteen sixteenths of the travel.
    expect(ANGLE_SHIFT_PER_POSE).toBe(6);
    expect(1 << ANGLE_SHIFT_PER_POSE).toBe(ANGLE_UNITS_PER_POSE);
    expect(batPoseForStroke(right, 1, sweep(18))).toBe(50);
    expect(batPoseForStroke(right, 63, sweep(18))).toBe(50);
    expect(batPoseForStroke(right, 64, sweep(18))).toBe(51);
    expect(batPoseForStroke(left, 1, sweep(18))).toBe(9);
    expect(batPoseForStroke(left, 63, sweep(18))).toBe(9);
    expect(batPoseForStroke(left, 64, sweep(18))).toBe(9);
    expect(batPoseForStroke(left, 65, sweep(18))).toBe(8);
  });

  it("only ever asks for a pose the bank stores", () => {
    for (const records of bats.tables.values()) {
      for (const bat of records.values()) {
        const span = sweep(bat.sweepPoses);
        for (let stroke = 0; stroke <= span; stroke += 1) {
          expect(bats.poses.has(batPoseForStroke(bat, stroke, span))).toBe(true);
        }
      }
    }
  });

  it("draws the strokes the simulation really reaches, including negative ones", () => {
    // REPLACES a pin that required a throw for ANY stroke outside 0..sweep. That
    // contract was wrong and it crashed the game: `tickFlipper` skips its near
    // stop while the button is held, so re-pressing a falling bat drives the
    // stroke below zero — measured at -58 from a 4-tick hold, a 6-tick gap and a
    // re-press, which is a 120 ms double-tap, and the renderer threw on it.
    //
    // The replacement is tied to what the simulation can actually produce rather
    // than to an assumed range, which is the stronger claim: every one of those
    // strokes must resolve to a pose the bank really stores. The pose arithmetic
    // was always fine — at -58 a left bat gives (-1*-58)>>6 = 0 and a right bat
    // -58>>6 = -1 — so only the guard was ever wrong.
    for (const records of bats.tables.values()) {
      for (const bat of records.values()) {
        const span = sweep(bat.sweepPoses);
        for (const stroke of [-span, -58, -10, -1, 0, 1, span - 1, span]) {
          expect(bats.poses.has(batPoseForStroke(bat, stroke, span))).toBe(true);
        }
      }
    }
  });

  it("still refuses a stroke that means the record is mis-wired", () => {
    // A spring overshoot is tens of units; a mis-wired record is thousands. The
    // guard keeps the job it was written for, at the threshold that separates the
    // two, and the sweep cross-check is untouched.
    expect(() => batPoseForStroke(right, -5000, sweep(18))).toThrow(/mis-wired/);
    expect(() => batPoseForStroke(right, 99_999, sweep(18))).toThrow(/mis-wired/);
    expect(() => batPoseForStroke(right, 0, sweep(17))).toThrow(/record sweeps/);
  });
});

describe("the loader", () => {
  /** `n` transparent bytes, base64. */
  const blank = (n: number): string => btoa(String.fromCharCode(0).repeat(n));
  const document = (): FlipperBatsDocument =>
    JSON.parse(
      JSON.stringify({
        schema: FLIPPER_BATS_SCHEMA,
        provenance: { sourceClass: "disk-derived-flipper-sprites", description: "", authorizationRequired: true },
        source: { file: "flipdat1.bin", byteLength: 1, sha256: "0".repeat(64) },
        posesPerTurn: 120,
        degreesPerPose: 3,
        angleUnitsPerPose: 64,
        planes: 3,
        plane2RowOffset: 2,
        poses: [0, 1].map((pose) => ({
          pose,
          unit: pose,
          bearingDeg: 3 * pose,
          width: 8,
          height: 8,
          anchorX: 8,
          anchorY: 8,
          plane0: blank(8),
          plane1: blank(8),
          plane2: blank(4),
        })),
        tables: [
          {
            tableId: "law-n-justice",
            displayName: "Law 'n Justice",
            bats: [
              {
                id: "lower-right",
                role: "right",
                slot: 3,
                pivotX: 1,
                pivotY: 2,
                restPose: 0,
                flippedPose: 1,
                direction: 1,
                sweepPoses: 1,
                button: "right",
                handlerFamily: 4,
                springAcceleration: 30,
                springCap: -50,
                coilAcceleration: 20,
                coilCap: 120,
              },
            ],
          },
        ],
      }),
    ) as FlipperBatsDocument;

  it("rejects a document that sweeps through a pose it does not carry", () => {
    const doc = document() as unknown as Record<string, unknown>;
    const tables = doc["tables"] as { bats: Record<string, unknown>[] }[];
    (tables[0] as { bats: Record<string, unknown>[] }).bats[0]!["sweepPoses"] = 3;
    expect(() => parseFlipperBatsDocument(doc as unknown as FlipperBatsDocument)).toThrow(
      /does not carry/,
    );
  });

  it("rejects a document whose pose step disagrees with the simulation", () => {
    const doc = document() as unknown as Record<string, unknown>;
    doc["angleUnitsPerPose"] = 32;
    expect(() => parseFlipperBatsDocument(doc as unknown as FlipperBatsDocument)).toThrow(
      /the simulation/,
    );
  });

  it("rejects the wrong schema", () => {
    const doc = document() as unknown as Record<string, unknown>;
    doc["schema"] = "pinball-illusions/flipper-bats/v0";
    expect(() => parseFlipperBatsDocument(doc as unknown as FlipperBatsDocument)).toThrow(/schema/);
  });

  it("registers what it loads and hands back null when nothing is registered", async () => {
    clearFlipperBats();
    expect(flipperBats()).toBeNull();
    const loaded = await loadFlipperBats(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => document(),
    }));
    expect(flipperBats()).toBe(loaded);
    clearFlipperBats();
    registerFlipperBats(bats);
    expect(flipperBats()).toBe(bats);
  });
});
