/**
 * Shared contracts for the simulation.
 *
 * Written before the implementation modules so that independently built parts
 * agree on shape. Nothing here has behaviour; it is the seam between the map
 * loader, the collision probe, the material table and the ball simulation.
 *
 * The whole game is N-ball from the ground up — Pinball Illusions' defining
 * feature is multiball, so there is no "the ball" anywhere in these types.
 */

import type { Q10 } from "../core/fixed-point.js";

/**
 * Playfield dimensions, identical on all three tables (measured from disk).
 *
 * The map's four layers are 620/620/600/600 rows, not four equal planes, and the
 * physics area is the first 600 rows of each. An earlier decode assumed equal
 * 610-row planes; that totals the same byte count, so it looked right while
 * shifting three of the four layers out of registration.
 */
export const PLAYFIELD_WIDTH = 336;
export const PLAYFIELD_HEIGHT = 600;

/**
 * The four layers combine per pixel into an index 0..15:
 *   bit 0 (1) lower-level collision line  <- the only bit the original physics tests
 *   bit 1 (2) upper-level collision line
 *   bit 2 (4) lower structure/occlusion artwork
 *   bit 3 (8) upper structure/occlusion artwork
 *
 * So a pixel blocks a ball on the lower playfield exactly when its index is odd.
 * The structure bits are artwork the ball passes under, not geometry.
 */
export type MaterialIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

export const TABLE_IDS = ["law-n-justice", "babewatch", "extreme-sports"] as const;
export type TableId = (typeof TABLE_IDS)[number];

/**
 * Which of the two collision lines a ball is riding.
 *
 * 0 is the playfield (bit 0), 1 is the ramp and habitrail network (bit 1). The
 * original engine held exactly this as a plane pointer and tested one plane at
 * a time; `playfield-levels.ts` has the geometry and the hand-off rules.
 */
export type PlayfieldLevel = 0 | 1;

/**
 * How a material behaves when a ball touches it.
 *
 * `passable` materials are surfaces the ball rolls over; everything else
 * deflects. Coefficients are Q10 fixed-point so the simulation stays integral
 * and replays reproduce exactly.
 */
export interface MaterialBehaviour {
  readonly index: MaterialIndex;
  /** Short stable identifier, e.g. "open", "wall", "rubber", "slingshot". */
  readonly kind: string;
  /** True when a ball may occupy this pixel. */
  readonly passable: boolean;
  /** Restitution in Q10; 1024 is a perfect bounce, 0 fully damped. */
  readonly elasticity: Q10;
  /** Tangential friction in Q10; 0 is frictionless. */
  readonly friction: Q10;
  /**
   * Extra outward impulse in Q10 units per tick, for powered surfaces such as
   * slingshots and bumpers that add energy rather than merely reflecting it.
   */
  readonly kick: Q10;
  /** Confidence in this assignment, so unverified guesses stay visible. */
  readonly confidence: "measured" | "inferred" | "provisional";
}

/** The full 16-entry table for one playfield. */
export interface MaterialTable {
  readonly tableId: TableId;
  readonly behaviours: ReadonlyMap<MaterialIndex, MaterialBehaviour>;
  behaviourFor(index: MaterialIndex): MaterialBehaviour;
}

/** A decoded playfield: one material index per pixel. */
export interface TableMap {
  readonly tableId: TableId;
  readonly displayName: string;
  readonly width: number;
  readonly height: number;
  /** Row-major, length width*height. */
  readonly pixels: Uint8Array;
  /** Index at (x, y); out-of-bounds reads return the solid border material. */
  materialAt(x: number, y: number): MaterialIndex;
}

