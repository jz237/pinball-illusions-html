/**
 * The game loop: the seam where the simulation, the player and the screen meet.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SIMULATION AND THE SCREEN ARE SEPARATE CLOCKS
 * ---------------------------------------------------------------------------
 * Every constant in the physics is per PAL field — gravity in Q10 per tick,
 * flipper stroke in ticks, plunger charge in ticks, tilt cooldown in ticks — so
 * the simulation may only ever advance in whole 1/50 s steps. A browser hands
 * out animation frames at whatever its display runs at: 60 Hz, 120 Hz, 24 Hz
 * while a tab is throttled, and a burst of one after a garbage collection.
 * Stepping the physics once per frame would make the ball fall at a different
 * rate on every machine and would make a recorded input log unreplayable.
 *
 * So `FixedStepScheduler` converts elapsed real time into a whole number of
 * ticks and `GameLoop.frame` runs exactly that many, then renders once. The
 * render reads the state the ticks left behind; nothing the renderer does can
 * be read back by the simulation, which is what keeps a 144 Hz monitor and a
 * headless test producing the same ball.
 *
 * ---------------------------------------------------------------------------
 * INPUT IS SAMPLED PER TICK, NOT PER FRAME
 * ---------------------------------------------------------------------------
 * `InputRouter.sample` clears its edge buffers, so it must be called exactly
 * once per simulation tick — that is its documented contract. Sampling per
 * frame instead would give the first tick of a three-tick catch-up batch all
 * the presses and the other two none, and a flipper tap that happened to land
 * in a slow frame would arrive three ticks late. The loop therefore samples
 * inside the tick loop, and takes its input as an `InputSource` interface so a
 * test can hand it a script instead of a keyboard.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LANE BALL IS PINNED
 * ---------------------------------------------------------------------------
 * The shipped collision layer has no floor under the shooter lane — column 322
 * of Law 'n Justice is free all the way to the last row — because on the real
 * machine the ball rests on the plunger rod, and the rod is no more present in
 * the playfield bitmap than the flippers are. A served ball therefore has to be
 * held in place by the ball lifecycle rather than by the map: while
 * `laneBallId` is set the loop restores that ball to the serve point after the
 * step, and the moment the plunger fires the id is cleared and the ball becomes
 * an ordinary ball with an upward velocity.
 *
 * The same fact runs the other way too. A plunge too weak to carry the ball round
 * the top arch drops back down the lane, and since the lane floor IS the rod, the
 * ball ends up back on it: `ballBackOnTheRod` re-pins it and re-arms the plunger
 * so the player may shoot again. Without that an under-plunge would leave a live
 * ball resting in the lane with no way to move it and no way to lose it.
 *
 * ---------------------------------------------------------------------------
 * THE BALL SEARCH
 * ---------------------------------------------------------------------------
 * `runBallSearch` writes off balls that have stayed inside a box of one ball
 * radius for `ballSearchTicks`. It is a real mechanism — every machine has one —
 * but it is also load-bearing here in a way it should not stay: most of the
 * device layer does not exist yet, so nothing empties the playfield's kicker
 * holes, and a ball that finds one would otherwise end the game silently. It is
 * deliberately position-based rather than velocity-based; see `ballsLeftTheBox`
 * for the two bugs that taught the current shape. It watches only balls IN PLAY:
 * a ball in a lock is motionless on purpose and for as long as the rules like.
 *
 * ---------------------------------------------------------------------------
 * BALL LOCKS, AND THE TWO SERVE QUEUES THAT ARE REALLY ONE
 * ---------------------------------------------------------------------------
 * `ball-locks.ts` owns capture and release; this file owns what the machine does
 * about them. Two counters, and the distinction between them is the whole of it:
 *
 *   `ballsServed`    balls the PLAYER has been given. `ballsPerGame` of these
 *                    ends the game.
 *   `pendingServes`  balls the MACHINE owes the lane and which cost the player
 *                    nothing: the replacement for a ball a lock just swallowed,
 *                    and the balls a multiball puts into play.
 *
 * Both come out of the same plunger lane through the same countdown, one at a
 * time and never while a ball is already sitting on the rod — which is the
 * original's rule too. Its server at data 0x65EE decrements the queue at
 * `$D86(a5)` and then sets `$D88/$D89(a5)`, and those are cleared only by the
 * shooter-lane zone at data 0x54C2, so the next queued ball cannot be fed until
 * the previous one has left the lane.
 *
 * End of ball is `no ball in play and nothing owed`, NOT "no active balls": a
 * held ball is active. Getting that wrong is a silent hang — the last ball drains
 * while a saucer still holds one, the drain path sees a non-zero active count,
 * never ends the ball, and the ball search cannot help because the only ball left
 * is one it is right to ignore. So the end-of-ball path gives the locks' balls
 * back to the trough first.
 *
 * ---------------------------------------------------------------------------
 * WHY `resolveFlipperContacts` IS CALLED WITHOUT A PUSH CLAMP
 * ---------------------------------------------------------------------------
 * `ball-physics.ts` builds the map-aware clamp it hands to `resolveBallCollisions`
 * in a private factory, so there is nothing to pass here and rewriting one would
 * be a second, subtly different implementation of a rule that already exists.
 * The unclamped case is recoverable rather than fatal: a bat can push a ball at
 * most its own penetration — a few pixels — into a wall, and `stepBalls` runs
 * `recoverPenetration` on the very next tick, which walks a ball whose centre is
 * inside solid material back out. Exporting the clamp factory would remove even
 * that, and is the right fix when ball-physics.ts is next opened.
 */

