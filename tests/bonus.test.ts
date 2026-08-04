/**
 * THE END-OF-BALL BONUS.
 *
 * The decode lives in `src/game/bonus.ts`, addresses and all; this file pins
 * the parts of it a change could silently take away — the multiply, the panel
 * order, the frame counts, the blink, the abort, the tilt forfeiture, and the
 * clear that stops one ball's bonus being paid twice.
 */

import { describe, expect, it } from "vitest";

import {
  BONUS_ABORT_GRACE_FRAMES,
  BONUS_FLASH_FRAMES,
  BONUS_FLASH_HALF_CYCLE_FRAMES,
  BONUS_NONE_FRAMES,
  BONUS_TOTAL_FRAMES,
  beginBonusPhase,
  bonusCaption,
  bonusMultiplierCaption,
  bonusMultiplierLit,
  bonusPhaseFinished,
  bonusStage,
  bonusValue,
  stepBonusPhase,
} from "../src/game/bonus.js";
import type { BonusPhase } from "../src/game/bonus.js";
import {
  addToBcdField,
  clearBonusForNewBall,
  createScoringState,
  multiplyBcdField,
  newBcdField,
  readBcdField,
} from "../src/game/scoring.js";
import type { ScoringState } from "../src/game/scoring.js";
import type { ControlSnapshot } from "../src/browser/input.js";
import { InputRouter } from "../src/browser/input.js";
import type { GameOptions, InputSource } from "../src/browser/game-loop.js";
import { createGame, debugSnapshot, runTicks, startGame } from "../src/browser/game-loop.js";
import type { BonusView, Game, GameTickReport } from "../src/browser/game-loop.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";
import { mapFor, modesFor } from "./table-fixtures.js";
import { createModeState, queueScript, tickModes } from "../src/game/mode-vm.js";
import { parseTableModesDocument } from "../src/game/table-modes.js";
import type { TableModes } from "../src/game/table-modes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoringWith(bonus: number, multiplier: number): ScoringState {
  const state = createScoringState();
  addToBcdField(state.bonus, bonus);
  state.multiplier = multiplier;
  return state;
}

/** Runs a phase to its end with nothing pressed, and answers how long it took. */
function runToEnd(phase: BonusPhase, keyAt = -1): number {
  let ticks = 0;
  while (!bonusPhaseFinished(phase) && ticks < 10_000) {
    ticks += 1;
    stepBonusPhase(phase, ticks === keyAt);
  }
  return ticks;
}

class Quiet implements InputSource {
  readonly router = new InputRouter();
  sample(): ControlSnapshot {
    return this.router.sample();
  }
}

function startedGame(options: Partial<GameOptions> = {}): Game {
  // BALL SAVE OFF, DELIBERATELY AND BY THE MACHINE'S OWN KNOB. `tableNNN.opt`
  // record 5 is a 0..10 slider and 0 is a setting the options screen offers;
  // every ball in this block is driven straight into the drain to reach the
  // thing under test, and with the shipped five seconds armed each of those
  // drains comes back instead. The saver has its own file — see
  // `tests/ball-saver.test.ts`, which drives it at the shipped lengths on all
  // three tables — and nothing here is testing it.
  const game = createGame(mapFor("law-n-justice"), {
    firstServeDelayTicks: 2,
    serveDelayTicks: 3,
    ballSaveSeconds: 0,
    ...options,
  });
  startGame(game);
  return game;
}

/**
 * A game whose every serve drains at once, so a ball end is a few ticks away.
 *
 * The bonus is seeded BEFORE the first tick, because `startGame` builds a fresh
 * scoring state and the first drain lands within four ticks of it: seeding after
 * any ticks at all is a race with the ball end the test is trying to watch.
 */
