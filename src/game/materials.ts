/**
 * Material behaviour table for the playfield collision map.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE 16 INDICES ACTUALLY ARE
 * ---------------------------------------------------------------------------
 * Slot 2 of a table package is not one 16-value material map. It is FOUR
 * INDEPENDENT 1-BIT LAYERS, and the "material index" is just their bitwise
 * union. The layers were recovered from the relocated pointer descriptor in
 * slot 0 (each of the four is a separate entry) and each one's role was read
 * out of the 68000 code in main.bin:
 *
 *   bit 0 (1)  level-0 collision line   -> ball field $54(a4), single-bit test
 *                                          at the ball pixel (main +0x00b43e)
 *   bit 1 (2)  level-1 collision line   -> same test, level-1 init variant
 *   bit 2 (4)  level-0 structure area   -> ball field $58(a4), AND-NOT mask in
 *                                          the ball blitter (main +0x00bf3c)
 *   bit 3 (8)  level-1 structure area   -> same, upper level
 *
 * ---------------------------------------------------------------------------
 * DOES BIT 2 BLOCK THE BALL? — ADJUDICATED, ANSWER IS NO
 * ---------------------------------------------------------------------------
 * Bit 2 covers 45.1% / 46.7% / 36.8% of the three tables, so whether it blocks
 * is the single largest open question in the physics. It was attacked by four
 * independent investigations (two disassembly, two geometric/connectivity). All
 * four returned "does not block". The disassembly is decisive and the byte
 * patterns below were re-verified directly against
 * `_pinball_research/illusions/seg/main.seg00.bin` (58,448 bytes, address ==
 * file offset). Each of these is the ONLY occurrence in the whole engine:
 *
 *   +0x00B43E  226C 0054       movea.l $54(a4),a1   ; the collision plane ptr
 *   +0x00B47E  3D7C 0026 0064  move.w #$26,$64(a6)  ; BLTAMOD = 38
 *   +0x00B492  0040 0BA0       ori.w  #$0BA0,d0     ; -> BLTCON0
 *   +0x00B4AE  3D7C 0442 0058  move.w #$442,$58(a6) ; BLTSIZE = 17 rows x 2 words
 *   +0x00A7FA  082E 0005 0002  btst.b #5,$2(a6)     ; DMACONR bit 13 = BZERO
 *   +0x0009CC  0642 002A       addi.w #$2A,d2       ; map row table stride = 42
 *   +0x00BF3C  266C 0058       movea.l $58(a4),a3   ; the OTHER per-level plane
 *   +0x00BFDC  4680            not.l  d0            ; ...used only to mask the sprite
 *
 * Four things follow, and together they close the question:
 *
 * 1. THE TEST IS A BLITTER AND OVER ONE BITPLANE. BLTCON0 $0BA0 is
 *    USEA|USEC|USED with minterm $A0 = A!BC + ABC, which is exactly `D = A AND
 *    C`, independent of B (verified by expanding the truth table). A is the map,
 *    C is a static 17x17 ball ring, D is a 68-byte scratch buffer; collision is
 *    "D != 0", read as the BZERO flag at +0x00A7FA. One bit per pixel. There is
 *    no nibble assembly, no 16-entry material LUT and no OR of two planes
 *    anywhere on the path.
 * 2. THE STRIDE PINS IT TO ONE PLANE. BLTAMOD 38 with a 2-word blit width gives
 *    a source row stride of 4 + 38 = 42 bytes = 336 pixels at 1 bit per pixel —
 *    one layer, not four. The runtime-built map row table at +0x0009CC steps by
 *    the same 42.
 * 3. BIT 2 CANNOT PHYSICALLY BE THE SOURCE. The blit reads 17 rows starting at
 *    map row y, and the guard is `cmpi.w #600,d1` (+0x00B29E) — y up to 600 is
 *    allowed, so rows up to 616 are fetched. Layers 0 and 1 are 620 rows;
 *    layers 2 and 3 stop dead at 600. Only the two 620-row layers can service
 *    that look-ahead, and the surplus rows are verifiably padding (0 set bits
 *    above row 599 on layer 0, 29 on layer 1). Bit 2 is a 600-row layer.
 * 4. BIT 2'S ACTUAL JOB IS POSITIVELY IDENTIFIED. $58(a4) is read at exactly one
 *    site, +0x00BF3C, inside the ball DRAW routine, where the plane word is
 *    NOT-ed and ANDed into each of the ball sprite's bitplanes so structure is
 *    drawn in front of the ball. It never touches position or velocity.
 *
 * The geometric investigations agree independently. Adding bit 2 to the lower
 * collision test seals the plunger lane on 2 of 3 tables and seals or destroys
 * 84-96% of the upper playfield on all three; the reachable region collapses
 * from a recognisable pinball table (orbit, plunger lane, top arch, bumpers,
 * slingshots, outlanes, all one connected component) to a pocket around the
 * flippers. That holds at ball radii 0, 1, 2 and 4, so it is topological rather
 * than an erosion artefact. Bit 0 is a collision OUTLINE lying inside the bit-2
 * body (containment 98.2% / 96.6% / 97.5%), which is why bit-2 bodies read as
 * solid to the eye while only their rim blocks: bumper and slingshot interiors
 * come out free but unreachable, which is correct, not a leak.
 *
 * WHAT REMAINS GENUINELY OPEN (do not let this file imply otherwise):
 *   - WHICH of the two 620-row layers is "lower". $54(a4) is loaded from
 *     $22F2(a5) for level 0 and $230A(a5) for level 1, and those pointers are
 *     block-copied from a table-package header that is zero-filled on disk, so
 *     the mapping was inferred (from stroke geometry and the outline/fill
 *     pairing), not read. If it were inverted the blocking bit would be bit 1
 *     rather than bit 0 — but bit 2 would still not block, so the verdict here
 *     is unaffected.
 *   - The vertical anchor of the 17-row probe window (rows y..y+16 assumed).
 *   - Whether bit 2 is consulted by per-table script code in the slot-0/4 code
 *     segments. Not exhaustively disassembled; no blitter setup with a 42-byte
 *     modulo exists in them.
 *
 * RULED OUT, so nobody re-runs them: bit 2 as a lower-level wall; any per-pixel
 * material LUT (no 16-entry or power-of-two mask tables exist in any segment);
 * byte-granular bit indexing (zero `lsr #3` in the engine); and the plane
 * offsets being computed in code (the constants 26040 / 52080 / 77280 / 102480
 * appear nowhere in any code segment — the four planes arrive as four
 * independent pointers).
 *
 * The four layers are NOT four equal 610-row planes. Their payload offsets are
 * 0 / 26040 / 52080 / 77280 with row counts 620 / 620 / 600 / 600 at 42 bytes
 * per row. That was confirmed here independently of the disassembly: scanning
 * the vertical offset that makes the bit-0 line lie inside the bit-2 area gives
 * a sharp peak at exactly the predicted +20 rows on all three tables
 * (containment 0.976 / 0.963 / 0.970 versus 0.681 / 0.661 / 0.581 at zero
 * offset), and the bit-1 / bit-3 pair peaks at exactly the predicted 0 rows.
 *
 * >>> STATE OF THE SHIPPED MAPS <<<
 * public/generated/tables/*.map.json are decoded under the bases in
 * SLOT2_PLANE_BASES below, so their indices mean what this table says. An
 * earlier export used four equal 25620-byte planes, which ORs vertically
 * misaligned layers — bit 2 twenty rows low, bits 1 and 3 ten rows low; that is
 * history. `scripts/export-table-maps.mjs` is the generator of record. Its
 * layer table must stay in step with SLOT2_PLANE_BASES (nothing mechanical can
 * do that — it runs without a TypeScript loader), and its `--check` mode
 * re-decodes the disks and compares against the shipped files without writing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE MAP DOES NOT CONTAIN — READ THIS BEFORE TUNING ANYTHING
 * ---------------------------------------------------------------------------
 * There is no rubber-versus-wall distinction anywhere in this data. Collision
 * is a SINGLE BIT per level: solid or not solid. No per-material restitution,
 * friction or kick table exists in the segments.
 *
 * There IS a per-region constant table and it carries ACCELERATION rather than
 * bounce: the RAMP DRIVE, now decoded, shipped and applied. This note used to
 * describe it as "Table00N.seg04.bin +6304, 4-byte signed x/y pairs ... a
 * per-8x8-block acceleration", which named only half of it. File offset 6304
 * (data offset 6300) is the short list of signed (dx, dy) word pairs; the part
 * that carries the GEOMETRY is the two 42x75 BLOCK MAPS in front of it, at data
 * 0 and data 3150, one per playfield level, whose bytes index that list. See
 * `scripts/export-table-accel.mjs` for the decode and the disassembly of the
 * consumer at main.seg00 +0x00B70A, and `table-accel.ts` for what the physics
 * does with it. Its existence is also why no amount of tuning the numbers below
 * could have closed the shallow-slope traps: the missing term was never a
 * coefficient.
 *
 * So: every `passable` flag and every `kind` below is derived from the data.
 * NOT ONE elasticity, friction or kick number in this file is measured. They
 * are engineering defaults chosen to feel like a pinball table. The
 * `confidence` field grades the KIND AND PASSABILITY assignment only, and the
 * per-entry comments say so where it matters.
 *
 * Slingshot, bumper and rubber behaviour must be applied by the device layer
 * from coordinates in the slot-4 rules module, layered on top of this table.
 * DEVICE_PRESETS at the bottom holds those coefficients so nothing has to
 * pretend a pixel index encodes them.
 */

