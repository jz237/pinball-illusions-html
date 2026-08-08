// THE FLIPPER PROBE — the bat behaviours a player actually complains about.
//
// The two defects this project has been told about by the person playing it are
// both flipper defects: "the ball goes through the flippers when flipping", and
// "if you let the ball roll near the end of the flipper and then flip, the ball
// goes under the flipper instead of shooting up". Neither is visible to a
// census, to the per-frame RAM gate, or to the film gate. Both are visible here.
//
// FIVE scenarios, run against the REAL loop (`createGame` / `runTicks` /
// `ScriptedInput`) with the ball placed by hand and nothing else touched, so
// what is measured is the shipped machine and not a model of it:
//
//   ROLL   ball set down on the resting bat, allowed to roll toward the tip for
//          k ticks, then flipped. The operator's report, parameterised by k.
//   DROP   ball falling onto the bat at speed, flipped as it arrives. The
//          "through the flippers while flipping" report.
//   HOLD   ball placed on the RAISED bat and left there. Cradle, and the place
//          the resting-ball position constraint would show if it were wrong.
//   SEAT   ball laid on the RESTING bat at nine points along the blade and the
//          coil held. THE STALL scenario — see below.
//   GAP    ball dropped straight down the whole width of the bat pair, bats up
//          and bats down. Nothing may end up under a raised bat.
//
// OUTCOMES are read from geometry alone — where the ball is relative to the
// bat's own axis at that tick, and where the bat's own stroke is — so this
// needs no instrumentation hook and survives any refactor of the responder:
//
//   STRUCK        left the bat moving UP, which is what a flipper is for
//   PASSED_UNDER  crossed from the top face to the underside: THE DEFECT
//   STALLED       the BAT stopped moving under the ball: THE OTHER DEFECT
//   CARRIED       still on the blade at the end of the window
//   MISSED        never came within contact range of the bat at all
//
// ---------------------------------------------------------------------------
// WHY STALLED EXISTS, AND WHY THIS PROBE HAD TO GROW IT
// ---------------------------------------------------------------------------
// `+0x00AED2` takes `entry(r) >> 1` out of the bat's rate INSIDE every
// collision pass that finds the ball, and `+0x00BDA8` / `+0x00BE32` put the
// record's own `+$16` acceleration back at every animation step. Where the
// deduction is the larger of the two the coil never gets ahead of the ball and
// the blade stands still — for as long as the button is held. BabeWatch's upper
// bat is the one record on any table whose coil accelerates at TEN, so it is
// pinned by a ball past 24 px out; Extreme Sports' upper accelerates at 15 and
// is pinned past 39 px; a 20-unit bat would need 53 px, which is past the end
// of a 44 px blade.
//
// `a9943e1` shipped the write-back, NAMED that consequence in its own report,
// and shipped anyway — because this probe could not see it. All four of its
// scenarios watched THE BALL, and a ball on a stalled bat sits still, which is
// also what a ball on a healthy cradled bat does; the bat's own stroke was
// never read. That is the eighteenth blind instrument this project has caught,
// and the only reason this note is short is that it was caught before it cost
// anything.
//
// THE RULE: three consecutive ticks with the button held, the ball touching the
// blade, the bat short of its far stop, and the stroke not advancing by one
// unit. Three ticks is 60 ms; a healthy bat advances 120 stroke units on the
// first tick of a press and is at its stop on the fourth.
//
// PROVED RATHER THAN TRUSTED: `FLIPPER_PROBE_SELFTEST=stall` divides every
// bat's coil acceleration down to 2, which pins all nine of them. The scenario
// then reports STALLED on every bat of every table instead of on the two the
// shipped records produce. A gate that would not have caught the bug it was
// extended for is worth nothing.
//
// Usage:
//   npx vite-node scripts/flipper-probe.mts -- [--json=PATH] [--quiet] [tableId ...]

import { readFileSync, writeFileSync } from "node:fs";
import { createGame, debugSnapshot, runTicks, startGame } from "../src/browser/game-loop.js";
import type { Game, InputSource } from "../src/browser/game-loop.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { parseTableMapDocument } from "../src/game/table-map.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import { parseTableAccelDocument, registerTableAcceleration } from "../src/game/table-accel.js";
import { parseTableDevicesDocument, registerTableDevices } from "../src/game/table-devices.js";
import { parseTableModesDocument, registerTableModes } from "../src/game/table-modes.js";
import { parseFlipperBatsDocument, registerFlipperBats } from "../src/game/flipper-bats.js";
import {
  UPPER_FLIPPER_RECORDS,
  batRadiusAt,
  flipperAngle,
  flipperConfigsFor,
} from "../src/game/flippers.js";
import type { FlipperConfig } from "../src/game/flippers.js";
import { BALL_RADIUS_PIXELS, cosineUnits, sineUnits } from "../src/game/collision-probe.js";
import { Q10_ONE, pixelsToQ10, q10Multiply } from "../src/core/fixed-point.js";
import { SUBSTEP_GRAVITY } from "../src/game/ball-physics.js";
import type {
  FlipperBatsDocument,
  TableAccelDocument,
  TableDevicesDocument,
  TableId,
  TableMapDocument,
  TableModesDocument,
} from "../src/game/contracts.js";

function mapFor(tableId: TableId) {
  const batsUrl = new URL(`../public/generated/flipper-bats.json`, import.meta.url);
  registerFlipperBats(
    parseFlipperBatsDocument(JSON.parse(readFileSync(batsUrl, "utf8")) as FlipperBatsDocument),
  );
  const accelUrl = new URL(`../public/generated/tables/${tableId}.accel.json`, import.meta.url);
  registerTableAcceleration(
    parseTableAccelDocument(JSON.parse(readFileSync(accelUrl, "utf8")) as TableAccelDocument),
  );
  const devicesUrl = new URL(`../public/generated/tables/${tableId}.devices.json`, import.meta.url);
  registerTableDevices(
    parseTableDevicesDocument(
      JSON.parse(readFileSync(devicesUrl, "utf8")) as TableDevicesDocument,
    ),
  );
  const modesUrl = new URL(`../public/generated/tables/${tableId}.modes.json`, import.meta.url);
  registerTableModes(
    parseTableModesDocument(JSON.parse(readFileSync(modesUrl, "utf8")) as TableModesDocument),
  );
  const url = new URL(`../public/generated/tables/${tableId}.map.json`, import.meta.url);
  return parseTableMapDocument(JSON.parse(readFileSync(url, "utf8")) as TableMapDocument);
}

class ScriptedInput implements InputSource {
  private sequence = 0;
  private held = new Set<Control>();
  constructor(private readonly plan: (tick: number) => readonly Control[]) {}
  sample(): ControlSnapshot {
    const wanted = new Set(this.plan(this.sequence));
    const previous = this.held;
    this.held = wanted;
    this.sequence += 1;
    const controls = {} as Record<Control, ControlEdges>;
    for (const control of CONTROLS) {
      const down = wanted.has(control);
      const was = previous.has(control);
      controls[control] = {
        down,
        pressed: down && !was,
        released: !down && was,
        pressCount: down && !was ? 1 : 0,
        releaseCount: !down && was ? 1 : 0,
      };
    }
    return { sequence: this.sequence, controls };
  }
}

// ---------------------------------------------------------------------------
// Bat-relative geometry
// ---------------------------------------------------------------------------

/**
 * Where the ball is in the BAT's frame: distance along the blade from the
 * pivot, and signed distance off the blade axis with + on the top face.
 *
 * The normal is chosen as the perpendicular pointing UP the table, which is
 * unambiguous for every bat on all three tables — no lower bat rests within 30
 * degrees of vertical — and means one sign convention serves left bats and
 * right bats alike without a per-bat table to get wrong.
 */
