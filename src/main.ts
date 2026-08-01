/**
 * Boot.
 *
 * The only file in the project that is allowed to assume a browser exists.
 * Everything it touches — the shell, the router, the loop, the simulation — was
 * written to run without one, and this module supplies the five things they
 * cannot get for themselves: a canvas, a keyboard, a clock, an audio context and
 * the table data over the network.
 *
 * It used to load one hard-coded table and hand it straight to the loop. It now
 * boots into the SHELL — `src/browser/shell.ts`, which is `main.bin`'s two state
 * machines — and the shell decides which of the three tables, if any, is loaded.
 * All three are reachable and all three are playable; there is no build-time
 * choice of table left anywhere.
 *
 * THE THREE JOBS THIS FILE HAS
 * ---------------------------------------------------------------------------
 * 1. FETCH. `openTable` pulls the five documents and the picture that make one
 *    table and assembles a `Game` on them. Tables are kept once opened, so going
 *    back to one you have already played is instant — the original re-reads
 *    everything from floppy on every trip through the menu, which is a property
 *    of the medium rather than of the design.
 * 2. ROUTE. One keydown listener, and it decides per phase who the key belongs
 *    to. In `play` the game gets everything except ESC; everywhere else the
 *    shell gets everything it recognises and the game gets nothing at all.
 * 3. DRIVE. One animation frame loop. In `play` it advances the simulation
 *    through `GameLoop.frame`; in every other phase it advances the shell's own
 *    clock and draws a menu. The simulation's scheduler is paused whenever the
 *    shell is showing, so time spent in a menu is never banked as catch-up ticks
 *    against the next ball.
 */

import { InputRouter, isControl } from "./browser/input.js";
import type { Control, KeyEventLike } from "./browser/input.js";
import {
  GameLoop,
  canvasSizeFor,
  createGame,
  currentScore,
  debugSnapshot,
  renderGame,
  startGame,
  tickGame,
} from "./browser/game-loop.js";
import type { Game, GameDebugState, GameTickReport } from "./browser/game-loop.js";
import { integerScaleFor, setPlayfieldArtwork } from "./browser/playfield-renderer.js";
import { loadTableMap } from "./game/table-map.js";
import { loadTableArt, tableArtUrl } from "./game/table-art.js";
import { loadTableAcceleration } from "./game/table-accel.js";
import { loadTableDevices } from "./game/table-devices.js";
import { loadTableModes } from "./game/table-modes.js";
import { loadTableAudio } from "./game/table-audio.js";
import { createAudioBank, loadAudioBank, playTick, resumeAudio } from "./browser/audio.js";
import type { AudioBank } from "./browser/audio.js";
import { TABLE_IDS } from "./game/contracts.js";
import type { TableId } from "./game/contracts.js";
import {
  createScoreStore,
  createShell,
  shellGameEnded,
  shellKey,
  shellKeyFor,
  shellPlayTable,
  shellTableFailed,
  shellTableLoaded,
  shellTick,
} from "./browser/shell.js";
import type { ShellEffect, ShellState } from "./browser/shell.js";
import { renderShell, shellDrawsOverPlayfield } from "./browser/shell-screens.js";
import type { ShellArtworkSource } from "./browser/shell-screens.js";
import { createShellSkin } from "./browser/shell-skin.js";
import type { ShellSkin } from "./browser/shell-skin.js";
import { loadShellArt } from "./game/shell-art.js";
import {
  MUSIC_TOGGLE_CODE,
  MUSIC_TOGGLE_KEY,
  createShellMusic,
} from "./browser/shell-music.js";

/** One table, assembled and ready to play. */
interface LoadedTable {
  readonly tableId: TableId;
  readonly game: Game;
  readonly loop: GameLoop;
  /**
   * The per-tick hook the loop runs, exposed so the debug handle's `tick` runs
   * it too.
   *
   * Without this, stepping the simulation by hand would play no sound and —
   * much worse — would never tell the shell the game had ended, so an automated
   * check driving a game to its last ball would sit in `play` forever and the
   * whole high-score path would be unreachable from a script. A debug entry
   * point that takes a different route through the machine than the player does
   * is a debug entry point that proves nothing.
   */
  readonly onTick: (report: GameTickReport) => void;
}

