import { describe, expect, it } from "vitest";
import {
  DESKTOP_MAX_RENDER_SCALE,
  MOBILE_MAX_RENDER_SCALE,
  canvasFitFor,
  chooseRenderScale,
  fitWindowInto,
} from "../src/browser/canvas-fit.js";
import { HD_SCALE } from "../src/browser/hd-scale.js";
import { VIEWPORT_HEIGHT } from "../src/browser/camera.js";
import { PLAYFIELD_WIDTH } from "../src/game/contracts.js";

/**
 * The geometry that used to be `window.innerHeight - 120`.
 *
 * The 120 was desktop chrome expressed as a constant. On a phone it is not
 * merely useless, it is wrong in a way that reads as "the game is tiny": in
 * landscape on an 844 x 390 viewport it yielded a 354 x 270 picture where
 * 512 x 390 fits. The cases below pin both orientations, both presentation
 * modes, and the render-scale cap — including the NATIVE-on-a-phone case, which
 * is the one a development machine never sees because it always has the HD
 * assets.
 */

/** An iPhone 14-class portrait viewport, less the deck and the safe areas. */
const PHONE_PORTRAIT = { width: 382, height: 560 };
/** The same phone turned over, less a one-row deck and the bar. */
const PHONE_LANDSCAPE = { width: 836, height: 268 };

describe("fitting the window into a box", () => {
  it("is width-bound in portrait, where the picture is wide and short", () => {
    const fitted = fitWindowInto(PHONE_PORTRAIT);
    expect(fitted.width).toBe(382);
    expect(fitted.height).toBe(Math.round((382 * VIEWPORT_HEIGHT) / PLAYFIELD_WIDTH));
    expect(fitted.height).toBeLessThanOrEqual(PHONE_PORTRAIT.height);
  });

  it("is height-bound in landscape, and fills the height", () => {
    const fitted = fitWindowInto(PHONE_LANDSCAPE);
    expect(fitted.height).toBe(268);
    expect(fitted.width).toBe(Math.round((268 * PLAYFIELD_WIDTH) / VIEWPORT_HEIGHT));
    expect(fitted.width).toBeLessThanOrEqual(PHONE_LANDSCAPE.width);
  });

  it("beats the arithmetic it replaced, which lost a third of the height", () => {
    // The old rule, restated: min(innerWidth / 1344, (innerHeight - 120) / 1024).
    const old = Math.min(844 / (PLAYFIELD_WIDTH * 4), (390 - 120) / (VIEWPORT_HEIGHT * 4));
    const wasWide = Math.round(PLAYFIELD_WIDTH * 4 * old);
    const wasHigh = Math.round(VIEWPORT_HEIGHT * 4 * old);
    expect([wasWide, wasHigh]).toEqual([354, 270]);

    const now = fitWindowInto({ width: 844, height: 390 });
    expect(now.height).toBe(390);
    expect(now.width).toBeGreaterThan(wasWide);
    expect(now.width * now.height).toBeGreaterThan(wasWide * wasHigh * 1.5);
  });

  it("keeps the 336 x 256 aspect within a pixel in both orientations", () => {
    for (const box of [PHONE_PORTRAIT, PHONE_LANDSCAPE, { width: 1600, height: 900 }]) {
      const fitted = fitWindowInto(box);
      const expected = (fitted.width * VIEWPORT_HEIGHT) / PLAYFIELD_WIDTH;
      expect(Math.abs(fitted.height - expected)).toBeLessThanOrEqual(1);
      expect(fitted.width).toBeLessThanOrEqual(box.width);
      expect(fitted.height).toBeLessThanOrEqual(box.height);
    }
  });

  it("falls back to the natural window rather than a zero-sized one", () => {
    expect(fitWindowInto({ width: 0, height: 500 })).toEqual({
      width: PLAYFIELD_WIDTH,
      height: VIEWPORT_HEIGHT,
    });
    expect(fitWindowInto({ width: Number.NaN, height: 500 })).toEqual({
      width: PLAYFIELD_WIDTH,
      height: VIEWPORT_HEIGHT,
    });
  });
});

