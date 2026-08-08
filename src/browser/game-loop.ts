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
 * THE LANE BALL IS NOT PINNED, AND THE SERVE IS THE MACHINE'S
 * ---------------------------------------------------------------------------
 * This file used to teleport a served ball onto the lane seat and write it back
 * there, at rest, after every step, on the grounds that the collision layer has
 * no floor under the shooter lane. It has one — row 561 is solid from x=310 to
 * the right edge on all three shipped maps — and the belief predates the 32 px
 * phase correction that moved the lane.
 *
 * So the serve is now the original's: `serveBall` puts the ball in the TROUGH at
 * main.seg00 $3E36's own coordinates, carrying three bits of the last drained
 * ball's position and the low byte of its velocity (`plunger.ts` has the decode
 * and the evidence), and the ball ROLLS down the return chute on the upper
 * collision line into the lane, taking 11 to 75 ticks about it depending on what
 * it carried. Nothing writes its position on the way.
 *
 * `laneBallId` is the original's $D88: the lane is spoken for from the moment a
 * ball is dropped into the trough, so the machine never feeds a second one, but
 * the LAUNCH is gated on the rod switch — the level-0 zone at (310,540)-(330,560)
 * that every table carries over the seat and that the original's launcher reads
 * through $234E(a5) — so a press while the ball is still in the chute is
 * consumed and does nothing, exactly as +0x006628's `beq` does.
 *
 * The launch itself is the ORIGINAL'S: a fixed kick on the launch key's press
 * edge (main.seg00 0x65EE / 0x663A — see `plunger.ts` for the whole story),
 * so there is no under-plunge any more. `ballBackOnTheRod` stays because the
 * playfield can still feed a ball back into the lane from above, and a ball
 * resting in the lane must always be shootable again.
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
 * THE BAT RESOLVER IS BUILT WITH THE MAP'S OWN PUSH CLAMP
 * ---------------------------------------------------------------------------
 * Round 5 passed `null` here and argued the unclamped case was recoverable: a
 * bat can push a ball at most its own penetration, a few pixels, and `stepBalls`
 * runs `recoverPenetration` on the next tick. Both halves turned out to be
 * wrong on Law 'n Justice's upper-left bat, whose body OVERLAPS the level-0
 * boundary wall (pivot (37,302), wall 14 px away against a boss-plus-ball touch
 * distance of 13 at the time, and 16 once the silhouette was re-measured; the
 * drawn silhouette that has since replaced the capsule overlaps it too), and
 * whose recovery walk is 34 px wide on that table rather than 16 because the
 * budget was tied to the virtual top wall. `ball-physics.ts` now exports
 * `pushClampForMap`, so there is one clamp with one implementation and the bat
 * cannot write a ball through a wall in the first place. `createFlipperPass`
 * takes it, and the resolver it builds runs inside `stepBalls` at the frame's
 * four collision passes — see `BatPassResolver`.
 */

import type { Control, ControlSnapshot } from "./input.js";
import { CONTROLS, isDown, plungerInputFrom, wasPressed } from "./input.js";
import type { CameraOptions, CameraState } from "./camera.js";
import {
  DEFAULT_CAMERA_OPTIONS,
  INITIAL_CAMERA,
  VIEWPORT_HEIGHT,
  updateCamera,
} from "./camera.js";
import { drawPlayfield } from "./playfield-renderer.js";
import { HUD_ALERT, HUD_TEXT, SURROUND } from "./palette.js";
import type {
  BallState,
  MaterialTable,
  PlayfieldLevel,
  SimulationForces,
  TableMap,
} from "../game/contracts.js";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "../game/contracts.js";
import type { Q10 } from "../core/fixed-point.js";
import { pixelsToQ10, q10ToPixel } from "../core/fixed-point.js";
import { FixedStepScheduler, millisecondsToNanos } from "../core/fixed-step-scheduler.js";
import type { BallSet, PushClamp, SimulationOptions } from "../game/ball-physics.js";
import {
  DEFAULT_SIMULATION_OPTIONS,
  activeBalls,
  ballById,
  ballIsInPlay,
  createBallSet,
  freeBallCount,
  freeBalls,
  levelSolidForMap,
  pruneInactiveBalls,
  pushClampForMap,
  stepBalls,
} from "../game/ball-physics.js";
import type { LockBank } from "../game/ball-locks.js";
import type { BallLock } from "../game/ball-locks.js";
import {
  MAX_SIMULTANEOUS_BALLS,
  ballsToTopUp,
  captureBalls,
  createLockBank,
  heldBallCount,
  heldBallIn,
  lockCovers,
  lockForZone,
  releaseHeldBalls,
  releaseLock,
} from "../game/ball-locks.js";
import { BALL_RADIUS_PIXELS, DEFAULT_PROBE_RADIUS } from "../game/collision-probe.js";
import { SLINGSHOT_KICK } from "../game/surface-physics.js";
import type { BatUnionMasks, FlipperApproachSides, FlipperBank } from "../game/flippers.js";
import {
  UPPER_FLIPPER_RECORDS,
  applyFlipperReactions,
  batUnionMaskFor,
  createBatUnionMasks,
  createFlipperApproachSides,
  createFlipperBank,
  createFlipperPass,
  flipperConfigsFor,
  flipperInputFrom,
  isFullyFlipped,
  tickFlipperBank,
} from "../game/flippers.js";
import { materialTableFor } from "../game/materials.js";
import type { TableDevices, ZoneEject } from "../game/table-devices.js";
import { DEVICE_ID_BASE } from "../game/surface-physics.js";
import { originalVelocityToQ10 } from "../game/timebase.js";
import { tableDevicesFor } from "../game/table-devices.js";
import type { Award, ScoringState } from "../game/scoring.js";
import {
  addPackedBcd,
  addToBcdField,
  applyAward,
  awardTrigger,
  clearBonusForNewBall,
  clearScoringFlags,
  createScoringState,
  formatBcdField,
  readBcdField,
  resetScoringForNewBall,
  scoreLock,
  scoreSurfaces,
  scoreZones,
  tickScoring,
} from "../game/scoring.js";
import type { BonusPhase, BonusStageKind } from "../game/bonus.js";
import {
  beginBonusPhase,
  bonusCaption,
  bonusMultiplierCaption,
  bonusMultiplierLit,
  bonusPhaseFinished,
  bonusStage,
  bonusValue,
  stepBonusPhase,
} from "../game/bonus.js";
import type { TableModes } from "../game/table-modes.js";
import { tableModesFor } from "../game/table-modes.js";
import type { TableLamps } from "../game/table-lamps.js";
import { tableLampsFor } from "../game/table-lamps.js";
import { drawLampOverlays } from "./lamp-layer.js";
import { FLIPPER_BATS_PATH, flipperBats } from "../game/flipper-bats.js";
import { tableBallFor } from "../game/table-ball.js";
import { drawMovingSprites } from "./sprite-layer.js";
import type { BallFrameState, BatFrameState } from "../game/moving-sprites.js";
import type { ModeMusicCue, ModeState, ModeTickReport } from "../game/mode-vm.js";
import {
  EMPTY_MODE_TICK,
  comboCount,
  createModeState,
  groupBackedFlagIds,
  lightGroupLampsForTrigger,
  litElements,
  missionSecondsLeft,
  queueScript,
  resetModesForNewBall,
  restoreMultiplierLamps,
  signalMultiballEnded,
  tickModes,
} from "../game/mode-vm.js";
import type { TableAcceleration } from "../game/table-accel.js";
import { tableAccelerationFor } from "../game/table-accel.js";
import type { PlungerConfig } from "../game/plunger.js";
import {
  SIMULATION_GRAVITY,
  SIMULATION_X_TILT,
  TICKS_PER_SECOND,
  ballSaveSecondsFor,
} from "../game/timebase.js";
import {
  CLEARED_TROUGH_RECORD,
  autoLaunchOutcome,
  ballIsOnTheRod,
  launchBall,
  plungerConfigFor,
  serveBall,
  tickLauncher,
  troughRecordOf,
} from "../game/plunger.js";
import type { TroughRecord } from "../game/plunger.js";
import { isPoweredSurfaceId } from "../game/scoring.js";
import type { NudgeConfig, NudgeDirection, TiltState } from "../game/tilt.js";
import {
  INITIAL_TILT,
  flippersLive,
  nudge,
  nudgeConfigFor,
  poweredSurfacesLive,
  resetTiltForNewBall,
  tickTilt,
} from "../game/tilt.js";
import { PANEL_HEIGHT as PANEL_STRIP_HEIGHT } from "./panel-renderer.js";

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

/**
 * Most players a game can hold: the size of the original's player-record array.
 *
 * Eight 22-byte records at `$dc6(a5)`, and the first-serve count adjust clamps
 * at exactly eight (`cmpi.w #$8,$dbc(a5)` at main.seg00 +0x004B10). The count
 * itself lives in `$dbc(a5)`; F1..F8 in the table attract set it 1..8
 * (+0x00446E..+0x00449C) and keypad ENTER starts one player.
 */
export const MAX_PLAYERS = 8;

/**
 * Ticks the multi-player end-of-ball "PL n" card is held — `move.w #$4b,d0 /
 * jsr $5230` at main.seg00 +0x005224, run only when the player count is above
 * one (`cmpi.w #$1,$dbc(a5)` at +0x00521C). A one-player game skips the hold
 * entirely, which is why no single-player film ever shows it.
 */
export const END_OF_BALL_HOLD_TICKS = 75;

/**
 * Unskippable ticks at the front of that hold: `move.w #$19,$528A` at
 * +0x005238 — the same 25-frame grace shape the end-of-ball bonus panels use
 * (`BONUS_ABORT_GRACE_FRAMES`); after it, any key-down ends the hold.
 */
export const END_OF_BALL_HOLD_GRACE_TICKS = 25;

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
  /**
   * BALL SAVE seconds — `tableNNN.opt` record 5, the one option record that is
   * NOT the same on all three files (5 / 5 / 10; see `ballSaveSecondsFor`).
   *
   * `null` means "whatever the table ships", which is what a game the player
   * starts uses and what the census and the pin run with. A number overrides
   * it, exactly as the options screen's 0..10 slider does — and 0, a setting
   * the machine genuinely offers, is how a test that is about something else
   * says so out loud instead of quietly working around the saver.
   */
  readonly ballSaveSeconds: number | null;
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
  ballSaveSeconds: null,
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
    ballSaveSeconds: options?.ballSaveSeconds ?? DEFAULT_GAME_OPTIONS.ballSaveSeconds,
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

/**
 * ONE PLAYER'S WHOLE PRIVATE MACHINE.
 *
 * The original does not bank anything: it keeps ONE copy of every record and
 * gives each per-player field a bit or a word slot per player, selected by the
 * player index at `$dbe(a5)` — element ARMED/DONE are 8-bit masks (`bset.b d6`),
 * counter records carry eight word slots (`$6(a1,d1.w)`), the lamp masks and
 * the first-hit flag bytes are 8-bit masks, and the 22-byte player records at
 * `$dc6(a5)` hold score/bonus/multiplier/holds. See
 * research/MULTIPLAYER_DECODE.md §1.
 *
 * This port's `ScoringState`/`ModeState` are one-player views of those records
 * (a byte where the machine has a bit), so a player switch here is a BANK swap
 * where the machine's is three globals (`$dbe/$dc0/$dc2`). The two are
 * observationally equivalent: every runtime reader in the machine indexes the
 * CURRENT player's bit, and every cross-player write it makes is a ball-start
 * walk this port re-runs on each player's own rotation-in
 * (`endBallAfterBonus`). A one-player game has one bank, aliased by
 * `Game.scoring`/`Game.modeState`, and runs exactly the code it always did —
 * `tests/sim-hash-pin.test.ts` is the proof.
 */
