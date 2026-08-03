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
import {
  integerScaleFor,
  setPlayfieldArtwork,
  setPlayfieldArtworkHd,
} from "./browser/playfield-renderer.js";
import { setLampOverlaysHd } from "./browser/lamp-layer.js";
import { setMovingSpritesHd } from "./browser/sprite-layer.js";
import { HD_SCALE } from "./browser/hd-scale.js";
import { loadTableMap } from "./game/table-map.js";
import { loadTableArt, tableArtUrl } from "./game/table-art.js";
import {
  loadFlipperBatsHd,
  loadTableArtHd,
  loadTableBallHd,
  loadTableLampsHd,
} from "./game/table-art-hd.js";
import { loadTableAcceleration } from "./game/table-accel.js";
import { loadTableDevices } from "./game/table-devices.js";
import { loadTableModes } from "./game/table-modes.js";
import { loadTableLamps } from "./game/table-lamps.js";
import { loadTableBall } from "./game/table-ball.js";
import { loadFlipperBats } from "./game/flipper-bats.js";
import { loadTablePanel, tablePanelFor } from "./game/table-panel.js";
import { PanelDisplay } from "./browser/panel-display.js";
import { loadEngineAudio, loadTableAudio } from "./game/table-audio.js";
import type { EngineAudio } from "./game/table-audio.js";
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
import { loadShellMusic } from "./audio/shell-music.js";
import type { ShellFont } from "./game/shell-art.js";
import {
  MUSIC_TOGGLE_CODE,
  MUSIC_TOGGLE_KEY,
  createShellMusic,
} from "./browser/shell-music.js";
import { createTableMusic } from "./browser/table-music.js";

