/**
 * Procedural playfield renderer.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DRAWS, AND FROM WHAT
 * ---------------------------------------------------------------------------
 * There is no extracted artwork in this project and there is not going to be.
 * The only table data that exists is the four-layer material map out of slot 2
 * — 336x600 pixels, four one-bit layers OR'd into an index 0..15 — and this
 * module turns that, and only that, into the picture of the table.
 *
 * The rule that makes it work: DRAW BY BIT MEANING, NEVER BY RAW INDEX. The 16
 * indices are not 16 materials, they are the 16 combinations of four
 * independent layers, so switching on the index would mean sixteen unrelated
 * cases where there are really four overlapping ones. Concretely:
 *
 *   bit 2 (4)  lower structure  -> a filled body: the furniture on the deck
 *   bit 0 (1)  lower collision  -> the lit edge drawn around those bodies
 *   bit 3 (8)  upper structure  -> the raised deck, which OCCLUDES the above
 *   bit 1 (2)  upper collision  -> the rail running along that raised deck
 *   none       -> bare playfield
 *
 * Painter's order is therefore lower body, lower edge, ramp drop shadow, raised
 * deck, upper rail. The occlusion is not a stylistic choice: bit 3 is used by
 * the original as an AND-NOT mask in the ball blitter (main +0x00bf3c), i.e. it
 * is precisely the region where the upper level is drawn *over* whatever is
 * beneath, ball included. Honouring that is what makes a ramp read as a ramp.
 *
 * ---------------------------------------------------------------------------
 * WHY IT LOOKS CHUNKY ON PURPOSE
 * ---------------------------------------------------------------------------
 * Everything is rasterised once at 336x600 logical pixels — one raster pixel per
 * map pixel, no supersampling, no anti-aliasing — and the caller blits it with
 * an INTEGER scale factor and `imageSmoothingEnabled = false`. Bilinear
 * upscaling would smear the 1-pixel collision outlines into mush and lose the
 * one thing that dates the look correctly. `integerScaleFor()` and
 * `drawPlayfield()` exist so no call site has to remember that.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS CACHED
 * ---------------------------------------------------------------------------
 * The map never changes during play, so the 201,600-pixel raster is built once
 * per table and blitted per frame. `invalidatePlayfieldRaster()` drops it, for
 * live palette tuning.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DOES NOT REQUIRE A CANVAS
 * ---------------------------------------------------------------------------
 * The pixel-producing half takes a plain `{ width, height, data }` target rather
 * than a real `ImageData`, so the entire look is assertable in node with no DOM.
 * Only the small blit half at the bottom of the file touches canvas APIs.
 */

import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../game/contracts.js";
import type { TableMap } from "../game/contracts.js";
import {
  LEVEL0_SOLID_BIT,
  LEVEL0_STRUCTURE_BIT,
  LEVEL1_SOLID_BIT,
  LEVEL1_STRUCTURE_BIT,
} from "../game/materials.js";
import { VIEWPORT_HEIGHT, clampScroll, toViewportSize } from "./camera.js";
import type { CameraState } from "./camera.js";
import {
  DECK_DARK,
  DECK_LIGHT,
  LOWER_EDGE_DIM,
  LOWER_EDGE_LIT,
  RAMP_BODY,
  RAMP_DARK,
  RAMP_LIGHT,
  RAMP_SHADOW_OFFSET_X,
  RAMP_SHADOW_OFFSET_Y,
  RAMP_SHADOW_STRENGTH,
  STRUCTURE_BODY,
  STRUCTURE_DARK,
  STRUCTURE_LIGHT,
  UPPER_RAIL_DIM,
  UPPER_RAIL_LIT,
  shade,
} from "./palette.js";
import type { Rgb } from "./palette.js";

/** RGBA, matching `ImageData`. */
export const BYTES_PER_PIXEL = 4;

/**
 * The slice of `ImageData` the rasteriser needs.
 *
 * A real `ImageData` satisfies this, and so does a plain object, which is the
 * point: node tests construct one with `createPixelTarget()` and read colours
 * straight back out. `data` is row-major RGBA, length width*height*4.
 */
export interface PixelTarget {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** An opaque, all-black target of the given size. */
export function createPixelTarget(width: number, height: number): PixelTarget {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`pixel target must have positive integer dimensions, got ${width}x${height}`);
  }
  const data = new Uint8ClampedArray(width * height * BYTES_PER_PIXEL);
  for (let i = 3; i < data.length; i += BYTES_PER_PIXEL) {
    data[i] = 255;
  }
  return { width, height, data };
}

// ---------------------------------------------------------------------------
// Deck dithering
// ---------------------------------------------------------------------------

