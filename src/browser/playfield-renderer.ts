/**
 * Playfield renderer.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DRAWS, AND FROM WHAT
 * ---------------------------------------------------------------------------
 * The picture on screen is the 1995 artwork out of slot 3 of the table package:
 * a 336x600 256-colour AGA playfield, decoded off the operator's own disks by
 * `scripts/export-table-art.mjs`, shipped as `<table-id>.art.png`, and loaded by
 * `src/game/table-art.ts`. This module blits those pixels and nothing else.
 *
 * It used to draw the collision map instead — a procedural wireframe of cyan and
 * yellow lines on near-black, invented here out of the four material bits. That
 * looked nothing like Pinball Illusions, and it shipped, because the tests only
 * ever asserted that the output was DETERMINISTIC. A wrong picture is perfectly
 * deterministic. `tests/playfield-renderer.test.ts` now compares the rendered
 * pixels against the exported artwork itself; keep it that way.
 *
 * THE COLLISION MAP IS NOT DRAWN. Slot 2 is physics and only physics. Nothing in
 * this file reads `materialAt`, and if something here ever does again, the
 * picture has started disagreeing with the disk.
 *
 * ---------------------------------------------------------------------------
 * REGISTRATION
 * ---------------------------------------------------------------------------
 * The artwork and the collision geometry are two independent rasters of one
 * table and they must line up, or the ball bounces off walls the player cannot
 * see. `ART_REGISTRATION_OFFSET_X/Y` is the single place that relationship is
 * expressed — see the constants for the measurement and for the outstanding
 * discrepancy in the shipped maps.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS CHUNKY ON PURPOSE
 * ---------------------------------------------------------------------------
 * The raster is one pixel per source pixel — no supersampling, no resampling —
 * and the caller blits it at an INTEGER magnification with
 * `imageSmoothingEnabled = false`. Bilinear upscaling would smear a 336-pixel
 * AGA playfield into mush and lose the one thing that dates the look correctly.
 * `integerScaleFor()` and `drawPlayfield()` exist so no call site has to
 * remember that.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS CACHED
 * ---------------------------------------------------------------------------
 * The artwork never changes during play, so the 201,600-pixel raster is built
 * once per table and blitted per frame. `invalidatePlayfieldRaster()` drops it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DOES NOT REQUIRE A CANVAS
 * ---------------------------------------------------------------------------
 * The pixel-producing half takes and returns a plain `{ width, height, data }`
 * target rather than a real `ImageData`, and the artwork arrives as decoded
 * pixels rather than as something only a browser can open, so the whole picture
 * is assertable in node with no DOM. Only the small blit half at the bottom of
 * the file touches canvas APIs.
 */

import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../game/contracts.js";
import type { TableMap } from "../game/contracts.js";
import { VIEWPORT_HEIGHT, clampScroll, toViewportSize } from "./camera.js";
import type { CameraState } from "./camera.js";
import { HD_SCALE } from "./hd-scale.js";
import { CABINET_BLACK } from "./palette.js";

/** RGBA, matching `ImageData`. */
export const BYTES_PER_PIXEL = 4;

/**
 * The slice of `ImageData` the rasteriser needs.
 *
 * A real `ImageData` satisfies this, and so does a plain object, and so does the
 * `TableArt` the loader produces — which is the point: node tests build one,
 * pass it in, and read colours straight back out. `data` is row-major RGBA,
 * length width*height*4.
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
// Registration
// ---------------------------------------------------------------------------

/**
 * How far the artwork has to move, in playfield pixels, to sit over the
 * collision geometry the physics reads. Positive x is right, positive y is down.
 *
 * ZERO, and measured rather than assumed. Slot 2 and slot 3 are stored as two
 * separate rasters with no shared origin, so "they line up" is a claim that has
 * to be tested. The test: take the boundary of the structure layer (bit 2 of the
 * map — the drawn edge of every body on the table, and the one probe with no
 * ball-radius bias), and measure the mean colour-gradient magnitude of the
 * artwork under it, as a multiple of the gradient over the whole playfield. A
 * probe sitting on drawn edges scores well above 1; a probe sitting on flat
 * paint scores 1. Swept over dx in -40..+40 against the shipped maps, the peak
 * is at dx = 0 on all three tables and it is sharp: lift 2.31 / 2.53 / 2.15 at
 * zero, 1.88..2.13 one pixel either side, and down to about 1.2 by two pixels.
 * Three independently exported tables agreeing to the pixel is not a
 * coincidence.
 *
 * WHY THIS IS MEASURED AND NOT ASSUMED. That sweep used to peak at dx = +32,
 * because `scripts/export-table-maps.mjs` read the slot-2 payload from byte 8
 * when the segment's four unused bytes are at the END of the file, not after the
 * length word (Table002's slot-2 payload has real data — 0xFFFFFFFF, the top
 * border line — at bytes 4..7 and four zero bytes at the end). Four bytes of a
 * 1-bpp row is exactly 32 pixels, so every wall on every table sat 32 px left of
 * the paint. That is the same phase mistake documented at the top of
 * `scripts/export-table-art.mjs`, and it was fixed in the exporter — the right
 * place — rather than compensated for here: a -32 in this file would have drawn
 * a correct picture in the wrong place and buried the bug in the geometry the
 * physics reads. If this constant is ever non-zero, treat it as evidence that
 * something upstream is framed wrong again.
 */