import type { Control, ControlSnapshot } from "./input.js";
import { isDown, plungerInputFrom, wasPressed } from "./input.js";
import type { CameraOptions, CameraState } from "./camera.js";
import {
  DEFAULT_CAMERA_OPTIONS,
  INITIAL_CAMERA,
  VIEWPORT_HEIGHT,
  toViewport,
  updateCamera,
  viewScale,
} from "./camera.js";
import { drawPlayfield } from "./playfield-renderer.js";
import {
  BALL_FILL,
  BALL_HIGHLIGHT,
  BALL_SHADE,
  FLIPPER_EDGE,
  FLIPPER_FILL,
  HUD_ALERT,
  HUD_TEXT,
  SURROUND,
} from "./palette.js";
import type {
  BallState,
  MaterialTable,
  PlayfieldLevel,
  SimulationForces,
  TableMap,
} from "../game/contracts.js";
import { PLAYFIELD_WIDTH } from "../game/contracts.js";
import type { Q10 } from "../core/fixed-point.js";
import { q10ToPixel } from "../core/fixed-point.js";
import { FixedStepScheduler, millisecondsToNanos } from "../core/fixed-step-scheduler.js";
import type { BallSet, SimulationOptions } from "../game/ball-physics.js";
import {
  DEFAULT_SIMULATION_OPTIONS,
  activeBalls,
  ballById,
  createBallSet,
  freeBallCount,
  freeBalls,
  pruneInactiveBalls,
  stepBalls,
} from "../game/ball-physics.js";
import type { LockBank } from "../game/ball-locks.js";
import {
  LOCKS_TO_LIGHT_MULTIBALL,
  MULTIBALL_BALL_COUNT,
  ballsToTopUp,
  captureBalls,
  createLockBank,
  heldBallCount,
  releaseHeldBalls,
} from "../game/ball-locks.js";
import { BALL_RADIUS_PIXELS, DEFAULT_PROBE_RADIUS } from "../game/collision-probe.js";
import type { FlipperBank } from "../game/flippers.js";
import {
  FLIPPER_BOSS_RADIUS_PIXELS,
  createFlipperBank,
  flipperEndpoints,
  flipperInputFrom,
  resolveFlipperContacts,
  tickFlipperBank,
} from "../game/flippers.js";
import { materialTableFor } from "../game/materials.js";
import type { TableAcceleration } from "../game/table-accel.js";
import { tableAccelerationFor } from "../game/table-accel.js";
import type { PlungerConfig, PlungerState } from "../game/plunger.js";
import {
  INITIAL_PLUNGER,
  PLUNGER_REFERENCE_GRAVITY,
  autoLaunchOutcome,
  chargeLevel,
  launchBall,
  plungerConfigFor,
  resetPlunger,
  serveBall,
  servePosition,
  shooterLaneFor,
  tickPlunger,
} from "../game/plunger.js";
import type { NudgeConfig, NudgeDirection, TiltState } from "../game/tilt.js";
import {
  INITIAL_TILT,
  flippersLive,
  nudge,
  nudgeConfigFor,
  resetTiltForNewBall,
  tickTilt,
} from "../game/tilt.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Balls in a game. Record 1 of `table00N.opt` reads `current 3, max 5,
 * default 3` on all three tables, which is the documented 3-or-5 choice; 3 is
 * the shipped current value and so the one a fresh install plays.
 */
export const DEFAULT_BALLS_PER_GAME = 3;

/**
 * Ticks between a drain and the next serve — one second at 50 Hz.
 *
 * Not decoration: serving on the same tick as the drain would teleport the
 * camera from wherever the ball died straight to the lane, and would give a
 * player still holding the plunger from the last launch a fired spring they
 * never wound.
 */
export const SERVE_DELAY_TICKS = 50;

/** Shorter for the first ball of a game — the player is already waiting. */
export const FIRST_SERVE_DELAY_TICKS = 25;

/**
 * Ticks of a completely motionless table before the machine gives up on the
 * ball — ten seconds at 50 Hz.
 *
 * Every real machine has this. It is called a ball search: when no switch has
 * closed for long enough the machine pulses its coils, and if that does not
 * shift anything it writes the ball off and serves the next one, because a ball
 * that has settled somewhere the playfield cannot return it from would otherwise
 * end the game silently. This reconstruction needs it for the same reason and
 * one more: the device layer is not built yet. Law 'n Justice's playfield has
 * places a ball legitimately arrives at and cannot leave under gravity alone —
 * the spiral around the left spinner at about (86, 155) is the clearest — and on
 * the real machine a kicker empties them. Until those devices exist, this is
 * what stops the game hanging.
 *
 * ---------------------------------------------------------------------------
 * THE ONE SITE THAT IS STILL LOAD-BEARING, MEASURED AND WRITTEN DOWN
 * ---------------------------------------------------------------------------
 * Law 'n Justice, (8,388) and its neighbours (8,389), (9,387), (7,389),
 * (19,378). Every remaining write-off on that table is in one place and it is
 * not a friction problem, an acceleration problem or a level problem. It was
 * measured rather than guessed and the answer is a negative, so here is the
 * negative:
 *
 *   - WHAT THE BALL IS RESTING ON. The 9x9 wire-support post at (12,400), on
 *     its left shoulder, jammed against the table's left edge. The probe reads
 *     ZERO contacts at (8,388) itself and the ring's straight-down sample at
 *     (8,397) is solid, so the contact normal is exactly vertical, the
 *     tangential velocity is exactly zero, and the ball is at rest for a
 *     completely correct reason. Traced tick by tick it arrives with
 *     v = (-1850, 934), rattles between the post and the edge for ninety ticks
 *     and settles at v = (0,0).
 *   - WHY IT CANNOT ROLL OFF. The gap between the post's left edge (x=8) and the
 *     playfield's left edge (x=0) is 8 px and the ball is 16. The gap between
 *     that post and the next one at (22,391) is 4.5 px. There is no way past on
 *     either side.
 *   - WHY THE PLACE IS A TRAP AND NOT A DIP. The far-left strip it sits at the
 *     bottom of runs from y=150 to y=388 between the table's left edge and the
 *     left spiral's outer wall, and it is a SEALED POCKET on the lower line: its
 *     free ball-centre runs go [8-19] at y=150, [8-13] at 300, [8-32] at 345,
 *     [8-10] at 387, [8-8] at 388 and NOTHING at 389, and its only opening is
 *     the top-left bowl above it. Below the posts the lower line reopens at
 *     y=397, but not connected to it.
 *   - WHY THE OTHER LINE DOES NOT HELP. The upper line carries the left
 *     habitrail through the same strip, but on its own columns: [12-13] from
 *     y=264 to 377, then [16-17] at 388 while the lower line has [8-8]. There is
 *     no row where the two lines agree across the columns a ball rolling down
 *     the strip actually occupies, so the `left-apron` / `crown-mouth` hand-off
 *     pattern has nothing to attach to. A gate at the columns the ball uses
 *     would drop it inside the habitrail's rail.
 *   - AND IT IS NOT MISSING DRIVE. The original's own acceleration map carries
 *     (0,0) in every block of the strip and of the left ramp above it, on BOTH
 *     levels. It has no zone there because it never has a ball there.
 *
 * So the ball search is doing the only thing available, and this comment is here
 * so the next person does not spend the afternoon re-deriving it. What would
 * close it is a device — a kicker, or whatever the original puts at the foot of
 * that strip — and no such device appears in any table module decoded so far.
 *
 * (Every column named in this file is 32 larger than it was recorded as. The
 * measurements were taken against maps exported a word out of phase, so each
 * site was written down 32 px left of the geometry it names; the maps have since
 * been re-exported and these are the same sites on the corrected frame. The rows
 * are untouched, which is what makes it a translation rather than a fresh
 * measurement — a horizontal reframe cannot move a row.)
 *
 * Ten seconds is long enough that nothing in normal play comes close: a ball is
 * motionless only when it is wedged, since `stepBalls` zeroes the velocity of a
 * ball that could not move rather than letting it grind on. Deliberately NOT
 * applied to the ball sitting on the plunger rod, which is motionless on
 * purpose and for as long as the player likes.
 */
export const BALL_SEARCH_TICKS = 500;

/**
 * How far a ball has to get from where the search's clock started before the
 * machine counts it as something happening. One ball radius.
 *
 * The clock used to be reset by ANY change to the whole-pixel position of any
 * live ball, and that made the search defeatable by a disturbance shorter than
 * its own window. Measured on the real map: a ball wedged in the spiral at
 * (86, 155) with the player nudging every 700 ticks is shoved a maximum of SEVEN
 * pixels and comes back to the same pixel about 200 ticks later, so `stillTicks`
 * climbed to exactly 493 and was reset — seven ticks short of the threshold —
 * every 700 ticks for eighteen thousand consecutive ticks. The ball was never
 * written off, `ballsServed` stalled on ball one and the game could not end.
 * Nudging every 400 ticks held it under 70.
 *
 * A radius is the right size because it is the smallest displacement that could
 * plausibly close a switch: a ball that has not moved by its own radius has not
 * left the target, lane or hole it is sitting in, and the real mechanism watches
 * switches, not micrometres. It also has honest margin at both ends, measured
 * over thirty scripted games on Law 'n Justice:
 *
 *   - Wedged balls never leave the box at all (max excursion 7 px under repeated
 *     nudging), so the clock runs uninterrupted to 500.
 *   - The slowest legitimate motion on the table is a ball creeping round the top
 *     arch at about a pixel every twenty ticks. Its longest stay inside a box
 *     this size is 208 ticks, and the longest for any non-wedged ball anywhere on
 *     the table is 205. Both are under half the threshold.
 *
 * Exact pixel equality had no margin at either end: 1 px of jitter reset it, and
 * the arch crawl needed a position test rather than a velocity test to survive at
 * all.
 */
export const BALL_SEARCH_BOX_PIXELS = BALL_RADIUS_PIXELS;

/**
 * Ticks a ball the MACHINE served sits in the lane before the auto-launcher
 * fires it — half a second at 50 Hz.
 *
 * Long enough to see a ball appear in the lane and understand where the extra
 * balls are coming from; short enough that a three-ball multiball is fully on
 * the playfield inside two seconds. It is not a physical constant and nothing
 * derives from it. Only balls the player never asked for are auto-launched; see
 * `autoLaunchOutcome`.
 */
export const AUTO_LAUNCH_DELAY_TICKS = 25;

export interface GameOptions {
  readonly ballsPerGame: number;
  /**
   * Downward acceleration in Q10 per tick.
   *
   * `PLUNGER_REFERENCE_GRAVITY`, because the plunger's launch ceiling is only
   * meaningful relative to it: change one and the other has to move with it or
   * a full plunge stops clearing the lane.
   */
  readonly gravityY: Q10;
  readonly serveDelayTicks: number;
  readonly firstServeDelayTicks: number;
  /** Motionless ticks before a ball is written off. See BALL_SEARCH_TICKS. */
  readonly ballSearchTicks: number;
  readonly simulation: Partial<SimulationOptions>;
  readonly camera: CameraOptions;
}

export const DEFAULT_GAME_OPTIONS: GameOptions = Object.freeze({
  ballsPerGame: DEFAULT_BALLS_PER_GAME,
  gravityY: PLUNGER_REFERENCE_GRAVITY,
  serveDelayTicks: SERVE_DELAY_TICKS,
  firstServeDelayTicks: FIRST_SERVE_DELAY_TICKS,
  ballSearchTicks: BALL_SEARCH_TICKS,
  simulation: Object.freeze({}),
  camera: DEFAULT_CAMERA_OPTIONS,
});

/**
 * Resolved with `??` per field rather than by spreading a partial: under
 * `exactOptionalPropertyTypes` a caller may pass an explicit `undefined`, and a
 * spread would overwrite the default with it.
 */
function resolveGameOptions(options?: Partial<GameOptions>): GameOptions {
  const ballsPerGame = options?.ballsPerGame ?? DEFAULT_GAME_OPTIONS.ballsPerGame;
  if (!Number.isInteger(ballsPerGame) || ballsPerGame < 1) {
    throw new RangeError(`ballsPerGame must be a positive whole number: ${ballsPerGame}`);
  }
  return {
    ballsPerGame,
    gravityY: options?.gravityY ?? DEFAULT_GAME_OPTIONS.gravityY,
    serveDelayTicks: options?.serveDelayTicks ?? DEFAULT_GAME_OPTIONS.serveDelayTicks,
    firstServeDelayTicks: options?.firstServeDelayTicks ?? DEFAULT_GAME_OPTIONS.firstServeDelayTicks,
    ballSearchTicks: options?.ballSearchTicks ?? DEFAULT_GAME_OPTIONS.ballSearchTicks,
    simulation: options?.simulation ?? DEFAULT_GAME_OPTIONS.simulation,
    camera: options?.camera ?? DEFAULT_GAME_OPTIONS.camera,
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * `attract` before the first game and `game-over` after the last ball; both
 * wait for start. They are distinct so the presentation can tell "never played"
 * from "just lost" without a second flag.
 */
export type GamePhase = "attract" | "in-play" | "game-over";

export interface Game {
  readonly map: TableMap;
  readonly materials: MaterialTable;
  /**
   * The table's ramp drive. Not optional and not nullable: see `table-accel.ts`
   * for why a game without it is a different machine.
   */
  readonly rampDrive: TableAcceleration;
  readonly options: GameOptions;
  readonly plungerConfig: PlungerConfig;
  readonly nudgeConfig: NudgeConfig;

  phase: GamePhase;
  /** Ticks the loop has run, including paused ones. Never resets. */
  tick: number;
  balls: BallSet;
  /** Balls served so far this game; `ballsPerGame` of them ends it. */
  ballsServed: number;
  /** Which saucer is holding which ball. See `ball-locks.ts`. */
  locks: LockBank;
  /**
   * Balls the machine owes the lane that do NOT cost the player one: the
   * replacement for a ball a lock swallowed, and the balls a multiball starts.
   * The original's `$D86(a5)`.
   */
  pendingServes: number;
  /** True from the moment a multiball starts until it is back down to one ball. */
  multiball: boolean;
  /**
   * Ticks until the auto-launcher fires the ball in the lane, or 0 when it is
   * not armed. Armed only for balls the machine owes itself.
   */
  autoLaunchCountdown: number;
  /** Locks captured so far this ball, for the presentation. */
  ballsLocked: number;
  /** The ball sitting on the plunger rod, or null once it has been launched. */
  laneBallId: number | null;
  serveCountdown: number;
  /** Consecutive ticks with every live ball inside its box and none on the rod. */
  stillTicks: number;
  /** Where each live ball was when that run of ticks began. See `runBallSearch`. */
  stillAnchors: readonly BallAnchor[];
  plunger: PlungerState;
  tilt: TiltState;
  flippers: FlipperBank;
  camera: CameraState;
  paused: boolean;
  /** Player's whole-table override, on top of the automatic multiball reframe. */
  forceFullTable: boolean;
}

/** What one tick did, for the presentation and for tests. */
export interface GameTickReport {
  readonly tick: number;
  /** True on ticks the physics actually ran — false while paused or idle. */
  readonly stepped: boolean;
  readonly served: boolean;
  readonly launched: boolean;
  readonly drained: readonly number[];
  /** Ids a lock swallowed this tick, in device order. */
  readonly locked: readonly number[];
  /** True on the tick a multiball was lit and the saucers gave their balls back. */
  readonly multiballStarted: boolean;
  readonly justTilted: boolean;
  readonly gameOver: boolean;
}

/** One control per nudge direction, in a fixed order so ticks are reproducible. */
const NUDGE_CONTROLS: readonly (readonly [Control, NudgeDirection])[] = Object.freeze([
  Object.freeze(["nudgeLeft", "left"] as const),
  Object.freeze(["nudgeRight", "right"] as const),
  Object.freeze(["nudgeForward", "forward"] as const),
]);

/**
 * Assembles a game on one table's geometry.
 *
 * `tableAccelerationFor` THROWS when the table's ramp drive has not been
 * registered, and that is on purpose: the drive is what carries a ball along a
 * ramp face too shallow for gravity to move it against friction, so a game
 * missing it looks entirely normal until a ball reaches an arch and stops
 * forever. Better a boot failure that names the file to load. See
 * `table-accel.ts`.
 */
export function createGame(map: TableMap, options?: Partial<GameOptions>): Game {
  return {
    map,
    materials: materialTableFor(map.tableId),
    rampDrive: tableAccelerationFor(map.tableId),
    options: resolveGameOptions(options),
    plungerConfig: plungerConfigFor(map.tableId),
    nudgeConfig: nudgeConfigFor(map.tableId),
    phase: "attract",
    tick: 0,
    balls: createBallSet(),
    ballsServed: 0,
    locks: createLockBank(map.tableId),
    pendingServes: 0,
    multiball: false,
    autoLaunchCountdown: 0,
    ballsLocked: 0,
    laneBallId: null,
    serveCountdown: 0,
    stillTicks: 0,
    stillAnchors: [],
    plunger: INITIAL_PLUNGER,
    tilt: INITIAL_TILT,
    flippers: createFlipperBank(map.tableId),
    camera: INITIAL_CAMERA,
    paused: false,
    forceFullTable: false,
  };
}

/**
 * Starts a fresh game.
 *
 * The ball set is replaced rather than emptied so ids restart at 0, which makes
 * a debug dump of two games comparable. Nothing is served here: the serve goes
 * through the same countdown the rest of the game uses, so there is exactly one
 * code path that puts a ball in the lane.
 */
export function startGame(game: Game): void {
  game.phase = "in-play";
  game.balls = createBallSet();
  game.ballsServed = 0;
  // A fresh bank rather than a cleared one: the ball set is new, so any id the
  // old bank still held would name a ball that no longer exists.
  game.locks = createLockBank(game.map.tableId);
  game.pendingServes = 0;
  game.multiball = false;
  game.autoLaunchCountdown = 0;
  game.ballsLocked = 0;
  game.laneBallId = null;
  game.serveCountdown = game.options.firstServeDelayTicks;
  game.stillTicks = 0;
  game.stillAnchors = [];
  game.plunger = resetPlunger();
  game.tilt = resetTiltForNewBall();
  game.flippers = createFlipperBank(game.map.tableId);
  game.camera = INITIAL_CAMERA;
  game.paused = false;
}

/** Balls left after the one in play, for the presentation. */
export function ballsRemaining(game: Game): number {
  return Math.max(0, game.options.ballsPerGame - game.ballsServed);
}

/** 1-based number of the ball in play; 0 before the first serve. */
export function ballNumber(game: Game): number {
  return game.ballsServed;
}

function ballRadiusOf(game: Game): Q10 {
  return game.options.simulation.radius ?? DEFAULT_PROBE_RADIUS;
}

function restThresholdOf(game: Game): number {
  return game.options.simulation.restThreshold ?? DEFAULT_SIMULATION_OPTIONS.restThreshold;
}

function cameraOptionsFor(game: Game): CameraOptions {
  const base = game.options.camera;
  return {
    forceFullTable: base.forceFullTable || game.forceFullTable,
    deadZoneHeight: base.deadZoneHeight,
    maxScrollStep: base.maxScrollStep,
  };
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/**
 * Advances the whole game by one simulation tick.
 *
 * Pure in the sense that matters: it reads a snapshot and the state, and writes
 * only the state. No clock, no random source, no iteration over a map's
 * insertion order. Two runs from the same start with the same snapshots produce
 * the same bytes, which is what `game-loop.test.ts` asserts and what makes a
 * recorded input log a replay.
 *
 * The order below is the behaviour. Serve before input so a ball that arrives
 * this tick can still be plunged; nudge before the step so the impulse joins
 * gravity in the same integration; flippers after the step because the bats
 * guard the drain and must meet the ball where it actually got to; LOCKS after
 * the rod is pinned, so the ball waiting on the plunger can never be swallowed
 * by a saucer and so a capture is judged on where the ball finished the tick;
 * drain last, so a ball saved by a bat on the tick it crossed the line is still
 * in play.
 */
export function tickGame(game: Game, snapshot: ControlSnapshot): GameTickReport {
  game.tick += 1;

  if (wasPressed(snapshot, "toggleWholeTableView")) {
    game.forceFullTable = !game.forceFullTable;
  }
  if (wasPressed(snapshot, "pause") && game.phase === "in-play") {
    game.paused = !game.paused;
  }
  if (wasPressed(snapshot, "start") && game.phase !== "in-play") {
    startGame(game);
  }

  const idle: GameTickReport = {
    tick: game.tick,
    stepped: false,
    served: false,
    launched: false,
    drained: [],
    locked: [],
    multiballStarted: false,
    justTilted: false,
    gameOver: false,
  };

  if (game.phase !== "in-play" || game.paused) return idle;

  // ---- serve -------------------------------------------------------------
  //
  // One lane, one countdown, and never two balls on the rod: the machine's own
  // debt (`pendingServes`) is paid first, and only when nothing is in play and
  // nothing is owed does the player get charged a ball. Without locks the two
  // conditions collapse into the old `activeBallCount === 0` exactly, because
  // then every active ball is in play and the lane ball is one of them.
  let served = false;
  if (game.laneBallId === null) {
    const owed = game.pendingServes > 0;
    if (owed || freeBallCount(game.balls) === 0) {
      if (game.serveCountdown > 0) {
        game.serveCountdown -= 1;
        // Still run the rest of the tick: the camera has to keep easing and the
        // flippers have to keep falling back to rest while the lane is empty.
      } else {
        const ball = serveBall(game.balls, game.plungerConfig);
        game.laneBallId = ball.id;
        game.plunger = resetPlunger();
        if (owed) {
          // A ball the machine owes: a lock's replacement or a multiball ball.
          // It costs the player nothing and it does NOT reset the tilt, because
          // the same ball is still in play and a tilt earned on it still stands.
          game.pendingServes -= 1;
          game.autoLaunchCountdown = AUTO_LAUNCH_DELAY_TICKS;
          if (game.pendingServes > 0) game.serveCountdown = game.options.serveDelayTicks;
        } else {
          game.ballsServed += 1;
          game.tilt = resetTiltForNewBall();
          game.ballsLocked = 0;
        }
        served = true;
      }
    }
  }

  // ---- nudge and tilt ----------------------------------------------------
  let nudgeX = 0;
  let nudgeY = 0;
  let justTilted = false;
  for (const [control, direction] of NUDGE_CONTROLS) {
    if (!wasPressed(snapshot, control)) continue;
    // Sequential rather than "first one wins": `nudge` refuses during its own
    // cooldown, so two directions in one tick correctly yield one shove.
    const outcome = nudge(game.tilt, direction, game.nudgeConfig);
    game.tilt = outcome.state;
    nudgeX += outcome.impulseX;
    nudgeY += outcome.impulseY;
    if (outcome.justTilted) justTilted = true;
  }
  game.tilt = tickTilt(game.tilt, game.nudgeConfig);

  // ---- plunger -----------------------------------------------------------
  const plunge = tickPlunger(game.plunger, plungerInputFrom(snapshot), game.plungerConfig);
  game.plunger = plunge.state;
  let launched = false;
  if (plunge.fired && game.laneBallId !== null) {
    const ball = ballById(game.balls, game.laneBallId);
    if (ball !== undefined && launchBall(ball, plunge)) {
      // Cleared BEFORE the step, so the pin below does not immediately drag the
      // ball it just fired back down onto the rod.
      game.laneBallId = null;
      game.autoLaunchCountdown = 0;
      launched = true;
    }
  }

  // The auto-launcher, for balls the machine served itself. It is disarmed the
  // moment the lane empties, so a player who shoots first keeps the shot.
  if (game.autoLaunchCountdown > 0) {
    if (game.laneBallId === null) {
      game.autoLaunchCountdown = 0;
    } else {
      game.autoLaunchCountdown -= 1;
      if (game.autoLaunchCountdown === 0) {
        const ball = ballById(game.balls, game.laneBallId);
        if (ball !== undefined && launchBall(ball, autoLaunchOutcome(game.plungerConfig))) {
          game.laneBallId = null;
          game.plunger = resetPlunger();
          launched = true;
        }
      }
    }
  }

  // ---- flippers ----------------------------------------------------------
  const live = flippersLive(game.tilt);
  const bankTick = tickFlipperBank(
    game.flippers,
    flipperInputFrom(
      live && isDown(snapshot, "leftFlipper"),
      live && isDown(snapshot, "rightFlipper"),
    ),
  );
  game.flippers = bankTick.bank;

  // ---- physics -----------------------------------------------------------
  const forces: SimulationForces = { gravityY: game.options.gravityY, nudgeX, nudgeY };
  // The drive is spread in LAST so a caller cannot switch it off through
  // `options.simulation` without noticing they have done it — and it is the
  // game's own, from the registry, not something the options carry.
  const step = stepBalls(game.balls, game.map, game.materials, forces, {
    ...game.options.simulation,
    rampDrive: game.rampDrive,
  });
  resolveFlipperContacts(
    game.balls.balls,
    bankTick.sweeps,
    ballRadiusOf(game),
    null,
    restThresholdOf(game),
  );

  // A plunge too weak to clear the arch drops back down the lane, and the lane
  // floor IS the plunger rod, so the ball ends up back on it and may be shot
  // again. That is how the real machine behaves and it is why the shipped
  // collision layer has no floor under the lane to begin with; without it, an
  // under-plunge would strand the ball and end the game.
  if (game.laneBallId === null) {
    const returned = ballBackOnTheRod(game);
    if (returned !== null) {
      game.laneBallId = returned.id;
      game.plunger = resetPlunger();
      // During multiball the player's hands are on the bats, so a ball that came
      // back down the lane goes out again on the auto-launcher rather than
      // waiting for a plunge that is not coming. With one ball in play it is the
      // player's shot, exactly as before.
      if (freeBallCount(game.balls) > 1) game.autoLaunchCountdown = AUTO_LAUNCH_DELAY_TICKS;
    }
  }

  // The plunger rod, which the collision layer does not contain. See the header.
  if (game.laneBallId !== null) {
    const ball = ballById(game.balls, game.laneBallId);
    if (ball !== undefined && ball.active) {
      const home = servePosition(game.plungerConfig);
      ball.x = home.x;
      ball.y = home.y;
      ball.velocityX = 0;
      ball.velocityY = 0;
      ball.level = 0;
    }
  }

  // ---- ball locks and multiball ------------------------------------------
  const lockTick = runLocks(game);

  // ---- ball search -------------------------------------------------------
  const lost = runBallSearch(game);

  // ---- drain -------------------------------------------------------------
  let gameOver = false;
  const drained = lost.length === 0 ? step.drained : [...step.drained, ...lost];
  if (drained.length > 0) {
    if (game.laneBallId !== null && drained.includes(game.laneBallId)) {
      game.laneBallId = null;
    }
    pruneInactiveBalls(game.balls);
    // "Nothing in play and nothing owed", not "no active balls": a held ball is
    // active. See the header — testing the active count here is a silent hang.
    if (freeBallCount(game.balls) === 0 && game.pendingServes === 0) {
      // The ball in play is over, so a ball a saucer is still holding is not in
      // play either: it goes back to the trough. A physical lock that held its
      // ball across the end of a ball would leave the machine one short on the
      // next one, and this reconstruction has no rule saying which tables do that.
      releaseHeldBalls(game.locks, game.balls.balls);
      pruneInactiveBalls(game.balls);
      game.multiball = false;
      game.plunger = resetPlunger();
      game.tilt = resetTiltForNewBall();
      game.serveCountdown = game.options.serveDelayTicks;
      if (game.ballsServed >= game.options.ballsPerGame) {
        game.phase = "game-over";
        gameOver = true;
      }
    }
  }

  // Multiball is over when it is back down to one ball, counting the ones still
  // queued for the lane. The original checks exactly this every frame at data
  // 0x5794: `move.w $d86(a5),d0 / add.w $d7e(a5),d0 / cmpi.w #$1,d0 / bhi`.
  if (game.multiball && freeBallCount(game.balls) + game.pendingServes <= 1) {
    game.multiball = false;
  }

  // ---- camera ------------------------------------------------------------
  game.camera = updateCamera(game.camera, game.balls.balls, cameraOptionsFor(game));

  return {
    tick: game.tick,
    stepped: true,
    served,
    launched,
    drained,
    locked: lockTick.locked,
    multiballStarted: lockTick.multiballStarted,
    justTilted,
    gameOver,
  };
}