describe("the render scale", () => {
  it("caps a coarse pointer at two and covers the physical pixels below it", () => {
    expect(chooseRenderScale(382, { devicePixelRatio: 3, coarsePointer: true })).toBe(
      MOBILE_MAX_RENDER_SCALE,
    );
    expect(chooseRenderScale(382, { devicePixelRatio: 2, coarsePointer: true })).toBe(2);
    // A small phone at dpr 1 needs less than two and gets it.
    expect(chooseRenderScale(320, { devicePixelRatio: 1, coarsePointer: true })).toBe(1);
  });

  it("treats a data-saver request exactly as a coarse pointer", () => {
    expect(chooseRenderScale(1344, { devicePixelRatio: 1, dataSaver: true })).toBe(
      MOBILE_MAX_RENDER_SCALE,
    );
    expect(chooseRenderScale(1344, { devicePixelRatio: 1 })).toBe(DESKTOP_MAX_RENDER_SCALE);
  });

  it("leaves a full-size desktop window on the master's own 4x", () => {
    expect(DESKTOP_MAX_RENDER_SCALE).toBe(HD_SCALE);
    expect(chooseRenderScale(1344, { devicePixelRatio: 1 })).toBe(HD_SCALE);
    expect(chooseRenderScale(1920, { devicePixelRatio: 1 })).toBe(HD_SCALE);
    expect(chooseRenderScale(700, { devicePixelRatio: 2 })).toBe(HD_SCALE);
  });

  it("never goes below one, whatever it is handed", () => {
    expect(chooseRenderScale(0, { devicePixelRatio: 3, coarsePointer: true })).toBe(1);
    expect(chooseRenderScale(-10, {})).toBe(1);
    expect(chooseRenderScale(Number.NaN, {})).toBe(1);
    expect(chooseRenderScale(390, { devicePixelRatio: Number.NaN, coarsePointer: true })).toBe(2);
    expect(chooseRenderScale(390, { devicePixelRatio: 0, coarsePointer: true })).toBe(2);
  });

  it("is a whole number, because glyphs are blitted at it", () => {
    for (const width of [200, 333, 390, 500, 812, 1100, 1344, 2000]) {
      for (const dpr of [1, 1.5, 2, 2.625, 3]) {
        for (const coarse of [false, true]) {
          const scale = chooseRenderScale(width, { devicePixelRatio: dpr, coarsePointer: coarse });
          expect(Number.isInteger(scale)).toBe(true);
          expect(scale).toBeGreaterThanOrEqual(1);
          expect(scale).toBeLessThanOrEqual(coarse ? MOBILE_MAX_RENDER_SCALE : HD_SCALE);
        }
      }
    }
  });
});

describe("the whole fit", () => {
  it("leaves a fine-pointer NATIVE build on whole-number magnification", () => {
    const fit = canvasFitFor({ width: 1600, height: 900 }, { hd: false, coarsePointer: false });
    expect(fit.scale).toBe(3);
    expect(fit.canvasWidth).toBe(PLAYFIELD_WIDTH * 3);
    expect(fit.canvasHeight).toBe(VIEWPORT_HEIGHT * 3);
    // Null is the instruction to leave the element at its natural size, which is
    // what stops a second, fractional scaling composing with the first.
    expect(fit.cssWidth).toBeNull();
    expect(fit.cssHeight).toBeNull();
    expect(fit.smooth).toBe(false);
  });

  it("fits a NATIVE build on a phone rather than leaving a postage stamp", () => {
    const stamp = canvasFitFor(PHONE_PORTRAIT, { hd: false, coarsePointer: false });
    // The bug this branch exists for: whole-number magnification on a phone is 1.
    expect(stamp.scale).toBe(1);
    expect(stamp.cssWidth).toBeNull();

    const fit = canvasFitFor(PHONE_PORTRAIT, {
      hd: false,
      coarsePointer: true,
      devicePixelRatio: 3,
    });
    expect(fit.cssWidth).toBe(382);
    expect(fit.cssHeight).toBe(291);
    expect(fit.scale).toBe(MOBILE_MAX_RENDER_SCALE);
    expect(fit.smooth).toBe(true);
  });

  it("caps the HD backing store on a phone and not on a desktop", () => {
    const phone = canvasFitFor(PHONE_PORTRAIT, {
      hd: true,
      coarsePointer: true,
      devicePixelRatio: 3,
    });
    expect(phone.scale).toBe(2);
    expect(phone.canvasWidth).toBe(672);
    expect(phone.canvasHeight).toBe(512);
    expect(phone.cssWidth).toBe(382);

    const desktop = canvasFitFor({ width: 1900, height: 1000 }, { hd: true, coarsePointer: false });
    expect(desktop.scale).toBe(HD_SCALE);
    expect(desktop.canvasWidth).toBe(1344);
    expect(desktop.canvasHeight).toBe(1024);
    // Height-bound at 1000 css px, so the element is fitted rather than clipped.
    expect(desktop.cssHeight).toBe(1000);
    expect(desktop.smooth).toBe(true);
  });

  it("uses the whole height in landscape, which the old arithmetic did not", () => {
    const fit = canvasFitFor(PHONE_LANDSCAPE, {
      hd: true,
      coarsePointer: true,
      devicePixelRatio: 3,
    });
    expect(fit.cssHeight).toBe(PHONE_LANDSCAPE.height);
    expect(fit.cssWidth).toBe(352);
    expect(fit.scale).toBe(2);
  });

  it("keeps the element inside the box it was given, in every case", () => {
    const boxes = [PHONE_PORTRAIT, PHONE_LANDSCAPE, { width: 1600, height: 900 }, { width: 500, height: 500 }];
    for (const box of boxes) {
      for (const hd of [false, true]) {
        for (const coarsePointer of [false, true]) {
          const fit = canvasFitFor(box, { hd, coarsePointer, devicePixelRatio: 2 });
          if (fit.cssWidth === null || fit.cssHeight === null) {
            expect(fit.canvasWidth).toBeLessThanOrEqual(box.width);
            expect(fit.canvasHeight).toBeLessThanOrEqual(box.height);
            continue;
          }
          expect(fit.cssWidth).toBeLessThanOrEqual(box.width);
          expect(fit.cssHeight).toBeLessThanOrEqual(box.height);
          expect(fit.canvasWidth).toBe(PLAYFIELD_WIDTH * fit.scale);
          expect(fit.canvasHeight).toBe(VIEWPORT_HEIGHT * fit.scale);
        }
      }
    }
  });
});
