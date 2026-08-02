/**
 * THE TWO THINGS THAT MOVE: the flipper bats and the balls.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * Both used to be drawn with canvas vector calls — two round-capped strokes for
 * a bat, three concentric `arc`s for a ball — at DEVICE resolution. That did
 * three things wrong at once, all of them measured against filmed WinUAE frames:
 *
 *   SHAPE. The original's bats are slim TAPERING blades with a bright red
 *   leading edge, a pale grey body and a white highlight near the boss, resting
 *   at exactly 30 degrees. The capsules were fat, uniformly thick, orange with a
 *   yellow outline, longer, and nearly horizontal at rest.
 *
 *   MATERIAL. The original's ball is a mottled dithered steel sphere with a hard
 *   highlight and a dark underside. Three flat anti-aliased circles read as a
 *   cartoon disc.
 *
 *   THE PIXEL GRID. Every pixel of the original — and every artwork and lamp
 *   pixel of this reconstruction — is a clean SxS block at integer scale S. A
 *   vector call at device resolution is not: over the 327x228 comparison window
 *   at 2x the original scores ZERO non-uniform 2x2 blocks and the reconstruction
 *   scored 599 / 559 / 621, and a connected-component pass over the failures
 *   returned exactly the two bats and the ball, nothing else.
 *
 * So both are now SPRITES, decoded off the disk, rasterised at NATIVE playfield
 * resolution into a playfield-sized overlay, and blitted through the same
 * `playfieldBlitGeometry` the artwork and the lamps use. The grid defect goes
 * away by construction rather than by being tuned out.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PIXELS ARE DECIDED HERE AND NOT IN THE BROWSER LAYER
 * ---------------------------------------------------------------------------
 * Same reason as `lamp-overlays.ts`: everything above the blit is pure and
 * node-testable. `src/browser/sprite-layer.ts` wraps these rasters in canvases;
 * the colours, the placements and the occlusion are decided here, where a test
 * can read them back byte for byte with no DOM.
 *
 * ---------------------------------------------------------------------------
 * THE FALLBACK IS A MARKER, NOT A LOOK-ALIKE
 * ---------------------------------------------------------------------------
 * The sprite documents are required assets — `main.ts` awaits them beside the
 * map and the artwork — but a synthetic map in a physics test has none, and a
 * table whose flipper record went missing must not silently draw something that
 * looks like a bat. So when a sprite is unavailable this module emits a MAGENTA
 * OUTLINE: a hollow box at the pivot for a bat, a hollow ring the ball's own
 * size for a ball. They are drawn as exact pixels, so the grid invariant holds
 * even in the failure case, and nobody could mistake either for the original.
 */

import { BALL_RADIUS_PIXELS } from "./collision-probe.js";
import type { PlayfieldLevel, TableId, TableMap } from "./contracts.js";
import type { Q10 } from "../core/fixed-point.js";
import { q10ToPixel } from "../core/fixed-point.js";
import { batBlockOrigin, batPoseForStroke } from "./flipper-bats.js";
import type { FlipperBatPose, FlipperBatRecord, FlipperBats } from "./flipper-bats.js";
import { STRUCTURE_BIT_BY_LEVEL } from "./table-ball.js";
import type { TableBall } from "./table-ball.js";
import type { TableArt } from "./table-art.js";
import type { PixelTarget } from "../browser/playfield-renderer.js";

/** RGBA, matching `ImageData` and `PixelTarget`. */
const BYTES_PER_PIXEL = 4;

/** The colour of every fallback marker. Nothing on any of the three tables is this. */
export const FALLBACK_MARKER: readonly [number, number, number] = Object.freeze([255, 0, 255]);

/** Side of the box drawn at a bat's pivot when its sprite is unavailable. */
export const FALLBACK_BAT_BOX = 11;

// ---------------------------------------------------------------------------
// Rasters
// ---------------------------------------------------------------------------

/** Everything one table needs to draw its bats and its ball, as RGBA. */
export interface MovingSprites {
  readonly tableId: TableId;
  /** One RGBA sprite per shipped pose, keyed by pose number. */
  readonly batPoses: ReadonlyMap<number, PixelTarget>;
  /** The same poses' geometry, which carries the blit anchor. */
  readonly poses: ReadonlyMap<number, FlipperBatPose>;
  /** This table's bat records, keyed by the simulation's flipper id. */
  readonly bats: ReadonlyMap<string, FlipperBatRecord>;
  readonly ball: PixelTarget;
  readonly ballCentreX: number;
  readonly ballCentreY: number;
}

