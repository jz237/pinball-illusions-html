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
 *
 * ---------------------------------------------------------------------------
 * THE FOLLOW LAW IS MEASURED. IT USED TO BE A DEAD ZONE AND A STEP CAP
 * ---------------------------------------------------------------------------
 * This file ran on a 64 px dead zone and a `maxScrollStep` of 8 px a tick, both
 * chosen, and it was the one rate in the game the timebase change never reached:
 * the ball's top speed doubled to 16 px a tick and the camera's cap stayed at 8.
 *
 * The original has neither a dead zone nor a step cap. It is a PROPORTIONAL
 * follower and it is thirteen instructions, at main.seg00 +0x006D5A, called once
 * per frame from all six game loops (+0x00489A, +0x004B1E, +0x004C08, +0x004C90,
 * +0x00517A, +0x005244):
 *
 *     006D5A  move.w  $da8(a5), d0        ; the ball being followed
 *     006D5E  move.w  $da4(a5), d1        ; the current top row
 *     006D62  sub.w   d1, d0
 *     006D64  sub.w   $d9e(a5), d0        ; ... minus the ANCHOR
 *     006D68  ext.l   d0
 *     006D6A  divs.w  $e88(a5), d0        ; step = error / DIVISOR  <- record 2
 *     006D6E  bpl     $6d84               ; >= 0 is the downward branch
 *     006D70  cmpi.w  #$20, d1 / bgt      ; UP: inside the top 32 rows,
 *     006D76  asr.w   #$1, d0             ;     halve the step
 *     006D78  add.w   d0, $da4(a5)
 *     006D7C  bpl / clr.w $da4(a5)        ;     never above row 0
 *     006D84  move.w  $da0(a5), d2 / sub.w d1, d2
 *     006D8A  cmpi.w  #$ffce, d2 / bhi    ; DOWN: 1..49 rows past the stop,
 *                                         ;       do not scroll at all
 *     006D90  asr.w   #$1, d0             ;       and always at half rate
 *     006D92  add.w   d0, $da4(a5)
 *     006D96  cmp.w   $da4(a5), d2 / bhi / move.w d2, $da4(a5)   ; clamp to $DA0
 *
 * $DA4 is the top visible playfield ROW in whole pixels — +0x007720 uses it to
 * index a per-row address table whose entries become the eight bitplane pointers
 * — so this is the whole of the vertical camera. There is no horizontal one:
 * $D96, added alongside at +0x006DB0, is the +-3 px nudge shake and nothing else.
 *
 * WHY THE SHIPPED DIVISOR IS PROVABLY 5, which is the finding rather than a fit.
 * The law's fixed point, replayed in integers, puts a ball falling at v px a
 * frame at screen row `anchor + 2*divisor*v` and a ball rising at v at
 * `anchor - divisor*v`. The engine's own velocity clamp is 4095 units = 16 px a
 * frame (see `timebase.ts`), and the original's narrow window is 230 rows —
 * $DA0 = 370 of a 600 px playfield. 70 + 2*5*16 = 230 EXACTLY: a ball at the
 * machine's top speed sits precisely on the bottom edge of the window and never
 * leaves it. Divisor 6 gives 262 and divisor 7 gives 294, both off the bottom.
 * Upward, 70 - 5*14 = 0 and 14 px a frame is the measured full plunge, so a
 * plunge puts the ball precisely on the TOP edge. Four independently measured
 * numbers — the clamp, the anchor, the window and the divisor — close on each
 * other to the pixel.
 *
 * WHAT IS STILL THIS PORT'S. The WINDOW. The original's narrow mode shows 230
 * rows and this port shows 256, which is 26 rows of margin the machine did not
 * have; the display-window registers set beside $D9E at +0x003BDC ($9CA = 48,
 * $9CE = 208) imply 160 lines and have not been reconciled with the 230 that
 * $DA0 forces, so the true height is [open] and changing it is a rendering
 * change rather than a camera one. The consequence is recorded rather than
 * hidden: with the measured law and a 256 px window the ball is 26 px further
 * from the bottom edge than it was on the machine.
 *
 * The WIDE mode is also the original's own — $D9E = 200, $DA0 = 138 at
 * +0x003C1E, i.e. 462 scrollable rows over an interlaced screen — and this port
 * does not reproduce it. What it has instead is the whole-table reframe below,
 * which is documented behaviour and is kept.
 */

