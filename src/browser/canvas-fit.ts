/**
 * How big the picture is, and how big the pixels behind it are.
 *
 * Two questions that used to be one, and conflating them is what made the game
 * a postage stamp on a phone. They are:
 *
 *   1. HOW BIG IS THE ELEMENT. A layout question, and the answer is "as big as
 *      the box the stylesheet gave it, aspect preserved". `fitWindowInto` is
 *      that answer and nothing else.
 *   2. HOW MANY PIXELS ARE BEHIND IT. A rendering question, answered by the
 *      device pixel ratio and a cap. `chooseRenderScale` is that answer.
 *
 * The old `fitCanvas` asked one question with `window.innerHeight - 120`, and
 * the 120 was desktop chrome that does not exist on a phone. In landscape it was
 * actively wrong: on an 844 x 390 viewport it yielded a 354 x 270 picture where
 * 512 x 390 fits. Nothing here looks at `window`. The host measures the box the
 * stylesheet produced — a `ResizeObserver`, so the small-viewport unit and the
 * safe-area insets are honoured by the engine rather than re-derived here — and
 * hands the measurement in.
 *
 * ---------------------------------------------------------------------------
 * THE RENDER SCALE CAP
 * ---------------------------------------------------------------------------
 * The HD presentation renders the 4x master into a `336 * scale` canvas: the
 * SOURCE rectangle is multiplied by `HD_SCALE` and the DEST rectangle by
 * `scale` (`drawPlayfield`, and identically in the lamp and sprite layers), so
 * a scale below `HD_SCALE` is a supersampled downscale of the same master
 * rather than a lower-quality read. That makes the scale a free performance
 * lever, and it is the lever the sibling Pinball Fantasies HD build pulls: one
 * 4x master, no second asset tier, and a canvas capped lower on a coarse
 * pointer. `navigator.connection.saveData` counts as coarse, because a player
 * who has asked for less data has usually also asked for less battery.
 *
 * Whole numbers only. Fantasies allows halves; Illusions must not, because the
 * score panel, the HUD text and every shell glyph are blitted at `scale` and a
 * half-pixel glyph origin is a blurred glyph.
 */

import { PLAYFIELD_WIDTH } from "../game/contracts.js";
import { VIEWPORT_HEIGHT } from "./camera.js";
import { HD_SCALE } from "./hd-scale.js";
import { integerScaleFor } from "./playfield-renderer.js";

/** A box, in CSS pixels. */
export interface FitSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The cap on a coarse pointer or under a data-saver request.
 *
 * Two, not four: 336 x 2 = 672 canvas pixels across, which on a 390 px-wide
 * phone at a device pixel ratio of 3 is a 1.74x upscale of a supersampled
 * picture. That is the sibling's shipped arithmetic (320 x 2 = 640 into the
 * same 1170 device pixels) and it halves the composite in each axis.
 */
export const MOBILE_MAX_RENDER_SCALE = 2;

/** The cap everywhere else: the master's own scale, so desktop is untouched. */
export const DESKTOP_MAX_RENDER_SCALE = HD_SCALE;

export interface RenderScaleOptions {
  readonly devicePixelRatio?: number | undefined;
  /** `(hover: none) and (pointer: coarse)` — never a user-agent string. */
  readonly coarsePointer?: boolean | undefined;
  /** `navigator.connection?.saveData`. */
  readonly dataSaver?: boolean | undefined;
}

/**
 * The backing-store magnification for a picture that is `cssWidth` wide.
 *
 * Ceiling, not floor: the canvas must COVER the physical pixels it is painted
 * into, so the browser's final composite is a downscale of a supersample rather
 * than an upscale of something too small. Below the cap that costs at most one
 * extra step of magnification and buys a sharp picture.
 */
