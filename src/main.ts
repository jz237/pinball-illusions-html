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
 * 3. DRIVE. One animation frame loop and TWO fixed-step clocks, both at 50 Hz.
 *    In `play` it advances the simulation through `GameLoop.frame` and gives the
 *    shell the same tick count; in every other phase `ShellClock` converts the
 *    frame's elapsed real time into whole shell ticks. Whichever clock is not
 *    driving is paused, so time spent in a menu is never banked as catch-up
 *    ticks against the next ball and time spent on the table is never banked
 *    against the credits roll. This loop used to advance the shell by a literal
 *    one tick per animation frame, which ran the whole front end at the
 *    display's refresh rate — 2.88x too fast on a 144 Hz screen.
 */

import { InputRouter, isControl } from "./browser/input.js";
import type { Control, KeyEventLike } from "./browser/input.js";
import {
  GameLoop,
  ballInLane,
  createGame,
  debugSnapshot,
  framingRows,
  playerCountAdjustable,
  playerScoresOf,
  renderGame,
  setPlayerCount,
  startGame,
  tickGame,
} from "./browser/game-loop.js";
import type { Game, GameDebugState, GameTickReport, RenderFraming } from "./browser/game-loop.js";
import { VIEWPORT_HEIGHT } from "./browser/camera.js";
import { attachFrontDoor } from "./browser/front-door.js";
import type { FrontDoor } from "./browser/front-door.js";
import { attachIntro, introFireKey, loadIntroAssets } from "./browser/intro.js";
import type { IntroHandle } from "./browser/intro.js";
import { setPlayfieldArtwork, setPlayfieldArtworkHd } from "./browser/playfield-renderer.js";
import { canvasFitFor } from "./browser/canvas-fit.js";
import { COARSE_POINTER_QUERY, attachTouch } from "./browser/touch.js";
import type { TouchHandle } from "./browser/touch.js";
import { setLampOverlaysHd } from "./browser/lamp-layer.js";
import { setMovingSpritesHd } from "./browser/sprite-layer.js";
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
  shellSetPlayers,
  shellTableFailed,
  shellTableLoaded,
  shellTick,
} from "./browser/shell.js";
import type { ShellEffect, ShellKey, ShellState } from "./browser/shell.js";
import { ShellClock } from "./browser/shell-clock.js";
import { renderShell, shellDrawsOverPlayfield } from "./browser/shell-screens.js";
import type { ShellArtworkSource } from "./browser/shell-screens.js";
import { createShellSkin } from "./browser/shell-skin.js";
import type { ShellSkin } from "./browser/shell-skin.js";
import { loadShellArt } from "./game/shell-art.js";
import { loadLoadingLogoHd, loadShellArtHd } from "./game/shell-art-hd.js";
import { loadLoadingLogo } from "./game/loading-logo.js";
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

/**
 * The box the picture is fitted into.
 *
 * Sized by the stylesheet — `100svh` minus the deck minus the safe-area insets
 * on a phone, the window minus the page's own padding on a desktop — and
 * MEASURED here rather than computed. That is the whole of the fix for
 * `window.innerHeight - 120`: the 120 was desktop chrome expressed as a
 * constant, it does not exist on a phone, and in landscape it cost the canvas a
 * third of its height. Falling back to the canvas's parent keeps a hand-edited
 * page working.
 */
