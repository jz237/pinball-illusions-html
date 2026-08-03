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
 * THE HD PATH keeps the polarity and the geometry and swaps the pixels: the
 * HD master (`playfieldArtworkHd`) is exported all-lit — masked-kind lamps
 * included, forced to their lit faces — and every lamp that is not visibly
 * lit draws its precomputed DIM PATCH from the table's `lamps-hd` atlas onto
 * a 4x overlay. The patches are crops of an identical-settings upscale of the
 * all-dim board, dilated 12 HD px past each lamp's rect — the measured radius
 * beyond which the two upscales are pixel-identical — so compositing them
 * over the master reproduces the true all-dim upscale exactly, seam-free by
 * construction (research/hd/INDEX.txt section 4, pinned by test). WHICH lamp
 * draws on WHICH tick is the same `lampModes`/`lampVisible` decision as the
 * native path: HD changes pixels, never behaviour.
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
import type { LampPatchHd, TableLampsHd } from "../game/table-art-hd.js";
import type { TableLamps } from "../game/table-lamps.js";
import type { CameraState } from "./camera.js";
import { HD_SCALE } from "./hd-scale.js";
import {
  RASTER_HEIGHT,
  RASTER_WIDTH,
  hdBlitSmoothing,
  hdFullTableSmoothing,
  playfieldArtwork,
  playfieldArtworkHd,
  playfieldBlitGeometry,
  playfieldFullTableGeometry,
  rasterToCanvas,
} from "./playfield-renderer.js";
import type { BlitContext } from "./playfield-renderer.js";

/** RGBA, matching `ImageData`. */
const BYTES_PER_PIXEL = 4;

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

interface HdLampLayer {
  readonly lamps: TableLamps;
  readonly doc: TableLampsHd;
  /** One canvas per patch, cut from the atlas once. Parallel to doc.patches. */
  readonly patches: readonly CanvasImageSource[];
  readonly canvas: CanvasImageSource;
  readonly context: OverlayContext;
}

let layers = new WeakMap<TableMap, LampLayer>();
let hdDocs = new WeakMap<TableMap, TableLampsHd>();
let hdLayers = new WeakMap<TableMap, HdLampLayer>();

/** Drops every cached layer. For tests and for live-swapping a decode. */
export function invalidateLampLayers(): void {
  layers = new WeakMap<TableMap, LampLayer>();
  hdDocs = new WeakMap<TableMap, TableLampsHd>();
  hdLayers = new WeakMap<TableMap, HdLampLayer>();
}

/**
 * Registers (or, with null, withdraws) a table's HD dim-patch atlas.
 *
 * Optional exactly as the HD master is optional: with no atlas registered —
 * or no HD master to sit the patches on — the native overlay path below runs
 * unchanged.
 */
export function setLampOverlaysHd(map: TableMap, doc: TableLampsHd | null): void {
  hdLayers.delete(map);
  if (doc === null) {
    hdDocs.delete(map);
    return;
  }
  hdDocs.set(map, doc);
}

function faceCanvas(sprite: LampSprite, face: Uint8ClampedArray | null): CanvasImageSource | null {
  if (face === null || sprite.width === 0 || sprite.height === 0) return null;
  return rasterToCanvas({ width: sprite.width, height: sprite.height, data: face });
}