/**
 * Owes the lane `count` more balls, and starts the clock if it is not running.
 *
 * The countdown is only armed when the lane is free and nothing is already
 * counting: a serve in progress must not be restarted, and a ball on the rod
 * blocks the queue until the player shoots it, which is the original's rule
 * (`$D88/$D89(a5)`, set by the server at data 0x65EE and cleared only by the
 * shooter-lane zone at data 0x54C2).
 */
function oweServes(game: Game, count: number): void {
  if (count <= 0) return;
  game.pendingServes += count;
  if (game.laneBallId === null && game.serveCountdown === 0) {
    game.serveCountdown = game.options.serveDelayTicks;
  }
}

/**
 * Captures balls into saucers, and lights multiball when enough are locked.
 *
 * Two decisions live here and only one of them is decoded.
 *
 * DECODED: capture freezes the ball where it is and takes it out of the
 * simulation; release does not kick it out of the saucer but puts it back in the
 * serve queue; multiball is a top-up to a requested count with a hard ceiling of
 * three. See `ball-locks.ts` for the instructions.
 *
 * RECONSTRUCTION: `LOCKS_TO_LIGHT_MULTIBALL` balls held lights it, and a capture
 * that leaves nothing rolling buys the player a replacement ball. The engine has
 * no rule for either — it keeps two lock counters and reads neither — so both are
 * this reconstruction's, and the replacement is the one that keeps the promise
 * that a game always ends: without it, locking the last ball in play would leave
 * the table empty with a non-zero active count and no way forward.
 */