function requireStage(canvas: HTMLCanvasElement): HTMLElement {
  const element = document.getElementById("stage");
  if (element instanceof HTMLElement) return element;
  return canvas.parentElement ?? document.body;
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

/** The version the front door's footer and the game bar print. */
const BUILD_VERSION = "v0.1.0";

/**
 * THE FRAMING — the render-layer full-table/Amiga choice of
 * `RenderFraming` (`game-loop.ts`), owned here beside `hdActive` because it
 * is the same kind of fact: presentation, never simulation. Default
 * FULL-TABLE, which is Fantasies' default and the reason the operator asked
 * for the toggle; persisted so a returning player keeps their choice, and
 * overridable per link with `?camera=original` / `?camera=amiga` (Fantasies'
 * own URL contract) or `?camera=full`.
 */
const FRAMING_STORAGE_KEY = "pinball-illusions/framing";

function framingFromQuery(search: string): RenderFraming | null {
  try {
    const camera = new URLSearchParams(search).get("camera");
    if (camera === "original" || camera === "amiga") return "amiga";
    if (camera === "full" || camera === "full-table") return "full-table";
  } catch {
    // An unparsable query string chooses nothing.
  }
  return null;
}

function initialFraming(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  search: string,
): RenderFraming {
  const fromQuery = framingFromQuery(search);
  if (fromQuery !== null) return fromQuery;
  try {
    const stored = storage?.getItem(FRAMING_STORAGE_KEY);
    if (stored === "amiga" || stored === "full-table") return stored;
  } catch {
    // Blocked storage forgets the choice; it must not stop the boot.
  }
  return "full-table";
}

/** `navigator.connection.saveData`, which counts as a coarse pointer would. */
function dataSaverRequested(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

function coarsePointer(): boolean {
  try {
    return window.matchMedia(COARSE_POINTER_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Picks the magnification, resizes the backing store, and sizes the element.
 *
 * The decision itself is `canvasFitFor`, which is pure and tested; everything
 * here is measurement and assignment. Three outcomes:
 *
 * NATIVE ON A FINE POINTER: whole numbers only. The element is left at its
 * natural pixel size, so one source pixel is always an exact square block of
 * device pixels and the rails never wobble.
 *
 * OTHERWISE — HD, or a coarse pointer in either mode — the element is fitted to
 * the stage with `image-rendering: auto`. That deliberately repeals the "CSS
 * must not scale the element" rule, which existed to protect a
 * NATIVE-resolution picture from fractional resampling; a supersampled picture
 * is protected BY the browser's bilinear downscale, exactly how Pinball
 * Fantasies HD ships its 4x masters into a smaller canvas. On a phone the
 * NATIVE branch has to be fitted too, or a build without the HD assets renders
 * 336 x 256 in the corner of the screen and is unplayable — easy to miss,
 * because a development machine always has the HD assets.
 */
function fitCanvas(
  canvas: HTMLCanvasElement,
  stage: HTMLElement,
  touch: boolean,
  logicalHeight: number,
): number {
  const fit = canvasFitFor(
    { width: stage.clientWidth, height: stage.clientHeight },
    {
      hd: hdActive,
      coarsePointer: touch || coarsePointer(),
      dataSaver: dataSaverRequested(),
      devicePixelRatio: window.devicePixelRatio,
      logicalHeight,
    },
  );
  if (canvas.width !== fit.canvasWidth || canvas.height !== fit.canvasHeight) {
    canvas.width = fit.canvasWidth;
    canvas.height = fit.canvasHeight;
  }
  if (fit.cssWidth === null || fit.cssHeight === null) {
    canvas.style.removeProperty("width");
    canvas.style.removeProperty("height");
    canvas.style.removeProperty("image-rendering");
    return fit.scale;
  }
  canvas.style.width = `${fit.cssWidth}px`;
  canvas.style.height = `${fit.cssHeight}px`;
  canvas.style.imageRendering = fit.smooth ? "auto" : "pixelated";
  return fit.scale;
}

/**
 * The pad button that flips the framing. Read HERE, not through the router:
 * the view toggle is presentation, so the button was dropped from
 * `GAMEPAD_BUTTON_BINDINGS` and its edges are detected at this boundary the
 * way F9/F10 are intercepted ahead of the key router. Button 3 (Y/Triangle),
 * the binding the sim-side toggle used to hold.
 */
const GAMEPAD_VIEW_BUTTON = 3;

/** Last polled state of the view button per pad slot, for the rising edge. */
const padViewHeld = new Map<number, boolean>();

/**
 * Folds the connected gamepads into the router once per frame.
 *
 * Pads are polled, not evented, so this has to happen before the frame's ticks
 * sample the router or a press would land one frame late. Disconnected slots
 * are dropped explicitly: a pad that vanishes without a `gamepaddisconnected`
 * event would otherwise hold its controls down forever.
 *
 * `onViewToggle` fires once per rising edge of the view button on any pad —
 * the presentation seam, never a control.
 */
function pollGamepads(router: InputRouter, onViewToggle?: () => void): void {
  if (typeof navigator.getGamepads !== "function") return;
  const pads = navigator.getGamepads();
  for (let index = 0; index < pads.length; index += 1) {
    const pad = pads[index];
    if (pad === null || pad === undefined) {
      router.dropGamepad(index);
      padViewHeld.delete(index);
      continue;
    }
    router.pollGamepad(pad, index);
    const viewDown = pad.buttons[GAMEPAD_VIEW_BUTTON]?.pressed === true;
    if (viewDown && padViewHeld.get(index) !== true) onViewToggle?.();
    padViewHeld.set(index, viewDown);
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
  const stage = requireStage(canvas);
  const context = requireContext(canvas);
  const router = new InputRouter();
  const sound = new SoundDeck();
  const thumbnails = new ThumbnailCache();
  const storage = readStorage();
  const store = createScoreStore(storage);
  const shell = createShell(store);
  /**
   * The shell's own 50 Hz clock, for every frame the playfield is not driving.
   *
   * One per page rather than one per table, and never reset: the backdrop
   * service's palette lap and the credits roll are free-running counters that
   * the original does not restart when you move between screens, and neither
   * does this.
   */
  const shellClock = new ShellClock();
  // The shell music: driven by `shell.phase` from the frame loop below, over
  // the deck's shared context. Never awaited, never read by the simulation.
  const music = createShellMusic(storage, () => sound.context());
  // The table music — the in-game module, decoded from each table's own two
  // SNT! banks — driven by the tick reports and the same phase. It borrows
  // the deck's context too, and follows the shell music's persisted mute.
  const tableMusic = createTableMusic(() => sound.context());
  tableMusic.setMuted(music.muted());
  const opened = new Map<TableId, LoadedTable>();

  /**
   * The touch chrome, attached below once the shell exists.
   *
   * Held in a mutable so `refit` can ask whether the deck is showing without
   * the two having to be constructed in the same breath — the deck needs the
   * shell, the shell's first frame needs a fitted canvas.
   */
  let touch: TouchHandle | null = null;

  /**
   * The front door, attached below once the effects exist. Declared here so
   * the key router above it in source order can consult `door.idling()`
   * without a temporal dead zone.
   */
  let door: FrontDoor | null = null;

  /**
   * THE INTRO — `intro.bin`'s cold-boot cinematic, attached at the bottom of
   * this function and non-null only while it owns the screen. The original
   * plays it on every boot before its shell ever appears, so this build plays
   * it once per page load before the front door; any fire input skips it
   * (`introFireKey` + the pointer and gamepad paths below), and `onDone`
   * simply nulls this out — the next animation frame takes the normal path
   * and lands on the front door exactly as a build without the intro does.
   * While it is non-null the shell clock is held paused, so the attract roll
   * and the credits cycle behind the door start from zero afterwards, which
   * is what the machine's own boot does.
   */
  let intro: IntroHandle | null = null;

  /**
   * THE FRAMING (§2 of the parity brief): full table by default, the Amiga
   * window as the live toggle. Presentation only — the simulation's own
   * `forceFullTable` field stays untouched and hashed, and no input path
   * reaches it any more.
   */
  let framing: RenderFraming = initialFraming(storage, window.location.search);

  /**
   * Logical canvas rows right now: the framing's rows while the playfield
   * presentation is on screen, the 256-row shell page everywhere else — the
   * decoded menus and the credits attract are 336 x 256 screens and stay so.
   */
  const canvasRows = (): number =>
    shellDrawsOverPlayfield(shell) ? framingRows(framing) : VIEWPORT_HEIGHT;

  const refit = (): number => fitCanvas(canvas, stage, touch?.active() ?? false, canvasRows());

  let scale = refit();
  /** The stage size the canvas was last fitted to. See the frame loop. */
  let stageWidth = stage.clientWidth;
  let stageHeight = stage.clientHeight;
  /** The logical rows the canvas was last fitted for. See the frame loop. */
  let fittedRows = canvasRows();
  let table: LoadedTable | null = null;
  /**
   * Set by the tick hook the moment a game reports its last ball gone: every
   * player's final score in player order, for the shell's high-score walk.
   */
  let endedWithScores: readonly number[] | null = null;

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
    .then(async (art) => {
      panelFont = art.font2;
      // The loading logo is a SEPARATE fetch with its own manifest, because it
      // belongs to the loader rather than to `menudata.bin`. It must not be able
      // to take the shell down with it: a build without the authorized assets
      // has no logo to fetch, and `createShellSkin` takes null for exactly that
      // case — the Loading page then sets the word in the font instead.
      const logo = await loadLoadingLogo().catch((error: unknown) => {
        console.warn("pinball-illusions: loading logo unavailable, using the font", error);
        return null;
      });
      // THE HD SHELL SET (phase 3). Optional-with-loud-fallback, exactly like a
      // table's HD master: a build without it draws the shell through the
      // native path unchanged. The two HD files move together — a 4x strip
      // under a native font atlas would be two resolutions of one screen — so a
      // failed strip fetch takes the whole HD skin down and nothing else.
      const artHd = await loadShellArtHd().catch((error: unknown) => {
        console.warn("pinball-illusions: HD shell artwork unavailable, using native", error);
        return null;
      });
      const logoHd =
        artHd === null
          ? null
          : await loadLoadingLogoHd().catch((error: unknown) => {
              console.warn("pinball-illusions: HD loading logo unavailable, using native", error);
              return null;
            });
      skin = createShellSkin(
        art,
        (width, height) => {
          const surface = document.createElement("canvas");
          surface.width = width;
          surface.height = height;
          return surface;
        },
        logo,
        artHd === null ? null : { art: artHd, logo: logoHd },
      );
      // The shell is the FIRST thing on screen and every screen before a table
      // loads is one of its pages, so the HD presentation has to go live here
      // rather than waiting for a board. Same flip, same refit, same one-way
      // latch as the table path below.
      if (artHd !== null && !hdActive) {
        hdActive = true;
        scale = refit();
      }
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

  /**
   * Flips the framing and persists the choice. A LIVE CUT: refit the canvas,
   * redraw the frame — no reload, because nothing in this renderer is
   * startup-baked (which is Fantasies' one limitation this port does not
   * share; its flag changes composites baked at boot, so it reloads).
   */
  const setFraming = (next: RenderFraming): void => {
    if (next === framing) return;
    framing = next;
    try {
      storage?.setItem(FRAMING_STORAGE_KEY, next);
    } catch {
      // A blocked storage forgets the choice; the toggle still works.
    }
    scale = refit();
    fittedRows = canvasRows();
    draw();
  };

  const toggleFraming = (): RenderFraming => {
    setFraming(framing === "full-table" ? "amiga" : "full-table");
    return framing;
  };

  /**
   * The shell, drawn wherever the current canvas puts its 336 x 256 page.
   *
   * Over a full-table-framed playfield the canvas is 616 rows and the shell's
   * cards (quit-confirm, game over, initials, ladder) would otherwise pin to
   * the top of the picture; a translate centres their 256-row page over the
   * board. Everywhere else — every framing's play frame aside — the canvas IS
   * 256 rows and the offset is zero, byte-for-byte the old draw.
   */
  const drawShellOverlay = (): void => {
    const offsetRows =
      framing === "full-table" && shellDrawsOverPlayfield(shell)
        ? (framingRows(framing) - VIEWPORT_HEIGHT) >> 1
        : 0;
    if (offsetRows > 0) context.setTransform(1, 0, 0, 1, 0, offsetRows * scale);
    renderShell(context, shell, scale, thumbnails, skin);
    if (offsetRows > 0) context.setTransform(1, 0, 0, 1, 0, 0);
  };

  const draw = (): void => {
    if (table !== null && shellDrawsOverPlayfield(shell)) {
      renderGame(context, table.game, scale, table.panel, framing);
    }
    drawShellOverlay();
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
        scale = refit();
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
      // The scores are read here rather than after the frame because the
      // game's own phase has already moved to `game-over` and nothing further
      // will change them — but reading at the tick keeps the two in step even
      // if that ever stops being true. Every player's, in player order: the
      // shell's high-score walk visits each exactly as the machine's state-2
      // loop walks the player records.
      if (report.gameOver) endedWithScores = playerScoresOf(game);
    };
    const loop = new GameLoop({
      game,
      input: router,
      frames: { request: () => 0, cancel: () => undefined },
      render: (current) => renderGame(context, current, scale, panel, framing),
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
            startGame(table.game, effect.players);
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

  /**
   * The gesture that lets a browser make a sound.
   *
   * Autoplay policies keep an audio context suspended until the player has
   * touched the page, and on a phone the FIRST touch is the only chance the
   * page gets — which is why `sound.context()` is called here rather than
   * merely resumed: the context is constructed inside the gesture task if it
   * does not exist yet, and all three owners (the effects deck, the shell
   * module and the table module) are resumed over it.
   *
   * Not `{ once: true }`, which is where the sibling Pinball Fantasies build
   * and the sibling Pinball Dreams build differ and where Dreams is right: iOS
   * re-suspends a context after an interruption — a phone call, the control
   * centre — and a listener that has already removed itself cannot recover.
   * `resumeAudio` guards on `state !== "suspended"`, so the repeat is free.
   */
  const unlockAudio = (): void => {
    sound.context();
    sound.resume();
    music.resume();
    tableMusic.resume();
  };

  const onKeyDown = (event: Event): void => {
    const keyEvent = event as KeyEventLike;
    // A keypress is a gesture; so is a touch, which is wired below.
    unlockAudio();
    door?.noteActivity(performance.now());
    // The soft keyboard on the initials screen has its own element and its own
    // `input` handler. Letting the window listener see the same keystroke would
    // type every character twice.
    if (touch?.ownsKeyboard(event.target) === true) return;

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

    // THE INTRO'S FIRE SKIP. The original polls fire on both joystick ports
    // and exits the whole show; here any fire input — flipper keys, launch,
    // Enter — does the same, and every other key is swallowed so nothing
    // leaks into the shell behind a screen it is not drawing. (The mute
    // above deliberately stays reachable: it is not a fire input.)
    if (intro !== null) {
      if (introFireKey(keyEvent) && keyEvent.repeat !== true) intro.skip();
      keyEvent.preventDefault?.();
      return;
    }

    // THE FRAMING TOGGLE, intercepted before the input router exactly as the
    // mute is: F9/F10 flip the render-layer framing (§2 of the parity brief)
    // and are no longer bound to any control, so the simulation never hears
    // the key at all. Any phase — the choice is about the canvas, not the
    // game, and flipping it in a menu simply takes effect on the next table.
    const code = keyEvent.code ?? "";
    const keyName = (keyEvent.key ?? "").toLowerCase();
    if (code === "F9" || code === "F10" || keyName === "f9" || keyName === "f10") {
      if (keyEvent.repeat !== true) toggleFraming();
      keyEvent.preventDefault?.();
      return;
    }

    const key = shellKeyFor(keyEvent);

    // The idle attract behind the front door. The decoded paths keep
    // working — SPACE forward into the menu, F1-F3 straight to a table,
    // exactly the filmed 0x1128 behaviour — and every key those screens
    // would IGNORE wakes the front door instead, which is the §3 rule
    // ("any key/tap returns to the front door") minus the keys the
    // authentic navigation itself claims.
    if (door !== null && door.idling() && shell.phase === "attract") {
      if (key === null || (key.kind !== "select" && key.kind !== "table")) {
        door.noteActivity(performance.now());
        door.refresh(shell.phase, shell.tableId, performance.now());
        keyEvent.preventDefault?.();
        return;
      }
    }

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
      // F1..F8 WHILE BALL 1 WAITS ON THE ROD: the original's state-5 scan
      // (`$d7c` window, main.seg00 +0x004AD6) lets latecomers join — Fn sets
      // the player count outright, clamp eight. The shell's sticky selection
      // follows so the next game keeps the choice. Outside the window the
      // keys fall through to the router, which binds none of them.
      if (key !== null && key.kind === "table" && table !== null && playerCountAdjustable(table.game)) {
        if (setPlayerCount(table.game, key.index + 1)) {
          shellSetPlayers(shell, key.index + 1);
        }
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

  /**
   * One synthesised key, down exactly the path a keyboard key takes.
   *
   * `ShellKey` is already device-free, so the touch layer produces them and
   * hands them here rather than extending the shell's vocabulary — which is why
   * `src/browser/shell.ts` and its tests are untouched by the whole mobile
   * round. The flush mirrors the ESC-in-play path above: leaving the table with
   * a bat held would otherwise carry the hold into the next game.
   */
  const routeShellKey = (key: ShellKey): void => {
    const before = shell.phase;
    apply(shellKey(shell, store, key));
    if (before === "play" && shell.phase !== "play") flushInput();
  };

  touch = attachTouch({
    router,
    canvas,
    shellState: () => shell,
    ballInLane: () => table !== null && ballInLane(table.game),
    shellKey: routeShellKey,
    gesture: unlockAudio,
    toggleMute: () => {
      const muted = music.toggleMuted();
      tableMusic.setMuted(muted);
      return muted;
    },
    muted: () => music.muted(),
    toggleFraming,
    framing: () => framing,
  });

  // The front door (§3 of the parity brief): the HTML card page over the
  // decoded shell. Optional at runtime — a hand-edited page without the
  // section boots straight into the canvas attract, exactly the old entry.
  const doorElement = document.getElementById("door");
  if (doorElement instanceof HTMLElement) {
    door = attachFrontDoor(doorElement, {
      // The decoded F-key path, so a card click and F1 are the same state.
      playTable: (tableId) => apply(shellPlayTable(shell, store, tableId)),
      ladder: (tableId) => store.load(tableId),
      gesture: unlockAudio,
      version: () => BUILD_VERSION,
      // The stepper reads and writes the shell's sticky player selection —
      // the same field the table attract's F1..F8 sets — so a card click
      // starts the game the stepper shows.
      players: () => shell.players,
      setPlayers: (players) => shellSetPlayers(shell, players),
    });
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => router.releaseAll());
  // A touch is a gesture too, and on a phone it is the only one there will be.
  // Capture phase so it is seen before any handler that stops the event; the
  // same gesture is the idle clock's activity, and — while the idle attract
  // has the screen — the tap that brings the front door back, swallowed
  // before the canvas hit test can read it as the attract's SPACE.
  window.addEventListener(
    "pointerdown",
    (event) => {
      unlockAudio();
      // A click or a tap is the intro's fire too — the original's mouse
      // button is wired to the same exit. Swallowed before anything else can
      // read it, exactly as the idle-attract wake below is.
      if (intro !== null) {
        intro.skip();
        event.stopPropagation();
        return;
      }
      const now = performance.now();
      if (door !== null && door.idling() && shell.phase === "attract") {
        door.noteActivity(now);
        door.refresh(shell.phase, shell.tableId, now);
        event.stopPropagation();
        return;
      }
      door?.noteActivity(now);
    },
    { capture: true },
  );

  const onViewportChange = (): void => {
    scale = refit();
    draw();
  };
  window.addEventListener("resize", onViewportChange);
  // The stylesheet owns how big the stage is — `100svh` minus the deck minus
  // the safe-area insets — so the honest way to learn its size is to be told.
  // A `resize` listener alone misses a deck that relabels to a taller row and
  // misses the address bar settling on a phone.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(onViewportChange).observe(stage);
  }
  // Rotating releases everything: the sibling Pinball Fantasies build does the
  // same, because a rotation can swallow the pointer-up for a bat that was held
  // across it and leave the flipper welded down.
  window.addEventListener("orientationchange", () => router.releaseAll());

  /**
   * The page going away.
   *
   * A hidden tab gets no animation frames, so the scheduler would bank the
   * whole absence as catch-up. Pausing it means the game resumes where it was
   * rather than fast-forwarding through the ball the player was not watching;
   * the music stops for the matching reason, since its scheduler would run its
   * lookahead dry and leave the looped voices droning.
   *
   * `pagehide` as well as `visibilitychange`, because iOS often fires only the
   * former when the app is swiped away or the page enters the back/forward
   * cache; `pageshow`, because a bfcache restore can resurrect a page whose
   * pointers ended while it was frozen. Both siblings listen for both.
   */
  const suspendPage = (): void => {
    table?.loop.scheduler.pause();
    // The shell's clock for the same reason the simulation's: a page that comes
    // back after ten minutes must not spend its first frame turning credits
    // pages. The catch-up clamp would bound it at eight ticks anyway; pausing
    // means those eight are not run either.
    shellClock.pause();
    // And the intro clock, or a backgrounded boot would come back mid-show
    // with the whole absence banked (clamped, but eight frames nobody saw).
    intro?.pause();
    router.releaseAll();
    music.stop();
    tableMusic.stop();
  };
  const resumePage = (): void => {
    router.releaseAll();
    table?.loop.scheduler.resume();
    shellClock.resume();
    intro?.resume();
  };
  window.addEventListener("pagehide", suspendPage);
  window.addEventListener("pageshow", resumePage);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      table?.loop.scheduler.pause();
      shellClock.pause();
      intro?.pause();
      router.releaseAll();
      // A hidden tab gets no frames, so the music's scheduler would run its
      // lookahead dry and leave the looped voices droning. Stop it; the first
      // visible frame's `update` starts the song afresh. The table music
      // stops for the same reason (its next serve brings it back).
      music.stop();
      tableMusic.stop();
    } else {
      table?.loop.scheduler.resume();
      shellClock.resume();
      intro?.resume();
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
   * banked — and `shellClock` decides instead, at the same fixed 50 Hz.
   *
   * Exactly one of the two clocks is running at any moment, and the crossing is
   * a pause on one and a re-seed on the other. That is what stops either from
   * charging for the time the other owned.
   */
  const frame = (timeMs: number): void => {
    pollGamepads(router, toggleFraming);
    // The front door follows the shell's phase and the idle clock; it owns
    // the `data-door-mode` attribute the stylesheet reads. While the intro
    // holds the screen the door is not consulted at all — it stays exactly
    // as the markup ships it, hidden — so the first thing it ever paints is
    // the post-intro boot state.
    if (intro === null) door?.refresh(shell.phase, shell.tableId, timeMs);
    const covered = intro === null && door?.showing() === true;
    // Read the layout BEFORE the deck writes to it, so a relabel never forces a
    // synchronous reflow. Two integers compared per frame is nothing, and it
    // makes the fit self-healing: the `ResizeObserver` above reacts sooner, but
    // this catches the deck appearing for the first time, a browser without an
    // observer, and anything else that changes the box without a resize event.
    // Skipped while the door covers the cabinet: the stage measures zero
    // under `display: none`, and a fit against nothing is a fit to undo.
    if (
      !covered &&
      (stage.clientWidth !== stageWidth ||
        stage.clientHeight !== stageHeight ||
        canvasRows() !== fittedRows)
    ) {
      stageWidth = stage.clientWidth;
      stageHeight = stage.clientHeight;
      fittedRows = canvasRows();
      scale = refit();
    }
    // The deck's five buttons are a function of the phase — the cabinet's
    // controls in play, a d-pad everywhere else — so something has to follow
    // the phase. It only touches the DOM when a label actually changed.
    touch?.refresh();
    // The music follows the shell's phase: the front-end module over every
    // menu and card, the table's own module over the ball. One call a frame
    // each handles the transitions and pumps the scheduler's lookahead
    // window; the table controller also gates the module's channel 3 while
    // the effects channel is sounding, which is Paula's AUD3 rule.
    music.update(shell.phase);
    tableMusic.update(shell.phase, sound.bank);

    // THE INTRO OWNS THE FRAME. The shell's clock is held paused so the
    // attract roll starts from zero when the door appears; the front-end
    // music above keeps being pumped — the original starts the tune WITH the
    // intro, and the browser's autoplay gate means it actually sounds from
    // the first gesture, mid-show or later, which is the shipped unlock path
    // and no new audio code. Any pressed gamepad button is the original's
    // joystick fire and skips, same as the key and pointer routes.
    if (intro !== null) {
      if (!shellClock.paused) shellClock.pause();
      if (typeof navigator.getGamepads === "function") {
        for (const pad of navigator.getGamepads()) {
          if (pad === null || pad === undefined) continue;
          if (pad.buttons.some((button) => button?.pressed === true)) {
            intro.skip();
            break;
          }
        }
      }
      intro?.frame(timeMs);
      window.requestAnimationFrame(frame);
      return;
    }

    if (shell.phase === "play" && table !== null) {
      // Only on the transition. `resume()` with no timestamp deliberately
      // re-seeds on the next `advance`, so calling it every frame would hand
      // the simulation an empty batch forever.
      if (table.loop.scheduler.paused) table.loop.scheduler.resume();
      // The playfield is driving the shell this frame; the shell's own clock
      // must not also charge for it, or every ball played would turn credits
      // pages behind the table.
      if (!shellClock.paused) shellClock.pause();
      const ticks = table.loop.frame(timeMs);
      apply(shellTick(shell, store, ticks));
      if (endedWithScores !== null) {
        shellGameEnded(shell, endedWithScores);
        endedWithScores = null;
        flushInput();
      }
      // The shell draws nothing over a live table, but a card raised on this
      // very frame has to appear on the frame that raised it.
      if (shell.phase !== "play") drawShellOverlay();
      window.requestAnimationFrame(frame);
      return;
    }

    if (table !== null && !table.loop.scheduler.paused) table.loop.scheduler.pause();
    apply(shellClock.frame(timeMs, shell, store));
    // No canvas work while the HTML door covers the cabinet — the shell's
    // clocks keep running above (the attract lap and the palette cycle are
    // free-running, exactly as the machine's are), so the roll the idle
    // handoff reveals is mid-flight, not restarted.
    if (!covered) draw();
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
        if (endedWithScores !== null) {
          shellGameEnded(shell, endedWithScores);
          endedWithScores = null;
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

  // `?table=<id>` boots straight into a game — the front door's card hrefs
  // and Fantasies' own URL contract. Through the same decoded F-key path a
  // click takes, so a shared link and a keypress are the same state.
  let bootTable: TableId | null = null;
  try {
    const requested = new URLSearchParams(window.location.search).get("table");
    if (requested !== null && isTableId(requested)) bootTable = requested;
  } catch {
    // An unparsable query string boots the front door, which is the default.
  }
  if (bootTable !== null) apply(shellPlayTable(shell, store, bootTable));

  // THE INTRO, attached last and awaited before the first frame: a cold load
  // plays `intro.bin`'s cinematic before the front door, once per load, the
  // way the original plays it before its shell on every boot. AWAITED because
  // the alternative is the door flashing up and then being replaced, which no
  // boot of the machine ever showed; the fetch is ~500 KB against assets the
  // page was about to fetch anyway, and the "Loading…" notice covers it. A
  // build without the gated intro assets rejects on the first fetch and boots
  // straight to the door, unchanged — and a `?table=` deep link skips the
  // show entirely, because a shared link into a game is not a cold boot of
  // the machine, and 82 seconds of history lesson before someone's champion
  // run would be hostile.
  if (bootTable === null) {
    try {
      const assets = await loadIntroAssets();
      intro = attachIntro(assets, {
        context,
        canvas,
        surface: (width, height) => {
          const surface = document.createElement("canvas");
          surface.width = width;
          surface.height = height;
          return surface;
        },
        onDone: () => {
          // The next animation frame takes the normal path: the shell clock
          // resumes itself and the front door paints — the same first frame
          // a build without the intro shows.
          intro = null;
        },
      });
      shellClock.pause();
    } catch (error) {
      console.warn("pinball-illusions: intro unavailable, booting to the front door", error);
    }
  }

  window.requestAnimationFrame(frame);
}

void boot().catch(reportBootFailure);