function batAxes(config: FlipperConfig, stroke: number): {
  readonly axisX: number;
  readonly axisY: number;
  readonly normalX: number;
  readonly normalY: number;
} {
  const angle = flipperAngle(config, { stroke, rate: 0 });
  const axisX = cosineUnits(angle);
  const axisY = sineUnits(angle);
  // Of the two perpendiculars, the one pointing UP the table (negative y).
  // `axisX` decides it and never reaches zero: a lower bat's axis runs from 30
  // to -24 degrees on the left and 150 to 204 on the right, so its x component
  // keeps its sign across the whole stroke on every bat of all three tables.
  const up = axisX > 0;
  return {
    axisX,
    axisY,
    normalX: up ? axisY : -axisY,
    normalY: up ? -axisX : axisX,
  };
}

function batFrame(
  config: FlipperConfig,
  stroke: number,
  ballX: number,
  ballY: number,
): { readonly along: number; readonly perp: number } {
  const { axisX, axisY, normalX, normalY } = batAxes(config, stroke);
  const dx = ballX - config.pivotX;
  const dy = ballY - config.pivotY;
  return {
    along: (q10Multiply(dx, axisX) + q10Multiply(dy, axisY)) / Q10_ONE,
    perp: (q10Multiply(dx, normalX) + q10Multiply(dy, normalY)) / Q10_ONE,
  };
}

/**
 * WHERE THE BALL IS RELATIVE TO ONE BLADE, in the three terms the crossing rule
 * needs. ONE definition — `trial` and `probeGap` used to compute their own and
 * they had drifted apart in the band they scored on.
 *
 * `onBlade` is only "inside the blade's span", and that is a STRIP ACROSS THE
 * WHOLE PLAYFIELD, not a neighbourhood of the bat: `along` and `perp` are a
 * rotation of the table's own axes about the pivot, so a ball 200 px down the
 * table can sit inside `along in [2,43]` while being nowhere near the bat. That
 * is precisely the mistake `911bed7` left behind — see `CrossingWatch`.
 *
 * `touching` is the blade's own reach: half-thickness at that `along` plus 9, a
 * ball centre inside it is in contact. `near` adds one whole ball diameter of
 * clearance on top, so a ball outside it is separated from the blade by a gap a
 * ball would fit through and cannot be in the act of passing through it.
 */
interface BladeGeometry {
  readonly along: number;
  readonly perp: number;
  readonly reach: number;
  readonly onBlade: boolean;
  readonly touching: boolean;
  readonly near: boolean;
}

/**
 * Slack beyond the blade's own reach that still counts as NEAR it.
 *
 * Eight px — one ball diameter. The blade's half-thickness runs 8.0 px at the
 * boss to 4.1 at the tip on every bat of all three tables, so `reach` is 17.0
 * down to 13.1 and the near band is 42 to 50 px wide. THE BALL CANNOT JUMP IT:
 * the velocity clamp is 16 px a tick per axis, i.e. 22.6 px of diagonal travel
 * in one tick, so a ball crossing the axis gets at least one sample inside the
 * band however fast it is going. `worstStep` re-measures that bound on every run
 * rather than trusting this paragraph.
 */
const NEAR_BLADE_SLACK = 8;

function bladeGeometry(
  config: FlipperConfig,
  stroke: number,
  ballX: number,
  ballY: number,
): BladeGeometry {
  const { along, perp } = batFrame(config, stroke, ballX, ballY);
  const reach = batRadiusAt(config, pixelsToQ10(Math.max(0, along))) / Q10_ONE + 9;
  // ON THE BLADE means between the boss and the tip. Past the tip is not the
  // blade, and a ball that falls past a raised tip has MISSED, not passed
  // under — the old research harness scored those separately for the same
  // reason. 43 px of the 44 px blade, one pixel clear of the tip cap.
  const onBlade = along >= 2 && along <= 43;
  return {
    along,
    perp,
    reach,
    onBlade,
    touching: onBlade && Math.abs(perp) <= reach + 2,
    near: onBlade && Math.abs(perp) <= reach + NEAR_BLADE_SLACK,
  };
}

/**
 * Ticks the ball may spend away from the blade and still be counted as having
 * gone THROUGH it.
 *
 * Two, i.e. 45 px of travel at the clamp — several times the 8 px the blade is
 * thick, so no honest passage needs more. It exists at all because a ball
 * arriving at 22 px a tick can be above the blade at one sample and below it at
 * the next with nothing in between; without it the rule would refuse the fastest
 * pass-unders, which are the ones that matter.
 */
const CROSSING_GRACE_TICKS = 2;

/**
 * THE CROSSING RULE, and this is the thing this round changed.
 *
 * `911bed7` connected the upper bats' button for the first time and eleven
 * crossings appeared that were called PASSED_UNDER. All eleven — and BOTH of the
 * two lower-bat crossings that had been carried as known residue since the probe
 * was written — turned out to be the same artifact, and the traces are in
 * `research/flipper-power/UPPER_BAT.md` §6:
 *
 *   the bat STRUCK the ball, the ball flew off the table's far side, and 60 to
 *   90 ticks later it fell back into the `along` strip from OUTSIDE — past the
 *   tip, or behind the boss — already below the blade's plane. On Extreme
 *   Sports' upper bat it was 192 to 239 px below the axis, i.e. most of the way
 *   down a 600 px table, with the bat parked at rest.
 *
 * The old rule could not tell that from a pass-under because its "was above"
 * latch was set once, anywhere in the strip, and never cleared. So a ball that
 * was above the blade at the START of the trial satisfied it for ever.
 *
 * THE RULE NOW: the latch is armed only while the ball is NEAR the blade and
 * above it, and it is cleared when the ball has been away from the blade for
 * more than `CROSSING_GRACE_TICKS`. A crossing is the ball appearing below the
 * blade's plane, inside the blade's span, without having left its neighbourhood
 * since it was last above it. That is "through the blade" and nothing else.
 *
 * `plane` keeps the OLD number alongside it — the ball ended below the blade's
 * infinite plane inside the strip — so this tightening stays auditable for ever
 * instead of being a count that silently got smaller. It is NOT a defect and it
 * is not what any outcome is scored on.
 */
class CrossingWatch {
  /** Near the blade AND above it, within the grace window. THE LATCH. */
  private armed = false;
  /** Ticks since the ball was last near this blade. */
  private awayTicks = CROSSING_GRACE_TICKS + 1;
  /** The OLD latch: above it ANYWHERE in the strip, ever. Diagnostic only. */
  private everAbove = false;

  /**
   * One tick. `scoring` is false before the button goes down, so a crossing
   * cannot be attributed to a press that has not happened.
   */
  observe(
    geometry: BladeGeometry,
    scoring: boolean,
  ): { readonly under: boolean; readonly plane: boolean; readonly armed: boolean } {
    if (geometry.near) {
      this.awayTicks = 0;
      if (geometry.perp > BALL_RADIUS_PIXELS) this.armed = true;
    } else {
      this.awayTicks += 1;
      if (this.awayTicks > CROSSING_GRACE_TICKS) this.armed = false;
    }
    if (geometry.onBlade && geometry.perp > BALL_RADIUS_PIXELS) this.everAbove = true;
    // Clearly below, not grazing: a perp of -1 is the ball riding the edge.
    const below = geometry.onBlade && geometry.perp < -(BALL_RADIUS_PIXELS + 2) && scoring;
    return { under: below && this.armed, plane: below && this.everAbove, armed: this.armed };
  }
}

