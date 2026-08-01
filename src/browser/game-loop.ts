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
 * but it is also load-bearing here in a way it should not stay: the device layer
 * does not exist yet, so nothing empties the playfield's kicker holes, and a ball
 * that finds one would otherwise end the game silently. It is deliberately
 * position-based rather than velocity-based; see `ballsLeftTheBox` for the two
 * bugs that taught the current shape.
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
  activeBallCount,
  activeBalls,
  ballById,
  createBallSet,
  pruneInactiveBalls,
  stepBalls,
} from "../game/ball-physics.js";
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
import type { PlungerConfig, PlungerState } from "../game/plunger.js";
import {
  INITIAL_PLUNGER,
  PLUNGER_REFERENCE_GRAVITY,
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
  readonly options: GameOptions;
  readonly plungerConfig: PlungerConfig;
  readonly nudgeConfig: NudgeConfig;

  phase: GamePhase;
  /** Ticks the loop has run, including paused ones. Never resets. */
  tick: number;
  balls: BallSet;
  /** Balls served so far this game; `ballsPerGame` of them ends it. */
  ballsServed: number;
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
  readonly justTilted: boolean;
  readonly gameOver: boolean;
}

/** One control per nudge direction, in a fixed order so ticks are reproducible. */
const NUDGE_CONTROLS: readonly (readonly [Control, NudgeDirection])[] = Object.freeze([
  Object.freeze(["nudgeLeft", "left"] as const),
  Object.freeze(["nudgeRight", "right"] as const),
  Object.freeze(["nudgeForward", "forward"] as const),
]);

export function createGame(map: TableMap, options?: Partial<GameOptions>): Game {
  return {
    map,
    materials: materialTableFor(map.tableId),
    options: resolveGameOptions(options),
    plungerConfig: plungerConfigFor(map.tableId),
    nudgeConfig: nudgeConfigFor(map.tableId),
    phase: "attract",
    tick: 0,
    balls: createBallSet(),
    ballsServed: 0,
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
 * guard the drain and must meet the ball where it actually got to; drain last,
 * so a ball saved by a bat on the tick it crossed the line is still in play.
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
    justTilted: false,
    gameOver: false,
  };

  if (game.phase !== "in-play" || game.paused) return idle;

  // ---- serve -------------------------------------------------------------
  let served = false;
  if (activeBallCount(game.balls) === 0) {
    if (game.serveCountdown > 0) {
      game.serveCountdown -= 1;
      // Still run the rest of the tick: the camera has to keep easing and the
      // flippers have to keep falling back to rest while the lane is empty.
    } else {
      const ball = serveBall(game.balls, game.plungerConfig);
      game.laneBallId = ball.id;
      game.ballsServed += 1;
      game.plunger = resetPlunger();
      game.tilt = resetTiltForNewBall();
      served = true;
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
      launched = true;
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
  const step = stepBalls(game.balls, game.map, game.materials, forces, game.options.simulation);
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
    if (activeBallCount(game.balls) === 0) {
      game.plunger = resetPlunger();
      game.tilt = resetTiltForNewBall();
      game.serveCountdown = game.options.serveDelayTicks;
      if (game.ballsServed >= game.options.ballsPerGame) {
        game.phase = "game-over";
        gameOver = true;
      }
    }
  }

  // ---- camera ------------------------------------------------------------
  game.camera = updateCamera(game.camera, game.balls.balls, cameraOptionsFor(game));

  return {
    tick: game.tick,
    stepped: true,
    served,
    launched,
    drained,
    justTilted,
    gameOver,
  };
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
 * "On the rod" is: exactly one ball in play, motionless, on the playfield level,
 * and inside the shooter lane below the point where the lane hands over to the
 * arch. The single-ball condition matters — during multiball a ball parked in
 * the lane is a locked ball, not a served one, and re-arming the plunger for it
 * would fire a ball the player never asked to serve.
 */
function ballBackOnTheRod(game: Game): BallState | null {
  const live = activeBalls(game.balls);
  const ball = live.length === 1 ? live[0] : undefined;
  if (ball === undefined) return null;
  if (ball.level !== 0) return null;
  if (!isAtRest(ball, restThresholdOf(game))) return null;

  const lane = shooterLaneFor(game.map.tableId);
  const x = q10ToPixel(ball.x);
  const y = q10ToPixel(ball.y);
  if (x < lane.minCentreX || x > lane.maxCentreX) return null;
  // Below the serve point, i.e. settled at the foot of the lane rather than
  // hung up somewhere in the middle of it.
  if (y < q10ToPixel(game.plungerConfig.serveY) - BALL_RADIUS_PIXELS) return null;
  return ball;
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
 */
function runBallSearch(game: Game): number[] {
  const live = activeBalls(game.balls);
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