function runLocks(game: Game): {
  readonly locked: readonly number[];
  readonly multiballStarted: boolean;
} {
  const captured = captureBalls(game.locks, game.balls.balls);
  if (captured.length === 0) return { locked: [], multiballStarted: false };

  game.ballsLocked += captured.length;
  const locked = captured.map((capture) => capture.ballId);

  if (heldBallCount(game.locks) >= LOCKS_TO_LIGHT_MULTIBALL) {
    startMultiball(game);
    return { locked, multiballStarted: true };
  }
  if (freeBallCount(game.balls) === 0) oweServes(game, 1);
  return { locked, multiballStarted: false };
}

/**
 * Gives every saucer's ball back and fills the table to `MULTIBALL_BALL_COUNT`.
 *
 * This is opcode `$68` (release, data 0x5B4E) run over the whole bank followed by
 * opcode `$6C` (top-up, data 0x5BCC). The released balls go into the queue rather
 * than back onto the playfield, so the balls come out of the plunger lane one
 * after another exactly as they do in the original; `ballsToTopUp` then adds
 * however many more the target needs, and refuses to exceed the engine's ceiling
 * of three.
 */
function startMultiball(game: Game): void {
  const freed = releaseHeldBalls(game.locks, game.balls.balls);
  pruneInactiveBalls(game.balls);
  oweServes(game, freed.length);
  oweServes(
    game,
    ballsToTopUp(MULTIBALL_BALL_COUNT, freeBallCount(game.balls), game.pendingServes),
  );
  game.multiball = true;
}