function overlayCanvas(width: number, height: number): { canvas: CanvasImageSource; context: OverlayContext } {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("could not acquire a 2d context for the lamp layer");
    return { canvas, context };
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
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
  const { canvas, context } = overlayCanvas(RASTER_WIDTH, RASTER_HEIGHT);
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

/** One patch's pixels sliced out of the atlas image. */
function patchCanvas(doc: TableLampsHd, patch: LampPatchHd): CanvasImageSource {
  const data = new Uint8ClampedArray(patch.width * patch.height * BYTES_PER_PIXEL);
  const stride = doc.atlas.width * BYTES_PER_PIXEL;
  for (let y = 0; y < patch.height; y += 1) {
    const from = (patch.atlasY + y) * stride + patch.atlasX * BYTES_PER_PIXEL;
    data.set(doc.atlas.data.subarray(from, from + patch.width * BYTES_PER_PIXEL), y * patch.width * BYTES_PER_PIXEL);
  }
  return rasterToCanvas({ width: patch.width, height: patch.height, data });
}

function hdLayerFor(map: TableMap, lamps: TableLamps): HdLampLayer | null {
  // Patches are crops that agree with the HD master along their edges; over
  // any other picture they would be visible rectangles. No master, no patches.
  if (playfieldArtworkHd(map) === null) return null;
  const doc = hdDocs.get(map);
  if (doc === undefined) return null;
  const cached = hdLayers.get(map);
  if (cached !== undefined && cached.lamps === lamps && cached.doc === doc) return cached;
  const { canvas, context } = overlayCanvas(RASTER_WIDTH * HD_SCALE, RASTER_HEIGHT * HD_SCALE);
  const layer: HdLampLayer = {
    lamps,
    doc,
    patches: doc.patches.map((patch) => patchCanvas(doc, patch)),
    canvas,
    context,
  };
  hdLayers.set(map, layer);
  return layer;
}

/**
 * Draws this frame's lamp overlays. Call immediately after `drawPlayfield`,
 * with the same map, camera and scale.
 *
 * Reads the mode VM's state and the tick; writes pixels; touches neither. A
 * null `modeState` (a table with no mission layer) draws every lamp dim,
 * which is the idle machine's true face.
 *
 * `fullTable` selects the presentation-layer full-table framing, exactly as it
 * does on `drawPlayfield`: full-source geometry, camera unread. WHICH lamps
 * draw is identical in both framings — the framing changes geometry, never
 * behaviour.
 */
export function drawLampOverlays(
  context: BlitContext,
  map: TableMap,
  camera: CameraState,
  scale: number,
  lamps: TableLamps,
  modeState: ModeState | null,
  tick: number,
  fullTable = false,
): void {
  const modes = lampModes(lamps, modeState);

  const hd = hdLayerFor(map, lamps);
  if (hd !== null) {
    hd.context.clearRect(0, 0, RASTER_WIDTH * HD_SCALE, RASTER_HEIGHT * HD_SCALE);
    for (let i = 0; i < hd.doc.patches.length; i += 1) {
      const patch = hd.doc.patches[i];
      const face = hd.patches[i];
      if (patch === undefined || face === undefined) continue;
      // The master is all-lit, masked kinds included, so EVERY kind of lamp
      // draws only when not visibly lit — the uniform HD polarity.
      if (lampVisible(modes[patch.index] ?? 0, tick, lamps.blinkHalfPeriodFrames)) continue;
      hd.context.drawImage(face, patch.destX, patch.destY);
    }
    const geometry = fullTable
      ? playfieldFullTableGeometry(map, scale)
      : playfieldBlitGeometry(map, camera, scale);
    context.imageSmoothingEnabled = fullTable
      ? hdFullTableSmoothing(scale)
      : hdBlitSmoothing(camera, scale);
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

  const layer = layerFor(map, lamps);
  if (layer === null) return;

  layer.context.clearRect(0, 0, RASTER_WIDTH, RASTER_HEIGHT);
  for (const sprite of layer.sprites) {
    const visible = lampVisible(modes[sprite.index] ?? 0, tick, lamps.blinkHalfPeriodFrames);
    const face = visible ? layer.onFaces[sprite.index] : layer.offFaces[sprite.index];
    if (face === undefined || face === null) continue;
    layer.context.drawImage(face, sprite.x, sprite.y);
  }

  const geometry = fullTable
    ? playfieldFullTableGeometry(map, scale)
    : playfieldBlitGeometry(map, camera, scale);
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
