/**
 * PER-SURFACE PHYSICS: the constants the original looked up by surface id.
 *
 * ---------------------------------------------------------------------------
 * WHERE THEY COME FROM, AND WHY THE LOCATION IS CERTAIN
 * ---------------------------------------------------------------------------
 * The ball integrator copies four words into the ball record before every
 * collision response, indexed by the surface id under the contact:
 *
 *     00ae0e  lea      $0.l, a0             ; <- relocated, see below
 *     00ae14  movem.w  (a0,d2.w*8), d3-d6   ; d2 = surface id, 8 bytes a row
 *     00ae1a  movem.w  d3-d6, $34(a4)       ; -> ball $34, $36, $38, $3A
 *     00ae20  cmpi.w   #$1f, d2             ; only NOW is the id range-checked
 *     00ae24  bhi.s    +$e                  ; ids >= 32 -> device index
 *     00ae2a  move.w   $16(pc,d2.w*2), d2   ; the 32-entry table at $AE40
 *     00ae2e  jsr      $12(pc,d2.w)
 *
 * The `lea`'s operand is at +0x00AE10, and main.seg00's own relocation table
 * says offset 44560 = 0xAE10 is THE SINGLE hunk-8 relocation in the whole
 * executable (block counts, in hunk order: 981, 29, 5, 12, 104, 29, 10, 4, ONE,
 * 68, 12, 5, parsing to byte 58444 of a 58448-byte file). So the base is
 * main.seg08, whose body is exactly 2048 bytes = 256 rows of four words, and
 * hunk 8 is referenced from nowhere else at all.
 *
 * It is 256 entries and not 32: the `movem.w` runs BEFORE the range check, so
 * every id 0..255 selects a row. Ids above 31 that carry a device therefore also
 * carry a material, and ids above 31 with no device — Law 'n Justice's 128/129,
 * BabeWatch's 64 — are PURE MATERIAL SELECTORS.
 *
 * The 2048 bytes contain exactly EIGHT distinct rows, and their boundaries land
 * precisely on the id semantics the engine's own jump table at +0x00AE40 gives
 * (1..4 flippers, 10..11 level change, 16..21 bumpers, 22..31 slingshots). A
 * misidentified table cannot produce that alignment, and the third word is
 * always a round multiple of 256 besides.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FOUR WORDS ARE, READ OUT OF THE RESPONDER AT +0x00B54C
 * ---------------------------------------------------------------------------
 *   $34  GRAZING LIMIT.  d1 = |(vt << 4) / vn|; `cmp.w $34(a4),d1 / blt` — a
 *        contact shallower than atan(w0/16) off the surface is cancelled
 *        outright and the ball slides on.
 *   $36  RESTITUTION x 1/256.  `muls.w $36(a4),d0 / asr.l #8,d0` at +0x00B620.
 *   $38  MINIMUM NORMAL IMPACT VELOCITY, stored negative. `cmp.w $38(a4),d0 /
 *        blt` — the ball only bounces when it is coming in faster than this.
 *   $3A  SPIN/FRICTION DIVISOR.  `d3 = ((spin - vt) << 8) / $3A; vt += d3*5>>3;
 *        spin -= d3` at +0x00B626..+0x00B640. Friction on SLIP, not on speed.
 *
 * ---------------------------------------------------------------------------
 * WHICH OF THEM THIS PORT ADOPTS, AND WHY THE OTHER TWO ARE LEFT ON THE PAGE
 * ---------------------------------------------------------------------------
 * ADOPTED: $36, the restitution. It is a pure RATIO, so it crosses between the
 * two velocity scales exactly and needs no bridge: Q10 elasticity = w1 * 4,
 * because Q10_ONE/256 = 4. Every `elasticity` this module answers is that
 * number and is `"measured"`.
 *
 * NOT ADOPTED, and this is a result rather than an omission:
 *
 *   $3A IS NOT A FRICTION COEFFICIENT THIS PORT CAN HOLD. The original's
 *   tangential rule is a fraction of the SLIP between the ball's spin and its
 *   along-surface speed, so a ball rolling without slipping loses nothing and no
 *   slope, however shallow, can ever hold a ball. `BallState` has no spin, and
 *   dropping the spin term turns the rule into a percentage of the whole
 *   tangential speed — which `reflectVelocity` already measured and rejected,
 *   because it caps a ball on a slope at `g*sin(theta)/f` instead of letting it
 *   accelerate. So `WALL_FRICTION` stays what it is: a coefficient of THIS
 *   model, chosen, and still labelled provisional. The negative is the finding —
 *   there is no per-surface friction number in the original to import.
 *
 *   $34 AND $38 ARE PARAMETERS OF A DIFFERENT CONTACT MODEL. The original
 *   evaluates one bounce per collision pass against a mean normal and uses those
 *   two words to decide whether that single event counts at all. This port
 *   sweeps to first contact, resolves up to eight contacts a tick, and has its
 *   own `restThreshold` doing $38's job on a different velocity scale. Importing
 *   two words of one model into another is not measurement, it is mixing, so
 *   they are recorded here in full and applied nowhere. Anyone who later gives
 *   the ball a spin state should come back for all four at once.
 *
 * ---------------------------------------------------------------------------
 * THE VELOCITY BRIDGE, WHICH IS INHERITED RATHER THAN CHOSEN
 * ---------------------------------------------------------------------------
 * The bumper and slingshot kicks below ARE velocities, so they do need a bridge,
 * and the project already has exactly one: `table-accel.ts` fixes 1 original
 * acceleration unit per substep = `TICKS_PER_ORIGINAL_UNIT` (6) Q10 per tick
 * by matching the original's shipped gravity of 4-per-substep-times-8-substeps
 * against this port's `PLUNGER_REFERENCE_GRAVITY`. Eight substeps of one unit is
 * eight original VELOCITY units, so one original velocity unit is 6/8 = 0.75
 * Q10, and that is the conversion used here. It is derived from the same
 * constant as the ramp drive so the two can never drift apart.
 *
 * Worked: the bumper's 5500 becomes 4125 Q10/tick, which against a gravity of 24
 * Q10/tick throws a ball 4125^2 / (2*24) = 354,000 Q10 = 346 px up the table.
 * That is the right order for a pop bumper on a 600-row playfield. The other
 * candidate bridge — matching POSITION, since the original moves the ball by
 * v/2 eight times a frame and so travels 4v per frame against this port's v —
 * gives 22,000 Q10/tick and a height of 9,800 px, sixteen tables. The port's own
 * gravity is what makes the difference, and the acceleration bridge is the one
 * the shipped ramp drive is already calibrated to.
 */