/** A resting place on the bat's top face: `along` px out, just clear of it. */
function seatOn(
  config: FlipperConfig,
  stroke: number,
  alongPx: number,
): { readonly x: number; readonly y: number } {
  const { axisX, axisY, normalX, normalY } = batAxes(config, stroke);
  const alongQ = pixelsToQ10(alongPx);
  const clear = batRadiusAt(config, alongQ) + pixelsToQ10(BALL_RADIUS_PIXELS + 1);
  return {
    x: (config.pivotX + q10Multiply(alongQ, axisX) + q10Multiply(clear, normalX)) | 0,
    y: (config.pivotY + q10Multiply(alongQ, axisY) + q10Multiply(clear, normalY)) | 0,
  };
}

/**
 * The button that strokes a bat, and THE UPPER BAT HAS NO BUTTON OF ITS OWN.
 *
 * This was a table with `upper: "upperFlipper"` in it, and `upperFlipper` is a
 * control the game loop does not read: `flipperInputFrom(left, right, role)`
 * gives the third bat THE SAME BOOLEAN as the lower bat on its own side,
 * because `cmpi.w #0,$A(a0)` at main.seg00 +0xBD6C routes each record to the
 * right-button test or the left one and the machine has no third button.
 *
 * So every upper-bat trial this probe has ever run pressed a key nothing was
 * listening to. That is why `a9943e1` found "all three upper-bat scenarios
 * byte-identical" before and after a change to the bat's own rate rule — the
 * bat never moved in any of them, before or after — and why all three upper
 * cradles have always read `lost 6/6`. THE SCENARIOS WERE NOT INSENSITIVE. THE
 * BUTTON WAS NOT CONNECTED.
 *
 * `UPPER_FLIPPER_RECORDS[table].role` is the same word the game loop routes on,
 * read from the same place, so the two cannot drift: Law 'n Justice's upper bat
 * is bound LEFT, BabeWatch's and Extreme Sports' RIGHT.
 */
function controlFor(tableId: TableId, config: FlipperConfig): Control {
  if (config.id === "lower-left") return "leftFlipper";
  if (config.id === "lower-right") return "rightFlipper";
  return UPPER_FLIPPER_RECORDS[tableId].role === "right" ? "rightFlipper" : "leftFlipper";
}

/**
 * Runs the loop until the serve has actually put a ball on the table.
 *
 * `startGame` only OWES a ball; the trough, the countdown and the chute all
 * take ticks, and a probe that places its ball before the serve has landed is
 * racing the machine — the project has an explicit note about exactly this
 * ("a port probe must let the served ball SETTLE before plunging or it invents
 * a defect"). Sixty ticks is more than twice the longest observed serve.
 *
 * SETTLED IS NOT DEAD STILL, and it never was on the machine. This used to wait
 * for `v === (0, 0)` exactly, which was a statement about the position
 * constraint `78bed65` shipped as a stand-in for the ejector at +0x00B6BE: that
 * constraint refused the into-surface part of every move, so a seated ball
 * stopped and never moved again. With the real ejector the seat BOBS, exactly
 * as the original's does — the machine's own lane ball only ever sits between
 * cy 553.53 and 553.91, and this port's now spans 0.492 px against that 0.38 —
 * and a residual of one collision pass's worth of gravity is what a seated ball
 * has for ever. Waiting for zero waits for something the machine never does.
 *
 * So the bar is the BOB and nothing more: `2 * SUBSTEP_GRAVITY` is the 32 Q10 a
 * ball picks up in the two substeps between one pass and the next, i.e. 1/32 px
 * per tick. A ball still travelling is orders of magnitude above it, and every
 * scenario places its ball by hand afterwards anyway.
 */
/**
 * THE SELF-TEST, and it is a real mutation of the shipped physics.
 *
 * `FLIPPER_PROBE_SELFTEST=stall` drops every bat's coil acceleration to 2 in
 * the bank the game actually runs. Two is under the deduction at EVERY point of
 * every blade — the smallest a 16 px boss contact charges is 5 — so all nine
 * bats are pinned at their rest stop, and a probe that cannot see that cannot
 * see the thing it was extended for either.
 *
 * It is applied to the BANK rather than to `FLIPPER_RECORDS`, which is frozen
 * and is the decode; nothing here can change what the port believes the machine
 * ships. The mutation is asserted to have taken, because a self-test that
 * silently fails to break anything reports a healthy machine and is worse than
 * no self-test at all.
 */
/**
 * THE SECOND MUTATION: `FLIPPER_PROBE_SELFTEST=through` MAKES THE BAT MISS.
 *
 * A crossing rule that has been TIGHTENED has to prove it still catches the
 * thing it is for, and "the count went down" is not that proof. This sets the
 * bank's collision LEVEL to a value no ball ever rides, and
 * `resolveFlipperContacts` skips a bat whose level differs from the ball's
 * (`sweep.config.level !== ball.level`, flippers.ts). The blade still animates —
 * the animation is driven by the button, not by contacts — so every bat sweeps
 * its full 54 degrees straight THROUGH the ball, which is the operator's own
 * report ("the ball goes through the flippers when flipping") in its purest and
 * most extreme form. A rule that cannot see the blade pass through the ball
 * cannot see a blade that half-passes through it either.
 *
 * It is the BANK's config, not `FLIPPER_RECORDS`, and not the `config` the
 * scenarios measure geometry in: the trial places its ball on `config.level`
 * from the decode, and `batFrame` reads the decode's pivot and poses, so the
 * frame the crossing is scored in is untouched and only the contact is gone.
 */
const SELFTEST = process.env["FLIPPER_PROBE_SELFTEST"] ?? "";
const SELFTEST_COIL = 2;
const SELFTEST_LEVEL = 7;

function applySelfTest(game: Game): void {
  if (SELFTEST === "stall") {
    for (const config of game.flippers.configs) {
      (config as { upAcceleration: number }).upAcceleration = SELFTEST_COIL;
      if (config.upAcceleration !== SELFTEST_COIL) {
        throw new Error(
          `FLIPPER_PROBE_SELFTEST=stall could not weaken ${config.id}: the config is frozen, ` +
            `so this run would have reported the SHIPPED coil as if it were the broken one`,
        );
      }
    }
    return;
  }
  if (SELFTEST === "through") {
    for (const config of game.flippers.configs) {
      (config as { level: number }).level = SELFTEST_LEVEL;
      if ((config as { level: number }).level !== SELFTEST_LEVEL) {
        throw new Error(
          `FLIPPER_PROBE_SELFTEST=through could not lift ${config.id} off the ball's ` +
            `collision line: the config is frozen, so this run would have reported the ` +
            `SHIPPED geometry as if the bat had been made to miss`,
        );
      }
    }
    return;
  }
  if (SELFTEST !== "") {
    throw new Error(
      `FLIPPER_PROBE_SELFTEST=${SELFTEST} is not a mutation this probe knows; ` +
        `a typo here silently runs the SHIPPED machine and reports it as a self-test`,
    );
  }
}

/**
 * `runTicks` with the self-test re-applied FIRST, every tick.
 *
 * The bank is not a fixed object: `game.flippers = createFlipperBank(...)`
 * (game-loop.ts:1265) replaces it wholesale every time a ball is served, so a
 * mutation applied once is thrown away the moment a trial drains and re-serves.
 * The first version of this self-test applied it before `startGame` and
 * reported IDENTICAL against the unbroken probe — which reads as "the outcome
 * is insensitive" and means "the break never happened". Re-applying it here
 * costs nine field writes a tick and cannot be outlived by a re-serve.
 */
function step(game: Game, input: InputSource, ticks: number) {
  applySelfTest(game);
  return runTicks(game, input, ticks);
}

function servedGame(tableId: TableId): Game {
  const game = createGame(mapFor(tableId), { ballsPerGame: 3 });
  startGame(game);
  const idle = new ScriptedInput(() => []);
  const seated = 2 * SUBSTEP_GRAVITY;
  for (let tick = 0; tick < 400; tick += 1) {
    step(game, idle, 1);
    const ball = game.balls.balls.find((one) => one.active);
    // Wait for it to be BOTH served and seated, so the starting velocity a
    // scenario asks for is the only velocity of any size it has.
    if (
      ball !== undefined &&
      Math.abs(ball.velocityX) <= seated &&
      Math.abs(ball.velocityY) <= seated &&
      tick > 4
    ) {
      return game;
    }
  }
  throw new Error(`${tableId}: the serve never settled`);
}

