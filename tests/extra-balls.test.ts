/**
 * THE EXTRA BALL — award effect 1, and the one thing the port had no model of.
 *
 * Until this round the reconstruction could not lengthen a game. The doc comment
 * on `Game.ballsServed` said so in as many words — *"charged serves are strictly
 * round-robin (the port has no extra balls, the one thing that would decouple
 * them)"* — and four live shots across the three tables handed the player their
 * (zero-scoring) award and then took the ball away.
 *
 * THE HANDLER, main.seg00 +0x00606C, twenty-six bytes:
 *
 *     00606C  2035 0162 2352 0000  move.l  ([$2352,a5],$0),d0   ; engine lamp 0
 *     006074  6706                 beq.s   $607c
 *     006076  2240                 movea.l d0,a1
 *     006078  50e9 0005            st.b    $5(a1)               ; SHOOT AGAIN
 *     00607C  206d 0dc2            movea.l $dc2(a5),a0          ; player record
 *     006080  5228 0010            addq.b  #1,$10(a0)           ; ONE MORE
 *     006084  4e75                 rts
 *
 * `2035 0162 2352 0000` is a FULL-FORMAT extension word Capstone cannot print —
 * index suppressed, word base displacement, memory indirect with a word outer
 * displacement — so the effective address is `([a5 + $2352] + 0)`: the long at
 * the front of the descriptor's three-slot ENGINE LAMP list, whose slot 1 is
 * BALL SAVE (`table-lamps.ts`) and whose slot 0 is this.
 *
 * THE CONSUMER, +0x00505A, on the same byte, in the drain path:
 *
 *     00505A  206d 0dc2      movea.l $dc2(a5),a0
 *     00505E  4a28 0010      tst.b   $10(a0)
 *     005062  670c           beq.s   $5070          ; none banked -> rotate
 *     005064  5328 0010      subq.b  #1,$10(a0)     ; spend one
 *     005068  3b7c 0007 008e move.w  #$7,$8e(a5)    ; state 7 = SHOOT AGAIN
 *     00506E  6040           bra.s   $50b0          ; ...over $5070 entirely
 *
 * $5070 is the player rotation, and it is where `subq.w #1,$d82` (balls left)
 * and `addq.w #1,$d84` (ball number) live. An extra ball skips all three: same
 * player, same ball number, nothing charged. That is what an extra ball IS.
 *
 * WHAT THIS FILE ASSERTS, and each is one of the machine's own instructions:
 *
 *   1. THE CENSUS — eight elements, at the indices the decode names, all eight
 *      shipping no per-element feedback because the handler provides its own.
 *   2. THE VM REPORTS IT rather than applying it, exactly as effects 2, 5 and 8
 *      are reported: +$10 is a byte of the record `scoring.ts` owns.
 *   3. THE BANK IS PER PLAYER AND PER GAME — the record is per player and the
 *      only clear in the segment is the per-GAME walk at +0x004588.
 *   4. THE RE-SERVE, on the real loop and out of the shipped jail-lock script:
 *      the same player shoots again, `ballsServed` does not move, `ballNumber`
 *      does not move, and no extra ball means no ball saver.
 *   5. IT DOES NOT STOP A GAME ENDING. A bank is finite and each spend is one
 *      ball, so a game with extra balls in it still terminates.
 *   6. THE LAMP — engine slot 0, steady while a ball is banked.
 *
 * Full decode: research/effects-tail/EFFECTS_TAIL.md section 2.
 */

import { describe, expect, it } from "vitest";

import { InputRouter } from "../src/browser/input.js";
import type { Control } from "../src/browser/input.js";
import {
  ballNumber,
  ballsRemaining,
  createGame,
  startGame,
  tickGame,
} from "../src/browser/game-loop.js";
import type { Game, GameTickReport } from "../src/browser/game-loop.js";
import { pixelsToQ10 } from "../src/core/fixed-point.js";
import { TABLE_IDS } from "../src/game/contracts.js";
import {
  LAMP_OFF,
  LAMP_STEADY,
  SHOOT_AGAIN_ENGINE_SLOT,
  lampModes,
} from "../src/game/lamp-overlays.js";
import { TICKS_PER_SECOND, createModeState, queueScript, tickModes } from "../src/game/mode-vm.js";
import { lampsFor, mapFor, modesFor } from "./table-fixtures.js";

