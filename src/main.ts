/**
 * Boot.
 *
 * The only file in the project that is allowed to assume a browser exists.
 * Everything it touches — the router, the loop, the simulation — was written to
 * run without one, and this module supplies the four things they cannot get for
 * themselves: a canvas, a keyboard, a clock, and the table data over the
 * network.
 *
 * Law 'n Justice is loaded because it is the table whose geometry has actually
 * been measured — its shooter lane, its flipper pivots and its 26-row virtual
 * top wall are all established facts, while the other two carry assumptions.
 * Changing tables is a one-line edit here, deliberately not a query parameter:
 * a URL switch would imply the other two are as finished as this one.
 */

import { InputRouter, attachKeyboard, isControl } from "./browser/input.js";
import {
  GameLoop,
  canvasSizeFor,
  createGame,
  debugSnapshot,
  renderGame,
  startGame,
  tickGame,
} from "./browser/game-loop.js";
import type { Game, GameDebugState } from "./browser/game-loop.js";
import type { Control } from "./browser/input.js";
import { integerScaleFor } from "./browser/playfield-renderer.js";
import { loadTableMap } from "./game/table-map.js";
import type { TableId } from "./game/contracts.js";

const TABLE: TableId = "law-n-justice";

/** The debug handle. Read-only views plus enough control to drive a whole ball. */
interface IllusionsDebugHandle {
  readonly game: Game;
  readonly loop: GameLoop;
  readonly input: InputRouter;
  /** Ball states, tick count, camera and table, flattened and JSON-safe. */
  state(): GameDebugState;
  press(control: string): void;
  release(control: string): void;
  tap(control: string): void;
  /** Runs n simulation ticks immediately, bypassing the clock. */
  tick(count?: number): GameDebugState;
  restart(): void;
}

declare global {
  interface Window {
    __illusions?: IllusionsDebugHandle;
  }
}

function requireCanvas(): HTMLCanvasElement {
  const element = document.getElementById("playfield");
  if (!(element instanceof HTMLCanvasElement)) {
    throw new Error("index.html must contain <canvas id=\"playfield\">");
  }
  return element;
}

function requireContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  // `alpha: false` lets the compositor skip blending the canvas over the page,
  // which for a full-bleed opaque playfield is free performance.
  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) {
    throw new Error("this browser did not give us a 2d canvas context");
  }
  return context;
}

/**
 * Picks the magnification and resizes the backing store to match.
 *
 * Whole numbers only, from `integerScaleFor`. The CSS keeps the element at its
 * natural pixel size, so one source pixel is always an exact square block of
 * device pixels and the rails never wobble.
 */
function fitCanvas(canvas: HTMLCanvasElement): number {
  const scale = integerScaleFor(window.innerWidth, window.innerHeight - 120);
  const size = canvasSizeFor(scale);
  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width;
    canvas.height = size.height;
  }
  return scale;
}

/**
 * Folds the connected gamepads into the router once per frame.
 *
 * Pads are polled, not evented, so this has to happen before the frame's ticks
 * sample the router or a press would land one frame late. Disconnected slots
 * are dropped explicitly: a pad that vanishes without a `gamepaddisconnected`
 * event would otherwise hold its controls down forever.
 */
function pollGamepads(router: InputRouter): void {
  if (typeof navigator.getGamepads !== "function") return;
  const pads = navigator.getGamepads();
  for (let index = 0; index < pads.length; index += 1) {
    const pad = pads[index];
    if (pad === null || pad === undefined) {
      router.dropGamepad(index);
      continue;
    }
    router.pollGamepad(pad, index);
  }
}

function reportBootFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const notice = document.getElementById("boot");
  if (notice !== null) {
    notice.textContent = `Could not start: ${message}`;
    notice.hidden = false;
  }
  console.error("pinball-illusions failed to boot", error);
}

async function boot(): Promise<void> {
  const canvas = requireCanvas();
  const context = requireContext(canvas);
  const router = new InputRouter();

  const map = await loadTableMap(TABLE);
  const game = createGame(map);

  let scale = fitCanvas(canvas);
  window.addEventListener("resize", () => {
    scale = fitCanvas(canvas);
    renderGame(context, game, scale);
  });

  attachKeyboard(router, window);

  const loop = new GameLoop({
    game,
    input: router,
    frames: {
      request: (callback) => window.requestAnimationFrame(callback),
      cancel: (handle) => window.cancelAnimationFrame(handle),
    },
    render: (current) => renderGame(context, current, scale),
    poll: () => pollGamepads(router),
  });

  // A hidden tab gets no animation frames, so the scheduler would bank the
  // whole absence as catch-up. Pausing it means the game resumes where it was
  // rather than fast-forwarding through the ball the player was not watching.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      loop.scheduler.pause();
      router.releaseAll();
    } else {
      loop.scheduler.resume();
    }
  });

  const notice = document.getElementById("boot");
  if (notice !== null) notice.hidden = true;

  // Named so a bad control from the console is a clear error rather than a
  // silent no-op, which is the failure mode that wastes an afternoon.
  const requireControl = (control: string): Control => {
    if (!isControl(control)) {
      throw new RangeError(`unknown control: ${control}`);
    }
    return control;
  };

  window.__illusions = {
    game,
    loop,
    input: router,
    state: () => debugSnapshot(game),
    press: (control) => router.press(requireControl(control), "debug"),
    release: (control) => router.release(requireControl(control), "debug"),
    tap: (control) => router.tap(requireControl(control), "debug"),
    // Steps the simulation directly rather than through `loop.frame`, because a
    // frame only runs the ticks real elapsed time has paid for, and an automated
    // check wants exactly the count it asked for.
    tick: (count = 1) => {
      for (let i = 0; i < count; i += 1) {
        tickGame(game, router.sample());
      }
      renderGame(context, game, scale);
      return debugSnapshot(game);
    },
    restart: () => startGame(game),
  };

  startGame(game);
  loop.start();
}

void boot().catch(reportBootFailure);