import type { Q10 } from "../core/fixed-point.js";
import { ORIGINAL_SUBSTEPS_PER_FRAME, TICKS_PER_ORIGINAL_UNIT } from "./table-accel.js";

/**
 * Converts one of the original's VELOCITY words to Q10 per tick.
 *
 * Truncating rather than rounding, so the result is a function of the integers
 * and nothing here depends on a floating-point mode.
 */
export function originalVelocityToQ10(units: number): Q10 {
  return Math.trunc((units * TICKS_PER_ORIGINAL_UNIT) / ORIGINAL_SUBSTEPS_PER_FRAME);
}

/** Q10 restitution from the original's `$36` word: `Q10_ONE / 256` is 4. */
export function originalRestitutionToQ10(word: number): Q10 {
  return word * 4;
}

// ---------------------------------------------------------------------------
// Surface id semantics, from the 32-entry jump table at main.seg00 +0x00AE40
// ---------------------------------------------------------------------------
//
// Read from the raw bytes rather than from a disassembler, because Capstone
// mis-renders the scale on `move.w $16(pc,d2.w*2),d2` (extension word 0x2216 is
// D2, word, scale x2). At x2 the table is 32 clean entries:
//
//   0        FFF0  do nothing              16..21   03D6  bumper 1..6
//   1..4     0040 0046 0050 005A flippers  22,24,..30 03E6 slingshot, +400
//   5..9     FFF0                          23,25,..31 03EE slingshot, -400
//   10       0420  move ball to UPPER      12..15   FFF0
//   11       0408  move ball to LOWER
//
// and at x1 it is garbage. The bumper handler at +0x00B216 does
// `subi.w #$0F,d3 / move.b d3,$4(a4)`, so bumper index = id - 15; the slingshot
// handler at +0x00B234 does `subi.w #$16,d3 / lsr.w #1,d3`, so slingshot index =
// ((id - 22) >> 1) + 1.

export const SURFACE_ID_NONE = 0;
export const FLIPPER_ID_MIN = 1;
export const FLIPPER_ID_MAX = 4;
export const LEVEL_TO_UPPER_ID = 10;
export const LEVEL_TO_LOWER_ID = 11;
export const BUMPER_ID_MIN = 16;
export const BUMPER_ID_MAX = 21;
export const SLINGSHOT_ID_MIN = 22;
export const SLINGSHOT_ID_MAX = 31;
/** Ids at or above this index the per-level device array: `index = id - 32`. */
export const DEVICE_ID_BASE = 32;