import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../game/contracts.js";
import type { BallState } from "../game/contracts.js";
import { q10ToPixel } from "../core/fixed-point.js";

/** PAL-era visible window over the playfield, in playfield pixels. */
export const VIEWPORT_WIDTH = PLAYFIELD_WIDTH;
export const VIEWPORT_HEIGHT = 256;

/**
 * The original's narrow window: 230 rows, from $DA0 = 370 at +0x003BDC against
 * the 600 px playfield. Recorded, not used — see the header for why the port's
 * window is 256.
 */
export const ORIGINAL_NARROW_WINDOW_ROWS = 230;

/**
 * The CAMERA SCROLL DIVISOR, `tableNNN.opt` record 2: (min 1, max 7, DEFAULT 5),
 * byte-identical on all three tables.
 *
 * MEASURED. $E88(a5) has exactly one reader in the whole 53 KB segment and it is
 * the `divs.w` at +0x006D6A. Nothing writes it after the option copy.
 */
export const ORIGINAL_SCROLL_DIVISOR_MIN = 1;
export const ORIGINAL_SCROLL_DIVISOR_MAX = 7;
export const ORIGINAL_SCROLL_DIVISOR_DEFAULT = 5;

/** $D9E(a5), narrow mode: the row the followed ball is held on. +0x003C10. */
export const ORIGINAL_CAMERA_ANCHOR_ROWS = 70;

/** Rows from the top inside which the upward step is halved. +0x006D70. */
export const ORIGINAL_TOP_EASE_ROWS = 32;

/**
 * Rows past the bottom stop within which the downward step is refused outright.
 * +0x006D8A's `cmpi.w #$ffce,d2 / bhi`, i.e. -49..-1 of remaining room.
 */
export const ORIGINAL_BOTTOM_STALL_ROWS = 49;

/** Rows below which a ball is not followed at all: the playfield's own height. */
export const ORIGINAL_FOLLOW_LIMIT_ROWS = PLAYFIELD_HEIGHT;

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
  /** Option record 2. The camera closes one part in `scrollDivisor` per tick. */
  readonly scrollDivisor: number;
  /** Rows between the top of the window and the ball it is following. */
  readonly anchorRows: number;
}

export const DEFAULT_CAMERA_OPTIONS: CameraOptions = {
  forceFullTable: false,
  scrollDivisor: ORIGINAL_SCROLL_DIVISOR_DEFAULT,
  anchorRows: ORIGINAL_CAMERA_ANCHOR_ROWS,
};

/**
 * THE CAMERA A FRESH GAME HOLDS: the TOP of the table, which is what the attract
 * screen frames.
 *
 * FILMED, and the film is why this is no longer the bottom stop. In
 * `research/view/reference` (INDEX.txt lines 41-43, telemetry/track10.csv) the
 * attract display frames the top of the playfield — track10 f54 tracks a blob at
 * game row 121 — and the first half-second of a game is the WINDOW RUNNING DOWN
 * to the lane in a decaying sequence, 102, 76, 68, 62, 56, 52, 46, 42, 40, 36,
 * 34, 30 screen px per frame (screen px / 2 = game px), settling 0.4-0.5 s after
 * start. This port opened at the bottom stop AND reset to it again at
 * `startGame`, so the window was already where it would end and the snap did not
 * exist at all.
 *
 * Nothing else was needed to produce it. The decay is the SHIPPED FOLLOWER LAW
 * of `updateCamera` below: its downward branch halves the step (`asr #1`) on top
 * of the option record's divisor of 5, so the error decays by a factor of
 * 1 - 1/(2*5) = 0.90 per tick, which is the filmed ratio. Fitted against the
 * filmed run's frames 1..11 the residual is 8 px in total, under a pixel a
 * frame; track10's own tail (42, 40, 36, 34, 30, 26, 24, 16 screen px) fits
 * inside 5 px over 8 frames. Divisor 6 fits that single run marginally better (3
 * px) and the measured ratio of 0.911 sits between the two, but the option
 * record's default is 5 and the capture ran on defaults, so 5 is what is used.
 * Frame 0's 102 px does not chain into frame 1 under any fixed target and is the
 * attract-to-game display switch, which track10 shows as tracker garbage
 * (f55-60).
 */