/** Puts the game's one ball exactly here, in play, and nowhere else. */
function place(game: Game, x: number, y: number, vx: number, vy: number, level: 0 | 1): void {
  const balls = game.balls.balls;
  if (balls.length === 0) throw new Error("no ball to place: the serve never landed");
  for (let i = 1; i < balls.length; i += 1) balls[i]!.active = false;
  const ball = balls[0]!;
  ball.x = x;
  ball.y = y;
  ball.velocityX = vx;
  ball.velocityY = vy;
  ball.active = true;
  ball.heldBy = null;
  ball.level = level;
}

type Outcome = "STRUCK" | "PASSED_UNDER" | "STALLED" | "CARRIED" | "MISSED" | "DRAINED";

/**
 * The letter each outcome contributes to a summary line.
 *
 * EXPLICIT, because it used to be `key[0]` and STALLED collides with STRUCK on
 * the first character. A tally that silently merges the defect it was added for
 * with the thing that is not a defect is worse than no tally.
 */
const OUTCOME_LETTER: Readonly<Record<Outcome, string>> = {
  STRUCK: "S",
  PASSED_UNDER: "P",
  STALLED: "X",
  CARRIED: "C",
  MISSED: "M",
  DRAINED: "D",
};

/**
 * Consecutive held ticks with the stroke standing still that count as a stall.
 *
 * Three, i.e. 60 ms. A healthy bat advances 120 stroke units on the FIRST tick
 * of a press (its four passes read 0, 20, 40, 60) and is on its far stop by the
 * fourth, so no honest stroke can hold one stroke value for three ticks
 * anywhere short of that stop.
 */
const STALL_TICKS = 3;

/**
 * Largest single-tick ball displacement STARTING FROM INSIDE a blade's near
 * band, px. The bound `CROSSING_GRACE_TICKS` rests on, re-measured every run.
 *
 * The band is 42 px wide at its narrowest and the velocity clamp is 16 px a
 * tick per axis, so the arithmetic says a moving ball cannot jump it. That is
 * not the whole story and this number is why it is measured rather than
 * asserted: a device eject TELEPORTS the ball, and the unrestricted maximum
 * over a whole run is 52.93 px — a scoop firing, not a ball flying. What the
 * rule needs to survive is a jump that starts next to the blade, which is what
 * this measures, and the grace window covers two ticks of it.
 */
let worstNearStep = 0;

interface Trial {
  readonly outcome: Outcome;
  /** `along` when the button went down, px from the pivot. */
  readonly alongAtPress: number;
  /** Highest upward speed the ball reached in the window, Q10 per tick. */
  readonly launchSpeed: number;
  /** Lowest `perp` reached while the bat was raised: negative means underside. */
  readonly minPerp: number;
  /**
   * WHERE THE BAT WAS when the crossing was scored, and how long after the
   * press — 0 stroke is a bat sitting on its rest stop.
   *
   * The operator's defect is a ball going under a bat that is RISING or RAISED;
   * a ball that flew off, came back a second later and fell past a bat parked at
   * rest is a drain. Both used to be counted as one number and the only way to
   * tell them apart was to re-run the trial by hand. -1 when nothing crossed.
   */
  readonly underStroke: number;
  readonly underTicksAfterPress: number;
  /**
   * The OLD rule fired and the new one did not: the ball ended below the
   * blade's infinite plane inside the `along` strip, having come back into it
   * from outside rather than through the blade. NOT A DEFECT — carried so the
   * tightening in `CrossingWatch` stays auditable and cannot quietly become a
   * rule that misses real crossings too.
   */
  readonly underPlaneOnly: boolean;
  /**
   * Longest run of held ticks over which the BAT's stroke did not move while
   * the ball was on it and the bat was short of its far stop.
   *
   * The one number in this file that is about the bat rather than the ball. See
   * the header for why it had to exist.
   */
  readonly stalledTicks: number;
  /** The stroke the bat was pinned at, and how long after the press. -1 if not. */
  readonly stallStroke: number;
  readonly stallTicksAfterPress: number;
  /** Furthest the bat's stroke got while the button was held. */
  readonly strokeReached: number;
  /**
   * The coil acceleration the GAME's own bank ran, not the record's.
   *
   * They are the same object's field until `FLIPPER_PROBE_SELFTEST` weakens the
   * bank, and a stall message that quotes the shipped 20 while the bank ran 2
   * is a message that hides its own break.
   */
  readonly coil: number;
}

/**
 * One tick of a trial, in the classifier's own terms.
 *
 * THE TRACE IS THE TRIAL. `traceTrial` used to re-implement the placement, the
 * press and the loop, which made it a second experiment that could drift from
 * the one whose number it was explaining — and the eleven upper-bat crossings
 * this round had to triage are exactly the case where a trace that is only
 * nearly the trial is worse than none. `trial` now emits its own state and the
 * trace prints it, so a traced tick and a counted tick cannot disagree.
 */
interface TickObservation {
  readonly tick: number;
  /** Ticks since the button went down; negative before the press. */
  readonly sincePress: number;
  readonly held: boolean;
  readonly stroke: number;
  readonly along: number;
  readonly perp: number;
  readonly ballX: number;
  readonly ballY: number;
  readonly velocityX: number;
  readonly velocityY: number;
  /** `along` inside the blade's span: the band the crossing is scored in. */
  readonly onBlade: boolean;
  /** Inside the band AND close enough to the blade to be touching it. */
  readonly nearBlade: boolean;
  /** The above-latch AFTER this tick's update. */
  readonly wasAbove: boolean;
  /** This tick scored the crossing. */
  readonly crossed: boolean;
  readonly drained: boolean;
}

/**
 * Runs one trial: place the ball, wait `settle` ticks, press the bat's button
 * for `hold`, and watch for `window` ticks.
 */