export function isBumperId(id: number): boolean {
  return id >= BUMPER_ID_MIN && id <= BUMPER_ID_MAX;
}

export function isSlingshotId(id: number): boolean {
  return id >= SLINGSHOT_ID_MIN && id <= SLINGSHOT_ID_MAX;
}

/** 1..6, the `$4(a4)` the collision responder indexes the bumper list with. */
export function bumperIndexOf(id: number): number {
  return id - (BUMPER_ID_MIN - 1);
}

/** 1..5, the `$5(a4)` the collision responder indexes the slingshot list with. */
export function slingshotIndexOf(id: number): number {
  return ((id - SLINGSHOT_ID_MIN) >> 1) + 1;
}

// ---------------------------------------------------------------------------
// The kicks
// ---------------------------------------------------------------------------
//
//   00b57a  move.b   $4(a4), d3          ; bumper index, 0 = not a bumper
//   00b582  cmpi.w   #$ffce, d0          ; needs an inward normal speed <= -50
//   00b588  subi.w   #$157c, d0          ; 5500 more inward, before restitution
//
//   00b5d6  move.b   $5(a4), d3          ; slingshot index
//   00b5da  cmpi.w   #$ff9c, d0          ; needs <= -100
//   00b5e0  subi.w   #$dac, d0           ; 3500 more inward
//   00b5e4  add.w    $6(a4), d2          ; and +-400 ALONG the surface
//
// Both go in before the `muls.w $36(a4)` at +0x00B620, so the original scales
// the kick by the surface's own restitution. That is reproduced.

/** Inward normal speed a bumper needs before it fires, in Q10 per tick. */
export const BUMPER_KICK_THRESHOLD: Q10 = originalVelocityToQ10(50);
/** Added to the inward normal speed before restitution. */
export const BUMPER_KICK: Q10 = originalVelocityToQ10(5500);
export const SLINGSHOT_KICK_THRESHOLD: Q10 = originalVelocityToQ10(100);
export const SLINGSHOT_KICK: Q10 = originalVelocityToQ10(3500);
/**
 * The slingshot's along-surface push. EVEN ids get +400 and ODD ids -400 — the
 * jump table sends 22, 24, 26, 28, 30 to +0x00B226 (`move.w #$190,$6(a4)`) and
 * 23, 25, 27, 29, 31 to +0x00B22E (`move.w #$FE70,$6(a4)`). A slingshot is two
 * ids, one per face, and the sign is which way that face throws.
 */
export const SLINGSHOT_TANGENT_KICK: Q10 = originalVelocityToQ10(400);