/** The debug handle. Read-only views plus enough control to drive a whole ball. */
interface IllusionsDebugHandle {
  readonly input: InputRouter;
  /** The shell's own state: which screen, which cursor, which ladder. */
  shell(): ShellState;
  /** The game on the table currently open, or null in the menus. */
  game(): Game | null;
  /** Ball states, tick count, camera and table, flattened and JSON-safe. */
  state(): GameDebugState | null;
  press(control: string): void;
  release(control: string): void;
  tap(control: string): void;
  /** Runs n simulation ticks immediately, bypassing the clock. */
  tick(count?: number): GameDebugState | null;
  restart(): void;
  /** Opens a table and starts a game on it, as the shell's F-keys do. */
  play(tableId: string): Promise<void>;
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
 * The sound: one bank per table over one shared context.
 *
 * One context because a browser will only give a page a handful of them and a
 * player who tries all three tables would run the allowance out; one bank per
 * table because the samples are that table's own. Nothing here is ever awaited
 * on a path that matters — a table whose samples will not fetch plays in
 * silence and every other part of the machine is unaffected.
 */
class SoundDeck {
  #context: AudioContext | null = null;
  readonly #banks = new Map<TableId, AudioBank>();
  #current: AudioBank | null = null;

  get bank(): AudioBank | null {
    return this.#current;
  }

  #host(): AudioContext | null {
    if (this.#context !== null) return this.#context;
    const Context =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Context === undefined) return null;
    this.#context = new Context();
    return this.#context;
  }

  /**
   * The one context, shared. The shell music runs its own nodes but must not
   * cost the page a second `AudioContext` out of the browser's small
   * allowance, so it borrows this deck's — created on whichever of the two
   * asks first.
   */
  context(): AudioContext | null {
    return this.#host();
  }

  /** Brings a table's bank up in the background and makes it the live one. */
  select(tableId: TableId): void {
    const existing = this.#banks.get(tableId);
    if (existing !== undefined) {
      this.#current = existing;
      return;
    }
    this.#current = null;
    const host = this.#host();
    if (host === null) return;
    void (async () => {
      try {
        const audio = await loadTableAudio(tableId);
        const bank = createAudioBank(host, audio);
        await loadAudioBank(bank);
        this.#banks.set(tableId, bank);
        this.#current = bank;
      } catch {
        // Silence is a correct outcome for a pinball table.
      }
    })();
  }

  silence(): void {
    this.#current = null;
  }

  resume(): void {
    if (this.#current !== null) resumeAudio(this.#current);
  }
}

/**
 * The pictures behind the table-select and info screens.
 *
 * Straight `<img>` elements pointed at the artwork the build already ships and
 * already accounts for in its manifest. `guard:public` refuses any raster no
 * manifest claims, and exporting a second, menu-sized copy would mean a second
 * set of digests for no gain; the original's own 128 x 128 logo panels live in
 * the `.mnu` packages and are not exported at all. They are fetched on demand,
 * once each, and a fetch that fails leaves the panel showing its placeholder
 * rather than stopping the menu.
 */
class ThumbnailCache implements ShellArtworkSource {
  readonly #images = new Map<TableId, HTMLImageElement>();
  readonly #ready = new Set<TableId>();

