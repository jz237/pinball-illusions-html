/**
 * Playfield camera.
 *
 * The original scrolls a roughly PAL-sized window vertically over the 336x600
 * playfield while one ball is in play, and switches to a whole-table view when
 * multiball starts so every ball stays visible. That switch is a documented
 * behaviour of the game rather than a convenience, so it is modelled here as a
 * rule rather than left to the renderer.
 *
 * Pure and deterministic: the same balls and previous state always produce the
 * same camera, which keeps replays reproducible and makes this testable without
 * a canvas.
 */

import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../game/contracts.js";
import type { BallState } from "../game/contracts.js";
import { q10ToPixel } from "../core/fixed-point.js";

/** PAL-era visible window over the playfield, in playfield pixels. */
export const VIEWPORT_WIDTH = PLAYFIELD_WIDTH;
export const VIEWPORT_HEIGHT = 256;

export type CameraMode = "scrolling" | "full-table";

export interface CameraState {
  /** Top edge of the visible window, in playfield pixels. */
  readonly scrollY: number;
  readonly mode: CameraMode;
}

export interface CameraOptions {
  /**
   * When true the whole-table view is forced on regardless of ball count.
   * The original exposed this as a player toggle; honouring it means the
   * automatic switch must never override an explicit choice.
   */
  readonly forceFullTable: boolean;
  /**
   * Vertical band, centred in the viewport, inside which the ball moves without
   * dragging the camera. Without it the view jitters constantly.
   */
  readonly deadZoneHeight: number;
  /** Maximum scroll change per tick, so the view eases rather than snaps. */
  readonly maxScrollStep: number;
}

export const DEFAULT_CAMERA_OPTIONS: CameraOptions = {
  forceFullTable: false,
  deadZoneHeight: 64,
  maxScrollStep: 8,
};

export const INITIAL_CAMERA: CameraState = {
  scrollY: PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT,
  mode: "scrolling",
};

/** Clamps the window so it never shows anything off the playfield. */
export function clampScroll(scrollY: number): number {
  const maximum = PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT;
  if (maximum <= 0) return 0;
  if (scrollY < 0) return 0;
  if (scrollY > maximum) return maximum;
  return Math.round(scrollY);
}

function activeBalls(balls: readonly BallState[]): BallState[] {
  return balls.filter((ball) => ball.active);
}

/**
 * Decides the mode for this tick.
 *
 * More than one live ball means the player is in multiball and the whole table
 * is shown. A single ball returns to scrolling — mirroring the original, where
 * draining back to one ball restores the close view.
 */
export function resolveMode(balls: readonly BallState[], options: CameraOptions): CameraMode {
  if (options.forceFullTable) return "full-table";
  return activeBalls(balls).length > 1 ? "full-table" : "scrolling";
}

/**
 * Advances the camera one tick.
 *
 * In whole-table mode the scroll is pinned to the top, since the renderer scales
 * the entire playfield to fit and there is nothing left to scroll.
 */
export function updateCamera(
  previous: CameraState,
  balls: readonly BallState[],
  options: CameraOptions = DEFAULT_CAMERA_OPTIONS,
): CameraState {
  const mode = resolveMode(balls, options);
  if (mode === "full-table") {
    return { scrollY: 0, mode };
  }

  const live = activeBalls(balls);
  if (live.length === 0) {
    // Nothing to follow — hold position rather than lurching to a default.
    return { scrollY: clampScroll(previous.scrollY), mode };
  }

  const target = live[0];
  if (target === undefined) {
    return { scrollY: clampScroll(previous.scrollY), mode };
  }

  const ballY = q10ToPixel(target.y);
  const viewTop = previous.scrollY;
  const bandTop = viewTop + (VIEWPORT_HEIGHT - options.deadZoneHeight) / 2;
  const bandBottom = bandTop + options.deadZoneHeight;

  let desired = viewTop;
  if (ballY < bandTop) desired = viewTop - (bandTop - ballY);
  else if (ballY > bandBottom) desired = viewTop + (ballY - bandBottom);

  const delta = desired - viewTop;
  const limited =
    delta > options.maxScrollStep
      ? options.maxScrollStep
      : delta < -options.maxScrollStep
        ? -options.maxScrollStep
        : delta;

  return { scrollY: clampScroll(viewTop + limited), mode };
}

/** Scale factor the renderer should apply for the current mode. */
export function viewScale(mode: CameraMode): number {
  return mode === "full-table" ? VIEWPORT_HEIGHT / PLAYFIELD_HEIGHT : 1;
}

/**
 * Maps a playfield *point* into viewport coordinates for the current camera.
 *
 * Scrolling mode shows playfield rows `scrollY … scrollY + VIEWPORT_HEIGHT - 1`
 * at viewport rows `0 … VIEWPORT_HEIGHT - 1`, so the scroll offset has to come
 * off the y coordinate: without it a ball at the bottom of a 600-row table is
 * drawn 344 px below a 256 px window. The scroll is re-clamped here for the
 * same reason the renderer re-clamps it — a caller may hand over a hand-built
 * camera state that never went through `updateCamera`, and the point must land
 * where the blit actually put that row.
 *
 * Whole-table mode ignores `scrollY` deliberately: `updateCamera` pins it to 0
 * there and the renderer reads from row 0, so the only transform is the scale
 * that shrinks all 600 rows into the window.
 *
 * Sizes must go through `toViewportSize` instead — a width or a height is a
 * difference between two points, and differences are unaffected by the offset.
 */
export function toViewport(
  camera: CameraState,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  if (camera.mode === "full-table") {
    const scale = viewScale(camera.mode);
    return { x: x * scale, y: y * scale };
  }
  return { x, y: y - clampScroll(camera.scrollY) };
}

/**
 * Maps a playfield *size* into viewport units for the current camera.
 *
 * Scales exactly as `toViewport` does but applies no scroll offset, which is
 * what a width or a height needs: translating a size would shrink the blit
 * rectangle by the scroll distance. Sizes and positions used to share
 * `toViewport`, which is precisely how the missing offset stayed hidden.
 */
export function toViewportSize(
  camera: CameraState,
  width: number,
  height: number,
): { readonly x: number; readonly y: number } {
  const scale = viewScale(camera.mode);
  return { x: width * scale, y: height * scale };
}
