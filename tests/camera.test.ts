import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMERA_OPTIONS,
  INITIAL_CAMERA,
  ORIGINAL_CAMERA_ANCHOR_ROWS,
  ORIGINAL_NARROW_WINDOW_ROWS,
  ORIGINAL_SCROLL_DIVISOR_DEFAULT,
  ORIGINAL_TOP_EASE_ROWS,
  VIEWPORT_HEIGHT,
  clampScroll,
  followRow,
  resolveMode,
  toViewport,
  toViewportSize,
  updateCamera,
  viewScale,
} from "../src/browser/camera.js";
import { VELOCITY_CLAMP_Q10 } from "../src/game/timebase.js";
import { Q10_ONE } from "../src/core/fixed-point.js";
import type { CameraOptions, CameraState } from "../src/browser/camera.js";
import { PLAYFIELD_HEIGHT } from "../src/game/contracts.js";
import type { BallState } from "../src/game/contracts.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";

function ball(id: number, y: number, active = true, heldBy: string | null = null): BallState {
  // The camera frames a ball by its y alone, so which collision level it rides
  // is irrelevant here; 0 is the playfield.
  return {
    id,
    x: pixelsToQ10(168),
    y: pixelsToQ10(y),
    velocityX: 0,
    velocityY: 0,
    active,
    heldBy,
    level: 0,
  };
}

const OPTIONS: CameraOptions = DEFAULT_CAMERA_OPTIONS;

/**
 * The scroll step the camera takes for a ball sitting `row` rows down the
 * screen, well away from either stop.
 *
 * The follower is a function of that offset alone — error = row - anchor — so a
 * fixed point can be asserted as arithmetic instead of by running a simulation
 * to convergence, which on a 600 px playfield does not always have room.
 */
function stepAtRow(row: number, options: CameraOptions = OPTIONS): number {
  const scrollY = 200;
  const camera: CameraState = { scrollY, mode: "scrolling" };
  return updateCamera(camera, [ball(0, scrollY + row)], options).scrollY - scrollY;
}

describe("scroll clamping", () => {
  it("never shows anything above or below the playfield", () => {
    expect(clampScroll(-50)).toBe(0);
    expect(clampScroll(99_999)).toBe(PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT);
    expect(clampScroll(100)).toBe(100);
  });
});

describe("mode selection", () => {
  it("scrolls with a single ball", () => {
    expect(resolveMode([ball(0, 400)], DEFAULT_CAMERA_OPTIONS)).toBe("scrolling");
  });

  it("shows the whole table once a second ball is live", () => {
    expect(resolveMode([ball(0, 400), ball(1, 200)], DEFAULT_CAMERA_OPTIONS)).toBe("full-table");
  });

  it("ignores drained balls when counting", () => {
    const balls = [ball(0, 400), ball(1, 200, false), ball(2, 100, false)];
    expect(resolveMode(balls, DEFAULT_CAMERA_OPTIONS)).toBe("scrolling");
  });

  it("returns to scrolling when multiball collapses back to one ball", () => {
    const multi = [ball(0, 400), ball(1, 200)];
    expect(resolveMode(multi, DEFAULT_CAMERA_OPTIONS)).toBe("full-table");
    const drained = [ball(0, 400), ball(1, 200, false)];
    expect(resolveMode(drained, DEFAULT_CAMERA_OPTIONS)).toBe("scrolling");
  });

  it("honours an explicit player toggle over the automatic rule", () => {
    const forced: CameraOptions = { ...DEFAULT_CAMERA_OPTIONS, forceFullTable: true };
    expect(resolveMode([ball(0, 400)], forced)).toBe("full-table");
  });
});

