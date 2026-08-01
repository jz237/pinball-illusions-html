/**
 * The browser half of the lamp overlays: canvases and the per-frame blit.
 *
 * The PIXELS are decided in `src/game/lamp-overlays.ts`, which is pure and
 * node-testable; this module only wraps those sprites in canvases and draws
 * the frame's set of them over the playfield with the same blit geometry the
 * playfield itself uses.
 *
 * THE LAYERING: the cached playfield raster shows every insert LIT (that is
 * what the disk's artwork stores), so this layer draws the DIM overlays of
 * every lamp that is not visibly lit this frame, plus the current face of the
 * masked-image lamps. The overlays are drawn into a playfield-sized
 * transparent canvas at native resolution and that canvas is blitted with
 * `playfieldBlitGeometry` — one shared piece of camera arithmetic, so the
 * overlay cannot drift off the artwork by even a pixel, and clipping in
 * scrolled view comes free.
 *
 * Cached per (map, artwork, lamps) identity, exactly as the playfield raster
 * is cached per map: the sprites never change during play, only which of them
 * draw.
 */

import type { TableMap } from "../game/contracts.js";
import { buildLampSprites, lampModes, lampVisible } from "../game/lamp-overlays.js";
import type { LampSprite } from "../game/lamp-overlays.js";
import type { ModeState } from "../game/mode-vm.js";
import type { TableArt } from "../game/table-art.js";
import type { TableLamps } from "../game/table-lamps.js";
import type { CameraState } from "./camera.js";
import {
  RASTER_HEIGHT,
  RASTER_WIDTH,
  playfieldArtwork,
  playfieldBlitGeometry,
  rasterToCanvas,
} from "./playfield-renderer.js";
import type { BlitContext } from "./playfield-renderer.js";

/** The 2d-context slice the overlay canvas needs. */
interface OverlayContext {
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
}

interface LampLayer {
  readonly lamps: TableLamps;
  readonly artwork: unknown;
  readonly sprites: readonly LampSprite[];
  /** One small canvas per sprite face; null where that face never draws. */
  readonly offFaces: readonly (CanvasImageSource | null)[];
  readonly onFaces: readonly (CanvasImageSource | null)[];
  readonly canvas: CanvasImageSource;
  readonly context: OverlayContext;
}

let layers = new WeakMap<TableMap, LampLayer>();

/** Drops every cached layer. For tests and for live-swapping a decode. */
export function invalidateLampLayers(): void {
  layers = new WeakMap<TableMap, LampLayer>();
}

function faceCanvas(sprite: LampSprite, face: Uint8ClampedArray | null): CanvasImageSource | null {
  if (face === null || sprite.width === 0 || sprite.height === 0) return null;
  return rasterToCanvas({ width: sprite.width, height: sprite.height, data: face });
}

function overlayCanvas(): { canvas: CanvasImageSource; context: OverlayContext } {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(RASTER_WIDTH, RASTER_HEIGHT);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("could not acquire a 2d context for the lamp layer");
    return { canvas, context };
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = RASTER_WIDTH;
    canvas.height = RASTER_HEIGHT;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("could not acquire a 2d context for the lamp layer");
    return { canvas, context };
  }
  throw new Error("no canvas implementation available; use compositeLampOverlays() headless");
}

function layerFor(map: TableMap, lamps: TableLamps): LampLayer | null {
  const artwork = playfieldArtwork(map);
  // The registered artwork must be the full decoded `TableArt` — the dim
  // overlays are computed from its palette INDICES, which a bare RGBA
  // `PixelTarget` does not carry. `main.ts` always registers the real thing; a
  // test that registers plain pixels simply gets no overlays rather than
  // overlays derived from invented indices.
  if (artwork === null || !("indices" in artwork) || !("palette" in artwork)) return null;
  const cached = layers.get(map);
  if (cached !== undefined && cached.lamps === lamps && cached.artwork === artwork) return cached;
  const sprites = buildLampSprites(artwork as TableArt, lamps);
  const { canvas, context } = overlayCanvas();
  const layer: LampLayer = {
    lamps,
    artwork,
    sprites,
    offFaces: sprites.map((sprite) => faceCanvas(sprite, sprite.off)),
    onFaces: sprites.map((sprite) => faceCanvas(sprite, sprite.on)),
    canvas,
    context,
  };
  layers.set(map, layer);
  return layer;
}

/**
 * Draws this frame's lamp overlays. Call immediately after `drawPlayfield`,
 * with the same map, camera and scale.
 *
 * Reads the mode VM's state and the tick; writes pixels; touches neither. A
 * null `modeState` (a table with no mission layer) draws every lamp dim,
 * which is the idle machine's true face.
 */
export function drawLampOverlays(
  context: BlitContext,
  map: TableMap,
  camera: CameraState,
  scale: number,
  lamps: TableLamps,
  modeState: ModeState | null,
  tick: number,
): void {
  const layer = layerFor(map, lamps);
  if (layer === null) return;

  const modes = lampModes(lamps, modeState);
  layer.context.clearRect(0, 0, RASTER_WIDTH, RASTER_HEIGHT);
  for (const sprite of layer.sprites) {
    const visible = lampVisible(modes[sprite.index] ?? 0, tick, lamps.blinkHalfPeriodFrames);
    const face = visible ? layer.onFaces[sprite.index] : layer.offFaces[sprite.index];
    if (face === undefined || face === null) continue;
    layer.context.drawImage(face, sprite.x, sprite.y);
  }

  const geometry = playfieldBlitGeometry(map, camera, scale);
  context.imageSmoothingEnabled = false;
  context.drawImage(
    layer.canvas,
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