export const ART_REGISTRATION_OFFSET_X = 0;
export const ART_REGISTRATION_OFFSET_Y = 0;

// ---------------------------------------------------------------------------
// Rasterising
// ---------------------------------------------------------------------------

/**
 * Draws the artwork into `target`, registered onto the playfield's coordinates.
 *
 * `target` must be exactly playfield-sized — one raster pixel per playfield
 * pixel is the entire basis of the chunky look, so a size mismatch is a bug, not
 * something to scale around. Any part of the target the artwork does not cover
 * (only possible with a non-zero registration offset) is left cabinet black
 * rather than transparent: this is the bottom layer of the frame and there is
 * nothing behind it.
 *
 * Returns the target for convenience.
 */
export function renderPlayfieldInto(artwork: PixelTarget, target: PixelTarget): PixelTarget {
  if (target.width !== RASTER_WIDTH || target.height !== RASTER_HEIGHT) {
    throw new RangeError(
      `render target is ${target.width}x${target.height} but the playfield is ${RASTER_WIDTH}x${RASTER_HEIGHT}; it rasterises 1:1`,
    );
  }
  const expected = target.width * target.height * BYTES_PER_PIXEL;
  if (target.data.length !== expected) {
    throw new RangeError(
      `render target has ${target.data.length} bytes, expected ${expected} for ${target.width}x${target.height} RGBA`,
    );
  }
  const artBytes = artwork.width * artwork.height * BYTES_PER_PIXEL;
  if (artwork.data.length !== artBytes) {
    throw new RangeError(
      `artwork is ${artwork.width}x${artwork.height} but carries ${artwork.data.length} bytes, expected ${artBytes} for RGBA`,
    );
  }

  const data = target.data;
  const source = artwork.data;
  let offset = 0;
  for (let y = 0; y < target.height; y += 1) {
    const sourceY = y - ART_REGISTRATION_OFFSET_Y;
    const rowInside = sourceY >= 0 && sourceY < artwork.height;
    for (let x = 0; x < target.width; x += 1) {
      const sourceX = x - ART_REGISTRATION_OFFSET_X;
      if (rowInside && sourceX >= 0 && sourceX < artwork.width) {
        const from = (sourceY * artwork.width + sourceX) * BYTES_PER_PIXEL;
        data[offset] = source[from] ?? 0;
        data[offset + 1] = source[from + 1] ?? 0;
        data[offset + 2] = source[from + 2] ?? 0;
      } else {
        data[offset] = CABINET_BLACK[0];
        data[offset + 1] = CABINET_BLACK[1];
        data[offset + 2] = CABINET_BLACK[2];
      }
      data[offset + 3] = 255;
      offset += BYTES_PER_PIXEL;
    }
  }
  return target;
}

/** Registers artwork into a freshly allocated playfield-sized target. */
export function renderPlayfield(artwork: PixelTarget): PixelTarget {
  return renderPlayfieldInto(artwork, createPixelTarget(RASTER_WIDTH, RASTER_HEIGHT));
}

// ---------------------------------------------------------------------------
// The artwork a map is drawn with
// ---------------------------------------------------------------------------

