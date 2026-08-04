/**
 * THE OPERATOR'S DEFECT, REPRODUCED AND PINNED.
 *
 * The person playing this reconstruction has reported the same thing twice:
 * "if you let the ball roll near the end of the flipper and then flip, the ball
 * goes under the flipper instead of shooting up". It reproduces exactly — set a
 * ball down on the resting bat, let it roll toward the tip, press the button
 * while it is on the outer half of the blade, and before this round the ball
 * came out of the UNDERSIDE with no impulse at all, on 138 of 384 outer-blade
 * trials across the six lower bats.
 *
 * The mechanism is `touchAt`'s approach-side reference, and the whole of it is
 * in the difference between a SIGN and a POSITION. The resolver overrides the
 * ring's normal when it disagrees with the side the ball came from, so that a
 * ball is never pushed out through the bat — and it used to establish that side
 * by re-measuring the last position the ball was OUTSIDE at, against whatever
 * pose the bat holds now. While a ball stays in contact there is no new outside
 * position, so on a struck ball the reference stays at the tick's start while
 * the axis it is measured against goes on rotating. The last eight degrees of
 * the stroke are 4.4 px of blade at mid-blade: on the tick the bat reaches its
 * stop, the stale point crosses to the far side of the new axis, the override
 * fires backwards, and the ball is separated DOWNWARD through the blade — with
 * no impulse, because the stop has already zeroed the rate.
 *
 * `resolveOne` now decides the side WHEN the ball was outside, against the pose
 * it was outside AT, and carries the answer for as long as the contact lasts.
 *
 * WHAT THIS FILE ASSERTS is the invariant and not the count: a ball that was on
 * the blade and above it when the button went down may not end up under the
 * blade. The counts are a survey (`scripts/flipper-probe.mts`), and pinning a
 * survey turns it into a change detector; the invariant is the contract.
 *
 * The scenarios are the research round's own, from
 * `research/view/tip-flip/SCENARIO_SPEC.txt`: the ball is placed on the resting
 * bat's top face at a known distance out, allowed to roll for a chosen number
 * of ticks, and flipped. Nothing is instrumented — where the ball is relative
 * to the bat's own axis is read from its position and the reported stroke, so
 * this survives any refactor of the responder.
 */

import { describe, expect, it } from "vitest";

import { createGame, debugSnapshot, runTicks, startGame } from "../src/browser/game-loop.js";
import type { Game, InputSource } from "../src/browser/game-loop.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { TableId } from "../src/game/contracts.js";
import { batRadiusAt, flipperAngle, flipperConfigsFor } from "../src/game/flippers.js";
import type { FlipperConfig } from "../src/game/flippers.js";
import { BALL_RADIUS_PIXELS, cosineUnits, sineUnits } from "../src/game/collision-probe.js";
import { Q10_ONE, pixelsToQ10, q10Multiply } from "../src/core/fixed-point.js";
import { SUBSTEP_GRAVITY } from "../src/game/ball-physics.js";
import { mapFor } from "./table-fixtures.js";

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

/**
 * The bat's axis and the perpendicular that points UP the table.
 *
 * `axisX` decides which of the two perpendiculars that is, and it never reaches
 * zero: a lower bat's axis runs 30 to -24 degrees on the left and 150 to 204 on
 * the right, so its x component keeps its sign across the whole stroke on every
 * bat of all three tables.
 */
function batAxes(config: FlipperConfig, stroke: number) {
  const angle = flipperAngle(config, { stroke, rate: 0 });
  const axisX = cosineUnits(angle);
  const axisY = sineUnits(angle);
  const up = axisX > 0;
  return { axisX, axisY, normalX: up ? axisY : -axisY, normalY: up ? -axisX : axisX };
}

/** Distance along the blade from the pivot, and signed height above its face. */
function batFrame(config: FlipperConfig, stroke: number, x: number, y: number) {
  const { axisX, axisY, normalX, normalY } = batAxes(config, stroke);
  const dx = x - config.pivotX;
  const dy = y - config.pivotY;
  return {
    along: (q10Multiply(dx, axisX) + q10Multiply(dy, axisY)) / Q10_ONE,
    perp: (q10Multiply(dx, normalX) + q10Multiply(dy, normalY)) / Q10_ONE,
  };
}