import type { Q10 } from "../core/fixed-point.js";
import type { MaterialBehaviour, MaterialIndex, MaterialTable, TableId } from "./contracts.js";

/** Bit 0: the ball collides with this pixel on the lower playfield. */
export const LEVEL0_SOLID_BIT = 0x1;
/** Bit 1: the ball collides with this pixel on the upper (ramp) playfield. */
export const LEVEL1_SOLID_BIT = 0x2;
/**
 * Bit 2: lower-playfield structure/occlusion artwork. DOES NOT BLOCK — read
 * only by the ball draw routine at main.seg00 +0x00BF3C, where it is NOT-ed and
 * ANDed into the sprite so structure covers the ball. See the adjudication note
 * at the top of this file before changing this.
 */
export const LEVEL0_STRUCTURE_BIT = 0x4;
/** Bit 3: upper-playfield structure/occlusion artwork. Does not block, same as bit 2. */
export const LEVEL1_STRUCTURE_BIT = 0x8;

/**
 * Byte offsets of the four layers within the slot-2 payload (after the 8-byte
 * preamble), with their row counts. 42 bytes per row, 336 pixels wide. The
 * physics area is the first 600 rows; the bounds check in the ball integrator
 * is `cmpi.w #$258,d1` i.e. y <= 600.
 */