function trial(
  tableId: TableId,
  config: FlipperConfig,
  start: { x: number; y: number; vx: number; vy: number },
  settle: number,
  hold: number,
  windowTicks: number,
  observe?: (observation: TickObservation) => void,
): Trial {
  const game = servedGame(tableId);
  const control = controlFor(tableId, config);
  const input = new ScriptedInput((tick) =>
    tick >= settle && tick < settle + hold ? [control] : [],
  );
  // ON THE BAT'S OWN COLLISION LINE. `resolveFlipperContacts` skips a bat whose
  // level differs from the ball's, and BabeWatch's (205,115) and Extreme Sports'
  // (182,194) upper bats are level-1 bats sitting over level-0 playfield. A
  // probe that put its ball on level 0 watched it fall straight through them and
  // called that a defect; the ball has to be on the line the bat collides on.
  place(game, start.x, start.y, start.vx, start.vy, config.level);

  // NaN, not 0. This was `let alongAtPress = 0`, and `0` is a perfectly good
  // `along`: a trial that drained before tick `settle` never reached the
  // `if (tick === settle)` write, kept the initialiser, and then satisfied
  // `onBladeAtPress = alongAtPress <= 43` — "the ball was on the blade when the
  // button went down" for a trial in which the button never went down at all.
  // NaN fails every comparison, so an unrecorded press cannot be mistaken for a
  // recorded one.
  let alongAtPress = Number.NaN;
  let launchSpeed = 0;
  let minPerp = Number.POSITIVE_INFINITY;
  let touched = false;
  const crossing = new CrossingWatch();
  let passedUnder = false;
  let planeOnly = false;
  let drained = false;
  let underStroke = -1;
  let underTick = -1;
  let previousX = start.x;
  let previousY = start.y;
  let previousNear = false;
  // NaN for the same reason `alongAtPress` is: the first held tick has no
  // previous stroke to be equal to, and `0 === 0` would score it as one.
  let previousStroke = Number.NaN;
  let stallRun = 0;
  let stalledTicks = 0;
  let stallStroke = -1;
  let stallTick = -1;
  let strokeReached = 0;

  for (let tick = 0; tick < settle + windowTicks; tick += 1) {
    const report = step(game, input, 1)[0];
    if ((report?.drained.length ?? 0) > 0) {
      drained = true;
      observe?.({
        tick,
        sincePress: tick - settle,
        held: tick >= settle && tick < settle + hold,
        stroke: -1,
        along: Number.NaN,
        perp: Number.NaN,
        ballX: Number.NaN,
        ballY: Number.NaN,
        velocityX: 0,
        velocityY: 0,
        onBlade: false,
        nearBlade: false,
        wasAbove: false,
        crossed: false,
        drained: true,
      });
      break;
    }
    const state = debugSnapshot(game);
    const ball = state.balls.find((one) => one.active);
    if (ball === undefined) break;
    const stroke = state.flippers.find((one) => one.id === config.id)?.stroke ?? 0;
    const geometry = bladeGeometry(config, stroke, ball.x, ball.y);
    if (tick === settle) alongAtPress = geometry.along;
    // THE BOUND THE CROSSING RULE RESTS ON, re-measured rather than asserted:
    // how far one tick can take a ball that STARTED beside the blade.
    const stepPx = Math.hypot(ball.x - previousX, ball.y - previousY) / Q10_ONE;
    if (previousNear && stepPx > worstNearStep) worstNearStep = stepPx;
    previousNear = geometry.near;
    previousX = ball.x;
    previousY = ball.y;
    if (geometry.touching) touched = true;
    const scored = crossing.observe(geometry, tick >= settle);
    let crossedNow = false;
    if (scored.under && !passedUnder) {
      crossedNow = true;
      underStroke = stroke;
      underTick = tick - settle;
    }
    if (scored.under) passedUnder = true;
    if (scored.plane) planeOnly = true;
    if (geometry.onBlade && tick >= settle) minPerp = Math.min(minPerp, geometry.perp);
    observe?.({
      tick,
      sincePress: tick - settle,
      held: tick >= settle && tick < settle + hold,
      stroke,
      along: geometry.along,
      perp: geometry.perp,
      ballX: ball.x / Q10_ONE,
      ballY: ball.y / Q10_ONE,
      velocityX: ball.velocityX,
      velocityY: ball.velocityY,
      onBlade: geometry.onBlade,
      nearBlade: geometry.near,
      wasAbove: scored.armed,
      crossed: crossedNow,
      drained: false,
    });
    if (ball.velocityY < 0) launchSpeed = Math.max(launchSpeed, -ball.velocityY);

    // ---- THE BAT, not the ball ------------------------------------------
    // A stall needs all four: the button down, the ball actually on the blade,
    // the bat short of its far stop (a bat resting on its stop is a cradle and
    // is supposed to stand still), and the stroke not moving. Anything less
    // scores a healthy cradle as the defect.
    const heldNow = tick >= settle && tick < settle + hold;
    if (heldNow && stroke > strokeReached) strokeReached = stroke;
    if (heldNow && geometry.touching && stroke < config.sweep && stroke === previousStroke) {
      stallRun += 1;
      if (stallRun > stalledTicks) {
        stalledTicks = stallRun;
        if (stalledTicks >= STALL_TICKS && stallStroke < 0) {
          stallStroke = stroke;
          stallTick = tick - settle;
        }
      }
    } else {
      stallRun = 0;
    }
    previousStroke = heldNow ? stroke : Number.NaN;
  }

  let outcome: Outcome;
  // A BALL THAT HAD ALREADY LEFT THE BLADE CANNOT PASS UNDER IT. When the
  // button goes down with the ball past the tip (`along` over the 44 px blade),
  // the flip has simply missed: the bat sweeps up behind a ball that is already
  // falling, and the ball ends below the raised blade because that is where it
  // was. The old research harness scored the same band separately — "ballistic
  // falls past the raised tip (44..52 px)" — and calling it a pass-under would
  // convict the engine of a defect the geometry cannot commit.
  //
  // NaN when the press never happened — the ball was gone before tick `settle` —
  // and `NaN <= 43` is false, so such a trial cannot be scored PASSED_UNDER on a
  // press it never saw. It falls through to DRAINED, which is what it was.
  //
  // STALLED OUTRANKS STRUCK, deliberately. A bat that stood still under the
  // ball for three ticks and then freed itself when the ball slid inboard has
  // stalled, and reporting it as a launch is exactly the averaging that let
  // this class of defect ship once already. It ranks BELOW PASSED_UNDER, which
  // is the operator's own report and stays the headline.
  const onBladeAtPress = alongAtPress <= 43;
  if (passedUnder && onBladeAtPress) outcome = "PASSED_UNDER";
  else if (stalledTicks >= STALL_TICKS) outcome = "STALLED";
  else if (launchSpeed >= 2048) outcome = "STRUCK";
  else if (drained) outcome = "DRAINED";
  else if (!touched) outcome = "MISSED";
  else outcome = "CARRIED";
  return {
    outcome,
    alongAtPress: Number.isFinite(alongAtPress) ? alongAtPress : -1,
    launchSpeed,
    minPerp: Number.isFinite(minPerp) ? minPerp : 0,
    underStroke,
    underTicksAfterPress: underTick,
    underPlaneOnly: planeOnly && !passedUnder && onBladeAtPress,
    stalledTicks,
    stallStroke,
    stallTicksAfterPress: stallTick,
    strokeReached,
    coil:
      game.flippers.configs.find((one) => one.id === config.id)?.upAcceleration ??
      config.upAcceleration,
  };
}

// ---------------------------------------------------------------------------
// The four scenarios
// ---------------------------------------------------------------------------

export interface BatReport {
  readonly table: TableId;
  readonly bat: string;
  readonly roll: Readonly<Record<string, number>>;
  readonly drop: Readonly<Record<string, number>>;
  /** Roll trials whose press found the ball on the OUTER half of the blade. */
  readonly rollOuter: Readonly<Record<string, number>>;
  /** Median launch speed of the struck roll trials, Q10 per tick. */
  readonly rollLaunchMedian: number;
  /** Cradle: `along` after 600 held ticks from each seat, and whether it left. */
  readonly holdEnd: readonly (readonly [number, number, number])[];
  readonly holdLost: number;
  /**
   * SEAT: the stall sweep. A ball laid on the RESTING blade at nine points and
   * the coil held for fourteen ticks — four times what a free stroke needs.
   */
  readonly seat: Readonly<Record<string, number>>;
  /** `[along, furthest stroke reached]` for each of the nine seats. */
  readonly seatStroke: readonly (readonly [number, number])[];
  /** Seats of the nine at which the bat stalled under the ball. */
  readonly seatStalled: number;
  /** The smallest `along` that stalls this bat, or -1 if none does. */
  readonly stallFrom: number;
  /**
   * The coil acceleration the GAME's bank ran during the sweep — the record's,
   * unless `FLIPPER_PROBE_SELFTEST` weakened it. A summary that quotes the
   * shipped 20 while the bank ran 2 is a summary that hides its own break.
   */
  readonly seatCoil: number;
  /**
   * ROLL + DROP trials the OLD crossing rule would have called PASSED_UNDER and
   * the tightened one does not: the ball came back into the `along` strip from
   * outside it, already below the blade's plane. NOT A DEFECT. Printed so the
   * change of rule is a visible number for ever rather than a count that got
   * quietly smaller.
   */
  readonly underPlaneOnly: number;
}