describe("following a ball", () => {
  // The measured law: step = (ballRow - scroll - anchor) / divisor, truncated;
  // halved on the way down always and on the way up inside the top 32 rows.
  // See the header of `src/browser/camera.ts` for the disassembly.

  it("closes one part in the divisor of the error, and nothing caps the step", () => {
    // The chosen `maxScrollStep` of 8 px a tick this replaces would have clipped
    // every one of these, and it was never raised when the ball's top speed
    // doubled on the measured timebase.
    const camera = { scrollY: 300, mode: "scrolling" as const };
    for (const error of [50, 100, 200, 250]) {
      const row = 300 + ORIGINAL_CAMERA_ANCHOR_ROWS + error;
      const next = updateCamera(camera, [ball(0, row)], OPTIONS);
      // Downward is always half rate: `asr.w #1` at +0x006D90.
      expect(next.scrollY - 300).toBe(Math.trunc(error / ORIGINAL_SCROLL_DIVISOR_DEFAULT) >> 1);
    }
  });

  it("goes up at the full rate outside the top 32 rows, and half inside them", () => {
    const low = { scrollY: 300, mode: "scrolling" as const };
    const error = -100;
    const next = updateCamera(low, [ball(0, 300 + ORIGINAL_CAMERA_ANCHOR_ROWS + error)], OPTIONS);
    expect(next.scrollY - 300).toBe(Math.trunc(error / ORIGINAL_SCROLL_DIVISOR_DEFAULT));

    const high = { scrollY: ORIGINAL_TOP_EASE_ROWS, mode: "scrolling" as const };
    const eased = updateCamera(
      high,
      [ball(0, ORIGINAL_TOP_EASE_ROWS + ORIGINAL_CAMERA_ANCHOR_ROWS + error)],
      OPTIONS,
    );
    expect(eased.scrollY - ORIGINAL_TOP_EASE_ROWS).toBe(
      Math.trunc(error / ORIGINAL_SCROLL_DIVISOR_DEFAULT) >> 1,
    );
  });

  it("holds a falling ball at anchor + 2 x divisor x speed, which is the fixed point", () => {
    // Two truncations — `divs.w` toward zero and `asr.w #1` toward minus
    // infinity — leave the fixed point a BAND rather than a point, one whole
    // divisor step wide in each direction. The bracket below is that band and
    // not a tolerance: a step cap or a dead zone would put the ball tens of
    // pixels outside it, which is what this is here to catch.
    const band = 2 * ORIGINAL_SCROLL_DIVISOR_DEFAULT;
    for (const v of [4, 8, 12, 14, 16]) {
      const row = ORIGINAL_CAMERA_ANCHOR_ROWS + band * v;
      expect(stepAtRow(row), `falling at ${v}`).toBe(v);
      // And it really is the point the follower converges ON, not merely a
      // point it passes through: one row higher it moves slower than the ball.
      expect(stepAtRow(row - band), `falling at ${v}`).toBeLessThan(v);
    }
  });

  it("holds a rising ball at anchor - divisor x speed", () => {
    // Upward there is only the one truncation outside the top 32 rows, so the
    // slope is twice as steep: a rising ball is carried toward the top of the
    // window rather than merely followed.
    const band = ORIGINAL_SCROLL_DIVISOR_DEFAULT;
    for (const v of [4, 8, 12, 14]) {
      const row = ORIGINAL_CAMERA_ANCHOR_ROWS - band * v;
      expect(stepAtRow(row), `rising at ${v}`).toBe(-v);
      expect(stepAtRow(row + band), `rising at ${v}`).toBeGreaterThan(-v);
    }
    // A full plunge is 14 px a tick, and 70 - 5*14 is exactly row 0: the
    // original's anchor and divisor put a plunged ball precisely on the top edge
    // of its window and no further.
    expect(ORIGINAL_CAMERA_ANCHOR_ROWS - band * 14).toBe(0);
  });

  it("keeps a ball at the machine's own velocity clamp inside the original window", () => {
    // THE REASON THE SHIPPED DIVISOR IS 5. The clamp is 4095 units = 16 px a
    // tick, and 70 + 2*5*16 is exactly the 230 rows the original's narrow view
    // shows. A divisor of 6 puts the ball off the bottom of that window, so 5 is
    // the largest setting that keeps a ball at the engine's own speed limit on
    // screen -- which is what a default is for.
    const clampPixels = Math.round(VELOCITY_CLAMP_Q10 / Q10_ONE);
    expect(clampPixels).toBe(16);

    /** The screen row a ball moving at `v` settles on for a given divisor. */
    function restingRow(divisor: number): number {
      const options = { ...OPTIONS, scrollDivisor: divisor };
      for (let row = 0; row <= PLAYFIELD_HEIGHT; row += 1) {
        if (stepAtRow(row, options) >= clampPixels) return row;
      }
      return PLAYFIELD_HEIGHT;
    }

    expect(restingRow(ORIGINAL_SCROLL_DIVISOR_DEFAULT)).toBe(ORIGINAL_NARROW_WINDOW_ROWS);
    for (let divisor = ORIGINAL_SCROLL_DIVISOR_DEFAULT + 1; divisor <= 7; divisor += 1) {
      expect(restingRow(divisor), `divisor ${divisor}`).toBeGreaterThan(
        ORIGINAL_NARROW_WINDOW_ROWS,
      );
    }
  });

  it("has no dead zone: any error at all moves the view", () => {
    // Truncation leaves a band of (-divisor, +2*divisor) where the step rounds
    // to nothing, and that band is an artefact of the integer divide rather than
    // the 64 px band this used to carry.
    const camera = { scrollY: 300, mode: "scrolling" as const };
    const row = 300 + ORIGINAL_CAMERA_ANCHOR_ROWS;
    for (const error of [2 * ORIGINAL_SCROLL_DIVISOR_DEFAULT, 20, 33]) {
      expect(updateCamera(camera, [ball(0, row + error)], OPTIONS).scrollY).toBeGreaterThan(300);
    }
    for (const error of [-ORIGINAL_SCROLL_DIVISOR_DEFAULT, -20, -33]) {
      expect(updateCamera(camera, [ball(0, row + error)], OPTIONS).scrollY).toBeLessThan(300);
    }
  });

  it("refuses to scroll further down once it is at the bottom stop", () => {
    const maximum = PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT;
    const camera: CameraState = { scrollY: maximum, mode: "scrolling" };
    const next = updateCamera(camera, [ball(0, PLAYFIELD_HEIGHT - 1)], OPTIONS);
    expect(next.scrollY).toBe(maximum);
  });

  it("follows the LOWEST ball, not the first one listed", () => {
    expect(followRow([ball(0, 120), ball(1, 480), ball(2, 300)])).toBe(480);
    // A ball at or below the playfield's own last row is not followed at all.
    expect(followRow([ball(0, 120), ball(1, PLAYFIELD_HEIGHT)])).toBe(120);
    expect(followRow([])).toBeNull();
  });

  it("holds position when every ball has drained", () => {
    const camera = { scrollY: 250, mode: "scrolling" as const };
    expect(updateCamera(camera, [ball(0, 400, false)], OPTIONS).scrollY).toBe(250);
  });

  it("stays within the playfield when the ball is at the very bottom", () => {
    let camera: CameraState = { scrollY: 300, mode: "scrolling" };
    for (let tick = 0; tick < 60; tick += 1) {
      camera = updateCamera(camera, [ball(0, PLAYFIELD_HEIGHT - 1)], OPTIONS);
    }
    expect(camera.scrollY).toBeLessThanOrEqual(PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT);
  });

  it("is deterministic — identical inputs give identical output", () => {
    const camera: CameraState = { scrollY: 123, mode: "scrolling" };
    const balls = [ball(0, 420)];
    expect(updateCamera(camera, balls, OPTIONS)).toEqual(updateCamera(camera, balls, OPTIONS));
  });
});