function drainingGame(
  bonus = 0,
  multiplier = 0,
  options: Partial<GameOptions> = {},
): Game {
  const game = startedGame({ simulation: { drainY: pixelsToQ10(300) }, ...options });
  if (bonus > 0) addToBcdField(game.scoring.bonus, bonus);
  game.scoring.multiplier = multiplier;
  return game;
}

/** The panels of the FIRST ball end in a run, in order. */
function firstPanelRun(reports: readonly GameTickReport[]): BonusView[] {
  const views: BonusView[] = [];
  for (const report of reports) {
    if (report.bonus !== null) views.push(report.bonus);
    else if (views.length > 0) break;
  }
  return views;
}

// ---------------------------------------------------------------------------
// The multiply
// ---------------------------------------------------------------------------

describe("the bonus multiply is the original's repeated BCD addition", () => {
  it("multiplies by the ladder's values", () => {
    for (const [multiplier, expected] of [
      [2, 3_000_000],
      [4, 6_000_000],
      [6, 9_000_000],
      [8, 12_000_000],
      [10, 15_000_000],
    ] as const) {
      const bonus = newBcdField();
      addToBcdField(bonus, 1_500_000);
      expect(readBcdField(multiplyBcdField(bonus, multiplier))).toBe(expected);
    }
  });

  it("pays the bonus ONCE at multiplier zero, which is what the missing moveq does", () => {
    // +0x00514E `beq $5152` leaves d0 at zero and `dbra` runs the body d0+1
    // times, so a ball that never lit a multiplier still collects its bonus.
    const bonus = newBcdField();
    addToBcdField(bonus, 5_000_000);
    expect(readBcdField(multiplyBcdField(bonus, 0))).toBe(5_000_000);
    expect(readBcdField(multiplyBcdField(bonus, 1))).toBe(5_000_000);
  });

  it("wraps at twelve digits, because six ABCDs have nowhere to carry to", () => {
    const bonus = newBcdField();
    addToBcdField(bonus, 500_000_000_000);
    expect(readBcdField(multiplyBcdField(bonus, 4))).toBe(0);
  });

  it("leaves the field it multiplied alone", () => {
    const bonus = newBcdField();
    addToBcdField(bonus, 1_000_000);
    multiplyBcdField(bonus, 10);
    expect(readBcdField(bonus)).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// The panels
// ---------------------------------------------------------------------------

describe("the bonus phase shows the panels the routine shows", () => {
  it("holds NO BONUS for 150 frames when there is nothing to pay", () => {
    const phase = beginBonusPhase(scoringWith(0, 0), false);
    expect(phase).not.toBeNull();
    const live = phase as BonusPhase;
    expect(bonusStage(live)).toBe("none");
    expect(bonusCaption(live)).toBe("NO BONUS");
    // `$2B84` draws the caption and never calls the number drawer.
    expect(bonusValue(live)).toBe(0);
    expect(runToEnd(live)).toBe(BONUS_NONE_FRAMES);
  });

  it("flashes the bonus for 80 frames and then totals it for 100", () => {
    const phase = beginBonusPhase(scoringWith(1_500_000, 4), false) as BonusPhase;
    expect(bonusStage(phase)).toBe("flash");
    expect(bonusCaption(phase)).toBe("BONUS");
    // The flash shows the RAW accumulator: `$29EE` draws `player+$10`.
    expect(bonusValue(phase)).toBe(1_500_000);
    expect(phase.product).toBe(6_000_000);

    for (let tick = 0; tick < BONUS_FLASH_FRAMES; tick += 1) stepBonusPhase(phase, false);
    expect(bonusStage(phase)).toBe("total");
    expect(bonusCaption(phase)).toBe("TOTAL BONUS");
    expect(bonusValue(phase)).toBe(6_000_000);

    for (let tick = 0; tick < BONUS_TOTAL_FRAMES; tick += 1) stepBonusPhase(phase, false);
    expect(bonusPhaseFinished(phase)).toBe(true);
    expect(bonusStage(phase)).toBeNull();
  });

  it("takes 180 frames in all for a bonus that pays", () => {
    const phase = beginBonusPhase(scoringWith(100_000, 2), false) as BonusPhase;
    expect(runToEnd(phase)).toBe(BONUS_FLASH_FRAMES + BONUS_TOTAL_FRAMES);
  });

  it("still flashes a bonus whose multiplier is zero, because the product is not", () => {
    // `$29DC` tests the PRODUCT, and the product of a zero multiplier is the
    // bonus itself.
    const phase = beginBonusPhase(scoringWith(250_000, 0), false) as BonusPhase;
    expect(bonusStage(phase)).toBe("flash");
    expect(readBcdField(phase.total)).toBe(250_000);
  });
});

// ---------------------------------------------------------------------------
// The combo term
// ---------------------------------------------------------------------------

describe("the combo panel, between the flash and the total", () => {
  it("is skipped at a count of zero, which is `beq.w $2B48`", () => {
    const phase = beginBonusPhase(scoringWith(1_000_000, 2), false, 0) as BonusPhase;
    expect(phase.stages.map((stage) => stage.kind)).toEqual(["flash", "total"]);
    expect(phase.comboTotal).toBe(0);
    expect(readBcdField(phase.total)).toBe(2_000_000);
  });

  it("holds `<n> COMBOS` for 100 frames and adds 1,000,000 a combo to the total", () => {
    // `$2A80` multiplies the six packed-BCD bytes at h4+0x2BA2 by the count and
    // `$2AA0` adds the product into the display total.
    const phase = beginBonusPhase(scoringWith(1_000_000, 2), false, 3) as BonusPhase;
    expect(phase.stages.map((stage) => stage.kind)).toEqual(["flash", "combo", "total"]);
    for (let tick = 0; tick < BONUS_FLASH_FRAMES; tick += 1) stepBonusPhase(phase, false);
    expect(bonusStage(phase)).toBe("combo");
    expect(bonusCaption(phase)).toBe("3 COMBOS");
    expect(bonusValue(phase)).toBe(3_000_000);

    for (let tick = 0; tick < BONUS_TOTAL_FRAMES; tick += 1) stepBonusPhase(phase, false);
    expect(bonusStage(phase)).toBe("total");
    // The product of the flash plus the combo term, which is what the score is
    // finally paid at `$51DA`.
    expect(bonusValue(phase)).toBe(5_000_000);
    expect(readBcdField(phase.total)).toBe(5_000_000);
  });

  it("drops the S at exactly one, which is the `cmpi.w #$1` at +0x2B0C", () => {
    const one = beginBonusPhase(scoringWith(0, 0), false, 1) as BonusPhase;
    expect(bonusCaption(one)).toBe("1 COMBO");
    const two = beginBonusPhase(scoringWith(0, 0), false, 2) as BonusPhase;
    expect(bonusStage(two)).toBe("combo");
    expect(bonusCaption(two)).toBe("2 COMBOS");
  });

  it("pays combos on a ball whose accumulator is empty, and skips the flash", () => {
    // `$29DC` gates the flash on the PRODUCT alone and `$2B4E` gates the total
    // on the display total, which the combo term has already been added into —
    // so a ball with no bonus and one combo shows two panels and pays 1,000,000.
    const phase = beginBonusPhase(scoringWith(0, 0), false, 1) as BonusPhase;
    expect(phase.stages.map((stage) => stage.kind)).toEqual(["combo", "total"]);
    expect(readBcdField(phase.total)).toBe(1_000_000);
    expect(runToEnd(phase)).toBe(BONUS_TOTAL_FRAMES * 2);
  });

  it("defaults to no combos, so a caller that has none behaves as before", () => {
    expect((beginBonusPhase(scoringWith(500_000, 2), false) as BonusPhase).comboCount).toBe(0);
  });
});

describe("the multiplier caption blinks four times over the flash", () => {
  it("names the multiplier the ball earned", () => {
    for (const multiplier of [2, 4, 6, 8, 10]) {
      const phase = beginBonusPhase(scoringWith(1_000, multiplier), false) as BonusPhase;
      expect(bonusMultiplierCaption(phase)).toBe(`X${multiplier}`);
    }
    // Extreme Sports' ladder is 2/3/4/5 and its records spell those out too.
    for (const multiplier of [3, 5]) {
      const phase = beginBonusPhase(scoringWith(1_000, multiplier), false) as BonusPhase;
      expect(bonusMultiplierCaption(phase)).toBe(`X${multiplier}`);
    }
  });

  it("shows nothing below x2, which is the bmi at +0x2A24", () => {
    for (const multiplier of [0, 1]) {
      const phase = beginBonusPhase(scoringWith(1_000, multiplier), false) as BonusPhase;
      expect(bonusMultiplierCaption(phase)).toBe("");
      expect(bonusMultiplierLit(phase)).toBe(false);
    }
  });

  it("is lit for the first half-cycle and dark for the second, four times", () => {
    const phase = beginBonusPhase(scoringWith(1_000, 6), false) as BonusPhase;
    const lit: boolean[] = [];
    for (let tick = 0; tick < BONUS_FLASH_FRAMES; tick += 1) {
      lit.push(bonusMultiplierLit(phase));
      stepBonusPhase(phase, false);
    }
    // Eight runs of ten, alternating, starting lit: `$2B9A` is cleared at
    // +0x29C2 and `not.b`-ed at the END of each half-cycle (+0x2A4E).
    for (let tick = 0; tick < BONUS_FLASH_FRAMES; tick += 1) {
      const half = Math.floor(tick / BONUS_FLASH_HALF_CYCLE_FRAMES);
      expect(lit[tick]).toBe(half % 2 === 0);
    }
    expect(lit.filter(Boolean)).toHaveLength(BONUS_FLASH_FRAMES / 2);
    // And it is dark once the flash is over.
    expect(bonusMultiplierLit(phase)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The abort
// ---------------------------------------------------------------------------

describe("a key cuts a panel short, but never inside the grace", () => {
  it("ends NO BONUS at the grace when a key came earlier", () => {
    const phase = beginBonusPhase(scoringWith(0, 0), false) as BonusPhase;
    expect(runToEnd(phase, 1)).toBe(BONUS_ABORT_GRACE_FRAMES);
  });

  it("ends on the tick a late key lands, not before", () => {
    const at = 90;
    const phase = beginBonusPhase(scoringWith(0, 0), false) as BonusPhase;
    expect(runToEnd(phase, at)).toBe(at);
  });

  it("cannot shorten the flash, whose steps are ten frames inside a 26 grace", () => {
    const phase = beginBonusPhase(scoringWith(1_000, 2), false) as BonusPhase;
    // A key on every single tick: the flash still runs its full 80 frames.
    let ticks = 0;
    while (bonusStage(phase) === "flash") {
      ticks += 1;
      stepBonusPhase(phase, true);
    }
    expect(ticks).toBe(BONUS_FLASH_FRAMES);
    // …and the TOTAL panel behind it is cut to the grace, because `$D00B` is
    // cleared once at `$51B2` and stays set for the rest of the routine.
    expect(runToEnd(phase)).toBe(BONUS_ABORT_GRACE_FRAMES);
  });

  it("never runs a panel longer than the routine asks for", () => {
    const phase = beginBonusPhase(scoringWith(0, 0), false) as BonusPhase;
    expect(runToEnd(phase, 10_000)).toBe(BONUS_NONE_FRAMES);
  });
});

// ---------------------------------------------------------------------------
// Tilt
// ---------------------------------------------------------------------------

describe("a tilted ball forfeits the bonus", () => {
  it("owes no phase at all — not even NO BONUS", () => {
    expect(beginBonusPhase(scoringWith(5_000_000, 10), true)).toBeNull();
    expect(beginBonusPhase(scoringWith(0, 0), true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The per-ball clear
// ---------------------------------------------------------------------------

describe("the accumulator clears for the next ball", () => {
  it("empties the bonus and the multiplier", () => {
    const state = scoringWith(7_000_000, 8);
    clearBonusForNewBall(state);
    expect(readBcdField(state.bonus)).toBe(0);
    expect(state.multiplier).toBe(0);
  });

  it("keeps them for exactly one ball when the holds are armed", () => {
    const state = scoringWith(7_000_000, 8);
    state.holdBonus = true;
    state.holdMultiplier = true;

    clearBonusForNewBall(state);
    expect(readBcdField(state.bonus)).toBe(7_000_000);
    expect(state.multiplier).toBe(8);
    // The `clr.b` past each test runs on BOTH arms (+0x00428E, +0x00429C), so
    // the grant is spent.
    expect(state.holdBonus).toBe(false);
    expect(state.holdMultiplier).toBe(false);

    clearBonusForNewBall(state);
    expect(readBcdField(state.bonus)).toBe(0);
    expect(state.multiplier).toBe(0);
  });

  it("holds one field without holding the other", () => {
    const state = scoringWith(1_000, 4);
    state.holdMultiplier = true;
    clearBonusForNewBall(state);
    expect(readBcdField(state.bonus)).toBe(0);
    expect(state.multiplier).toBe(4);
  });

  it("leaves the score alone", () => {
    const state = scoringWith(1_000, 4);
    addToBcdField(state.score, 12_345);
    clearBonusForNewBall(state);
    expect(readBcdField(state.score)).toBe(12_345);
  });
});

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

describe("a ball end pays what the ball earned", () => {
  it("adds bonus x multiplier to the score, once, when the panels are done", () => {
    const game = drainingGame(1_500_000, 4);
    const reports: GameTickReport[] = runTicks(game, new Quiet(), 250);

    expect(firstPanelRun(reports)).toHaveLength(BONUS_FLASH_FRAMES + BONUS_TOTAL_FRAMES);
    expect(debugSnapshot(game).score).toBe(6_000_000);
    // And the accumulator is empty behind it — `$427C`, at +0x0050D4.
    expect(debugSnapshot(game).bonus).toBe(0);
    expect(debugSnapshot(game).bonusMultiplier).toBe(0);
  });

  it("shows the panels in order and holds the score flat until the end", () => {
    const game = drainingGame(2_000_000, 2);
    const input = new Quiet();
    const stages: (string | null)[] = [];
    const scores: number[] = [];
    for (let tick = 0; tick < 220; tick += 1) {
      const [report] = runTicks(game, input, 1);
      stages.push(report?.bonus?.stage ?? null);
      scores.push(debugSnapshot(game).score);
    }

    // The FIRST ball end only: ball 2 drains inside this window too, and its
    // own "NO BONUS" is a different panel run.
    const from = stages.indexOf("flash");
    const run = stages.slice(from, from + stages.slice(from).indexOf(null));
    expect(run.filter((stage) => stage === "flash")).toHaveLength(BONUS_FLASH_FRAMES);
    expect(run.filter((stage) => stage === "total")).toHaveLength(BONUS_TOTAL_FRAMES);
    // In that order, with nothing between: the flash runs out and the total
    // panel replaces it.
    expect(run.indexOf("total")).toBe(BONUS_FLASH_FRAMES);

    // THE SCORE DOES NOT TICK. `$51DA` is one `ABCD` chain AFTER the display,
    // and the film's DMD is bit-identical frame to frame across every filmed
    // end-of-ball. So the score is the same number on every tick of the run.
    const duringPanel = new Set<number>();
    for (let tick = from; tick < from + run.length; tick += 1) {
      duringPanel.add(scores[tick] as number);
    }
    expect([...duringPanel]).toEqual([0]);
    expect(debugSnapshot(game).score).toBe(4_000_000);
  });

  it("shows NO BONUS on a ball that earned nothing, and pays nothing", () => {
    const game = drainingGame();
    const views = firstPanelRun(runTicks(game, new Quiet(), 200));
    expect(views).toHaveLength(BONUS_NONE_FRAMES);
    expect(views[0]?.stage).toBe("none");
    expect(views[0]?.caption).toBe("NO BONUS");
    expect(views[0]?.value).toBeNull();
    expect(views[0]?.multiplier).toBe("");
    expect(debugSnapshot(game).score).toBe(0);
  });

  it("pays a tilted ball nothing and shows nothing at all", () => {
    // ONE ball, so the only ball end in the run is the tilted one — a second
    // ball would arrive untilted and put its own "NO BONUS" up. The tilt and
    // the bonus are set after the SERVE rather than before it, because a serve
    // resets the tilt for the ball it is serving; and the ball is put down the
    // drain by hand, because the shot that would have earned the bonus is not
    // what this test is about.
    const game = startedGame({ ballsPerGame: 1 });
    const input = new Quiet();
    runTicks(game, input, 3);
    const ball = game.balls.balls[0];
    expect(ball).toBeDefined();
    addToBcdField(game.scoring.bonus, 5_000_000);
    game.scoring.multiplier = 10;
    game.tilt = { ...game.tilt, tilted: true };
    game.laneBallId = null;
    if (ball !== undefined) ball.y = pixelsToQ10(700);

    const reports = runTicks(game, input, 60);
    // No panel was ever up, and the score never moved — not even by the 5,000,000
    // this ball had banked at a x10 multiplier.
    expect(reports.every((report) => report.bonus === null)).toBe(true);
    expect(debugSnapshot(game).score).toBe(0);
    // And the accumulator was still cleared, because `$427C` runs either way.
    expect(debugSnapshot(game).bonus).toBe(0);
    expect(debugSnapshot(game).bonusMultiplier).toBe(0);
    // The game ended without waiting for a bonus it was never going to pay.
    expect(reports.some((report) => report.gameOver)).toBe(true);
  });

  it("keeps the lane shut while the bonus counts", () => {
    const game = drainingGame(1_000_000, 0);

    const reports = runTicks(game, new Quiet(), 300);
    // From the tick AFTER a panel goes up until it comes down, nothing serves.
    // The tick it goes up is excluded because this fixture's drain line is
    // above the trough, so its serve and its ball end really are one tick.
    let panelTicks = 0;
    for (const report of reports) {
      if (report.bonus === null) {
        panelTicks = 0;
        continue;
      }
      if (panelTicks > 0) expect(report.served).toBe(false);
      panelTicks += 1;
    }
    // And the lane opens again afterwards.
    expect(reports.filter((report) => report.served).length).toBeGreaterThan(1);
  });

  it("pays the last ball before the game ends", () => {
    const game = drainingGame(3_000_000, 2, { ballsPerGame: 1 });

    const reports = runTicks(game, new Quiet(), 400);
    const over = reports.findIndex((report) => report.gameOver);
    expect(over).toBeGreaterThan(0);
    // Every panel came BEFORE the game-over tick, and the score is paid.
    const lastPanel = reports.map((report) => report.bonus !== null).lastIndexOf(true);
    expect(lastPanel).toBeLessThan(over);
    expect(debugSnapshot(game).score).toBe(6_000_000);
  });

  it("does not pay one ball's bonus twice", () => {
    const game = drainingGame(1_000_000, 0);

    runTicks(game, new Quiet(), 1200);
    // Three balls, one of which had a bonus: the score is that bonus and no
    // multiple of it.
    expect(debugSnapshot(game).score).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// The ladder the mission layer sets it from
// ---------------------------------------------------------------------------

describe("the mission layer reaches the player record's bonus fields", () => {
  /** One element with `effect`, and one script that AWARDs it. */
  function oneShot(effect: number, multiplier: number): TableModes {
    const opcodes = Array.from({ length: 32 }, (_, index) => {
      const named: Readonly<Record<number, readonly [string, number, string]>> = {
        0: ["END", 2, ""],
        5: ["AWARD", 6, "e"],
      };
      const entry = named[index] ?? ([`OP${index}`, 2, ""] as const);
      return { index, name: entry[0], length: entry[1], args: entry[2] };
    });
    return parseTableModesDocument({
      schema: "pinball-illusions/table-modes/v1",
      tableId: "law-n-justice",
      displayName: "fixture",
      provenance: {
        sourceClass: "disk-derived-mode-scripts",
        description: "test",
        authorizationRequired: true,
      },
      opcodes,
      elements: [
        {
          index: 0,
          flags: 0,
          score: 0,
          bonus: 0,
          effect,
          multiplier,
          countdown: -1,
          lampStart: false,
          lampAward: false,
          soundStart: false,
          soundAward: false,
          displayStart: -1,
          displayAward: -1,
          counter: -1,
        },
      ],
      messages: [],
      scripts: [{ index: 0, ops: [{ pc: 0, op: 5, args: [0] }, { pc: 6, op: 0, args: [] }] }],
      missions: [],
      triggers: { devices: [], zones: [], locks: [] },
    } as unknown as Parameters<typeof parseTableModesDocument>[0]);
  }

  function awardOnce(effect: number, multiplier = 0) {
    const modes = oneShot(effect, multiplier);
    const state = createModeState(modes);
    state.armed[0] = 1;
    queueScript(state, 0);
    // The queue runs one opcode a frame, so give it a few.
    let report = tickModes(modes, state);
    for (let tick = 0; tick < 4 && report.awards.length === 0; tick += 1) {
      report = tickModes(modes, state);
    }
    return report;
  }

  it("effect 5 reports the multiplier the element carries", () => {
    const report = awardOnce(5, 6);
    expect(report.awards).toHaveLength(1);
    expect(report.bonusMultiplier).toBe(6);
    expect(report.holdBonus).toBe(false);
  });

  it("effect 2 reports HOLD BONUS and effect 8 reports HOLD MULTIPLIER", () => {
    expect(awardOnce(2).holdBonus).toBe(true);
    expect(awardOnce(2).holdMultiplier).toBe(false);
    expect(awardOnce(8).holdMultiplier).toBe(true);
    expect(awardOnce(8).holdBonus).toBe(false);
  });

  it("says nothing at all for the effects that are not these three", () => {
    const report = awardOnce(0);
    expect(report.awards).toHaveLength(1);
    // -1, not 0: zero is a multiplier the field can legally hold.
    expect(report.bonusMultiplier).toBe(-1);
    expect(report.holdBonus).toBe(false);
    expect(report.holdMultiplier).toBe(false);
  });
});

describe("award effect 5 is the x2..x10 insert row", () => {
  it("ships one element per rung on every table", () => {
    for (const [tableId, expected] of [
      ["law-n-justice", [2, 4, 6, 8, 10]],
      ["babewatch", [2, 4, 6, 8, 10]],
      ["extreme-sports", [2, 3, 4, 5]],
    ] as const) {
      const modes = modesFor(tableId);
      const ladder = modes.elements
        .filter((element) => element.effect === 5)
        .map((element) => element.multiplier);
      expect(ladder).toEqual([...expected]);
    }
  });

  it("gives every other element a multiplier of zero, because +$34 is a pointer there", () => {
    for (const tableId of ["law-n-justice", "babewatch", "extreme-sports"] as const) {
      for (const element of modesFor(tableId).elements) {
        if (element.effect !== 5) expect(element.multiplier).toBe(0);
      }
    }
  });
});