/**
 * The GAP scenario's own report, which is per TABLE and per bats-up/bats-down
 * and not per bat — which is why it never fitted in `BatReport`.
 *
 * IT USED TO BE THREE FIELDS ON `BatReport` HARD-CODED TO ZERO. `gapUnder` was
 * documented as "Gap drops: how many ended under a raised bat" and the literal
 * that reached the `--json` dump was `gapUnder: 0`, on every bat of every table,
 * for ever: `probeGap`'s result was `console.log`ged and then discarded. So the
 * ONE scenario written for the operator's original complaint — "the ball goes
 * through the flippers when flipping" — was the one scenario that could not be
 * diffed before and after a change, which is the only reason the dump exists.
 *
 * `under`, `struck` and `drained` DO NOT PARTITION `trials` between them: a ball
 * that is struck and then drains later in the same 120 ticks counts as `struck`
 * only, and a ball still on the table when the window closes is none of the
 * three. `settled` is that remainder, so the four DO partition and the printed
 * line cannot be read as a breakdown that fails to add up.
 */
export interface GapReport {
  readonly table: TableId;
  readonly raised: boolean;
  readonly trials: number;
  /** Trials that ended UNDER a raised blade, having been over it first. */
  readonly under: number;
  /**
   * Trials the OLD sticky-latch rule counted as `under` and the tightened one
   * does not. Same meaning as `BatReport.underPlaneOnly` and printed for the
   * same reason: so the change of rule is a number and not an absence.
   */
  readonly underPlaneOnly: number;
  readonly struck: number;
  readonly drained: number;
  /** Neither under, struck nor drained: still in play when the window closed. */
  readonly settled: number;
}

const ROLL_SETTLES = [
  0, 4, 8, 12, 16, 20, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60,
  64, 68,
];
const ROLL_SEATS = [8, 12, 16, 20];
const DROP_ALONGS = [10, 16, 22, 28, 34, 40, 44];
const DROP_SPEEDS = [2048, 4096, 8192, 12288, 16384];
const HOLD_SEATS = [10, 16, 22, 28, 34, 40];
const HOLD_TICKS = 600;
/**
 * SEAT: nine points along the blade, and fourteen held ticks at each.
 *
 * The same sweep `research/flipper-power/tools/rig-upper.py` pins a ball at on
 * the original, so the two sides answer the same question at the same places.
 * Fourteen ticks is four times what a free stroke needs (3.5), so a bat that has
 * not left its stop by then is not merely slow.
 */
const SEAT_ALONGS = [12, 16, 20, 24, 28, 32, 36, 40, 44];
const SEAT_HOLD = 14;

function tally(list: readonly Outcome[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const one of list) out[one] = (out[one] ?? 0) + 1;
  return out;
}

function median(list: readonly number[]): number {
  if (list.length === 0) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
}

export function probeBat(tableId: TableId, config: FlipperConfig): BatReport {
  // ---- ROLL: set down on the resting bat, flipped k ticks later ----------
  const roll: Outcome[] = [];
  const rollOuter: Outcome[] = [];
  const rollLaunch: number[] = [];
  let underPlaneOnly = 0;
  for (const seat of ROLL_SEATS) {
    for (const settle of ROLL_SETTLES) {
      const plan = rollTrialSpec(config, seat, settle);
      const result = trial(tableId, config, plan.start, plan.settle, TRACE_HOLD, TRACE_WINDOW);
      // Every pass-under names itself, and names the command that replays it,
      // because a residual count is only useful if the next round can reproduce
      // the residue without transcribing four numbers into a different shape.
      if (result.outcome === "PASSED_UNDER") {
        console.log(
          `    UNDER ${tableId} ${config.id} seat ${seat} settle ${settle} ` +
            `along ${result.alongAtPress.toFixed(2)} minPerp ${result.minPerp.toFixed(2)} ` +
            `at stroke ${result.underStroke}, ${result.underTicksAfterPress} ticks after the press` +
            ` [--trace=${tableId},${config.id},roll,${seat},${settle}]`,
        );
      }
      if (result.underPlaneOnly) underPlaneOnly += 1;
      roll.push(result.outcome);
      if (result.alongAtPress >= 22) rollOuter.push(result.outcome);
      if (result.outcome === "STRUCK") rollLaunch.push(result.launchSpeed);
    }
  }

  // ---- DROP: falling onto the blade, flipped on arrival ------------------
  const drop: Outcome[] = [];
  for (const along of DROP_ALONGS) {
    for (const speed of DROP_SPEEDS) {
      const plan = dropTrialSpec(config, along, speed);
      const result = trial(tableId, config, plan.start, plan.settle, TRACE_HOLD, TRACE_WINDOW);
      // Named for the same reason the ROLL loop names its own: a residual count
      // is only useful if the next round can reproduce the residue.
      if (result.outcome === "PASSED_UNDER") {
        console.log(
          `    UNDER ${tableId} ${config.id} DROP along ${along} speed ${speed} ` +
            `alongAtPress ${result.alongAtPress.toFixed(2)} minPerp ${result.minPerp.toFixed(2)} ` +
            `at stroke ${result.underStroke}, ${result.underTicksAfterPress} ticks after the press` +
            ` [--trace=${tableId},${config.id},drop,${along},${speed}]`,
        );
      }
      if (result.underPlaneOnly) underPlaneOnly += 1;
      drop.push(result.outcome);
    }
  }

  // ---- HOLD: the cradle --------------------------------------------------
  const holdEnd: (readonly [number, number, number])[] = [];
  let holdLost = 0;
  for (const seat of HOLD_SEATS) {
    const game = servedGame(tableId);
    const control = controlFor(tableId, config);
    const input = new ScriptedInput(() => [control]);
    // Raise the bat first, THEN put the ball on the raised face: a ball placed
    // where a rising bat is about to be is a different experiment.
    step(game, input, 8);
    const at = seatOn(game.flippers.configs.find((one) => one.id === config.id) ?? config, 1152, seat);
    place(game, at.x, at.y, 0, 0, config.level);
    let lost = false;
    for (let tick = 0; tick < HOLD_TICKS; tick += 1) {
      const report = step(game, input, 1)[0];
      if ((report?.drained.length ?? 0) > 0) {
        lost = true;
        break;
      }
    }
    const state = debugSnapshot(game);
    const ball = state.balls.find((one) => one.active);
    const stroke = state.flippers.find((one) => one.id === config.id)?.stroke ?? 0;
    if (lost || ball === undefined) {
      holdLost += 1;
      holdEnd.push([seat, -1, -1]);
    } else {
      const frame = batFrame(config, stroke, ball.x, ball.y);
      holdEnd.push([seat, Math.round(frame.along * 10) / 10, Math.round(frame.perp * 10) / 10]);
      if (frame.along > 52 || frame.perp < -2) holdLost += 1;
    }
  }

  // ---- SEAT: the stall sweep --------------------------------------------
  // The ball is laid on the RESTING blade and the coil is held from the first
  // tick, which is the machine capture's own experiment
  // (`tools/rig-upper.py`, `research/flipper-power/UPPER_BAT.md`). What is
  // being asked is not what happens to the ball but whether the BAT moves.
  const seat: Outcome[] = [];
  const seatStroke: (readonly [number, number])[] = [];
  let seatStalled = 0;
  let stallFrom = -1;
  let seatCoil = config.upAcceleration;
  for (const along of SEAT_ALONGS) {
    const at = seatOn(config, 0, along);
    const result = trial(tableId, config, { ...at, vx: 0, vy: 0 }, 0, SEAT_HOLD, SEAT_HOLD + 6);
    seat.push(result.outcome);
    seatStroke.push([along, result.strokeReached]);
    seatCoil = result.coil;
    if (result.outcome === "STALLED") {
      seatStalled += 1;
      if (stallFrom < 0) stallFrom = along;
      console.log(
        `    STALL ${tableId} ${config.id} seat ${along} ` +
          `bat pinned at stroke ${result.stallStroke} of ${config.sweep} for ` +
          `${result.stalledTicks} ticks from ${result.stallTicksAfterPress} after the press ` +
          `(coil ${result.coil})`,
      );
    }
  }

  return {
    table: tableId,
    bat: config.id,
    roll: tally(roll),
    rollOuter: tally(rollOuter),
    drop: tally(drop),
    rollLaunchMedian: median(rollLaunch),
    holdEnd,
    holdLost,
    seat: tally(seat),
    seatStroke,
    seatStalled,
    stallFrom,
    seatCoil,
    underPlaneOnly,
  };
}

