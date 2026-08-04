/**
 * THE MACHINE'S FRAME, and the staircase it produces at Law 'n Justice's top
 * arch.
 *
 * Every number here comes out of `research/ARCH_NORMAL_DECODE.md`, which decoded
 * the original's tick from main.seg00 and then FITTED it against the original's
 * own RAM over 576 traced frames carrying 218 contacts. The rule:
 *
 *   eight substeps of `pos += v >> 1` per frame, a collision-and-respond pass in
 *   front of substeps 0, 2, 4 and 6, the 44-direction ring read WHERE THE BALL
 *   STANDS, and no walk of any kind.
 *
 * THIS FILE PINS BEHAVIOUR. `tests/physics-gate.test.ts` MEASURES ERROR AGAINST
 * THE MACHINE. They are not duplicates and neither replaces the other:
 *
 *   here                    the SHAPE of the rule — eight substeps, four passes,
 *                           the staircase answering 10.79 and 14.13 either side
 *                           of a computed boundary, the decode's own unobserved
 *                           17.24 forecast landing at 17.25. Needs no research
 *                           tree; would still be meaningful if every trace on
 *                           earth were lost.
 *   physics-gate.test.ts    the SIZE of what is left — one number, 1790 units of
 *                           1/256 px per frame over 576 traced frames of the
 *                           original's own RAM, which a physics round must move
 *                           in the right direction or leave alone. Skips where
 *                           the operator's traces are absent.
 *
 * A change can get the staircase right at one site and the slip wrong everywhere
 * (passes here, fails the gate), or score well on average while losing the phase
 * response (passes the gate, fails here). Run both. And note that NEITHER is the
 * film gate, which renders a fresh `createGame` at tick 0 and cannot move on a
 * trajectory change at all — `research/physics-gate/README.md` has the table of
 * which gate proves what.
 *
 * The operator's copy of the error measurement, with a per-frame CSV and a
 * non-zero exit on drift, is `research/physics-gate/run.cmd`.
 *
 * WHY THE ARCH. Session 4 measured the original turning 14.13 degrees at the
 * first top-right arch contact on cold runs A and B and 10.78 on cold run D —
 * 3.35 degrees apart from a quarter pixel of launch phase — where HEAD turned
 * 7.58 and ground. That is not a coefficient; it is the ring reading the wall
 * from a different PIXEL ROW, and the row is decided by which of the frame's
 * four passes the ball is standing in.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { BallState, PlayfieldLevel, TableMap } from "../src/game/contracts.js";
import {
  REST_THRESHOLD,
  SUBSTEP_GRAVITY,
  createBall,
  createBallSet,
  stepBalls,
} from "../src/game/ball-physics.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import {
  parseTableAccelDocument,
  registerTableAcceleration,
  tableAccelerationFor,
} from "../src/game/table-accel.js";
import type { TableAcceleration } from "../src/game/table-accel.js";
import {
  parseTableDevicesDocument,
  registerTableDevices,
  tableDevicesFor,
} from "../src/game/table-devices.js";
import { materialTableFor } from "../src/game/materials.js";
import {
  ORIGINAL_COLLISION_PASSES_PER_FRAME,
  ORIGINAL_SUBSTEPS_PER_FRAME,
  Q10_PER_ORIGINAL_ACCEL_UNIT,
  SIMULATION_GRAVITY,
} from "../src/game/timebase.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";
import { SOLID_BORDER_INDEX } from "../src/game/materials.js";

/**
 * A bare 336x600 playfield with nothing on it, so the frame's own arithmetic is
 * measured without a wall anywhere near it. BabeWatch's id, because its virtual
 * top wall is 0 rows and a fixture must be exactly what it says it is.
 */
const EMPTY_MAP: TableMap = {
  tableId: "babewatch",
  displayName: "fixture",
  width: 336,
  height: 600,
  pixels: new Uint8Array(336 * 600),
  materialAt(x: number, y: number): 0 | typeof SOLID_BORDER_INDEX {
    return x < 0 || y < 0 || x >= 336 || y >= 600 ? SOLID_BORDER_INDEX : 0;
  },
} as unknown as TableMap;

const TABLE = "law-n-justice";
const readJson = (path: string): never => JSON.parse(readFileSync(path, "utf8")) as never;
registerTableAcceleration(
  parseTableAccelDocument(readJson(`public/generated/tables/${TABLE}.accel.json`)),
);
registerTableDevices(
  parseTableDevicesDocument(readJson(`public/generated/tables/${TABLE}.devices.json`)),
);
const LAW_MAP = parseTableMapDocument(readJson(`public/generated/tables/${TABLE}.map.json`));
const LAW_MATERIALS = materialTableFor(TABLE);
const LAW_DRIVE = tableAccelerationFor(TABLE);
const LAW_DEVICES = tableDevicesFor(TABLE);

