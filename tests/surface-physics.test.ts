/**
 * The 256-row per-surface constant table, and what this port takes from it.
 *
 * These are contracts on DECODED DATA, so almost everything here is an equality
 * rather than a band. The one thing that would make the table useless is a
 * silent edit to a coefficient, and a range check would not catch one.
 */

import { describe, expect, it } from "vitest";
import {
  BUMPER_ID_MAX,
  BUMPER_ID_MIN,
  BUMPER_KICK,
  BUMPER_KICK_THRESHOLD,
  DEVICE_ID_BASE,
  FLIPPER_ID_MAX,
  FLIPPER_ID_MIN,
  LEVEL_TO_LOWER_ID,
  LEVEL_TO_UPPER_ID,
  RESPONDER_VELOCITY_SCALE,
  SLINGSHOT_ID_MAX,
  SLINGSHOT_ID_MIN,
  SLINGSHOT_KICK,
  SLINGSHOT_KICK_THRESHOLD,
  SLINGSHOT_TANGENT_KICK,
  SURFACE_CONSTANT_ROWS,
  bumperIndexOf,
  isBumperId,
  isSlingshotId,
  originalRestitutionToQ10,
  originalVelocityToQ10,
  slingshotIndexOf,
  slingshotTangentSign,
  surfaceResponseFor,
  surfaceResponses,
} from "../src/game/surface-physics.js";
import { DEVICE_PRESETS, WALL_ELASTICITY, WALL_FRICTION } from "../src/game/materials.js";
import { ORIGINAL_SUBSTEPS_PER_FRAME, TICKS_PER_ORIGINAL_UNIT } from "../src/game/table-accel.js";

const Q10_ONE = 1024;

describe("the table covers every id exactly once", () => {
  it("has 256 rows and no id claimed twice or missed", () => {
    // `buildTable` throws on either fault, so reaching this point is half the
    // assertion; the other half is that the module really answers for all 256.
    const responses = surfaceResponses();
    expect(responses).toHaveLength(256);
    for (let id = 0; id < 256; id += 1) {
      expect(surfaceResponseFor(id).surfaceId).toBe(id);
    }
  });

  it("refuses an id outside a byte, because the map is bytes", () => {
    expect(() => surfaceResponseFor(256)).toThrow(RangeError);
    expect(() => surfaceResponseFor(-1)).toThrow(RangeError);
  });

  it("has exactly the eight distinct rows main.seg08 contains", () => {
    expect(SURFACE_CONSTANT_ROWS).toHaveLength(8);
    const seen = new Set(
      SURFACE_CONSTANT_ROWS.map(
        (row) => `${row.grazeLimit},${row.restitution},${row.minImpact},${row.slipDivisor}`,
      ),
    );
    expect(seen.size).toBe(8);
  });

  it("keeps every word of every row exactly as it was read", () => {
    // A change detector, deliberately, and the only kind that is right for a
    // decoded table: these thirty-two numbers are the file's contents.
    const rows = SURFACE_CONSTANT_ROWS.map((row) => [
      row.grazeLimit,
      row.restitution,
      row.minImpact,
      row.slipDivisor,
    ]);
    expect(rows).toEqual([
      [34, 76, -800, 21760],
      [24, 115, -800, 12800],
      [60, 102, -200, 23040],
      [34, 2, -2000, 5120],
      [34, 115, -400, 19200],
      [34, 89, -400, 19200],
      [34, 153, -200, 5120],
      [34, 89, 0, 19200],
    ]);
  });
});