export const SLOT2_PLANE_BASES = [
  { bit: LEVEL0_SOLID_BIT, offset: 0, rows: 620 },
  { bit: LEVEL1_SOLID_BIT, offset: 26040, rows: 620 },
  { bit: LEVEL0_STRUCTURE_BIT, offset: 52080, rows: 600 },
  { bit: LEVEL1_STRUCTURE_BIT, offset: 77280, rows: 600 },
] as const;

/** Rolling resistance of bare playfield. Small: the ball must reach the drain. */
const ROLLING_FRICTION: Q10 = 20;

/** Plain wall restitution, mid of the 0.55-0.7 band the project settled on. */
const WALL_ELASTICITY: Q10 = 640;
/**
 * Tangential loss on a wall graze, ~0.15.
 *
 * Exported because it is not only a coefficient: under the Coulomb rule in
 * `reflectVelocity` it also fixes a STATIC FRICTION ANGLE of
 * `atan(154/1024)` = 8.55 degrees, below which a slope holds a ball
 * indefinitely. `ball-physics.ts` derives its slope release from this number so
 * the two can never drift apart, and `releaseFromShallowSlope` documents why the
 * original — whose bounce has no Coulomb term at all — never needed one.
 */
export const WALL_FRICTION: Q10 = 154;

/**
 * Free space: the ball rolls through, losing only rolling friction.
 * Used for every index whose bit 0 is clear, because bit 0 is the whole of the
 * lower-playfield collision test.
 */
function free(index: MaterialIndex, kind: string, confidence: MaterialBehaviour["confidence"]): MaterialBehaviour {
  return { index, kind, passable: true, elasticity: 0, friction: ROLLING_FRICTION, kick: 0, confidence };
}

/** Solid: bit 0 set. Deflects with the plain-wall coefficients. */
function solid(index: MaterialIndex, kind: string, confidence: MaterialBehaviour["confidence"]): MaterialBehaviour {
  return {
    index,
    kind,
    passable: false,
    elasticity: WALL_ELASTICITY,
    friction: WALL_FRICTION,
    kick: 0,
    confidence,
  };
}

/**
 * The 16 behaviours, shared by all three tables.
 *
 * Pixel counts quoted per entry are Law 'n Justice / BabeWatch / Extreme Sports
 * over the 336x600 physics area under the corrected plane bases. "ball-covered"
 * is the fraction of that index an 8-pixel-radius ball can physically overlap,
 * measured by eroding the free space by the ball radius, flood-filling from the
 * lower playfield and dilating back.
 */