// All keyed by map identity rather than by table id: a reloaded or
// re-exported map is a different object and must not silently inherit the
// previous one's pixels.
let artworkByMap = new WeakMap<TableMap, PixelTarget>();
let rasterCache = new WeakMap<TableMap, PixelTarget>();
let sourceCache = new WeakMap<TableMap, CanvasImageSource>();
// The OPTIONAL HD master (1344x2400, xBRZ 4x of the artwork above — see
// scripts/export-table-art-hd.mjs). Registered beside the native artwork,
// never instead of it: the native raster stays required, stays tested, and
// stays the fallback the instant the HD master is absent.
let hdArtworkByMap = new WeakMap<TableMap, PixelTarget>();
let hdSourceCache = new WeakMap<TableMap, CanvasImageSource>();

/**
 * Tells the renderer which decoded artwork belongs to a map.
 *
 * Separate from the map loader because the two files are loaded independently
 * and because the pixels have to be injectable: tests decode the shipped PNG
 * themselves and hand it in here, with no canvas and no network anywhere.
 * Re-registering different artwork drops the cached raster, so live-swapping a
 * decode takes effect on the next frame.
 */
export function setPlayfieldArtwork(map: TableMap, artwork: PixelTarget): void {
  if (artwork.width !== RASTER_WIDTH || artwork.height !== RASTER_HEIGHT) {
    throw new RangeError(
      `artwork for ${map.tableId} is ${artwork.width}x${artwork.height}, expected ${RASTER_WIDTH}x${RASTER_HEIGHT}`,
    );
  }
  if (artworkByMap.get(map) !== artwork) {
    invalidatePlayfieldRaster(map);
  }
  artworkByMap.set(map, artwork);
}

/** The artwork registered for a map, or null. */
export function playfieldArtwork(map: TableMap): PixelTarget | null {
  return artworkByMap.get(map) ?? null;
}

/**
 * Tells the renderer which HD master belongs to a map, or takes one away.
 *
 * The registration invariant is the size check: logical (x, y) is HD image
 * (HD_SCALE·x, HD_SCALE·y) with no crop and no letterbox, which is what lets
 * every blit multiply the source rectangle by HD_SCALE and nothing else. A
 * master of any other size would silently shear the picture off the physics.
 */
export function setPlayfieldArtworkHd(map: TableMap, artwork: PixelTarget | null): void {
  if (artwork === null) {
    hdArtworkByMap.delete(map);
    hdSourceCache.delete(map);
    return;
  }
  if (artwork.width !== RASTER_WIDTH * HD_SCALE || artwork.height !== RASTER_HEIGHT * HD_SCALE) {
    throw new RangeError(
      `HD artwork for ${map.tableId} is ${artwork.width}x${artwork.height}, ` +
        `expected ${RASTER_WIDTH * HD_SCALE}x${RASTER_HEIGHT * HD_SCALE}`,
    );
  }
  if (hdArtworkByMap.get(map) !== artwork) hdSourceCache.delete(map);
  hdArtworkByMap.set(map, artwork);
}

/** The HD master registered for a map, or null. */
export function playfieldArtworkHd(map: TableMap): PixelTarget | null {
  return hdArtworkByMap.get(map) ?? null;
}

/**
 * The cached raster for a map, built on first use.
 *
 * Returns the same object every time, so callers may compare by identity. The
 * buffer is shared — treat it as read-only; mutate it and every later frame
 * inherits the damage.
 *
 * Throws when no artwork has been registered. There is deliberately no
 * procedural fallback: drawing something invented here when the real picture is
 * missing is precisely the failure this renderer was rewritten to end, and a
 * blank table would hide a broken asset path behind a plausible-looking screen.
 */
export function playfieldRaster(map: TableMap): PixelTarget {
  const cached = rasterCache.get(map);
  if (cached !== undefined) {
    return cached;
  }
  const artwork = artworkByMap.get(map);
  if (artwork === undefined) {
    throw new Error(
      `no playfield artwork registered for ${map.tableId}; load ${map.tableId}.art.png with loadTableArt() and call setPlayfieldArtwork() before rendering`,
    );
  }
  const raster = renderPlayfield(artwork);
  rasterCache.set(map, raster);
  return raster;
}

/**
 * Drops cached pixels so the next frame rebuilds them.
 *
 * With no argument it clears everything, including the registered artwork, which
 * is what a test wants between cases.
 */