describe("the row boundaries land on the engine's own id semantics", () => {
  it("gives all four flipper ids one row and nothing else that row", () => {
    const flipper = surfaceResponseFor(FLIPPER_ID_MIN).constants;
    for (let id = FLIPPER_ID_MIN; id <= FLIPPER_ID_MAX; id += 1) {
      expect(surfaceResponseFor(id).constants).toBe(flipper);
    }
    expect(surfaceResponseFor(FLIPPER_ID_MIN - 1).constants).not.toBe(flipper);
    expect(surfaceResponseFor(FLIPPER_ID_MAX + 1).constants).not.toBe(flipper);
  });

  it("gives both level-change ids one row, and it is the one that does not bounce", () => {
    const change = surfaceResponseFor(LEVEL_TO_UPPER_ID).constants;
    expect(surfaceResponseFor(LEVEL_TO_LOWER_ID).constants).toBe(change);
    // 2/256. The original does not want a ball bouncing off the thing that hands
    // it to the other playfield.
    expect(change.restitution).toBe(2);
    expect(surfaceResponseFor(LEVEL_TO_LOWER_ID + 1).constants).not.toBe(change);
  });

  it("gives all six bumper ids one row, and it is the only row with no minimum impact", () => {
    const bumper = surfaceResponseFor(BUMPER_ID_MIN).constants;
    for (let id = BUMPER_ID_MIN; id <= BUMPER_ID_MAX; id += 1) {
      expect(surfaceResponseFor(id).constants).toBe(bumper);
    }
    expect(bumper.minImpact).toBe(0);
    for (const row of SURFACE_CONSTANT_ROWS) {
      if (row !== bumper) expect(row.minImpact).toBeLessThan(0);
    }
  });

  it("puts every slingshot face on the rubber row, with id 15", () => {
    const rubber = surfaceResponseFor(15).constants;
    for (let id = SLINGSHOT_ID_MIN; id <= SLINGSHOT_ID_MAX; id += 1) {
      expect(surfaceResponseFor(id).constants).toBe(rubber);
    }
    // The bounciest thing in the game, and still well under a perfect bounce.
    expect(rubber.restitution).toBe(153);
    for (const row of SURFACE_CONSTANT_ROWS) {
      expect(row.restitution).toBeLessThanOrEqual(rubber.restitution);
      expect(originalRestitutionToQ10(row.restitution)).toBeLessThan(Q10_ONE);
    }
  });
});

describe("indexing, as the collision responder does it", () => {
  it("maps bumper ids to 1..6 and nothing else", () => {
    expect(isBumperId(BUMPER_ID_MIN - 1)).toBe(false);
    expect(isBumperId(BUMPER_ID_MAX + 1)).toBe(false);
    expect(bumperIndexOf(BUMPER_ID_MIN)).toBe(1);
    expect(bumperIndexOf(BUMPER_ID_MAX)).toBe(6);
  });

  it("maps a PAIR of slingshot ids to each of 1..5", () => {
    // `subi.w #$16,d3 / lsr.w #1,d3` — two ids per slingshot, one per face.
    expect(isSlingshotId(SLINGSHOT_ID_MIN - 1)).toBe(false);
    expect(isSlingshotId(SLINGSHOT_ID_MAX + 1)).toBe(false);
    expect(slingshotIndexOf(22)).toBe(1);
    expect(slingshotIndexOf(23)).toBe(1);
    expect(slingshotIndexOf(24)).toBe(2);
    expect(slingshotIndexOf(SLINGSHOT_ID_MAX)).toBe(5);
  });

  it("throws the two faces of one slingshot in opposite directions", () => {
    for (let id = SLINGSHOT_ID_MIN; id <= SLINGSHOT_ID_MAX; id += 2) {
      expect(slingshotTangentSign(id)).toBe(1);
      expect(slingshotTangentSign(id + 1)).toBe(-1);
      expect(surfaceResponseFor(id).tangentKick).toBe(-surfaceResponseFor(id + 1).tangentKick);
    }
  });

  it("gives a kick to powered ids and to nothing else", () => {
    for (let id = 0; id < 256; id += 1) {
      const response = surfaceResponseFor(id);
      const powered = isBumperId(id) || isSlingshotId(id);
      expect(response.kick > 0).toBe(powered);
      expect(response.kickThreshold > 0).toBe(powered);
      expect(response.tangentKick !== 0).toBe(isSlingshotId(id));
    }
  });
});