const FORCES = { gravityY: SIMULATION_GRAVITY, nudgeX: 0, nudgeY: 0 };
const OPTIONS = {
  rampDrive: LAW_DRIVE,
  surfaces: LAW_DEVICES,
  poweredKicksLive: true,
  ballToBall: false,
  restThreshold: REST_THRESHOLD,
};

/** One of the machine's velocity units is four Q10; the traces are in its units. */
const PER_UNIT = 4;

/**
 * The machine's own launch state, one frame at a time.
 *
 * `cx` is 321.3672 on every cold launch of session 4 — the resting lane seat,
 * fine x 313.3672 with vx exactly zero — and the velocity word entering the
 * arch is (0, -3047).
 */
function launchAtQ10(qy: number, ticks = 1): {
  readonly ball: BallState;
  readonly turns: readonly number[];
} {
  const ball = createBall(1, Math.round(321.3672 * 1024), qy, 0, -3047 * PER_UNIT, 1);
  const set = createBallSet([ball]);
  const turns: number[] = [];
  let fromX = ball.velocityX;
  let fromY = ball.velocityY;
  for (let tick = 0; tick < ticks; tick += 1) {
    stepBalls(set, LAW_MAP, LAW_MATERIALS, FORCES, OPTIONS);
    const before = Math.atan2(fromX, -fromY);
    const after = Math.atan2(ball.velocityX, -ball.velocityY);
    turns.push((Math.abs(after - before) * 180) / Math.PI);
    fromX = ball.velocityX;
    fromY = ball.velocityY;
  }
  return { ball, turns };
}

function launchAt(cy: number, ticks = 1): {
  readonly ball: BallState;
  readonly turns: readonly number[];
} {
  return launchAtQ10(Math.round(cy * 1024), ticks);
}

function turnAt(cy: number): number {
  return launchAt(cy).turns[0] ?? 0;
}

function turnAtQ10(qy: number): number {
  return launchAtQ10(qy).turns[0] ?? 0;
}

// ---------------------------------------------------------------------------
// The frame itself
// ---------------------------------------------------------------------------