/**
 * Ordered 4x4 Bayer thresholds, flattened.
 *
 * A two-colour ordered dither is how a 1990s Amiga artist drew a gradient on a
 * tight palette, and it is stable under integer scaling in a way that a noise
 * dither is not — the pattern stays a pattern instead of turning into grain.
 * Flat rather than nested so `noUncheckedIndexedAccess` costs one `?? 0`
 * instead of two.
 */
const BAYER_4X4: readonly number[] = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

/**
 * Bare playfield tone at a point.
 *
 * Darkens toward the top of the table, so the bottom third — where the ball
 * spends its life and where the flippers are — is the brightest part of the
 * deck. Purely a function of (x, y, height): no state, no randomness.
 */
function deckToneAt(x: number, y: number, height: number): Rgb {
  const span = height > 1 ? height - 1 : 1;
  const threshold = BAYER_4X4[(y & 3) * 4 + (x & 3)] ?? 0;
  // 16 levels across the table; `>` rather than `>=` keeps row 0 fully dark.
  return (y * 16) / span > threshold ? DECK_LIGHT : DECK_DARK;
}

// ---------------------------------------------------------------------------
// Per-pixel classification
// ---------------------------------------------------------------------------

function bitsAt(map: TableMap, x: number, y: number): number {
  // `materialAt` is the contract's accessor and already answers out-of-bounds
  // reads with the solid border material, so bodies that run off the edge of the
  // bitmap get bevelled against it instead of needing a special case here.
  return map.materialAt(x, y);
}

/** True when the raised deck is overhead at this exact pixel. */
function isRamp(map: TableMap, x: number, y: number): boolean {
  return (bitsAt(map, x, y) & LEVEL1_STRUCTURE_BIT) !== 0;
}

/**
 * Simple two-face bevel for a filled body.
 *
 * The body gets its light tone on the row where it meets open space above, its
 * dark tone where it meets open space below, and its body tone in between. Top
 * and bottom only, no side faces: at 336 pixels wide most of these bodies are a
 * few pixels across, and a four-sided bevel would leave no body tone at all.
 */
function bevel(map: TableMap, x: number, y: number, bit: number, light: Rgb, body: Rgb, dark: Rgb): Rgb {
  if ((bitsAt(map, x, y - 1) & bit) === 0) return light;
  if ((bitsAt(map, x, y + 1) & bit) === 0) return dark;
  return body;
}

/** Everything that counts as "inside the shape" on each level, for `lineTone`. */
const LEVEL0_MASS = LEVEL0_SOLID_BIT | LEVEL0_STRUCTURE_BIT;
const LEVEL1_MASS = LEVEL1_SOLID_BIT | LEVEL1_STRUCTURE_BIT;

/**
 * Two-tone shading for a collision line.
 *
 * A collision line is one pixel wide, so it cannot be bevelled like a body: both
 * of its vertical neighbours are usually outside it. What decides whether a
 * given pixel of the line is a lit top edge or a shaded underside is which side
 * the SHAPE is on, and the structure layer is what says where the shape is. So:
 * dim only where the mass sits above the line and open space below it — the
 * bottom of a slingshot, the underside of a lane guide. Everything else,
 * including a free-standing line with nothing either side of it, stays lit,
 * because these outlines are the most important thing on the table to see.
 */
function lineTone(map: TableMap, x: number, y: number, mask: number, lit: Rgb, dim: Rgb): Rgb {
  const massAbove = (bitsAt(map, x, y - 1) & mask) !== 0;
  const massBelow = (bitsAt(map, x, y + 1) & mask) !== 0;
  return massAbove && !massBelow ? dim : lit;
}

/**
 * The colour of one playfield pixel.
 *
 * Pure: same map and coordinates always give the same colour, which is what
 * lets the raster be cached forever and compared byte-for-byte in tests.
 */
export function playfieldColourAt(map: TableMap, x: number, y: number): Rgb {
  const bits = bitsAt(map, x, y);

  // Upper level first, because it is drawn over everything below it.
  if ((bits & LEVEL1_SOLID_BIT) !== 0) {
    return lineTone(map, x, y, LEVEL1_MASS, UPPER_RAIL_LIT, UPPER_RAIL_DIM);
  }
  if ((bits & LEVEL1_STRUCTURE_BIT) !== 0) {
    return bevel(map, x, y, LEVEL1_STRUCTURE_BIT, RAMP_LIGHT, RAMP_BODY, RAMP_DARK);
  }

  // Lower level: edge over body over bare deck.
  let colour: Rgb;
  if ((bits & LEVEL0_SOLID_BIT) !== 0) {
    colour = lineTone(map, x, y, LEVEL0_MASS, LOWER_EDGE_LIT, LOWER_EDGE_DIM);
  } else if ((bits & LEVEL0_STRUCTURE_BIT) !== 0) {
    colour = bevel(map, x, y, LEVEL0_STRUCTURE_BIT, STRUCTURE_LIGHT, STRUCTURE_BODY, STRUCTURE_DARK);
  } else {
    colour = deckToneAt(x, y, map.height);
  }

  // The raised deck throws a hard offset shadow onto whatever is under it.
  if (isRamp(map, x - RAMP_SHADOW_OFFSET_X, y - RAMP_SHADOW_OFFSET_Y)) {
    colour = shade(colour, RAMP_SHADOW_STRENGTH);
  }
  return colour;
}