/** On-disk shape of `public/generated/tables/<id>.map.json`. */
export interface TableMapDocument {
  readonly schema: "pinball-illusions/table-map/v1";
  readonly tableId: TableId;
  readonly displayName: string;
  readonly width: number;
  readonly height: number;
  readonly provenance: {
    readonly sourceClass: string;
    readonly description: string;
    readonly authorizationRequired: boolean;
  };
  readonly materialHistogram: Readonly<Record<string, number>>;
  /** Per row, flat pairs of [inclusive_end_x, material]. Runs start at x=0. */
  readonly rows: readonly (readonly number[])[];
}

/**
 * On-disk shape of `public/generated/tables/<id>.accel.json`: the per-8x8-block
 * ramp drive decoded from slot 4. See `table-accel.ts` for what it means and
 * `scripts/export-table-accel.mjs` for where it comes from.
 */
export interface TableAccelDocument {
  readonly schema: "pinball-illusions/table-accel/v1";
  readonly tableId: TableId;
  readonly displayName: string;
  readonly provenance: {
    readonly sourceClass: string;
    readonly description: string;
    readonly authorizationRequired: boolean;
  };
  readonly blockSize: number;
  readonly columns: number;
  readonly rows: number;
  /** Signed (dx, dy) pairs in the ORIGINAL's per-substep velocity units. */
  readonly vectors: readonly (readonly number[])[];
  /** One per playfield level; per block row, flat [inclusive_end_column, vector index]. */
  readonly levels: readonly (readonly (readonly number[])[])[];
}

/** One ball in flight. Positions are Q10; velocities are signed 16-bit. */
export interface BallState {
  readonly id: number;
  x: Q10;
  y: Q10;
  velocityX: number;
  velocityY: number;
  /** False once drained; kept in the list so ids stay stable during multiball. */
  active: boolean;
  /**
   * The ball lock holding this ball, or null when it is in play.
   *
   * A held ball is still `active` — it is on the table and the player can see it
   * sitting in the saucer — but it takes no part in the physics at all: no
   * gravity, no ramp drive, no contact, no ball-to-ball, no drain. That is what
   * the original does. Its capture handler sets bit 7 of the ball record's flag
   * byte (main.seg00 data 0x555E, `ori.b #$80,$1(a4)`) and the integrator skips
   * any ball carrying it — `tst.b $1(a4)` / `bmi` at data 0xA684, 0xA6CE and
   * 0xA718, one test per sub-step group.
   *
   * `ball-locks.ts` owns the capture and release rules; `stepBalls` only honours
   * the flag. It is a device id rather than a boolean so a held ball says WHICH
   * saucer has it, which is what release needs and what a debug dump wants.
   */
  heldBy: string | null;
  /**
   * Which collision line this ball is riding: 0 the playfield, 1 the ramps.
   *
   * The map carries two independent collision lines and a pixel that blocks on
   * one may be open on the other — Law 'n Justice's top arch exists only on
   * line 1, its shooter-lane floor only on line 0 — so "solid" is not a
   * property of the map alone. See `playfield-levels.ts` for the two views and
   * for where a ball changes between them.
   */
  level: PlayfieldLevel;
}

/** A contact detected between a ball's probe ring and a non-passable pixel. */
export interface ContactPoint {
  /** Index into the probe ring, 0..ringSize-1. */
  readonly ringIndex: number;
  /** Contact angle in the original's 2048-units-per-revolution scale. */
  readonly angle: number;
  readonly material: MaterialIndex;
  readonly x: number;
  readonly y: number;
}

/** Result of probing one ball against the map for a single tick. */
export interface ContactResult {
  readonly contacts: readonly ContactPoint[];
  /** Mean contact angle, or null when there were no contacts. */
  readonly normalAngle: number | null;
  /** The most deflecting material touched, or null when free. */
  readonly dominant: MaterialIndex | null;
}

/** Per-tick forces applied before collision resolution. */
export interface SimulationForces {
  /** Downward acceleration in Q10 per tick, scaled by the slope option. */
  readonly gravityY: Q10;
  /** Nudge impulse applied this tick, if the player nudged. */
  readonly nudgeX: Q10;
  readonly nudgeY: Q10;
}