describe("the machine's frame", () => {
  it("is eight substeps with four collision passes, and the shapes divide", () => {
    expect(ORIGINAL_SUBSTEPS_PER_FRAME).toBe(8);
    expect(ORIGINAL_COLLISION_PASSES_PER_FRAME).toBe(4);
    // A pass in front of every other substep: 0, 2, 4, 6.
    expect(ORIGINAL_SUBSTEPS_PER_FRAME / ORIGINAL_COLLISION_PASSES_PER_FRAME).toBe(2);
  });

  it("splits gravity and the ramp drive into exact per-substep adds", () => {
    // `add.w $e86(a5),d1` at +0x00B758 adds the WHOLE option word once per
    // substep, so the tick's 128 Q10 is eight adds of 16 rather than one of 128.
    expect(SUBSTEP_GRAVITY).toBe(16);
    expect(SUBSTEP_GRAVITY * ORIGINAL_SUBSTEPS_PER_FRAME).toBe(SIMULATION_GRAVITY);
    expect(SIMULATION_GRAVITY % ORIGINAL_SUBSTEPS_PER_FRAME).toBe(0);
    // The drive vectors are whole per-substep units worth 32 Q10 a tick, so
    // their eighth is exact too — `>> 3` never truncates one.
    expect(Q10_PER_ORIGINAL_ACCEL_UNIT % ORIGINAL_SUBSTEPS_PER_FRAME).toBe(0);
    expect(Q10_PER_ORIGINAL_ACCEL_UNIT / ORIGINAL_SUBSTEPS_PER_FRAME).toBe(4);
    for (const [dx, dy] of LAW_DRIVE.vectors) {
      expect((dx * Q10_PER_ORIGINAL_ACCEL_UNIT) >> 3).toBe(
        (dx * Q10_PER_ORIGINAL_ACCEL_UNIT) / 8,
      );
      expect((dy * Q10_PER_ORIGINAL_ACCEL_UNIT) >> 3).toBe(
        (dy * Q10_PER_ORIGINAL_ACCEL_UNIT) / 8,
      );
    }
  });

  it("advances a ball released from rest by 56 Q10, not by a whole tick of gravity", () => {
    // THE SIGNATURE OF THE EIGHT SUBSTEPS, and the second of the two defects
    // this round closed. `v += a; x += v` moves a ball released from rest by a
    // whole tick of gravity, 128 Q10. The machine moves by
    // 0+2+4+6+8+10+12+14 = 56 — `v_before + 0.4375*a` — because it adds an
    // eighth of the acceleration after each of eight `v >> 3` moves.
    //
    // Measured against the machine's own RAM over the 474 contact-free frames of
    // the session-4 corpus, the old rule's per-tick position error was a median
    // of exactly +76 Q10 on y and 0 on x. Over the 31-frame shooter-lane ascent
    // that is 2.3 px, which is what put HEAD a whole pixel row up the arch from
    // where the original arrives.
    const ball = createBall(1, pixelsToQ10(160), pixelsToQ10(40), 0, 0, 0);
    const set = createBallSet([ball]);
    const startY = ball.y;
    stepBalls(set, EMPTY_MAP, LAW_MATERIALS, FORCES, { ballToBall: false });
    expect(ball.y - startY).toBe(56);
    expect(ball.velocityY).toBe(SIMULATION_GRAVITY);
    // ...and the frame's gain really is the arithmetic series of the substeps.
    let sum = 0;
    for (let substep = 0; substep < ORIGINAL_SUBSTEPS_PER_FRAME; substep += 1) {
      sum += (substep * SUBSTEP_GRAVITY) >> 3;
    }
    expect(sum).toBe(56);
  });

  it("re-reads the ramp drive at every substep, not once at the tick start", () => {
    // Worth 9% of the corpus score (B8 against B0 in the sweep table: 2017
    // against 1850). A drive that changes with the row must be picked up by the
    // substeps that reach the new row, so a ball crossing the boundary gets a
    // MIXTURE of the two cells rather than eight eighths of the first.
    const rows = new Map<number, readonly [number, number]>();
    const drive: TableAcceleration = {
      tableId: TABLE,
      displayName: "fixture",
      driveAt: (_level: PlayfieldLevel, _x: number, y: number) => {
        const vector = y >= 300 ? ([0, 8] as const) : ([0, 0] as const);
        rows.set(y, vector);
        return { x: vector[0] * Q10_PER_ORIGINAL_ACCEL_UNIT, y: vector[1] * Q10_PER_ORIGINAL_ACCEL_UNIT };
      },
      vectors: [
        [0, 0],
        [0, 8],
      ],
      blocks: [],
    };
    // Starts two pixels above the boundary at 8 px a tick, so the tick crosses
    // it: the first substeps see no drive and the later ones see all of it.
    const ball = createBall(1, pixelsToQ10(160), pixelsToQ10(298), 0, 8192, 0);
    const set = createBallSet([ball]);
    stepBalls(set, EMPTY_MAP, LAW_MATERIALS, FORCES, { ballToBall: false, rampDrive: drive });
    expect(rows.size, "the drive was read at more than one row").toBeGreaterThan(1);
    const wholeTick = 8192 + SIMULATION_GRAVITY + 8 * Q10_PER_ORIGINAL_ACCEL_UNIT;
    const noDrive = 8192 + SIMULATION_GRAVITY;
    expect(ball.velocityY).toBeGreaterThan(noDrive);
    expect(ball.velocityY).toBeLessThan(wholeTick);
  });
});

// ---------------------------------------------------------------------------
// The staircase
// ---------------------------------------------------------------------------

/**
 * The reconstructed wall and the ring sets it produces, from the shipped
 * collision map (ARCH_NORMAL_DECODE section 3):
 *
 *   row the pass lands in | ring hits (bearings)         | mean | frame turns
 *   cy 109                | {1968}                       | 1968 | 14.12 deg
 *   cy 108                | {1968, 2007}                 | 1987 | 10.79 deg
 *   cy 107                | {0, 1879, 1968, 2007}        | 1975 | 17.24 deg
 *
 * `trunc((1968 + 2007) / 2) = 1987` is the whole of cold run D's 10.78 degrees:
 * ONE extra ring entry, 19 angle units of mean, 3.34 degrees of turn.
 */
