import { describe, expect, it } from "vitest";
import {
  DECK_SLOTS,
  TOUCH_KEYS,
  WINDOW_HEIGHT,
  WINDOW_WIDTH,
  canvasPointToShell,
  deckPlanFor,
  shellHitTest,
} from "../src/browser/touch-zones.js";
import type { DeckSlot, ShellHitState } from "../src/browser/touch-zones.js";
import {
  FIELD_HEIGHT,
  FIELD_WIDTH,
  FIELD_X,
  FIELD_Y,
  MENU_RECTS,
  SELECT_INFO_BOX,
  SELECT_NAME_BOX,
  SELECT_ROW_PITCH,
  SELECT_ROW_Y,
  SHELL_HEIGHT,
  SHELL_ORIGIN_X,
  SHELL_WIDTH,
} from "../src/browser/shell-screens.js";
import {
  MENU_ITEMS,
  SHELL_TABLES,
  createScoreStore,
  createShell,
  shellKey,
} from "../src/browser/shell.js";
import type { ShellPhase, ShellState } from "../src/browser/shell.js";
import { CONTROLS, isControl } from "../src/browser/input.js";
import { PLAYFIELD_WIDTH } from "../src/game/contracts.js";

/**
 * Where a finger lands on a shell that is painted INTO the canvas.
 *
 * The whole reason this file exists is that Illusions cannot inherit the
 * siblings' answer: both of those draw their menus as HTML buttons and get
 * touch navigation for nothing. Everything here is arithmetic over the
 * renderer's OWN exported coordinates — if a number below is also written in
 * `shell-screens.ts`, that is a bug in this file.
 */

/** Every phase in the union, so a new one cannot slip through untested. */
const PHASES: readonly ShellPhase[] = [
  "attract",
  "menu",
  "select",
  "info",
  "loading",
  "play",
  "quit-confirm",
  "game-over",
  "fanfare",
  "initials",
  "ladder",
  "failed",
];

function hitState(phase: ShellPhase, overrides: Partial<ShellHitState> = {}): ShellHitState {
  return { phase, menuCursor: 0, cursor: 0, column: 0, ...overrides };
}

/** The middle of a rectangle, in shell coordinates. */
function centre(rect: { x1: number; y1: number; x2: number; y2: number }): { x: number; y: number } {
  return { x: (rect.x1 + rect.x2) / 2, y: (rect.y1 + rect.y2) / 2 };
}

describe("the canvas-to-shell map", () => {
  /** A NATIVE element: 336 x 256 at its natural size, at the page origin. */
  const native = { left: 0, top: 0, width: PLAYFIELD_WIDTH, height: SHELL_HEIGHT };
  /** A phone: the same window CSS-fitted to 382 x 291 and offset by the bar. */
  const fitted = { left: 4, top: 42, width: 382, height: 291 };

  it("puts the shell page's origin eight pixels in, in both geometries", () => {
    expect(canvasPointToShell(SHELL_ORIGIN_X, 0, native)).toEqual({ x: 0, y: 0 });
    const scaled = canvasPointToShell(4 + (382 * SHELL_ORIGIN_X) / WINDOW_WIDTH, 42, fitted);
    expect(scaled.x).toBeCloseTo(0, 10);
    expect(scaled.y).toBeCloseTo(0, 10);
  });

  it("maps the four corners of the element onto the four corners of the window", () => {
    for (const rect of [native, fitted]) {
      const topLeft = canvasPointToShell(rect.left, rect.top, rect);
      expect(topLeft.x).toBeCloseTo(-SHELL_ORIGIN_X, 10);
      expect(topLeft.y).toBeCloseTo(0, 10);

      const bottomRight = canvasPointToShell(rect.left + rect.width, rect.top + rect.height, rect);
      expect(bottomRight.x).toBeCloseTo(SHELL_WIDTH + SHELL_ORIGIN_X, 10);
      expect(bottomRight.y).toBeCloseTo(WINDOW_HEIGHT, 10);
    }
  });

  it("agrees between the two geometries for the same fraction of the picture", () => {
    for (const fraction of [0.1, 0.25, 0.5, 0.73, 0.99]) {
      const a = canvasPointToShell(
        native.left + native.width * fraction,
        native.top + native.height * fraction,
        native,
      );
      const b = canvasPointToShell(
        fitted.left + fitted.width * fraction,
        fitted.top + fitted.height * fraction,
        fitted,
      );
      expect(b.x).toBeCloseTo(a.x, 8);
      expect(b.y).toBeCloseTo(a.y, 8);
    }
  });

  it("survives a zero-sized element rather than dividing by it", () => {
    const point = canvasPointToShell(10, 10, { left: 0, top: 0, width: 0, height: 0 });
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  });

  it("restates the window the shell is centred in", () => {
    expect(WINDOW_WIDTH).toBe(PLAYFIELD_WIDTH);
    expect(WINDOW_WIDTH).toBe(SHELL_WIDTH + 2 * SHELL_ORIGIN_X);
    expect(WINDOW_HEIGHT).toBe(SHELL_HEIGHT);
  });
});