export function chooseRenderScale(cssWidth: number, options: RenderScaleOptions = {}): number {
  const maximum =
    options.coarsePointer === true || options.dataSaver === true
      ? MOBILE_MAX_RENDER_SCALE
      : DESKTOP_MAX_RENDER_SCALE;
  if (!Number.isFinite(cssWidth) || cssWidth <= 0) return 1;
  const ratio = options.devicePixelRatio;
  const dpr = typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const physical = (cssWidth * dpr) / PLAYFIELD_WIDTH;
  if (!Number.isFinite(physical)) return 1;
  return Math.min(maximum, Math.max(1, Math.ceil(physical)));
}

/**
 * The largest 336 x 256 picture that fits a box, aspect preserved.
 *
 * Rounded rather than floored so a picture that is a hair under a whole pixel
 * does not lose a whole row; the two axes are rounded independently, which can
 * leave the aspect a fraction of a pixel out and is exactly what the pre-mobile
 * code did.
 */
export function fitWindowInto(available: FitSize): FitSize {
  const width = Number.isFinite(available.width) ? available.width : 0;
  const height = Number.isFinite(available.height) ? available.height : 0;
  if (width <= 0 || height <= 0) return { width: PLAYFIELD_WIDTH, height: VIEWPORT_HEIGHT };
  const fit = Math.min(width / PLAYFIELD_WIDTH, height / VIEWPORT_HEIGHT);
  return {
    width: Math.max(1, Math.round(PLAYFIELD_WIDTH * fit)),
    height: Math.max(1, Math.round(VIEWPORT_HEIGHT * fit)),
  };
}

export interface CanvasFitOptions extends RenderScaleOptions {
  /** True once a table's 4x master has registered. */
  readonly hd: boolean;
}

export interface CanvasFit {
  /** What to pass `renderGame` and `renderShell`. */
  readonly scale: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /**
   * The CSS size for the element, or null to leave it at its natural size.
   *
   * Null is the pre-mobile desktop path and is deliberately preserved: a
   * NATIVE-resolution picture magnified by a whole number in the backing store
   * must NOT then be scaled again by CSS, or the two scalings compose into a
   * fractional one and the rails wobble.
   */
  readonly cssWidth: number | null;
  readonly cssHeight: number | null;
  /**
   * Whether the element should be composited smoothly.
   *
   * True exactly when CSS is scaling the element, which is when the picture is
   * a supersample being resolved down rather than a pixel grid being magnified.
   */
  readonly smooth: boolean;
}

/**
 * The whole geometry decision, as one pure function.
 *
 * THREE CASES, and the third is the one the pre-mobile code did not have:
 *
 *  - NATIVE on a fine pointer: whole-number magnification, element left at its
 *    natural size. Byte-for-byte the old behaviour, except that the space
 *    available is now measured rather than guessed at with `-120`.
 *  - HD: the element is fitted to the box and the backing store follows the
 *    cap. On a desktop the cap is the master's own 4x, so a full-size window is
 *    the 1344 x 1024 composite it always was.
 *  - NATIVE on a coarse pointer: ALSO fitted. Without this branch a build
 *    without the HD assets renders 336 x 256 in the corner of a phone —
 *    `integerScaleFor(390, 724)` is 1 — and is unplayable. It is easy to miss
 *    because a development machine always has the HD assets.
 */
export function canvasFitFor(available: FitSize, options: CanvasFitOptions): CanvasFit {
  const cssFit = options.hd || options.coarsePointer === true;
  if (!cssFit) {
    const scale = integerScaleFor(available.width, available.height);
    return {
      scale,
      canvasWidth: PLAYFIELD_WIDTH * scale,
      canvasHeight: VIEWPORT_HEIGHT * scale,
      cssWidth: null,
      cssHeight: null,
      smooth: false,
    };
  }
  const painted = fitWindowInto(available);
  const scale = chooseRenderScale(painted.width, options);
  return {
    scale,
    canvasWidth: PLAYFIELD_WIDTH * scale,
    canvasHeight: VIEWPORT_HEIGHT * scale,
    cssWidth: painted.width,
    cssHeight: painted.height,
    smooth: true,
  };
}