const BEHAVIOURS: readonly MaterialBehaviour[] = [
  // 0 — no bit set. The bare playfield: 108789 / 105715 / 122375 px, the single
  // largest class on every table, 94.7% / 89.3% / 83.5% ball-covered. It is the
  // shooter lane interior (x 281-300 is index 0 top to bottom) and it is the
  // drain: the last physics row y=599 reads 4[0-51] 5[52-56] 0[57-163]
  // 5[164-167] 4[168-303] 0[304-335], so the centre gap between the two rails
  // is index 0 and a ball can leave the table. All four investigators agree.
  free(0, "open", "measured"),

  // 1 — level-0 collision line lying outside the structure mask. Only
  // 237 / 601 / 337 px: residue where the 1-px line pokes past the area mask
  // edge. Solid because bit 0 is set; that part is certain. The kind is a
  // label of convenience for a class too small to characterise.
  solid(1, "wall-edge", "provisional"),

  // 2 — upper-level collision line over ground that is not lower-playfield
  // structure. 132 / 290 / 211 px, and 52% / 66% / 86% of it is ball-covered
  // ON LEVEL 0, which is the direct evidence that bit 1 does not block a
  // lower-playfield ball. Passable here; the level-1 simulation must treat it
  // as solid.
  free(2, "rail-upper", "provisional"),

  // 3 — solid on both levels, inside neither structure mask. THE INDEX THE
  // BRIEF FLAGGED AS UNUSED ON LAW 'N JUSTICE. Under the misaligned export it
  // is 0 px there; under the corrected plane bases it is 4 / 41 / 30 px. Either
  // way it is negligible on all three tables and is a bit-overlap artifact
  // where two 1-px lines cross, not a designed material. Solid, because bit 0
  // is set and a stray passable pixel inside a wall is worse than a stray
  // solid one.
  solid(3, "wall-edge", "provisional"),

  // 4 — lower-playfield structure artwork with no collision line.
  // 65819 / 52317 / 36187 px. THE INDEX THE INVESTIGATORS FOUGHT OVER, now
  // settled: it is PASSABLE. Four independent investigations agreed, and the
  // disassembly is decisive — the collision blit's A source is a single 620-row
  // plane and bit 2 is a 600-row plane read only by the sprite masker. Full
  // argument at the top of this file.
  // The corroborating geometry: 73.5% / 39.8% / 67.5% of these pixels are
  // physically reachable by an 8-px ball, so walling them off would block real
  // playfield — and blocking bit 2 seals the plunger lane on two of the three
  // tables outright. The remainder is sealed body interior — bumper discs,
  // slingshot bodies, the region beyond the outer wall — which the bit-0
  // outline rings and the ball never enters. Only 47% / 64% / 48% of this
  // mask's own boundary carries a collision line (58% / 68% / 57% once 1-2 px
  // art filigree is opened away), which is what makes it an occlusion layer
  // rather than a solid layer.
  free(4, "structure-occluded", "measured"),

  // 5 — THE WALL. Level-0 collision line inside the structure mask:
  // 11410 / 12171 / 8500 px, the bulk of all lower-playfield collision. It is
  // the outer table wall, the shooter-lane walls (column x=303 is index 5 for
  // 433 of 460 rows on Law 'n Justice), the lane guides, the slingshot faces
  // and the pop-bumper rings. Passability measured; coefficients chosen.
  // A loader that must answer materialAt() outside the bitmap should return
  // this index — it is the natural solid border material.
  solid(5, "wall", "measured"),

  // 6 — upper-level line inside the lower structure mask. 41 / 185 / 24 px.
  // Passable on level 0 (bit 0 clear). Too rare to characterise.
  free(6, "rail-upper", "provisional"),

  // 7 — both collision lines inside the lower structure mask. 25 / 159 / 139 px,
  // 1-3 px slivers where the two line layers cross. Solid on level 0.
  solid(7, "wall-edge", "provisional"),

  // 8 — upper-level structure artwork only. 1134 / 601 / 3413 px, and
  // 99.6% / 99.3% / 80.8% ball-covered on level 0: this is bare lower playfield
  // that happens to lie under a ramp deck or overpass, where the artwork draws
  // over the ball. Rolls exactly like index 0; the renderer, not the physics,
  // is what cares.
  free(8, "open-under-ramp", "measured"),

  // 9 — level-0 line plus upper structure area. 0 / 0 / 1 px. Effectively
  // impossible, and its collapse from 146 / 966 / 435 px under the misaligned
  // export to zero here is one of the checks that the corrected plane bases are
  // right. Solid by the bit-0 rule so the class is never silently passable.
  solid(9, "wall-edge", "provisional"),

  // 10 — upper-level collision line over open lower playfield.
  // 443 / 119 / 1116 px and 98.0% / 99.2% / 78.7% ball-covered on level 0:
  // habitrail and ramp rails suspended above ground the ball rolls across.
  // Passable for the lower-playfield simulation, solid for the upper one.
  free(10, "rail-upper", "measured"),

  // 11 — both lines plus upper structure area. 8 / 19 / 0 px. Line-crossing
  // artifact. Solid on level 0.
  solid(11, "wall-edge", "provisional"),

  // 12 — both structure masks, no collision line. 2528 / 17851 / 12507 px, far
  // larger on BabeWatch and Extreme Sports because those tables have much more
  // ramp. 74.5% / 43.9% / 67.8% ball-covered: lower playfield running beneath a
  // ramp deck. Passable, and identical to index 0 for physics.
  free(12, "open-under-ramp", "measured"),

  // 13 — level-0 wall beneath a ramp deck. 293 / 3229 / 2910 px. Same wall as
  // index 5, just with upper-level artwork drawn over it.
  solid(13, "wall", "measured"),

  // 14 — upper-level collision line inside both structure masks.
  // 8644 / 5046 / 10748 px, the main ramp guide rail, and 84.0% / 48.1% / 65.9%
  // ball-covered ON LEVEL 0 — a lower-playfield ball rolls straight under it.
  // Passable here, solid for the level-1 simulation. Marking this solid on
  // level 0 would fence off large parts of the table.
  free(14, "rail-upper", "measured"),

  // 15 — solid on both levels. 2093 / 3256 / 3102 px: outer walls and lane
  // guides that exist at both heights, so the ball is stopped whichever level
  // it is on. Solid on level 0.
  solid(15, "wall", "measured"),
];

