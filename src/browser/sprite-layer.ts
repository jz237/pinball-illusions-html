/**
 * The browser half of the moving sprites: canvases and the per-frame blit.
 *
 * The PIXELS are decided in `src/game/moving-sprites.ts`, which is pure and
 * node-testable; this module only wraps those rasters in canvases and draws the
 * frame's set of them over the playfield with the same blit geometry the
 * playfield and the lamps use.
 *
 * THE LAYERING, and it is the original's own (main.seg00 $4B20 draws the
 * flippers, then the lamps, then the balls last): the artwork raster is
 * blitted, then the lamp overlay, then THIS layer — bats first, balls on top of
 * them. One playfield-sized transparent overlay, cleared each frame and blitted
 * once through `playfieldBlitGeometry`, so the sprites cannot drift off the
 * artwork by a pixel and scroll clipping comes free.
 *
 * At NATIVE resolution every sprite lands on an integer playfield pixel with
 * `imageSmoothingEnabled = false`: at scale S each source pixel becomes a
 * uniform SxS block aligned to the canvas origin, exactly as the original does
 * at S = 2.
 *
 * THE HD PATH (active only when the table's HD sprite set is registered) keeps
 * the same overlay discipline at 4x — a 1344x2400 overlay, xBRZ-upscaled disk
 * sprites — and places them at `(q10 * 4) >> 10`: integer HD pixels in
 * QUARTER-NATIVE-PIXEL steps. Q10 always carried ten fractional bits and the
 * native path floors them all away; at HD two of them finally show, so slow
 * rolls and flipper strokes stop stair-stepping. WHICH pose draws and WHERE
 * the pivot is remain the simulation's own numbers — the sub-pixel remainder
 * changes nothing the physics reads. Ball occlusion samples the same native
 * structure occluder at `floor(hd/4)`, so a ball still disappears under
 * exactly the structures the simulation says cover it.
 *
 * Cached per (map, artwork, bats, ball) identity, as the lamp layer is cached:
 * the sprites never change during play, only which of them draw and where.
 */

import type { TableMap } from "../game/contracts.js";
import { batBlockOrigin, batPoseForStroke } from "../game/flipper-bats.js";
import type { FlipperBats } from "../game/flipper-bats.js";
import {
  buildMovingSprites,
  compositeMovingSprites,
  mapStructureOccluder,
  movingSpritePlacements,
  spriteFace,
} from "../game/moving-sprites.js";
import type {
  BallFrameState,
  BatFrameState,
  MovingSprites,
  SpritePlacement,
  StructureOccluder,
} from "../game/moving-sprites.js";
import type { TableArt } from "../game/table-art.js";
import type { FlipperBatsHd, TableBallHd } from "../game/table-art-hd.js";
import type { TableBall } from "../game/table-ball.js";
import type { CameraState } from "./camera.js";
import { HD_SCALE, q10ToHdPixel } from "./hd-scale.js";
import {
  RASTER_HEIGHT,
  RASTER_WIDTH,
  hdBlitSmoothing,
  playfieldArtwork,
  playfieldArtworkHd,
  playfieldBlitGeometry,
  rasterToCanvas,
} from "./playfield-renderer.js";
import type { BlitContext, PixelTarget } from "./playfield-renderer.js";

/** RGBA, matching `ImageData`. */
const BYTES_PER_PIXEL = 4;

/** The 2d-context slice this module uses. */
interface SpriteContext {
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
  createImageData(sw: number, sh: number): ImageData;
  putImageData(image: ImageData, dx: number, dy: number): void;
}

interface Surface {
  readonly canvas: CanvasImageSource;
  readonly context: SpriteContext;
}

interface SpriteLayer extends Surface {
  readonly artwork: unknown;
  readonly bats: FlipperBats;
  readonly ballDoc: TableBall;
  readonly sprites: MovingSprites;
  readonly occluder: StructureOccluder;
  /** One small canvas per pose, built on first use; a pose never changes. */
  readonly poseCanvases: Map<number, CanvasImageSource>;
  /** Re-uploaded per ball per frame, because structure occlusion moves with it. */
  readonly ballSurface: Surface;
  readonly ballFace: Uint8ClampedArray;
}

