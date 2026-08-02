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
 * them. One playfield-sized transparent overlay at NATIVE resolution, cleared
 * each frame and blitted once through `playfieldBlitGeometry`, so the sprites
 * cannot drift off the artwork by a pixel and scroll clipping comes free.
 *
 * Every sprite is drawn at an integer playfield pixel with
 * `imageSmoothingEnabled = false`, which is the whole point: at scale S each
 * source pixel becomes a uniform SxS block aligned to the canvas origin, exactly
 * as the original does at S = 2.
 *
 * Cached per (map, artwork, bats, ball) identity, as the lamp layer is cached:
 * the sprites never change during play, only which of them draw and where.
 */

import type { TableMap } from "../game/contracts.js";
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
import type { TableBall } from "../game/table-ball.js";
import type { CameraState } from "./camera.js";
import {
  RASTER_HEIGHT,
  RASTER_WIDTH,
  playfieldArtwork,
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

let layers = new WeakMap<TableMap, SpriteLayer>();
/** Marker canvases, keyed by kind and size. Only ever used when an asset is absent. */
let markers = new Map<string, CanvasImageSource>();
let markerSurface: Surface | null = null;

/** Drops every cached layer. For tests and for live-swapping a decode. */
export function invalidateSpriteLayers(): void {
  layers = new WeakMap<TableMap, SpriteLayer>();
  markers = new Map<string, CanvasImageSource>();
  markerSurface = null;
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

function layerFor(map: TableMap, bats: FlipperBats, ball: TableBall): SpriteLayer | null {
  const artwork = playfieldArtwork(map);
  // The registered artwork must be the full decoded `TableArt` — the sprites
  // are palette INDICES and need its palette. A test that registers plain
  // pixels gets the fallback markers rather than sprites in invented colours.
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

/**
 * Draws this frame's bats and balls. Call after `drawLampOverlays`, with the
 * same map, camera and scale.
 *
 * `batStates` and `balls` are read-only views of simulation state; nothing here
 * writes any of it. When the pose bank or the ball sprite is unavailable the
 * placements come back as MARKERS — magenta outlines — and this function draws
 * those, so a missing asset is loud rather than a plausible-looking substitute.
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