describe("the unit bridges", () => {
  it("scales restitution by exactly Q10_ONE / 256", () => {
    expect(originalRestitutionToQ10(256)).toBe(Q10_ONE);
    expect(originalRestitutionToQ10(76)).toBe(304);
  });

  it("takes the velocity bridge from the ramp drive's own constants", () => {
    // Derived rather than restated, so the two can never drift: one original
    // acceleration unit per substep is TICKS_PER_ORIGINAL_UNIT Q10 per tick, and
    // a frame is ORIGINAL_SUBSTEPS_PER_FRAME substeps.
    expect(originalVelocityToQ10(ORIGINAL_SUBSTEPS_PER_FRAME)).toBe(TICKS_PER_ORIGINAL_UNIT);
    // AND THE RESPONDER'S OWN CONSTANTS ARE HALVED ON TOP OF IT. `subi.w #$157c`
    // and `subi.w #$dac` are written inside a contact frame whose forward
    // rotation has a gain of 2 (+0x00B50A muls x16384, +0x00B520 asl.l #3,
    // +0x00B524 swap) and whose inverse has a gain of 1/2 (+0x00B66A muls,
    // +0x00B680 swap, +0x00B684 rol.l #1), so each reads at twice the scale of
    // the ball's own velocity words. Pinned as the raw operand over the scale so
    // the disassembly stays visible in the failure message.
    expect(RESPONDER_VELOCITY_SCALE).toBe(2);
    expect(BUMPER_KICK).toBe(originalVelocityToQ10(5500 / RESPONDER_VELOCITY_SCALE));
    expect(SLINGSHOT_KICK).toBe(originalVelocityToQ10(3500 / RESPONDER_VELOCITY_SCALE));
    expect(SLINGSHOT_TANGENT_KICK).toBe(originalVelocityToQ10(400 / RESPONDER_VELOCITY_SCALE));
    expect(BUMPER_KICK_THRESHOLD).toBe(originalVelocityToQ10(50 / RESPONDER_VELOCITY_SCALE));
    expect(SLINGSHOT_KICK_THRESHOLD).toBe(originalVelocityToQ10(100 / RESPONDER_VELOCITY_SCALE));
    // Spelt out once in Q10 as well, because these five numbers are what every
    // filmed slingshot and bumper exit in the acceptance table is measured from.
    expect([BUMPER_KICK, SLINGSHOT_KICK, SLINGSHOT_TANGENT_KICK]).toEqual([11000, 7000, 800]);
  });

  it("makes a pop bumper harder than a slingshot, as the two subi operands do", () => {
    expect(BUMPER_KICK).toBeGreaterThan(SLINGSHOT_KICK);
    expect(SLINGSHOT_KICK).toBeGreaterThan(SLINGSHOT_TANGENT_KICK);
  });
});

describe("materials.ts agrees with the table it now takes its numbers from", () => {
  it("uses the measured plain wall as its fallback restitution", () => {
    expect(WALL_ELASTICITY).toBe(surfaceResponseFor(0).elasticity);
    expect(WALL_ELASTICITY).toBe(originalRestitutionToQ10(76));
  });

  it("restates the rubber, slingshot and bumper rows without changing them", () => {
    expect(DEVICE_PRESETS["rubber"]?.elasticity).toBe(surfaceResponseFor(15).elasticity);
    expect(DEVICE_PRESETS["slingshot"]?.elasticity).toBe(surfaceResponseFor(22).elasticity);
    expect(DEVICE_PRESETS["slingshot"]?.kick).toBe(surfaceResponseFor(22).kick);
    expect(DEVICE_PRESETS["bumper"]?.elasticity).toBe(surfaceResponseFor(16).elasticity);
    expect(DEVICE_PRESETS["bumper"]?.kick).toBe(surfaceResponseFor(16).kick);
  });

  it("still labels friction as this port's own, because there is none to import", () => {
    // The negative result, pinned so it cannot quietly become a claim: the
    // original's fourth word is a SLIP divisor and needs a spin state this
    // simulation does not have. Every row carries one and none of them is used.
    for (const row of SURFACE_CONSTANT_ROWS) expect(row.slipDivisor).toBeGreaterThan(0);
    for (const preset of Object.values(DEVICE_PRESETS)) {
      expect(preset.friction).toBe(WALL_FRICTION);
    }
  });

  it("keeps the device ids' base where the array index says it is", () => {
    expect(DEVICE_ID_BASE).toBe(32);
  });
});
