/**
 * THE BALL SAVER — `$D8A(a5)`, the general game feature this port never had.
 *
 * It was decoded a round ago and deliberately left out
 * (`research/MULTIBALL_PLAY.md` section 8) because it is not a multiball detail:
 * the same word is armed at the START OF EVERY BALL ON EVERY TABLE from `.opt`
 * record 5, so wiring it changes every ball in the game. Twelve of the thirteen
 * multiball scripts arm 10 to 30 seconds of it on top.
 *
 * The whole mechanism is five sites, and every one has a case below:
 *
 *   +0x0049AE  ARM. `move.w $e8e(a5),d0 / mulu.w $50(a5),d0 / move.w d0,$d8a`,
 *              the first three instructions of state 5. `$e8e` is option
 *              record 5, which the shipped files really do carry — 5 seconds on
 *              Law 'n Justice and BabeWatch, TEN on Extreme Sports.
 *   +0x005992  opcode 11, the same multiply. A plain `move.w`, so a script SETS
 *              the countdown and does not extend it.
 *   +0x004DF2  TICK, once per state-3 frame and in no other state.
 *   +0x0052CE  SPEND. The drain reaper gives the ball straight back.
 *   +0x004E4E  THE LAST BALL. Still running when the final ball goes: re-queue
 *              at +0x004EB4 and STATE 6, the "DON'T MOVE" card, instead of the
 *              end of the ball.
 *
 * And +0x004DEC..+0x004E20, the lamp, whose blink is anchored to the countdown
 * itself rather than to any clock.
 *
 * Addresses are `main.seg00`; file offset = address + 4 in
 * `research/seg_clean/main.bin.seg00.bin`. See
 * `research/BALL_SAVER_JACKPOTS.md`.
 */

import { describe, expect, it } from "vitest";
import {
  createGame,
  debugSnapshot,
  panelCardOf,
  runTicks,
  startGame,
  tickGame,
} from "../src/browser/game-loop.js";
import type { Game, GameOptions, InputSource } from "../src/browser/game-loop.js";
import { lampsFor, mapFor, modesFor } from "./table-fixtures.js";
import { CONTROLS } from "../src/browser/input.js";
import type { Control, ControlEdges, ControlSnapshot } from "../src/browser/input.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import type { TableId } from "../src/game/contracts.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";
import {
  ORIGINAL_BALL_SAVE_MAX,
  ORIGINAL_BALL_SAVE_MIN,
  TICKS_PER_SECOND,
  ballSaveSecondsFor,
} from "../src/game/timebase.js";
import {
  BALL_SAVE_ENGINE_SLOT,
  LAMP_OFF,
  LAMP_STEADY,
  ballSaveLampLit,
  lampModes,
} from "../src/game/lamp-overlays.js";
import { createModeState, queueScript, tickModes } from "../src/game/mode-vm.js";