/**
 * THE GAP. Balls dropped straight down across the whole width spanned by the
 * two lower bats, with the bats HELD UP, from above the pivot line.
 *
 * A ball may drain — the gap between the raised bats is the drain, and that is
 * the game working. What it may not do is end up UNDER a raised bat, which is
 * the operator's first report ("goes through the flippers when flipping") in
 * its purest form.
 */
function gapPlan(configs: readonly FlipperConfig[]): {
  readonly lower: readonly FlipperConfig[];
  readonly xs: readonly number[];
  readonly dropY: number;
} {
  const lower = configs.filter((one) => one.id !== "upper");
  const left = lower[0]!;
  const right = lower[1]!;
  const minX = Math.min(left.pivotX, right.pivotX) / Q10_ONE - 10;
  const maxX = Math.max(left.pivotX, right.pivotX) / Q10_ONE + 10;
  const pivotY = Math.max(left.pivotY, right.pivotY) / Q10_ONE;
  const xs: number[] = [];
  for (let x = Math.round(minX); x <= Math.round(maxX); x += 2) xs.push(x);
  return { lower, xs, dropY: pivotY - 40 };
}

const GAP_SPEEDS = [4096, 10240, 16384];

/**
 * ONE gap drop. Extracted for the same reason `rollTrialSpec` was: so
 * `--tracegap` replays exactly the trial the count came from and not a second
 * experiment shaped like it.
 */
function gapTrial(
  tableId: TableId,
  lower: readonly FlipperConfig[],
  dropY: number,
  raised: boolean,
  x: number,
  speed: number,
  observe?: (tick: number, id: string, geometry: BladeGeometry, armed: boolean, under: boolean, drained: boolean) => void,
): { under: boolean; plane: boolean; struck: boolean; gone: boolean } {
  const game = servedGame(tableId);
  const input = new ScriptedInput(() => (raised ? ["leftFlipper", "rightFlipper"] : []));
  if (raised) step(game, input, 8);
  place(game, pixelsToQ10(x), pixelsToQ10(dropY), 0, speed, 0);
  let wentUnder = false;
  let wentUnderPlane = false;
  let gone = false;
  let up = false;
  // THE SAME `CrossingWatch` THE TRIALS USE, one per bat. It used to be a
  // `Set` of "was above this bat at some point", which is the sticky latch
  // the trials were carrying too and it convicts a ball that came back into
  // the strip from outside it — see `CrossingWatch`. Two crossing rules in
  // one file is how one of them rots, so there is now one.
  const watches = new Map(lower.map((config) => [config.id, new CrossingWatch()]));
  for (let tick = 0; tick < 120; tick += 1) {
    const report = step(game, input, 1)[0];
    if ((report?.drained.length ?? 0) > 0) {
      gone = true;
      observe?.(tick, "", { along: 0, perp: 0, reach: 0, onBlade: false, touching: false, near: false }, false, false, true);
      break;
    }
    const state = debugSnapshot(game);
    const ball = state.balls.find((one) => one.active);
    if (ball === undefined) break;
    if (ball.velocityY < -2048) up = true;
    for (const config of lower) {
      const stroke = state.flippers.find((one) => one.id === config.id)?.stroke ?? 0;
      const geometry = bladeGeometry(config, stroke, ball.x, ball.y);
      const scored = watches.get(config.id)!.observe(geometry, true);
      observe?.(tick, config.id, geometry, scored.armed, scored.under, false);
      if (scored.under) wentUnder = true;
      if (scored.plane) wentUnderPlane = true;
    }
  }
  return { under: wentUnder, plane: wentUnderPlane, struck: !wentUnder && up, gone };
}

function probeGap(
  tableId: TableId,
  configs: readonly FlipperConfig[],
  raised: boolean,
): GapReport {
  const { lower, xs, dropY } = gapPlan(configs);
  let under = 0;
  let underPlaneOnly = 0;
  let drained = 0;
  let struck = 0;
  let trials = 0;
  for (const x of xs) {
    for (const speed of GAP_SPEEDS) {
      trials += 1;
      const result = gapTrial(tableId, lower, dropY, raised, x, speed);
      if (result.under) under += 1;
      else if (result.struck) struck += 1;
      else if (result.gone) drained += 1;
      if (result.plane && !result.under) {
        underPlaneOnly += 1;
        console.log(
          `    PLANE ${tableId} GAP bats ${raised ? "UP" : "DOWN"} x ${x} speed ${speed}` +
            ` [--tracegap=${tableId},${x},${speed},${raised ? "up" : "down"}]`,
        );
      }
    }
  }
  // The three are ordered tests, not a partition — see `GapReport`. `settled` is
  // what is left over, and it is printed so the line adds up.
  return {
    table: tableId,
    raised,
    under,
    underPlaneOnly,
    drained,
    struck,
    trials,
    settled: trials - under - drained - struck,
  };
}

/**
 * Sets up one ROLL or one DROP trial exactly as `probeBat` does.
 *
 * ONE definition, used by the scenario loops AND by the trace, so the tick a
 * trace prints is the tick the summary counted. It used to be two: `traceTrial`
 * re-derived the seat, the press tick and the window, and could have been
 * explaining a trial next door to the one whose residue it was called on.
 */
function rollTrialSpec(
  config: FlipperConfig,
  seat: number,
  settle: number,
): { start: { x: number; y: number; vx: number; vy: number }; settle: number } {
  const at = seatOn(config, 0, seat);
  return { start: { ...at, vx: 0, vy: 0 }, settle };
}

function dropTrialSpec(
  config: FlipperConfig,
  along: number,
  speed: number,
): { start: { x: number; y: number; vx: number; vy: number }; settle: number } {
  const at = seatOn(config, 0, along);
  // Start a whole fall above the seat so the ball arrives AT the seat with
  // roughly `speed`, and press on the tick it gets there.
  const ticks = 6;
  const rise = (speed * ticks) / Q10_ONE;
  return {
    start: { x: at.x, y: (at.y - pixelsToQ10(Math.round(rise))) | 0, vx: 0, vy: speed },
    settle: ticks,
  };
}

const TRACE_HOLD = 25;
const TRACE_WINDOW = 90;

/**
 * One trial, printed tick by tick in the bat's own frame AND in the
 * classifier's own terms.
 *
 * `--trace=<table>,<bat>,roll,<seat>,<settle>` and
 * `--trace=<table>,<bat>,drop,<along>,<speed>` — the exact strings every `UNDER`
 * line now prints for itself, so a residual count is walkable back to the
 * geometry that made it without a transcription step in between.
 *
 * The `band` column is what the crossing rule sees: `-` off the blade entirely,
 * `.` in the `along` band but out of reach of the face, `o` in contact, `^`
 * above-latched. `<<< UNDER` marks the tick the crossing scores.
 */