export interface PlayerBank {
  readonly scoring: ScoringState;
  readonly modeState: ModeState | null;
}

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
  /**
   * The table's LAMP LAYER, or null.
   *
   * Nullable like the mission layer, and even more consequence-free: lamps are
   * PRESENTATION ONLY. Nothing in the tick reads this field or the overlay
   * state derived from it — a game without it plays an identical ball and
   * merely shows the static (all-lit) artwork. See `lamp-overlays.ts`.
   */
  readonly lamps: TableLamps | null;
  readonly options: GameOptions;
  readonly plungerConfig: PlungerConfig;
  readonly nudgeConfig: NudgeConfig;

  phase: GamePhase;
  /** Ticks the loop has run, including paused ones. Never resets. */
  tick: number;
  balls: BallSet;
  /**
   * Balls served so far this game — CHARGED serves, every player's together.
   * `ballsPerGame * playerCount` of them ends it; `ballNumber` derives the
   * machine's `$d84` from it, which works because charged serves are strictly
   * round-robin.
   *
   * AND THE PORT NOW HAS EXTRA BALLS, which is the one thing that looked like
   * it would decouple the two and does not. An extra ball is served by state 7
   * (`Game.extraBallServe`), whose entry at +0x00505A `bra`s clear over the
   * rotation at $5070 — where `subq.w #1,$d82` and `addq.w #1,$d84` live — so
   * it charges nothing and advances nothing. It inserts an UNCHARGED serve for
   * the player already up and leaves the sequence of charged ones exactly the
   * round-robin `ballNumber` and `ballsRemaining` read it as. Only this field's
   * increment site may ever move it, and only state 5 reaches that.
   */
  ballsServed: number;
  /**
   * One bank per player, `playerCount` of them. `scoring` and `modeState`
   * below ALIAS the active player's bank — the whole tick path reads those two
   * fields exactly as it did when there was one player, which is what keeps
   * the one-player game byte-identical. See `PlayerBank`.
   */
  banks: PlayerBank[];
  /** 0-based player whose ball is up — the original's `$dbe(a5)`. */
  activePlayer: number;
  /** Players in this game, 1..8 — the original's `$dbc(a5)`. */
  playerCount: number;
  /**
   * True from the game's first launch. The original lets F1..F8 / keypad ENTER
   * change the player count while ball 1 waits on the rod (`$d7c(a5)`, the
   * state-5 scan at +0x004AD6); the window effectively closes at the first
   * launch, because the scan only runs in the serve state. See
   * `setPlayerCount`.
   */
  playersLocked: boolean;
  /**
   * Ticks left on the multi-player end-of-ball "PL n" hold, 0 outside it.
   * `$5136`'s tail draws the card and `$5230` holds it 75 frames with a
   * 25-frame unskippable grace — only when `$dbc > 1`, so a one-player game
   * never sets this and its ball ends are untouched.
   */
  endHoldTicks: number;
  /**
   * True while the charged serve's PLAYER/BALL panel is up: from the serve
   * that costs the player a ball until the launch takes it off the rod — the
   * original's state 5, whose panel shows "PLAYER n" (or "PLAYERS n" while
   * the first-serve count window is open) and "BALL m". Machine-owed serves
   * never set it, exactly as they never pass through state 5.
   */
  announcingServe: boolean;
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
   * THE BALL SAVE COUNTDOWN, the original's `$D8A(a5)`, in ticks.
   *
   * Armed by every charged serve — state 5's first three instructions,
   * +0x0049AE, from `.opt` record 5 (`ballSaveSecondsFor`) — re-armed at any
   * length by mode-script opcode 11 (+0x005992, a plain `move.w`, so it SETS
   * rather than extends), ticked down once per in-play frame at +0x004DF2, and
   * cleared by the end-of-ball teardown at +0x0050FA. While it is non-zero the
   * reaper at +0x0052CE gives every drained ball straight back.
   *
   * NOT PER PLAYER: one word, machine-global, and it does not need to be —
   * it is armed fresh at each player's own serve and cleared between them.
   * NOT RE-ARMED BY A SAVE either: nothing in the save path writes it, so one
   * armed window can give the same ball back over and over until it runs out.
   */
  ballSaveTicks: number;
  /**
   * THE ORIGINAL'S STATE 6, the one state this port had never had: the machine
   * is holding a "DON'T MOVE" card while a saved LAST ball comes back.
   *
   * Entered only from +0x004EB8 — the last ball drained with `$D8A` still
   * running — and left at +0x004FA4 when a ball is out of the trough and the
   * lane is free again (`tst.w $d7e / beq` then `tst.b $d88 / bne`). State 6
   * runs the physics and the serve but NOT the reaper and NOT the `$D8A` tick,
   * so the saver's clock is stopped for as long as the card is up.
   *
   * `move.w #$6,$8e(a5)` occurs at exactly one address in the whole segment,
   * which is what identifies this state: the shipped documents had it down as a
   * tilt warning, and the tilt card is state 8's, at +0x004D98.
   */
  ballSaving: boolean;
  /**
   * THE ORIGINAL'S STATE 7 — SHOOT AGAIN: the ball-end chain spent an extra ball
   * and the lane owes this player a FREE re-serve.
   *
   * `move.w #$7,$8e(a5)` occurs at exactly one address, +0x005068, inside the
   * two instructions the drain path takes when the player record's +$10 is
   * non-zero (`tst.b $10(a0) / beq $5070` — no bank, rotate the player — else
   * `subq.b #1,$10(a0)`), and its `bra $50B0` jumps CLEAR OVER the rotation at
   * $5070 where `subq.w #1,$d82` (balls left) and `addq.w #1,$d84` (ball number)
   * both live. So the re-serve costs the player nothing: no rotation, no charge
   * to `ballsServed`, and hence no move in `ballNumber` or `ballsRemaining`,
   * which is exactly what those two derive.
   *
   * A BOOLEAN, where the record's +$10 is a count, because this is the debt of
   * ONE serve: the count lives on `ScoringState.extraBalls` and is spent one at
   * a time by the ball-end chain, which is the only thing that ever sets this.
   *
   * State 7 is a SERVE state, not a machine-owed one like state 6: `+0x004FC0`
   * sets `$d7b` — the byte the tilt-meter reset at +0x0054B6 hangs off, and only
   * states 5 and 7 set it — and `+0x004FC4` draws descriptor +$88's PLAYER/BALL
   * card through the same `jsr $6868` state 5's own +0x0049BE does. What it does
   * NOT do is write `$d8a`: an extra ball gets no ball saver, because the
   * teardown at +0x0050FA has already zeroed the countdown and nothing in state
   * 7 re-arms it. research/effects-tail/EFFECTS_TAIL.md §2.4.
   */
  extraBallServe: boolean;
  /**
   * Saucers whose script has run `PUSH` and which are counting down to spitting
   * their ball back onto the playfield, newest first.
   *
   * This is the original's element stack at `$23DC(a5)`: `PUSH` (+0x005BFC)
   * pushes the lock's record and the pop service at +0x006F72 works ONE element
   * at a time, so a second `PUSH` while an eject is in flight waits its turn and
   * the last one pushed is served first. `lockEjecting` is `$23E0(a5)`, the
   * element currently counting.
   */
  lockEjectStack: string[];
  /** The saucer currently counting down, and how many ticks are left. */
  lockEjecting: { deviceId: string; ticksLeft: number } | null;
  /** The map's push clamp, built on first use. See `pushClampFor`. */
  pushClamp: PushClamp | null;
  /**
   * The bats' UNION MASKS — each pose's own pixels with this table's collision
   * plane ORed in, which is what the machine builds at `+0x0039FA` while the
   * table loads. Built on first use and kept: it is per (table, bat, pose) and
   * nothing about it can change while a table is up. See `batUnionsFor`.
   */
  batUnions: BatUnionMasks | null;
  /**
   * Ticks until the auto-launcher fires the ball in the lane, or 0 when it is
   * not armed. Armed only for balls the machine owes itself.
   */
  autoLaunchCountdown: number;
  /** Locks captured so far this ball, for the presentation. */
  ballsLocked: number;
  /** Packed-BCD score and bonus, plus the three award debounces. */
  scoring: ScoringState;
  /**
   * The end-of-ball bonus being paid right now, or null.
   *
   * Non-null from the drain that ended a ball until the last of its panels has
   * had its frames; the lane stays shut for the whole of it and the score is
   * paid on the tick it clears. Null on a TILTED ball end, which forfeits.
   * See `bonus.ts`.
   */
  bonus: BonusPhase | null;
  /** The mission machine's state, or null when the table has no mission layer. */
  modeState: ModeState | null;
  /** The lines the running mission last put on the display, newest first. */
  modeMessages: readonly string[];
  /** The ball sitting on the plunger rod, or null once it has been launched. */
  laneBallId: number | null;
  serveCountdown: number;
  /**
   * The three bits of position and byte of velocity the last ball taken off the
   * table left in the trough, which the NEXT serve carries out of it.
   *
   * The original's ball records at $FAA(a5), read and rewritten in place by
   * $3E36 — see `plunger.ts`. It is deliberately not reset by `startGame`: the
   * machine's memory of the last drain outlives a game, because nothing in the
   * binary ever clears those records. `createGame` is the cold machine.
   *
   * ONE record, where the original has three (one per ball, each carrying its
   * own last drain). With a single ball in play the two are identical, because
   * only one record is ever in flight; during multiball the original would serve
   * ball 2 from ball 2's own last drain and this serves it from whichever ball
   * drained most recently. Stated rather than modelled: this port's balls are an
   * open set with running ids and there is no honest mapping onto three slots.
   */
  troughRecord: TroughRecord;
  /** Consecutive ticks with every live ball inside its box and none on the rod. */
  stillTicks: number;
  /** Coil pulses left before the ball search writes the ball off. Per serve. */
  searchPulses: number;
  /** Where each live ball was when that run of ticks began. See `runBallSearch`. */
  stillAnchors: readonly BallAnchor[];
  tilt: TiltState;
  flippers: FlipperBank;
  /**
   * WHICH SIDE OF EACH BAT EACH BALL WAS LAST OUTSIDE ON, carried across ticks.
   *
   * The bats resolve four times a tick now, inside the integrator, so the
   * approach side `ed5e01d` made a sign instead of a position has to outlive the
   * tick it was read in — a cradled ball spends hundreds of consecutive passes
   * inside the blade with no fresh reading available. See
   * `FlipperApproachSides`. It is game state and not a cache: two games with the
   * same inputs and different memories here are two different games.
   */
  flipperSides: FlipperApproachSides;
  camera: CameraState;
  paused: boolean;
  /** Player's whole-table override, on top of the automatic multiball reframe. */
  forceFullTable: boolean;
}

/**
 * One frame of the end-of-ball bonus display, as the panel needs it.
 *
 * The captions are the packages' own ASCII (Law 'n Justice hunk 4 +0x2BC4,
 * +0x2BD2, +0x2BE6) and the multiplier caption is the row of records at +0x2C0C;
 * `bonus.ts` is where they and their frame counts are decoded.
 */
export interface BonusView {
  readonly stage: BonusStageKind;
  /** "BONUS", "TOTAL BONUS", "NO BONUS", or "<n> COMBOS". */
  readonly caption: string;
  /** The figure under the caption, or null when the panel is a caption alone. */
  readonly value: number | null;
  /** "X2".."X10", or "" when the ball has no multiplier to show. */
  readonly multiplier: string;
  /** True on the half-cycles the multiplier caption is drawn. */
  readonly multiplierLit: boolean;
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
  /**
   * Ids a saucer spat back onto the playfield this tick, at the record's own
   * authored position and impulse. Never more than one: the popper serves one
   * element at a time. These are NOT serves — the ball never left play.
   */
  readonly ejected: readonly number[];
  /**
   * The saucer each of `ejected` came out of, parallel to it: the lock zone's
   * level and index. The audio layer keys the eject voice on the saucer —
   * the original plays the record the held zone object carries at `+$10`
   * (main.seg00 $6FD8/$705A), so which saucer it was is part of the event.
   */
  readonly ejectedFrom: readonly { readonly level: PlayfieldLevel; readonly index: number }[];
  /**
   * Ids of balls that crossed between the two collision lines during this
   * tick's physics step — the zone-action-10/11 transfers and the surface
   * hand-offs, but NOT lock ejects (those choose a level too, and are already
   * reported above) and not serves. The original plays its level-transfer
   * record from the two handlers at $B252/$B26A on exactly these crossings.
   */
  readonly levelTransfers: readonly number[];
  /** True on the tick a multiball was lit and the saucers gave their balls back. */
  readonly multiballStarted: boolean;
  /** Index into the table's mission list started this tick, or -1. */
  readonly missionStarted: number;
  /** True on the tick the running mission reached its END. */
  readonly missionEnded: boolean;
  /** Everything that scored this tick, in the order it scored. */
  readonly awards: readonly Award[];
  /**
   * The COMBO CHAIN'S OWN PAYMENT this tick, which is not an award.
   *
   * Mission award effects 16 and 7 pay a counter record's accumulator straight
   * into the player's score through `$6BCC` — one BCD field, score only, with
   * no element and no bonus beside it — where an ordinary element award goes
   * through `$6B96` and pays the pair. So it is a third way the score moves,
   * alongside `awards` and the end-of-ball bonus, and it was the one way that
   * nothing outside this module could see. `tests/scoring-play.test.ts` needs
   * all three to say what it means to say: that the score is exactly the sum of
   * what the shipped data paid and never a digit more.
   */
  readonly comboPaid: number;
  /**
   * Element indices the mode VM STARTed this tick, in execution order.
   *
   * These three lists are the score panel's feed: the element's +$14 display
   * record (on START), its +$18 record (on AWARD) and each message record
   * name the slot-5 animations the original's $6C2C append queues on the
   * 64-slot display ring, and the index-to-objects wiring ships in the panel
   * document. The simulation neither knows nor cares what a panel is — these
   * are indices into data it already owns — which is what keeps the panel
   * strictly downstream of the tick.
   */
  readonly elementStarts: readonly number[];
  /** Element indices the mode VM AWARDed this tick, in execution order. */
  readonly elementAwards: readonly number[];
  /** Message-record indices the mode VM put on the display this tick. */
  readonly messagesShown: readonly number[];
  /**
   * MUSIC OPCODE SITES the mode VM executed this tick, in execution order:
   * `{script, pc}` pairs into the modes document. Opcode 19's handler
   * (main.seg00 $5B3E) posts the record's command / order position / bank
   * straight to the music player's mailbox at $6868, so these are the MODE and
   * JACKPOT MUSIC SWITCHES; `src/audio/table-music.ts` carries the decoded
   * record for each site and `src/browser/table-music.ts` plays it. As with
   * `messagesShown`, the simulation reports indices into data it already owns
   * and knows nothing about sound.
   */
  readonly musicCues: readonly ModeMusicCue[];
  readonly justTilted: boolean;
  readonly gameOver: boolean;
  /**
   * The end-of-ball bonus panel this tick, or null when none is up.
   *
   * Plain data rather than the phase object, and on the report rather than
   * behind a getter, so the panel layer keeps its "state advances only in
   * `observe`" contract and stays a pure function of the tick stream.
   */
  readonly bonus: BonusView | null;
  /**
   * Flipper sides whose full-raise flag rose this tick — some bat of the side
   * reached the top of its stroke while none was there before. The original's
   * `$23F5` (left) / `$23F6` (right) 0->FF edges, the up-stroke sound's trigger
   * at $A7A2/$A7C8. A side with two bats (the upper flipper rides its side's
   * button) flags once, exactly as one byte per side can.
   */
  readonly flipperRaised: readonly FlipperSide[];
  /** The FF->0 edges of the same flags: the side left full raise ($A79A). */
  readonly flipperRested: readonly FlipperSide[];
  /**
   * THE FIGURES A DISPLAY RECORD'S NUMBER OPCODES READ, this tick.
   *
   * Six of the 26 display opcodes print a live value rather than a string —
   * "BUMPER VALUE" and the figure under it are one record — and every one of
   * them reads a field this simulation already keeps. `ModeMessageValue` has the
   * decode of which pointer names which field; this is that set, sampled once a
   * tick so the panel layer stays a pure function of the tick stream and never
   * reaches into `ModeState`.
   *
   * The arrays are the live `ModeState` ones and MUST NOT be retained past the
   * call: the panel resolves its figures inside `observe`, which is exactly when
   * the machine's own interpreter executes the record's instruction.
   */
  readonly displayValues: DisplayValues;
}

/**
 * The live fields the display's number opcodes read. See `GameTickReport`.
 *
 * `score` and `missionSeconds` are plain numbers because the machine reads them
 * from single locations (player +$02..$07 and `$23E6(a5)`, which 0x57D0 sets to
 * the mission countdown divided by VBlankFrequency); the rest are the per-record
 * arrays, indexed by the record index the modes document carries.
 */
export interface DisplayValues {
  readonly score: number;
  readonly missionSeconds: number;
  readonly counterAccumulators: ArrayLike<number>;
  readonly counterSteps: ArrayLike<number>;
  readonly counterCounts: ArrayLike<number>;
  readonly rampValues: ArrayLike<number>;
  readonly rampPaid: ArrayLike<number>;
}

/** The empty channel, for the ticks with no simulation behind them. */
const NO_DISPLAY_VALUES: DisplayValues = Object.freeze({
  score: 0,
  missionSeconds: 0,
  counterAccumulators: Object.freeze([]),
  counterSteps: Object.freeze([]),
  counterCounts: Object.freeze([]),
  rampValues: Object.freeze([]),
  rampPaid: Object.freeze([]),
});

/** The two flipper flag bytes the original keeps, `$23F5` and `$23F6`. */
export type FlipperSide = "left" | "right";