/** One table, assembled and ready to play. */
interface LoadedTable {
  readonly tableId: TableId;
  readonly game: Game;
  readonly loop: GameLoop;
  /**
   * The score panel: the decoded slot-5 animation heap behind a display-queue
   * reconstruction, fed per tick and drawn above the playfield. Null when the
   * table's panel document did not load — the game plays identically and the
   * score stays on the text HUD.
   */
  readonly panel: PanelDisplay | null;
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
 * Whether the HD presentation set is live: flipped the first time a table's
 * HD master loads and registers, never before, never speculatively. Until
 * then — and forever, in a build without the HD assets — the canvas rules
 * below are byte-for-byte the pre-HD ones.
 */
let hdActive = false;

/**
 * Picks the magnification and resizes the backing store to match.
 *
 * NATIVE MODE: whole numbers only, from `integerScaleFor`. The CSS keeps the
 * element at its natural pixel size, so one source pixel is always an exact
 * square block of device pixels and the rails never wobble.
 *
 * HD MODE: the backing store is fixed at `HD_SCALE` (1344x1024 — a 4x
 * supersampled window) and CSS fits the element to the viewport instead,
 * aspect preserved. That deliberately repeals the "CSS must not scale the
 * element" rule, which existed to protect a NATIVE-resolution picture from
 * fractional resampling; a 4x supersampled picture is protected BY the
 * browser's bilinear downscale — exactly how Pinball Fantasies HD ships its
 * 4x masters into a ≤3x canvas. `image-rendering: pixelated` is lifted for
 * the same reason, and only in this mode.
 */
function fitCanvas(canvas: HTMLCanvasElement): number {
  if (hdActive) {
    const size = canvasSizeFor(HD_SCALE);
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width;
      canvas.height = size.height;
    }
    const fit = Math.min(
      window.innerWidth / size.width,
      Math.max(0.1, window.innerHeight - 120) / size.height,
    );
    canvas.style.width = `${Math.max(1, Math.round(size.width * fit))}px`;
    canvas.style.height = `${Math.max(1, Math.round(size.height * fit))}px`;
    canvas.style.imageRendering = "auto";
    return HD_SCALE;
  }
  const scale = integerScaleFor(window.innerWidth, window.innerHeight - 120);
  const size = canvasSizeFor(scale);
  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width;
    canvas.height = size.height;
  }
  canvas.style.removeProperty("width");
  canvas.style.removeProperty("height");
  canvas.style.removeProperty("image-rendering");
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
  /**
   * The engine's seven sounds — one manifest for the whole machine, fetched
   * once and shared by every table's bank. Null (forever, if the fetch fails)
   * costs exactly the engine's events their sound and nothing else.
   */
  #engine: Promise<EngineAudio | null> | null = null;

  get bank(): AudioBank | null {
    return this.#current;
  }

  #engineAudio(): Promise<EngineAudio | null> {
    this.#engine ??= loadEngineAudio().catch(() => null);
    return this.#engine;
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
        const [audio, engine] = await Promise.all([loadTableAudio(tableId), this.#engineAudio()]);
        const bank = createAudioBank(host, audio, engine);
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
  // The table music — the in-game module, decoded from each table's own two
  // SNT! banks — driven by the tick reports and the same phase. It borrows
  // the deck's context too, and follows the shell music's persisted mute.
  const tableMusic = createTableMusic(() => sound.context());
  tableMusic.setMuted(music.muted());
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
  /**
   * The small shell font (`font2`), for the score panel's score view — the
   * font whose comma and digit advances are the 3 and 7 the original's own
   * `300 - (3*commas + 7*digits)` column arithmetic sums. Read per frame by
   * each table's `PanelDisplay`, which draws nothing until it arrives.
   */
  let panelFont: ShellFont | null = null;
  void loadShellArt()
    .then((art) => {
      panelFont = art.font2;
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

  /**
   * The front-end module, decoded from the disks and shipped behind the
   * authorization gate. The controller plays nothing until this lands, and
   * nothing at all if it never does — a build without the authorized assets is
   * a silent shell, not a broken one.
   */
  void loadShellMusic((url) => fetch(url))
    .then((asset) => {
      music.useAsset(asset);
      if (asset === null) {
        console.warn("pinball-illusions: front-end music unavailable, shell will be silent");
      }
    })
    .catch((error: unknown) => {
      console.warn("pinball-illusions: front-end music unavailable, shell will be silent", error);
    });

  thumbnails.warm();

  const draw = (): void => {
    if (table !== null && shellDrawsOverPlayfield(shell)) {
      renderGame(context, table.game, scale, table.panel);
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
   * Eight files, and seven of them are required. The map is the collision
   * geometry the physics reads; the artwork is the picture the player sees; the
   * ramp drive is the per-block acceleration that carries the ball along
   * surfaces too shallow for gravity to move it against friction, without which
   * a ball reaching an arch stops there for the rest of the game; the scoring
   * layer is the SURFACE-ID MAP plus the device, bumper, slingshot and zone
   * records — which is not only what makes the score move, but what the contact
   * model reads its restitution out of, what makes a pop bumper kick, and what
   * hands a ball from a habitrail back to the playfield; the mission layer is
   * the bytecode that starts a mode, counts it down and ends it; and the bat
   * pose bank and the ball sprite are the two things on the table that move,
   * which are drawn from the disk's own pixels or not at all.
   *
   * Fetched together because none depends on the others, and all awaited before
   * a game is assembled — the renderer refuses to draw a table whose artwork is
   * missing, and `createGame` refuses to assemble one whose drive is missing,
   * rather than either of them inventing a substitute. The sprites are required
   * for the same reason: without them the renderer draws magenta markers, which
   * is deliberately unmistakable rather than quietly plausible.
   */
  const assemble = async (tableId: TableId): Promise<LoadedTable> => {
    const [map, artwork, , , , , , , , artHd, lampsHd, ballHd, batsHd] = await Promise.all([
      loadTableMap(tableId),
      loadTableArt(tableId),
      // These six register themselves; `createGame` and the renderer read them
      // back out of their registries.
      loadTableAcceleration(tableId),
      loadTableDevices(tableId),
      loadTableModes(tableId),
      loadTableLamps(tableId),
      loadTableBall(tableId),
      // One shared document for all three tables: the raster is
      // table-independent and only the palette differs.
      loadFlipperBats(),
      // The panel heap registers itself too, but tolerantly: it is
      // presentation only, so a table whose panel document will not fetch
      // still plays an identical ball and shows the score as text.
      loadTablePanel(tableId).catch((error: unknown) => {
        console.warn(`pinball-illusions: ${tableId} panel animations unavailable`, error);
        return null;
      }),
      // The HD presentation set — 4x master, lamp dim-patch atlas, ball, bat
      // atlas. All four are OPTIONAL-WITH-LOUD-FALLBACK, the panel's pattern:
      // a table whose HD set is missing (or half missing) renders through the
      // native-resolution path unchanged and says so in the console, because
      // the native artwork above is the real disk picture and the renderer
      // must never invent a substitute for it.
      loadTableArtHd(tableId).catch((error: unknown) => {
        console.warn(`pinball-illusions: ${tableId} HD artwork unavailable, using native resolution`, error);
        return null;
      }),
      loadTableLampsHd(tableId).catch((error: unknown) => {
        console.warn(`pinball-illusions: ${tableId} HD lamp patches unavailable, using native overlays`, error);
        return null;
      }),
      loadTableBallHd(tableId).catch((error: unknown) => {
        console.warn(`pinball-illusions: ${tableId} HD ball unavailable, using native sprites`, error);
        return null;
      }),
      loadFlipperBatsHd(tableId).catch((error: unknown) => {
        console.warn(`pinball-illusions: ${tableId} HD bats unavailable, using native sprites`, error);
        return null;
      }),
    ]);
    setPlayfieldArtwork(map, artwork);
    if (artHd !== null) {
      setPlayfieldArtworkHd(map, artHd);
      setLampOverlaysHd(map, lampsHd);
      // Both movers or neither: mixing one HD sprite with one native sprite
      // on the same overlay would be a resolution seam nobody chose.
      setMovingSpritesHd(map, ballHd !== null && batsHd !== null ? { ball: ballHd, bats: batsHd } : null);
      if (!hdActive) {
        hdActive = true;
        scale = fitCanvas(canvas);
      }
    }
    const game = createGame(map);
    const heap = tablePanelFor(tableId);
    const panel = heap === null ? null : new PanelDisplay(heap, () => panelFont);
    // The loop's animation frames are never used: the single driver below calls
    // `frame()` by hand. What the loop is here for is its SCHEDULER — the fixed
    // step and the catch-up clamp — and keeping one per table means a table
    // returned to after ten minutes in the menus does not owe ten minutes of
    // ticks.
    const onTick = (report: GameTickReport): void => {
      const bank = sound.bank;
      if (bank !== null) playTick(bank, report);
      // The music reads the same finished report: serve -> vamp, launch ->
      // main queued at the lap boundary, tilt -> the stop section.
      tableMusic.observe(report);
      // The panel consumes the same per-tick reports the audio does — the
      // debug handle's `tick` goes through this hook too, so a scripted game
      // queues exactly the animations a played one does.
      panel?.observe(report);
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
      render: (current) => renderGame(context, current, scale, panel),
      onTick,
    });
    return { tableId, game, loop, panel, onTick };
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
      tableMusic.select(tableId);
      apply(shellTableLoaded(shell));
      return Promise.resolve();
    }

    const task = (async () => {
      try {
        const next = await assemble(tableId);
        opened.set(tableId, next);
        table = next;
        sound.select(tableId);
        tableMusic.select(tableId);
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
            // The display ring's contents belong to the game that queued
            // them; a fresh game opens on the score view.
            table.panel?.reset();
            sound.resume();
          }
          break;
        case "leave-table":
          // The table object stays in `opened` — the pixels and the parsed
          // documents are expensive and the player may come straight back — but
          // nothing is ticked or drawn until it is chosen again.
          table = null;
          sound.silence();
          tableMusic.clear();
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
    tableMusic.resume();

    // The mute toggle, from any phase. The backquote is bound to no game
    // control, no shell navigation, no function-key table pick and no
    // initials character, so taking it here steals nothing from anyone.
    // One toggle covers both modules — the shell's and the table's — with
    // the shell's persisted state as the single source of truth.
    if (keyEvent.code === MUSIC_TOGGLE_CODE || keyEvent.key === MUSIC_TOGGLE_KEY) {
      if (keyEvent.repeat !== true) tableMusic.setMuted(music.toggleMuted());
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
      // visible frame's `update` starts the song afresh. The table music
      // stops for the same reason (its next serve brings it back).
      music.stop();
      tableMusic.stop();
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
    // The music follows the shell's phase: the front-end module over every
    // menu and card, the table's own module over the ball. One call a frame
    // each handles the transitions and pumps the scheduler's lookahead
    // window; the table controller also gates the module's channel 3 while
    // the effects channel is sounding, which is Paula's AUD3 rule.
    music.update(shell.phase);
    tableMusic.update(shell.phase, sound.bank);

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