/** +1 or -1: which way along the surface this slingshot face throws. */
export function slingshotTangentSign(id: number): number {
  return id % 2 === 0 ? 1 : -1;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/** One row of main.seg08, exactly as the four words read. */
export interface SurfaceConstants {
  /** `$34` grazing limit, in sixteenths of a tangent. Recorded, not applied. */
  readonly grazeLimit: number;
  /** `$36` restitution, 1/256ths. */
  readonly restitution: number;
  /** `$38` minimum normal impact velocity, negative. Recorded, not applied. */
  readonly minImpact: number;
  /** `$3A` spin/friction divisor. Recorded, not applied — see the header. */
  readonly slipDivisor: number;
  /** Ids this row governs, as inclusive ranges. */
  readonly ids: readonly (readonly [number, number])[];
}

/**
 * The eight distinct rows of main.seg08, and the ids each governs.
 *
 * Typed out rather than shipped as an asset because it is thirty-two numbers of
 * shared-engine constant, not per-table data — the same table serves all three
 * playfields — and because `materials.ts` has always been where this project
 * keeps its coefficients. `tests/surface-physics.test.ts` re-derives the id
 * assignment and asserts every id 0..255 is covered exactly once.
 */
export const SURFACE_CONSTANT_ROWS: readonly SurfaceConstants[] = Object.freeze([
  // Plain wall. The commonest row by far, and the one that replaces
  // WALL_ELASTICITY: 76/256 = 0.297, where this project had been using 0.625.
  Object.freeze({
    grazeLimit: 34,
    restitution: 76,
    minImpact: -800,
    slipDivisor: 21760,
    ids: Object.freeze([
      Object.freeze([0, 0] as const),
      Object.freeze([5, 8] as const),
      Object.freeze([13, 13] as const),
      Object.freeze([64, 127] as const),
      Object.freeze([192, 255] as const),
    ]),
  }),
  // The four flipper ids. Their pixels are the bats' swept footprint rather than
  // a wall, and `flippers.ts` resolves bat contacts itself, so this row is
  // decoded and recorded but never reached by the contact path.
  Object.freeze({
    grazeLimit: 24,
    restitution: 115,
    minImpact: -800,
    slipDivisor: 12800,
    ids: Object.freeze([Object.freeze([1, 4] as const)]),
  }),
  Object.freeze({
    grazeLimit: 60,
    restitution: 102,
    minImpact: -200,
    slipDivisor: 23040,
    ids: Object.freeze([Object.freeze([9, 9] as const)]),
  }),
  // The two level-change ids. Restitution 2/256 = 0.008: the original does not
  // want a ball bouncing off the thing that hands it to the other playfield.
  Object.freeze({
    grazeLimit: 34,
    restitution: 2,
    minImpact: -2000,
    slipDivisor: 5120,
    ids: Object.freeze([Object.freeze([10, 11] as const)]),
  }),
  Object.freeze({
    grazeLimit: 34,
    restitution: 115,
    minImpact: -400,
    slipDivisor: 19200,
    ids: Object.freeze([Object.freeze([12, 12] as const)]),
  }),
  Object.freeze({
    grazeLimit: 34,
    restitution: 89,
    minImpact: -400,
    slipDivisor: 19200,
    ids: Object.freeze([Object.freeze([14, 14] as const), Object.freeze([128, 191] as const)]),
  }),
  // Rubber. Id 15 is the posts and rings, and 22..31 the slingshot faces; ids
  // 32..63 are the target and trigger devices, which are rubber-faced too.
  Object.freeze({
    grazeLimit: 34,
    restitution: 153,
    minImpact: -200,
    slipDivisor: 5120,
    ids: Object.freeze([Object.freeze([15, 15] as const), Object.freeze([22, 63] as const)]),
  }),
  // The bumpers, and the only row whose minimum impact is zero: a pop bumper
  // fires however gently it is touched.
  Object.freeze({
    grazeLimit: 34,
    restitution: 89,
    minImpact: 0,
    slipDivisor: 19200,
    ids: Object.freeze([Object.freeze([16, 21] as const)]),
  }),
]);

/** How a surface responds, in this port's units. */
export interface SurfaceResponse {
  readonly surfaceId: number;
  /** Restitution in Q10, measured. */
  readonly elasticity: Q10;
  /** Added to the inward normal speed before restitution; 0 for a plain wall. */
  readonly kick: Q10;
  /** Inward normal speed the kick needs before it fires. */
  readonly kickThreshold: Q10;
  /** Along-surface push, signed. Slingshots only. */
  readonly tangentKick: Q10;
  readonly constants: SurfaceConstants;
}

function buildTable(): readonly SurfaceResponse[] {
  const rows: (SurfaceConstants | undefined)[] = new Array<SurfaceConstants | undefined>(256);
  for (const row of SURFACE_CONSTANT_ROWS) {
    for (const [lo, hi] of row.ids) {
      for (let id = lo; id <= hi; id += 1) {
        if (rows[id] !== undefined) {
          throw new Error(`surface id ${id} is claimed by two rows of SURFACE_CONSTANT_ROWS`);
        }
        rows[id] = row;
      }
    }
  }
  const out: SurfaceResponse[] = [];
  for (let id = 0; id < 256; id += 1) {
    const row = rows[id];
    if (row === undefined) {
      throw new Error(`surface id ${id} has no row in SURFACE_CONSTANT_ROWS`);
    }
    const bumper = isBumperId(id);
    const slingshot = isSlingshotId(id);
    out.push(
      Object.freeze({
        surfaceId: id,
        elasticity: originalRestitutionToQ10(row.restitution),
        kick: bumper ? BUMPER_KICK : slingshot ? SLINGSHOT_KICK : 0,
        kickThreshold: bumper
          ? BUMPER_KICK_THRESHOLD
          : slingshot
            ? SLINGSHOT_KICK_THRESHOLD
            : 0,
        tangentKick: slingshot ? SLINGSHOT_TANGENT_KICK * slingshotTangentSign(id) : 0,
        constants: row,
      }),
    );
  }
  return Object.freeze(out);
}

const TABLE = buildTable();

/** The response for one surface id. Throws outside 0..255: the map is bytes. */
export function surfaceResponseFor(id: number): SurfaceResponse {
  const found = TABLE[id];
  if (found === undefined) {
    throw new RangeError(`surface id ${id} is outside the 256-entry table`);
  }
  return found;
}

/** Every id's response, for tests and tooling. */
export function surfaceResponses(): readonly SurfaceResponse[] {
  return TABLE;
}