/** Which sides have some bat at the top of its stroke. */
function raisedSides(bank: FlipperBank): { left: boolean; right: boolean } {
  let left = false;
  let right = false;
  for (const config of bank.configs) {
    const state = bank.states.get(config.id);
    if (state === undefined || !isFullyFlipped(config, state)) continue;
    if (config.role === "left") left = true;
    else if (config.role === "right") right = true;
  }
  return { left, right };
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
 *
 * THE FLIPPER BAT POSE BANK IS NOW THE SAME KIND OF REQUIREMENT, and for a
 * sharper reason: the bats collide on the pixels those poses draw, so a game
 * assembled without it has no bat shape at all. It used to be presentation only
 * — absent, the renderer drew a magenta marker and the ball still bounced off an
 * analytic capsule — and that is precisely the arrangement in which a picture and
 * a physics can disagree. There is no capsule left to fall back to and
 * `batPoseBody` refuses to invent one, so this turns what would otherwise be a
 * throw on the first tick a ball came near a bat into a boot failure that names
 * the document.
 */
export function createGame(map: TableMap, options?: Partial<GameOptions>): Game {
  if (flipperBats() === null) {
    throw new Error(
      `${map.tableId}: the flipper bat pose bank is not registered, so the bats have no ` +
        `collision body. Load ${FLIPPER_BATS_PATH} (loadFlipperBats) before createGame.`,
    );
  }
  const modes = tableModesFor(map.tableId);
  const scoring = createScoringState();
  const modeState = modes === null ? null : createModeState(modes);
  return {
    map,
    materials: materialTableFor(map.tableId),
    rampDrive: tableAccelerationFor(map.tableId),
    devices: tableDevicesFor(map.tableId),
    modes,
    lamps: tableLampsFor(map.tableId),
    options: resolveGameOptions(options),
    plungerConfig: plungerConfigFor(map.tableId),
    nudgeConfig: nudgeConfigFor(map.tableId),
    phase: "attract",
    tick: 0,
    balls: createBallSet(),
    ballsServed: 0,
    banks: [{ scoring, modeState }],
    activePlayer: 0,
    playerCount: 1,
    playersLocked: false,
    endHoldTicks: 0,
    announcingServe: false,
    locks: createLockBank(map.tableId),
    pendingServes: 0,
    multiball: false,
    ballSaveTicks: 0,
    ballSaving: false,
    extraBallServe: false,
    lockEjectStack: [],
    lockEjecting: null,
    pushClamp: null,
    batUnions: null,
    autoLaunchCountdown: 0,
    ballsLocked: 0,
    scoring,
    bonus: null,
    modeState,
    modeMessages: [],
    laneBallId: null,
    serveCountdown: 0,
    troughRecord: CLEARED_TROUGH_RECORD,
    stillTicks: 0,
    searchPulses: BALL_SEARCH_PULSES,
    stillAnchors: [],
    tilt: INITIAL_TILT,
    flippers: createFlipperBank(map.tableId),
    flipperSides: createFlipperApproachSides(),
    camera: INITIAL_CAMERA,
    paused: false,
    forceFullTable: false,
  };
}

/**
 * Starts a fresh game, for `players` players (1..8, default one).
 *
 * The ball set is replaced rather than emptied so ids restart at 0, which makes
 * a debug dump of two games comparable. Nothing is served here: the serve goes
 * through the same countdown the rest of the game uses, so there is exactly one
 * code path that puts a ball in the lane.
 *
 * THE PLAYER COUNT is the original's `$dbc(a5)`, set by the table attract's
 * F1..F8 scan (main.seg00 +0x00446E: Fn = n players, keypad ENTER = one) and
 * adjustable while ball 1 waits on the rod (`setPlayerCount`). The new-game
 * init at +0x004558 clears ALL EIGHT player records whatever the count; here a
 * bank simply does not exist until the count asks for it, which is the same
 * machine because a fresh bank IS the cleared record.
 */
export function startGame(game: Game, players: number = 1): void {
  if (!Number.isInteger(players) || players < 1 || players > MAX_PLAYERS) {
    throw new RangeError(`players must be a whole number from 1 to ${MAX_PLAYERS}: ${players}`);
  }
  game.phase = "in-play";
  game.balls = createBallSet();
  game.ballsServed = 0;
  // A fresh bank rather than a cleared one: the ball set is new, so any id the
  // old bank still held would name a ball that no longer exists.
  game.locks = createLockBank(game.map.tableId);
  game.pendingServes = 0;
  game.multiball = false;
  game.lockEjectStack = [];
  game.lockEjecting = null;
  game.autoLaunchCountdown = 0;
  game.ballsLocked = 0;
  // Fresh per-player banks rather than cleared ones — the machine's own new
  // game clears every player record and every per-player bit (+0x004558's
  // record loop, the hard reset $3EA8 and the game walks $40CA/$4052 clear
  // ALL EIGHT slots at once). The flag bytes that decide whether an award is
  // a first hit or a repeat are per GAME, and a new game must not inherit the
  // last one's; the DONE bits that say which shots a player has already
  // finished are per game the same way. Player 0's bank is built first and
  // aliased by `scoring`/`modeState`, so a one-player game holds exactly the
  // two objects it always held.
  game.playerCount = players;
  game.activePlayer = 0;
  game.playersLocked = false;
  game.endHoldTicks = 0;
  game.announcingServe = false;
  const banks: PlayerBank[] = [];
  for (let index = 0; index < players; index += 1) {
    banks.push({
      scoring: createScoringState(),
      modeState: game.modes === null ? null : createModeState(game.modes),
    });
  }
  game.banks = banks;
  const first = banks[0];
  if (first === undefined) throw new Error("startGame built no player banks");
  game.scoring = first.scoring;
  // Whatever the last game's final ball was still counting out, it is not this
  // game's: the accumulator behind it has just been replaced.
  game.bonus = null;
  game.modeState = first.modeState;
  game.modeMessages = [];
  game.laneBallId = null;
  game.ballSaveTicks = 0;
  game.ballSaving = false;
  game.extraBallServe = false;
  game.serveCountdown = game.options.firstServeDelayTicks;
  game.stillTicks = 0;
  game.searchPulses = BALL_SEARCH_PULSES;
  game.stillAnchors = [];
  game.tilt = resetTiltForNewBall();
  game.flippers = createFlipperBank(game.map.tableId);
  // THE CAMERA IS RESET HERE, AND TO THE TOP OF THE TABLE.
  //
  // Round 5 deleted this line, and it did not need to. What made the filmed
  // serve snap impossible was that `INITIAL_CAMERA.scrollY` was the BOTTOM STOP
  // — the framing the first serve ENDS at — so resetting to it left the window
  // already where it would finish. Round 5 also changed the constant to 0, the
  // top of the playfield, which is what the attract display frames (INDEX.txt
  // 41-43, track10 f54); with that fixed the reset ARMS the snap instead of
  // killing it, and removing it only broke the second game.
  //
  // Measured on one `Game` played twice, which is exactly how `main.ts` drives
  // it: `opened` caches the assembled table and both the start button and
  // `restart()` call `startGame` on that same object. Without this line game 1
  // stepped 47, 42, 38, 34, 31, 28, 25, 22, 20, 18, 16, 15, 8 down to the stop
  // and game 2 stepped nothing at all, opening on the framing the last ball of
  // the previous game died at. With it, game 2's sequence is game 1's exactly.
  game.camera = INITIAL_CAMERA;
  game.paused = false;
}

/** Balls left after the one in play, for the presentation. */
export function ballsRemaining(game: Game): number {
  return Math.max(0, game.options.ballsPerGame * game.playerCount - game.ballsServed);
}

/**
 * 1-based number of the ball in play; 0 before the first serve.
 *
 * The original's `$d84(a5)` advances only when the rotation wraps
 * (+0x005094), so every player plays ball k before anyone plays ball k+1;
 * with charged serves strictly round-robin the same number falls out of the
 * serve count. One player is the identity it always was.
 */
export function ballNumber(game: Game): number {
  if (game.playerCount <= 1) return game.ballsServed;
  if (game.ballsServed === 0) return 0;
  return Math.floor((game.ballsServed - 1) / game.playerCount) + 1;
}

/** Every player's score in player order, read out of the packed-BCD fields. */
export function playerScoresOf(game: Game): number[] {
  if (game.banks.length === 0) return [readBcdField(game.scoring.score)];
  return game.banks.map((bank) => readBcdField(bank.scoring.score));
}

/**
 * True while the player count may still change: the original's `$d7c(a5)`
 * window — a new game until ball 1 leaves the rod. The scan lives in the
 * serve state (+0x004AD6) and the flag dies at the first rotation, so the
 * launch is the effective edge.
 */
export function playerCountAdjustable(game: Game): boolean {
  return game.phase === "in-play" && !game.playersLocked && game.ballsServed <= 1;
}

/**
 * Changes the player count while the first-serve window is open — the
 * original's F1..F8 SETTING `$dbc` outright (+0x004B04) with the same clamp
 * at eight. Growing mints fresh banks (the machine's records were cleared at
 * new game and untouched since, so a fresh bank is the same bytes); shrinking
 * drops the tail. Player 1's bank — the one already in play — is never
 * rebuilt. Answers whether the count changed.
 */
export function setPlayerCount(game: Game, players: number): boolean {
  if (!Number.isInteger(players) || players < 1 || players > MAX_PLAYERS) return false;
  if (!playerCountAdjustable(game)) return false;
  if (players === game.playerCount) return true;
  const banks = game.banks.slice(0, players);
  while (banks.length < players) {
    banks.push({
      scoring: createScoringState(),
      modeState: game.modes === null ? null : createModeState(game.modes),
    });
  }
  game.banks = banks;
  game.playerCount = players;
  return true;
}

function ballRadiusOf(game: Game): Q10 {
  return game.options.simulation.radius ?? DEFAULT_PROBE_RADIUS;
}

function restThresholdOf(game: Game): number {
  return game.options.simulation.restThreshold ?? DEFAULT_SIMULATION_OPTIONS.restThreshold;
}

/**
 * The map-aware push clamp the bats write their positions through. Built once
 * per game and kept, because it expands both level views and the probe ring and
 * this runs on every tick. See `pushClampForMap` for why the flippers need it.
 */
function pushClampFor(game: Game): PushClamp {
  game.pushClamp ??= pushClampForMap(game.map, game.materials, game.options.simulation);
  return game.pushClamp;
}

/**
 * This table's UNION MASKS, built once and kept.
 *
 * The machine ORs the collision plane into every pose of every flipper record
 * while the table is loading (`+0x0039FA`; see `createBatUnionMasks`), so this
 * is the same work at the same moment in the same life-cycle — the first tick
 * that needs a bat rather than the load itself only because this port has no
 * single table-load seam, and the result is identical either way because both
 * inputs are immutable for the life of the table.
 *
 * `levelSolidForMap` is the physics' OWN definition of solid, options and all,
 * so the mask cannot carry a pixel the probe would not have found.
 */
function batUnionsFor(game: Game): BatUnionMasks {
  game.batUnions ??= createBatUnionMasks(
    flipperConfigsFor(game.map.tableId),
    levelSolidForMap(game.map, game.materials, game.options.simulation),
    ballRadiusOf(game),
  );
  return game.batUnions;
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

  // The SIM-SIDE whole-table toggle. Since the Fantasies-parity round no
  // input path reaches this control any more: F9/F10 and pad button 3 are
  // intercepted in `main.ts` and flip the RENDER-LAYER framing instead (see
  // `RenderFraming` below and research/FANTASIES_PARITY_BRIEF.md §2.4). The
  // branch and the `forceFullTable` field both STAY — the field is part of
  // every hashed `debugSnapshot` and removing it would move the pins in
  // `tests/sim-hash-pin.test.ts`, which this round is forbidden to do.
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
    ejected: [],
    ejectedFrom: [],
    levelTransfers: [],
    multiballStarted: false,
    missionStarted: -1,
    missionEnded: false,
    awards: [],
    comboPaid: 0,
    elementStarts: [],
    elementAwards: [],
    messagesShown: [],
    musicCues: [],
    justTilted: false,
    gameOver: false,
    bonus: null,
    flipperRaised: [],
    flipperRested: [],
    displayValues: NO_DISPLAY_VALUES,
  };

  if (game.phase !== "in-play" || game.paused) return idle;

  let gameOver = false;

  // ---- the end-of-ball bonus ---------------------------------------------
  //
  // Before the serve, because the lane stays shut for the whole of it: the
  // original's `$5136` is called from the ball-end state and does not return
  // until its last panel has run out its frames, and only then does the state
  // machine go on to pick the next ball. See `bonus.ts` for the routine.
  //
  // The key argument is `$D00B`, the last key-down byte, which `$51B2` clears
  // once before the table routine and which `$5230` reads to cut a panel short.
  // Every control counts, because the machine's byte is written by the KEYBOARD
  // HANDLER (+0x000850) and not by the game: on film a DEL press — inert during
  // play — dismissed the panel exactly as ENTER and SHIFT did.
  if (game.bonus !== null) {
    stepBonusPhase(game.bonus, anyControlPressed(snapshot));
    if (bonusPhaseFinished(game.bonus)) {
      // `$51DA`: one `ABCD` chain, once, after the display and not during it.
      addPackedBcd(game.scoring.score, game.bonus.total);
      game.bonus = null;
      // With more than one player the machine now holds the "PL n" card 75
      // frames (`$521C`: `cmpi.w #$1,$dbc / beq` skips it for one player)
      // BEFORE the rotation; the rotation itself runs when the hold ends.
      if (game.playerCount > 1) game.endHoldTicks = END_OF_BALL_HOLD_TICKS;
      else gameOver = endBallAfterBonus(game);
    }
  }

  // ---- the multi-player end-of-ball hold ---------------------------------
  //
  // `$5230`, exactly: 75 frames of the outgoing player's "PL n" card, the
  // first 25 unskippable (`move.w #$19,$528A` at +0x005238), any key-down
  // after that cuts it. Zero in every one-player game — the branch never
  // runs, and the ball end is the tick sequence it always was.
  if (game.endHoldTicks > 0 && game.bonus === null) {
    const elapsed = END_OF_BALL_HOLD_TICKS - game.endHoldTicks;
    game.endHoldTicks =
      elapsed >= END_OF_BALL_HOLD_GRACE_TICKS && anyControlPressed(snapshot)
        ? 0
        : game.endHoldTicks - 1;
    if (game.endHoldTicks === 0) gameOver = endBallAfterBonus(game);
  }

  // ---- serve -------------------------------------------------------------
  //
  // One lane, one countdown, and never two balls on the rod: the machine's own
  // debt (`pendingServes`) is paid first, and only when nothing is in play and
  // nothing is owed does the player get charged a ball. Without locks the two
  // conditions collapse into the old `activeBallCount === 0` exactly, because
  // then every active ball is in play and the lane ball is one of them.
  // While tilted the serve queue is WIPED, every tick: the original's state 8
  // runs `clr.w $D86(a5)` each frame, which also cancels any ball-save
  // requeue. Machine-owed balls die with the tilt; the player-owed count is a
  // different counter and survives, exactly as $D7E does.
  if (game.tilt.tilted) game.pendingServes = 0;

  let served = false;
  // `endHoldTicks` shuts the lane exactly as the bonus does: the machine is
  // still inside its ball-end state, and the rotation that would arm the next
  // serve has not happened yet.
  if (game.laneBallId === null && game.bonus === null && game.endHoldTicks === 0) {
    const owed = game.pendingServes > 0;
    // A SAUCER THAT IS ABOUT TO SPIT THE BALL BACK IS NOT AN EMPTY TABLE.
    //
    // The capture handler at +0x00552A leaves the live-ball count `$D7E(a5)`
    // alone, so in the original a held ball is still a ball in play and the
    // machine serves nothing for it. This port cannot read `$D7E` — a held ball
    // is not a FREE ball here — so it tests the popper's own queue instead:
    // while an element is stacked or counting, the ball is coming back and the
    // lane stays shut. Round 5 needed no such test because its `PUSH` went to
    // the trough and paid its own serve; with the decoded in-place eject, and
    // without this, a saucer that swallowed the last ball served a FOURTH ball
    // into a three-ball game.
    //
    // A saucer whose script KEEPS the ball — Law 'n Justice's right crater with
    // its lock lamp lit, BabeWatch's lower bowl on the same branch — stacks
    // nothing, so the countdown below runs out and the player gets another ball
    // to play with. That replacement is the one piece of the round-4 lock
    // reconstruction that survives, and it is charged as a MACHINE serve rather
    // than as one of the player's three.
    const returning = game.lockEjecting !== null || game.lockEjectStack.length > 0;
    if (owed || (freeBallCount(game.balls) === 0 && !returning)) {
      if (game.serveCountdown > 0) {
        game.serveCountdown -= 1;
        // Still run the rest of the tick: the camera has to keep easing and the
        // flippers have to keep falling back to rest while the lane is empty.
      } else {
        // The trough, with the last drain's low bits in it: the ball is placed
        // at the chute mouth on the UPPER line and ROLLS down to the rod, which
        // takes 11 to 75 ticks depending on the entropy. `laneBallId` is set now
        // rather than on arrival because it is the original's $D88 — "the lane is
        // spoken for" — and the machine will not feed a second ball while it is
        // set, whether or not the first has reached the bottom yet.
        const ball = serveBall(game.balls, game.plungerConfig, game.troughRecord);
        game.laneBallId = ball.id;
        if (owed) {
          // A ball the machine owes: a lock's replacement or a multiball ball.
          // It costs the player nothing and it does NOT reset the tilt, because
          // the same ball is still in play and a tilt earned on it still stands.
          game.pendingServes -= 1;
          game.autoLaunchCountdown = AUTO_LAUNCH_DELAY_TICKS;
          if (game.pendingServes > 0) game.serveCountdown = game.options.serveDelayTicks;
        } else if (game.extraBallServe) {
          // THE ORIGINAL'S STATE 7. It is a serve state and not a machine-owed
          // one, so it runs everything the charged serve at state 5 runs EXCEPT
          // the charge and the saver: `+0x004FC0` sets `$d7b`, which is the byte
          // the tilt-meter reset at +0x0054B6 hangs off and which only states 5
          // and 7 ever set, and `+0x004FC4` draws descriptor +$88's PLAYER/BALL
          // card through the same `jsr $6868` state 5 uses at +0x0049BE. It never
          // writes `$d8a`, so there is NO BALL SAVER on an extra ball — the
          // teardown at +0x0050FA zeroed the countdown and nothing here re-arms
          // it. And it does not touch `ballsServed`, because $5070's two
          // decrements were jumped clear over. See `Game.extraBallServe`.
          game.extraBallServe = false;
          game.tilt = resetTiltForNewBall();
          game.ballsLocked = 0;
          game.searchPulses = BALL_SEARCH_PULSES;
          // `bra $50b0` lands two instructions above $3F10, so the ball-start
          // soft reset runs for an extra ball exactly as it does for a fresh
          // one and the group-backed first-hit awards come back. The comment on
          // the charged serve below has the whole argument.
          resetScoringForNewBall(game.scoring, groupBackedFlagIds(game.modes));
          game.announcingServe = true;
        } else if (heldBallCount(game.locks) > 0) {
          // The table is empty only because a saucer is KEEPING the player's
          // ball. Replacing it costs the player nothing — the ball they were
          // given is still on the machine — so the tilt and the per-ball
          // counters stand with it.
          game.autoLaunchCountdown = AUTO_LAUNCH_DELAY_TICKS;
        } else {
          game.ballsServed += 1;
          // THE BALL SAVE IS ARMED HERE AND NOWHERE ELSE. State 5 opens with
          // `move.w $e8e(a5),d0 / mulu.w $50(a5),d0 / move.w d0,$d8a(a5)` at
          // +0x0049AE, and `$d8a` has exactly two writers in the segment: that
          // one and mode-script opcode 11. So it is the CHARGED serve that arms
          // it — a machine-owed serve does not pass through state 5 and neither
          // does the extra-ball state 7, whose own entry at +0x004FC0 sets
          // `$d7b` and leaves `$d8a` as the teardown at +0x0050FA left it,
          // which is zero. An extra ball gets no ball saver.
          game.ballSaveTicks =
            (game.options.ballSaveSeconds ?? ballSaveSecondsFor(game.map.tableId)) *
            TICKS_PER_SECOND;
          game.tilt = resetTiltForNewBall();
          game.ballsLocked = 0;
          game.searchPulses = BALL_SEARCH_PULSES;
          // The hit timers, the zone occupancies, and the flag bytes that live
          // inside a lamp group. The machine's ball-start soft reset $3F10
          // (one caller, +0x0050B6; the EXTRA-BALL arm at +0x005068 sets state
          // 7 and branches to +0x0050B0, two instructions above it, so an
          // extra ball runs the same walk) does a whole-byte `clr.b` on every
          // group-chained lamp — the very bytes the first-hit `bset` at
          // +0x0055F0/+0x00543A tests — so the group-backed ids re-arm their
          // first-hit award EVERY BALL. `game.scoring` is the ACTIVE player's
          // bank, so the re-arm lands on whoever this serve is for; a flag
          // byte outside every group would stay per game, and none of the
          // shipped three have one. research/MULTIPLAYER_DECODE.md §7.
          resetScoringForNewBall(game.scoring, groupBackedFlagIds(game.modes));
          // The charged serve is the original's state 5, whose panel announces
          // the incoming player until the launch takes the ball off the rod.
          game.announcingServe = true;
        }
        served = true;
      }
    }
  }

  // ---- nudge and tilt ----------------------------------------------------
  //
  // The warning counter only warms while a ball is IN PLAY — measured: six
  // shoves at 160 ms with the ball waiting on the plunger rod never tilted
  // the original, and the same cadence with a ball rolling does. The shove
  // itself still happens (the cabinet moves whatever is on it).
  const ballRolling = freeBalls(game.balls).some((ball) => ball.id !== game.laneBallId);
  let nudgeX = 0;
  let nudgeY = 0;
  let justTilted = false;
  for (const [control, direction] of NUDGE_CONTROLS) {
    if (!wasPressed(snapshot, control)) continue;
    // Sequential rather than "first one wins": `nudge` refuses during its own
    // cooldown, so two directions in one tick correctly yield one shove.
    const outcome = nudge(game.tilt, direction, game.nudgeConfig, ballRolling);
    game.tilt = outcome.state;
    nudgeX += outcome.impulseX;
    nudgeY += outcome.impulseY;
    if (outcome.justTilted) justTilted = true;
  }
  game.tilt = tickTilt(game.tilt, game.nudgeConfig);

  // ---- launch ------------------------------------------------------------
  //
  // The original's launcher (main.seg00 0x65EE, run every in-play frame): the
  // RETURN key byte is edge-consumed and fires a FIXED kick at the ball in the
  // lane — no charge, no hold, tap and two-second press frame-identical on
  // film. ENTER is bound to `start`, so during play a `start` press IS the
  // launch edge — one key with both meanings, exactly as the original's
  // RETURN starts from the shell and launches in play. The `plunger` control
  // stays for the gamepad face button and the touch overlay.
  const launchInput = plungerInputFrom(snapshot);
  const launchPressed = launchInput.pressed || wasPressed(snapshot, "start");
  const plunge = tickLauncher(
    { pressed: launchPressed, released: launchInput.released, held: launchInput.held },
    game.plungerConfig,
  );
  let launched = false;
  if (plunge.fired && game.laneBallId !== null) {
    const ball = ballById(game.balls, game.laneBallId);
    // ON THE ROD, not merely owed to it. The original kicks the ball index
    // standing in the rod switch's byte and does nothing at all when that byte
    // is zero (+0x006628, `move.b (a0),d0 / beq`), and since the serve now rolls
    // a ball down the return chute there is a real window in which the lane is
    // spoken for and empty. A press in that window is consumed and wasted,
    // exactly as the original consumes $ED6 before it looks.
    if (ball !== undefined && ballIsOnTheRod(ball) && launchBall(ball, plunge)) {
      // Cleared BEFORE the step, so the pin below does not immediately drag the
      // ball it just fired back down onto the rod.
      game.laneBallId = null;
      game.autoLaunchCountdown = 0;
      launched = true;
      // The launch ends the serve announcement and closes the first-serve
      // player-count window (the state-5 scan never runs again this game).
      game.announcingServe = false;
      game.playersLocked = true;
    }
  }

  // The auto-launcher, for balls the machine served itself: the original sets
  // $D89 on a machine-owed delivery and 0x6628 kicks it the moment it
  // registers in the lane, no key. It is disarmed the moment the lane
  // empties, so a player who shoots first keeps the shot.
  if (game.autoLaunchCountdown > 0) {
    const waiting = game.laneBallId === null ? undefined : ballById(game.balls, game.laneBallId);
    if (waiting === undefined) {
      game.autoLaunchCountdown = 0;
    } else if (ballIsOnTheRod(waiting)) {
      // The clock runs only while the ball is actually on the rod. It used to
      // start at the serve, which was harmless when the serve WAS the rod; now
      // the ball spends up to 75 ticks in the return chute and a countdown
      // started at the serve would expire against an empty lane and silently
      // throw the auto-launch away.
      game.autoLaunchCountdown -= 1;
      if (game.autoLaunchCountdown === 0) {
        if (launchBall(waiting, autoLaunchOutcome(game.plungerConfig))) {
          game.laneBallId = null;
          launched = true;
          game.announcingServe = false;
          game.playersLocked = true;
        }
      }
    }
  }

  // ---- flippers ----------------------------------------------------------
  const live = flippersLive(game.tilt);
  const raisedBefore = raisedSides(game.flippers);
  const flipperInput = flipperInputFrom(
    live && isDown(snapshot, "leftFlipper"),
    live && isDown(snapshot, "rightFlipper"),
    // The third bat rides its own side's button — there is no third button.
    UPPER_FLIPPER_RECORDS[game.map.tableId].role,
  );
  // THE BANK IS NOT SETTLED HERE, and it used to be. A bat's tick is not over
  // until the four collision passes have run, because a ball on the blade slows
  // the blade BETWEEN them — `+0x00AED2` writes the reduced rate back inside the
  // pass and the animation step that follows moves by it. Taking the new bank
  // out of `tickFlipperBank` and storing it before `stepBalls` would store the
  // unloaded answer and let the blade over-travel every loaded tick. The bank is
  // settled by `applyFlipperReactions` after the step, and with it the stroke
  // edges below, which are read off that same settled bank.
  const bankTick = tickFlipperBank(game.flippers, flipperInput);

  // ---- physics -----------------------------------------------------------
  const forces: SimulationForces = {
    gravityY: game.options.gravityY,
    tiltX: game.options.tiltX,
    nudgeX,
    nudgeY,
  };
  /** Which line each in-play ball was on entering the step, for the report. */
  const levelsBefore = new Map<number, PlayfieldLevel>();
  for (const ball of game.balls.balls) {
    if (!ballIsInPlay(ball)) continue;
    levelsBefore.set(ball.id, ball.level);
  }
  // THE BATS GO INTO THE STEP, and they used to come after it.
  //
  // `resolveFlipperContacts` ran here, once, on the position `stepBalls` had
  // already integrated the ball all the way to, and it recovered the four
  // collision passes the machine has by INTERPOLATING the tick's net
  // displacement. The machine's own frame (main.seg00 +0x00A618) has no such
  // seam: `+0x00B278` walks the flipper records at the head of the same
  // collision routine that blits the map, four times a frame, at the position
  // the ball actually stands in. So the resolver is handed to `stepBalls` and
  // called from inside the integrator — which also means an impulse landed at
  // pass 0 is carried by the six substeps after it instead of being spent on
  // the next tick. See `BatPassResolver` and `createFlipperPass`.
  //
  // The side memory is the GAME'S and not the resolver's; the resolver is
  // rebuilt every tick and the memory must not be.
  const bats = createFlipperPass(
    bankTick.sweeps,
    ballRadiusOf(game),
    pushClampFor(game),
    restThresholdOf(game),
    game.flipperSides,
  );
  // The drive is spread in LAST so a caller cannot switch it off through
  // `options.simulation` without noticing they have done it — and it is the
  // game's own, from the registry, not something the options carry.
  const step = stepBalls(game.balls, game.map, game.materials, forces, {
    ...game.options.simulation,
    rampDrive: game.rampDrive,
    surfaces: game.devices,
    // Tilt kills the coils and only the coils: bumpers and slingshots stop
    // kicking (and stop scoring, gated below) but keep their restitution,
    // which is the original's gate at +0x00B216/+0x00B234.
    poweredKicksLive: poweredSurfacesLive(game.tilt),
    bats: bats.resolve,
    // AND THE SAME BATS AGAIN, for the EJECTOR'S RING COUNT and nothing else:
    // inside a pose's box the machine's collision blit is the pose's mask with
    // the map ORed in, so `$c(a4)` at +0x00B6BE counts over `map OR bat`. Built
    // from the same sweeps at the same poses as the resolver above, so the count
    // and the contact cannot disagree about where the blade is. See
    // `BatUnionMask` in `ball-physics.ts` and `research/pocket/POCKET_TRACE.md`.
    batUnion: batUnionMaskFor(bankTick.sweeps, batUnionsFor(game), ballRadiusOf(game)),
  });
  // The step is where the two collision lines exchange balls (zone actions 10
  // and 11 and the surface hand-offs), so a line change across it IS a level
  // transfer. Read immediately, before the popper and the rod pin also assign
  // levels for their own, separately reported reasons.
  const levelTransfers: number[] = [];
  for (const ball of game.balls.balls) {
    const before = levelsBefore.get(ball.id);
    if (before !== undefined && ball.level !== before) levelTransfers.push(ball.id);
  }
  // Every contact the four passes above resolved, in pass order. A ball lying
  // on a rising blade reports one per pass, which is what the machine records:
  // +0x00AED2 writes the reduced bat rate back inside every pass.
  const flipperContacts = bats.contacts;
  // THE BAT'S TICK ENDS HERE. Each sweep has already spent every deduction at
  // the pass that took it, so this reads the end state off rather than
  // computing one — see `applyFlipperReactions`.
  game.flippers = applyFlipperReactions(game.flippers, bankTick.sweeps);
  // Which bats the PLAYER is driving this tick: button down, or the stroke
  // still somewhere other than rest (a raised hold, a rising flip, a spring
  // return). The ball search reads this to tell a cradle from furniture — see
  // the cradled set below for the two measured sites that forced the split.
  const drivenBats = new Set<string>();
  for (const sweep of bankTick.sweeps) {
    if (
      flipperInput.get(sweep.config.id) === true ||
      sweep.from.stroke !== 0 ||
      sweep.from.rate !== 0 ||
      sweep.to.stroke !== 0 ||
      sweep.to.rate !== 0
    ) {
      drivenBats.add(sweep.config.id);
    }
  }
  // The stroke edges, for the report. OBSERVATION ONLY: nothing below reads
  // these back. They are taken from the SETTLED bank, because whether a bat
  // reached its stop this tick is now a question the collision passes can
  // answer differently: a loaded blade turns more slowly and can arrive a tick
  // later than an unloaded one would have.
  const raisedAfter = raisedSides(game.flippers);
  const flipperRaised: FlipperSide[] = [];
  const flipperRested: FlipperSide[] = [];
  for (const side of ["left", "right"] as const) {
    if (raisedAfter[side] && !raisedBefore[side]) flipperRaised.push(side);
    if (!raisedAfter[side] && raisedBefore[side]) flipperRested.push(side);
  }

  // A ball that comes back down the lane lands on the rod — the lane floor IS
  // the plunger rod, which is why the shipped collision layer has no floor
  // under the lane — and may be shot again. The fixed kick makes an
  // under-LAUNCH impossible, but the playfield can still feed a ball back
  // into the lane from above, and without the re-pin it would strand there.
  if (game.laneBallId === null) {
    const returned = ballBackOnTheRod(game);
    if (returned !== null) {
      game.laneBallId = returned.id;
      // During multiball the player's hands are on the bats, so a ball that came
      // back down the lane goes out again on the auto-launcher rather than
      // waiting for a launch press that is not coming. With one ball in play it
      // is the player's shot, exactly as before.
      if (freeBallCount(game.balls) > 1) game.autoLaunchCountdown = AUTO_LAUNCH_DELAY_TICKS;
    }
  }

  // THERE IS NO PIN ANY MORE, and the removal is the point of the serve round.
  //
  // The loop used to write the lane ball back to the seat, at rest, on level 0,
  // after every step. Nothing in the original does that — the only three writes
  // to a ball's position in the whole binary are the trough ($3E36), a saucer's
  // authored eject (+0x0070FC) and the integrator (+0x00B728) — and the pin was
  // here because the serve teleported a ball into a lane the header claimed had
  // no floor under it. It does have one: row 561 is solid from x=310 to the
  // right edge on all three shipped maps, and a ball rolled in off the return
  // chute comes to rest against it on its own (measured over the trough's whole
  // 64-pixel mouth: 256/256 draws settle at y=553, velocity exactly zero, and
  // stay there).
  //
  // The pin also destroyed the thing this round exists to add. Where the ball
  // stops in the lane is a function of how it came down the chute — 9 distinct
  // rest states on Law 'n Justice and BabeWatch, 116 on Extreme Sports, over 256
  // trough draws — and snapping it to one seat pixel with zero velocity threw
  // every one of them away on the tick it arrived.

  // ---- scoring -----------------------------------------------------------
  //
  // After the physics and after the rod is pinned, so the ids scored are the
  // ones the ball really touched this tick and the ball parked on the plunger
  // cannot score the lane it is sitting in. Before the locks, because a lock
  // captures a ball that has already been scored for whatever it rolled over on
  // the way in.
  const awards = runScoring(game, step.surfaces, poweredSurfacesLive(game.tilt));

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

  // ---- the popper --------------------------------------------------------
  //
  // One tick of a saucer's hold timer and, at its end, the authored eject.
  // AFTER `runModes`, because `PUSH` is what queues an element; BEFORE the ball
  // search, so a ball just spat back onto the playfield is never counted still.
  const ejectTick = runLockEjects(game);

  // ---- ball search -------------------------------------------------------
  //
  // A ball a bat is holding up is CONTROLLED, not lost: the player is cradling
  // it, which is a legal and deliberate thing to do for as long as they like,
  // and the original has no ball search at all to disagree (exhaustive read of
  // every in-play state's service bundle — the only involuntary ball removal
  // in the machine is the y>600 drain test). So a ball the flippers touched
  // this tick is exempt from the search exactly as the rod ball is. B2.
  //
  // TOUCHED BY A DRIVEN BAT, not touched by any bat — and the narrowing is
  // measured, not doctrinal. Law 'n Justice's upper bat rests over two map
  // pockets, (24,304) and (41,339) on the main level, and a ball wedged in
  // either one is in mask contact with the RESTING bat on every single tick
  // (verified: 3,000/3,000 ticks in contact at both sites, velocity exactly
  // (0,0)). Under the old "any contact" rule those balls were cradle-exempt
  // forever: the census games that found them ran out their whole 12,000-tick
  // budget with `stillTicks` pinned at 0 and the game unfinishable. A bat
  // sitting at rest with its button up is not holding anything for anyone —
  // it is playfield furniture, and a ball leaning on it is exactly as
  // searchable as a ball leaning on a wall. The cradle the exemption exists
  // for — B2, a ball held ON a bat the player is DRIVING — always has the
  // button down or the stroke off rest, and `drivenBats` is precisely that
  // test. See `runBallSearch` for the second half of the fix (the freeze).
  const cradled = new Set<number>();
  for (const contact of flipperContacts) {
    if (drivenBats.has(contact.flipperId)) cradled.add(contact.ballId);
  }
  const search = runBallSearch(game, cradled);
  const lost = search.lost;

  // ---- the trough ---------------------------------------------------------
  //
  // Every ball this port takes off the table goes through the original's $3E36,
  // and $3E36's whole effect on the machine's future is the four masked fields
  // it leaves behind. Read HERE, before either prune below drops the ball
  // objects, and covering all three ways a ball leaves: the drain (the original
  // calls $3E36 from the y>600 test itself, +0x00B424), a device that swallowed
  // it (+0x005B7C), and this port's own ball-search write-off, which the
  // original has no equivalent of but which puts a ball back in the trough all
  // the same. Last one this tick wins, which for the single-record model below
  // is the only ordering there is.
  const troughed = [...step.drained, ...lost, ...search.swallowed];
  if (troughed.length > 0) {
    const last = troughed[troughed.length - 1] as number;
    const ball = ballById(game.balls, last);
    if (ball !== undefined) game.troughRecord = troughRecordOf(ball);
  }

  // A swallowed ball is inactive but NOT drained: it is back in the trough and
  // the machine owes a serve for it, so it must not reach the end-of-ball path.
  if (search.swallowed.length > 0) pruneInactiveBalls(game.balls);

  // ---- drain -------------------------------------------------------------
  const drained = lost.length === 0 ? step.drained : [...step.drained, ...lost];
  if (drained.length > 0) {
    if (game.laneBallId !== null && drained.includes(game.laneBallId)) {
      game.laneBallId = null;
      game.announcingServe = false;
    }
    pruneInactiveBalls(game.balls);
    // ---- THE BALL SAVE, +0x0052CE and +0x004E4E ---------------------------
    //
    // Two sites, one rule: while `$D8A` is running, a ball that drains comes
    // straight back. The reaper's own site handles the ones that leave another
    // ball on the table —
    //
    //     0052C8  subq.w #$1,$d7e(a5)      live--, and the ball is NOT over
    //     0052CC  beq.b  $52e2             ...unless that was the last one
    //     0052CE  tst.w  $d8a(a5)          BALL SAVE running?
    //     0052D2  beq.b  $52d8
    //     0052D4  addq.w #$1,$d86(a5)      yes -> owe one more serve
    //
    // — and the LAST ball is handled by state 3's own `bmi` road at +0x004E40,
    // which tests the same word at +0x004E4E and, if it is still running,
    // re-queues at +0x004EB4 and goes to STATE 6 instead of ending the ball.
    // Both add one serve per ball, so with the saver armed EVERY drained ball
    // comes back and the only difference between the two is the card.
    //
    // NOTHING HERE RE-ARMS OR CLEARS `$D8A`. One five-second window can give
    // the same ball back four times if the player drains it four times.
    //
    // AND NOT WHILE TILTED. State 8 does not take the +0x004E4E road at all —
    // its `bmi.w $4ec0` at +0x004D68 jumps straight to the real end of ball —
    // and it opens every frame with `clr.w $d86(a5)` at +0x004D4C, which is
    // the line this loop already models at the top of the serve section. The
    // machine's own frame order does let ONE re-served ball out of the lane
    // during a tilt runout, because +0x004B58's serve runs after the reaper and
    // before the next frame's clear; this port serves at the top of the tick
    // and drains at the bottom, so the clear always wins here. A tilt inside an
    // armed save window with two balls out is the only state that can tell the
    // two apart, and this port's answer — no save at all once tilted — is the
    // one the tilt's own `clr.w` is there to produce.
    //
    // AND ONLY FOR A REAL DRAIN. `step.drained` is a ball that went out of the
    // bottom, which is the `cmpi.w #$258,d1 / bgt` at +0x00B29A; `lost` is the
    // ball SEARCH writing one off after it has been wedged for
    // `ballSearchTicks`, which is this port's own deadlock guarantee and not
    // anything the machine does. Giving a written-off ball back would hand it
    // straight into the same wedge with the clock stopped, so the saver takes
    // no notice of one.
    const lastBallGone = freeBallCount(game.balls) === 0 && game.pendingServes === 0;
    if (game.ballSaveTicks > 0 && !game.tilt.tilted && step.drained.length > 0) {
      game.pendingServes += step.drained.length;
      if (lastBallGone) {
        // State 6. The re-serve does NOT pass through state 5, so there is no
        // PLAYER/BALL card, no tilt-meter reset (`clr.w $23f0` at +0x0054B6
        // hangs off `$d7b`, which only states 5 and 7 set) and no charge to
        // `ballsServed`.
        game.ballSaving = true;
        game.serveCountdown = game.options.serveDelayTicks;
      }
    }
    // "Nothing in play and nothing owed", not "no active balls": a held ball is
    // active. See the header — testing the active count here is a silent hang.
    if (freeBallCount(game.balls) === 0 && game.pendingServes === 0) {
      // The ball in play is over, so a ball a saucer is still holding is not in
      // play either: it goes back to the trough. A physical lock that held its
      // ball across the end of a ball would leave the machine one short on the
      // next one, and this reconstruction has no rule saying which tables do that.
      releaseHeldBalls(game.locks, game.balls.balls);
      game.lockEjectStack = [];
      game.lockEjecting = null;
      pruneInactiveBalls(game.balls);
      // The mission goes with the ball. The original refuses to END THE BALL
      // while a mission is running instead (0x4F12-0x4F28 will not advance the
      // game state while `$daa(a5)` is set), which is not reproducible here: the
      // ball is already gone, so nothing could ever advance the script and the
      // machine would hang. See the divergence note in `mode-vm.ts`.
      // THE COMBO COUNT IS READ BEFORE THE COUNTER WALK, because the machine's
      // order is `jsr $5136` (the whole bonus) at +0x00504C and only then
      // `jsr $412C` (the per-ball counter reset) at +0x0050BC. Extreme Sports'
      // combo counter carries neither carry-across bit, so on that table the two
      // orders give different answers; Law 'n Justice's carries bit 3 and does
      // not care. Zero when the table has no live combo counter.
      const combos =
        game.modes !== null && game.modeState !== null ? comboCount(game.modes, game.modeState) : 0;
      if (game.modes !== null && game.modeState !== null) {
        resetModesForNewBall(game.modes, game.modeState);
      }
      game.modeMessages = [];
      game.multiball = false;
      // THE BONUS IS READ BEFORE THE TILT IS CLEARED, because the machine does:
      // `jsr $5136` at +0x00504C tests `$23ED`, and `$5052` clears it only after
      // the call has returned. Reading the flag here and keeping the answer in
      // the phase is the same test one tick earlier, and it leaves the tilt
      // reset exactly where it already was.
      game.bonus = beginBonusPhase(game.scoring, game.tilt.tilted, combos);
      game.tilt = resetTiltForNewBall();
      // A tilted ball forfeits and the machine goes straight on — no multiply,
      // no panel, not even "NO BONUS". Everything else waits for the count.
      // ($5136's tilt branch still lands on the `$521C` hold, so a tilted end
      // in a multi-player game holds the "PL n" card exactly as a paid one.)
      if (game.bonus === null) {
        if (game.playerCount > 1) game.endHoldTicks = END_OF_BALL_HOLD_TICKS;
        else gameOver = endBallAfterBonus(game);
      }
    }
  }

  // Multiball is over when it is back down to one ball, counting the ones still
  // queued for the lane. The original checks exactly this every frame at data
  // 0x5794: `move.w $d86(a5),d0 / add.w $d7e(a5),d0 / cmpi.w #$1,d0 / bhi`.
  //
  // AND THE MISSION GOES WITH IT. The two instructions after that test are
  // `0057A8 clr.b $d7a(a5)` and `0057AC st.b $d9d(a5)` — the multiball flag
  // goes out and the teardown latch goes on, and the mission frame at
  // `+0x0057B6` then diverts the running WAIT to its wind-up branch. Every one
  // of the thirteen multiball missions in the game parks on a WAIT that has no
  // clock, so without this the mission has NO WAY TO END: measured before this
  // landed, Law 'n Justice's script 93 and BabeWatch's 179 sat suspended for
  // every remaining tick of the ball, holding the one mission slot shut.
  // And it counts the SAUCERS too, for the same reason the top-up does: `$d7e`
  // is every ball the machine has out of the trough, held or rolling. A ball
  // re-locked during a multiball does not end that multiball on the original —
  // the saucer will spit it back — and it used to end it here.
  if (game.multiball && freeBallCount(game.balls) + heldBallCount(game.locks) + game.pendingServes <= 1) {
    game.multiball = false;
    if (game.modeState !== null) signalMultiballEnded(game.modeState);
  }

  // ---- the ball save clock, +0x004DEC ------------------------------------
  //
  // `tst.w $d8a(a5) / beq / subq.w #$1,$d8a(a5)`, ONCE per state-3 frame, and
  // its slot in that frame is after the reaper (+0x004DB8) and after the serve
  // (+0x004DC2) — which is why it runs here, at the tail, and why the drain
  // above sees the value the frame started with.
  //
  // STATE 3 ONLY. The tick is not in state 4's ball end, not in state 6's card
  // loop (+0x004F50, which has no `$d8a` instruction at all), not in state 8's
  // tilt runout, and not in the two wind-down loops. So the countdown STOPS
  // while the saved ball is coming back, while the bonus counts, and for the
  // whole of a tilted runout — and this port stops it for exactly those.
  if (
    game.phase === "in-play" &&
    game.bonus === null &&
    game.endHoldTicks === 0 &&
    !game.ballSaving &&
    !game.tilt.tilted &&
    game.ballSaveTicks > 0
  ) {
    game.ballSaveTicks -= 1;
  }
  // State 6 ends at +0x004F98: `tst.w $d7e(a5) / beq` — a ball is out of the
  // trough — then `tst.b $d88(a5) / bne` — and the lane is free again. The
  // second test is what holds the card up until the saved ball has actually
  // been plunged rather than merely served.
  if (game.ballSaving && freeBallCount(game.balls) > 0 && game.laneBallId === null) {
    game.ballSaving = false;
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
    ejected: ejectTick.ejected,
    ejectedFrom: ejectTick.zones,
    levelTransfers,
    multiballStarted: game.multiball && !wasMultiball,
    missionStarted: modeTick.missionStarted,
    missionEnded: modeTick.missionEnded,
    awards,
    comboPaid: modeTick.comboPaid,
    elementStarts: modeTick.elementStarts,
    elementAwards: modeTick.awards.map((award) => award.element),
    messagesShown: modeTick.messagesShown,
    musicCues: modeTick.musicCues,
    justTilted,
    gameOver,
    bonus: bonusViewOf(game),
    flipperRaised,
    flipperRested,
    displayValues: displayValuesOf(game),
  };
}