/** The eight, and the saucer script that awards each table's three (or two). */
const EXTRA_BALL_ELEMENTS: Record<string, number[]> = {
  "law-n-justice": [21, 47, 65],
  babewatch: [7, 67, 122],
  "extreme-sports": [58, 96],
};

// ---------------------------------------------------------------------------
// The decode
// ---------------------------------------------------------------------------

describe("award effect 1, in the shipped documents", () => {
  it("is eight elements with no lamp and no sound, and the machine's own card", () => {
    let total = 0;
    for (const tableId of TABLE_IDS) {
      const modes = modesFor(tableId);
      const carriers = modes.elements.filter((one) => one.effect === 1);
      expect(carriers.map((one) => one.index)).toEqual(EXTRA_BALL_ELEMENTS[tableId]);
      total += carriers.length;
      // 8 OF 8, NO EXCEPTIONS on the lamp and the sound: the handler lights the
      // engine's own SHOOT AGAIN lamp, so the elements need neither.
      //
      // THE DISPLAY IS THE CORRECTION THIS ROUND MAKES. This test used to
      // assert `displayAward === -1` and call the effect "feedback-less", and
      // that was an artefact: the exporter's display pool held only MESSAGE
      // operands, so 228 of 229 element display pointers shipped as -1 and
      // EVERY element looked feedback-less. Read out of the package, all eight
      // carry BOTH records — a START card that says "EXTRA BALL IS LIT" and an
      // AWARD record that is a sting and an animation with no text at all
      // (Law 'n Justice e21's is h4+0x3718: `SOUND / ANIM_BLOCK / WAIT 2 s`).
      // So the effect is silent in words on the award and loud on the arm,
      // which is what a SHOOT AGAIN lamp wants either side of it.
      for (const one of carriers) {
        expect([one.lampAward, one.soundAward]).toEqual([false, false]);
        expect(one.displayAward).toBeGreaterThanOrEqual(0);
        expect(modes.messages[one.displayAward]!.lines).toEqual([]);
      }
      // The START card, on every one of them that anything arms. Law 'n
      // Justice's e47 is the exception and is not a decode gap: nothing in the
      // decoded corpus arms it (its only arming scripts s104/s105/s106 have no
      // referrer), and its `+$14` really is null in the package.
      const lit = carriers.filter((one) => one.displayStart >= 0);
      for (const one of lit) {
        expect(modes.messages[one.displayStart]!.lines).toEqual(["EXTRA BALL IS LIT"]);
      }
      expect(lit.length).toBe(tableId === "law-n-justice" ? 2 : carriers.length);
      // AND THE +$34 IS NOT READ. The handler names no element field at all, so
      // every one of these must arrive with the polymorphic pointer unresolved
      // in all four of its readings — that is what "dispatch by effect alone"
      // has to look like in the document.
      for (const one of carriers) {
        expect([one.counter, one.ladder, one.chainScript, one.rampCollect]).toEqual([-1, -1, -1, -1]);
      }
    }
    expect(total).toBe(8);
  });

  it("is awarded at a saucer on every table", () => {
    // Convention, and it holds across all three: the collector is a lock.
    // Law 'n Justice's jail is lower lock 5 and its script awards all three of
    // the table's effect-1 elements in a row.
    const modes = modesFor("law-n-justice");
    expect(modes.scriptForLock(0, 5)).toBe(62);
    const awarded = modes.scripts[62]!.ops.filter((op) => op.op === 5).map((op) => op.args[0]);
    for (const element of EXTRA_BALL_ELEMENTS["law-n-justice"]!) {
      expect(awarded).toContain(element);
    }
  });

  it("is REPORTED by the mission VM, and counted rather than flagged", () => {
    // The mode VM must not own the ball count for the same reason it does not
    // own `$d8a`: `out.extraBalls` is the report, and the loop applies it.
    const modes = modesFor("law-n-justice");
    const state = createModeState(modes);
    // Two of the jail's three effect-1 elements armed at once. `addq.b #1` is
    // an ADD, so the machine banks two, and script 62 awards them on separate
    // ticks — this counts what the whole run reported, not one tick's.
    state.armed[21] = 1;
    state.armed[65] = 1;
    queueScript(state, 62);
    let banked = 0;
    for (let i = 0; i < 400; i += 1) banked += tickModes(modes, state).extraBalls;
    expect(banked).toBe(2);

    // AND NOTHING ELSE PAYS ONE. An unarmed element is not awarded at all
    // (`AWARD` at $5CA8 refuses on `armed = 0`), so the same script through a
    // fresh state banks nothing.
    const cold = createModeState(modes);
    queueScript(cold, 62);
    let none = 0;
    for (let i = 0; i < 400; i += 1) none += tickModes(modes, cold).extraBalls;
    expect(none).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

class Driver {
  readonly router = new InputRouter();

  constructor(readonly game: Game) {}

  tick(count = 1): GameTickReport {
    let report: GameTickReport | null = null;
    for (let i = 0; i < count; i += 1) report = tickGame(this.game, this.router.sample());
    if (report === null) throw new Error("tick(0)");
    return report;
  }

  tap(control: Control): void {
    this.router.tap(control);
  }
}

/**
 * BALL SAVE OFF, by the machine's own knob (`tableNNN.opt` record 5 is a 0..10
 * slider and 0 is a setting the options screen offers). Every ball below is
 * driven straight into the drain to reach the thing under test; with the
 * shipped seconds armed each of those drains would come back instead. The one
 * test that needs the saver turns it on for itself.
 */
function gameOf(players = 1, ballSaveSeconds = 0): Driver {
  const game = createGame(mapFor("law-n-justice"), { ballSaveSeconds });
  startGame(game, players);
  return new Driver(game);
}

function launchServedBall(drv: Driver): void {
  for (let i = 0; i < 800; i += 1) {
    if (i % 10 === 4) drv.tap("plunger");
    if (drv.tick().launched) return;
  }
  throw new Error("the served ball never launched");
}

function drainLiveBall(drv: Driver): void {
  const ball = drv.game.balls.balls.find(
    (one) => one.active && one.heldBy === null && one.id !== drv.game.laneBallId,
  );
  if (ball === undefined) throw new Error("no live ball to drain");
  ball.level = 0;
  ball.x = pixelsToQ10(155);
  ball.y = pixelsToQ10(592);
  ball.velocityX = 0;
  ball.velocityY = 8000;
  for (let i = 0; i < 80; i += 1) {
    if (drv.tick().drained.length > 0) return;
  }
  throw new Error("the teleported ball never drained");
}

/**
 * Ticks until the ball-save countdown is spent, plunging anything that lands
 * back in the lane — a ball the saver gives back is re-served, so the window
 * cannot be run out by standing still.
 */
function runOutBallSaverWindow(drv: Driver): void {
  for (let i = 0; i < 3000 && drv.game.ballSaveTicks > 0; i += 1) {
    if (i % 10 === 4) drv.tap("plunger");
    drv.tick();
  }
  if (drv.game.ballSaveTicks > 0) throw new Error("the ball saver never ran out");
  if (drv.game.laneBallId !== null) launchServedBall(drv);
}

/** Runs out the ball end; returns on the next serve or on game over. */
function runOutBallEnd(drv: Driver): GameTickReport {
  for (let i = 0; i < 1500; i += 1) {
    if (i % 8 === 3) drv.tap("leftFlipper");
    const report = drv.tick();
    if (report.gameOver || report.served) return report;
  }
  throw new Error("the ball end never resolved");
}

/** Arms a jail element and runs the shipped lock script that awards it. */
function bankOneExtraBall(drv: Driver, element = 21): void {
  const state = drv.game.modeState;
  if (state === null) throw new Error("no mission layer");
  const before = drv.game.scoring.extraBalls;
  state.armed[element] = 1;
  state.done[element] = 0;
  queueScript(state, 62);
  for (let i = 0; i < 400; i += 1) {
    drv.tick();
    if (drv.game.scoring.extraBalls > before) return;
  }
  throw new Error("the jail never awarded the extra ball");
}

describe("the extra ball on the real loop", () => {
  it("hands the ball back to the SAME player without charging or advancing one", () => {
    // THE DEMONSTRATION, in a two-player game where a rotation is visible.
    const drv = gameOf(2);
    runOutBallEnd(drv); // player 1, ball 1
    launchServedBall(drv);
    expect(drv.game.activePlayer).toBe(0);
    expect(drv.game.ballsServed).toBe(1);

    bankOneExtraBall(drv);
    expect(drv.game.scoring.extraBalls).toBe(1);
    // Banked on the SHOOTING player's record and nobody else's.
    expect(drv.game.banks[1]!.scoring.extraBalls).toBe(0);

    drainLiveBall(drv);
    const served = runOutBallEnd(drv);
    expect(served.served).toBe(true);
    // +0x005068's `bra $50b0` jumped clear over the rotation: same player, same
    // ball number, and `$d82`/`$d84` — which `ballsRemaining` and `ballNumber`
    // derive from `ballsServed` — did not move either. The bank is spent.
    expect(drv.game.activePlayer).toBe(0);
    expect(ballNumber(drv.game)).toBe(1);
    expect(drv.game.ballsServed).toBe(1);
    expect(ballsRemaining(drv.game)).toBe(5);
    expect(drv.game.scoring.extraBalls).toBe(0);
    expect(drv.game.phase).toBe("in-play");

    // And the NEXT drain, with nothing banked, takes the `beq $5070` arm: the
    // rotation happens and player 2 is up on their own ball 1.
    launchServedBall(drv);
    drainLiveBall(drv);
    runOutBallEnd(drv);
    expect(drv.game.activePlayer).toBe(1);
    expect(ballNumber(drv.game)).toBe(1);
    expect(drv.game.ballsServed).toBe(2);
  });

  it("gets NO BALL SAVER, where a charged serve does", () => {
    // State 7's entry at +0x004FC0 sets `$d7b` and never writes `$d8a`; the
    // teardown at +0x0050FA has already zeroed the countdown. State 5's own
    // first three instructions at +0x0049AE are what arm it, and state 7 does
    // not pass through them.
    const drv = gameOf(1, 5);
    runOutBallEnd(drv);
    // The charged serve armed it, at the length asked for less the tick the
    // in-play countdown at +0x004DF2 has already taken off it.
    expect(drv.game.ballSaveTicks).toBe(5 * TICKS_PER_SECOND - 1);
    launchServedBall(drv);
    bankOneExtraBall(drv);
    // THEN let the window run out — otherwise the drain below is given back by
    // the SAVER and the extra ball is never reached at all, which is what the
    // first cut of this test measured by accident. The bank is per game, so it
    // is still there on the other side.
    runOutBallSaverWindow(drv);
    expect(drv.game.ballSaveTicks).toBe(0);
    expect(drv.game.scoring.extraBalls).toBe(1);

    drainLiveBall(drv);
    runOutBallEnd(drv);
    expect(drv.game.ballsServed).toBe(1); // it really was the extra ball
    expect(drv.game.scoring.extraBalls).toBe(0);
    // AND STATE 7 LEFT `$d8a` WHERE THE TEARDOWN PUT IT. A charged serve would
    // have re-armed 250 ticks here.
    expect(drv.game.ballSaveTicks).toBe(0);
    expect(drv.game.ballSaving).toBe(false);
  });

  it("stacks, survives the drain that spends one, and still lets the game end", () => {
    // THE TERMINATION CHECK. `addq.b #1` does not saturate and nothing in the
    // per-BALL path clears +$10, so a bank of two survives the drain that
    // spends the first. But every award needs its own re-arm, so the bank is
    // finite and the game still reaches its last ball.
    const drv = gameOf(1);
    runOutBallEnd(drv); // ball 1
    launchServedBall(drv);
    bankOneExtraBall(drv, 21);
    bankOneExtraBall(drv, 65);
    expect(drv.game.scoring.extraBalls).toBe(2);

    drainLiveBall(drv);
    runOutBallEnd(drv);
    // One spent, one still banked across the ball end.
    expect(drv.game.scoring.extraBalls).toBe(1);
    expect(drv.game.ballsServed).toBe(1);

    launchServedBall(drv);
    drainLiveBall(drv);
    runOutBallEnd(drv);
    expect(drv.game.scoring.extraBalls).toBe(0);
    expect(drv.game.ballsServed).toBe(1);

    // Now the three charged balls play out and the game ends, exactly as it
    // would have without any of this: five more ball ends, the last of them
    // game over.
    for (let i = 0; i < 2; i += 1) {
      launchServedBall(drv);
      drainLiveBall(drv);
      expect(runOutBallEnd(drv).served).toBe(true);
    }
    expect(drv.game.ballsServed).toBe(3);
    launchServedBall(drv);
    drainLiveBall(drv);
    expect(runOutBallEnd(drv).gameOver).toBe(true);
    expect(drv.game.phase).toBe("game-over");
  });

  it("starts every game with the bank empty", () => {
    // +0x004588's `move.b d1,$10(a0)` is in the per-GAME record walk and
    // nowhere else, and the port's fresh banks are that walk.
    const drv = gameOf(2);
    runOutBallEnd(drv);
    launchServedBall(drv);
    bankOneExtraBall(drv);
    expect(drv.game.scoring.extraBalls).toBe(1);
    startGame(drv.game, 2);
    expect(drv.game.scoring.extraBalls).toBe(0);
    expect(drv.game.banks.every((bank) => bank.scoring.extraBalls === 0)).toBe(true);
    expect(drv.game.extraBallServe).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The lamp
// ---------------------------------------------------------------------------

describe("the SHOOT AGAIN lamp", () => {
  it("is engine slot 0 on all three tables, and no element can reach it", () => {
    // Both writers of the byte are `st.b $5(a1)` — the award at +0x00606C and
    // the ball-start relight at +0x0050E0, which are the SAME sixteen bytes —
    // and neither sets the blink flag, so the lamp is STEADY and never blinks.
    // Driving it off the banked count every frame is observationally identical
    // to those two one-shot writes only because NOTHING ELSE DRIVES IT: measured
    // here, no element on any of the three tables names this lamp on its start
    // (+$04) or award (+$08) path.
    for (const tableId of TABLE_IDS) {
      const lamps = lampsFor(tableId);
      const slot = lamps.engine[SHOOT_AGAIN_ENGINE_SLOT]!;
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(lamps.startElementsByLamp[slot] ?? []).toEqual([]);
      expect(lamps.awardElementsByLamp[slot] ?? []).toEqual([]);

      const state = createModeState(modesFor(tableId));
      expect(lampModes(lamps, state, 0, 0)[slot]).toBe(LAMP_OFF);
      expect(lampModes(lamps, state, 0, 1)[slot]).toBe(LAMP_STEADY);
      expect(lampModes(lamps, state, 0, 3)[slot]).toBe(LAMP_STEADY);
    }
  });

  it("lights when the jail banks one and goes out when the re-serve spends it", () => {
    const drv = gameOf(1);
    const lamps = lampsFor("law-n-justice");
    const slot = lamps.engine[SHOOT_AGAIN_ENGINE_SLOT]!;
    const lit = (): number =>
      lampModes(lamps, drv.game.modeState, 0, drv.game.scoring.extraBalls)[slot]!;
    runOutBallEnd(drv);
    launchServedBall(drv);
    expect(lit()).toBe(LAMP_OFF);
    bankOneExtraBall(drv);
    expect(lit()).toBe(LAMP_STEADY);
    drainLiveBall(drv);
    runOutBallEnd(drv);
    expect(lit()).toBe(LAMP_OFF);
  });
});