export const INITIAL_CAMERA: CameraState = {
  scrollY: 0,
  mode: "scrolling",
};

/**
 * The bottom stop, where a served ball's follow converges. Recorded because it
 * is what the serve snap runs TO, and because the port's 256-row window puts it
 * at 344 against the machine's 370 — the documented window difference, which
 * truncates the last ~26 rows of the filmed approach.
 */
export const SERVE_FRAMING_SCROLL = PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT;

/** Clamps the window so it never shows anything off the playfield. */
export function clampScroll(scrollY: number): number {
  const maximum = PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT;
  if (maximum <= 0) return 0;
  if (scrollY < 0) return 0;
  if (scrollY > maximum) return maximum;
  return Math.round(scrollY);
}

/**
 * The balls the camera has to keep on screen.
 *
 * A ball sitting in a lock is drawn but does not count here. It never moves, so
 * following it is meaningless, and counting it would throw the view into the
 * whole-table multiball frame the moment the first ball was locked — while the
 * player still has exactly one ball rolling and wants the close view. Multiball
 * proper is when the locks give the balls back, and then every one of them is in
 * play and every one is counted. See `ball-locks.ts`.
 */
function activeBalls(balls: readonly BallState[]): BallState[] {
  return balls.filter((ball) => ball.active && ball.heldBy === null);
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
 * The row the camera follows: the LOWEST ball in play.
 *
 * MEASURED at +0x00BEF0. The routine seeds $DA6/$DA8 from the first ball's
 * $12/$14 and then walks the list keeping any ball with a LARGER y — `cmp.w
 * $da8(a5),d1 / bcs` at +0x00BF2C — while skipping any at or below row 600
 * (`cmpi.w #$258,d1 / bcc` at +0x00BF10). Negative coordinates are clamped to
 * zero on the way in.
 *
 * "The lowest ball" and not "the first" is the multiball rule the port had
 * backwards: the view has to stay with the ball nearest the drain, because that
 * is the one the player can still do something about.
 */
export function followRow(live: readonly BallState[]): number | null {
  const first = live[0];
  if (first === undefined) return null;
  let target = Math.max(0, q10ToPixel(first.y));
  for (const ball of live) {
    const row = Math.max(0, q10ToPixel(ball.y));
    if (row >= ORIGINAL_FOLLOW_LIMIT_ROWS) continue;
    if (row > target) target = row;
  }
  return target;
}

/**
 * Advances the camera one tick, by the measured law in the header.
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
  const target = followRow(live);
  if (target === null) {
    // Nothing to follow — hold position rather than lurching to a default.
    return { scrollY: clampScroll(previous.scrollY), mode };
  }

  const maximum = Math.max(0, PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT);
  const viewTop = clampScroll(previous.scrollY);
  // `divs.w` truncates toward zero; `asr.w #1` floors. The two are deliberately
  // different rounding and the difference is a pixel of lag at the extremes.
  let step = Math.trunc((target - viewTop - options.anchorRows) / options.scrollDivisor);

  if (step < 0) {
    if (viewTop <= ORIGINAL_TOP_EASE_ROWS) step >>= 1;
    const next = viewTop + step;
    return { scrollY: next < 0 ? 0 : next, mode };
  }

  // The overshoot guard, in the original's own unsigned word arithmetic: a
  // window already 1..49 rows past the bottom stop does not scroll down at all.
  const room = (maximum - viewTop) & 0xffff;
  if (room > 0xffff - ORIGINAL_BOTTOM_STALL_ROWS) {
    return { scrollY: viewTop, mode };
  }
  step >>= 1;
  const next = viewTop + step;
  return { scrollY: next > maximum ? maximum : next, mode };
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