describe("whole-table mode", () => {
  it("pins the scroll to the top, since the view no longer scrolls", () => {
    const camera = { scrollY: 300, mode: "scrolling" as const };
    const next = updateCamera(camera, [ball(0, 400), ball(1, 100)], OPTIONS);
    expect(next).toEqual({ scrollY: 0, mode: "full-table" });
  });

  it("scales the playfield down to fit, and keeps 1:1 while scrolling", () => {
    expect(viewScale("full-table")).toBeCloseTo(VIEWPORT_HEIGHT / PLAYFIELD_HEIGHT);
    expect(viewScale("scrolling")).toBe(1);
  });

  it("fits the entire playfield inside the viewport when scaled", () => {
    const bottom = toViewport({ scrollY: 0, mode: "full-table" }, 0, PLAYFIELD_HEIGHT);
    expect(bottom.y).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
  });
});

describe("mapping points into the viewport", () => {
  it("puts the top of the visible window at viewport y 0, at every scroll position", () => {
    for (const scrollY of [0, 1, 100, 200, 343, PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT]) {
      const camera = { scrollY, mode: "scrolling" as const };
      expect(toViewport(camera, 168, scrollY).y).toBe(0);
    }
  });

  it("puts the bottom of the visible window at viewport y VIEWPORT_HEIGHT", () => {
    for (const scrollY of [0, 1, 100, 200, 343, PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT]) {
      const camera = { scrollY, mode: "scrolling" as const };
      expect(toViewport(camera, 168, scrollY + VIEWPORT_HEIGHT).y).toBe(VIEWPORT_HEIGHT);
    }
  });

  it("subtracts the scroll offset, so a ball near the drain is on screen", () => {
    // The camera settles here when it is following a ball at y=500; before the
    // offset was applied the ball was drawn 244 px below a 256 px window.
    const camera = { scrollY: 344, mode: "scrolling" as const };
    expect(toViewport(camera, 100, 500)).toEqual({ x: 100, y: 156 });
  });

  it("leaves x alone while scrolling, since the window only moves vertically", () => {
    const camera = { scrollY: 200, mode: "scrolling" as const };
    expect(toViewport(camera, 0, 200).x).toBe(0);
    expect(toViewport(camera, 335, 200).x).toBe(335);
  });

  it("reports a point above the window as negative rather than clamping it", () => {
    // Callers need to know a sprite is off screen so they can skip it.
    const camera = { scrollY: 200, mode: "scrolling" as const };
    expect(toViewport(camera, 168, 150).y).toBe(-50);
    expect(toViewport(camera, 168, 500).y).toBeGreaterThan(VIEWPORT_HEIGHT);
  });

  it("clamps a hand-built scroll the same way the blit does", () => {
    const camera = { scrollY: 9999, mode: "scrolling" as const };
    expect(toViewport(camera, 168, PLAYFIELD_HEIGHT).y).toBe(VIEWPORT_HEIGHT);
    expect(toViewport({ scrollY: -50, mode: "scrolling" }, 168, 0).y).toBe(0);
  });

  it("agrees with the camera it was fed, over a whole follow", () => {
    // A REAL descent AND a real climb, at the machine's own top speed, rather
    // than the teleporting fixture list this used to walk. The measured follower
    // has no step cap to lift, so the only way to outrun it is to move a ball
    // faster than the engine can move one — which is a statement about the
    // fixture, not about the camera. 16 px a tick IS the engine's clamp.
    let camera = INITIAL_CAMERA;
    let y = PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT + ORIGINAL_CAMERA_ANCHOR_ROWS;
    for (const leg of [-14, -12, 16, 12, -8, 8]) {
      for (let tick = 0; tick < 45; tick += 1) {
        y = Math.min(PLAYFIELD_HEIGHT - 1, Math.max(0, y + leg));
        camera = updateCamera(camera, [ball(0, y)], OPTIONS);
        const mapped = toViewport(camera, 168, y);
        expect(mapped.y, `leg ${leg} tick ${tick} row ${y}`).toBeGreaterThanOrEqual(0);
        expect(mapped.y).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
      }
    }
  });

  it("uses viewScale and ignores the pinned scroll in whole-table mode", () => {
    const scale = viewScale("full-table");
    const camera = { scrollY: 0, mode: "full-table" as const };
    expect(toViewport(camera, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(toViewport(camera, 336, PLAYFIELD_HEIGHT)).toEqual({ x: 336 * scale, y: PLAYFIELD_HEIGHT * scale });
    expect(toViewport(camera, 168, 300).y).toBeCloseTo(VIEWPORT_HEIGHT / 2);
    // updateCamera pins the scroll to 0 here, and the renderer reads from row 0,
    // so a stale scrollY must not shift the whole table.
    expect(toViewport({ scrollY: 344, mode: "full-table" }, 168, 300)).toEqual(toViewport(camera, 168, 300));
  });
});

describe("mapping sizes into the viewport", () => {
  it("is 1:1 while scrolling, whatever the scroll position is", () => {
    for (const scrollY of [0, 200, 344]) {
      const size = toViewportSize({ scrollY, mode: "scrolling" }, 336, VIEWPORT_HEIGHT);
      expect(size).toEqual({ x: 336, y: VIEWPORT_HEIGHT });
    }
  });

  it("scales by viewScale in whole-table mode", () => {
    const scale = viewScale("full-table");
    const size = toViewportSize({ scrollY: 0, mode: "full-table" }, 336, PLAYFIELD_HEIGHT);
    expect(size.x).toBeCloseTo(336 * scale);
    expect(size.y).toBeCloseTo(VIEWPORT_HEIGHT);
  });

  it("maps a size as the difference of the two points that bound it", () => {
    const camera = { scrollY: 137, mode: "scrolling" as const };
    const top = toViewport(camera, 0, 200);
    const bottom = toViewport(camera, 0, 200 + 64);
    expect(toViewportSize(camera, 0, 64).y).toBe(bottom.y - top.y);
  });
});

describe("initial state", () => {
  it("starts at the bottom of the table, where the ball is served", () => {
    expect(INITIAL_CAMERA.mode).toBe("scrolling");
    expect(INITIAL_CAMERA.scrollY).toBe(PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT);
  });
});
