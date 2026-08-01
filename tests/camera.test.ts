import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMERA_OPTIONS,
  INITIAL_CAMERA,
  VIEWPORT_HEIGHT,
  clampScroll,
  resolveMode,
  toViewport,
  toViewportSize,
  updateCamera,
  viewScale,
} from "../src/browser/camera.js";
import type { CameraOptions } from "../src/browser/camera.js";
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

const OPTIONS: CameraOptions = { ...DEFAULT_CAMERA_OPTIONS, maxScrollStep: 1000 };

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
  it("does not move while the ball stays inside the dead zone", () => {
    const camera = { scrollY: 300, mode: "scrolling" as const };
    const centre = 300 + VIEWPORT_HEIGHT / 2;
    expect(updateCamera(camera, [ball(0, centre)], OPTIONS).scrollY).toBe(300);
  });

  it("scrolls down when the ball drops below the dead zone", () => {
    const camera = { scrollY: 200, mode: "scrolling" as const };
    const next = updateCamera(camera, [ball(0, 200 + VIEWPORT_HEIGHT)], OPTIONS);
    expect(next.scrollY).toBeGreaterThan(200);
  });

  it("scrolls up when the ball rises above the dead zone", () => {
    const camera = { scrollY: 300, mode: "scrolling" as const };
    const next = updateCamera(camera, [ball(0, 300)], OPTIONS);
    expect(next.scrollY).toBeLessThan(300);
  });

  it("eases rather than snapping, bounded by maxScrollStep", () => {
    const camera = { scrollY: 300, mode: "scrolling" as const };
    const slow = updateCamera(camera, [ball(0, 0)], DEFAULT_CAMERA_OPTIONS);
    expect(300 - slow.scrollY).toBe(DEFAULT_CAMERA_OPTIONS.maxScrollStep);
  });

  it("holds position when every ball has drained", () => {
    const camera = { scrollY: 250, mode: "scrolling" as const };
    expect(updateCamera(camera, [ball(0, 400, false)], OPTIONS).scrollY).toBe(250);
  });

  it("stays within the playfield when the ball is at the very bottom", () => {
    const camera = { scrollY: 300, mode: "scrolling" as const };
    const next = updateCamera(camera, [ball(0, PLAYFIELD_HEIGHT)], OPTIONS);
    expect(next.scrollY).toBeLessThanOrEqual(PLAYFIELD_HEIGHT - VIEWPORT_HEIGHT);
  });

  it("is deterministic — identical inputs give identical output", () => {
    const camera = { scrollY: 123, mode: "scrolling" as const };
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
    // OPTIONS lifts maxScrollStep so the camera reaches its target in one tick;
    // with the default easing a teleporting fixture ball would simply outrun it.
    let camera = INITIAL_CAMERA;
    for (const y of [500, 480, 400, 300, 200, 100, 40, 120, 300, 560, 600]) {
      camera = updateCamera(camera, [ball(0, y)], OPTIONS);
      const mapped = toViewport(camera, 168, y);
      // The dead zone keeps the ball on screen; the point of the assertion is
      // that the mapping and the scroll agree, not that they are generous.
      expect(mapped.y).toBeGreaterThanOrEqual(0);
      expect(mapped.y).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
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