describe("the shell hit test", () => {
  it("has a defined answer for every phase in the union", () => {
    for (const phase of PHASES) {
      const keys = shellHitTest(hitState(phase), SHELL_WIDTH / 2, SHELL_HEIGHT / 2);
      expect(Array.isArray(keys)).toBe(true);
      for (const key of keys) {
        expect(typeof key.kind).toBe("string");
      }
    }
  });

  it("covers exactly the phases the shell declares", () => {
    // `createShell` cannot enumerate the union, so this is the belt: every phase
    // named above is reachable in `shellKey`'s switch and vice versa. A new
    // phase makes `PHASE_HITS` a type error and this list a test failure.
    expect(new Set(PHASES).size).toBe(PHASES.length);
    expect(PHASES).toContain("quit-confirm");
    expect(PHASES.length).toBe(12);
  });

  it("ignores a tap outside the window", () => {
    expect(shellHitTest(hitState("attract"), -SHELL_ORIGIN_X - 1, 100)).toEqual([]);
    expect(shellHitTest(hitState("attract"), SHELL_WIDTH + SHELL_ORIGIN_X + 1, 100)).toEqual([]);
    expect(shellHitTest(hitState("attract"), 100, -1)).toEqual([]);
    expect(shellHitTest(hitState("attract"), 100, SHELL_HEIGHT + 1)).toEqual([]);
    expect(shellHitTest(hitState("attract"), Number.NaN, 100)).toEqual([]);
  });

  it("takes any tap as the way out of the credits roll", () => {
    const keys = shellHitTest(hitState("attract"), 160, 128);
    expect(keys).toEqual([TOUCH_KEYS.select]);
  });

  it("selects the menu item the finger landed on, walking the cursor there", () => {
    const tables = centre(MENU_RECTS[0]!);
    const exit = centre(MENU_RECTS[1]!);

    expect(shellHitTest(hitState("menu"), tables.x, tables.y)).toEqual([TOUCH_KEYS.select]);
    expect(shellHitTest(hitState("menu"), exit.x, exit.y)).toEqual([
      TOUCH_KEYS.down,
      TOUCH_KEYS.select,
    ]);
    expect(shellHitTest(hitState("menu", { menuCursor: 1 }), tables.x, tables.y)).toEqual([
      TOUCH_KEYS.up,
      TOUCH_KEYS.select,
    ]);
    // Between the two rectangles is nothing at all.
    expect(shellHitTest(hitState("menu"), 160, 120)).toEqual([]);
  });

  it("moves the cursor to the menu item it claims to, through the real shell", () => {
    for (let target = 0; target < MENU_ITEMS.length; target += 1) {
      for (let from = 0; from < MENU_ITEMS.length; from += 1) {
        const store = createScoreStore(null);
        const state: ShellState = createShell(store);
        state.phase = "menu";
        state.menuCursor = from;
        const rect = MENU_RECTS[target]!;
        const point = centre(rect);
        const keys = shellHitTest(state, point.x, point.y);
        // Everything but the trailing select, so the cursor can be inspected.
        for (const item of keys.slice(0, -1)) shellKey(state, store, item);
        expect(state.menuCursor).toBe(target);
      }
    }
  });

  it("plays the table from the name box and opens Info from the Info box", () => {
    const name = centre(SELECT_NAME_BOX);
    const info = centre(SELECT_INFO_BOX);
    expect(shellHitTest(hitState("select"), name.x, name.y)).toEqual([TOUCH_KEYS.select]);
    expect(shellHitTest(hitState("select"), info.x, info.y)).toEqual([
      TOUCH_KEYS.right,
      TOUCH_KEYS.select,
    ]);
    expect(shellHitTest(hitState("select", { column: 1 }), name.x, name.y)).toEqual([
      TOUCH_KEYS.left,
      TOUCH_KEYS.select,
    ]);
    expect(shellHitTest(hitState("select", { column: 1 }), info.x, info.y)).toEqual([
      TOUCH_KEYS.select,
    ]);
  });

  it("walks the list when a finger lands off the pinned row", () => {
    const x = SELECT_NAME_BOX.x1 + 4;
    // One row below the pinned entry is the next table down.
    expect(shellHitTest(hitState("select"), x, SELECT_ROW_Y + SELECT_ROW_PITCH)).toEqual([
      TOUCH_KEYS.down,
    ]);
    // Two rows below, from the first entry, is the third table.
    expect(shellHitTest(hitState("select"), x, SELECT_ROW_Y + 2 * SELECT_ROW_PITCH)).toEqual([
      TOUCH_KEYS.down,
      TOUCH_KEYS.down,
    ]);
    // Above the pinned row from the last entry walks back up.
    const last = SHELL_TABLES.length - 1;
    expect(
      shellHitTest(hitState("select", { cursor: last }), x, SELECT_ROW_Y - SELECT_ROW_PITCH),
    ).toEqual([TOUCH_KEYS.up]);
    // A row that would be off the end of the list is not a target.
    expect(shellHitTest(hitState("select"), x, SELECT_ROW_Y - SELECT_ROW_PITCH)).toEqual([]);
  });

  it("never quits the table from a tap on the glass", () => {
    // The shell takes 'Y' and nothing else; a stray tap must resolve to the
    // answer that keeps the ball, and QUIT lives on a button that says so.
    for (const y of [0, 64, 128, 200, SHELL_HEIGHT]) {
      const keys = shellHitTest(hitState("quit-confirm"), 160, y);
      for (const key of keys) expect(key.char).not.toBe("Y");
    }
  });

  it("leaves the playfield and the initials box alone", () => {
    expect(shellHitTest(hitState("play"), 160, 128)).toEqual([]);
    // A select on `initials` COMMITS, so a brushed thumb must not be one.
    expect(shellHitTest(hitState("initials"), 160, 128)).toEqual([]);
    expect(shellHitTest(hitState("loading"), 160, 128)).toEqual([]);
  });

  it("gets on with the cards that are only waiting to be dismissed", () => {
    for (const phase of ["info", "failed", "game-over", "fanfare", "ladder"] as const) {
      expect(shellHitTest(hitState(phase), 160, 128)).toEqual([TOUCH_KEYS.select]);
    }
  });

  it("only ever produces targets inside the drawn field", () => {
    // Sweep the whole window on every phase; anything that answers must have
    // been inside the frame the renderer draws.
    for (const phase of PHASES) {
      for (let y = 0; y <= SHELL_HEIGHT; y += 2) {
        for (let x = -SHELL_ORIGIN_X; x <= SHELL_WIDTH + SHELL_ORIGIN_X; x += 2) {
          const keys = shellHitTest(hitState(phase), x, y);
          if (keys.length === 0) continue;
          if (phase === "menu" || phase === "select") {
            expect(x).toBeGreaterThanOrEqual(FIELD_X);
            expect(x).toBeLessThanOrEqual(FIELD_X + FIELD_WIDTH);
            expect(y).toBeGreaterThanOrEqual(FIELD_Y);
            expect(y).toBeLessThanOrEqual(FIELD_Y + FIELD_HEIGHT);
          }
        }
      }
    }
  });
});