/** A seat on the resting bat's top face, `alongPx` out and 1 px clear of it. */
function seatOn(config: FlipperConfig, alongPx: number) {
  const { axisX, axisY, normalX, normalY } = batAxes(config, 0);
  const alongQ = pixelsToQ10(alongPx);
  const clear = batRadiusAt(config, alongQ) + pixelsToQ10(BALL_RADIUS_PIXELS + 1);
  return {
    x: (config.pivotX + q10Multiply(alongQ, axisX) + q10Multiply(clear, normalX)) | 0,
    y: (config.pivotY + q10Multiply(alongQ, axisY) + q10Multiply(clear, normalY)) | 0,
  };
}

const BAT_CONTROL: Readonly<Record<string, Control>> = {
  "lower-left": "leftFlipper",
  "lower-right": "rightFlipper",
  upper: "upperFlipper",
};

/**
 * A game with the serve LANDED and SETTLED, which a probe has to wait for: the
 * project's own note is that a probe which plunges before the served ball has
 * come to rest invents a defect.
 */
function servedGame(tableId: TableId): Game {
  const game = createGame(mapFor(tableId), { ballsPerGame: 3 });
  startGame(game);
  const idle = new ScriptedInput(() => []);
  const seated = 2 * SUBSTEP_GRAVITY;
  // SETTLED IS NOT DEAD STILL, and it never was on the machine. This used to
  // wait for `v === (0, 0)`, which was a statement about the position
  // constraint `78bed65` shipped as a stand-in for the ejector at +0x00B6BE:
  // that constraint refused the into-surface part of every move, so a seated
  // ball stopped dead. With the real ejector the seat BOBS, as the original's
  // does — its own lane ball only ever sits between cy 553.53 and 553.91 — and a
  // residual of one collision pass's worth of gravity is what a seated ball has
  // for ever. `2 * SUBSTEP_GRAVITY` is exactly that: 32 Q10, 1/32 px a tick. A
  // ball still travelling is orders of magnitude above it.
  for (let tick = 0; tick < 400; tick += 1) {
    runTicks(game, idle, 1);
    const ball = game.balls.balls.find((one) => one.active);
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

interface Trial {
  /** True when the ball ended up under a blade it had been on top of. */
  readonly passedUnder: boolean;
  /** `along` at the tick the button went down. */
  readonly alongAtPress: number;
  /** Deepest the ball got below the blade axis while on the blade, px. */
  readonly minPerp: number;
}

/**
 * Sets the ball on the resting bat at `seat`, lets it roll for `settle` ticks,
 * then flips and watches for ninety more.
 */
function rollAndFlip(
  tableId: TableId,
  config: FlipperConfig,
  seat: number,
  settle: number,
): Trial {
  const game = servedGame(tableId);
  const control = BAT_CONTROL[config.id] ?? "leftFlipper";
  const input = new ScriptedInput((tick) =>
    tick >= settle && tick < settle + 25 ? [control] : [],
  );
  const at = seatOn(config, seat);
  const balls = game.balls.balls;
  for (let i = 1; i < balls.length; i += 1) balls[i]!.active = false;
  const ball = balls[0]!;
  ball.x = at.x;
  ball.y = at.y;
  ball.velocityX = 0;
  ball.velocityY = 0;
  ball.active = true;
  ball.heldBy = null;
  ball.level = config.level;

  let alongAtPress = 0;
  let minPerp = 0;
  let wasAbove = false;
  let passedUnder = false;
  for (let tick = 0; tick < settle + 90; tick += 1) {
    const report = runTicks(game, input, 1)[0];
    if ((report?.drained.length ?? 0) > 0) break;
    const state = debugSnapshot(game);
    const live = state.balls.find((one) => one.active);
    if (live === undefined) break;
    const stroke = state.flippers.find((one) => one.id === config.id)?.stroke ?? 0;
    const frame = batFrame(config, stroke, live.x, live.y);
    if (tick === settle) alongAtPress = frame.along;
    // ON THE BLADE means between the boss and the tip. Past the tip is not the
    // blade: a ball that has rolled off the end and is falling when the bat
    // sweeps up behind it has been MISSED, not passed through, and the research
    // round scored that band separately for the same reason.
    if (frame.along < 2 || frame.along > 43) continue;
    if (frame.perp > BALL_RADIUS_PIXELS) wasAbove = true;
    if (tick >= settle) minPerp = Math.min(minPerp, frame.perp);
    if (tick >= settle && wasAbove && frame.perp < -(BALL_RADIUS_PIXELS + 2)) passedUnder = true;
  }
  return { passedUnder, alongAtPress, minPerp };
}

describe("a flipper does not throw the ball through itself", () => {
  /**
   * THE CANONICAL CASE, and the reason this file exists. Law 'n Justice's lower
   * right bat, ball set down 16 px out, flipped 22 ticks later with the ball at
   * `along` 23.1 — the middle of the outer half, exactly where the operator
   * says it happens.
   *
   * Before the fix this trial ran: struck at `perp` +4.78, driven to the
   * velocity clamp, still embedded when the bat reached its stop at stroke
   * 1152, and then ejected DOWNWARD to `perp` -8.00 with the velocity reversed
   * from -16,380 (up, clamped) to +3,712 (down). It drained.
   */
  it("does not drop the canonical Law 'n Justice tip-flip through the blade", () => {
    const config = flipperConfigsFor("law-n-justice").find((one) => one.id === "lower-right");
    expect(config).toBeDefined();
    const trial = rollAndFlip("law-n-justice", config!, 16, 22);
    expect(trial.alongAtPress).toBeGreaterThan(22);
    expect(trial.alongAtPress).toBeLessThan(43);
    expect(trial.passedUnder).toBe(false);
    // Not merely "not through": the ball never gets below the blade at all.
    expect(trial.minPerp).toBeGreaterThan(-(BALL_RADIUS_PIXELS + 2));
  });

  /**
   * THE SWEEP, over the band the report names — the ball on the OUTER HALF of
   * the blade when the button goes down — on both lower bats of all three
   * tables.
   *
   * The pass-under count over this band was 138 of 384 at `c9724a4`, 84 at
   * `822caf5`, 9 at `ed5e01d` and 12 after the spin round. It is now ZERO, and
   * the ceiling is zero: the invariant this file is named for is that a flipper
   * does not throw the ball through itself, and a non-zero ceiling was only ever
   * a truce with a defect nobody owned.
   *
   * WHAT CLOSED IT was the deviation the spin round disclosed and left open —
   * `resolveFlipperContacts` running ONCE PER TICK after `stepBalls` where the
   * machine walks the flipper records at the head of the same collision routine
   * that blits the map, four times a frame (main.seg00 +0x00B278, called from
   * +0x00A7E0 at +0x00A64C/696/6E0/728). Three things went with it, and each is
   * a separate reason the residue could not survive:
   *
   *   THE BALL IS TESTED WHERE IT STANDS. The old resolve sampled four
   *   INTERPOLATED points along the tick's net displacement, because by the time
   *   it ran the intermediate positions no longer existed. They exist now.
   *
   *   NOTHING REWINDS THE BALL. The old resolve ended by moving the ball back to
   *   the crossing point, discarding up to three quarters of the tick's travel —
   *   measured on a ball rolling down the resting left bat, 0.13 px a tick
   *   against a velocity of 0.55 to 1.04. A ball that rolls at its real speed
   *   reaches the tip sooner and is struck earlier in the stroke, which is the
   *   opposite of the "still embedded when the bat hits its stop" state the
   *   pass-under needs.
   *
   *   THE POSE AT A PASS IS THE POSE BEFORE THAT PASS'S ANIMATION STEP. `jsr
   *   $bc24` comes AFTER the ball loop in every one of the frame's four groups,
   *   so a pass reads the pose the previous step wrote. The port read the pose
   *   AFTER the step, which put the bat a quarter tick ahead of the ball and ran
   *   a fresh stroke's four passes at rates 20/40/60/80 where the machine runs
   *   0/20/40/60.
   *
   * Measured on `scripts/flipper-probe.mts`, which runs 648 of these trials
   * rather than this file's 168: roll pass-under 12 -> 0 of 648, drop-and-flip
   * 13 -> 0 of 210, cradles still held on all six lower bats.
   */
  it("keeps outer-blade flips out of the underside on every lower bat", () => {
    const seats = [8, 12, 16, 20];
    const settles = [24, 26, 28, 30, 32, 34, 36, 38, 40, 42];
    let trials = 0;
    let under = 0;
    const sites: string[] = [];
    for (const tableId of TABLE_IDS) {
      for (const config of flipperConfigsFor(tableId)) {
        if (config.id === "upper") continue;
        for (const seat of seats) {
          for (const settle of settles) {
            const trial = rollAndFlip(tableId, config, seat, settle);
            // Only the band the operator described: the ball ON the blade and
            // past its middle when the button goes down.
            if (trial.alongAtPress < 22 || trial.alongAtPress > 43) continue;
            trials += 1;
            if (!trial.passedUnder) continue;
            under += 1;
            sites.push(
              `${tableId} ${config.id} seat ${seat} settle ${settle} ` +
                `along ${trial.alongAtPress.toFixed(2)}`,
            );
          }
        }
      }
    }
    // The band has to be populated or the ceiling below is vacuous — which is
    // exactly how the previous tip-flip figure came to read "0 of 882" while
    // every one of its 882 trials was a clean MISS.
    expect(trials).toBeGreaterThan(100);
    expect(under, `${under}/${trials} passed under: ${sites.join("; ")}`).toBe(0);
  });

  /**
   * A CRADLE HOLDS. The same rule that stopped the bat throwing a ball through
   * itself must not have made the bat porous the other way: a ball on a bat the
   * player is holding up rolls to the boss and stays there.
   */
  it("cradles a ball on every raised lower bat", () => {
    for (const tableId of TABLE_IDS) {
      for (const config of flipperConfigsFor(tableId)) {
        if (config.id === "upper") continue;
        const game = servedGame(tableId);
        const control = BAT_CONTROL[config.id] ?? "leftFlipper";
        const input = new ScriptedInput(() => [control]);
        runTicks(game, input, 8);
        const balls = game.balls.balls;
        for (let i = 1; i < balls.length; i += 1) balls[i]!.active = false;
        const ball = balls[0]!;
        // Placed on the RAISED bat's face, which is where the stroke has
        // already carried the blade to by tick 8.
        const raised = batAxes(config, 1152);
        const alongQ = pixelsToQ10(24);
        const clear = batRadiusAt(config, alongQ) + pixelsToQ10(BALL_RADIUS_PIXELS + 1);
        ball.x = (config.pivotX + q10Multiply(alongQ, raised.axisX) +
          q10Multiply(clear, raised.normalX)) | 0;
        ball.y = (config.pivotY + q10Multiply(alongQ, raised.axisY) +
          q10Multiply(clear, raised.normalY)) | 0;
        ball.velocityX = 0;
        ball.velocityY = 0;
        ball.active = true;
        ball.heldBy = null;
        ball.level = config.level;

        let lost = false;
        for (let tick = 0; tick < 600; tick += 1) {
          const report = runTicks(game, input, 1)[0];
          if ((report?.drained.length ?? 0) > 0) {
            lost = true;
            break;
          }
        }
        expect(lost, `${tableId} ${config.id} lost a cradled ball`).toBe(false);
        const state = debugSnapshot(game);
        const live = state.balls.find((one) => one.active);
        expect(live).toBeDefined();
        const stroke = state.flippers.find((one) => one.id === config.id)?.stroke ?? 0;
        const frame = batFrame(config, stroke, live!.x, live!.y);
        // Rolled down to the boss and sitting on the face: a real cradle.
        expect(frame.along, `${tableId} ${config.id} along`).toBeLessThan(20);
        expect(frame.perp, `${tableId} ${config.id} perp`).toBeGreaterThan(0);
      }
    }
  });
});