class ScriptedInput implements InputSource {
  private sequence = 0;
  private held = new Set<Control>();
  constructor(private readonly plan: (tick: number) => readonly Control[] = () => []) {}
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

function idle(): InputSource {
  return new ScriptedInput();
}

function started(tableId: TableId, options: Partial<GameOptions> = {}): Game {
  const game = createGame(mapFor(tableId), options);
  startGame(game);
  return game;
}

/** Ticks until the lane ball has been launched, tapping the plunger. */
function launch(game: Game): void {
  const input = new ScriptedInput((tick) => (tick % 10 < 4 ? ["plunger"] : []));
  for (let i = 0; i < 900; i += 1) {
    if (runTicks(game, input, 1)[0]?.launched === true) return;
  }
  throw new Error("the served ball never launched");
}

/** Teleports the one free ball over the drain mouth and ticks until it goes. */
function drainNow(game: Game): void {
  const laneId = debugSnapshot(game).laneBallId;
  const ball = game.balls.balls.find(
    (one) => one.active && one.heldBy === null && one.id !== laneId,
  );
  if (ball === undefined) throw new Error("no free ball to drain");
  ball.level = 0;
  ball.x = pixelsToQ10(168);
  ball.y = pixelsToQ10(596);
  ball.velocityX = 0;
  ball.velocityY = 9000;
  for (let i = 0; i < 60; i += 1) {
    if (runTicks(game, idle(), 1)[0]?.drained.length ?? 0) return;
  }
  throw new Error("the teleported ball never drained");
}

describe("the ball save is armed at the start of every ball", () => {
  it("takes its length from the table's own option record 5", () => {
    // NOT A RECONSTRUCTION. `research/meta/tableNNN.opt` is on the disks and is
    // seventy bytes of seven ten-byte (min, max, current, default, -1) records;
    // record 5 reads `0000 000a 0000 0005 ffff` on tables 1 and 2 and
    // `0000 000a 0000 000a ffff` on table 3, and +0x0009E6 copies each default
    // over its current at load. So the shipped lengths are read, not chosen.
    expect(ORIGINAL_BALL_SAVE_MIN).toBe(0);
    expect(ORIGINAL_BALL_SAVE_MAX).toBe(10);
    expect(TABLE_IDS.map(ballSaveSecondsFor)).toEqual([5, 5, 10]);

    for (const tableId of TABLE_IDS) {
      const game = started(tableId);
      // Before the serve there is nothing armed; the arm is state 5's own.
      expect(debugSnapshot(game).ballSaveTicks, `${tableId} before the serve`).toBe(0);
      runTicks(game, idle(), 1);
      for (let i = 0; i < 200 && debugSnapshot(game).ballSaveTicks === 0; i += 1) {
        runTicks(game, idle(), 1);
      }
      const armed = debugSnapshot(game).ballSaveTicks;
      const want = ballSaveSecondsFor(tableId) * TICKS_PER_SECOND;
      // Armed at the serve and already counting: it is within a few frames of
      // the full length, and it is the LENGTH THIS TABLE SHIPS.
      expect(armed, `${tableId} armed`).toBeGreaterThan(want - 20);
      expect(armed, `${tableId} armed`).toBeLessThanOrEqual(want);
    }
  });

  it("counts down once a frame while the ball is in play, and stops at zero", () => {
    const game = started("law-n-justice");
    runTicks(game, idle(), 1);
    for (let i = 0; i < 200 && debugSnapshot(game).ballSaveTicks === 0; i += 1) {
      runTicks(game, idle(), 1);
    }
    const before = debugSnapshot(game).ballSaveTicks;
    runTicks(game, idle(), 10);
    expect(debugSnapshot(game).ballSaveTicks).toBe(before - 10);
    runTicks(game, idle(), before);
    expect(debugSnapshot(game).ballSaveTicks).toBe(0);
  });

  it("is off entirely when the option is turned down to zero", () => {
    // 0 is inside the shipped 0..10 slider, so this is a configuration the
    // machine offers rather than a switch this port invented.
    const game = started("law-n-justice", { ballSaveSeconds: 0 });
    runTicks(game, idle(), 200);
    expect(debugSnapshot(game).ballSaveTicks).toBe(0);
  });
});

describe("a drain inside the window gives the ball back", () => {
  for (const tableId of TABLE_IDS) {
    it(`${tableId} re-serves without charging the player a ball`, () => {
      const game = started(tableId);
      launch(game);
      const before = debugSnapshot(game);
      expect(before.ballSaveTicks, `${tableId} nothing armed`).toBeGreaterThan(0);
      expect(before.ballsServed).toBe(1);

      drainNow(game);
      const saved = debugSnapshot(game);
      // +0x004EB4's `addq.w #$1,$d86(a5)` and +0x004EB8's state 6.
      expect(saved.pendingServes, `${tableId} owed`).toBe(1);
      expect(saved.ballSaving, `${tableId} state 6`).toBe(true);
      expect(saved.bonusPhase, `${tableId} bonus`).toBeNull();
      expect(saved.ballsServed, `${tableId} charged`).toBe(1);
      expect(saved.phase).toBe("in-play");

      // The card is the display list at +0x004FAC, four words and all:
      // `00A0 0002 0001 0002` — CENTRED on x=160, row 2, the twelve-row face.
      // And it carries NO SCORE: +0x004F50 clears the plane, prints its one
      // record and returns without ever reaching `$71BA`. Film frame 545 of the
      // full-game capture shows exactly that — the callout and no digit
      // anywhere on the strip.
      expect(panelCardOf(game)).toEqual({
        lines: [{ x: 160, row: 2, font: 1, align: 2, text: "DON'T MOVE" }],
        score: null,
      });

      // And the ball really comes back and gets played again.
      launch(game);
      const back = debugSnapshot(game);
      expect(back.balls.filter((one) => one.active).length, `${tableId} back`).toBeGreaterThan(0);
      expect(back.ballSaving, `${tableId} card down`).toBe(false);
      expect(back.ballsServed, `${tableId} still ball one`).toBe(1);
    });
  }

  it("stops the clock while the card is up and restarts it when the ball is back", () => {
    // State 6's frame (+0x004F50) has no `$d8a` instruction in it at all.
    const game = started("law-n-justice");
    launch(game);
    drainNow(game);
    const held = debugSnapshot(game).ballSaveTicks;
    expect(debugSnapshot(game).ballSaving).toBe(true);
    runTicks(game, idle(), 20);
    expect(debugSnapshot(game).ballSaveTicks).toBe(held);
    launch(game);
    expect(debugSnapshot(game).ballSaving).toBe(false);
    runTicks(game, idle(), 5);
    expect(debugSnapshot(game).ballSaveTicks).toBeLessThan(held);
  });

  it("does not re-arm on a save, so one window can pay twice and then stop", () => {
    // Nothing in either save path writes `$d8a`. Law 'n Justice's five seconds
    // is 250 frames and a drain-and-return cycle here is far shorter, so the
    // same window saves the ball more than once and then runs out.
    const game = started("law-n-justice");
    launch(game);
    const first = debugSnapshot(game).ballSaveTicks;
    drainNow(game);
    launch(game);
    const second = debugSnapshot(game).ballSaveTicks;
    // NOT put back to the full length — the save path writes nothing.
    expect(second).toBeLessThanOrEqual(first);
    expect(second).toBeLessThan(ballSaveSecondsFor("law-n-justice") * TICKS_PER_SECOND);
    expect(second).toBeGreaterThan(0);
    drainNow(game);
    expect(debugSnapshot(game).ballSaving).toBe(true);
    expect(debugSnapshot(game).ballsServed).toBe(1);
  });

  it("ends the ball once the window is spent", () => {
    const game = started("law-n-justice");
    launch(game);
    // Run the clock out with the ball parked safely above the drain.
    for (let i = 0; i < 400 && debugSnapshot(game).ballSaveTicks > 0; i += 1) {
      const ball = game.balls.balls.find((one) => one.active && one.heldBy === null);
      if (ball !== undefined) {
        ball.y = pixelsToQ10(300);
        ball.velocityY = 0;
      }
      runTicks(game, idle(), 1);
    }
    expect(debugSnapshot(game).ballSaveTicks).toBe(0);
    drainNow(game);
    const ended = debugSnapshot(game);
    expect(ended.ballSaving).toBe(false);
    // The bonus phase is the end of the ball; a saved drain never reaches it.
    expect(ended.bonusPhase).not.toBeNull();
  });
});

describe("the ball save and the rest of the machine", () => {
  it("does nothing once the table is tilted", () => {
    // State 8 opens every frame with `clr.w $d86(a5)` (+0x004D4C) and its own
    // `bmi.w $4ec0` (+0x004D68) goes straight to the real end of ball, skipping
    // the +0x004E4E test entirely.
    const game = started("law-n-justice");
    launch(game);
    expect(debugSnapshot(game).ballSaveTicks).toBeGreaterThan(0);
    game.tilt = { warning: 0, tilted: true, cooldown: 0 };
    drainNow(game);
    const ended = debugSnapshot(game);
    expect(ended.pendingServes).toBe(0);
    expect(ended.ballSaving).toBe(false);
  });

  it("takes no notice of a ball the SEARCH wrote off", () => {
    // The write-off is this port's own deadlock guarantee and not a drain the
    // machine ever sees; handing a wedged ball back would put it straight into
    // the same wedge with the countdown stopped.
    const game = started("law-n-justice");
    launch(game);
    expect(debugSnapshot(game).ballSaveTicks).toBeGreaterThan(0);
    const ball = game.balls.balls.find((one) => one.active && one.heldBy === null);
    expect(ball).toBeDefined();
    // Freeze it somewhere the search will retire it.
    for (let i = 0; i < 12 * game.options.ballSearchTicks; i += 1) {
      const live = game.balls.balls.find((one) => one.active && one.heldBy === null);
      if (live === undefined) break;
      live.x = pixelsToQ10(168);
      live.y = pixelsToQ10(300);
      live.velocityX = 0;
      live.velocityY = 0;
      const report = tickGame(game, idle().sample());
      if (report.writtenOff.length > 0) {
        expect(debugSnapshot(game).ballSaving, "a written-off ball was saved").toBe(false);
        return;
      }
    }
    throw new Error("the ball search never wrote the ball off");
  });

  it("is cleared at the end of a ball and armed again for the next player", () => {
    // `clr.w $d8a(a5)` at +0x0050FA is in the teardown BOTH the rotation and the
    // extra ball run through, and only state 5 arms — so the countdown never
    // crosses a ball and never needs to be per player.
    const game = createGame(mapFor("law-n-justice"));
    startGame(game, 2);
    launch(game);
    expect(debugSnapshot(game).activePlayer).toBe(0);
    const first = debugSnapshot(game).ballSaveTicks;
    expect(first).toBeGreaterThan(0);

    // Spend the window, then drain for real.
    for (let i = 0; i < 400 && debugSnapshot(game).ballSaveTicks > 0; i += 1) {
      const ball = game.balls.balls.find((one) => one.active && one.heldBy === null);
      if (ball !== undefined) {
        ball.y = pixelsToQ10(300);
        ball.velocityY = 0;
      }
      runTicks(game, idle(), 1);
    }
    drainNow(game);
    // Run the bonus, the hold and the rotation out.
    for (let i = 0; i < 2_000 && debugSnapshot(game).activePlayer === 0; i += 1) {
      runTicks(game, idle(), 1);
    }
    expect(debugSnapshot(game).activePlayer).toBe(1);
    launch(game);
    expect(debugSnapshot(game).ballSaveTicks).toBeGreaterThan(0);
  });
});

describe("mode-script opcode 11", () => {
  it("SETS the countdown rather than extending it", () => {
    // +0x005992 is a plain `move.w`, so a 10-second arm over a running 30 makes
    // it ten. Twelve of the thirteen multiball scripts arm one immediately
    // after `BALLS_UP_TO`: 10 s and 30 s on Law 'n Justice, 15 s on the others.
    const modes = modesFor("babewatch");
    const state = createModeState(modes);
    const script = modes.scripts.find((one) => one.ops.some((op) => op.op === 11));
    expect(script, "no BabeWatch script arms a ball save").toBeDefined();
    const seconds = script!.ops.find((op) => op.op === 11)!.args[0]!;
    expect(seconds).toBe(15);

    queueScript(state, script!.index);
    let reported = -1;
    for (let i = 0; i < 200 && reported < 0; i += 1) {
      const report = tickModes(modes, state);
      if (report.ballSaveTicks >= 0) reported = report.ballSaveTicks;
    }
    expect(reported).toBe(seconds * TICKS_PER_SECOND);
  });

  it("is named SET_BALL_SAVE in the shipped documents", () => {
    // The old name, `SET_INTRO`, was a guess at a small operand. It is the
    // handler at +0x005992 and it writes `$d8a`.
    for (const tableId of TABLE_IDS) {
      const opcode = modesFor(tableId).opcodes[11];
      expect(opcode?.name, tableId).toBe("SET_BALL_SAVE");
    }
  });

  it("every multiball script that arms one is still doing it", () => {
    // Twelve of the thirteen. The thirteenth is Law 'n Justice's script 202.
    const armed: string[] = [];
    for (const tableId of TABLE_IDS) {
      const modes = modesFor(tableId);
      for (const script of modes.scripts) {
        const balls = script.ops.find((op) => op.op === 27);
        if (balls === undefined || (balls.args[0] ?? 0) < 2) continue;
        const save = script.ops.find((op) => op.op === 11);
        armed.push(`${tableId} s${script.index} ${save === undefined ? "none" : save.args[0]}`);
      }
    }
    expect(armed.filter((one) => !one.endsWith("none")).length).toBe(12);
    expect(armed.length).toBe(13);
  });
});

describe("the ball-save lamp", () => {
  it("blinks off the countdown itself, and goes dark for the last second", () => {
    // +0x004E06..+0x004E20: `> $64` masks bit 2 (four on, four off), `> $32`
    // masks bit 0 (on every other frame), and `<= $32` is `clr.b (a1)`.
    expect(ballSaveLampLit(0)).toBeNull();
    expect(ballSaveLampLit(250)).toBe(false);
    expect(ballSaveLampLit(252)).toBe(true);
    expect(ballSaveLampLit(101)).toBe(true);
    expect(ballSaveLampLit(100)).toBe(false);
    expect(ballSaveLampLit(99)).toBe(true);
    expect(ballSaveLampLit(51)).toBe(true);
    expect(ballSaveLampLit(50)).toBe(false);
    expect(ballSaveLampLit(1)).toBe(false);
    // The slow phase really is four on and four off.
    const slow = [108, 109, 110, 111, 112, 113, 114, 115].map((one) => ballSaveLampLit(one));
    expect(slow).toEqual([true, true, true, true, false, false, false, false]);
  });

  it("drives engine lamp slot 1, and BabeWatch has none", () => {
    // Descriptor +$64 is three slots and BabeWatch's middle one is a genuine
    // null — the engine's own `beq.b $4e22` at +0x004DFE is the branch for it.
    expect(TABLE_IDS.map((id) => lampsFor(id).engine[BALL_SAVE_ENGINE_SLOT])).toEqual([8, -1, 1]);

    for (const tableId of TABLE_IDS) {
      const lamps = lampsFor(tableId);
      const slot = lamps.engine[BALL_SAVE_ENGINE_SLOT] ?? -1;
      const off = lampModes(lamps, createModeState(modesFor(tableId)), 0);
      const on = lampModes(lamps, createModeState(modesFor(tableId)), 252);
      if (slot < 0) {
        expect(off, `${tableId} has no ball-save lamp`).toEqual(on);
        continue;
      }
      expect(on[slot], `${tableId} lit`).toBe(LAMP_STEADY);
      const dark = lampModes(lamps, createModeState(modesFor(tableId)), 250);
      expect(dark[slot], `${tableId} dark`).toBe(LAMP_OFF);
    }
  });
});