function traceTrial(spec: string): void {
  const parts = spec.split(",");
  const [table, bat, scenario, first, second] = parts;
  const tableId = table as TableId;
  const config = flipperConfigsFor(tableId).find((one) => one.id === bat);
  if (config === undefined) throw new Error(`no bat "${bat}" on ${tableId}`);
  if (scenario !== "roll" && scenario !== "drop") {
    throw new Error(
      `--trace needs <table>,<bat>,roll,<seat>,<settle> or <table>,<bat>,drop,<along>,<speed>`,
    );
  }
  const plan =
    scenario === "roll"
      ? rollTrialSpec(config, Number(first), Number(second))
      : dropTrialSpec(config, Number(first), Number(second));
  console.log(
    `trace ${tableId} ${config.id} ${scenario} ${first} ${second} ` +
      `press at tick ${plan.settle}, held ${TRACE_HOLD}, window ${TRACE_WINDOW}`,
  );
  const result = trial(
    tableId,
    config,
    plan.start,
    plan.settle,
    TRACE_HOLD,
    TRACE_WINDOW,
    (o) => {
      if (o.drained) {
        console.log(`t${String(o.tick).padStart(4)} DRAIN`);
        return;
      }
      const band = !o.onBlade ? "-" : o.nearBlade ? (o.wasAbove ? "^" : "o") : o.wasAbove ? "^" : ".";
      console.log(
        `t${String(o.tick).padStart(4)} p${String(o.sincePress).padStart(4)} ` +
          `${o.held ? "HELD" : "    "} stroke ${String(o.stroke).padStart(5)} ` +
          `along ${o.along.toFixed(2).padStart(8)} perp ${o.perp.toFixed(2).padStart(9)} ` +
          `${band}${o.onBlade ? "B" : " "}${o.nearBlade ? "N" : " "}${o.wasAbove ? "A" : " "} ` +
          `xy (${o.ballX.toFixed(2)},${o.ballY.toFixed(2)}) ` +
          `v (${o.velocityX},${o.velocityY})` +
          `${o.crossed ? "  <<< UNDER" : ""}`,
      );
    },
  );
  console.log(
    `RESULT ${result.outcome} alongAtPress ${result.alongAtPress.toFixed(2)} ` +
      `minPerp ${result.minPerp.toFixed(2)} underStroke ${result.underStroke} ` +
      `underTicksAfterPress ${result.underTicksAfterPress} launch ${result.launchSpeed} ` +
      `planeOnly ${result.underPlaneOnly}`,
  );
}

/**
 * One GAP drop, printed tick by tick against BOTH lower bats.
 *
 * `--tracegap=<table>,<x>,<speed>,up|down` — the string every `PLANE` line
 * prints for itself. The GAP scenario is the one written for the operator's
 * original complaint and it was the one scenario with no way to look at a
 * single trial; a rule change that moved its count could not be checked.
 */
function traceGap(spec: string): void {
  const [table, x, speed, raised] = spec.split(",");
  const tableId = table as TableId;
  const configs = flipperConfigsFor(tableId);
  const { lower, dropY } = gapPlan(configs);
  const up = raised !== "down";
  console.log(
    `tracegap ${tableId} x ${x} speed ${speed} bats ${up ? "UP" : "DOWN"} ` +
      `dropped from y ${dropY}`,
  );
  const result = gapTrial(
    tableId,
    lower,
    dropY,
    up,
    Number(x),
    Number(speed),
    (tick, id, geometry, armed, under, drained) => {
      if (drained) {
        console.log(`t${String(tick).padStart(4)} DRAIN`);
        return;
      }
      const band = !geometry.onBlade ? "-" : geometry.near ? "o" : ".";
      console.log(
        `t${String(tick).padStart(4)} ${id.padEnd(12)} ` +
          `along ${geometry.along.toFixed(2).padStart(8)} perp ${geometry.perp.toFixed(2).padStart(9)} ` +
          `${band}${geometry.onBlade ? "B" : " "}${geometry.near ? "N" : " "}${armed ? "A" : " "}` +
          `${under ? "  <<< UNDER" : ""}`,
      );
    },
  );
  console.log(
    `RESULT under ${result.under} plane ${result.plane} struck ${result.struck} ` +
      `drained ${result.gone}`,
  );
}

function main(argv: readonly string[]): number {
  const traceArg = argv.find((arg) => arg.startsWith("--trace="));
  if (traceArg !== undefined) {
    traceTrial(traceArg.slice(8));
    return 0;
  }
  const gapArg = argv.find((arg) => arg.startsWith("--tracegap="));
  if (gapArg !== undefined) {
    traceGap(gapArg.slice(11));
    return 0;
  }
  const wanted = argv.filter((arg) => !arg.startsWith("-"));
  const tables = wanted.length > 0 ? (wanted as TableId[]) : [...TABLE_IDS];
  const jsonArg = argv.find((arg) => arg.startsWith("--json="));
  const reports: BatReport[] = [];
  const gaps: GapReport[] = [];
  for (const tableId of tables) {
    const configs = flipperConfigsFor(tableId);
    for (const config of configs) {
      const report = probeBat(tableId, config);
      reports.push(report);
      // `OUTCOME_LETTER`, not `key[0]`: STALLED and STRUCK both begin with S,
      // and a tally that merged them would hide the outcome it was added for.
      const show = (label: string, counts: Record<string, number>): string =>
        `${label} ${Object.entries(counts)
          .map(([key, value]) => `${OUTCOME_LETTER[key as Outcome] ?? key[0]}${value}`)
          .join(" ")}`;
      console.log(
        `${tableId.padStart(15)} ${config.id.padEnd(12)} ` +
          `${show("roll", report.roll)} | ${show("outer", report.rollOuter)} | ` +
          `${show("drop", report.drop)} | launch ${report.rollLaunchMedian} | ` +
          `cradle lost ${report.holdLost}/${report.holdEnd.length} ` +
          `[${report.holdEnd.map(([seat, along]) => `${seat}->${along}`).join(" ")}]`,
      );
      console.log(
        `${" ".repeat(15)} ${config.id.padEnd(12)} ` +
          `${show("seat", report.seat)} | STALLED ${report.seatStalled}/${SEAT_ALONGS.length}` +
          `${report.stallFrom < 0 ? "" : ` from ${report.stallFrom} px`} | ` +
          `coil ${report.seatCoil} | stroke of ${config.sweep} ` +
          `[${report.seatStroke.map(([along, stroke]) => `${along}->${stroke}`).join(" ")}]` +
          ` | plane-only ${report.underPlaneOnly}`,
      );
    }
    for (const raised of [true, false]) {
      const gap = probeGap(tableId, configs, raised);
      gaps.push(gap);
      console.log(
        `${tableId.padStart(15)} GAP bats ${raised ? "UP  " : "DOWN"}  trials ${gap.trials}  ` +
          `UNDER ${gap.under}  struck ${gap.struck}  drained ${gap.drained}  ` +
          `settled ${gap.settled}  plane-only ${gap.underPlaneOnly}`,
      );
    }
  }
  // THE BOUND THE CROSSING RULE RESTS ON, measured by the run that used it: how
  // far one tick can carry a ball that started beside a blade. The near band is
  // 42 px wide at its narrowest and the grace window is two ticks of it.
  console.log(
    `  worst single-tick step from inside the near band ${worstNearStep.toFixed(2)} px ` +
      `over every ROLL/DROP/SEAT trial ` +
      `(band >= ${2 * (4 + 9 + NEAR_BLADE_SLACK)} px wide, grace ${CROSSING_GRACE_TICKS} ticks)`,
  );
  if (jsonArg !== undefined) {
    // `{ bats, gap }`, not the bare array it used to be. `probe-tally.mjs` reads
    // either shape, so old dumps still tally; what changes is that the GAP
    // scenario now reaches the file at all instead of being printed and thrown
    // away with three zeroes left behind in its place.
    writeFileSync(jsonArg.slice(7), JSON.stringify({ bats: reports, gap: gaps }), "utf8");
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