describe("the deck", () => {
  it("is five slots, and every slot exists on every phase", () => {
    expect([...DECK_SLOTS]).toEqual(["left", "up", "down", "right", "action"]);
    for (const phase of PHASES) {
      const plan = deckPlanFor(phase, false);
      for (const slot of DECK_SLOTS) {
        expect(plan[slot]).toBeDefined();
        expect(typeof plan[slot].label).toBe("string");
      }
    }
  });

  it("is the cabinet in play: three bats, a shove and a launch", () => {
    const plan = deckPlanFor("play", true);
    expect(plan.left.control).toBe("leftFlipper");
    expect(plan.right.control).toBe("rightFlipper");
    expect(plan.up.control).toBe("upperFlipper");
    expect(plan.down.control).toBe("nudgeForward");
    expect(plan.action.control).toBe("plunger");
    for (const slot of DECK_SLOTS) {
      expect(plan[slot].hidden).toBe(false);
      // Nothing in play is a shell key: the game must not be steerable from the
      // shell's vocabulary and the shell must not be steerable from a bat.
      expect(plan[slot].key).toBeNull();
    }
  });

  it("hides LAUNCH when there is nothing on the plunger rod", () => {
    const plan = deckPlanFor("play", false);
    expect(plan.action.hidden).toBe(true);
    expect(plan.left.control).toBe("leftFlipper");
    expect(plan.right.control).toBe("rightFlipper");
  });

  it("binds only real controls, and every flipper the game has", () => {
    const bound = new Set<string>();
    for (const phase of PHASES) {
      for (const ball of [false, true]) {
        for (const slot of DECK_SLOTS) {
          const control = deckPlanFor(phase, ball)[slot].control;
          if (control === null) continue;
          expect(isControl(control)).toBe(true);
          bound.add(control);
        }
      }
    }
    expect(bound).toEqual(
      new Set(["leftFlipper", "rightFlipper", "upperFlipper", "nudgeForward", "plunger"]),
    );
    for (const control of bound) expect(CONTROLS).toContain(control);
  });

  it("is a d-pad and a select on every menu screen", () => {
    for (const phase of ["attract", "menu", "select", "info", "failed", "game-over", "fanfare"] as const) {
      const plan = deckPlanFor(phase, false);
      expect(plan.left.key).toEqual(TOUCH_KEYS.left);
      expect(plan.up.key).toEqual(TOUCH_KEYS.up);
      expect(plan.down.key).toEqual(TOUCH_KEYS.down);
      expect(plan.right.key).toEqual(TOUCH_KEYS.right);
      expect(plan.action.key).toEqual(TOUCH_KEYS.select);
      for (const slot of DECK_SLOTS) expect(plan[slot].control).toBeNull();
    }
  });

  it("starts a game from the table's own attract screen", () => {
    expect(deckPlanFor("ladder", false).action.key).toEqual(TOUCH_KEYS.select);
    expect(deckPlanFor("ladder", false).action.label).toBe("START");
  });

  it("is the only place the quit answer can be given", () => {
    const plan = deckPlanFor("quit-confirm", false);
    expect(plan.right.key).toEqual(TOUCH_KEYS.yes);
    expect(plan.right.key?.char).toBe("Y");
    expect(plan.right.label).toBe("QUIT");
    expect(plan.left.key).toEqual(TOUCH_KEYS.select);
    expect(plan.left.label).toBe("PLAY ON");
  });

  it("offers a delete and an accept while initials are being typed", () => {
    const plan = deckPlanFor("initials", false);
    expect(plan.left.key).toEqual(TOUCH_KEYS.erase);
    expect(plan.right.key).toEqual(TOUCH_KEYS.select);
    // A select with no character is what commits; a character would type one.
    expect(plan.right.key?.char).toBeNull();
  });

  it("shows nothing to press while a table is loading", () => {
    const plan = deckPlanFor("loading", false);
    for (const slot of DECK_SLOTS) expect(plan[slot].hidden).toBe(true);
  });

  it("labels every visible button", () => {
    for (const phase of PHASES) {
      for (const ball of [false, true]) {
        const plan = deckPlanFor(phase, ball);
        for (const slot of DECK_SLOTS as readonly DeckSlot[]) {
          const binding = plan[slot];
          if (binding.hidden) continue;
          expect(binding.label.length).toBeGreaterThan(0);
          // A visible button always does exactly one thing.
          expect((binding.control === null) !== (binding.key === null)).toBe(true);
        }
      }
    }
  });
});