/**
 * This tick's live figures, for the display records that print one.
 *
 * Sampled AFTER `runModes` has paid the tick's awards, which is where the
 * machine samples them too: the caption and its figure come out of one display
 * record, and the record is posted by the same award that moved the score.
 */
function displayValuesOf(game: Game): DisplayValues {
  const state = game.modeState;
  if (state === null) {
    return { ...NO_DISPLAY_VALUES, score: readBcdField(game.scoring.score) };
  }
  return {
    score: readBcdField(game.scoring.score),
    missionSeconds: missionSecondsLeft(state),
    counterAccumulators: state.counterAccumulators,
    counterSteps: state.counterSteps,
    counterCounts: state.counterCounts,
    rampValues: state.rampValues,
    rampPaid: state.rampPaid,
  };
}

/**
 * True on a tick any control went down: this port's `$D00B`.
 *
 * The original's byte is written by the KEYBOARD HANDLER on every key-down
 * (+0x000850, `btst #7,d0 / bne` throwing away the key-up half), not by the
 * game, so every key the cabinet has counts and not merely the ones in play
 * mean something. Every control here, for the same reason.
 */
function anyControlPressed(snapshot: ControlSnapshot): boolean {
  for (const control of CONTROLS) {
    if (snapshot.controls[control].pressed) return true;
  }
  return false;
}