/** The HD sprite set for one table: both documents or nothing. */
export interface MovingSpritesHd {
  readonly ball: TableBallHd;
  readonly bats: FlipperBatsHd;
}

interface HdSpriteLayer extends Surface {
  readonly assets: MovingSpritesHd;
  readonly artwork: unknown;
  readonly bats: FlipperBats;
  readonly ballDoc: TableBall;
  readonly sprites: MovingSprites;
  readonly occluder: StructureOccluder;
  readonly poseCanvases: Map<number, CanvasImageSource>;
  readonly ballSurface: Surface;
  readonly ballFace: Uint8ClampedArray;
}

let layers = new WeakMap<TableMap, SpriteLayer>();
let hdAssets = new WeakMap<TableMap, MovingSpritesHd>();
let hdLayers = new WeakMap<TableMap, HdSpriteLayer>();
/** Marker canvases, keyed by kind and size. Only ever used when an asset is absent. */
let markers = new Map<string, CanvasImageSource>();
let markerSurface: Surface | null = null;

/** Drops every cached layer. For tests and for live-swapping a decode. */
export function invalidateSpriteLayers(): void {
  layers = new WeakMap<TableMap, SpriteLayer>();
  hdAssets = new WeakMap<TableMap, MovingSpritesHd>();
  hdLayers = new WeakMap<TableMap, HdSpriteLayer>();
  markers = new Map<string, CanvasImageSource>();
  markerSurface = null;
}

/**
 * Registers (or, with null, withdraws) a table's HD ball and bat atlas.
 *
 * Both or neither: a table with only half its HD sprite set falls back to the
 * native path for both movers rather than mixing resolutions on one overlay.
 */
export function setMovingSpritesHd(map: TableMap, assets: MovingSpritesHd | null): void {
  hdLayers.delete(map);
  if (assets === null) {
    hdAssets.delete(map);
    return;
  }
  hdAssets.set(map, assets);
}

function surfaceOf(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("could not acquire a 2d context for the sprite layer");
    return { canvas, context: context as unknown as SpriteContext };
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("could not acquire a 2d context for the sprite layer");
    return { canvas, context: context as unknown as SpriteContext };
  }
  throw new Error("no canvas implementation available; use compositeMovingSpriteFrame() headless");
}

function nativeSprites(map: TableMap, bats: FlipperBats, ball: TableBall): MovingSprites | null {
  const artwork = playfieldArtwork(map);
  // The registered artwork must be the full decoded `TableArt` — the sprites
  // are palette INDICES and need its palette. A test that registers plain
  // pixels gets the fallback markers rather than sprites in invented colours.
  if (artwork === null || !("indices" in artwork) || !("palette" in artwork)) return null;
  return buildMovingSprites(artwork as TableArt, bats, ball);
}

function layerFor(map: TableMap, bats: FlipperBats, ball: TableBall): SpriteLayer | null {
  const artwork = playfieldArtwork(map);
  if (artwork === null || !("indices" in artwork) || !("palette" in artwork)) return null;
  const cached = layers.get(map);
  if (
    cached !== undefined &&
    cached.artwork === artwork &&
    cached.bats === bats &&
    cached.ballDoc === ball
  ) {
    return cached;
  }
  const sprites = buildMovingSprites(artwork as TableArt, bats, ball);
  const overlay = surfaceOf(RASTER_WIDTH, RASTER_HEIGHT);
  const layer: SpriteLayer = {
    ...overlay,
    artwork,
    bats,
    ballDoc: ball,
    sprites,
    occluder: mapStructureOccluder(map),
    poseCanvases: new Map(),
    ballSurface: surfaceOf(sprites.ball.width, sprites.ball.height),
    ballFace: new Uint8ClampedArray(sprites.ball.width * sprites.ball.height * BYTES_PER_PIXEL),
  };
  layers.set(map, layer);
  return layer;
}

