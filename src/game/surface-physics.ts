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
 * WHICH OF THEM THIS PORT ADOPTS — THREE OF THE FOUR, SINCE ROUND 5
 * ---------------------------------------------------------------------------
 * ADOPTED: $36, the restitution. It is a pure RATIO, so it crosses between the
 * two velocity scales exactly and needs no bridge: Q10 elasticity = w1 * 4,
 * because Q10_ONE/256 = 4. Every `elasticity` this module answers is that
 * number and is `"measured"`.
 *
 * ADOPTED IN ROUND 5, on film evidence: $34 and $3A, both consumed by
 * `reflectVelocity` and both only on maps that HAVE a surface layer, so the
 * synthetic-map contact model the physics tests measure is untouched.
 *
 *   $34, THE GRAZE GATE. The responder cancels any contact shallower than
 *   atan(16/$34) off the surface — no restitution, no slip, the ball slides
 *   on. This port used to resolve every oblique ring contact with full
 *   restitution plus Coulomb friction, losing 15-48% per graze that the
 *   original loses nothing on; the filmed consequences (a launched BabeWatch
 *   ball dying 180 px under the top corridor it crosses on film, Law 'n
 *   Justice's apron carom kept at 52% against a filmed 85%) are the ROUND 5
 *   scoring defect, because the natural paths never reached the award sites.
 *
 *   $3A, THE SLIP RULE, adopted in its spinless limit: with no spin state the
 *   `5*256/(8*$3A)` fraction of the slip becomes `tangent * 160 / $3A` per
 *   bounce — the MOST the rule can take, 0.74% on a plain wall — and it
 *   replaces the Coulomb bite. It replaces it on EVERY surface contact,
 *   resting ones included, and that is not a simplification: +0x00B626 is
 *   where all four outcomes converge and it is not gated on anything at all.
 *   A future spin state should still come back for the exchange half
 *   (spin -= what the surface hands the ball).
 *
 *   ROUND 5 SHIPPED THIS HEADER SAYING "resting contacts keep the
 *   Coulomb-capped rolling rule `reflectVelocity` derived in round 3", and the
 *   code it shipped beside it did not: `drop` tests `surface !== null` before
 *   it tests `resting`, so on all three shipped tables — every one of which
 *   has a surface layer — the resting branch was unreachable. Round 6 kept the
 *   CODE and corrected the SENTENCE, because the disassembly is on the code's
 *   side. The round-3 rolling rule survives where it is still the only rule
 *   there is: on a synthetic map with no surface layer, which is what every
 *   physics unit test measures.
 *
 * NOT ADOPTED: $38, the minimum normal impact. Decoded and recorded as
 * `minImpact`; the branch is `cmp.w $38(a4),d0 / blt.b $b57a` at +0x00B56E and
 * its fall-through is `moveq #0,d0 / bra.w $b626`, i.e. a contact softer than
 * the row's minimum is killed exactly as a graze is — no bounce, no coil, slip
 * only. This port's `restThreshold` gates the same event on its own velocity
 * scale and carrying both would gate it twice. The two are not equivalent and
 * the difference is recorded rather than hidden: on the plain-wall row `$38` is
 * -800 responder units = 1.56 px/tick of approach, where `restThreshold`
 * (853 Q10 on the OUTGOING bounce, so 2.80 px/tick of approach at that row's
 * restitution) is nearly twice as strict; on the bumper row `$38` is 0, so the
 * original's pop bumper fires however gently it is touched. Adopting `$38`
 * needs a before-and-after census, not a patch.
 *
 * ---------------------------------------------------------------------------
 * THE VELOCITY BRIDGE, WHICH WAS INHERITED, CIRCULAR AND WRONG
 * ---------------------------------------------------------------------------
 * The bumper and slingshot kicks below ARE velocities, so they need a bridge.
 * This file used to build one out of `table-accel.ts`'s
 * `TICKS_PER_ORIGINAL_UNIT` (then 6), reasoning that eight substeps of one
 * acceleration unit is eight velocity units and so one velocity unit is 6/8 =
 * 0.75 Q10 per tick. Every step of that is sound and the answer was still wrong,
 * because the constant it started from had itself been solved for out of this
 * port's inherited gravity of 24 rather than measured. The two bridges agreed
 * with each other and both were 16/3 too small; that mutual consistency is
 * exactly why nothing here ever caught it.
 *
 * The bridge is now measured, in `timebase.ts`, from the original's integrator:
 * eight substeps of `pos += v>>1` means ONE ORIGINAL VELOCITY UNIT IS FOUR Q10
 * PER TICK. The kicks below are therefore 5.33x what they were.
 *
 * Worked, and it is the disproof of the old bridge rather than a restatement of
 * it: at 0.75 Q10 the slingshot's 3500 units became 2625 Q10/tick, which against
 * the old gravity of 24 throws a ball 2625^2/(2*24) = 143,000 Q10 = 3987 px up
 * the table — six and a half table lengths. The bridge itself is unchanged by
 * the responder-scale correction below; what changes is that 3500 is 1750 in
 * the ball's units, so the kick is 7,000 Q10 and the EXIT it produces — the
 * kick is scaled by the row's own restitution at +0x00B620 before the ball
 * ever sees it — is `0.598 * 7000 = 4184 Q10 = 4.09 px/tick`, which lifts a
 * ball 4184^2/(2*128) = 68,400 Q10 = 67 px. The pop bumper's 5500 is 2750 =
 * 11,000 Q10, exiting at `0.348 * 11000 = 3824 Q10 = 3.73 px/tick` for 56 px
 * of rise. Both sit inside the film: Law 'n Justice's four measured slingshot
 * exits are 4.85 to 8.41 game px/frame, all above the 4.09 floor, and the
 * three-bumper cluster's filmed rattle exits at or under 6 px/f, which the
 * 3.73 floor allows and a 7.47 floor does not.
 */

import type { Q10 } from "../core/fixed-point.js";
import { ORIGINAL_SUBSTEPS_PER_FRAME, originalVelocityToQ10 } from "./timebase.js";

export { originalVelocityToQ10, ORIGINAL_SUBSTEPS_PER_FRAME };

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
//   00b5e6  add.w    $6(a4), d2          ; and +-400 ALONG the surface
//
// Both go in before the `muls.w $36(a4)` at +0x00B620, so the original scales
// the kick by the surface's own restitution. That is reproduced.
//
// ---------------------------------------------------------------------------
// AND EVERY ONE OF THEM READS AT TWICE THE BALL'S OWN VELOCITY SCALE
// ---------------------------------------------------------------------------
// ROUND 6, and it is the same doubled contact frame `flippers.ts` already
// accounts for in the flipper impulse. The responder rotates the ball's
// velocity into the contact frame and back with tables at scale 16384 —
// `cos` at main.seg01+0x4B8 and `sin` at +0xB8, both reached through the two
// hunk-1 relocations at main.seg00 offsets 0xB4BC and 0xB4C2 — and the two
// halves of the rotation are NOT inverse in gain:
//
//   FORWARD  +0x00B50A  muls.w (a0,d4.w*2),d0   ; x 16384
//            +0x00B520  asl.l  #3, d0           ; x 8
//            +0x00B524  swap   d0               ; >> 16    => NET x2
//
//   REVERSE  +0x00B66A  muls.w (a0,d4.w*2),d0   ; x 16384
//            +0x00B680  swap   d2               ; >> 16
//            +0x00B684  rol.l  #1, d2           ; x 2      => NET / 2
//
// The pair round-trips exactly, which is why nothing here ever looked wrong.
// But every constant the responder COMPARES TO or ADDS TO `d0`/`d2` lives
// between those two operations, so each is written at twice the scale the
// ball's own `$0E/$10` velocity words use. `RESPONDER_VELOCITY_SCALE` is that
// factor, and the raw disassembly numbers are kept beside each constant so the
// citation survives the correction.
//
// WHAT IS AND IS NOT AFFECTED. Affected: the two kicks, the two kick
// thresholds, the tangential throw, `$38`'s minimum approach, and the `+1` of
// the per-contact decay. UNAFFECTED, because they are dimensionless and the
// two scales cancel: `$34` (a ratio), `$36` (a ratio), `$3A` (the slip is
// `(spin - vt)` over it, both doubled), and the `16` of the graze divide.
//
// THE CONTROL THAT PROVES THE BRIDGE IN `timebase.ts` IS STILL RIGHT. The
// plunger kick is `subi.w #$1770,$10(a0)` at +0x00663A, written straight onto
// the ball's own velocity word OUTSIDE the rotation. It is therefore NOT
// doubled, and it needs no correction: 6000 units clamps to 4095 = 15.996
// px/frame against the film's measured 14.85-15.80 px/f lane ascent
// (research\view\fixround\INDEX.txt line 53). Same class of constant, applied
// on the other side of the rotation, and the film agrees with it untouched.
// One original velocity unit is still four Q10 per tick.
export const RESPONDER_VELOCITY_SCALE = 2;

/** Inward normal speed a bumper needs before it fires, in Q10 per tick. */
export const BUMPER_KICK_THRESHOLD: Q10 = originalVelocityToQ10(50 / RESPONDER_VELOCITY_SCALE);
/** Added to the inward normal speed before restitution. */
export const BUMPER_KICK: Q10 = originalVelocityToQ10(5500 / RESPONDER_VELOCITY_SCALE);
export const SLINGSHOT_KICK_THRESHOLD: Q10 = originalVelocityToQ10(100 / RESPONDER_VELOCITY_SCALE);
export const SLINGSHOT_KICK: Q10 = originalVelocityToQ10(3500 / RESPONDER_VELOCITY_SCALE);
/**
 * The slingshot's along-surface push. EVEN ids get +400 and ODD ids -400 — the
 * jump table sends 22, 24, 26, 28, 30 to +0x00B226 (`move.w #$190,$6(a4)`) and
 * 23, 25, 27, 29, 31 to +0x00B22E (`move.w #$FE70,$6(a4)`). A slingshot is two
 * ids, one per face, and the sign is which way that face throws.
 */
export const SLINGSHOT_TANGENT_KICK: Q10 = originalVelocityToQ10(
  400 / RESPONDER_VELOCITY_SCALE,
);

/** +1 or -1: which way along the surface this slingshot face throws. */
export function slingshotTangentSign(id: number): number {
  return id % 2 === 0 ? 1 : -1;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/** One row of main.seg08, exactly as the four words read. */
export interface SurfaceConstants {
  /**
   * `$34` grazing limit, in sixteenths of a tangent: a contact with
   * `|vt| * 16 >= grazeLimit * |vn|` is cancelled outright. Applied by
   * `reflectVelocity` on surface-mapped contacts since round 5.
   */
  readonly grazeLimit: number;
  /** `$36` restitution, 1/256ths. */
  readonly restitution: number;
  /** `$38` minimum normal impact velocity, negative. Recorded, not applied. */
  readonly minImpact: number;
  /**
   * `$3A` spin/friction divisor: an impact takes `tangent * 160 / $3A` in the
   * spinless limit. Applied by `reflectVelocity` on surface-mapped impacts
   * since round 5 — see the header.
   */
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

/**
 * The same table with every coil DEAD: what a bumper or slingshot face is
 * while the table is TILTED.
 *
 * MEASURED at the contact handlers: tilt ($23ED) is tested at +0x00B216 before
 * the bumper number is latched and at +0x00B234 before the slingshot's, so the
 * kick stage never sees either device and neither kick, tangential throw nor
 * award fires — but the `movem.w` that loads the surface row runs BEFORE the
 * id range check and is not gated at all, so the face still bounces with its
 * own restitution. A tilted bumper is a rubber post, not a wall of a different
 * material.
 */
const DISARMED_TABLE: readonly SurfaceResponse[] = Object.freeze(
  TABLE.map((row) =>
    row.kick === 0 && row.tangentKick === 0
      ? row
      : Object.freeze({ ...row, kick: 0, kickThreshold: 0, tangentKick: 0 }),
  ),
);

/**
 * The response for one surface id. Throws outside 0..255: the map is bytes.
 *
 * `powered` false answers the tilted table's row: same restitution, no coil.
 */
export function surfaceResponseFor(id: number, powered = true): SurfaceResponse {
  const found = (powered ? TABLE : DISARMED_TABLE)[id];
  if (found === undefined) {
    throw new RangeError(`surface id ${id} is outside the 256-entry table`);
  }
  return found;
}

/** Every id's response, for tests and tooling. */
export function surfaceResponses(): readonly SurfaceResponse[] {
  return TABLE;
}