/**
 * Everything the ball-end chain does once the bonus has been paid — INCLUDING
 * THE PLAYER ROTATION, which is exactly here on the machine too.
 *
 * The order is `$5044`'s: the bonus first (its caller), then the rotation at
 * +0x005070..+0x0050AA — next player, same ball number until the wrap, then
 * `$d82` (balls remaining) down one and `$d84` (ball number) up one — then the
 * incoming player's ball-start walks, then `$427C` clearing that player's
 * accumulator and multiplier unless the holds veto them (+0x0050D4), then
 * hook 2 (+0x005116) re-seeding the incoming player's held multiplier ladder.
 * The game-over test is `$5090`, taken AT THE WRAP and downstream of the bonus
 * — the last ball's bonus is paid before the game ends, which is what the film
 * shows when "NO BONUS" is followed by "GAME OVER" — and its branch to `$5124`
 * skips the walks entirely.
 *
 * ONE PLAYER RUNS THE EXACT SEQUENCE IT ALWAYS DID — the first branch below is
 * the pre-multiplayer body, line for line, because with one bank the rotation
 * is the identity and the pin (`tests/sim-hash-pin.test.ts`) holds by
 * construction rather than by care.
 *
 * Answers whether the game ended.
 */
function endBallAfterBonus(game: Game): boolean {
  // `clr.w $d8a(a5)` at +0x0050FA, in the teardown both the player rotation and
  // the extra-ball state run through. The saver never crosses a ball, so it
  // never needs to be per player.
  game.ballSaveTicks = 0;
  game.ballSaving = false;
  // THE EXTRA-BALL ARM, +0x00505A, taken BEFORE the rotation and on either
  // player count:
  //
  //     00505A  206d 0dc2      movea.l $dc2(a5),a0
  //     00505E  4a28 0010      tst.b   $10(a0)        ; any banked?
  //     005062  670c           beq.s   $5070          ;  no -> rotate the player
  //     005064  5328 0010      subq.b  #1,$10(a0)     ; spend one
  //     005068  3b7c 0007 008e move.w  #$7,$8e(a5)    ; state 7 = SHOOT AGAIN
  //     00506E  6040           bra.s   $50b0          ; ...over $5070 entirely
  //
  // $5070 is where `subq.w #1,$d82` (balls left) and `addq.w #1,$d84` (ball
  // number) live, so an extra ball costs neither. That is why NOTHING here
  // touches `ballsServed`: `ballNumber` and `ballsRemaining` both derive from
  // it, and both are right precisely because they derive from the CHARGED
  // serves, which stay strictly round-robin — an extra ball inserts an
  // uncharged serve for the same player and leaves that sequence alone.
  //
  // The tail is the one-player body below, line for line, because `bra $50b0`
  // lands on exactly the block the rotation falls into: the ball-start walks
  // (already run on this bank at the drain, since no rotation swapped it),
  // $427C's hold settle, and hook 2. What it skips is the game-over test, and
  // it must: a bank spent here is a ball the player has not been given yet.
  if (game.scoring.extraBalls > 0) {
    game.scoring.extraBalls -= 1;
    game.extraBallServe = true;
    game.serveCountdown = game.options.serveDelayTicks;
    clearBonusForNewBall(game.scoring);
    if (game.modes !== null && game.modeState !== null) {
      restoreMultiplierLamps(game.modes, game.modeState, game.scoring.multiplier);
    }
    return false;
  }
  if (game.playerCount <= 1) {
    clearBonusForNewBall(game.scoring);
    // Descriptor HOOK 2, `jsr ([$94,a5],$A4)` at +0x005116, runs on the
    // machine's every ball start AFTER `$427C` has settled the holds: it
    // re-seeds the multiplier ladder's counter to multiplier/2 and relights
    // that many X2..X10 chain lamps for the incoming player. With no hold the
    // multiplier is now zero and the hook's own `beq` makes this a no-op,
    // exactly as here; Extreme Sports' hook is a plain `rts` and its document
    // ships no restore at all.
    if (game.modes !== null && game.modeState !== null) {
      restoreMultiplierLamps(game.modes, game.modeState, game.scoring.multiplier);
    }
    game.serveCountdown = game.options.serveDelayTicks;
    if (game.ballsServed >= game.options.ballsPerGame) {
      game.phase = "game-over";
      return true;
    }
    return false;
  }

  // THE ROTATION. Charged serves are strictly round-robin, so "the wrap" is
  // the serve count reaching a multiple of the player count; the last ball of
  // the game is the wrap that finds every serve spent. The machine's game-over
  // branch (`beq $5124`) runs no walks, so neither does this one — the last
  // player's record keeps its final state for the game-over screens. The
  // serve countdown is armed BEFORE the test exactly as the one-player branch
  // arms it, and that is load-bearing on both: the serve gate runs later in
  // this same tick, and a spent countdown would hand out — and charge — a
  // seventh ball on the game-over tick.
  game.serveCountdown = game.options.serveDelayTicks;
  const next = (game.activePlayer + 1) % game.playerCount;
  if (next === 0 && game.ballsServed >= game.options.ballsPerGame * game.playerCount) {
    game.phase = "game-over";
    return true;
  }
  game.activePlayer = next;
  const bank = game.banks[next];
  if (bank !== undefined) {
    game.scoring = bank.scoring;
    game.modeState = bank.modeState;
  }
  // The incoming player's ball-start walks, the machine's own order
  // (+0x0050B6..+0x005116): the lamp/counter/element walks ($3F10/$412C/$3F80
  // — `resetModesForNewBall` is this port's reading of all three), then $427C
  // on the rotated-in record, then hook 2 reading the SAME record's held
  // multiplier. Running the walk again when this player next rotates OUT (the
  // drain site) is idempotent — every write is set-to-value or keep — and the
  // bank is dormant in between, so the double application cannot be observed.
  if (game.modes !== null && game.modeState !== null) {
    resetModesForNewBall(game.modes, game.modeState);
  }
  game.modeMessages = [];
  clearBonusForNewBall(game.scoring);
  if (game.modes !== null && game.modeState !== null) {
    restoreMultiplierLamps(game.modes, game.modeState, game.scoring.multiplier);
  }
  return false;
}