/**
 * Coefficients for powered and sprung devices.
 *
 * NOT reachable from any pixel index — the map cannot express them. The device
 * layer looks up bumper and slingshot positions from the slot-4 rules module
 * and applies these at the contact point. Every number here is a chosen
 * default; none is measured. Kept in this file so there is one place to tune
 * rebound and nothing is tempted to smuggle "rubber" into the pixel table.
 */
export const DEVICE_PRESETS: Readonly<Record<string, Omit<MaterialBehaviour, "index">>> = {
  rubber: {
    kind: "rubber",
    passable: false,
    elasticity: 845,
    friction: 205,
    kick: 0,
    confidence: "provisional",
  },
  slingshot: {
    kind: "slingshot",
    passable: false,
    elasticity: 512,
    friction: 205,
    kick: 420,
    confidence: "provisional",
  },
  bumper: {
    kind: "bumper",
    passable: false,
    elasticity: 460,
    friction: 205,
    kick: 560,
    confidence: "provisional",
  },
};

/**
 * True when the lower-playfield collision test blocks this index — i.e. when the
 * index is ODD.
 *
 * This is the whole of the lower-level collision test, matching the engine's
 * single-bitplane blitter AND at main.seg00 +0x00B43E. Structure bits 2 and 3
 * are deliberately absent: see the adjudication note at the top of this file.
 * If you are here because index 4 "looks solid" in a render, it is artwork.
 */
export function isLevel0Solid(index: MaterialIndex): boolean {
  return (index & LEVEL0_SOLID_BIT) !== 0;
}

/** True when the upper-playfield collision test blocks this index. */
export function isLevel1Solid(index: MaterialIndex): boolean {
  return (index & LEVEL1_SOLID_BIT) !== 0;
}

/** The index a probe outside the bitmap should read: a plain solid wall. */
export const SOLID_BORDER_INDEX: MaterialIndex = 5;

/** The bare playfield index. */
export const OPEN_INDEX: MaterialIndex = 0;

const TABLE_CACHE = new Map<TableId, MaterialTable>();

/**
 * The material table for one playfield.
 *
 * All three tables share the encoding — the same four descriptor slots at the
 * same payload offsets carry the same four layers on Law 'n Justice, BabeWatch
 * and Extreme Sports — so the behaviours are identical and only the pixel
 * populations differ. The tableId is carried through so a future per-table
 * measurement has somewhere to land without changing any call site.
 */
export function materialTableFor(tableId: TableId): MaterialTable {
  const cached = TABLE_CACHE.get(tableId);
  if (cached !== undefined) {
    return cached;
  }

  const behaviours = new Map<MaterialIndex, MaterialBehaviour>();
  for (const behaviour of BEHAVIOURS) {
    behaviours.set(behaviour.index, behaviour);
  }

  const table: MaterialTable = {
    tableId,
    behaviours,
    behaviourFor(index: MaterialIndex): MaterialBehaviour {
      const behaviour = behaviours.get(index);
      if (behaviour === undefined) {
        throw new RangeError(`no material behaviour for index ${index}`);
      }
      return behaviour;
    },
  };

  TABLE_CACHE.set(tableId, table);
  return table;
}