/**
 * True when a ball is going nowhere.
 *
 * The test is the simulation's own rest threshold rather than exactly zero,
 * because a wedged ball rarely comes to a dead stop: it keeps a unit or two of
 * velocity that the contact resolution hands straight back every tick. Measured
 * on the real map, a ball jammed in the spiral at (86, 155) sits there forever
 * with velocity (-1, 1), and one settling at the foot of the shooter lane
 * oscillates for hundreds of ticks at under a tenth of a pixel. Both are at
 * rest by any standard a player would use; neither is at zero.
 */
function isAtRest(ball: BallState, threshold: number): boolean {
  return Math.abs(ball.velocityX) <= threshold && Math.abs(ball.velocityY) <= threshold;
}

/**
 * The ball that has rolled back onto the plunger rod, if there is one.
 *
 * "On the rod" is: motionless, on the playfield level, inside the shooter lane
 * and below the point where the lane hands over to the arch.
 *
 * The condition used to be "and it is the only live ball on the table", which
 * was right when there was no way to have two. It is wrong now, and it was the
 * first thing multiball broke: an under-plunged multiball ball fell back down
 * the lane, failed this test because two other balls were rolling, was never
 * re-pinned, never re-armed the plunger and never auto-launched, and simply sat
 * in the lane until the ball search wrote it off. The census showed it at once —
 * write-offs appeared in a cluster at x 320..325, y 490..560, which is the lane
 * itself, on a table that had never lost a ball there.
 *
 * What the old condition was really protecting against is still guarded, and
 * more precisely: the test is now scoped to the LANE, and the ball taken is the
 * LOWEST at-rest ball in it. Two balls stacked in the lane resolve one at a
 * time, lowest first, which is the order the rod would hand them over in
 * anyway; and a ball anywhere else on the table is simply irrelevant to whether
 * the rod has one on it.
 */
