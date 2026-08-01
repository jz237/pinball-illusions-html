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
 * radius for `ballSearchTicks` — but only after firing the machine's own coils
 * at them `BALL_SEARCH_PULSES` times, which is what a real search does and what
 * this one only ever described. It is deliberately position-based rather than
 * velocity-based; see `ballsLeftTheBox` for the two bugs that taught the current
 * shape. It watches only balls IN PLAY: a ball in a lock is motionless on
 * purpose and for as long as the rules like.
 *
 * IT IS NO LONGER LOAD-BEARING, and that is a measured claim. It used to be
 * carrying the absence of the device layer: nothing emptied the playfield's
 * holes, and Law 'n Justice lost 9.0% of its balls to it. With the surface-id
 * map wired into the physics — the habitrail deliveries, the engine's own
 * hand-off boxes, the pop bumpers — and with the coil pulse implemented, the
 * ninety-game aggressive census writes off ZERO balls on all three tables and
 * completes 90 of 90 games on each. The search is now what it is supposed to
 * be: a backstop nothing normally reaches.
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
  ballIsInPlay,
  createBallSet,
  freeBallCount,
  freeBalls,
  pruneInactiveBalls,
  stepBalls,
} from "../game/ball-physics.js";
import type { LockBank } from "../game/ball-locks.js";
import {
  MAX_SIMULTANEOUS_BALLS,
  ballsToTopUp,
  captureBalls,
  createLockBank,
  heldBallCount,
  lockCovers,
  lockForZone,
  releaseHeldBalls,
  releaseLock,
} from "../game/ball-locks.js";
import { BALL_RADIUS_PIXELS, DEFAULT_PROBE_RADIUS } from "../game/collision-probe.js";
import { SLINGSHOT_KICK } from "../game/surface-physics.js";
import type { FlipperBank } from "../game/flippers.js";
import {
  FLIPPER_BOSS_RADIUS_PIXELS,
  applyFlipperReactions,
  createFlipperBank,
  flipperEndpoints,
  flipperInputFrom,
  resolveFlipperContacts,
  tickFlipperBank,
} from "../game/flippers.js";
import { materialTableFor } from "../game/materials.js";
import type { TableDevices } from "../game/table-devices.js";
import { tableDevicesFor } from "../game/table-devices.js";
import type { Award, ScoringState } from "../game/scoring.js";
import {
  addToBcdField,
  applyAward,
  awardTrigger,
  createScoringState,
  formatBcdField,
  readBcdField,
  resetScoringForNewBall,
  scoreLock,
  scoreSurfaces,
  scoreZones,
  tickScoring,
} from "../game/scoring.js";
import type { TableModes } from "../game/table-modes.js";
import { tableModesFor } from "../game/table-modes.js";
import type { ModeState, ModeTickReport } from "../game/mode-vm.js";
import {
  EMPTY_MODE_TICK,
  createModeState,
  litElements,
  missionSecondsLeft,
  queueScript,
  resetModesForNewBall,
  tickModes,
} from "../game/mode-vm.js";
import type { TableAcceleration } from "../game/table-accel.js";
import { tableAccelerationFor } from "../game/table-accel.js";
import type { PlungerConfig, PlungerState } from "../game/plunger.js";
import { SIMULATION_GRAVITY, SIMULATION_X_TILT } from "../game/timebase.js";
import {
  INITIAL_PLUNGER,
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
 * THE SITE THAT USED TO BE LOAD-BEARING, AND WHAT ACTUALLY CLOSED IT
 * ---------------------------------------------------------------------------
 * Law 'n Justice, (8,388) and its neighbours (8,389), (9,387), (7,389),
 * (19,378). Every remaining write-off on that table used to be in that one
 * place, and this comment used to carry a long negative result about it: the
 * ball rests on the left shoulder of the wire-support post at (12,400) jammed
 * against the table's left edge, the far-left strip above it is a SEALED POCKET
 * on the lower collision line, the upper line's habitrail runs through the same
 * strip on different columns, and the original's acceleration map is (0,0)
 * everywhere in it. All of that was correct and none of it was the answer.
 *
 * THE BALL WAS NEVER SUPPOSED TO BE IN THE STRIP. It arrived there because this
 * project's reconstructed `left-apron` gate tipped it off the LEFT HABITRAIL,
 * which it was riding on the upper line, onto a lower line that has no way out.
 * It was riding the habitrail because it had missed the reconstructed `ramp-end`
 * gate — three columns wide, x 34..36 — by one pixel at x=37. The engine's own
 * hand-off is not three columns; it is a twenty-one pixel BOX at (25,180)-(45,200)
 * in the zone list, and it does not miss. See `applyLevelZones` in
 * ball-physics.ts, and `applyLevelSurfaces` beside it for the other half: the
 * flat bar of surface id 11 across the foot of the habitrail's channel at
 * x 23..47, y 465..467, whose handler stops the ball and hands it to the lower
 * line in the left inlane.
 *
 * With both wired, the aggressive census on Law 'n Justice goes from 26 write-offs
 * in 290 ball ends to ZERO in 349, with completions unchanged at 90 of 90. The
 * strip is still a sealed pocket and the post is still a trap; nothing rolls
 * into them any more.
 *
 * (Every column named above is 32 larger than it was first recorded as. The
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
 *
 * ---------------------------------------------------------------------------
 * THIS NUMBER DOES NOT MOVE WITH THE TIMEBASE, AND THAT IS THE POINT OF SAYING SO
 * ---------------------------------------------------------------------------
 * When gravity was re-measured every velocity and every acceleration in this
 * engine moved by 4x or 32x, so it is worth stating which constants did not.
 * This one is a TIME. Nothing in the original counts sub-steps: every duration
 * in the game is `seconds x $50(a5)` frames and `$50(a5)` is the OS's
 * `VBlankFrequency`, which is 50. Five hundred ticks is ten seconds before the
 * correction and ten seconds after it. See `timebase.ts`.
 *
 * What DID change is the margin around it, in the direction that helps. The
 * search asks for BALL_SEARCH_BOX_PIXELS of movement in a window, i.e. 16 Q10 a
 * tick; a ball on a shallow slope now carries 5.33x the speed it did, so the gap
 * between "still rolling" and "stopped" is five times wider than it was and the
 * test is five times less likely to retire a ball that is still going anywhere.
 *
 * AND THE COILS NOW ACTUALLY WORK, which is a behaviour change rather than an
 * arithmetic one: BALL_SEARCH_PULSE is the measured slingshot coil and it is
 * 14,000 Q10 a tick rather than 2,625, so a pulse throws a wedged ball clean out
 * of the pocket it is in instead of nudging it. A ball the playfield truly
 * cannot return therefore takes rather LONGER to be written off than it used to,
 * because every pulse buys it several hundred ticks of real travel and each of
 * those legitimately resets this clock. That is the mechanism working harder,
 * not the search failing; `tests/plays.test.ts` budgets for it explicitly.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE ORIGINAL'S OWN NUMBER IS — NOT ADOPTED, AND THE REASON IS RECORDED
 * ---------------------------------------------------------------------------
 * `tableNNN.opt` record 6 (`$E8E(a5)`, min 0, max 10, default 5 and TEN on
 * Extreme Sports) is consumed at +0x0049AE as `option x $50(a5)` — a per-table
 * countdown in frames, 250 / 250 / 500, and the only per-table duration on the
 * disk. It is tempting, and 500 is exactly Extreme Sports' value.
 *
 * It is not adopted because what that countdown IS is not settled:
 * `docs/RULES_SPEC.md` reads it as a timed BALL-SAVE grace and one of the two
 * timebase investigations read it as the ball-search window. Those are opposite
 * mechanisms — one gives a ball back, the other takes it away — and adopting the
 * wrong one would halve the search window on two tables on the strength of a
 * coincidence. The number is recorded here so the next person does not have to
 * find it again, and the identification is the thing to settle first.
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
 * COIL PULSES the machine fires before it gives up on a ball: one.
 *
 * `BALL_SEARCH_TICKS` above has always described the real mechanism in full —
 * "when no switch has closed for long enough the machine pulses its coils, and
 * if that does not shift anything it writes the ball off" — and only ever
 * implemented the second half. This is the first half, and it is here because
 * the write-off was starting to be asked to do a job it cannot do.
 *
 * What it is for, precisely: a ball that comes to rest on the APEX of something
 * round. Extreme Sports' top lanes are rings nine pixels across on the upper
 * collision line, and a ball whose tangential speed has been taken to exactly
 * zero one radius above the middle of one is in a perfect unstable equilibrium —
 * the contact normal is exactly vertical, gravity has no component along the
 * surface, and nothing in an integer contact model will ever tip it off. The
 * playfield has several such apexes and the player cannot help with any of them
 * on the upper level: `nudgeReachesLevel(1)` is false, measured, because a shove
 * on the cabinet does not reach into a habitrail. THE COILS DO — they are bolted
 * to the playfield.
 *
 * THREE, and the count is measured. A real search pulses its coils several times
 * before giving up, and here it has to: with a single pulse an Extreme Sports
 * ball rolled off the apex of one top-lane ring and came to rest on the apex of
 * the NEXT one, nine pixels along, which is why the aggressive census still
 * reported one level-1 write-off at (210,62) after having reported one at
 * (241,62). Successive pulses alternate direction so the second is never a
 * repeat of the first. At three, every table's census is clean.
 *
 * Bounded so it cannot become the very defect the search exists to prevent. The
 * budget is per SERVE, not per stillness: a pulse spends it, and once it is
 * spent the next expiry writes the ball off whatever happened in between. The
 * worst case is therefore three extra `ballSearchTicks` windows per ball and the
 * termination guarantee is untouched — which matters, because the search was
 * defeatable once already, by a player nudging every 700 ticks.
 */
export const BALL_SEARCH_PULSES = 3;

/**
 * The pulse, in Q10 per tick: the measured SLINGSHOT coil, 3500 of the
 * original's velocity units through the acceleration bridge.
 *
 * Not a chosen number, and not the player's nudge either. A ball search fires
 * the machine's own coils, and this reconstruction now knows exactly how hard
 * one of those hits — see `surface-physics.ts`, +0x00B5E0. Using the slingshot
 * rather than the pop bumper because the bumper is the harder of the two and
 * this is meant to dislodge a ball, not launch it across the table.
 */
export const BALL_SEARCH_PULSE: Q10 = SLINGSHOT_KICK;

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
   * `SIMULATION_GRAVITY`, because the plunger's launch ceiling is only
   * meaningful relative to it: change one and the other has to move with it or
   * a full plunge stops clearing the lane.
   */
  readonly gravityY: Q10;
  /** Option record 4, the table x-tilt. Zero on every shipped table. */
  readonly tiltX: Q10;
  readonly serveDelayTicks: number;
  readonly firstServeDelayTicks: number;
  /** Motionless ticks before a ball is written off. See BALL_SEARCH_TICKS. */
  readonly ballSearchTicks: number;
  readonly simulation: Partial<SimulationOptions>;
  readonly camera: CameraOptions;
}

export const DEFAULT_GAME_OPTIONS: GameOptions = Object.freeze({
  ballsPerGame: DEFAULT_BALLS_PER_GAME,
  gravityY: SIMULATION_GRAVITY,
  tiltX: SIMULATION_X_TILT,
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
    tiltX: options?.tiltX ?? DEFAULT_GAME_OPTIONS.tiltX,
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
  /**
   * The table's SCORING LAYER, or null.
   *
   * Nullable where the ramp drive is not, and the asymmetry is the one
   * `table-devices.ts` argues for: a missing drive changes the PHYSICS and every
   * shallow ramp becomes a trap, so it throws; a missing scoring layer leaves
   * the ball rolling exactly the same path and only the score reads zero. It is
   * also the SURFACE-ID MAP, which is handed to `stepBalls` so the contact model
   * can take its restitution from the id under the contact and so a bumper can
   * be a bumper.
   */
  readonly devices: TableDevices | null;
  /**
   * The table's MISSION LAYER, or null.
   *
   * Nullable for the same reason the scoring layer is, and with the same
   * consequence: without it a mode START still awards its 500,000 and the
   * mission still never runs, which is exactly the state this project was in
   * before the event record turned out to be a bytecode program. See
   * `mode-vm.ts`.
   */
  readonly modes: TableModes | null;
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
   * Saucers whose held ball the machine has ALREADY replaced: the device ids
   * marked when a capture left nothing rolling and a replacement serve was
   * owed. When the lock's script later ejects that ball, the eject does not
   * owe a second serve — the replacement already stands in for it — which is
   * what keeps the decoded eject path and the reconstruction's replacement
   * rule from together minting a ball the player never had.
   */
  lockDebts: Set<string>;
  /**
   * Ticks until the auto-launcher fires the ball in the lane, or 0 when it is
   * not armed. Armed only for balls the machine owes itself.
   */
  autoLaunchCountdown: number;
  /** Locks captured so far this ball, for the presentation. */
  ballsLocked: number;
  /** Packed-BCD score and bonus, plus the three award debounces. */
  scoring: ScoringState;
  /** The mission machine's state, or null when the table has no mission layer. */
  modeState: ModeState | null;
  /** The lines the running mission last put on the display, newest first. */
  modeMessages: readonly string[];
  /** The ball sitting on the plunger rod, or null once it has been launched. */
  laneBallId: number | null;
  serveCountdown: number;
  /** Consecutive ticks with every live ball inside its box and none on the rod. */
  stillTicks: number;
  /** Coil pulses left before the ball search writes the ball off. Per serve. */
  searchPulses: number;
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
  /**
   * The subset of `drained` the BALL SEARCH retired rather than the drain taking.
   *
   * A ball leaves play in one of two ways and the difference is the whole of
   * what a write-off census measures: it goes down the drain, which is the game
   * working, or the search gives up on it, which is the game admitting the
   * playfield stopped returning it. Both used to arrive as plain `drained` ids
   * and every census told them apart by asking whether the ball's LAST SAMPLED
   * POSITION was on the bottom rows.
   *
   * That heuristic is a function of how fast the ball is moving, and it broke the
   * moment gravity was measured: a ball arriving at the drain at 13 px a tick is
   * last seen at y=586..589 rather than y>=590, so twelve perfectly ordinary
   * drains on Law 'n Justice were counted as strandings — a 4.2% write-off rate
   * that was entirely an artefact of the census's own threshold. The loop knows
   * which is which and now says so, and no caller has to guess.
   */
  readonly writtenOff: readonly number[];
  /**
   * Ids the ball search returned to the TROUGH this tick instead of writing
   * off: balls that had settled inside a saucer already holding one.
   *
   * These are NOT ball ends and are deliberately not in `drained`: the ball
   * comes back out of the plunger lane as an owed serve, exactly as a released
   * lock ball does. See `runBallSearch` for the site that made this necessary.
   */
  readonly swallowed: readonly number[];
  /** Ids a lock swallowed this tick, in device order. */
  readonly locked: readonly number[];
  /** True on the tick a multiball was lit and the saucers gave their balls back. */
  readonly multiballStarted: boolean;
  /** Index into the table's mission list started this tick, or -1. */
  readonly missionStarted: number;
  /** True on the tick the running mission reached its END. */
  readonly missionEnded: boolean;
  /** Everything that scored this tick, in the order it scored. */
  readonly awards: readonly Award[];
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
  const modes = tableModesFor(map.tableId);
  return {
    map,
    materials: materialTableFor(map.tableId),
    rampDrive: tableAccelerationFor(map.tableId),
    devices: tableDevicesFor(map.tableId),
    modes,
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
    lockDebts: new Set<string>(),
    autoLaunchCountdown: 0,
    ballsLocked: 0,
    scoring: createScoringState(),
    modeState: modes === null ? null : createModeState(modes),
    modeMessages: [],
    laneBallId: null,
    serveCountdown: 0,
    stillTicks: 0,
    searchPulses: BALL_SEARCH_PULSES,
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
  game.lockDebts = new Set<string>();
  game.autoLaunchCountdown = 0;
  game.ballsLocked = 0;
  // A fresh board rather than a cleared one: the flag bytes that decide whether
  // an award is a first hit or a repeat are per GAME, and a new game must not
  // inherit the last one's.
  game.scoring = createScoringState();
  // A fresh mission machine for the same reason: the DONE bits that say which
  // shots a player has already finished are per game, so a new game must not
  // start with half the table already completed.
  game.modeState = game.modes === null ? null : createModeState(game.modes);
  game.modeMessages = [];
  game.laneBallId = null;
  game.serveCountdown = game.options.firstServeDelayTicks;
  game.stillTicks = 0;
  game.searchPulses = BALL_SEARCH_PULSES;
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
    scrollDivisor: base.scrollDivisor,
    anchorRows: base.anchorRows,
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
    writtenOff: [],
    swallowed: [],
    locked: [],
    multiballStarted: false,
    missionStarted: -1,
    missionEnded: false,
    awards: [],
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
          game.searchPulses = BALL_SEARCH_PULSES;
          // The hit timers and zone occupancies, and only those: the flag bytes
          // that decide first-hit versus repeat are per game, not per ball.
          resetScoringForNewBall(game.scoring);
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
  const forces: SimulationForces = {
    gravityY: game.options.gravityY,
    tiltX: game.options.tiltX,
    nudgeX,
    nudgeY,
  };
  // The drive is spread in LAST so a caller cannot switch it off through
  // `options.simulation` without noticing they have done it — and it is the
  // game's own, from the registry, not something the options carry.
  const step = stepBalls(game.balls, game.map, game.materials, forces, {
    ...game.options.simulation,
    rampDrive: game.rampDrive,
    surfaces: game.devices,
  });
  const flipperContacts = resolveFlipperContacts(
    game.balls.balls,
    bankTick.sweeps,
    ballRadiusOf(game),
    null,
    restThresholdOf(game),
  );
  // The ball takes angular momentum out of the bat — measured, see
  // `applyFlipperReactions` — so the bank has to be told what it just paid for.
  game.flippers = applyFlipperReactions(game.flippers, flipperContacts);

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

  // ---- scoring -----------------------------------------------------------
  //
  // After the physics and after the rod is pinned, so the ids scored are the
  // ones the ball really touched this tick and the ball parked on the plunger
  // cannot score the lane it is sitting in. Before the locks, because a lock
  // captures a ball that has already been scored for whatever it rolled over on
  // the way in.
  const awards = runScoring(game, step.surfaces);

  // ---- ball locks and multiball ------------------------------------------
  const wasMultiball = game.multiball;
  const lockTick = runLocks(game);
  awards.push(...lockTick.awards);

  // ---- missions ----------------------------------------------------------
  //
  // Every award that came from a device, a trigger zone or a lock queues that
  // record's own script — `jsr $6c10` at +0x005582 for a lock, and the same call
  // from the device and zone handlers. Then one frame of the mission machine.
  // Queue first, run second, so a script fired this tick starts next tick,
  // which is the original's ordering and what keeps one ball from satisfying two
  // stages of a ladder in one frame.
  const modeTick = runModes(game, awards);
  awards.push(...modeAwardsAsAwards(modeTick));

  // ---- ball search -------------------------------------------------------
  const search = runBallSearch(game);
  const lost = search.lost;
  // A swallowed ball is inactive but NOT drained: it is back in the trough and
  // the machine owes a serve for it, so it must not reach the end-of-ball path.
  if (search.swallowed.length > 0) pruneInactiveBalls(game.balls);

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
      game.lockDebts.clear();
      pruneInactiveBalls(game.balls);
      // The mission goes with the ball. The original refuses to END THE BALL
      // while a mission is running instead (0x4F12-0x4F28 will not advance the
      // game state while `$daa(a5)` is set), which is not reproducible here: the
      // ball is already gone, so nothing could ever advance the script and the
      // machine would hang. See the divergence note in `mode-vm.ts`.
      if (game.modes !== null && game.modeState !== null) {
        resetModesForNewBall(game.modes, game.modeState);
      }
      game.modeMessages = [];
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
    writtenOff: lost,
    swallowed: search.swallowed,
    locked: lockTick.locked,
    multiballStarted: game.multiball && !wasMultiball,
    missionStarted: modeTick.missionStarted,
    missionEnded: modeTick.missionEnded,
    awards,
    justTilted,
    gameOver,
  };
}

/**
 * Runs one tick of the scoring layer: the hit timers down one frame, then the
 * surfaces each ball touched, then the zones each ball is inside.
 *
 * Surfaces before zones because that is the order the original's ball loop does
 * it in — the collision pass at +0x00AD42 dispatches the device chain, and the
 * zone walk at +0x0052E6 runs after it — and because it is the order a player
 * would describe: the ball hit the target, then it rolled into the lane.
 *
 * A held ball is skipped entirely. It is out of the simulation (see
 * `ballIsInPlay`), so it has no contacts to score, and leaving it in the zone
 * pass would make a saucer re-award its own rectangle every tick it held a ball.
 */
function runScoring(game: Game, surfaces: ReadonlyMap<number, readonly number[]>): Award[] {
  const devices = game.devices;
  if (devices === null) return [];
  tickScoring(game.scoring);

  const awards: Award[] = [];
  for (const ball of game.balls.balls) {
    if (!ballIsInPlay(ball)) continue;
    if (ball.id === game.laneBallId) continue;
    const touched = surfaces.get(ball.id);
    if (touched === undefined || touched.length === 0) continue;
    awards.push(...scoreSurfaces(game.scoring, devices, ball.level, touched));
  }

  const centres = freeBalls(game.balls)
    .filter((ball) => ball.id !== game.laneBallId)
    .map((ball) => ({
      id: ball.id,
      level: ball.level,
      x: q10ToPixel(ball.x),
      y: q10ToPixel(ball.y),
    }));
  awards.push(...scoreZones(game.scoring, devices, centres));

  for (const award of awards) applyAward(game.scoring, award);
  return awards;
}

/** The player's score, as a decimal number read out of the BCD field. */
export function currentScore(game: Game): number {
  return readBcdField(game.scoring.score);
}

/** The player's bonus, as a decimal number read out of the BCD field. */
export function currentBonus(game: Game): number {
  return readBcdField(game.scoring.bonus);
}

/**
 * Feeds this tick's awards into the mission machine and runs one frame of it.
 *
 * The join between the physics and the rules is exactly this: a device, a
 * trigger zone or a lock that paid an award also fires its own event record, and
 * that record's `AWARD` opcode is what puts out the lit shot a mission is
 * waiting on. Everything else — the timers, the ladders, the timeouts — follows
 * from that one bit going out. See `mode-vm.ts`.
 *
 * A device binding is looked up on both levels because the award's id carries
 * the surface id and not the plane; the engine indexes the level's own array and
 * a surface id is filed in exactly one of them, so asking both is the same
 * answer with fewer things to get wrong.
 */
function runModes(game: Game, awards: readonly Award[]): ModeTickReport {
  const modes = game.modes;
  const state = game.modeState;
  if (modes === null || state === null) return EMPTY_MODE_TICK;

  for (const award of awards) {
    const trigger = awardTrigger(award);
    if (trigger === null) continue;
    if (trigger.kind === "device") {
      const lower = modes.scriptForDevice(0, trigger.id);
      queueScript(state, lower >= 0 ? lower : modes.scriptForDevice(1, trigger.id));
      continue;
    }
    const level: PlayfieldLevel = trigger.level === 1 ? 1 : 0;
    queueScript(
      state,
      trigger.kind === "lock"
        ? modes.scriptForLock(level, trigger.id)
        : modes.scriptForZone(level, trigger.id),
    );
  }

  const report = tickModes(modes, state);

  for (const award of report.awards) {
    addToBcdField(game.scoring.score, award.score);
    addToBcdField(game.scoring.bonus, award.bonus);
  }
  // The banner is the last thing the mission said, and it goes away with the
  // mission: a display left showing "SHOOT ALL TERRORISTS" after the mode has
  // ended is worse than showing nothing.
  if (report.messages.length > 0) game.modeMessages = report.messages;
  if (report.missionEnded) game.modeMessages = [];

  // THE DECODED LOCK RELEASES. `BALL_REMOVE` takes the named lock's held ball
  // off the table into the trough with nothing owed for it — the `BALLS_UP_TO`
  // that follows it in every script that uses it counts live and queued balls,
  // so the removed ball comes back as part of the top-up. A `PUSH` eject gives
  // the ball back on its own: the machine owes a serve for it, unless the
  // capture already bought a replacement (see `Game.lockDebts`).
  //
  // WHERE the ejected ball reappears is this port's one divergence from the
  // decoded mechanism, and it is labelled: the popper at 0x7078 kicks the ball
  // out of the saucer in place with authored per-device impulse words that are
  // not yet exported, and this reconstruction returns it through the trough
  // and the plunger lane like every other release instead. Same ball count,
  // different door.
  let released = false;
  for (const eject of report.lockEjects) {
    const device = lockForZone(game.locks, eject.level, eject.index);
    if (device === null) continue;
    const ballId = releaseLock(game.locks, device.id, game.balls.balls);
    if (ballId === null) continue;
    released = true;
    if (game.lockDebts.delete(device.id)) continue;
    oweServes(game, 1);
  }
  for (const remove of report.lockRemoves) {
    const device = lockForZone(game.locks, remove.level, remove.index);
    if (device === null) continue;
    if (releaseLock(game.locks, device.id, game.balls.balls) !== null) released = true;
    game.lockDebts.delete(device.id);
  }
  if (released) pruneInactiveBalls(game.balls);

  // `BALLS_UP_TO` is the multiball opcode and it is a TOP-UP with a ceiling of
  // three, which is what `oweServes` already implements. Which count each
  // multiball asks for is the script's own word — 2 or 3, per table, decoded.
  if (report.ballsUpTo > 0) {
    oweServes(game, ballsToTopUp(report.ballsUpTo, freeBallCount(game.balls), game.pendingServes));
    if (report.ballsUpTo > 1) game.multiball = true;
  }
  return report;
}

/**
 * The mission awards, as ordinary awards, so one list carries everything that
 * scored this tick and `debugSnapshot().score` stays the sum of it.
 *
 * `source` is "mode" and the id names the element, so a test can tell a shot
 * that paid its device record from the same shot paying its mission.
 */
function modeAwardsAsAwards(report: ModeTickReport): Award[] {
  return report.awards.map((award) => ({
    source: "mode" as const,
    id: `mode-element-${award.element}`,
    score: award.score,
    bonus: award.bonus,
    repeat: false,
  }));
}

/**
 * Owes the lane `count` more balls, and starts the clock if it is not running.
 *
 * The countdown is only armed when the lane is free and nothing is already
 * counting: a serve in progress must not be restarted, and a ball on the rod
 * blocks the queue until the player shoots it, which is the original's rule
 * (`$D88/$D89(a5)`, set by the server at data 0x65EE and cleared only by the
 * shooter-lane zone at data 0x54C2).
 *
 * ---------------------------------------------------------------------------
 * THE MACHINE HAS THREE BALLS AND CANNOT OWE A FOURTH
 * ---------------------------------------------------------------------------
 * `MAX_SIMULTANEOUS_BALLS` is not a policy, it is the size of the original's
 * ball array: three objects of 110 bytes at data 0x3536, with the next live
 * global immediately after the third. A ball that does not exist cannot be
 * served, so the debt is capped by what the trough actually has left —
 * everything not already rolling, held in a saucer or already queued.
 *
 * Without the cap the debt could exceed the trough by a route that needs
 * multiball to reach: a scripted eject queues a serve for the ball it frees and
 * the top-up that follows only ever adds, so a burst of ejects while balls are
 * still rolling could briefly promise a fourth. Capping the debt at its source
 * fixes every caller at once and leaves the top-up doing exactly what opcode
 * `$6C` does.
 */
function oweServes(game: Game, count: number): void {
  const inHand = freeBallCount(game.balls) + heldBallCount(game.locks) + game.pendingServes;
  const room = MAX_SIMULTANEOUS_BALLS - inHand;
  count = Math.min(count, room);
  if (count <= 0) return;
  game.pendingServes += count;
  if (game.laneBallId === null && game.serveCountdown === 0) {
    game.serveCountdown = game.options.serveDelayTicks;
  }
}

/**
 * Captures balls into saucers. What a capture LEADS TO is no longer decided
 * here: the saucer's own script does that, through the mission machine.
 *
 * DECODED: capture freezes the ball where it is and takes it out of the
 * simulation; the capture's award queues the lock's script (`jsr $6c10` at
 * +0x005582, routed through `runModes`); that script advances the multiball
 * lock ladder (award effect 6), ejects the ball back (`PUSH`) or leaves it
 * held for its multiball's `BALL_REMOVE` and `BALLS_UP_TO`. The two-saucers
 * rule that used to live here is replaced by that mechanism — see the
 * headstone comment in `ball-locks.ts`.
 *
 * RECONSTRUCTION: a capture that leaves nothing rolling buys the player a
 * replacement ball, which keeps the promise that a game always ends — a
 * swallowed launcher (`MODE_START` while another mode runs eats the start but
 * the ladder still counts, a measured consequence) or a modeless table would
 * otherwise leave the table empty with no way forward. The saucer is marked in
 * `lockDebts` so a later scripted eject of the same ball does not owe a second
 * serve on top of the replacement.
 */
function runLocks(game: Game): {
  readonly locked: readonly number[];
  readonly awards: readonly Award[];
} {
  const captured = captureBalls(game.locks, game.balls.balls);
  if (captured.length === 0) return { locked: [], awards: [] };

  game.ballsLocked += captured.length;
  const locked = captured.map((capture) => capture.ballId);

  // The lock's own award, taken on the tick the saucer swallows the ball —
  // `jsr $6b96` at +0x005568, immediately after the ball is flagged held. A
  // lock that was already occupied never gets here, which is why this is scored
  // from the capture rather than from the zone pass.
  const awards: Award[] = [];
  const devices = game.devices;
  if (devices !== null) {
    for (const capture of captured) {
      const ball = ballById(game.balls, capture.ballId);
      if (ball === undefined) continue;
      const award = scoreLock(
        game.scoring,
        devices,
        ball.level,
        q10ToPixel(ball.x),
        q10ToPixel(ball.y),
      );
      if (award !== null) {
        applyAward(game.scoring, award);
        awards.push(award);
      }
    }
  }

  if (freeBallCount(game.balls) === 0) {
    oweServes(game, 1);
    // The replacement stands in for the FIRST held ball of this tick's
    // captures: when its saucer's script ejects it later, no second serve.
    const deviceId = captured[0]?.deviceId;
    if (deviceId !== undefined) game.lockDebts.add(deviceId);
  }
  return { locked, awards };
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
 *
 * ---------------------------------------------------------------------------
 * THE OCCUPIED-SAUCER POCKET, AND WHY IT IS A TROUGH RETURN, NOT A WRITE-OFF
 * ---------------------------------------------------------------------------
 * Found by the first census at the measured flipper energies: BabeWatch, hold
 * 25 / cadence 20, deterministic. Ball 1 is captured by the `lower-bowl` saucer
 * (rectangle (200,250)-(230,295), level 0) and held at (228,257); the
 * replacement ball rolls into the SAME bowl at ~tick 4820 and settles jittering
 * at (219,290) — the bowl's physical bottom. The saucer refuses it, exactly as
 * the original's capture handler does (`move.b $1(a1),d0 / bne` at +0x005536:
 * occupied means ignore), and the bowl is a concave pocket on plain surface 0
 * with ramp drive (0,0) — measured from the decoded maps — so gravity never
 * returns it. The coil pulses threw it 30 px out and it rolled straight back
 * down both times; the search then retired a ball that was never lost, and the
 * census read 0.4% write-offs against a 0.0% baseline.
 *
 * The recovery is the machine's own, not an invention: the one coil AT a ball
 * seated in a saucer is the saucer kicker, and the decoded release path
 * (opcode $68, data 0x5B4E) says what that kicker does with a ball — it goes to
 * the TROUGH and comes back out of the PLUNGER LANE as a serve. It never throws
 * a ball onto the playfield. So when the stillness clock expires and the still
 * ball is sitting inside an occupied saucer's rectangle, the saucer swallows it:
 * deactivated, one serve owed, no coil pulse spent and no ball end recorded.
 * The slingshot pulses stay the answer everywhere else; they are simply the
 * wrong coil for a ball that is sitting in a hole with a kicker under it.
 *
 * Verified: the hold-25 repro now returns the ball to the lane at the first
 * expiry and the game completes with all three balls ending in real drains;
 * the full BabeWatch census slice is back to 0.0% at the same budget.
 */
function runBallSearch(game: Game): { lost: number[]; swallowed: number[] } {
  const none: { lost: number[]; swallowed: number[] } = { lost: [], swallowed: [] };
  const live = freeBalls(game.balls);
  if (
    live.length === 0 ||
    game.laneBallId !== null ||
    ballsLeftTheBox(live, game.stillAnchors, BALL_SEARCH_BOX_PIXELS)
  ) {
    game.stillTicks = 0;
    game.stillAnchors = anchorsFor(live);
    return none;
  }

  game.stillTicks += 1;
  if (game.stillTicks < game.options.ballSearchTicks) return none;

  game.stillTicks = 0;
  game.stillAnchors = [];

  // The saucer kicker first: a still ball inside an OCCUPIED saucer goes back
  // to the trough as an owed serve. See the header for the measured site and
  // for why this is the decoded $68 semantics rather than a new rule.
  const swallowed: number[] = [];
  for (const ball of live) {
    if (!restsInOccupiedSaucer(game, ball)) continue;
    ball.active = false;
    ball.velocityX = 0;
    ball.velocityY = 0;
    swallowed.push(ball.id);
  }
  if (swallowed.length > 0) {
    // Deactivated first, so the trough cap in `oweServes` sees them gone.
    oweServes(game, swallowed.length);
    game.stillAnchors = anchorsFor(freeBalls(game.balls));
    return { lost: [], swallowed };
  }

  // The coils next. See BALL_SEARCH_PULSES for why this is bounded per serve
  // rather than per stillness: a pulse that could be earned again by moving
  // would let a ball be shoved back and forth forever, which is exactly how the
  // search was defeated once before.
  if (game.searchPulses > 0) {
    const spent = BALL_SEARCH_PULSES - game.searchPulses;
    game.searchPulses -= 1;
    for (const ball of live) pulseBall(game, ball, spent);
    game.stillAnchors = anchorsFor(live);
    return none;
  }

  const lost: number[] = [];
  for (const ball of live) {
    ball.active = false;
    lost.push(ball.id);
  }
  return { lost, swallowed: [] };
}

/**
 * True when this ball's centre is inside the rectangle of a saucer that is
 * already holding a DIFFERENT ball. Such a ball can never be captured — the
 * engine's own refusal — and on a bowl-shaped saucer it can never leave either,
 * which is the strand the ball search's swallow branch exists for.
 */
function restsInOccupiedSaucer(game: Game, ball: BallState): boolean {
  for (const device of game.locks.locks) {
    if (!game.locks.held.has(device.id)) continue;
    if (lockCovers(device, ball)) return true;
  }
  return false;
}

/**
 * Fires the coils at one ball the search has run out of patience with.
 *
 * THE FIRST PULSE IS TOWARDS THE MIDDLE OF THE TABLE, because that is the one
 * direction that is a property of the machine rather than of the ball: it gets a
 * ball off an outer rail and back into play, and it never drives a ball at the
 * edge further into a corner it is already stuck in. SUCCESSIVE PULSES
 * ALTERNATE, because a ball that rolled off one apex and settled on the next one
 * along needs to be sent back the way it came, and because a search that keeps
 * repeating one shove is not a search.
 *
 * `spent` counts the pulses already used this serve, so the direction is a pure
 * function of the game state and two identical runs pulse identically.
 *
 * Velocity is SET rather than added, like the kicker device's `movem.w` at
 * +0x0056B0: whatever the ball had, it had been sitting still with it for the
 * whole search window and it is not worth preserving.
 */
function pulseBall(game: Game, ball: BallState, spent: number): void {
  const centre = game.map.width / 2;
  const inward = q10ToPixel(ball.x) < centre ? 1 : -1;
  const sign = spent % 2 === 0 ? inward : -inward;
  ball.velocityX = sign * BALL_SEARCH_PULSE;
  ball.velocityY = 0;
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
  /**
   * Called once per SIMULATION TICK with that tick's report, for presentation
   * that has to see every tick rather than every frame — the audio layer, which
   * would otherwise miss every bumper in a three-tick catch-up batch.
   *
   * Strictly downstream: the loop does not read anything back from it, and a
   * callback that throws must not take the simulation with it, so it is called
   * inside a `try`. See `src/browser/audio.ts`.
   */
  readonly onTick?: (report: GameTickReport) => void;
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
  readonly #onTick: ((report: GameTickReport) => void) | null;
  #handle: number | null = null;
  #frameCount = 0;

  constructor(options: GameLoopOptions) {
    this.game = options.game;
    this.#input = options.input;
    this.#frames = options.frames;
    this.#render = options.render;
    this.#poll = options.poll ?? null;
    this.#onTick = options.onTick ?? null;
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
      const report = tickGame(this.game, this.#input.sample());
      if (this.#onTick === null) continue;
      try {
        this.#onTick(report);
      } catch {
        // Presentation must never be able to stop the simulation.
      }
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
  /** Player score, read back out of the packed-BCD field. */
  readonly score: number;
  /** Player bonus. Zero throughout the shipped data; see `scoring.ts`. */
  readonly bonus: number;
  /** Device id to ball id for every occupied saucer, in table order. */
  readonly locks: readonly { readonly deviceId: string; readonly ballId: number }[];
  /**
   * The running mission, or null.
   *
   * `lit` is every element armed for this player, which is the reconstruction's
   * equivalent of looking at the lamps: those are the shots the table is asking
   * for right now.
   */
  readonly mission: {
    readonly index: number;
    readonly title: string;
    readonly secondsLeft: number;
    readonly lit: readonly number[];
  } | null;
  /** The lines the mission last put on the display. */
  readonly modeMessages: readonly string[];
  readonly plungerCharge: number;
  /** Consecutive motionless ticks counted toward the ball search. */
  readonly stillTicks: number;
  /** Coil pulses the ball search has left before it writes the ball off. */
  readonly searchPulses: number;
  readonly tilt: TiltState;
  readonly flippersLive: boolean;
  readonly camera: CameraState;
  readonly forceFullTable: boolean;
  readonly balls: readonly BallDebugState[];
  readonly flippers: readonly { readonly id: string; readonly stroke: number }[];
}

/**
 * The mission the table is running, flattened for the display and for tests.
 *
 * Null when no mission is running, which — because `MODE_START` refuses to start
 * a second while one is live — is the same thing as "the player may start one".
 */
export function runningMission(game: Game): GameDebugState["mission"] {
  const modes = game.modes;
  const state = game.modeState;
  if (modes === null || state === null || state.mission < 0) return null;
  const record = state.missionIndex < 0 ? undefined : modes.missions[state.missionIndex];
  return {
    index: state.missionIndex,
    title: record?.title ?? "",
    secondsLeft: missionSecondsLeft(state),
    lit: litElements(state),
  };
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
    score: readBcdField(game.scoring.score),
    bonus: readBcdField(game.scoring.bonus),
    // Built from the bank's declared device order, never from the map's
    // iteration order, so this stays a determinism digest.
    locks: game.locks.locks.flatMap((device) => {
      const ballId = game.locks.held.get(device.id);
      return ballId === undefined ? [] : [{ deviceId: device.id, ballId }];
    }),
    mission: runningMission(game),
    modeMessages: [...game.modeMessages],
    plungerCharge: chargeLevel(game.plunger),
    stillTicks: game.stillTicks,
    searchPulses: game.searchPulses,
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
  // The score outlives the ball, so it is on the game-over line too — that is
  // the one moment a player actually wants to read it.
  if (game.phase === "game-over") {
    return `GAME OVER  ${formatBcdField(game.scoring.score)}  -  ENTER FOR A NEW GAME`;
  }
  if (game.paused) return "PAUSED";
  if (game.tilt.tilted) return "TILT";
  const ball = Math.max(1, ballNumber(game));
  const charge = Math.round(chargeLevel(game.plunger) * 100);
  const plunger = game.laneBallId === null ? "" : `  PLUNGER ${charge}%`;
  // Digits straight out of the BCD field: what is displayed is what is stored.
  const bonus = readBcdField(game.scoring.bonus);
  const bonusText = bonus === 0 ? "" : `  BONUS ${formatBcdField(game.scoring.bonus)}`;
  return `BALL ${ball} OF ${game.options.ballsPerGame}  ${formatBcdField(game.scoring.score)}${bonusText}${plunger}`;
}

/**
 * The mission banner: the title the mission announced and its clock.
 *
 * Empty when nothing is running, which is what the caller uses to decide whether
 * to draw a second line at all. The seconds are `$dae / $50(a5)`, which is what
 * the original puts on its own display.
 */
function missionLine(game: Game): string {
  const mission = runningMission(game);
  if (mission === null) return "";
  const clock = mission.secondsLeft > 0 ? `  ${mission.secondsLeft}` : "";
  const title = mission.title.length > 0 ? mission.title : game.modeMessages.join(" ");
  return `${title}${clock}`;
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
  const mission = missionLine(game);
  if (mission.length > 0) {
    context.fillStyle = HUD_ALERT;
    context.fillText(mission, 6, 22);
  }
}
