/**
 * Boot.
 *
 * The only file in the project that is allowed to assume a browser exists.
 * Everything it touches — the router, the loop, the simulation — was written to
 * run without one, and this module supplies the four things they cannot get for
 * themselves: a canvas, a keyboard, a clock, and the table data over the
 * network — both halves of it, the collision map and the playfield artwork.
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
import { integerScaleFor, setPlayfieldArtwork } from "./browser/playfield-renderer.js";
import { loadTableMap } from "./game/table-map.js";
import { loadTableArt } from "./game/table-art.js";
import { loadTableAcceleration } from "./game/table-accel.js";
import { loadTableDevices } from "./game/table-devices.js";
import { loadTableModes } from "./game/table-modes.js";
import { loadTableAudio } from "./game/table-audio.js";
import { createAudioBank, loadAudioBank, playTick, resumeAudio } from "./browser/audio.js";
import type { AudioBank } from "./browser/audio.js";
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

/**
 * Brings the sound up in the background.
 *
 * Returns a handle whose `bank` is null until the manifest and every WAV have
 * loaded, and stays null forever if any of that fails. Nothing awaits it and
 * nothing checks it twice: the tick hook simply plays nothing until there is
 * something to play.
 */
function startAudio(tableId: TableId): { bank: AudioBank | null } {
  const handle: { bank: AudioBank | null } = { bank: null };
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Context === undefined) return handle;
  void (async () => {
    try {
      const audio = await loadTableAudio(tableId);
      const bank = createAudioBank(new Context(), audio);
      await loadAudioBank(bank);
      handle.bank = bank;
    } catch {
      // Silence is a correct outcome for a pinball table.
    }
  })();
  return handle;
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

  // Four files per table, and all four are required. The map is the collision
  // geometry the physics reads; the artwork is the picture the player sees; the
  // ramp drive is the per-block acceleration that carries the ball along
  // surfaces too shallow for gravity to move it against friction, without which
  // a ball reaching an arch stops there for the rest of the game; and the
  // scoring layer is the SURFACE-ID MAP plus the device, bumper, slingshot and
  // zone records — which is not only what makes the score move, but what the
  // contact model reads its restitution out of, what makes a pop bumper kick,
  // and what hands a ball from a habitrail back to the playfield.
  //
  // Fetched together because none depends on the others, and all awaited before
  // the loop starts — the renderer refuses to draw a table whose artwork is
  // missing, and `createGame` refuses to assemble one whose drive is missing,
  // rather than either of them inventing a substitute.
  const [map, artwork] = await Promise.all([
    loadTableMap(TABLE),
    loadTableArt(TABLE),
    // Both register themselves; `createGame` reads them back out of their
    // registries.
    loadTableAcceleration(TABLE),
    loadTableDevices(TABLE),
    loadTableModes(TABLE),
  ]);
  setPlayfieldArtwork(map, artwork);
  const game = createGame(map);

  // The sound comes up AFTER the game is assembled and is never awaited on the
  // boot path. It is presentation: a table that cannot fetch its samples, or a
  // browser that will not open an audio context, plays in silence and every
  // other part of the machine is unaffected. See `src/browser/audio.ts`.
  const sound = startAudio(TABLE);

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
    onTick: (report) => {
      const bank = sound.bank;
      if (bank !== null) playTick(bank, report);
    },
  });

  // Autoplay policies keep an audio context suspended until the player has
  // touched the page. A keypress is exactly that, and the loop's own input
  // already sees every one of them.
  window.addEventListener("keydown", () => {
    if (sound.bank !== null) resumeAudio(sound.bank);
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