function hdLayerFor(map: TableMap, bats: FlipperBats, ball: TableBall): HdSpriteLayer | null {
  // The HD sprites sit on the HD master; without it the native path draws.
  if (playfieldArtworkHd(map) === null) return null;
  const assets = hdAssets.get(map);
  if (assets === undefined) return null;
  const artwork = playfieldArtwork(map);
  const cached = hdLayers.get(map);
  if (
    cached !== undefined &&
    cached.assets === assets &&
    cached.artwork === artwork &&
    cached.bats === bats &&
    cached.ballDoc === ball
  ) {
    return cached;
  }
  // The native sprite set still decides geometry: pose anchors, the ball's
  // centre, and which pose a stroke selects all come from the same documents
  // the simulation collides on.
  const sprites = nativeSprites(map, bats, ball);
  if (sprites === null) return null;
  const overlay = surfaceOf(RASTER_WIDTH * HD_SCALE, RASTER_HEIGHT * HD_SCALE);
  const layer: HdSpriteLayer = {
    ...overlay,
    assets,
    artwork,
    bats,
    ballDoc: ball,
    sprites,
    occluder: mapStructureOccluder(map),
    poseCanvases: new Map(),
    ballSurface: surfaceOf(assets.ball.width, assets.ball.height),
    ballFace: new Uint8ClampedArray(assets.ball.width * assets.ball.height * BYTES_PER_PIXEL),
  };
  hdLayers.set(map, layer);
  return layer;
}

/** A marker outline as a canvas, cached by kind and size. */
function markerCanvas(placement: SpritePlacement): CanvasImageSource {
  const key = `${placement.kind}:${placement.width}x${placement.height}`;
  const cached = markers.get(key);
  if (cached !== undefined) return cached;
  const face = new Uint8ClampedArray(placement.width * placement.height * BYTES_PER_PIXEL);
  spriteFace(null, placement, null, face);
  const made = rasterToCanvas({ width: placement.width, height: placement.height, data: face });
  markers.set(key, made);
  return made;
}

// ---------------------------------------------------------------------------
// HD placement — the browser-layer counterpart of `movingSpritePlacements`
// ---------------------------------------------------------------------------

/** One HD sprite on the 4x overlay this frame. Whole HD pixels, always. */
export interface HdSpritePlacement {
  readonly kind: "bat" | "ball";
  /** The pose number for a bat, the ball's id for a ball. */
  readonly key: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly level: BallFrameState["level"];
}

/**
 * This frame's HD placements, bats first and balls after — the original's own
 * draw order, exactly as the native `movingSpritePlacements` orders them.
 *
 * Positions floor Q10 in HD units (`q10ToHdPixel`), which is the whole of the
 * sub-pixel dividend; the anchor arithmetic is `batBlockOrigin`'s, scaled.
 * Returns null when any needed pose or record is missing — the caller then
 * uses the NATIVE path, whose magenta markers are the loud fallback — so this
 * function never invents a placement.
 */
export function hdMovingSpritePlacements(
  sprites: MovingSprites,
  assets: MovingSpritesHd,
  batStates: readonly BatFrameState[],
  balls: readonly BallFrameState[],
): HdSpritePlacement[] | null {
  const placements: HdSpritePlacement[] = [];
  for (const bat of batStates) {
    const record = sprites.bats.get(bat.id);
    if (record === undefined) return null;
    const pose = batPoseForStroke(record, bat.stroke, bat.sweep);
    const geometry = sprites.poses.get(pose);
    const cell = assets.bats.cells.get(pose);
    if (geometry === undefined || cell === undefined) return null;
    if (cell.width !== geometry.width * HD_SCALE || cell.height !== geometry.height * HD_SCALE) {
      return null;
    }
    // The simulation's pivot at HD precision, the pose's anchor scaled: the
    // same `pivot - anchor` origin the native path and the physics use.
    const origin = batBlockOrigin(
      { pivotX: q10ToHdPixel(bat.pivotX), pivotY: q10ToHdPixel(bat.pivotY) },
      { ...geometry, anchorX: geometry.anchorX * HD_SCALE, anchorY: geometry.anchorY * HD_SCALE },
    );
    placements.push({
      kind: "bat",
      key: pose,
      x: origin.x,
      y: origin.y,
      width: cell.width,
      height: cell.height,
      level: 0,
    });
  }
  for (const ball of balls) {
    placements.push({
      kind: "ball",
      key: ball.id,
      x: q10ToHdPixel(ball.x) - sprites.ballCentreX * HD_SCALE,
      y: q10ToHdPixel(ball.y) - sprites.ballCentreY * HD_SCALE,
      width: assets.ball.width,
      height: assets.ball.height,
      level: ball.level,
    });
  }
  return placements;
}