describe("the arch staircase", () => {
  it("answers three different turns across the approach phase, not one", () => {
    // THE NO-WALK TEST. The shipped rule swept to first touch and then walked
    // the probe |v|/4 whole pixels ALONG THE CONTACT BEARING before reading it,
    // which drags the read two pixels into the material where the ring straddles
    // a large, approach-INDEPENDENT chunk of the face. Its answer was a FLAT
    // 15.98 degrees at every one of the 1.7 px of approach phase below. The
    // machine's rule reads the ring where the ball stands and steps.
    const answers = new Set<string>();
    for (let cy = 117.2; cy <= 118.88; cy += 0.02) {
      answers.add(turnAt(cy).toFixed(2));
    }
    expect([...answers].sort()).toEqual(["10.79", "14.13"]);
  });

  it("turns 10.79 degrees below cy 117.88525 and 14.13 above it", () => {
    // The boundary is computed from the geometry, not fitted: it is where the
    // frame's responding pass falls in row 108 rather than row 109. Asserted in
    // Q10, where it is a single unit wide — 120715 is 117.885742 px against the
    // decode's predicted 117.88525, half a Q10 unit apart.
    expect(turnAtQ10(120714).toFixed(2)).toBe("10.79");
    expect(turnAtQ10(120715).toFixed(2)).toBe("14.13");
    expect(120715 / 1024).toBeCloseTo(117.88525, 3);
    expect(turnAt(117.5).toFixed(2)).toBe("10.79");
    expect(turnAt(118.5).toFixed(2)).toBe("14.13");
    // The 14.13 band is EXACTLY one pixel wide, which is what a staircase read
    // one pixel row at a time has to be.
    expect(turnAtQ10(121738).toFixed(2)).toBe("14.13");
    expect(turnAtQ10(121739).toFixed(2)).toBe("0.00");
    expect(121739 - 120715).toBe(1024);
  });

  it("puts each session-4 cold launch on the stair its own RAM says", () => {
    // The machine's measured turns, from its own velocity words:
    //   cold A  cy 117.9619  (0,-3047) -> (-705,-2801)  14.13 deg
    //   cold B  cy 118.0947  (0,-3047) -> (-705,-2801)  14.13 deg
    //   cold D  cy 117.7197  (0,-3047) -> (-547,-2873)  10.78 deg
    //   warm    cy 117.9502  (0,-3047) -> (-708,-2813)  14.13 deg
    // Each from its OWN lane seat: the warm control was served from a carried
    // trough record and sits 1.91 px east of the three cold draws, which is the
    // whole reason it is kept.
    //
    // Two claims. First, reduced to the machine's own 16-bit word this port
    // reproduces the decode's predicted velocity EXACTLY on all four runs — the
    // model column of ARCH_NORMAL_DECODE section 1, which was computed in Python
    // from the disassembly and never saw this code. Second, that word is within
    // five units of 1/256 px per frame of what the machine's RAM actually held,
    // with no constant fitted to any of them.
    const cases: readonly (readonly [string, number, number, number, number[], number[]])[] = [
      ["coldA", 321.3672, 117.9619, 14.13, [-705, -2801], [-704, -2798]],
      ["coldB", 321.3672, 118.0947, 14.13, [-705, -2801], [-704, -2798]],
      ["coldD", 321.3672, 117.7197, 10.78, [-547, -2873], [-547, -2871]],
      ["warm", 323.2773, 117.9502, 14.13, [-708, -2813], [-707, -2808]],
    ];
    for (const [name, cx, cy, machineTurn, machine, model] of cases) {
      const ball = createBall(
        1,
        Math.round(cx * 1024),
        Math.round(cy * 1024),
        0,
        -3047 * PER_UNIT,
        1,
      );
      const set = createBallSet([ball]);
      stepBalls(set, LAW_MAP, LAW_MATERIALS, FORCES, OPTIONS);
      const turn =
        (Math.atan2(Math.abs(ball.velocityX), Math.abs(ball.velocityY)) * 180) / Math.PI;
      // The machine's word truncates toward zero; this port keeps two more bits.
      const word = [
        Math.trunc(ball.velocityX / PER_UNIT),
        Math.trunc(ball.velocityY / PER_UNIT),
      ];
      expect(turn, `${name} turn`).toBeCloseTo(machineTurn, 1);
      expect(word, `${name} against the decode's own prediction`).toEqual(model);
      expect(Math.abs(word[0]! - machine[0]!), `${name} vx`).toBeLessThanOrEqual(5);
      expect(Math.abs(word[1]! - machine[1]!), `${name} vy`).toBeLessThanOrEqual(5);
    }
  });

  /**
   * THE MODEL'S OWN FALSIFIABLE FORECAST, AND IT HOLDS.
   *
   * ARCH_NORMAL_DECODE section 11 predicted a third stair that NO RUN HAS EVER
   * PRODUCED and that no tuning of a constant could produce, because it is a
   * two-pass frame: an approach starting above cy 118.88525 puts the frame's
   * last pass at cy 110.00, where it MISSES, and the next frame's first pass
   * then opens at row 107 with a second pass behind it, for 17.24 degrees.
   *
   * Run here on the shipped map: above the boundary the frame turns nothing at
   * all and the frame after it turns 17.25. A model that predicts an unobserved
   * state to a hundredth of a degree, from geometry it was not fitted to, is
   * worth more than one fitted to what was already seen.
   */
  it("misses above cy 118.88525 and turns 17.25 degrees on the NEXT frame", () => {
    const below = launchAt(118.88525, 2);
    expect(below.turns[0] ?? 0).toBeCloseTo(14.13, 1);

    for (const cy of [118.886, 118.9, 119.0]) {
      const { turns } = launchAt(cy, 2);
      expect(turns[0] ?? -1, `cy ${cy} first frame`).toBe(0);
      expect(turns[1] ?? 0, `cy ${cy} second frame`).toBeCloseTo(17.24, 1);
    }
  });
});