export function invalidatePlayfieldRaster(map?: TableMap): void {
  if (map === undefined) {
    artworkByMap = new WeakMap<TableMap, PixelTarget>();
    rasterCache = new WeakMap<TableMap, PixelTarget>();
    sourceCache = new WeakMap<TableMap, CanvasImageSource>();
    hdArtworkByMap = new WeakMap<TableMap, PixelTarget>();
    hdSourceCache = new WeakMap<TableMap, CanvasImageSource>();
    return;
  }
  rasterCache.delete(map);
  sourceCache.delete(map);
  hdSourceCache.delete(map);
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

/**
 * Uploads a raster to a canvas of its own.
 *
 * `OffscreenCanvas` when the runtime has it — the raster is a background asset
 * and has no business being in the document — falling back to a detached
 * `<canvas>` element, which is what Safari needed for most of this project's
 * life. The two canvas types have incompatible `getContext` overloads, so each
 * branch keeps its own concrete type instead of unioning them first.
 *
 * `putImageData`, not `drawImage` of the PNG: the pixels go up exactly as the
 * palette produced them, with no chance of a colour-managed decode changing a
 * 1995 artist's RGB values on the way past.
 *
 * Exported for the lamp layer, which uploads its overlay sprites through the
 * exact same path for the exact same colour-fidelity reason.
 */
export function rasterToCanvas(raster: PixelTarget): CanvasImageSource {
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

/**
 * The registered HD master as something `drawImage` accepts, or null when no
 * HD master is registered — which is the renderer's fallback signal: null
 * sends every layer down the native-resolution path unchanged.
 *
 * Uploaded through the same `putImageData` path as the native raster, for the
 * same reason: the pixels the exporter computed go up exactly as computed.
 */
export function playfieldImageSourceHd(map: TableMap): CanvasImageSource | null {
  const cached = hdSourceCache.get(map);
  if (cached !== undefined) return cached;
  const artwork = hdArtworkByMap.get(map);
  if (artwork === undefined) return null;
  const source = rasterToCanvas(artwork);
  hdSourceCache.set(map, source);
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
 * Whether a blit of the HD sources should smooth.
 *
 * The scrolling blit at the HD window scale is 1:1 — HD source pixels land on
 * canvas pixels untouched, so nearest keeps them exact (and the flag is moot
 * anyway). Whole-table mode downsamples 2400 HD rows into the window, and
 * there bilinear is strictly better than the dropped-row shimmer nearest
 * produces — the same filtering stance both sibling remakes ship. Shared by
 * the lamp and sprite overlays so all three layers resample identically.
 *
 * `scale` below `HD_SCALE` is the mobile render-scale cap: the source is still
 * read at 4x and the destination is smaller, so the blit is a 2:1 supersampled
 * downscale and needs the same bilinear resolve whole-table mode does. Nearest
 * there would throw three of every four pixels away and shimmer as the table
 * scrolls. Defaulted so every existing caller keeps the 1:1 answer it had.
 */
export function hdBlitSmoothing(camera: CameraState, scale: number = HD_SCALE): boolean {
  return camera.mode === "full-table" || scale !== HD_SCALE;
}

/**
 * Blits the cached playfield for the current camera.
 *
 * `scale` is the window magnification (`integerScaleFor`'s pick, or HD_SCALE
 * when the HD master is live); the camera's own scale (1 while scrolling,
 * 256/600 in whole-table mode) is applied on top of it via `toViewport`, so
 * this function never second-guesses the camera about how much of the table
 * is on screen.
 *
 * With an HD master registered the same geometry is read at HD resolution:
 * the source rectangle is multiplied by HD_SCALE and nothing else changes —
 * the registration invariant (logical (x,y) is HD (4x,4y)) makes that the
 * whole of the mapping. At `scale = HD_SCALE` the scrolling blit is therefore
 * 1:1. Without one, the native path below is byte-for-byte what it always
 * was.
 *
 * Smoothing is set on every call rather than once at setup, because a context
 * is shared with whatever else draws this frame and any of them may have
 * changed it.
 */
export function drawPlayfield(
  context: BlitContext,
  map: TableMap,
  camera: CameraState,
  scale: number,
): void {
  const geometry = playfieldBlitGeometry(map, camera, scale);
  const hd = playfieldImageSourceHd(map);
  if (hd !== null) {
    context.imageSmoothingEnabled = hdBlitSmoothing(camera, scale);
    context.drawImage(
      hd,
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