function ballBackOnTheRod(game: Game): BallState | null {
  const lane = shooterLaneFor(game.map.tableId);
  const footY = q10ToPixel(game.plungerConfig.serveY) - BALL_RADIUS_PIXELS;
  const threshold = restThresholdOf(game);

  let lowest: BallState | null = null;
  for (const ball of freeBalls(game.balls)) {
    if (ball.level !== 0) continue;
    if (!isAtRest(ball, threshold)) continue;
    const x = q10ToPixel(ball.x);
    const y = q10ToPixel(ball.y);
    if (x < lane.minCentreX || x > lane.maxCentreX) continue;
    // Below the serve point, i.e. settled at the foot of the lane rather than
    // hung up somewhere in the middle of it.
    if (y < footY) continue;
    if (lowest === null || y > q10ToPixel(lowest.y)) lowest = ball;
  }
  return lowest;
}

/** Where one ball was when the ball search's clock last started. */
interface BallAnchor {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

function anchorsFor(balls: readonly BallState[]): BallAnchor[] {
  return balls.map((ball) => ({ id: ball.id, x: q10ToPixel(ball.x), y: q10ToPixel(ball.y) }));
}

/**
 * True when something has happened: the population changed, or some ball has
 * left the box it was in when the clock started.
 *
 * The ball search's "has anything happened" test, and the reason it is POSITION
 * rather than velocity, and a BOX rather than a pixel.
 *
 * A velocity test looked right and was wrong. A ball creeping along the top arch
 * under gravity carries 14 to 70 Q10 per tick — well under the simulation's rest
 * threshold of 160, and therefore "motionless" by that measure — but it is
 * crossing the table at about a pixel every twenty ticks and takes several
 * hundred to finish the shot. Judging by velocity wrote that ball off in the
 * middle of a legitimate, if unhurried, orbit.
 *
 * Exact pixel equality against the PREVIOUS tick was the second wrong answer, and
 * a worse one, because it made the search defeatable: any disturbance that moved
 * a wedged ball by one pixel more often than every `ballSearchTicks` reset the
 * clock forever, and a player nudging is exactly such a disturbance. See
 * BALL_SEARCH_BOX_PIXELS for the measurements. The anchor is therefore held for
 * the whole window rather than replaced every tick, and the comparison is against
 * a box the size of the ball.
 */
function ballsLeftTheBox(
  balls: readonly BallState[],
  anchors: readonly BallAnchor[],
  box: number,
): boolean {
  if (balls.length !== anchors.length) return true;
  for (let i = 0; i < balls.length; i += 1) {
    const ball = balls[i];
    const anchor = anchors[i];
    if (ball === undefined || anchor === undefined) return true;
    if (ball.id !== anchor.id) return true;
    if (Math.abs(q10ToPixel(ball.x) - anchor.x) > box) return true;
    if (Math.abs(q10ToPixel(ball.y) - anchor.y) > box) return true;
  }
  return false;
}

/**
 * Writes off balls the playfield has stopped returning. See BALL_SEARCH_TICKS.
 *
 * The clock only runs while every live ball has stayed inside a box one ball
 * radius across and none is on the rod; real movement resets it, so a ball
 * rattling in a lane or inching round a ramp is never written off. Returns the
 * ids given up on, which the caller merges into the tick's drains so a lost ball
 * goes through exactly the same lifecycle as one that went down the middle.
 *
 * It watches only balls IN PLAY. A ball in a saucer is motionless on purpose and
 * for as long as the rules like — writing it off after ten seconds would make
 * every lock a slow drain — and it is exempt for the same reason the ball on the
 * plunger rod is.
 */
function runBallSearch(game: Game): number[] {
  const live = freeBalls(game.balls);
  if (
    live.length === 0 ||
    game.laneBallId !== null ||
    ballsLeftTheBox(live, game.stillAnchors, BALL_SEARCH_BOX_PIXELS)
  ) {
    game.stillTicks = 0;
    game.stillAnchors = anchorsFor(live);
    return [];
  }

  game.stillTicks += 1;
  if (game.stillTicks < game.options.ballSearchTicks) return [];

  game.stillTicks = 0;
  game.stillAnchors = [];
  const lost: number[] = [];
  for (const ball of live) {
    ball.active = false;
    lost.push(ball.id);
  }
  return lost;
}

// ---------------------------------------------------------------------------
// Driving it
// ---------------------------------------------------------------------------

/**
 * Anything that can produce one tick's input.
 *
 * `InputRouter` satisfies it structurally, and so does a scripted stand-in, so
 * the loop below never learns what a keyboard is.
 */
export interface InputSource {
  sample(): ControlSnapshot;
}

/** Runs `ticks` ticks with no clock at all. The headless entry point. */
export function runTicks(game: Game, input: InputSource, ticks: number): GameTickReport[] {
  if (!Number.isInteger(ticks) || ticks < 0) {
    throw new RangeError(`ticks must be a non-negative whole number: ${ticks}`);
  }
  const reports: GameTickReport[] = [];
  for (let i = 0; i < ticks; i += 1) {
    reports.push(tickGame(game, input.sample()));
  }
  return reports;
}

/** The two `requestAnimationFrame` functions, injectable so tests can fake time. */
export interface FrameScheduler {
  request(callback: (timeMs: number) => void): number;
  cancel(handle: number): void;
}

export interface GameLoopOptions {
  readonly game: Game;
  readonly input: InputSource;
  readonly frames: FrameScheduler;
  /** Called once per animation frame, after that frame's ticks have run. */
  readonly render: (game: Game) => void;
  /** Called before each frame's ticks, for pull-based devices such as gamepads. */
  readonly poll?: () => void;
  readonly scheduler?: FixedStepScheduler;
}

/**
 * Ties the fixed-step scheduler to the simulation and the renderer.
 *
 * The class owns no timing policy of its own: everything about how much
 * simulation a frame is worth lives in `FixedStepScheduler`, including the
 * catch-up clamp that stops a long stall from being paid off in one enormous
 * burst of ticks.
 */
export class GameLoop {
  readonly game: Game;
  readonly scheduler: FixedStepScheduler;
  readonly #input: InputSource;
  readonly #frames: FrameScheduler;
  readonly #render: (game: Game) => void;
  readonly #poll: (() => void) | null;
  #handle: number | null = null;
  #frameCount = 0;