function empty(width: number, height: number): PixelTarget {
  return { width, height, data: new Uint8ClampedArray(width * height * BYTES_PER_PIXEL) };
}

/** Writes one palette entry of the artwork's own palette, opaque. */
function paletteRgba(art: TableArt, index: number, out: Uint8ClampedArray, at: number): void {
  const entry = index * 3;
  out[at] = art.palette[entry] ?? 0;
  out[at + 1] = art.palette[entry + 1] ?? 0;
  out[at + 2] = art.palette[entry + 2] ?? 0;
  out[at + 3] = 255;
}

function planeBit(plane: Uint8Array, rowBytes: number, row: number, x: number): number {
  return ((plane[row * rowBytes + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0 ? 1 : 0;
}

/**
 * One pose as RGBA through the table's own palette.
 *
 * `plane0 | plane1<<1 | plane2<<2`, index 0 transparent, with plane 2 offset
 * down by `plane2RowOffset` rows — the original's own composition, and the
 * reason the bat is a slim grey blade rather than a red blob.
 */
export function buildBatPoseSprite(
  art: TableArt,
  pose: FlipperBatPose,
  plane2RowOffset: number,
): PixelTarget {
  const raster = empty(pose.width, pose.height);
  const rowBytes = Math.ceil(pose.width / 8);
  const plane2Rows = pose.height - 2 * plane2RowOffset;
  for (let y = 0; y < pose.height; y += 1) {
    for (let x = 0; x < pose.width; x += 1) {
      let index = planeBit(pose.plane0, rowBytes, y, x) | (planeBit(pose.plane1, rowBytes, y, x) << 1);
      const body = y - plane2RowOffset;
      if (body >= 0 && body < plane2Rows && planeBit(pose.plane2, rowBytes, body, x) !== 0) {
        index |= 4;
      }
      if (index === 0) continue;
      paletteRgba(art, index, raster.data, (y * pose.width + x) * BYTES_PER_PIXEL);
    }
  }
  return raster;
}

/** The ball as RGBA through the table's own palette. Index 0 is transparent. */
export function buildBallSprite(art: TableArt, ball: TableBall): PixelTarget {
  const raster = empty(ball.width, ball.height);
  for (let y = 0; y < ball.height; y += 1) {
    for (let x = 0; x < ball.width; x += 1) {
      const index = ball.pixels[y * ball.width + x] ?? 0;
      if (index === 0) continue;
      paletteRgba(art, index, raster.data, (y * ball.width + x) * BYTES_PER_PIXEL);
    }
  }
  return raster;
}

/**
 * Builds every sprite one table draws, once.
 *
 * Pure and deterministic: the same artwork, pose bank and ball document produce
 * the same bytes. Throws when the three do not name the same table, because a
 * sprite recoloured through the wrong palette is a defect that looks like a
 * style choice.
 */
export function buildMovingSprites(
  art: TableArt,
  bats: FlipperBats,
  ball: TableBall,
): MovingSprites {
  if (art.tableId !== ball.tableId) {
    throw new Error(`the ${ball.tableId} ball cannot be built against ${art.tableId} artwork`);
  }
  const records = bats.tables.get(art.tableId);
  if (records === undefined) {
    throw new Error(`the flipper bat document carries no records for ${art.tableId}`);
  }
  const batPoses = new Map<number, PixelTarget>();
  for (const [pose, entry] of bats.poses) {
    batPoses.set(pose, buildBatPoseSprite(art, entry, bats.plane2RowOffset));
  }
  return Object.freeze({
    tableId: art.tableId,
    batPoses,
    poses: bats.poses,
    bats: records,
    ball: buildBallSprite(art, ball),
    ballCentreX: ball.centreX,
    ballCentreY: ball.centreY,
  });
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** What a placement is: a real sprite, or the marker that says one is missing. */
export type SpriteKind = "bat" | "ball" | "bat-missing" | "ball-missing";

/** One sprite on the playfield this frame, at native playfield resolution. */
export interface SpritePlacement {
  readonly kind: SpriteKind;
  /** The pose number for a bat, the ball's id for a ball, for the marker cases 0. */
  readonly key: number;
  /** Top-left playfield pixel. Whole numbers, always. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Balls only: whose structure layer hides pixels of this one. */
  readonly level: PlayfieldLevel;
}

/** The bat state a placement needs, taken from the simulation without changing it. */
export interface BatFrameState {
  readonly id: string;
  /** Bat angle units, 0 at rest. */
  readonly stroke: number;
  /** The configured sweep in bat angle units, for the range check. */
  readonly sweep: number;
  /**
   * The SIMULATION's pivot, and what the sprite is BLITTED AGAINST.
   *
   * This used to be carried only so a bat with no record could put a fallback
   * marker somewhere sensible, while the drawn bat was placed on the pose bank
   * record's own pivot. The two were two pixels apart on every lower bat, and
   * the drawn one sat ABOVE the colliding one — a ball resting on what the
   * player could see was above anything that could stop it. They are now one
   * number: the simulation is built from the same records the pose bank ships
   * (`FLIPPER_RECORDS` in `flippers.ts`, pinned field for field against the
   * document by test), and the picture is placed on whatever the simulation is
   * actually colliding with.
   */
  readonly pivotX: Q10;
  readonly pivotY: Q10;
}

/** The ball state a placement needs. */
export interface BallFrameState {
  readonly id: number;
  readonly x: Q10;
  readonly y: Q10;
  readonly level: PlayfieldLevel;
}

/**
 * This frame's placements, bats first and balls after.
 *
 * ORDER IS THE ORIGINAL'S: main.seg00 $4B20 draws the bats, then the lamps,
 * then the balls last, so a ball rolling over a raised bat is drawn on top of
 * it. The lamps are a separate layer that has already been blitted by the time
 * this list is composited.
 *
 * Positions are floored to whole playfield pixels BEFORE any scaling —
 * `q10ToPixel` is `>> 10`, the original's own conversion — so a sprite can never
 * land on a half pixel and no blit can smear.
 */
export function movingSpritePlacements(
  sprites: MovingSprites | null,
  bats: readonly BatFrameState[],
  balls: readonly BallFrameState[],
): SpritePlacement[] {
  const placements: SpritePlacement[] = [];
  for (const bat of bats) {
    const record = sprites?.bats.get(bat.id);
    const pose = record === undefined ? null : batPoseForStroke(record, bat.stroke, bat.sweep);
    const raster = pose === null ? undefined : sprites?.batPoses.get(pose);
    const geometry = pose === null ? undefined : sprites?.poses.get(pose);
    if (record === undefined || pose === null || raster === undefined || geometry === undefined) {
      placements.push({
        kind: "bat-missing",
        key: 0,
        x: q10ToPixel(bat.pivotX) - (FALLBACK_BAT_BOX >> 1),
        y: q10ToPixel(bat.pivotY) - (FALLBACK_BAT_BOX >> 1),
        width: FALLBACK_BAT_BOX,
        height: FALLBACK_BAT_BOX,
        level: 0,
      });
      continue;
    }
    // THE SIMULATION'S pivot, not the record's. See `BatFrameState.pivotX`.
    const origin = batBlockOrigin(
      { pivotX: q10ToPixel(bat.pivotX), pivotY: q10ToPixel(bat.pivotY) },
      geometry,
    );
    placements.push({
      kind: "bat",
      key: pose,
      x: origin.x,
      y: origin.y,
      width: raster.width,
      height: raster.height,
      level: 0,
    });
  }
  for (const ball of balls) {
    if (sprites === null) {
      const size = 2 * BALL_RADIUS_PIXELS + 1;
      placements.push({
        kind: "ball-missing",
        key: ball.id,
        x: q10ToPixel(ball.x) - BALL_RADIUS_PIXELS,
        y: q10ToPixel(ball.y) - BALL_RADIUS_PIXELS,
        width: size,
        height: size,
        level: ball.level,
      });
      continue;
    }
    placements.push({
      kind: "ball",
      key: ball.id,
      x: q10ToPixel(ball.x) - sprites.ballCentreX,
      y: q10ToPixel(ball.y) - sprites.ballCentreY,
      width: sprites.ball.width,
      height: sprites.ball.height,
      level: ball.level,
    });
  }
  return placements;
}

// ---------------------------------------------------------------------------
// Structure occlusion
// ---------------------------------------------------------------------------

/**
 * Whether the level's structure layer covers a playfield pixel.
 *
 * The original does not draw structure over the ball: it removes structure
 * pixels from the ball's MASK before the single cookie-cut blit (main.seg00
 * +0x00BF3C, `not.l` then AND into every bitplane). Same result, one bit test
 * per ball pixel per frame — 221 of them.
 */
export interface StructureOccluder {
  blocks(x: number, y: number, level: PlayfieldLevel): boolean;
}

/** The shipped collision map as an occluder: bit 2 on level 0, bit 3 on level 1. */
export function mapStructureOccluder(map: TableMap): StructureOccluder {
  return {
    blocks(x: number, y: number, level: PlayfieldLevel): boolean {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
      return (map.materialAt(x, y) & (STRUCTURE_BIT_BY_LEVEL[level] ?? 0)) !== 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Compositing
// ---------------------------------------------------------------------------

/** Draws one placement's RGBA into `out`, which must be width*height*4 bytes. */
export function spriteFace(
  sprites: MovingSprites | null,
  placement: SpritePlacement,
  occluder: StructureOccluder | null,
  out: Uint8ClampedArray,
): void {
  out.fill(0);
  if (placement.kind === "bat-missing" || placement.kind === "ball-missing") {
    drawMarker(out, placement.width, placement.height, placement.kind === "ball-missing");
    return;
  }
  const raster =
    placement.kind === "bat" ? sprites?.batPoses.get(placement.key) : sprites?.ball;
  if (raster === undefined) return;
  out.set(raster.data);
  if (placement.kind !== "ball" || occluder === null) return;
  for (let y = 0; y < placement.height; y += 1) {
    for (let x = 0; x < placement.width; x += 1) {
      const at = (y * placement.width + x) * BYTES_PER_PIXEL;
      if ((out[at + 3] ?? 0) === 0) continue;
      if (occluder.blocks(placement.x + x, placement.y + y, placement.level)) out[at + 3] = 0;
    }
  }
}

/** A hollow magenta outline: a box for a bat, a ring for a ball. */
function drawMarker(out: Uint8ClampedArray, width: number, height: number, ring: boolean): void {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const outer = Math.min(cx, cy);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const edge = ring
        ? (() => {
            const dx = x - cx;
            const dy = y - cy;
            const d2 = dx * dx + dy * dy;
            return d2 <= outer * outer && d2 > (outer - 1) * (outer - 1);
          })()
        : x === 0 || y === 0 || x === width - 1 || y === height - 1;
      if (!edge) continue;
      const at = (y * width + x) * BYTES_PER_PIXEL;
      out[at] = FALLBACK_MARKER[0];
      out[at + 1] = FALLBACK_MARKER[1];
      out[at + 2] = FALLBACK_MARKER[2];
      out[at + 3] = 255;
    }
  }
}

/**
 * Composites this frame's placements over a playfield-sized raster.
 *
 * `target` is the frame's own buffer — hand it the shared cached artwork raster
 * and every later frame inherits this frame's bats. Pixels off a sprite are
 * skipped rather than blended: the source has no partial alpha anywhere, which
 * is the whole point.
 */
export function compositeMovingSprites(
  target: PixelTarget,
  sprites: MovingSprites | null,
  placements: readonly SpritePlacement[],
  occluder: StructureOccluder | null = null,
): void {
  let scratch = new Uint8ClampedArray(0);
  for (const placement of placements) {
    const size = placement.width * placement.height * BYTES_PER_PIXEL;
    if (scratch.length < size) scratch = new Uint8ClampedArray(size);
    const face = scratch.subarray(0, size);
    spriteFace(sprites, placement, occluder, face);
    for (let y = 0; y < placement.height; y += 1) {
      const ty = placement.y + y;
      if (ty < 0 || ty >= target.height) continue;
      for (let x = 0; x < placement.width; x += 1) {
        const tx = placement.x + x;
        if (tx < 0 || tx >= target.width) continue;
        const from = (y * placement.width + x) * BYTES_PER_PIXEL;
        if ((face[from + 3] ?? 0) === 0) continue;
        const to = (ty * target.width + tx) * BYTES_PER_PIXEL;
        target.data[to] = face[from] ?? 0;
        target.data[to + 1] = face[from + 1] ?? 0;
        target.data[to + 2] = face[from + 2] ?? 0;
        target.data[to + 3] = 255;
      }
    }
  }
}