  imageFor(tableId: TableId): CanvasImageSource | null {
    const existing = this.#images.get(tableId);
    if (existing === undefined) {
      const image = new Image();
      image.decoding = "async";
      image.addEventListener("load", () => this.#ready.add(tableId));
      image.src = tableArtUrl(tableId);
      this.#images.set(tableId, image);
      return null;
    }
    return this.#ready.has(tableId) ? existing : null;
  }

  /** Starts every fetch at once, so the first menu the player sees is filled. */
  warm(): void {
    for (const tableId of TABLE_IDS) this.imageFor(tableId);
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

function isTableId(value: string): value is TableId {
  return (TABLE_IDS as readonly string[]).includes(value);
}

function readStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return window.localStorage;
  } catch {
    // A browser with storage blocked still plays; it just forgets the ladder.
    return null;
  }
}

async function boot(): Promise<void> {
  const canvas = requireCanvas();
  const context = requireContext(canvas);
  const router = new InputRouter();
  const sound = new SoundDeck();
  const thumbnails = new ThumbnailCache();
  const storage = readStorage();
  const store = createScoreStore(storage);
  const shell = createShell(store);
  // The shell music: driven by `shell.phase` from the frame loop below, over
  // the deck's shared context. Never awaited, never read by the simulation.
  const music = createShellMusic(storage, () => sound.context());
  const opened = new Map<TableId, LoadedTable>();

  let scale = fitCanvas(canvas);
  let table: LoadedTable | null = null;
  /** Set by the tick hook the moment a game reports its last ball gone. */
  let endedWithScore: number | null = null;

  /**
   * The decoded `menudata.bin` presentation — fonts, backdrop strips, palette.
   *
   * Fetched in the background and swapped in whenever it lands; until then (or
   * forever, if the fetch fails) every screen draws its placeholder rendering,
   * so the shell is usable from the first frame. Never awaited on any path
   * that matters, exactly like the sound banks.
   */
  let skin: ShellSkin | null = null;
  void loadShellArt()
    .then((art) => {
      skin = createShellSkin(art, (width, height) => {
        const surface = document.createElement("canvas");
        surface.width = width;
        surface.height = height;
        return surface;
      });
    })
    .catch((error: unknown) => {
      console.warn("pinball-illusions: shell artwork unavailable, using placeholder", error);
    });

  thumbnails.warm();

  const draw = (): void => {
    if (table !== null && shellDrawsOverPlayfield(shell)) {
      renderGame(context, table.game, scale);
    }
    renderShell(context, shell, scale, thumbnails, skin);
  };

  /**
   * Clears every held control and the edges that go with them.
   *
   * Called on every crossing between the shell and the table. Without it the
   * key that chose a table is still held when the first ball is served, and its
   * release lands on the game's first tick as a phantom flipper.
   */
  const flushInput = (): void => {
    router.releaseAll();
    router.sample();
  };

  // -------------------------------------------------------------------------
  // Fetching and assembling a table
  // -------------------------------------------------------------------------

  /**
   * Five files, and all five are required. The map is the collision geometry the
   * physics reads; the artwork is the picture the player sees; the ramp drive is
   * the per-block acceleration that carries the ball along surfaces too shallow
   * for gravity to move it against friction, without which a ball reaching an
   * arch stops there for the rest of the game; the scoring layer is the
   * SURFACE-ID MAP plus the device, bumper, slingshot and zone records — which
   * is not only what makes the score move, but what the contact model reads its
   * restitution out of, what makes a pop bumper kick, and what hands a ball from
   * a habitrail back to the playfield; and the mission layer is the bytecode
   * that starts a mode, counts it down and ends it.
   *
   * Fetched together because none depends on the others, and all awaited before
   * a game is assembled — the renderer refuses to draw a table whose artwork is
   * missing, and `createGame` refuses to assemble one whose drive is missing,
   * rather than either of them inventing a substitute.
   */
  const assemble = async (tableId: TableId): Promise<LoadedTable> => {
    const [map, artwork] = await Promise.all([
      loadTableMap(tableId),
      loadTableArt(tableId),
      // These three register themselves; `createGame` reads them back out of
      // their registries.
      loadTableAcceleration(tableId),
      loadTableDevices(tableId),
      loadTableModes(tableId),
    ]);
    setPlayfieldArtwork(map, artwork);
    const game = createGame(map);
    // The loop's animation frames are never used: the single driver below calls
    // `frame()` by hand. What the loop is here for is its SCHEDULER — the fixed
    // step and the catch-up clamp — and keeping one per table means a table
    // returned to after ten minutes in the menus does not owe ten minutes of
    // ticks.
    const onTick = (report: GameTickReport): void => {
      const bank = sound.bank;
      if (bank !== null) playTick(bank, report);
      // The score is read here rather than after the frame because the game's
      // own phase has already moved to `game-over` and nothing further will
      // change it — but reading it at the tick keeps the two in step even if
      // that ever stops being true.
      if (report.gameOver) endedWithScore = currentScore(game);
    };
    const loop = new GameLoop({
      game,
      input: router,
      frames: { request: () => 0, cancel: () => undefined },
      render: (current) => renderGame(context, current, scale),
      onTick,
    });
    return { tableId, game, loop, onTick };
  };

  /**
   * Loads a table at most once, however many times it is asked for.
   *
   * The in-flight map is not an optimisation. Two overlapping calls for the same
   * table each finish with their own freshly `createGame`d state, and the second
   * one to land replaces the first — including replacing the game that
   * `start-game` has already served a ball into with one that has never been
   * started. The shell then sits in `play` over a table in `attract`, with no
   * ball and no way to get one. Sharing the promise means the second caller
   * waits for the first caller's table rather than building a rival.
   */
  const inFlight = new Map<TableId, Promise<void>>();

  const openTable = (tableId: TableId): Promise<void> => {
    const running = inFlight.get(tableId);
    if (running !== undefined) return running;

    const cached = opened.get(tableId);
    if (cached !== undefined) {
      table = cached;
      sound.select(tableId);
      apply(shellTableLoaded(shell));
      return Promise.resolve();
    }

    const task = (async () => {
      try {
        const next = await assemble(tableId);
        opened.set(tableId, next);
        table = next;
        sound.select(tableId);
        apply(shellTableLoaded(shell));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`pinball-illusions could not load ${tableId}`, error);
        shellTableFailed(shell, message);
        table = null;
      } finally {
        inFlight.delete(tableId);
      }
    })();
    inFlight.set(tableId, task);
    return task;
  };

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  function apply(effects: readonly ShellEffect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case "load-table":
          void openTable(effect.tableId);
          break;
        case "start-game":
          if (table !== null) {
            flushInput();
            table.loop.scheduler.resume();
            startGame(table.game);
            sound.resume();
          }
          break;
        case "leave-table":
          // The table object stays in `opened` — the pixels and the parsed
          // documents are expensive and the player may come straight back — but
          // nothing is ticked or drawn until it is chosen again.
          table = null;
          sound.silence();
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  const onKeyDown = (event: Event): void => {
    const keyEvent = event as KeyEventLike;
    // Autoplay policies keep an audio context suspended until the player has
    // touched the page. A keypress is exactly that.
    sound.resume();
    music.resume();

    // The mute toggle, from any phase. The backquote is bound to no game
    // control, no shell navigation, no function-key table pick and no
    // initials character, so taking it here steals nothing from anyone.
    if (keyEvent.code === MUSIC_TOGGLE_CODE || keyEvent.key === MUSIC_TOGGLE_KEY) {
      if (keyEvent.repeat !== true) music.toggleMuted();
      keyEvent.preventDefault?.();
      return;
    }

    const key = shellKeyFor(keyEvent);

    if (shell.phase === "play") {
      // ESC belongs to the shell on the playfield — the original asks "REALLY
      // QUIT TABLE?" and takes only 'Y' for an answer — and every other key
      // belongs to the game. The router never sees this event, which is what
      // stops the same ESC from also toggling the game's own pause underneath.
      if (key !== null && key.kind === "back") {
        apply(shellKey(shell, store, key));
        flushInput();
        keyEvent.preventDefault?.();
        return;
      }
      if (router.handleKeyDown(keyEvent) !== null) keyEvent.preventDefault?.();
      return;
    }

    if (key === null) return;
    // Auto-repeat must not walk the menu cursor at the OS repeat rate, and it
    // must not type an initial three times.
    if (keyEvent.repeat === true) {
      keyEvent.preventDefault?.();
      return;
    }
    apply(shellKey(shell, store, key));
    keyEvent.preventDefault?.();
  };

  const onKeyUp = (event: Event): void => {
    const keyEvent = event as KeyEventLike;
    // Releases always go through, whatever phase the shell is in: a flipper key
    // still held when the last ball drained has to come up even though the
    // key-down that follows it will go to a menu.
    if (router.handleKeyUp(keyEvent) !== null) keyEvent.preventDefault?.();
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => router.releaseAll());

  window.addEventListener("resize", () => {
    scale = fitCanvas(canvas);
    draw();
  });

  // A hidden tab gets no animation frames, so the scheduler would bank the
  // whole absence as catch-up. Pausing it means the game resumes where it was
  // rather than fast-forwarding through the ball the player was not watching.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      table?.loop.scheduler.pause();
      router.releaseAll();
      // A hidden tab gets no frames, so the music's scheduler would run its
      // lookahead dry and leave the looped voices droning. Stop it; the first
      // visible frame's `update` starts the song afresh.
      music.stop();
    } else {
      table?.loop.scheduler.resume();
    }
  });

  // -------------------------------------------------------------------------
  // The frame
  // -------------------------------------------------------------------------

  /**
   * One animation frame.
   *
   * In `play` the simulation's own scheduler decides how many ticks the frame is
   * worth and `GameLoop.frame` runs and draws them; the shell's clock is then
   * advanced by the same count, so the two never drift. In every other phase the
   * simulation is stopped dead — its scheduler paused, so the wall time is not
   * banked — and the shell is advanced one tick per frame, which is what the
   * attract roll and the info screen's typewriter run on.
   */
  const frame = (timeMs: number): void => {
    pollGamepads(router);
    // The music follows the shell's phase: on over every menu and card, off
    // over the ball. One call a frame both handles the transitions and pumps
    // the scheduler's lookahead window.
    music.update(shell.phase);

    if (shell.phase === "play" && table !== null) {
      // Only on the transition. `resume()` with no timestamp deliberately
      // re-seeds on the next `advance`, so calling it every frame would hand
      // the simulation an empty batch forever.
      if (table.loop.scheduler.paused) table.loop.scheduler.resume();
      const ticks = table.loop.frame(timeMs);
      apply(shellTick(shell, store, ticks));
      if (endedWithScore !== null) {
        shellGameEnded(shell, endedWithScore);
        endedWithScore = null;
        flushInput();
      }
      // The shell draws nothing over a live table, but a card raised on this
      // very frame has to appear on the frame that raised it.
      if (shell.phase !== "play") renderShell(context, shell, scale, thumbnails, skin);
      window.requestAnimationFrame(frame);
      return;
    }

    if (table !== null && !table.loop.scheduler.paused) table.loop.scheduler.pause();
    apply(shellTick(shell, store, 1));
    draw();
    window.requestAnimationFrame(frame);
  };

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
    input: router,
    shell: () => shell,
    game: () => table?.game ?? null,
    state: () => (table === null ? null : debugSnapshot(table.game)),
    press: (control) => router.press(requireControl(control), "debug"),
    release: (control) => router.release(requireControl(control), "debug"),
    tap: (control) => router.tap(requireControl(control), "debug"),
    // Steps the simulation directly rather than through `loop.frame`, because a
    // frame only runs the ticks real elapsed time has paid for, and an automated
    // check wants exactly the count it asked for.
    tick: (count = 1) => {
      const current = table;
      if (current === null) return null;
      for (let i = 0; i < count; i += 1) {
        // Through the same hook the loop uses, so a scripted game reaches the
        // game-over card and the high-score entry exactly as a played one does.
        current.onTick(tickGame(current.game, router.sample()));
        if (endedWithScore !== null) {
          shellGameEnded(shell, endedWithScore);
          endedWithScore = null;
          break;
        }
      }
      draw();
      return debugSnapshot(current.game);
    },
    restart: () => {
      if (table !== null) startGame(table.game);
    },
    play: async (tableId: string) => {
      if (!isTableId(tableId)) throw new RangeError(`unknown table: ${tableId}`);
      // Through the shell rather than around it, so the console and the
      // function keys end up in exactly the same state.
      apply(shellPlayTable(shell, store, tableId));
      await openTable(tableId);
    },
  };

  window.requestAnimationFrame(frame);
}

void boot().catch(reportBootFailure);