// ---------------------------------------------------------------------------
// Rasterising
// ---------------------------------------------------------------------------

/**
 * Draws the whole static playfield into `target`, which must match the map's
 * dimensions exactly — one raster pixel per map pixel is the entire basis of
 * the chunky look, so a size mismatch is a bug, not something to scale around.
 *
 * Returns the target for convenience. Alpha is forced opaque: this is the
 * bottom layer of the frame and there is nothing behind it.
 */
export function renderPlayfieldInto(map: TableMap, target: PixelTarget): PixelTarget {
  if (target.width !== map.width || target.height !== map.height) {
    throw new RangeError(
      `render target is ${target.width}x${target.height} but the map is ${map.width}x${map.height}; the playfield rasterises 1:1`,
    );
  }
  const expected = map.width * map.height * BYTES_PER_PIXEL;
  if (target.data.length !== expected) {
    throw new RangeError(
      `render target has ${target.data.length} bytes, expected ${expected} for ${map.width}x${map.height} RGBA`,
    );
  }

  const data = target.data;
  let offset = 0;
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const colour = playfieldColourAt(map, x, y);
      data[offset] = colour[0];
      data[offset + 1] = colour[1];
      data[offset + 2] = colour[2];
      data[offset + 3] = 255;
      offset += BYTES_PER_PIXEL;
    }
  }
  return target;
}

/** Rasterises a map into a freshly allocated target. */
export function renderPlayfield(map: TableMap): PixelTarget {
  return renderPlayfieldInto(map, createPixelTarget(map.width, map.height));
}

// ---------------------------------------------------------------------------
// The static cache
// ---------------------------------------------------------------------------

// Keyed by map identity rather than table id: a reloaded or re-exported map is a
// different object and must not silently reuse the previous table's pixels.
let rasterCache = new WeakMap<TableMap, PixelTarget>();
let sourceCache = new WeakMap<TableMap, CanvasImageSource>();

/**
 * The cached raster for a map, built on first use.
 *
 * Returns the same object every time, so callers may compare by identity. The
 * buffer is shared — treat it as read-only; mutate it and every later frame
 * inherits the damage.
 */
export function playfieldRaster(map: TableMap): PixelTarget {
  const cached = rasterCache.get(map);
  if (cached !== undefined) {
    return cached;
  }
  const raster = renderPlayfield(map);
  rasterCache.set(map, raster);
  return raster;
}

/**
 * Drops cached pixels so the next frame rebuilds them.
 *
 * With no argument it clears everything, which is the palette-tuning path: edit
 * a constant, call this, and the new look appears without a reload.
 */
export function invalidatePlayfieldRaster(map?: TableMap): void {
  if (map === undefined) {
    rasterCache = new WeakMap<TableMap, PixelTarget>();
    sourceCache = new WeakMap<TableMap, CanvasImageSource>();
    return;
  }
  rasterCache.delete(map);
  sourceCache.delete(map);
}

// ---------------------------------------------------------------------------
// Blitting (the only part that needs a browser)
// ---------------------------------------------------------------------------

/**
 * Largest whole-number magnification that still fits the viewport in the space
 * available, never below 1.
 *
 * Whole numbers only. A fractional scale means some source pixels cover more
 * output pixels than their neighbours, which at this resolution is instantly
 * visible as wobbling rails — worse than a slightly smaller picture.
 */
export function integerScaleFor(availableWidth: number, availableHeight: number): number {
  const horizontal = Math.floor(availableWidth / PLAYFIELD_WIDTH);
  const vertical = Math.floor(availableHeight / VIEWPORT_HEIGHT);
  const fit = Math.min(horizontal, vertical);
  return Number.isFinite(fit) && fit >= 1 ? fit : 1;
}

/** Where to read from the raster and how big to draw it. All in pixels. */
export interface BlitGeometry {
  readonly sourceX: number;
  readonly sourceY: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly destWidth: number;
  readonly destHeight: number;
}

