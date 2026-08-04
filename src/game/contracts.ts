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

/**
 * On-disk shape of `public/generated/tables/<id>.devices.json`: the surface-id
 * map plus the device, bumper, slingshot and zone records the original scores
 * with. See `table-devices.ts` for what it means and
 * `scripts/export-table-devices.mjs` for where it comes from.
 */
export interface TableDevicesDocument {
  readonly schema: "pinball-illusions/table-devices/v1";
  readonly tableId: TableId;
  readonly displayName: string;
  readonly provenance: {
    readonly sourceClass: string;
    readonly description: string;
    readonly authorizationRequired: boolean;
  };
  readonly width: number;
  readonly height: number;
  readonly devices: readonly Readonly<Record<string, unknown>>[];
  readonly bumpers: readonly Readonly<Record<string, unknown>>[];
  readonly slingshots: readonly Readonly<Record<string, unknown>>[];
  readonly zones: readonly Readonly<Record<string, unknown>>[];
  readonly surfaceHistogram: readonly Readonly<Record<string, number>>[];
  /** One per playfield level; per pixel row, flat [inclusive_end_x, surface id]. */
  readonly surfaceIds: readonly (readonly (readonly number[])[])[];
}

/**
 * On-disk shape of `public/generated/tables/<id>.modes.json`: the mission
 * bytecode, the playfield element records it operates on, the display text and
 * the device/zone bindings that fire it. See `table-modes.ts` for what it means,
 * `mode-vm.ts` for what runs it, and `scripts/export-table-modes.mjs` for where
 * it comes from and what it does not know.
 */
export interface TableModesDocument {
  readonly schema: "pinball-illusions/table-modes/v1";
  readonly tableId: TableId;
  readonly displayName: string;
  readonly provenance: {
    readonly sourceClass: string;
    readonly description: string;
    readonly authorizationRequired: boolean;
  };
  readonly opcodes: readonly Readonly<Record<string, unknown>>[];
  readonly elements: readonly Readonly<Record<string, unknown>>[];
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  readonly scripts: readonly Readonly<Record<string, unknown>>[];
  readonly missions: readonly Readonly<Record<string, unknown>>[];
  /** The progress-counter records off the descriptor's own list at +$40. */
  readonly counters?: readonly Readonly<Record<string, unknown>>[];
  /** Index into `counters` of the one the end-of-ball bonus pays combos for, or -1. */
  readonly comboCounter?: number;
  /** The lamp groups off the descriptor's +$38 table. See `table-modes.ts`. */
  readonly lampGroups?: readonly Readonly<Record<string, unknown>>[];
  /** Descriptor hook 2's ball-start multiplier restore, or null. See `table-modes.ts`. */
  readonly multiplierRestore?: Readonly<Record<string, unknown>> | null;
  readonly triggers: Readonly<Record<string, unknown>>;
}

/**
 * On-disk shape of `public/generated/tables/<id>.lamps.json`: the playfield
 * lamp overlays — position, shape and (for the masked kind) both image states
 * of every insert lamp — plus the wiring from each mode element to the lamps
 * its START and AWARD opcodes drive. See `table-lamps.ts` for what it means,
 * `lamp-overlays.ts` for what draws it, and `scripts/export-table-lamps.mjs`
 * for where it comes from.
 */
export interface TableLampsDocument {
  readonly schema: "pinball-illusions/table-lamps/v1";
  readonly tableId: TableId;
  readonly displayName: string;
  readonly provenance: {
    readonly sourceClass: string;
    readonly description: string;
    readonly authorizationRequired: boolean;
  };
  readonly blink: { readonly halfPeriodFrames: number };
  readonly lamps: readonly Readonly<Record<string, unknown>>[];
  /** Dense, in mode element-pool order: each element's start/award lamp index. */
  readonly elements: readonly Readonly<Record<string, unknown>>[];
}

/**
 * On-disk shape of `public/generated/tables/<id>.audio.json`: the sound-effect
 * samples and the device, bumper, slingshot and zone bindings that play them.
 * See `table-audio.ts` for what it means, `src/browser/audio.ts` for what plays
 * it, and `scripts/export-table-audio.mjs` for where it comes from.
 */
export interface TableAudioDocument {
  readonly schema: "pinball-illusions/table-audio/v1";
  readonly tableId: TableId;
  readonly displayName: string;
  readonly provenance: {
    readonly sourceClass: string;
    readonly description: string;
    readonly authorizationRequired: boolean;
  };
  readonly samples: readonly Readonly<Record<string, unknown>>[];
  readonly triggers: readonly Readonly<Record<string, unknown>>[];
}

/**
 * On-disk shape of `public/generated/engine.audio.json`: the seven sounds the
 * ENGINE plays itself — flipper strokes, serve, drain, level transfer, capture,
 * eject — decoded from `main.bin` hunks 10/11 and table-independent. Same
 * sample shape as the table documents; the triggers are event names rather than
 * award ids. See `scripts/export-engine-audio.mjs` for where it comes from.
 */
export interface EngineAudioDocument {
  readonly schema: "pinball-illusions/engine-audio/v1";
  readonly displayName: string;
  readonly provenance: {
    readonly sourceClass: string;
    readonly description: string;
    readonly authorizationRequired: boolean;
  };
  readonly samples: readonly Readonly<Record<string, unknown>>[];
  readonly triggers: readonly Readonly<Record<string, unknown>>[];
}