  constructor(options: GameLoopOptions) {
    this.game = options.game;
    this.#input = options.input;
    this.#frames = options.frames;
    this.#render = options.render;
    this.#poll = options.poll ?? null;
    this.scheduler = options.scheduler ?? new FixedStepScheduler();
  }

  get running(): boolean {
    return this.#handle !== null;
  }

  /** Animation frames served since construction; render calls, not ticks. */
  get frameCount(): number {
    return this.#frameCount;
  }

  start(): void {
    if (this.#handle !== null) return;
    this.#schedule();
  }

  /**
   * Stops requesting frames and re-seeds the scheduler, so the wall time spent
   * stopped never becomes a burst of catch-up ticks on restart.
   */
  stop(): void {
    if (this.#handle === null) return;
    this.#frames.cancel(this.#handle);
    this.#handle = null;
    this.scheduler.resume();
  }

  #schedule(): void {
    this.#handle = this.#frames.request((timeMs) => {
      this.#handle = null;
      this.frame(timeMs);
      this.#schedule();
    });
  }

  /**
   * One animation frame: catch the simulation up, then draw once.
   *
   * Public so a test — or the debug handle — can drive frames by hand without
   * an event loop.
   */
  frame(timeMs: number): number {
    this.#poll?.();
    const batch = this.scheduler.advance(millisecondsToNanos(timeMs));
    for (let i = 0; i < batch.ticks; i += 1) {
      tickGame(this.game, this.#input.sample());
    }
    this.#frameCount += 1;
    this.#render(this.game);
    return batch.ticks;
  }
}

// ---------------------------------------------------------------------------
// Debug view
// ---------------------------------------------------------------------------

/** A ball flattened for inspection. Pixels as well as Q10, so it reads. */
export interface BallDebugState {
  readonly id: number;
  readonly x: Q10;
  readonly y: Q10;
  readonly pixelX: number;
  readonly pixelY: number;
  readonly velocityX: number;
  readonly velocityY: number;
  readonly active: boolean;
  /** The lock holding this ball, or null when it is in play. */
  readonly heldBy: string | null;
  /** Which collision line the ball is riding: 0 the playfield, 1 the ramps. */
  readonly level: PlayfieldLevel;
}

export interface GameDebugState {
  readonly tableId: string;
  readonly displayName: string;
  readonly tick: number;
  readonly phase: GamePhase;
  readonly paused: boolean;
  readonly ballNumber: number;
  readonly ballsServed: number;
  readonly ballsRemaining: number;
  readonly ballsPerGame: number;
  readonly laneBallId: number | null;
  readonly serveCountdown: number;
  /** Balls the machine owes the lane that cost the player nothing. */
  readonly pendingServes: number;
  readonly multiball: boolean;
  readonly ballsLocked: number;
  /** Device id to ball id for every occupied saucer, in table order. */
  readonly locks: readonly { readonly deviceId: string; readonly ballId: number }[];
  readonly plungerCharge: number;
  /** Consecutive motionless ticks counted toward the ball search. */
  readonly stillTicks: number;
  readonly tilt: TiltState;
  readonly flippersLive: boolean;
  readonly camera: CameraState;
  readonly forceFullTable: boolean;
  readonly balls: readonly BallDebugState[];
  readonly flippers: readonly { readonly id: string; readonly stroke: number }[];
}

/**
 * A structurally-cloned, JSON-safe view of everything an automated check needs.
 *
 * Deliberately a snapshot rather than live references: an assertion that holds a
 * reference to the mutable ball objects is asserting whatever the loop did
 * after it looked, which is exactly the kind of test that passes for the wrong
 * reason. Ordering is the ball set's own order and the bank's declared config
 * order, both of which are stable, so this doubles as a determinism digest.
 */
export function debugSnapshot(game: Game): GameDebugState {
  return {
    tableId: game.map.tableId,
    displayName: game.map.displayName,
    tick: game.tick,
    phase: game.phase,
    paused: game.paused,
    ballNumber: ballNumber(game),
    ballsServed: game.ballsServed,
    ballsRemaining: ballsRemaining(game),
    ballsPerGame: game.options.ballsPerGame,
    laneBallId: game.laneBallId,
    serveCountdown: game.serveCountdown,
    pendingServes: game.pendingServes,
    multiball: game.multiball,
    ballsLocked: game.ballsLocked,
    // Built from the bank's declared device order, never from the map's
    // iteration order, so this stays a determinism digest.
    locks: game.locks.locks.flatMap((device) => {
      const ballId = game.locks.held.get(device.id);
      return ballId === undefined ? [] : [{ deviceId: device.id, ballId }];
    }),
    plungerCharge: chargeLevel(game.plunger),
    stillTicks: game.stillTicks,
    tilt: { ...game.tilt },
    flippersLive: flippersLive(game.tilt),
    camera: { ...game.camera },
    forceFullTable: game.forceFullTable,
    balls: game.balls.balls.map((ball) => ({
      id: ball.id,
      x: ball.x,
      y: ball.y,
      pixelX: q10ToPixel(ball.x),
      pixelY: q10ToPixel(ball.y),
      velocityX: ball.velocityX,
      velocityY: ball.velocityY,
      active: ball.active,
      heldBy: ball.heldBy,
      level: ball.level,
    })),
    flippers: game.flippers.configs.map((config) => ({
      id: config.id,
      stroke: (game.flippers.states.get(config.id) ?? { stroke: 0 }).stroke,
    })),
  };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Canvas size for an integer magnification. The window is 336 x 256. */
export function canvasSizeFor(scale: number): { readonly width: number; readonly height: number } {
  return { width: PLAYFIELD_WIDTH * scale, height: VIEWPORT_HEIGHT * scale };
}

function screenPoint(
  game: Game,
  scale: number,
  x: Q10,
  y: Q10,
): { readonly x: number; readonly y: number } {
  const view = toViewport(game.camera, q10ToPixel(x), q10ToPixel(y));
  return { x: view.x * scale, y: view.y * scale };
}

function drawBall(
  context: CanvasRenderingContext2D,
  game: Game,
  scale: number,
  ball: BallState,
): void {
  const centre = screenPoint(game, scale, ball.x, ball.y);
  const radius = BALL_RADIUS_PIXELS * viewScale(game.camera.mode) * scale;

  context.beginPath();
  context.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
  context.fillStyle = BALL_SHADE;
  context.fill();

  context.beginPath();
  context.arc(centre.x - radius * 0.15, centre.y - radius * 0.15, radius * 0.8, 0, Math.PI * 2);
  context.fillStyle = BALL_FILL;
  context.fill();

  context.beginPath();
  context.arc(centre.x - radius * 0.35, centre.y - radius * 0.4, radius * 0.28, 0, Math.PI * 2);
  context.fillStyle = BALL_HIGHLIGHT;
  context.fill();
}

/**
 * Draws the bats as tapered capsules.
 *
 * Two strokes rather than a polygon: the flipper silhouette measured off
 * `flipdat1.bin` is a rounded bar 10 px across at the boss narrowing toward the
 * tip, and a round-capped line of that width is the same shape to within the
 * pixel the silhouette was measured at.
 */
function drawFlippers(context: CanvasRenderingContext2D, game: Game, scale: number): void {
  const zoom = viewScale(game.camera.mode) * scale;
  for (const config of game.flippers.configs) {
    const state = game.flippers.states.get(config.id);
    if (state === undefined) continue;
    const ends = flipperEndpoints(config, state);
    const pivot = screenPoint(game, scale, ends.pivotX, ends.pivotY);
    const tip = screenPoint(game, scale, ends.tipX, ends.tipY);

    context.lineCap = "round";
    context.beginPath();
    context.moveTo(pivot.x, pivot.y);
    context.lineTo(tip.x, tip.y);
    context.lineWidth = 2 * FLIPPER_BOSS_RADIUS_PIXELS * zoom;
    context.strokeStyle = FLIPPER_EDGE;
    context.stroke();

    context.beginPath();
    context.moveTo(pivot.x, pivot.y);
    context.lineTo(tip.x, tip.y);
    context.lineWidth = Math.max(1, (2 * FLIPPER_BOSS_RADIUS_PIXELS - 2) * zoom);
    context.strokeStyle = FLIPPER_FILL;
    context.stroke();
  }
}

function statusLine(game: Game): string {
  if (game.phase === "attract") return "PRESS ENTER TO START";
  if (game.phase === "game-over") return "GAME OVER  -  ENTER FOR A NEW GAME";
  if (game.paused) return "PAUSED";
  if (game.tilt.tilted) return "TILT";
  const ball = Math.max(1, ballNumber(game));
  const charge = Math.round(chargeLevel(game.plunger) * 100);
  const plunger = game.laneBallId === null ? "" : `  PLUNGER ${charge}%`;
  return `BALL ${ball} OF ${game.options.ballsPerGame}${plunger}`;
}

/**
 * Draws one frame.
 *
 * Everything is redrawn every frame — there is no dirty-rectangle tracking —
 * because the whole window is 336 x 256 source pixels and a full blit of that
 * costs less than working out what changed.
 */
export function renderGame(context: CanvasRenderingContext2D, game: Game, scale: number): void {
  const size = canvasSizeFor(scale);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.imageSmoothingEnabled = false;
  context.fillStyle = SURROUND;
  context.fillRect(0, 0, size.width, size.height);

  drawPlayfield(context, game.map, game.camera, scale);
  drawFlippers(context, game, scale);
  // Every ball on the table, INCLUDING the ones sitting in saucers: a locked
  // ball is still a steel ball the player can see, and drawing only the ones in
  // play would make a lock look like a drain.
  for (const ball of activeBalls(game.balls)) {
    drawBall(context, game, scale, ball);
  }

  // The overlay is drawn at device resolution rather than magnified: scaled-up
  // text at 3x is unreadable mush, and this is instrumentation, not artwork.
  context.imageSmoothingEnabled = true;
  context.font = "12px ui-monospace, 'DejaVu Sans Mono', monospace";
  context.textBaseline = "top";
  context.fillStyle = game.tilt.tilted ? HUD_ALERT : HUD_TEXT;
  context.fillText(statusLine(game), 6, 6);
}