/**
 * Resolves the camera into a source rectangle and an output size.
 *
 * Scrolling mode shows the viewport-sized window the camera settled on;
 * whole-table mode shows all 600 rows and lets the camera's own scale shrink
 * them to fit. `clampScroll` is reapplied because a caller may hand us a
 * hand-built camera state that never went through `updateCamera`.
 *
 * Split out of `drawPlayfield` and pure, so the geometry is testable without a
 * canvas — which is where the off-by-one bugs in a scrolling blit actually live.
 */
export function playfieldBlitGeometry(map: TableMap, camera: CameraState, scale: number): BlitGeometry {
  const full = camera.mode === "full-table";
  const sourceY = full ? 0 : clampScroll(camera.scrollY);
  const sourceHeight = full ? map.height : Math.min(VIEWPORT_HEIGHT, map.height);
  // The camera owns the mapping from playfield pixels to the 336x256 window;
  // `scale` only magnifies that window onto the real canvas.
  //
  // `toViewportSize`, not `toViewport`: these are a width and a height, and a
  // size is a difference between two points, so the scroll offset must not be
  // applied to it. Routing them through the position transform subtracted
  // `scrollY` from the height and shrank the blit by the scroll distance —
  // 112 px instead of 512 at the bottom of the table.
  const size = toViewportSize(camera, map.width, sourceHeight);
  return {
    sourceX: 0,
    sourceY,
    sourceWidth: map.width,
    sourceHeight,
    destWidth: size.x * scale,
    destHeight: size.y * scale,
  };
}

/**
 * Uploads a raster to a canvas of its own.
 *
 * `OffscreenCanvas` when the runtime has it — the raster is a background asset
 * and has no business being in the document — falling back to a detached
 * `<canvas>` element, which is what Safari needed for most of this project's
 * life. The two canvas types have incompatible `getContext` overloads, so each
 * branch keeps its own concrete type instead of unioning them first.
 */
/** The two context methods the upload needs, shared by both canvas flavours. */
interface RasterUploadContext {
  createImageData(sw: number, sh: number): ImageData;
  putImageData(image: ImageData, dx: number, dy: number): void;
}

/**
 * Copies a raster into a 2d context.
 *
 * Goes through `createImageData` and `set` rather than `new ImageData(data, …)`
 * because the constructor insists on a `Uint8ClampedArray` backed by a plain
 * `ArrayBuffer`, and `PixelTarget` deliberately does not promise which kind of
 * buffer it holds — the target may well have come from somewhere else.
 */
function uploadRaster(context: RasterUploadContext, raster: PixelTarget): void {
  const image = context.createImageData(raster.width, raster.height);
  image.data.set(raster.data);
  context.putImageData(image, 0, 0);
}

function rasterToCanvas(raster: PixelTarget): CanvasImageSource {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(raster.width, raster.height);
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("could not acquire a 2d context for the playfield raster");
    }
    uploadRaster(context, raster);
    return canvas;
  }

  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = raster.width;
    canvas.height = raster.height;
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("could not acquire a 2d context for the playfield raster");
    }
    uploadRaster(context, raster);
    return canvas;
  }

  throw new Error("no canvas implementation available; use renderPlayfield() for headless rasterising");
}

/**
 * The cached raster as something `drawImage` accepts.
 *
 * Kept separate from `playfieldRaster` so the pixel half of this module stays
 * usable with no DOM at all; only this function needs a canvas to exist.
 */
export function playfieldImageSource(map: TableMap): CanvasImageSource {
  const cached = sourceCache.get(map);
  if (cached !== undefined) {
    return cached;
  }
  const source = rasterToCanvas(playfieldRaster(map));
  sourceCache.set(map, source);
  return source;
}

/** The bit of a 2d context this module uses, so a fake can stand in for it. */
export interface BlitContext {
  imageSmoothingEnabled: boolean;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/**
 * Blits the cached playfield for the current camera.
 *
 * `scale` is the integer magnification from `integerScaleFor`; the camera's own
 * scale (1 while scrolling, 256/600 in whole-table mode) is applied on top of it
 * via `toViewport`, so this function never second-guesses the camera about how
 * much of the table is on screen.
 *
 * Smoothing is disabled on every call rather than once at setup, because a
 * context is shared with whatever else draws this frame and any of them may
 * have turned it back on.
 */
export function drawPlayfield(
  context: BlitContext,
  map: TableMap,
  camera: CameraState,
  scale: number,
): void {
  const geometry = playfieldBlitGeometry(map, camera, scale);
  context.imageSmoothingEnabled = false;
  context.drawImage(
    playfieldImageSource(map),
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

/** The logical raster size, restated here so blit code need not import contracts. */
export const RASTER_WIDTH = PLAYFIELD_WIDTH;
export const RASTER_HEIGHT = PLAYFIELD_HEIGHT;