/**
 * On-disk shape of `public/generated/flipper-bats.json`: the 3-bitplane pose
 * bank every bat on every table is drawn from, plus each table's decoded
 * flipper records. ONE shared document — the raster is table-independent, which
 * is a decoded fact the exporter asserts. See `flipper-bats.ts` for what it
 * means, `moving-sprites.ts` for what draws it, and
 * `scripts/export-flipper-bats.mjs` for where it comes from.
 */
export interface FlipperBatsDocument {
  readonly schema: "pinball-illusions/flipper-bats/v1";
  readonly provenance: {
    readonly sourceClass: string;
    readonly description: string;
    readonly authorizationRequired: boolean;
  };
  readonly source: Readonly<Record<string, unknown>>;
  readonly posesPerTurn: number;
  readonly degreesPerPose: number;
  readonly angleUnitsPerPose: number;
  readonly planes: number;
  readonly plane2RowOffset: number;
  readonly poses: readonly Readonly<Record<string, unknown>>[];
  readonly tables: readonly Readonly<Record<string, unknown>>[];
}

/**
 * On-disk shape of `public/generated/tables/<id>.ball.json`: the 17x17
 * 8-bitplane steel ball sprite as palette indices into the table's own artwork
 * palette, the shared 221-pixel disc mask, and the two per-level structure
 * bitmaps the original cookie-cuts it against. See `table-ball.ts` for what it
 * means and `scripts/export-table-ball.mjs` for where it comes from.
 */
export interface TableBallDocument {
  readonly schema: "pinball-illusions/table-ball/v1";
  readonly tableId: TableId;
  readonly displayName: string;
  readonly provenance: {
    readonly sourceClass: string;
    readonly description: string;
    readonly authorizationRequired: boolean;
  };
  readonly width: number;
  readonly height: number;
  readonly anchor: { readonly centreX: number; readonly centreY: number };
  readonly source: Readonly<Record<string, unknown>>;
  readonly mask: Readonly<Record<string, unknown>>;
  readonly pixels: string;
  readonly indicesUsed: readonly number[];
  readonly occluders: Readonly<Record<string, unknown>>;
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
  /**
   * THE BALL'S SPIN: the surface speed its rotation would give the contact
   * point, signed in the contact tangent basis `t = (n_y, -n_x)`.
   *
   * The original's own `$26(a4)` — a signed 16-bit word at ball record offset
   * +$26, the very next word after the Q10 position pair at +$1E/+$22 — found,
   * decoded and measured against three cold boots of the machine's own RAM in
   * `research/spin/SPIN_DECODE.md`. It is charged by the responder at
   * +0x00B640 (`sub.w d4,$26(a4)`, the same `d4` that puts `5q/8` into the
   * translation one instruction earlier) and bled one unit per SUBSTEP toward
   * zero at +0x00B770. Nothing else in the whole segment writes it: all
   * seventeen `$26(An)` accesses in main.seg00 were disassembled and classified,
   * and the ten that are not these are other structures.
   *
   * RESPONDER UNITS — 1/512 px per tick, two Q10, half of one of the original's
   * own velocity words — because `$26(a4)` is subtracted straight from the
   * doubled tangential speed inside the contact rotation (see
   * `surface-physics.ts`'s `RESPONDER_VELOCITY_SCALE`) and its decay quantum is
   * exactly one of them.
   *
   * IT PERSISTS, and that is decoded rather than convenient: across frames,
   * across free flight, across a serve, across a drain and across a lock.
   * `+0x3E36`, the serve routine, re-seeds `$12/$14/$1E/$22/$0E/$10/$01` and
   * NOT `$26`; the per-ball loops skip a held or drained ball entirely, so a
   * ball released from a saucer comes out with the spin it went in with. A port
   * that reset it at serve would be wrong in the code and almost right in
   * effect, because eight units a frame empties any real spin in about a second
   * — measured on the machine's own seated lane ball the spin is exactly 0 on
   * 79-87 % of its frames, which is the equilibrium between the seat's own
   * charge and the decay rather than an uncleared leftover.
   *
   * SIGN. The basis is derived from the outward normal by a fixed quarter turn,
   * so the handedness is global and this is a genuine angular velocity about
   * the axis out of the playfield rather than a per-contact convention. A port
   * that flipped it would DOUBLE the tangential toll instead of removing it,
   * which is why `tests/ball-physics.test.ts` asserts the handedness directly.
   */
  spin: number;
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
  /**
   * Sideways acceleration in Q10 per tick squared: option record 4, the TABLE
   * X-TILT. Optional, and zero on every shipped table.
   *
   * MEASURED and wired for completeness rather than for effect. $E8C(a5) is
   * added to the X acceleration at +0x00B758 in the same instruction pair that
   * adds gravity to the Y, so it takes the same unit bridge — one option unit is
   * 32 Q10 per tick squared — and its +-3 range is three quarters of gravity of
   * permanent lateral lean. All three `tableNNN.opt` files ship it at 0, so
   * applying it faithfully changes nothing about how the game plays; leaving it
   * unapplied would have left a measured option with no home. See `timebase.ts`.
   */
  readonly tiltX?: Q10;
  /** Nudge impulse applied this tick, if the player nudged. */
  readonly nudgeX: Q10;
  readonly nudgeY: Q10;
}