/**
 * The HD ball face for one placement: the atlas pixels with every HD pixel
 * whose NATIVE pixel the structure layer covers knocked transparent.
 *
 * `floor(hd / 4)` per HD pixel against the same occluder the native path
 * samples, so occlusion edges step at native granularity while the art under
 * them is smooth — the ball hides under exactly what the simulation says.
 */
export function hdBallFace(
  assets: MovingSpritesHd,
  placement: HdSpritePlacement,
  occluder: StructureOccluder,
  out: Uint8ClampedArray,
): void {
  out.set(assets.ball.data);
  for (let y = 0; y < placement.height; y += 1) {
    const py = Math.floor((placement.y + y) / HD_SCALE);
    for (let x = 0; x < placement.width; x += 1) {
      const at = (y * placement.width + x) * BYTES_PER_PIXEL;
      if ((out[at + 3] ?? 0) === 0) continue;
      if (occluder.blocks(Math.floor((placement.x + x) / HD_SCALE), py, placement.level)) {
        out[at + 3] = 0;
      }
    }
  }
}

/** One pose's pixels sliced out of the HD atlas, cached as a canvas. */
function hdPoseCanvas(layer: HdSpriteLayer, pose: number): CanvasImageSource | null {
  const cached = layer.poseCanvases.get(pose);
  if (cached !== undefined) return cached;
  const cell = layer.assets.bats.cells.get(pose);
  if (cell === undefined) return null;
  const atlas = layer.assets.bats.atlas;
  const data = new Uint8ClampedArray(cell.width * cell.height * BYTES_PER_PIXEL);
  const stride = atlas.width * BYTES_PER_PIXEL;
  for (let y = 0; y < cell.height; y += 1) {
    const from = (cell.y + y) * stride + cell.x * BYTES_PER_PIXEL;
    data.set(atlas.data.subarray(from, from + cell.width * BYTES_PER_PIXEL), y * cell.width * BYTES_PER_PIXEL);
  }
  const canvas = rasterToCanvas({ width: cell.width, height: cell.height, data });
  layer.poseCanvases.set(pose, canvas);
  return canvas;
}

/**
 * Draws this frame's bats and balls. Call after `drawLampOverlays`, with the
 * same map, camera and scale.
 *
 * `batStates` and `balls` are read-only views of simulation state; nothing here
 * writes any of it. When the pose bank or the ball sprite is unavailable the
 * placements come back as MARKERS — magenta outlines — and this function draws
 * those, so a missing asset is loud rather than a plausible-looking substitute.
 * The HD path runs only when the table's full HD sprite set is registered and
 * every pose it needs resolves; anything less falls back to the native path
 * for the whole frame.
 */