/** What the panel should be showing this tick, or null when no bonus is up. */
function bonusViewOf(game: Game): BonusView | null {
  const phase = game.bonus;
  if (phase === null || bonusStage(phase) === null) return null;
  return {
    stage: bonusStage(phase) ?? "none",
    caption: bonusCaption(phase),
    // The zero panel is a caption and nothing else: `$2B84` draws "NO BONUS"
    // and never calls the number drawer.
    value: bonusStage(phase) === "none" ? null : bonusValue(phase),
    multiplier: bonusMultiplierCaption(phase),
    multiplierLit: bonusMultiplierLit(phase),
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
 *
 * `poweredLive` is false while TILTED, and it gates exactly what the original
 * gates: the bumper and slingshot awards (their contact latches at +0x00B216
 * and +0x00B234 are skipped on the tilt flag). Zone triggers, targets and
 * every other device KEEP scoring on the way down — measured on film, twice —
 * so filtering more than ids 16..31 here would be less authentic, not more.
 */
/**
 * THE KICKER LAW: a device whose record carries a velocity pair WRITES IT OVER
 * the ball's velocity.
 *
 * Decoded from the device chain's own type table. The chain at main.seg00 body
 * +0x55A0 reads the device's type word and jumps through the table at +0x55C8;
 * type 2 lands at +0x56B0 and is four instructions long:
 *
 *     0056b0  movea.l $2(a0), a2        ; the device's flag object
 *     0056b4  movem.w $dbe(a5), d6-d7   ; the player bit
 *     0056ba  btst.l  d6, $1(a2)        ; ARMED for this player?
 *     0056be  beq.b   $56d2             ;   no -> nothing happens at all
 *     0056c0  movem.w $6(a0), d0-d1     ; the record's two velocity words
 *     0056c6  movem.w d0-d1, $e(a4)     ; -> straight over the ball's vx, vy
 *     0056cc  jsr     $5cac.l
 *
 * `movem.w` to `$e(a4)`, not `add` — the ball leaves at the record's velocity
 * whatever it arrived with. The words are in the original's own velocity units
 * and go through the plain 4x bridge, so BabeWatch's surface 64 (0, -3000)
 * becomes 12,000 Q10 a tick upward: a 549 px ejection, which is the kickback
 * lane's whole length.
 *
 * NOT REPRODUCED, and it is the reason this can only ever be an upper bound: the
 * `btst` gate. Which lamp object arms a kicker, and when, is in the device's
 * `$2(a0)` pointer, and the exporter does not carry it. This port fires the
 * kicker on every touch. On the three shipped tables the only record with a
 * velocity at all is BabeWatch's kickback, whose real gate is presumably its own
 * "kickback lit" lamp, so the visible consequence is a kickback that is always
 * lit rather than one that is sometimes lit.
 */
function applyKickers(
  devices: TableDevices,
  ball: BallState,
  touched: readonly number[],
): void {
  for (const id of touched) {
    if (id < DEVICE_ID_BASE) continue;
    const device = devices.deviceFor(ball.level, id);
    if (device === null) continue;
    if (device.velocityX === 0 && device.velocityY === 0) continue;
    ball.velocityX = originalVelocityToQ10(device.velocityX);
    ball.velocityY = originalVelocityToQ10(device.velocityY);
    return;
  }
}

function runScoring(
  game: Game,
  surfaces: ReadonlyMap<number, readonly number[]>,
  poweredLive: boolean,
): Award[] {
  const devices = game.devices;
  if (devices === null) return [];
  tickScoring(game.scoring);

  const awards: Award[] = [];
  for (const ball of game.balls.balls) {
    if (!ballIsInPlay(ball)) continue;
    if (ball.id === game.laneBallId) continue;
    let touched = surfaces.get(ball.id);
    if (touched === undefined || touched.length === 0) continue;
    if (!poweredLive) {
      touched = touched.filter((id) => !isPoweredSurfaceId(id));
      if (touched.length === 0) continue;
    }
    awards.push(...scoreSurfaces(game.scoring, devices, ball.level, touched));
    applyKickers(devices, ball, touched);
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
      // The device's +$04 "flag byte" is a lamp on the group table, and the
      // same `bset` that picks first-hit from repeat lights it (+0x0055F0);
      // completing a group of them queues the group's event. This is the join
      // that arms the bonus multiplier — see `lampGroups` in table-modes.ts.
      lightGroupLampsForTrigger(modes, state, "device", -1, trigger.id);
      const lower = modes.scriptForDevice(0, trigger.id);
      queueScript(state, lower >= 0 ? lower : modes.scriptForDevice(1, trigger.id));
      continue;
    }
    const level: PlayfieldLevel = trigger.level === 1 ? 1 : 0;
    // A trigger zone's flag byte at object +$0A is the same shape (+0x00543A);
    // BabeWatch's and Extreme Sports' rollover-lane groups light this way.
    if (trigger.kind === "zone") lightGroupLampsForTrigger(modes, state, "zone", level, trigger.id);
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
  // The combo chain's own payment — award effects 16 and 7 paying a counter
  // record's accumulator. SCORE only: their $6BCC adds one BCD field into the
  // player's score, where the element award's $6B96 above pays score and
  // bonus as a pair. See `ModeTickReport.comboPaid`.
  if (report.comboPaid > 0) addToBcdField(game.scoring.score, report.comboPaid);
  // The three player-record award effects the mission machine reports rather
  // than applies, because the record belongs to the scoring layer: effect 5
  // SETS the bonus multiplier to the element's own +$34, effects 2 and 8 arm
  // the one-ball holds `clearBonusForNewBall` tests. See `mode-vm.ts`.
  if (report.bonusMultiplier >= 0) game.scoring.multiplier = report.bonusMultiplier;
  if (report.holdBonus) game.scoring.holdBonus = true;
  if (report.holdMultiplier) game.scoring.holdMultiplier = true;
  // And the FOURTH of them: award effect 1's `addq.b #1,$10(a0)`, the extra
  // ball. `+=` rather than `= true`, because the machine's is an ADD on a byte
  // and banked extra balls stack. `game.scoring` is the ACTIVE player's bank,
  // which is the record `$dc2(a5)` points at, so a shot in a four-player game
  // banks the ball for whoever is shooting. What the loop then does with it is
  // `endBallAfterBonus`; see `EFFECT_EXTRA_BALL` and `Game.extraBallServe`.
  if (report.extraBalls > 0) game.scoring.extraBalls += report.extraBalls;
  // And the fourth: the force-off's `bclr` on an element's start lamp is a
  // `bclr` on a device's or a zone's first-hit flag byte, because on the
  // shipped data they are the same byte. The mission machine names the ids; the
  // scoring layer owns the set. See `clearScoringFlags` and, for the film that
  // caught this, `forceStartLampsOff` in mode-vm.ts.
  clearScoringFlags(game.scoring, report.clearedFlagIds);

  // The banner is the last thing the mission said, and it goes away with the
  // mission: a display left showing "SHOOT ALL TERRORISTS" after the mode has
  // ended is worse than showing nothing.
  if (report.messages.length > 0) game.modeMessages = report.messages;
  if (report.missionEnded) game.modeMessages = [];

  // THE TWO DECODED LOCK RELEASES, AND THEY ARE NOT THE SAME DOOR.
  //
  // `BALL_REMOVE` (opcode $68, +0x005B4E) is the TROUGH: `jsr $c060` unhooks
  // the sprite, `subq.w #$1,$d7e(a5)` takes the ball out of play and
  // `addq.w #$1,$d86(a5)` queues it for the lane. Nothing is owed on top,
  // because the `BALLS_UP_TO` that follows it in every script that uses it
  // counts live and queued balls and the removed ball comes back inside the
  // top-up.
  //
  // `PUSH` (+0x005BFC) is the SAUCER'S OWN MOUTH and it never goes near the
  // trough: it pushes the lock's record onto the element stack at `$23DC(a5)`
  // and the popper at +0x006F72 spits the ball back onto the playfield at the
  // record's authored position and impulse, `holdTicks` frames later. The ball
  // never leaves play, so no serve is owed and no replacement is minted.
  //
  // ROUND 5 RAN `PUSH` THROUGH THE TROUGH, and that closed a limit cycle: an
  // ejected ball reappeared on the plunger rod at a fixed position with a fixed
  // kick, which is a total state reset, and on Extreme Sports it took the same
  // lap back into the same saucer every 742 ticks — 26 locks and 9,325,000
  // points inside 20,000 ticks with ball 1 never ending. The authored eject is
  // now exported (`ZoneEject`), so the ball comes back where the machine puts
  // it and the lap cannot repeat.
  let released = false;
  for (const eject of report.lockEjects) {
    const device = lockForZone(game.locks, eject.level, eject.index);
    if (device === null) continue;
    if (heldBallIn(game.locks, device.id) === null) continue;
    // LIFO, like `move.l a2,-(a0)` against `movea.l (a1)+,a0`.
    if (!game.lockEjectStack.includes(device.id)) game.lockEjectStack.unshift(device.id);
  }
  for (const remove of report.lockRemoves) {
    const device = lockForZone(game.locks, remove.level, remove.index);
    if (device === null) continue;
    if (releaseLock(game.locks, device.id, game.balls.balls) !== null) released = true;
    cancelLockEject(game, device.id);
  }
  if (released) pruneInactiveBalls(game.balls);

  // `BALLS_UP_TO` is the multiball opcode and it is a TOP-UP with a ceiling of
  // three, which is what `oweServes` already implements. Which count each
  // multiball asks for is the script's own word — 2 or 3, per table, decoded.
  //
  // A BALL IN A SAUCER IS STILL A BALL IN PLAY. `$d7e(a5)` is what the top-up
  // counts (`+0x005BD6  move.w $d7e(a5),d0 / add.w $d86(a5),d0`), and the lock
  // capture handler at `+0x00552A..+0x005588` never decrements it: it sets the
  // HELD flag (`ori.b #$80,$1(a4)`), bumps `$23e4` and queues the lock's
  // script, and that is all. The only two decrements in the whole segment are
  // the drain reaper's `+0x0052C8` and `BALL_REMOVE`'s `+0x005B78`.
  //
  // Passing only the ROLLING count here made a two-ball top-up ask for two
  // while a saucer already held one, which is a ball more than the machine
  // would have on the table. BabeWatch reaches it directly: its ladder is
  // driven by a grid CAPTURE, so the ball that starts a `BALLS_UP_TO 2` is
  // sitting in the saucer when it runs, and none of its 2-ball scripts does a
  // `BALL_REMOVE` first. `oweServes`'s trough cap hid it whenever the script
  // asked for the full three and nowhere else.
  if (report.ballsUpTo > 0) {
    const inPlay = freeBallCount(game.balls) + heldBallCount(game.locks);
    oweServes(game, ballsToTopUp(report.ballsUpTo, inPlay, game.pendingServes));
    if (report.ballsUpTo > 1) game.multiball = true;
  }
  // Mode-script opcode 11: a mission arming its own ball save. TWELVE OF THE
  // THIRTEEN MULTIBALL SCRIPTS DO IT the instant `BALLS_UP_TO` runs — 10 s and
  // 30 s on Law 'n Justice, 15 s on BabeWatch and Extreme Sports — and it is a
  // plain `move.w`, so it SETS the countdown rather than adding to it.
  if (report.ballSaveTicks >= 0) game.ballSaveTicks = report.ballSaveTicks;
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
 * A CAPTURE DOES NOT BUY A REPLACEMENT, and round 5's rule that it did is gone.
 * The capture handler at +0x00552A never touches the live-ball count `$D7E(a5)`
 * — a held ball is still a live ball — so the machine owes nothing for it and
 * the trough stays shut. The replacement existed because round 5's `PUSH` sent
 * the ball to the trough instead of out of the saucer, so a saucer that swallowed
 * the last ball could leave the table empty; with the decoded eject the ball is
 * always back inside `ZoneEject.holdTicks` frames and the reconstruction has
 * nothing left to insure against. `endOfBall` still gives a held ball back to the
 * trough, which is the one place a saucer can strand a game.
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

  // A SAUCER THAT EMPTIES THE TABLE RE-ARMS THE SERVE COUNTDOWN.
  //
  // The countdown is normally set by the end-of-ball path, so between balls it
  // sits at zero — and a capture empties the table without a drain. Without
  // this, the serve gate above fires on the very tick the saucer swallowed the
  // last ball, before the saucer's script has had a single frame to run its
  // `PUSH`, and the machine hands out a ball it is about to get back. Arming it
  // gives the script its delay; a saucer that genuinely KEEPS the ball still
  // gets the player a replacement when the countdown runs out.
  if (freeBallCount(game.balls) === 0 && game.laneBallId === null && game.serveCountdown === 0) {
    game.serveCountdown = game.options.serveDelayTicks;
  }
  return { locked, awards };
}

/**
 * Runs the popper: the saucer's hold timer and the authored eject.
 *
 * ONE ELEMENT AT A TIME, because the original's pop service at +0x006F72 only
 * arms a new one when `$23E0(a5)` is clear, and the stack it pops from is LIFO.
 * The hold is 50 or 76 frames, chosen per record — see `ZoneEject`.
 *
 * THE EJECT ITSELF, +0x0070F6..+0x007120: the ball's position becomes the
 * record's authored one (the sub-pixel accumulators are set from it too, which
 * is why this assigns Q10 directly rather than snapping a pixel), its velocity
 * becomes the record's authored impulse, the held flag is cleared and the
 * saucer is freed. Nothing goes near the trough or the serve queue.
 *
 * AND THE EJECT CHOOSES THE LEVEL, which is what its last instruction does:
 * `move.w $e(a0),d1 / jmp ([$712e,pc,d1.w*4])` lands on +0x0053C6 or +0x0053F4,
 * the bodies of the zone list's own to-lower and to-upper handlers. So Law 'n
 * Justice's jail puts its ball on the UPPER ramp at (300,375) — on the main
 * line those coordinates are a funnel a 16 px ball cannot leave, which is how
 * the level word was found — and BabeWatch's upper-deck saucer, which sits on
 * the upper line, delivers to the MAIN one at the same (71,98) its three
 * level-0 sisters use.
 */
function runLockEjects(game: Game): {
  readonly ejected: readonly number[];
  /** The lock zone each eject came out of, parallel to `ejected`. */
  readonly zones: readonly { readonly level: PlayfieldLevel; readonly index: number }[];
} {
  const none = { ejected: [], zones: [] };
  if (game.lockEjecting === null) {
    const next = game.lockEjectStack.shift();
    if (next === undefined) return none;
    const lock = game.locks.locks.find((one) => one.id === next);
    const eject = lock === undefined ? null : ejectFor(game, lock);
    // A saucer whose eject data did not survive (a synthetic devices document,
    // or a lock the exporter has no record for) falls back to the trough rather
    // than holding the ball for ever.
    if (eject === null) {
      if (releaseLock(game.locks, next, game.balls.balls) !== null) {
        oweServes(game, 1);
        pruneInactiveBalls(game.balls);
      }
      return none;
    }
    game.lockEjecting = { deviceId: next, ticksLeft: eject.holdTicks };
    return none;
  }

  game.lockEjecting.ticksLeft -= 1;
  if (game.lockEjecting.ticksLeft > 0) return none;

  const deviceId = game.lockEjecting.deviceId;
  game.lockEjecting = null;
  const ballId = heldBallIn(game.locks, deviceId);
  const lock = game.locks.locks.find((one) => one.id === deviceId);
  if (ballId === null || lock === undefined) return none;
  const eject = ejectFor(game, lock);
  if (eject === null) return none;
  const ball = ballById(game.balls, ballId);
  game.locks.held.delete(deviceId);
  if (ball === undefined) return none;
  ball.heldBy = null;
  ball.x = pixelsToQ10(eject.x);
  ball.y = pixelsToQ10(eject.y);
  ball.velocityX = ejectVelocity(ball.velocityX, eject.velocityX);
  ball.velocityY = ejectVelocity(ball.velocityY, eject.velocityY);
  ball.level = eject.level;
  return { ejected: [ballId], zones: [{ level: lock.level, index: lock.zoneIndex }] };
}

/**
 * One axis of the eject velocity: the authored impulse PLUS the low byte of the
 * held ball's own entry-velocity word.
 *
 * Decoded from the popper, +0x007114..+0x007120:
 *
 *     007114  andi.l  #$ff00ff,$e(a4)     ; keep only the LOW BYTE of each of
 *     00711C  add.w   d0,$e(a4)           ;   the ball's velocity words, then
 *     007120  add.w   d1,$10(a4)          ;   ADD the authored impulse words
 *
 * The capture at +0x00552A never clears the ball's velocity, so those low bytes
 * are the remnant of the capture approach — up to 255 original units (just
 * under a pixel a frame) per axis, always non-negative before the add because a
 * byte is unsigned. The sum is a 68000 `add.w`: it wraps at sixteen bits and
 * the integrator reads the result as signed. This is the original's own eject
 * entropy — the reason its three filmed untouched launches leave the top-lane
 * saucer on different lines — and it was measured live in the reference
 * emulator (ramwatch run C: hold record h4+0x39EA, authored impulse (500,0),
 * ejected ball moving (+2.37,+0.39) px/f, not (+1.95,0)).
 *
 * The recon's Q10 words carry two more fraction bits than the original's
 * velocity units; `>> 2` is the exact bridge back to original units
 * (Q10_PER_ORIGINAL_VELOCITY_UNIT is 4), and the two dropped bits are noise the
 * original could not have held either.
 */
function ejectVelocity(entryQ10: number, impulseUnits: number): number {
  const entryLowByte = (entryQ10 >> 2) & 0xff;
  let word = (impulseUnits + entryLowByte) & 0xffff;
  if (word >= 0x8000) word -= 0x10000;
  return originalVelocityToQ10(word);
}

/** The authored eject of a saucer, from the shipped devices document. */
function ejectFor(game: Game, lock: BallLock): ZoneEject | null {
  return game.devices?.lockEjectFor(lock.level, lock.zoneIndex) ?? null;
}

/** Forgets a queued or in-flight eject, for a saucer emptied another way. */
function cancelLockEject(game: Game, deviceId: string): void {
  const at = game.lockEjectStack.indexOf(deviceId);
  if (at >= 0) game.lockEjectStack.splice(at, 1);
  if (game.lockEjecting?.deviceId === deviceId) game.lockEjecting = null;
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
  const threshold = restThresholdOf(game);

  let lowest: BallState | null = null;
  for (const ball of freeBalls(game.balls)) {
    // The machine's own rod switch — the level-0 zone at (310,540)-(330,560)
    // that every table carries over the lane seat — rather than a hand-drawn box
    // around the serve point. It is the same rectangle the launcher tests, so a
    // ball the loop calls "on the rod" is exactly a ball the launcher will kick.
    if (!ballIsOnTheRod(ball)) continue;
    if (!isAtRest(ball, threshold)) continue;
    if (lowest === null || q10ToPixel(ball.y) > q10ToPixel(lowest.y)) lowest = ball;
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
function runBallSearch(
  game: Game,
  cradled: ReadonlySet<number>,
): { lost: number[]; swallowed: number[] } {
  const none: { lost: number[]; swallowed: number[] } = { lost: [], swallowed: [] };
  // A ball a DRIVEN bat touched this tick is under the player's control — a
  // cradle is motionless on purpose, exactly like the ball on the rod, and the
  // original has no ball search at all, let alone one that confiscates a held
  // ball. It is excluded from the watch list entirely: it neither runs the
  // clock nor takes a coil pulse nor gets written off. Releasing the flipper
  // puts it back on the list the next tick. (Contact with a bat at REST is not
  // in `cradled` at all — see the caller — because the two pockets flanking
  // Law 'n Justice's upper bat kept a wedged ball in permanent rest-bat
  // contact and therefore permanently off this list, and two census games
  // stalled forever on it.)
  const free = freeBalls(game.balls);
  const live = free.filter((ball) => !cradled.has(ball.id));
  // THE FREEZE, and why it is not a reset: while every free ball is in the
  // grip of a driven bat there is nothing to watch, but the stroke itself must
  // not count as "something happened" to a ball it cannot actually move. At
  // (24,304) the census player's blind 17-tick cadence swept the bat through
  // the wedged ball on every beat; each sweep was a contact, each contact
  // emptied the watch list, and under `stillTicks = 0` here the clock could
  // never climb past the cadence (measured: max 5 of the 500 needed). Holding
  // the clock instead — no advance, no reset, anchors untouched — lets the
  // window resume when the bat comes back to rest: if the flip really moved
  // the ball, the box test resets the clock honestly on the next live tick;
  // if it did not, the machine is one beat closer to noticing. A genuine B2
  // cradle freezes here for as long as the button is down and expires never,
  // which is exactly the exemption the cradle is owed.
  if (live.length === 0 && free.length > 0 && game.laneBallId === null) return none;
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
  /**
   * The ball's SPIN — the original's `$26(a4)`, in responder units.
   *
   * Here so a dump says what the contact rule is actually working with; it is
   * NOT hashed by `tests/sim-hash-pin.test.ts`, which projects it out. See that
   * file for why: a spin word differs on the first contact of every game, so
   * hashing it would turn "the first divergent tick" from a statement about
   * behaviour into a statement about bookkeeping.
   */
  readonly spin: number;
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
  /**
   * The masked record the next serve will carry out of the trough — the
   * original's $3E36 entropy. In the snapshot so that the simulation pin covers
   * it: a change that quietly stopped the machine carrying its drains forward
   * would otherwise only show up as a trajectory difference much later.
   */
  readonly troughRecord: TroughRecord;
  /** Balls the machine owes the lane that cost the player nothing. */
  readonly pendingServes: number;
  readonly multiball: boolean;
  /** `$D8A(a5)`: ticks left on the ball save, 0 when none is armed. */
  readonly ballSaveTicks: number;
  /** The original's state 6: a saved last ball is coming back. */
  readonly ballSaving: boolean;
  readonly ballsLocked: number;
  /** Player score, read back out of the packed-BCD field. */
  readonly score: number;
  /** The bonus accumulator, read back out of the packed-BCD field. */
  readonly bonus: number;
  /** The player record's `+$12`: what the end-of-ball bonus is multiplied by. */
  readonly bonusMultiplier: number;
  /**
   * The end-of-ball bonus panel up right now, or null.
   *
   * In the snapshot so the simulation pin covers the phase itself and not only
   * the score it eventually pays: a change that quietly shortened or skipped a
   * panel would otherwise show up as nothing until a serve moved.
   */
  readonly bonusPhase: BonusView | null;
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
  /**
   * MULTI-PLAYER FIELDS, present only when the game holds more than one
   * player. Conditional ON PURPOSE and appended at the end: the one-player
   * snapshot must serialise byte-for-byte as it always did, because
   * `tests/sim-hash-pin.test.ts` hashes the JSON and that pin does not move.
   */
  readonly playerCount?: number;
  readonly activePlayer?: number;
  /** Every player's score in player order, active one included. */
  readonly playerScores?: readonly number[];
  /** Ticks left on the end-of-ball "PL n" hold. */
  readonly endHoldTicks?: number;
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
    troughRecord: game.troughRecord,
    pendingServes: game.pendingServes,
    multiball: game.multiball,
    ballsLocked: game.ballsLocked,
    ballSaveTicks: game.ballSaveTicks,
    ballSaving: game.ballSaving,
    score: readBcdField(game.scoring.score),
    bonus: readBcdField(game.scoring.bonus),
    bonusMultiplier: game.scoring.multiplier,
    bonusPhase: bonusViewOf(game),
    // Built from the bank's declared device order, never from the map's
    // iteration order, so this stays a determinism digest.
    locks: game.locks.locks.flatMap((device) => {
      const ballId = game.locks.held.get(device.id);
      return ballId === undefined ? [] : [{ deviceId: device.id, ballId }];
    }),
    mission: runningMission(game),
    modeMessages: [...game.modeMessages],
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
      spin: ball.spin,
    })),
    flippers: game.flippers.configs.map((config) => ({
      id: config.id,
      stroke: (game.flippers.states.get(config.id) ?? { stroke: 0 }).stroke,
    })),
    // The multi-player tail. Spread so a one-player snapshot has exactly the
    // keys — and therefore exactly the JSON — it had before players arrived.
    ...(game.playerCount > 1
      ? {
          playerCount: game.playerCount,
          activePlayer: game.activePlayer,
          playerScores: playerScoresOf(game),
          endHoldTicks: game.endHoldTicks,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Canvas size for an integer magnification. The window is 336 x 256. */
export function canvasSizeFor(scale: number): { readonly width: number; readonly height: number } {
  return { width: PLAYFIELD_WIDTH * scale, height: VIEWPORT_HEIGHT * scale };
}

/**
 * The PRESENTATION FRAMING — a render-layer choice, never simulation state.
 *
 * "amiga" is the film-verified 336 x 256 scrolling window this port has always
 * drawn: panel strip over the top 16 rows, the measured proportional follower,
 * and the documented multiball whole-table reframe inside the window. It is
 * the machine's own presentation and it stays byte-identical.
 *
 * "full-table" is the Fantasies-parity default: a 336 x 616 canvas — the
 * 16-row panel in its own cabinet band, then all 600 playfield rows at scale
 * 1 with NO camera transform. `game.camera` keeps stepping (it is hashed
 * state, covered by `tests/sim-hash-pin.test.ts`) and is simply not read.
 * `main.ts` owns which framing is live, persists it, and re-fits the canvas
 * on a toggle; the switch is a live cut, no reload — nothing in this
 * renderer is startup-baked.
 */
export type RenderFraming = "full-table" | "amiga";

/** Logical rows of the full-table framing: the cabinet band plus the board. */
export const FULL_TABLE_FRAMING_ROWS = PANEL_STRIP_HEIGHT + PLAYFIELD_HEIGHT;

/** Logical canvas rows for a framing; width is always `PLAYFIELD_WIDTH`. */
export function framingRows(framing: RenderFraming): number {
  return framing === "full-table" ? FULL_TABLE_FRAMING_ROWS : VIEWPORT_HEIGHT;
}

/**
 * Whether there is a ball sitting on the plunger rod.
 *
 * A selector rather than a reach into `Game` from the presentation layer: the
 * on-screen LAUNCH button is shown only while there is something to launch, and
 * that is the one fact it needs.
 */
export function ballInLane(game: Game): boolean {
  return game.laneBallId !== null;
}

/**
 * The bats, as the sprite layer needs to see them.
 *
 * The STROKE decides the POSE: `restPose + ((direction * stroke) >> 6)` off the
 * bat's own disk record, which is the original's `asr.w #$6` at main.seg00
 * +0xBDB8. The PIVOT decides where that pose is blitted, and it is this one —
 * the simulation's. It used to travel only so a bat with no record could put a
 * fallback marker somewhere sensible, while the drawn bat was placed on the pose
 * bank record's pivot instead; the two were two pixels apart on every lower bat.
 * Both now come from the same records, and the picture is hung on whatever the
 * physics is actually colliding with.
 */
function batFrameStates(game: Game): BatFrameState[] {
  const states: BatFrameState[] = [];
  for (const config of game.flippers.configs) {
    const state = game.flippers.states.get(config.id);
    if (state === undefined) continue;
    states.push({
      id: config.id,
      stroke: state.stroke,
      sweep: config.sweep,
      pivotX: config.pivotX,
      pivotY: config.pivotY,
    });
  }
  return states;
}

/**
 * Every ball on the table, INCLUDING the ones sitting in saucers: a locked ball
 * is still a steel ball the player can see, and drawing only the ones in play
 * would make a lock look like a drain.
 */
function ballFrameStates(game: Game): BallFrameState[] {
  return activeBalls(game.balls).map((ball) => ({
    id: ball.id,
    x: ball.x,
    y: ball.y,
    level: ball.level,
  }));
}

/**
 * The status readout under the HUD. `scoreOnPanel` is true when the score
 * panel strip is being drawn: the panel IS the score display then, exactly as
 * it is in the original, so the text line keeps only what the panel does not
 * show — ball count, bonus, plunger charge — instead of printing the same
 * digits twice.
 */
function statusLine(game: Game, scoreOnPanel: boolean): string {
  if (game.phase === "attract") return "PRESS ENTER TO START";
  // The score outlives the ball, so it is on the game-over line too — that is
  // the one moment a player actually wants to read it.
  if (game.phase === "game-over") {
    return `GAME OVER  ${formatBcdField(game.scoring.score)}  -  ENTER FOR A NEW GAME`;
  }
  if (game.paused) return "PAUSED";
  if (game.tilt.tilted) return "TILT";
  const ball = Math.max(1, ballNumber(game));
  // The fixed kick has no charge to meter, so the prompt is the whole of the
  // display. SPACE is the primary launch key since the Fantasies-parity
  // round; the film-verified RETURN still works as an alias.
  const plunger = game.laneBallId === null ? "" : "  SPACE LAUNCHES";
  // While the bonus counts out, the whole line is the bonus: the machine's own
  // display shows nothing else during it, and this one has no ball to describe.
  const view = bonusViewOf(game);
  if (view !== null) {
    const figure = view.value === null ? "" : `  ${view.value.toLocaleString("en-US")}`;
    const lit = view.multiplierLit ? `${view.multiplier}  ` : "";
    return `${lit}${view.caption}${figure}`;
  }
  // Digits straight out of the BCD field: what is displayed is what is stored.
  const bonus = readBcdField(game.scoring.bonus);
  const times = game.scoring.multiplier >= 2 ? ` X${game.scoring.multiplier}` : "";
  const bonusText = bonus === 0 ? "" : `  BONUS ${formatBcdField(game.scoring.bonus)}${times}`;
  const scoreText = scoreOnPanel ? "" : `  ${formatBcdField(game.scoring.score)}`;
  // The active player, named only when there is more than one — a one-player
  // line is the byte-identical line it always was.
  const player = game.playerCount > 1 ? `PLAYER ${game.activePlayer + 1}  ` : "";
  return `${player}BALL ${ball} OF ${game.options.ballsPerGame}${scoreText}${bonusText}${plunger}`;
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
 * One line of a card, as the machine's own print record spells it: the four
 * words `$73D0` reads at +$0..+$6 and the ASCIIZ text behind them. Structurally
 * `panel-renderer.ts`'s `PanelMessageLine`, declared here so the loop and the
 * renderer stay independent — the same twinning as `BonusView`.
 */
export interface PanelCardLine {
  readonly x: number;
  readonly row: number;
  readonly font: number;
  readonly align: number;
  readonly text: string;
}

/**
 * A CARD for the panel strip — the serve announcement, the multi-player
 * end-of-ball card and the ball-save callout, all three `$73D0` display lists
 * on the same 320 x 16 strip (research/MULTIPLAYER_DECODE.md §5). The records
 * are read out of main.seg00 and carried verbatim, geometry and all:
 *
 *   serve (state 5, +0x0049FE..+0x004A5E): 0x4AA2 `0000 0002 0004 0000
 *   "PLAYER  "` — left at x=0, ROW 2, the FIVE-ROW face — or 0x4AB4
 *   `"PLAYERS  "`, the COUNT, while the first-serve adjust window is open
 *   (`$d7c`); 0x4AC6 `"BALL  "` at ROW 8; and the incoming player's score
 *   through `$7198`.
 *
 *   ball end (`$5136`'s tail, +0x0051E6..+0x005216): 0x453C `0000 0002 0001
 *   0000 "PL 0"` — the TWELVE-ROW face, its digit patched in at +0x0051EE —
 *   and the outgoing score through the same six words inlined at +0x005206.
 *   Held 75 frames when more than one player is in the game.
 *
 *   ball save (state 6, +0x004F50..+0x004F8C): 0x4FAC `00A0 0002 0001 0002
 *   "DON'T MOVE"` — CENTRED on x=160, twelve-row face — and NOTHING ELSE. That
 *   state prints its record and returns; it never reaches `$71BA`, so there is
 *   no score on the strip while it is up, which is what film frame 545 of the
 *   full-game capture shows.
 *
 * Plain data, derived from the game by `panelCardOf` and handed to the panel
 * presenter by the renderer, exactly as the bonus view travels.
 */
export interface PanelCard {
  /** The card's print records, in the order the machine draws them. */
  readonly lines: readonly PanelCardLine[];
  /** The score `$7198` prints for this card, or null for a card that has none. */
  readonly score: number | null;
}

/** ROW 2 and ROW 8: the two text rows every card record names. */
const CARD_TOP_ROW = 2;
const CARD_BOTTOM_ROW = 8;
/** FONT 4 is the five-row caption face; FONT 1 the twelve-row one. */
const CARD_CAPTION_FONT = 4;
const CARD_LARGE_FONT = 1;

/**
 * The machine's own `$6DD0`, which is what decides how many spaces a caption
 * really has.
 *
 * It writes the decimal digits RIGHT TO LEFT — `move.b d1,-(a0)` at 0x6E2A,
 * 0x6E38 and 0x6E46 — so the pointer it is handed is ONE PAST the last digit
 * and the digits EAT the record's trailing blanks. `lea $4AB2,a0` is index 8 of
 * `"PLAYER  "`, so a one-digit player number lands on the SECOND space and the
 * strip reads "PLAYER 1", not "PLAYER  1". Film confirms it twice over: on the
 * session-5 still the '1' is at panel x=90 and the '3' of "BALL 3" at x=60,
 * which is one blank advance (8 px) past each caption's last letter and not
 * two. Reproduced by overwriting the record's tail rather than by hard-coding
 * one space, so a two-digit value eats both blanks exactly as the machine's
 * does.
 */
function cardCaption(record: string, value: number): string {
  const digits = String(value);
  return record.slice(0, Math.max(0, record.length - digits.length)) + digits;
}

/** The card the panel should carry this frame, or null for the normal views. */
export function panelCardOf(game: Game): PanelCard | null {
  if (game.phase !== "in-play") return null;
  // STATE 6, +0x004F50: while a saved last ball is coming back the machine
  // clears the text plane and redraws one card every frame, and the card is the
  // display list at +0x004FAC — `00A0 0002 0001 0002` and then the ten bytes
  // "DON'T MOVE". It outranks the score for the same reason the PLAYER/BALL
  // card does: `jsr $6B06` wipes the plane ahead of it every frame.
  if (game.ballSaving) {
    return {
      lines: [{ x: 160, row: CARD_TOP_ROW, font: CARD_LARGE_FONT, align: 2, text: "DON'T MOVE" }],
      score: null,
    };
  }
  if (game.endHoldTicks > 0) {
    return {
      lines: [
        {
          x: 0,
          row: CARD_TOP_ROW,
          font: CARD_LARGE_FONT,
          align: 0,
          text: cardCaption("PL 0", game.activePlayer + 1),
        },
      ],
      score: readBcdField(game.scoring.score),
    };
  }
  if (!game.announcingServe || game.laneBallId === null) return null;
  const adjusting = !game.playersLocked && game.ballsServed <= 1;
  return {
    lines: [
      {
        x: 0,
        row: CARD_TOP_ROW,
        font: CARD_CAPTION_FONT,
        align: 0,
        text: adjusting
          ? cardCaption("PLAYERS  ", game.playerCount)
          : cardCaption("PLAYER  ", game.activePlayer + 1),
      },
      {
        x: 0,
        row: CARD_BOTTOM_ROW,
        font: CARD_CAPTION_FONT,
        align: 0,
        text: cardCaption("BALL  ", Math.max(1, ballNumber(game))),
      },
    ],
    score: readBcdField(game.scoring.score),
  };
}

/**
 * The score panel, as the drawing code sees it.
 *
 * An interface rather than the concrete `PanelDisplay` so this module never
 * imports the panel integrator (which imports this module's report type — the
 * dependency points one way in values even though the types meet). `draw`
 * composes the whole 16-row panel band across the top of a `viewWidth`-wide
 * view and returns whether it did; false — no decoded heap, or the shell font
 * not yet fetched — leaves the caller on the text score exactly as before.
 * `card` is the PLAYER/BALL announcement above, when one is up.
 */
export interface PanelPresenter {
  draw(
    context: CanvasRenderingContext2D,
    score: number,
    scale: number,
    viewWidth: number,
    card?: PanelCard | null,
  ): boolean;
}

/**
 * Draws one frame.
 *
 * Everything is redrawn every frame — there is no dirty-rectangle tracking —
 * because the whole window is 336 x 256 source pixels and a full blit of that
 * costs less than working out what changed.
 *
 * `panel` is the score panel strip, drawn over the top 16 rows of the view the
 * way the original's own display sits the panel above the playfield window (a
 * 320x256 PAL screen: 16 panel lines, then the scrolling playfield). Optional
 * and nullable: every existing caller and test renders identically without
 * one, and a missing shell font merely keeps the text score.
 *
 * `framing` is the presentation framing (`RenderFraming` above). It defaults
 * to "amiga" so every existing caller and test renders byte-for-byte what it
 * always did; `main.ts` passes the live choice. In "full-table" the canvas is
 * 336 x 616: the panel keeps its own 16-row cabinet band at the top (drawn in
 * the same top-of-canvas position it always had — the band is simply no
 * longer over playfield rows), and the board is drawn below it through a
 * canvas translate with the camera unread.
 */
export function renderGame(
  context: CanvasRenderingContext2D,
  game: Game,
  scale: number,
  panel?: PanelPresenter | null,
  framing: RenderFraming = "amiga",
): void {
  const fullTable = framing === "full-table";
  const size = fullTable
    ? { width: PLAYFIELD_WIDTH * scale, height: FULL_TABLE_FRAMING_ROWS * scale }
    : canvasSizeFor(scale);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.imageSmoothingEnabled = false;
  context.fillStyle = SURROUND;
  context.fillRect(0, 0, size.width, size.height);

  // The full-table pass hangs the board under the cabinet band with one
  // translate; the three layers then draw full-source geometry at scale 1
  // (their `fullTable` flag) instead of reading the camera. The transform is
  // reset before the panel so the band's own coordinates never move.
  if (fullTable) context.setTransform(1, 0, 0, 1, 0, PANEL_STRIP_HEIGHT * scale);

  drawPlayfield(context, game.map, game.camera, scale, fullTable);
  // The lamps, straight over the artwork and before anything that sits above
  // the playfield glass: the cached raster stores every insert lit, so this
  // draws the DIM face of each lamp the mission VM is not lighting this frame.
  if (game.lamps !== null) {
    drawLampOverlays(
      context,
      game.map,
      game.camera,
      scale,
      game.lamps,
      game.modeState,
      game.tick,
      fullTable,
      // The ball-save lamp is the ENGINE's, not a mission's: +0x004DEC writes
      // the byte every in-play frame off the countdown, and +0x004E4C puts it
      // out when the last ball goes — which is the whole of the time state 6's
      // card is up. See `ballSaveLampLit`.
      game.ballSaving ? 0 : game.ballSaveTicks,
      // And SHOOT AGAIN is the engine's too, off the banked count on the player
      // record whose ball is up. See `applyShootAgainLamp`.
      game.scoring.extraBalls,
    );
  }
  // The bats and the balls, as decoded SPRITES on the playfield's own pixel
  // grid — one overlay, bats first and balls over them, which is the original's
  // own order at main.seg00 $4B20. Both used to be canvas vector calls at device
  // resolution: wrong shape, wrong colours, and off the 2x2 grid every other
  // pixel on screen sits on. See `src/game/moving-sprites.ts`.
  drawMovingSprites(
    context,
    game.map,
    game.camera,
    scale,
    flipperBats(),
    tableBallFor(game.map.tableId),
    batFrameStates(game),
    ballFrameStates(game),
    fullTable,
  );

  if (fullTable) context.setTransform(1, 0, 0, 1, 0, 0);

  // The score panel strip, above the playfield view. Drawn after the balls so
  // it sits over them the way the original's panel plane does — a ball rolling
  // under the top of the window passes behind the panel, not through it.
  const panelDrawn =
    panel !== undefined && panel !== null &&
    panel.draw(context, currentScore(game), scale, PLAYFIELD_WIDTH, panelCardOf(game));

  // The overlay is drawn at device resolution rather than magnified: scaled-up
  // text at 3x is unreadable mush, and this is instrumentation, not artwork.
  // It drops below the panel band when one is up, so the readouts stay
  // readable rather than printing over the strip.
  const hudTop = panelDrawn ? PANEL_STRIP_HEIGHT * scale + 6 : 6;
  context.imageSmoothingEnabled = true;
  context.font = "12px ui-monospace, 'DejaVu Sans Mono', monospace";
  context.textBaseline = "top";
  context.fillStyle = game.tilt.tilted ? HUD_ALERT : HUD_TEXT;
  context.fillText(statusLine(game, panelDrawn), 6, hudTop);
  const mission = missionLine(game);
  if (mission.length > 0) {
    context.fillStyle = HUD_ALERT;
    context.fillText(mission, 6, hudTop + 16);
  }
}