export function drawMovingSprites(
  context: BlitContext,
  map: TableMap,
  camera: CameraState,
  scale: number,
  bats: FlipperBats | null,
  ball: TableBall | null,
  batStates: readonly BatFrameState[],
  balls: readonly BallFrameState[],
): void {
  const hd = bats === null || ball === null ? null : hdLayerFor(map, bats, ball);
  if (hd !== null) {
    const placements = hdMovingSpritePlacements(hd.sprites, hd.assets, batStates, balls);
    if (placements !== null) {
      if (placements.length === 0) return;
      hd.context.clearRect(0, 0, RASTER_WIDTH * HD_SCALE, RASTER_HEIGHT * HD_SCALE);
      for (const placement of placements) {
        if (placement.kind === "bat") {
          const canvas = hdPoseCanvas(hd, placement.key);
          if (canvas !== null) hd.context.drawImage(canvas, placement.x, placement.y);
          continue;
        }
        // The ball is cookie-cut against the level's structure layer, so its
        // face changes with its position: one 68x68 upload per ball per frame.
        hdBallFace(hd.assets, placement, hd.occluder, hd.ballFace);
        const image = hd.ballSurface.context.createImageData(placement.width, placement.height);
        image.data.set(hd.ballFace);
        hd.ballSurface.context.putImageData(image, 0, 0);
        hd.context.drawImage(hd.ballSurface.canvas, placement.x, placement.y);
      }
      const geometry = playfieldBlitGeometry(map, camera, scale);
      context.imageSmoothingEnabled = hdBlitSmoothing(camera, scale);
      context.drawImage(
        hd.canvas,
        geometry.sourceX * HD_SCALE,
        geometry.sourceY * HD_SCALE,
        geometry.sourceWidth * HD_SCALE,
        geometry.sourceHeight * HD_SCALE,
        0,
        0,
        geometry.destWidth,
        geometry.destHeight,
      );
      return;
    }
  }

  const layer = bats === null || ball === null ? null : layerFor(map, bats, ball);
  const sprites = layer?.sprites ?? null;
  const placements = movingSpritePlacements(sprites, batStates, balls);
  if (placements.length === 0) return;

  let surface: Surface | null = layer;
  if (surface === null) {
    markerSurface ??= surfaceOf(RASTER_WIDTH, RASTER_HEIGHT);
    surface = markerSurface;
  }
  surface.context.clearRect(0, 0, RASTER_WIDTH, RASTER_HEIGHT);

  for (const placement of placements) {
    if (layer === null || placement.kind === "bat-missing" || placement.kind === "ball-missing") {
      surface.context.drawImage(markerCanvas(placement), placement.x, placement.y);
      continue;
    }
    if (placement.kind === "bat") {
      let canvas = layer.poseCanvases.get(placement.key);
      if (canvas === undefined) {
        const face = new Uint8ClampedArray(placement.width * placement.height * BYTES_PER_PIXEL);
        spriteFace(sprites, placement, null, face);
        canvas = rasterToCanvas({ width: placement.width, height: placement.height, data: face });
        layer.poseCanvases.set(placement.key, canvas);
      }
      surface.context.drawImage(canvas, placement.x, placement.y);
      continue;
    }
    // The ball is cookie-cut against the level's structure layer, so its face
    // changes with its position: one 17x17 upload per ball per frame.
    spriteFace(sprites, placement, layer.occluder, layer.ballFace);
    const image = layer.ballSurface.context.createImageData(placement.width, placement.height);
    image.data.set(layer.ballFace);
    layer.ballSurface.context.putImageData(image, 0, 0);
    surface.context.drawImage(layer.ballSurface.canvas, placement.x, placement.y);
  }

  const geometry = playfieldBlitGeometry(map, camera, scale);
  context.imageSmoothingEnabled = false;
  context.drawImage(
    surface.canvas,
    geometry.sourceX,
    geometry.sourceY,
    geometry.sourceWidth,
    geometry.sourceHeight,
    0,
    0,
    geometry.destWidth,
    geometry.destHeight,
  );
}

/**
 * The headless path: composite this frame's sprites straight into a raster.
 *
 * Same placements, same pixels, no canvas — this is what the pixel-grid test
 * drives, and it is the reason the grid invariant can be asserted in node.
 */
export function compositeMovingSpriteFrame(
  target: PixelTarget,
  map: TableMap,
  sprites: MovingSprites | null,
  batStates: readonly BatFrameState[],
  balls: readonly BallFrameState[],
): void {
  compositeMovingSprites(
    target,
    sprites,
    movingSpritePlacements(sprites, batStates, balls),
    mapStructureOccluder(map),
  );
}
